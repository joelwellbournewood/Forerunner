import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { LiveSessions, type PrepareBy } from "../src/session/live-sessions.ts";
import {
  type PrepareRequest,
  type PrepareResult,
  prepareWork,
} from "../src/session/prepared-work.ts";
import {
  JOINED_EVENT,
  PROMISED_EVENT,
  type SessionResult,
  SessionRunner,
  StaticPlanner,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { startCheck } from "../src/session/start-check.ts";
import { seedWorld } from "./context-helpers.ts";

/**
 * d1109-starts-engine, run C (S-6, S-7; ADR 0118; the owner's option C of 2026-11-09: "the session
 * keeps its promise and spare budget isn't wasted, I think that's probably the best", and "the
 * management of the tasks should be able to feed into sessions that are already running when
 * appropriate"). The runner with a scripted executor and fixed estimates: the promise a Start
 * makes is the Start dialog's list; work prepared while it runs joins only when its estimate fits
 * the work budget left after the session's own tasks; what did not fit waits for the next Start,
 * said once in the result. Before, the session took every ready task that fit the room left at
 * its next look, so a Redo could take the room its promised followers needed.
 */
const usd = (n: number) => Math.round(n * 1_000_000);
const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

/** A task's scripted run: what it costs, and what happens while it runs. */
interface Script {
  cost: number;
  during?: () => Promise<void>;
  outcome?: "done" | "failed";
}

describe("d1109-starts-engine, run C: a running session keeps its promise and takes what fits (S-6, S-7)", () => {
  let store: StateStore;
  let clock: SimulatedClock;
  let w: Awaited<ReturnType<typeof seedWorld>>;
  let live: LiveSessions;
  const scripts = new Map<string, Script>();
  const ran: string[] = [];
  const executor: TaskExecutor = {
    async execute({ task, budget, session }) {
      ran.push(task.title);
      const script = scripts.get(task.title) ?? { cost: 0.1 };
      const cost = usd(script.cost);
      const run = await store.run.insert({
        task_id: task.id,
        session_id: session.id,
        specialist: "coder",
        model: "fake-sonnet",
        provider: "fake",
        effort: "medium",
        cost_usd_micro: cost,
        duration_ms: 1000,
        outcome: script.outcome === "failed" ? "failed" : "completed",
      });
      budget.record(run.id, cost);
      await script.during?.();
      return script.outcome === "failed"
        ? {
            outcome: "failed",
            summary: "failed",
            costUsdMicro: cost,
            checksPassed: false,
            runId: run.id,
            changedFiles: [],
          }
        : {
            outcome: "done",
            summary: "done",
            costUsdMicro: cost,
            checksPassed: true,
            runId: run.id,
            changedFiles: ["a.txt"],
          };
    },
  };
  const runner = () =>
    new SessionRunner({
      store,
      clock,
      tokens: new TokenIssuer({ now: () => clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor,
      live,
    });
  const start = (budgetUsd = 3, over: { autonomy?: 0 | 1 | 2; planApproved?: boolean } = {}) =>
    runner().start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "manual",
      by: "person",
      budgetCapUsdMicro: usd(budgetUsd),
      grant,
      ...(over.autonomy !== undefined ? { autonomy: over.autonomy } : {}),
      ...(over.planApproved ? { planApproved: true } : {}),
    });
  const add = (
    title: string,
    estimate: number,
    over: Partial<Pick<TaskRow, "status" | "priority">> = {},
  ) =>
    store.task.insert({
      project_id: w.project,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 0,
      status: "ready",
      priority: 5,
      est_cost_usd_micro: usd(estimate),
      reason: "seed",
      ...over,
    });
  /** The person's Redo of a done task: it is ready again, then prepared (the answer paths do). */
  const redo = async (task: TaskRow, by: PrepareBy = "person"): Promise<PrepareResult | null> => {
    const fresh = await store.task.mustGet(task.id);
    await store.task.reopen(fresh.id, fresh.version, "ready", "Redo asked by you", {
      humanId: w.human,
    });
    return prepare({ taskIds: [task.id], by });
  };
  const prepare = (req: Partial<PrepareRequest>) =>
    prepareWork(
      { store, live, now: () => clock.nowIso() },
      { agentId: w.agent, projectId: w.project, reason: "test", by: "person", ...req },
    );
  const events = async (r: SessionResult, type: string) =>
    (await store.event.list(r.sessionId)).filter((e) => e.type === type).map((e) => e.payload);

  beforeEach(async () => {
    clock = new SimulatedClock("2026-11-10T07:00:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    w = await seedWorld(store, {}, { session: false });
    live = new LiveSessions();
    scripts.clear();
    ran.length = 0;
  });
  afterEach(async () => {
    await store.close();
  });

  it("S-6: the session promises what the Start dialog said, and says it once", async () => {
    const a = await add("Task A", 1, { priority: 9 });
    const b = await add("Task B", 1, { priority: 8 });
    const check = await startCheck({ store }, w.project, usd(3));
    expect(check.runnable.map((t) => t.title)).toEqual(["Task A", "Task B"]);
    const r = await start();
    const [promised] = await events(r, PROMISED_EVENT);
    expect(promised).toEqual({ taskIds: [a.id, b.id], estimateUsdMicro: usd(2) });
    expect(
      ((await store.session.mustGet(r.sessionId)).plan as { promise?: unknown }).promise,
    ).toEqual({
      taskIds: [a.id, b.id],
      estimateUsdMicro: usd(2),
    });
  });

  it("S-7: a Redo that fits joins and runs after the promise; one that does not fit waits and is named once", async () => {
    await add("Task A", 1, { priority: 9 });
    await add("Task B", 1, { priority: 8 });
    const c = await add("Task C", 0.3, { status: "done" });
    const d = await add("Task D", 0.5, { status: "draft" });
    const answers: (PrepareResult | null)[] = [];
    scripts.set("Task A", {
      cost: 1,
      during: async () => {
        answers.push(await redo(c));
        const fresh = await store.task.mustGet(d.id);
        await store.task.transition(fresh.id, fresh.version, "ready", "made ready by you", {
          humanId: w.human,
        });
        answers.push(await prepare({ taskIds: [d.id] }));
      },
    });
    scripts.set("Task B", { cost: 1 });
    const r = await start();
    expect(answers.map((a) => a?.line)).toEqual([
      "It joins the session that is running.",
      "Ready: it joins this session if budget is left after its own tasks, else your next Start.",
    ]);
    expect(ran).toEqual(["Task A", "Task B", "Task C"]);
    expect((await store.task.mustGet(d.id)).status).toBe("ready");
    expect(r.summary).toMatch(/Left for your next Start: "Task D" \(about CHF 0\.\d\d\)\./);
    expect((await events(r, JOINED_EVENT)).map((p) => (p as { title: string }).title)).toEqual([
      "Task C",
    ]);
    // The ledger never shows the session past its work budget (the review's fifth kept).
    expect((await store.session.mustGet(r.sessionId)).spent_usd_micro).toBeLessThanOrEqual(
      usd(2.4),
    );
  });

  it("S-7: spare budget is not wasted: when A spent less than its estimate, D joins at the next look", async () => {
    await add("Task A", 1, { priority: 9 });
    await add("Task B", 1, { priority: 8 });
    const d = await add("Task D", 0.5, { status: "draft" });
    let answer: PrepareResult | null = null;
    scripts.set("Task A", {
      cost: 0.7,
      during: async () => {
        const fresh = await store.task.mustGet(d.id);
        await store.task.transition(fresh.id, fresh.version, "ready", "made ready by you", {
          humanId: w.human,
        });
        answer = await prepare({ taskIds: [d.id] });
      },
    });
    const r = await start();
    expect((answer as PrepareResult | null)?.outcome).toBe("no_room");
    expect(ran).toEqual(["Task A", "Task B", "Task D"]);
    expect(r.summary).not.toContain("Left for your next Start");
  });

  it("S-7: a cancelled promised task gives its room back; a task larger than the work budget never joins", async () => {
    await add("Task A", 1, { priority: 9 });
    const b = await add("Task B", 1, { priority: 8 });
    const d = await add("Task D", 1, { status: "draft" });
    const big = await add("Task Big", 3, { status: "draft" });
    const answers: (PrepareResult | null)[] = [];
    scripts.set("Task A", {
      cost: 0.5,
      during: async () => {
        const fresh = await store.task.mustGet(b.id);
        await store.task.transition(fresh.id, fresh.version, "cancelled", "cancelled by you", {
          humanId: w.human,
        });
        for (const t of [d, big]) {
          const row = await store.task.mustGet(t.id);
          await store.task.transition(row.id, row.version, "ready", "made ready by you", {
            humanId: w.human,
          });
          answers.push(await prepare({ taskIds: [t.id] }));
        }
      },
    });
    await start();
    // L4-money-203: the task above the whole work budget is told it never joins (it read "it
    // joins this session if budget is left after its own tasks"); the line is what the person
    // reads.
    expect(answers.map((a) => a?.outcome)).toEqual(["joined", "too_large"]);
    expect(answers.map((a) => a?.line)).toEqual([
      "It joins the session that is running.",
      "Ready: it is larger than this session's budget, so it runs at your next Start.",
    ]);
    expect(ran).toEqual(["Task A", "Task D"]);
  });

  it("S-7: after Stop after this task every preparation reads 'it runs at your next Start' and the task does not run", async () => {
    await add("Task A", 1, { priority: 9 });
    const c = await add("Task C", 0.3, { status: "done" });
    let answer: PrepareResult | null = null;
    scripts.set("Task A", {
      cost: 0.5,
      during: async () => {
        const [row] = await store.session.active(w.agent);
        if (row) await store.session.setStatus(row.id, row.version, "paused");
        answer = await redo(c);
      },
    });
    await start();
    expect((answer as PrepareResult | null)?.line).toBe("Ready: it runs at your next Start.");
    expect(ran).toEqual(["Task A"]);
    expect((await store.task.mustGet(c.id)).status).toBe("ready");
  });

  it("S-7: work prepared during the session's last look hears 'it runs at your next Start' and does not run in it", async () => {
    await add("Task A", 0.5);
    const late = await add("Task Late", 0.2, { status: "draft" });
    let answer: PrepareResult | null = null;
    // The last look reads the ready tasks; work prepared while it reads is the race.
    const readyTasks = store.task.readyTasks.bind(store.task);
    let fired = false;
    store.task.readyTasks = async (projectId, opts) => {
      // The last look has closed the session to newcomers before it reads.
      if (live.forProject(w.project)?.closing && !fired) {
        fired = true;
        const row = await store.task.mustGet(late.id);
        await store.task.transition(row.id, row.version, "ready", "made ready by you", {
          humanId: w.human,
        });
        answer = await prepare({ taskIds: [late.id] });
      }
      return readyTasks(projectId, opts);
    };
    await start();
    expect((answer as PrepareResult | null)?.line).toBe("Ready: it runs at your next Start.");
    expect(ran).toEqual(["Task A"]);
  });

  it("S-7 (D7): a part of a promised task is the session's own within its estimate; a step added before a promised task that does not fit takes it out of the promise, both named once", async () => {
    const a = await add("Task A", 1, { priority: 9 });
    const b = await add("Task B", 1, { priority: 8 });
    const part = await add("Task A part two", 0.4, { status: "draft" });
    const step = await add("Step before B", 0.9, { status: "draft" });
    const answers: (PrepareResult | null)[] = [];
    scripts.set("Task A", {
      cost: 0.5,
      during: async () => {
        for (const [t, context] of [
          [part, { partOf: a.id }],
          [step, { before: b.id }],
        ] as const) {
          const row = await store.task.mustGet(t.id);
          await store.task.transition(row.id, row.version, "ready", "the agent added it", {
            agentId: w.agent,
          });
          answers.push(await prepare({ taskIds: [t.id], by: "agent", context }));
        }
      },
    });
    const r = await start();
    expect(answers.map((x) => x?.outcome)).toEqual(["joined", "no_room"]);
    expect(ran).toEqual(["Task A", "Task A part two"]);
    // d1109-selftasks-run (D7): the promised task is named after the step it waits for.
    expect(r.summary).toMatch(
      /Left for your next Start: "Step before B" \(about CHF 0\.\d\d\) and "Task B", which waits for it\./,
    );
  });

  it("S-7: at level 1 the person's Redo joins the approved work and nothing the agent made ready runs", async () => {
    await store.project.update(w.project, (await store.project.mustGet(w.project)).version, {
      autonomy_level: 1,
    });
    await add("Task A", 1, { priority: 9 });
    const c = await add("Task C", 0.2, { status: "done" });
    const agentTask = await add("Agent task", 0.2, { status: "draft" });
    scripts.set("Task A", {
      cost: 0.3,
      during: async () => {
        await redo(c);
        const row = await store.task.mustGet(agentTask.id);
        await store.task.transition(row.id, row.version, "ready", "the agent added it", {
          agentId: w.agent,
        });
        await prepare({ taskIds: [agentTask.id], by: "agent" });
      },
    });
    await start(3, { autonomy: 1, planApproved: true });
    expect(ran).toEqual(["Task A", "Task C"]);
  });

  // S-8 (ADR 0118): edits apply before a task starts. Before, the plan's queue item kept the title
  // and specialist it was planned with, so a task renamed or handed to another specialist while
  // it waited started under its old name, by the old specialist.
  it("S-8: an edit made while a task waited applies at its claim: it starts under its new title, by its new specialist", async () => {
    await add("Write the intro", 0.1);
    const outro = await add("Write the outro", 0.1);
    scripts.set("Write the intro", {
      cost: 0.1,
      during: async () => {
        await store.task.patch(outro.id, { title: "Write the closing", specialist: "writer" });
      },
    });
    const r = await start();
    expect(
      (await events(r, "task.started")).map((p) => [
        (p as { title?: unknown }).title,
        (p as { specialist?: unknown }).specialist,
      ]),
    ).toEqual([
      ["Write the intro", "coder"],
      ["Write the closing", "writer"],
    ]);
    expect(ran).toEqual(["Write the intro", "Write the closing"]);
  });

  it("S-7: a task readmitted after a wait inside the session runs in the same session", async () => {
    await add("Task A", 0.5, { priority: 9 });
    const b = await add("Task B", 0.5, { priority: 8 });
    scripts.set("Task A", {
      cost: 0.2,
      during: async () => {
        const handle = live.forProject(w.project);
        expect(handle).toBeDefined();
        handle?.readmit([b.id]);
      },
    });
    await start();
    expect(ran).toEqual(["Task A", "Task B"]);
  });
});
