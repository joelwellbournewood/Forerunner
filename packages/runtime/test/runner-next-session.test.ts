import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../src/session/executor.ts";
import { notesForTask, type QueueNote } from "../src/session/next-session.ts";
import {
  SessionRunner,
  StaticPlanner,
  type TaskExecutionResult,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { flatPricing, harness, issue, registry, ScriptedProvider } from "./helpers.ts";

/**
 * U-038: what the person left for the next session reached nothing. The queue (the Next
 * session panel, "noted for the next session" from Chat) was printed in the planner's state
 * brief and marked consumed, but `StaticPlanner` never reads that text and no specialist's
 * brief carried a note; the first-session plan approved with the project's intake was written
 * to the summary cache and never read. Now a queued item reaches the brief of the task it
 * names, or every brief when it names none, and the approved first session decides the first
 * session's tasks and their order.
 */

const stores: StateStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function world(url = "sqlite::memory:", clock = new SimulatedClock("2026-03-02T07:00:00Z")) {
  const store = await openStore({ url, clock });
  stores.push(store);
  const human = (await store.human.insert({ name: "J", email: "j@example.test" })).id;
  const alice = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
  const project = (
    await store.project.insert({
      name: "Sample",
      goal: "Ship a sample service",
      autonomy_level: 2,
      settings: { members: [alice] },
    })
  ).id;
  const task = (title: string, priority: number) =>
    store.task.insert({
      project_id: project,
      title,
      outcome: `${title} is done`,
      status: "ready",
      priority,
      risk_tier: 0,
    });
  return { store, clock, human, alice, project, task };
}

type World = Awaited<ReturnType<typeof world>>;

/** Records what each task's executor call carried; every task finishes. */
function recorder(): { exec: TaskExecutor; calls: { title: string; notes: string[] }[] } {
  const calls: { title: string; notes: string[] }[] = [];
  return {
    calls,
    exec: {
      async execute(ctx): Promise<TaskExecutionResult> {
        calls.push({ title: ctx.task.title, notes: (ctx.notes ?? []).map((n) => n.text) });
        return { outcome: "done", summary: "done", costUsdMicro: 0, checksPassed: true };
      },
    },
  };
}

function start(w: World, exec: TaskExecutor, events: string[] = []) {
  const runner = new SessionRunner({
    store: w.store,
    clock: w.clock,
    tokens: new TokenIssuer({ now: () => w.clock.now() }),
    kill: new KillSwitch(),
    planner: new StaticPlanner(),
    executor: exec,
  });
  return runner.start({
    agentId: w.alice,
    projectId: w.project,
    trigger: "manual",
    budgetCapUsdMicro: 50_000_000,
    grant: { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] },
    onEvent: (type) => events.push(type),
  });
}

describe("the next-session queue reaches the specialists' briefs (U-038)", () => {
  it("an item that names a task goes to that task; one that names none goes to every task", async () => {
    const w = await world();
    const login = await w.task("Add the login page", 9);
    await w.task("Write the README", 5);
    const enqueue = (kind: "note" | "correction" | "idea", text: string) =>
      w.store.queue.enqueue({ project_id: w.project, human_id: w.human, kind, text, priority: 5 });
    // From the Next session panel, and "correction: ..." in Chat (note.add).
    await enqueue("correction", "Add the login page: reuse the session cookie, no new table");
    await enqueue("note", "Write in British English");
    await enqueue("idea", `For ${login.id}: a remember-me box would help`);
    const r = recorder();
    const events: string[] = [];
    const res = await start(w, r.exec, events);
    expect(res.status).toBe("completed");
    expect(r.calls).toEqual([
      {
        title: "Add the login page",
        notes: [
          "Add the login page: reuse the session cookie, no new table",
          "Write in British English",
          `For ${login.id}: a remember-me box would help`,
        ],
      },
      { title: "Write the README", notes: ["Write in British English"] },
    ]);
    expect(events.filter((e) => e === "task.notes")).toHaveLength(2);
  });

  it("the specialist reads them in its brief, quoted as data", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    stores.push(store);
    const human = (await store.human.insert({ name: "J", email: "j@x.test" })).id;
    const agent = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
    const project = (await store.project.insert({ name: "P" })).id;
    const session = await store.session.insert({
      agent_id: agent,
      project_id: project,
      trigger: "manual",
      status: "running",
      runner: "pc",
    });
    const task = await store.task.insert({
      project_id: project,
      title: "Add the login page",
      status: "in_progress",
      budget_usd_micro: 1_000_000,
    });
    const coder: SpecialistSpec = {
      name: "coder",
      prompt: "You are the coder.",
      promptVersion: "coder@1.0.0+abc12345",
      defaultTier: "sonnet",
      defaultEffort: "medium",
      allowedTools: ["echo"],
      allowedDomains: [],
      maxBudgetUsdMicro: 1_000_000,
      maxTurns: 5,
      timeoutMs: 60_000,
    };
    const provider = new ScriptedProvider([{ text: "Done." }], h.clock);
    const exec = new LoopTaskExecutor({
      store,
      clock: h.clock,
      tokens: h.tokens,
      driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
      provider,
      pricing: flatPricing,
      tools: registry(),
      billingSourceId: "bs",
      specialists: (n) => (n === "coder" ? coder : undefined),
    });
    const notes: QueueNote[] = [
      { id: "q1", kind: "correction", text: "Reuse the session cookie", priority: 7 },
    ];
    const res = await exec.execute({
      task,
      session,
      token: issue(h, {
        agentId: agent,
        ownerHumanId: human,
        projectId: project,
        sessionId: session.id,
        allowedTools: ["echo"],
        budgetUsdMicro: 5_000_000,
      }),
      budget: new SessionBudget({
        sessionId: session.id,
        budgetUsdMicro: 5_000_000,
        stepCap: 100,
        deadlineMs: h.clock.now() + 3_600_000,
        reserveShare: 0.2,
      }),
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
      notes,
    });
    expect(res.outcome).toBe("done");
    const sent = provider.calls[0]?.messages[0]?.content as string;
    expect(sent).toContain("## Left for this session by the human");
    expect(sent).toContain('- correction (priority 7): "Reuse the session cookie"');
  });

  it("the intake's first-session announcement goes to no brief", () => {
    const items: QueueNote[] = [
      {
        id: "q",
        kind: "task",
        text: "First-session plan (approved intake r1, ~$0.65): Scaffold first\n1. Scaffold",
        priority: 9,
      },
    ];
    expect(notesForTask(items, { id: "t", title: "Scaffold" }, [])).toEqual([]);
  });
});

