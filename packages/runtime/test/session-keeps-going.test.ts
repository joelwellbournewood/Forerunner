import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import type { CriticPort, TaskReviewOutcome } from "../src/loop/ports.ts";
import {
  SessionRunner,
  type SessionRunnerDeps,
  StaticPlanner,
  type TaskExecutionResult,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { STOP_NOW_REASON } from "../src/session/stop-words.ts";
import { sessionPausePorts } from "../src/wiring/session-ports.ts";
import { seedWorld } from "./context-helpers.ts";

/**
 * How a session behaves (core-experience design §4; ADR 0102). Before, a session planned once
 * from the tasks ready when it started and ran that fixed list: a 7-task chain took 7 Starts,
 * a task the critic sent back waited for the next Start, a person's Stop read as an error and
 * "kill switch", a model error was reported as the model's first remark, the notes left for
 * the session were used up by a session that ran nothing, and the result was a paragraph that
 * listed tasks just done as "(ready)" with six zero counts.
 */
const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  agent: string;
  project: string;
}

describe("a session keeps going until nothing it can run is left (design §4.2, §4.3)", () => {
  let w: World;
  let ran: string[];
  const add = (title: string, over: Record<string, unknown> = {}) =>
    w.store.task.insert({
      project_id: w.project,
      title,
      outcome: `${title} done`,
      acceptance_criteria: ["works"],
      risk_tier: 0,
      status: "ready",
      priority: 5,
      est_cost_usd_micro: 100_000,
      reason: "seed",
      ...over,
    });
  const doneExecutor: TaskExecutor = {
    async execute({ task }) {
      ran.push(task.title);
      return { outcome: "done", summary: "did it", costUsdMicro: 0, checksPassed: true };
    },
  };
  const runner = (over: Partial<SessionRunnerDeps> = {}) =>
    new SessionRunner({
      store: w.store,
      clock: w.clock,
      tokens: new TokenIssuer({ now: () => w.clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor: doneExecutor,
      ...over,
    });
  const start = (r: SessionRunner, onEvent?: (t: string, p: Record<string, unknown>) => void) =>
    r.start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
      ...(onEvent ? { onEvent } : {}),
    });

  beforeEach(async () => {
    const clock = new SimulatedClock("2026-11-01T09:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const seeded = await seedWorld(store, {}, { session: false });
    w = { store, clock, ...seeded };
    ran = [];
  });
  afterEach(async () => {
    await w.store.close();
  });

  it("one Start runs a whole chain: each task that becomes ready is taken in the same session", async () => {
    const a = await add("Create index.html");
    const b = await add("Add script.js", { depends_on: [a.id] });
    const c = await add("Style the page", { depends_on: [b.id] });
    await add("Write the README", { depends_on: [c.id], priority: 1 });
    const r = await start(runner());
    expect(ran).toEqual([
      "Create index.html",
      "Add script.js",
      "Style the page",
      "Write the README",
    ]);
    expect(r.status).toBe("completed");
    expect(r.completed).toHaveLength(4);
    expect(await w.store.session.forProject(w.project)).toHaveLength(1);
    // The plan on the row grew with what the session took, with the reason.
    const row = await w.store.session.mustGet(r.sessionId);
    expect((row.plan as { items: unknown[] }).items).toHaveLength(4);
    // The result: at most three lines, names not ids, CHF, no "(ready)", no zero counts.
    const lines = r.summary.split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(r.summary).toBe(
      'Did 4 tasks: "Create index.html", "Add script.js", "Style the page" and 1 more.\nNothing left. CHF 0.00.',
    );
    expect(r.summary).not.toContain("(ready)");
    expect(r.summary).not.toMatch(/: 0\b/);
    expect(r.summary).not.toContain("$");
  });

  it("a task the critic sends back is tried again in the same session, and the rework is accepted", async () => {
    const t = await add("Style the page", { risk_tier: 1 });
    let reviews = 0;
    const critic: CriticPort = {
      async reviewTask(req) {
        reviews++;
        const task = await w.store.task.mustGet(req.task.id);
        if (reviews === 1) {
          // What the critic's follow-up does for "revise": back to ready, one attempt more.
          const f = await w.store.task.transition(
            task.id,
            task.version,
            "failed",
            "critic revise",
            {
              agentId: w.agent,
            },
          );
          const back = await w.store.task.transition(
            f.id,
            f.version,
            "ready",
            "retry after critic revise",
            { agentId: w.agent },
          );
          return outcomeOf(back, "revise", reviews);
        }
        const done = await w.store.task.transition(task.id, task.version, "done", "accepted", {
          agentId: w.agent,
        });
        return outcomeOf(done, "accepted", reviews);
      },
      async reviewSession() {
        throw new Error("not under test");
      },
    };
    const r = await start(runner({ critic }));
    expect(ran).toEqual(["Style the page", "Style the page"]);
    expect(r.retried).toEqual([t.id]);
    expect(r.completed).toEqual([t.id]);
    expect((await w.store.task.mustGet(t.id)).status).toBe("done");
    expect(await w.store.session.forProject(w.project)).toHaveLength(1);
  });

  it("Stop now: the task goes back to ready with 'Stopped by you', and no error line", async () => {
    const t = await add("Create the page skeleton");
    const kill = new KillSwitch();
    const executor: TaskExecutor = {
      execute({ signal, session }) {
        ran.push("started");
        return new Promise<TaskExecutionResult>((resolve) => {
          signal.addEventListener("abort", () =>
            resolve({ outcome: "killed", summary: "stopped", costUsdMicro: 0 }),
          );
          void kill.stop({ sessionId: session.id }, STOP_NOW_REASON, { freeze: false });
        });
      },
    };
    const events: string[] = [];
    const lines: Record<string, unknown>[] = [];
    const r = await start(runner({ kill, executor }), (type, p) => {
      events.push(type);
      if (type === "session.stopped") lines.push(p);
    });
    expect(r.stopReason).toBe("you");
    const task = await w.store.task.mustGet(t.id);
    expect(task.status).toBe("ready");
    expect(task.reason).toBe("Stopped by you");
    expect(events).not.toContain("session.error");
    expect(lines[0]?.text).toBe(
      'Stopped by you during "Create the page skeleton". It is ready again.',
    );
    expect(r.summary.split("\n").at(-1)).toBe(
      'Stopped by you. "Create the page skeleton" is ready to continue. CHF 0.00.',
    );
    const row = await w.store.session.mustGet(r.sessionId);
    expect((row.handoff as { stop_reason?: string }).stop_reason).toBe("you");
    // The kill switch is not frozen by a session's Stop now: the next Start works.
    expect(kill.isFrozen({ agentId: w.agent })).toBe(false);
  });

  it("a transient error is tried again once at once; a lasting one fails with the error in words", async () => {
    const t = await add("Create the page skeleton");
    let calls = 0;
    const flaky: TaskExecutor = {
      async execute() {
        calls++;
        if (calls === 1)
          return {
            outcome: "failed",
            summary: "Claude did not answer (model call failed).",
            costUsdMicro: 0,
            errorCode: "provider_error",
          };
        return { outcome: "done", summary: "ok", costUsdMicro: 0, checksPassed: true };
      },
    };
    const r = await start(runner({ executor: flaky }));
    expect(calls).toBe(2);
    expect(r.completed).toEqual([t.id]);
    expect((await w.store.task.mustGet(t.id)).attempt).toBe(0);

    const u = await add("Add script.js");
    calls = 0;
    const broken: TaskExecutor = {
      async execute() {
        calls++;
        return {
          outcome: "failed",
          summary: "Claude did not answer (model call failed).",
          costUsdMicro: 0,
          errorCode: "provider_error",
        };
      },
    };
    const r2 = await start(runner({ executor: broken }));
    expect(calls).toBe(2);
    expect(r2.failed).toEqual([u.id]);
    const row = await w.store.task.mustGet(u.id);
    expect(row.status).toBe("failed");
    expect(row.reason).toBe("Claude did not answer (model call failed).");
    expect(r2.summary.split("\n")[0]).toBe(
      '"Add script.js" failed: claude did not answer (model call failed).',
    );
  });

  it("nothing runnable: nothing is consumed, reviewed or graded, and the result says why", async () => {
    const failedDep = await add("Import the data", { status: "failed" });
    await add("Build the report", { depends_on: [failedDep.id] });
    const note = await w.store.queue.enqueue({
      project_id: w.project,
      human_id: w.human,
      kind: "note",
      text: "Use plain HTML",
      priority: 1,
    });
    let reviewed = 0;
    const critic: CriticPort = {
      async reviewTask() {
        throw new Error("no task runs");
      },
      async reviewSession() {
        reviewed++;
        throw new Error("a session that ran nothing is not reviewed");
      },
    };
    const r = await start(runner({ critic }));
    expect(ran).toEqual([]);
    expect(r.stopReason).toBe("nothing_runnable");
    expect(reviewed).toBe(0);
    expect((await w.store.queue.mustGet(note.id)).status).toBe("queued");
    expect(r.summary.split("\n")[0]).toBe(
      'Nothing could run: "Build the report" waits on "Import the data", which failed.',
    );
    // No Update for a session that ran nothing.
    const updates = await w.store.message.inbox({ humanId: w.human });
    expect(updates).toEqual([]);
  });

  it("notes are used up only by work that finished: a stopped session leaves them for the next", async () => {
    const t = await add("Create the page skeleton");
    const note = await w.store.queue.enqueue({
      project_id: w.project,
      human_id: w.human,
      kind: "note",
      text: "The greeting says good evening after 6 pm",
      priority: 1,
    });
    const kill = new KillSwitch();
    const briefs: string[] = [];
    const stopping: TaskExecutor = {
      execute({ signal, notes, session }) {
        briefs.push((notes ?? []).map((n) => n.text).join("|"));
        return new Promise<TaskExecutionResult>((resolve) => {
          signal.addEventListener("abort", () =>
            resolve({ outcome: "killed", summary: "stopped", costUsdMicro: 0 }),
          );
          void kill.stop({ sessionId: session.id }, STOP_NOW_REASON, { freeze: false });
        });
      },
    };
    await start(runner({ kill, executor: stopping }));
    expect((await w.store.queue.mustGet(note.id)).status).toBe("queued");
    // The next session gives the note again, and uses it up once the task is done.
    const giving: TaskExecutor = {
      async execute({ notes }) {
        briefs.push((notes ?? []).map((n) => n.text).join("|"));
        return { outcome: "done", summary: "ok", costUsdMicro: 0, checksPassed: true };
      },
    };
    const r = await start(runner({ executor: giving }));
    expect(r.completed).toEqual([t.id]);
    expect(briefs).toEqual([
      "The greeting says good evening after 6 pm",
      "The greeting says good evening after 6 pm",
    ]);
    expect((await w.store.queue.mustGet(note.id)).status).toBe("consumed");
  });

  it("live: each model call and tool result moves the session's steps and spend and logs a step line while the task runs (design §4.14)", async () => {
    await add("Create index.html");
    let midRun: { steps: number; spent: number; lines: string[] } | null = null;
    const executor: TaskExecutor = {
      async execute({ session, onStep }) {
        onStep?.({ kind: "model", costUsdMicro: 1_200 });
        onStep?.({ kind: "tool", name: "list_dir", input: { path: "." }, isError: false });
        onStep?.({ kind: "tool", name: "read_file", input: { path: "README.md" }, isError: false });
        onStep?.({ kind: "model", costUsdMicro: 800 });
        onStep?.({
          kind: "tool",
          name: "write_file",
          input: { path: "index.html" },
          isError: false,
        });
        onStep?.({
          kind: "tool",
          name: "run_command",
          input: { command: "node --check script.js" },
          isError: true,
        });
        // Read back while the task still runs, as the session page does.
        await new Promise((r) => setTimeout(r, 20));
        const row = await w.store.session.mustGet(session.id);
        const lines = (await w.store.event.list(session.id))
          .filter((e) => e.type === "task.step")
          .map((e) => String((e.payload as { text?: string }).text));
        midRun = { steps: row.steps, spent: row.spent_usd_micro, lines };
        return { outcome: "done", summary: "ok", costUsdMicro: 2_000, checksPassed: true };
      },
    };
    await start(runner({ executor }));
    expect(midRun).toEqual({
      steps: 6,
      spent: 2_000,
      lines: [
        "looked at the folder",
        "read README.md",
        "wrote index.html",
        "ran node --check script.js: failed",
      ],
    });
  });

  it("Stop after this task: the task in flight finishes, no other starts, nothing is an error (design §4.9)", async () => {
    const a = await add("Create index.html", { priority: 9 });
    const b = await add("Write the README", { priority: 1 });
    const kill = new KillSwitch();
    const executor: TaskExecutor = {
      async execute({ task, session }) {
        ran.push(task.title);
        // What POST /sessions/:id/pause does while the task runs (the pause port).
        await sessionPausePorts({
          store: w.store,
          kill,
          agentId: w.agent,
          humanId: w.human,
        }).pauseSession?.(session.id, "stop after this task");
        return { outcome: "done", summary: "ok", costUsdMicro: 0, checksPassed: true };
      },
    };
    const events: string[] = [];
    const r = await start(runner({ kill, executor }), (type) => events.push(type));
    expect(ran).toEqual(["Create index.html"]);
    expect(r.completed).toEqual([a.id]);
    expect((await w.store.task.mustGet(b.id)).status).toBe("ready");
    expect(r.status).toBe("stopped");
    expect(events).not.toContain("session.error");
    expect(r.summary.split("\n").at(-1)).toMatch(
      /^Stopped after the task, as asked\. "Write the README" is ready to continue\./,
    );
    const row = await w.store.session.mustGet(r.sessionId);
    expect(row.status).toBe("stopped");
  });

  it("done means done: a milestone whose tasks are all done closes, and the project's stage reads done (design §4.13)", async () => {
    const milestone = await w.store.milestone.insert({
      project_id: w.project,
      name: "First version",
      status: "active",
      reason: "the plan",
      author_agent: w.agent,
    });
    const other = await w.store.milestone.insert({
      project_id: w.project,
      name: "Later",
      status: "planned",
      reason: "the plan",
      author_agent: w.agent,
    });
    const a = await add("Create index.html", { milestone_id: milestone.id });
    await add("Write the README", { milestone_id: milestone.id, depends_on: [a.id] });
    const later = await add("Add a share button", { milestone_id: other.id, status: "draft" });
    await start(runner());
    expect((await w.store.milestone.mustGet(milestone.id)).status).toBe("done");
    expect((await w.store.milestone.mustGet(other.id)).status).toBe("planned");
    // A draft is left: the project is not done yet.
    expect((await w.store.project.mustGet(w.project)).stage).toBe("build");
    await w.store.task.transition(later.id, later.version, "cancelled", "not needed", {
      agentId: w.agent,
    });
    const last = await add("Check the page", { milestone_id: other.id });
    const r = await start(runner());
    expect(r.completed).toEqual([last.id]);
    expect((await w.store.milestone.mustGet(other.id)).status).toBe("done");
    const project = await w.store.project.mustGet(w.project);
    expect(project.stage).toBe("done");
    expect((project.summary_cache as { stage?: string }).stage).toBe("done");
  });

  it("the Overview's last result is true now: a structured outcome and next steps from the tasks left", async () => {
    const blocker = await add("Import the data", {
      status: "failed",
      reason: "the file is missing",
    });
    await add("Build the report", { depends_on: [blocker.id] });
    const a = await add("Create index.html");
    const r = await start(runner());
    expect(r.completed).toEqual([a.id]);
    const cache = (await w.store.project.mustGet(w.project)).summary_cache as {
      last_session: { outcome: Record<string, unknown> };
      next_steps: string[];
    };
    expect(cache.last_session.outcome).toMatchObject({
      done: [{ id: a.id, title: "Create index.html" }],
      failed: [],
      needsYou: [],
      waiting: [{ title: "Build the report", waitsOn: ['"Import the data", which failed'] }],
      stopReason: "completed",
    });
    expect(cache.next_steps).toEqual(["Build the report"]);
    // One Update line in the Inbox, naming the project.
    const updates = await w.store.message.inbox({ humanId: w.human });
    expect(updates.map((m) => m.body)).toEqual(['P: did 1 task: "Create index.html".']);
  });
});

function outcomeOf(task: TaskRow, decision: TaskReviewOutcome["decision"], n: number) {
  return {
    reviewId: `review-${n}`,
    tier: 1 as const,
    verdict: decision === "accepted" ? ("accept" as const) : ("revise" as const),
    grade: decision === "accepted" ? 90 : 40,
    confidence: 0.9,
    summary: decision,
    findings: [],
    openFindings: 0,
    decision,
    attempt: task.attempt,
    costUsdMicro: 0,
    resolvedFindingIds: [],
    lessonProposals: [],
    quarantinedLessons: [],
    task,
  } as TaskReviewOutcome;
}
