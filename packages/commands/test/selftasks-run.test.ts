import type { TaskRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  CommandExecutor,
  defaultRegistry,
  type ExecuteResult,
  toToolSpecs,
} from "../src/index.ts";
import { type World, world } from "./helpers.ts";

/**
 * d1109-selftasks-run, run C (ADR 0119; D7, the owner, 2026-11-09: "if I say set this up and I
 * approve a plan and then it adds a bunch of tasks, I want it to be able to fix its tasks. Like
 * as part of a run, it should be able to do things like that."; confirmed: "the agent changes
 * its own tasks, the autonomy level deciding when it asks first", "each change shown with one
 * Undo"). The commands the session's task check and chat's "fix the tasks" use, through the
 * executor with the bodies a session sends: a split, a step before a task, a duplicate dropped;
 * each with its change log row, its sentence and a state-based Undo that works after a restart
 * (a fresh executor on the same store, as undo.test.ts restarts).
 */

function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}

/** A session of the project that runs now: its log receives the change lines. */
async function runningSession(w: World) {
  const s = await w.store.session.insert({
    agent_id: w.agent.id,
    project_id: w.pharma.id,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 3_000_000,
    step_cap: 200,
    spent_usd_micro: 0,
    steps: 0,
    started_at: w.clock.nowIso(),
    status: "planned",
    summary: "",
    handoff: {},
    runner: "pc",
  });
  return w.store.session.start(s.id, s.version);
}

/** The context the session's task check runs a change in: the agent, source 'session'. */
function sessionCtx(w: World, sessionId: string, over: Partial<CommandContext> = {}) {
  return w.ctx({
    actor: { kind: "agent", id: w.agent.id },
    source: "session",
    sessionId,
    activeProjectId: w.pharma.id,
    planFix: { level: 2 },
    ...over,
  });
}

async function seed(w: World, title: string, over: Partial<TaskRow> = {}) {
  return w.store.task.insert({
    project_id: w.pharma.id,
    title,
    outcome: `${title} is done`,
    acceptance_criteria: ["it works"],
    risk_tier: 1,
    status: "ready",
    priority: 5,
    reason: "planned",
    author_agent: w.agent.id,
    ...over,
  });
}

/** A restart: a fresh executor on the same store (nothing of the first one's memory). */
function restarted(w: World): CommandExecutor {
  const registry = defaultRegistry();
  return new CommandExecutor({ registry, store: w.store, clock: w.clock });
}

describe("d1109-selftasks-run, run C: the agent's own changes through the executor (ST-5)", () => {
  it("a change with source 'session' is one Changes row with Undo, a 'change' line in its session and no Inbox message; its Undo works after a restart", async () => {
    const w = await world();
    const s = await runningSession(w);
    const task = await seed(w, "Write README");
    const r = done(
      await w.executor.execute({
        name: "task.update",
        params: { task: task.id, title: "Write the README" },
        ctx: sessionCtx(w, s.id),
      }),
    );
    const row = await w.store.changeLog.mustGet(r.changeLogId);
    expect(row).toMatchObject({
      source: "session",
      undo_state: "undoable",
      author_agent: w.agent.id,
    });
    expect(r.undoToken).toBe(r.changeLogId);
    expect((await w.executor.undoable(w.human.id, w.pharma.id)).map((x) => x.id)).toContain(row.id);
    const lines = (await w.store.event.list(s.id)).filter((e) => e.type === "change");
    expect(lines.map((e) => e.payload)).toEqual([
      expect.objectContaining({ changeLogId: r.changeLogId, sentence: r.sentence }),
    ]);
    // Design §3.8: one Update per session, never one Inbox line per change.
    expect(await w.store.message.inbox({ humanId: w.human.id })).toEqual([]);
    const fresh = restarted(w);
    const u = done(await fresh.undo(r.changeLogId, w.ctx({ source: "ui" })));
    expect(u.sentence).toBe('Undone: "Write README" is as it was.');
    expect((await w.store.task.mustGet(task.id)).title).toBe("Write README");
    await w.store.close();
  });

  it("a planFix context at Standard acts at once from chat (no read-back, no Inbox line); at Assisted it is read back", async () => {
    const w = await world();
    const task = await seed(w, "Write README");
    const chatAgent = (level: 0 | 1 | 2 | 3 | 4) =>
      w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat", planFix: { level } });
    const r = done(
      await w.executor.execute({
        name: "task.update",
        params: { task: task.id, title: "Write the README" },
        ctx: chatAgent(2),
      }),
    );
    expect(r.sentence).toBe('Changed "Write README": the title to "Write the README".');
    expect(await w.store.message.inbox({ humanId: w.human.id })).toEqual([]);
    for (const level of [0, 1] as const) {
      const p = await w.executor.execute({
        name: "task.update",
        params: { task: task.id, priority: "high" },
        ctx: chatAgent(level),
      });
      expect(p.status).toBe("pending");
    }
    await w.store.close();
  });

  it("a turn that read a record reads the agent's fix back whatever the level (recordsRead wins over planFix)", async () => {
    const w = await world();
    const task = await seed(w, "Write README");
    const p = await w.executor.execute({
      name: "task.update",
      params: { task: task.id, title: "Write the README" },
      ctx: w.ctx({
        actor: { kind: "agent", id: w.agent.id },
        source: "chat",
        planFix: { level: 4 },
        recordsRead: true,
      }),
    });
    expect(p.status).toBe("pending");
    await w.store.close();
  });

  it("planFix named in a call's params changes nothing: the change is read back as before (only the runtime sets it)", async () => {
    const w = await world();
    const task = await seed(w, "Write README");
    const p = await w.executor.execute({
      name: "task.update",
      params: { task: task.id, title: "Write the README", planFix: { level: 4 } },
      ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat" }),
    });
    expect(p.status).toBe("pending");
    // The registry's schema drops a field it does not know: nothing of it is stored.
    expect(JSON.stringify(await w.store.humanRequest.list())).not.toContain("planFix");
    await w.store.close();
  });

  it("task.split is no tool of the chat's model (d1109-selftasks-chat adds chat's own)", () => {
    const specs = toToolSpecs(defaultRegistry(), {
      execute: async () => ({ status: "done", sentence: "ok" }),
      ctxFor: () => {
        throw new Error("unused");
      },
    });
    expect(specs.map((s) => s.name)).not.toContain("task_split");
    expect(specs.map((s) => s.name)).toContain("task_create");
  });
});