describe("the approved first session decides the first session (U-038)", () => {
  async function approvedFirstSession(w: World) {
    // What the intake writes on approval (`IntakeService.applyApproved`): the first session's
    // tasks in the approved order, which is not the priority order.
    const urgent = await w.task("Fix the urgent typo", 9);
    const scaffold = await w.task("Scaffold the repository", 3);
    const ci = await w.task("Set up continuous integration", 5);
    const project = await w.store.project.mustGet(w.project);
    await w.store.project.patch(w.project, {
      summary_cache: {
        ...project.summary_cache,
        first_session: {
          request_id: "req-1",
          approved_at: "2026-03-01T10:00:00.000Z",
          summary: "Scaffold first, then wire CI.",
          estimate_usd_micro: 650_000,
          items: [
            { task_id: scaffold.id, key: "scaffold", title: scaffold.title },
            { task_id: ci.id, key: "ci", title: ci.title },
          ],
        },
      },
    });
    return { urgent, scaffold, ci };
  }

  it("runs the approved tasks in the approved order, then plans by priority", async () => {
    const w = await world();
    await approvedFirstSession(w);
    const r = recorder();
    const first = await start(w, r.exec);
    expect(first.status).toBe("completed");
    expect(r.calls.map((c) => c.title)).toEqual([
      "Scaffold the repository",
      "Set up continuous integration",
    ]);
    expect(first.plan?.summary).toContain("the first session you approved with the project plan");
    // Marked as run, and the session end's own summary write keeps the mark.
    const cache = (await w.store.project.mustGet(w.project)).summary_cache as {
      first_session?: { ran_in_session?: string };
    };
    expect(cache.first_session?.ran_in_session).toBe(first.sessionId);
    // The next session plans as usual.
    const next = await start(w, r.exec);
    expect(next.status).toBe("completed");
    expect(r.calls.map((c) => c.title).slice(2)).toEqual(["Fix the urgent typo"]);
  });

  it("the mark survives a restart: a reopened store plans by priority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-first-session-"));
    const url = `sqlite:${join(dir, "state.db")}`;
    const clock = new SimulatedClock("2026-03-02T07:00:00Z");
    const w = await world(url, clock);
    const { urgent } = await approvedFirstSession(w);
    // The first session runs the approved tasks and is marked as run in the database.
    const r = recorder();
    await start(w, r.exec);
    await w.store.close();
    stores.splice(stores.indexOf(w.store), 1);
    const reopened = await openStore({ url, clock });
    stores.push(reopened);
    const again: World = { ...w, store: reopened };
    await reopened.task.insert({
      project_id: w.project,
      title: "Another ready task",
      outcome: "o",
      status: "ready",
      priority: 1,
      risk_tier: 0,
    });
    const r2 = recorder();
    await start(again, r2.exec);
    expect(r2.calls.map((c) => c.title)).toEqual([urgent.title, "Another ready task"]);
  });

  it("without an approved first session the plan is the priority order", async () => {
    const w = await world();
    await w.task("Low", 1);
    await w.task("High", 9);
    const r = recorder();
    await start(w, r.exec);
    expect(r.calls.map((c) => c.title)).toEqual(["High", "Low"]);
  });
});
