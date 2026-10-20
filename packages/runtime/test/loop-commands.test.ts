import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import {
  CommandLoop,
  SESSION_START_ENDED_REASON,
  SESSION_START_UNDO_REASON,
  sessionCommandPorts,
} from "../src/loop/commands.ts";
import type { CommandTurn } from "../src/loop/ports.ts";
import { Scheduler, type StartRequest } from "../src/session/triggers.ts";

/**
 * The session ports of the command registry (spec Q, E; the kill switch of spec "Security"):
 * `session.start` reports what the scheduler did; the undo of a start that only queued (or
 * was deferred by quiet hours) drops the waiting request instead of stopping the session the
 * agent is running; the undo of a start whose session is still running stops that session
 * only, never the agent's scope; and the undo of a start whose session already ended is a
 * no-op with a clear message that leaves the kill switch open and marks the change row
 * irreversible (follow-up RT-P5-2 of the phase 5 gate).
 */
function fakeKill() {
  const calls: { scope: unknown; reason: string }[] = [];
  return {
    calls,
    async stop(scope: unknown, reason: string) {
      calls.push({ scope, reason });
      return { stoppedRuns: 1, killedProcesses: 0 };
    },
  };
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

interface StoreWorld {
  clock: SimulatedClock;
  store: StateStore;
  humanId: string;
  agentId: string;
  projectId: string;
  otherProjectId: string;
  /** The principal's conversation session (the change log's activity log). */
  chatId: string;
  turn: CommandTurn;
}

async function storeWorld(): Promise<StoreWorld> {
  const clock = new SimulatedClock("2026-10-20T09:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = await store.human.insert({
    name: "J",
    email: "j@example.test",
    timezone: "Europe/Zurich",
    notify_prefs: {},
    default_autonomy: 2,
    monthly_cap_usd_micro: 150_000_000,
    locale: "en",
  });
  const alice = await store.agent.insert({
    name: "Alice",
    owner_human_id: human.id,
    model_config: {},
    memory_location: "local",
    status: "active",
    kind: "principal",
  });
  const project = await store.project.insert({ name: "Sample", goal: "Ship the sample" });
  const other = await store.project.insert({ name: "Game", goal: "Ship the game" });
  const chat = await store.session.insert({
    agent_id: alice.id,
    project_id: project.id,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 0,
    step_cap: 1,
    spent_usd_micro: 0,
    steps: 0,
    started_at: clock.nowIso(),
    status: "running",
    summary: "conversation",
    handoff: {},
    runner: "pc",
  });
  return {
    clock,
    store,
    humanId: human.id,
    agentId: alice.id,
    projectId: project.id,
    otherProjectId: other.id,
    chatId: chat.id,
    turn: {
      humanId: human.id,
      agentId: alice.id,
      activeProjectId: project.id,
      sessionId: chat.id,
      source: "text",
      wordsUsed: "start a session on sample with one franc",
    },
  };
}

/**
 * A scheduler whose `start` makes a real session row: `mode` says whether the session ends at
 * once (`completed`) or stays running until `release()`.
 */
function sessionScheduler(w: StoreWorld) {
  let mode: "completed" | "running" = "completed";
  let release: (() => void) | null = null;
  const started: StartRequest[] = [];
  const scheduler = new Scheduler({
    clock: w.clock,
    start: async (req) => {
      started.push(req);
      const row = await w.store.session.insert({
        agent_id: req.agentId,
        project_id: req.projectId ?? w.projectId,
        trigger: req.trigger,
        plan: {},
        budget_cap_usd_micro: 1_000_000,
        step_cap: 10,
        spent_usd_micro: 0,
        steps: 0,
        started_at: w.clock.nowIso(),
        status: "running",
        summary: "",
        handoff: {},
        runner: "pc",
      });
      if (mode === "running") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const current = await w.store.session.mustGet(row.id);
      await w.store.session.setStatus(current.id, current.version, "completed");
    },
  });
  return {
    scheduler,
    started,
    setMode(m: typeof mode) {
      mode = m;
    },
    async release() {
      release?.();
      release = null;
      await settle();
    },
  };
}

describe("session commands over the scheduler", () => {
  it("a queued start is undone by dropping the request; a started one and session.stop reach the kill switch", async () => {
    const clock = new SimulatedClock("2026-10-20T09:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const started: string[] = [];
    const scheduler = new Scheduler({
      clock,
      start: async (req) => {
        started.push(req.reason);
        await new Promise(() => undefined); // the session never ends during the test
      },
    });
    const kill = fakeKill();
    const ports = sessionCommandPorts({ scheduler, kill, store });
    if (!ports.startSession || !ports.kill) throw new Error("ports missing");
    const first = await ports.startSession({
      agentId: "alice",
      projectId: "p1",
      trigger: "manual",
      reason: "first",
    });
    expect(first).toEqual({
      sessionId: undefined,
      startId: scheduler.activeStart("alice")?.id,
      outcome: "started",
    });
    expect(typeof first?.startId).toBe("string");
    expect(scheduler.isActive("alice")).toBe(true);
    const second = await ports.startSession({
      agentId: "alice",
      projectId: "p1",
      trigger: "manual",
      reason: "second",
      budgetUsdMicro: 1_000_000,
    });
    expect(second).toEqual({
      sessionId: undefined,
      startId: scheduler.pendingStart("alice")?.id,
      outcome: "queued",
    });
    expect(second?.startId).not.toBe(first?.startId);
    expect(scheduler.pendingFor("alice")?.reason).toBe("second");
    // The undo of the running start while the queued one waits: the queued request is not
    // it; the store has no session row for the running one (this scheduler makes none), so
    // nothing is stopped, nothing is dropped and the agent's scope is never frozen.
    expect(
      await ports.kill({ agentId: "alice", startId: first?.startId }, SESSION_START_UNDO_REASON),
    ).toEqual({ stoppedRuns: 0, killedProcesses: 0 });
    expect(kill.calls).toEqual([]);
    expect(scheduler.pendingFor("alice")?.reason).toBe("second");
    // Undo of the queued start: the request is dropped, nothing running is touched.
    expect(
      await ports.kill({ agentId: "alice", startId: second?.startId }, SESSION_START_UNDO_REASON),
    ).toEqual({ stoppedRuns: 0, killedProcesses: 0 });
    expect(scheduler.pendingFor("alice")).toBeUndefined();
    expect(kill.calls).toEqual([]);
    expect(scheduler.log.at(-1)).toMatchObject({
      id: second?.startId,
      result: "cancelled",
      req: { reason: "second" },
    });
    expect(scheduler.isActive("alice")).toBe(true);
    // An undo that names no start (a row from before starts had one) matches nothing.
    expect(await ports.kill({ agentId: "alice" }, SESSION_START_UNDO_REASON)).toEqual({
      stoppedRuns: 0,
      killedProcesses: 0,
    });
    expect(kill.calls).toEqual([]);
    expect(scheduler.isActive("alice")).toBe(true);
    expect(await ports.startUndoState("alice")).toBe("ended");
    expect(await ports.startUndoState("alice", first?.startId)).toBe("running");
    expect(await ports.startUndoState("alice", second?.startId)).toBe("ended");
    // session.stop with a queued request behind an active session still stops the session.
    await ports.startSession({
      agentId: "alice",
      projectId: "p1",
      trigger: "manual",
      reason: "third",
    });
    await ports.kill({ agentId: "alice" }, "stop requested");
    expect(kill.calls.at(-1)).toEqual({ scope: { agentId: "alice" }, reason: "stop requested" });
    expect(scheduler.pendingFor("alice")?.reason).toBe("third");
    // A deferred start (quiet hours) is dropped the same way.
    const quiet = new Scheduler({
      clock,
      start: async () => undefined,
      isQuietHours: () => true,
    });
    const quietPorts = sessionCommandPorts({ scheduler: quiet, kill, store });
    const night = await quietPorts.startSession?.({
      agentId: "bob",
      trigger: "schedule",
      reason: "night",
    });
    expect(night).toEqual({
      sessionId: undefined,
      startId: quiet.pendingStart("bob")?.id,
      outcome: "deferred",
    });
    expect(await quietPorts.startUndoState("bob", night?.startId)).toBe("pending");
    expect(
      await quietPorts.kill?.(
        { agentId: "bob", startId: night?.startId },
        SESSION_START_UNDO_REASON,
      ),
    ).toEqual({ stoppedRuns: 0, killedProcesses: 0 });
    expect(quiet.pendingFor("bob")).toBeUndefined();
    expect(started).toEqual(["first"]);
    await store.close();
  });

  it("through the registry: session.start while a session runs is queued, and its undo does not kill the running session", async () => {
    const w = await storeWorld();
    const { store, clock } = w;
    const scheduler = new Scheduler({
      clock,
      start: async () => {
        await new Promise(() => undefined);
      },
    });
    const kill = fakeKill();
    const commands = new CommandLoop({
      store,
      clock,
      ports: { chfPerUsd: async () => 0.8, ...sessionCommandPorts({ scheduler, kill, store }) },
    });
    await commands.start();
    // The agent is busy: the registry's start is queued behind it.
    expect(
      await scheduler.request({ agentId: w.agentId, trigger: "manual", reason: "running" }),
    ).toBe("started");
    const started = await commands.execute(
      { name: "session.start", params: { project: "Sample", budgetChf: 1 } },
      w.turn,
    );
    expect(started.status).toBe("done");
    expect(scheduler.pendingFor(w.agentId)?.reason).toContain(w.humanId);
    const undone = await commands.undo(started.changeLogId ?? null, w.turn);
    expect(undone.status).toBe("done");
    expect(scheduler.pendingFor(w.agentId)).toBeUndefined();
    expect(kill.calls).toEqual([]);
    expect(scheduler.isActive(w.agentId)).toBe(true);
    expect((await store.changeLog.mustGet(started.changeLogId ?? "")).undo_state).toBe("undone");
    await store.close();
  });

  it("the undo of a session.start whose session ended is a no-op with a clear message: nothing stopped, the kill switch open, the change row irreversible; a running start is stopped as that session only", async () => {
    const w = await storeWorld();
    const { store, clock } = w;
    const kill = new KillSwitch(new TokenIssuer({ now: () => clock.now() }));
    const stops: { scope: unknown; reason: string }[] = [];
    kill.onStop((report, reason) => stops.push({ scope: report.scope, reason }));
    const sched = sessionScheduler(w);
    const { startUndoState, ...ports } = sessionCommandPorts({
      scheduler: sched.scheduler,
      kill,
      store,
    });
    const commands = new CommandLoop({
      store,
      clock,
      ports: { chfPerUsd: async () => 0.8, ...ports },
      startUndoState,
    });
    await commands.start();
    const startCommand = { name: "session.start", params: { project: "Sample", budgetChf: 1 } };

    // 1. The start ran and its session completed hours ago.
    const ended = await commands.execute(startCommand, w.turn);
    expect(ended.status).toBe("done");
    await settle();
    expect(sched.started).toHaveLength(1);
    expect(sched.scheduler.isActive(w.agentId)).toBe(false);
    await clock.advance(3 * 3_600_000);
    const undoEnded = await commands.undo(ended.changeLogId ?? null, w.turn);
    expect(undoEnded.status).toBe("refused");
    expect(undoEnded.reason).toBe(SESSION_START_ENDED_REASON);
    expect(undoEnded.reason).toContain("already ended");
    expect(stops).toEqual([]);
    expect(kill.isFrozen({ agentId: w.agentId })).toBe(false);
    const endedRow = await store.changeLog.mustGet(ended.changeLogId ?? "");
    expect(endedRow.undo_state).toBe("irreversible");
    expect(endedRow.undone_at).toBeNull();
    // Nothing is offered for undo any more, and a second attempt is refused as such.
    expect(
      (await commands.changeLog({ humanId: w.humanId, undoable: true })).map((r) => r.id),
    ).not.toContain(ended.changeLogId);
    expect((await commands.undo(ended.changeLogId ?? null, w.turn)).reason).toContain(
      "irreversible",
    );
    // No undo row was written for the no-op: the change log shows the start and nothing else.
    expect(
      (await commands.changeLog({ humanId: w.humanId })).map((r) => r.commands.length),
    ).toEqual([1]);

    // 2. A start whose session is still running: the undo stops that session only.
    sched.setMode("running");
    const running = await commands.execute(startCommand, w.turn);
    await settle();
    expect(sched.scheduler.isActive(w.agentId)).toBe(true);
    const live = (await store.session.active(w.agentId)).filter(
      (s) => s.summary !== "conversation",
    );
    expect(live).toHaveLength(1);
    const liveId = live[0]?.id ?? "";
    const undoRunning = await commands.undo(running.changeLogId ?? null, w.turn);
    expect(undoRunning.status).toBe("done");
    expect(stops).toEqual([
      { scope: { agentId: w.agentId, sessionId: liveId }, reason: SESSION_START_UNDO_REASON },
    ]);
    expect(kill.isFrozen({ agentId: w.agentId })).toBe(false);
    expect(kill.isFrozen({ agentId: w.agentId, sessionId: liveId })).toBe(true);
    expect(kill.isFrozen({ agentId: w.agentId, sessionId: "another" })).toBe(false);
    expect((await store.changeLog.mustGet(running.changeLogId ?? "")).undo_state).toBe("undone");
    await sched.release();
    expect((await store.session.mustGet(liveId)).status).toBe("completed");
    kill.resume();

    // 3. The start's session ended and a scheduled session of the agent runs now: the undo of
    // the old start is the no-op, the scheduled session is untouched.
    sched.setMode("completed");
    const old = await commands.execute(startCommand, w.turn);
    await settle();
    sched.setMode("running");
    expect(
      await sched.scheduler.request({
        agentId: w.agentId,
        projectId: w.projectId,
        trigger: "schedule",
        reason: "daily at 06:00",
      }),
    ).toBe("started");
    await settle();
    const scheduled = (await store.session.active(w.agentId)).filter(
      (s) => s.summary !== "conversation",
    );
    expect(scheduled.map((s) => s.trigger)).toEqual(["schedule"]);
    const undoOld = await commands.undo(old.changeLogId ?? null, w.turn);
    expect(undoOld.status).toBe("refused");
    expect(undoOld.reason).toBe(SESSION_START_ENDED_REASON);
    expect(stops).toHaveLength(1);
    expect(kill.isFrozen({ agentId: w.agentId })).toBe(false);
    expect((await store.changeLog.mustGet(old.changeLogId ?? "")).undo_state).toBe("irreversible");
    expect((await store.session.mustGet(scheduled[0]?.id ?? "")).status).toBe("running");
    await sched.release();

    // 4. The phone's plan: a composed change (switch the project, start a session) whose
    // session ended is undone as a whole; the start part is the no-op, the switch is undone.
    sched.setMode("completed");
    const plan = await commands.compose(
      [{ name: "project.switch", params: { project: "Game" } }, startCommand],
      w.turn,
    );
    expect(plan.status).toBe("done");
    expect(await commands.activeProject(w.humanId)).toBe(w.otherProjectId);
    await settle();
    expect(sched.scheduler.isActive(w.agentId)).toBe(false);
    const undoPlan = await commands.undo(plan.changeLogId ?? null, w.turn);
    expect(undoPlan.status).toBe("done");
    expect(await commands.activeProject(w.humanId)).toBe(w.projectId);
    expect(stops).toHaveLength(1);
    expect(kill.isFrozen({ agentId: w.agentId })).toBe(false);
    expect((await store.changeLog.mustGet(plan.changeLogId ?? "")).undo_state).toBe("undone");
    await store.close();
  });

  it("the undo is tied to the start it undoes: an earlier start whose session ended is the no-op while a later start of the agent runs; the later start's undo stops its session only, never a cloud session of the agent; a queued start that ran is stopped under its own identity", async () => {
    const w = await storeWorld();
    const { store, clock } = w;
    const kill = new KillSwitch(new TokenIssuer({ now: () => clock.now() }));
    const stops: { scope: unknown; reason: string }[] = [];
    kill.onStop((report, reason) => stops.push({ scope: report.scope, reason }));
    const sched = sessionScheduler(w);
    const { startUndoState, ...ports } = sessionCommandPorts({
      scheduler: sched.scheduler,
      kill,
      store,
    });
    const commands = new CommandLoop({
      store,
      clock,
      ports: { chfPerUsd: async () => 0.8, ...ports },
      startUndoState,
    });
    await commands.start();
    const startCommand = { name: "session.start", params: { project: "Sample", budgetChf: 1 } };
    const workSessions = async () =>
      (await store.session.active(w.agentId)).filter((s) => s.summary !== "conversation");

    // Morning: a start by chat whose session completed.
    const morning = await commands.execute(startCommand, w.turn);
    expect(morning.status).toBe("done");
    await settle();
    const morningRow = (await store.session.list({ agent_id: w.agentId })).find(
      (s) => s.summary !== "conversation",
    );
    expect(morningRow?.status).toBe("completed");
    const morningAfter = (await store.changeLog.mustGet(morning.changeLogId ?? "")).after as {
      start_id?: unknown;
      session_id?: unknown;
    };
    expect(typeof morningAfter.start_id).toBe("string");
    expect(morningAfter.session_id).toBeNull();
    await clock.advance(6 * 3_600_000);

    // Afternoon: a second start of the same agent (from the phone, say), still running, and a
    // session of the agent on the cloud runner (another runner's row in the shared store).
    sched.setMode("running");
    const afternoon = await commands.execute(startCommand, w.turn);
    expect(afternoon.status).toBe("done");
    await settle();
    const live = await workSessions();
    expect(live).toHaveLength(1);
    const liveId = live[0]?.id ?? "";
    expect(liveId).not.toBe(morningRow?.id);
    const cloud = await store.session.insert({
      agent_id: w.agentId,
      project_id: w.projectId,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 1_000_000,
      step_cap: 10,
      spent_usd_micro: 0,
      steps: 0,
      started_at: clock.nowIso(),
      status: "running",
      summary: "",
      handoff: {},
      runner: "cloud",
    });

    // The undo of the morning's start from the Changes screen: that session ended; the
    // afternoon's session is not it and keeps running, the kill switch stays open.
    const undoMorning = await commands.undo(morning.changeLogId ?? null, w.turn);
    expect(undoMorning.status).toBe("refused");
    expect(undoMorning.reason).toBe(SESSION_START_ENDED_REASON);
    expect(stops).toEqual([]);
    expect(kill.isFrozen({ agentId: w.agentId })).toBe(false);
    expect(kill.isFrozen({ agentId: w.agentId, sessionId: liveId })).toBe(false);
    expect((await store.session.mustGet(liveId)).status).toBe("running");
    expect((await store.changeLog.mustGet(morning.changeLogId ?? "")).undo_state).toBe(
      "irreversible",
    );

    // The undo of the afternoon's start stops that session only: not the agent's scope, not
    // the cloud session.
    const undoAfternoon = await commands.undo(afternoon.changeLogId ?? null, w.turn);
    expect(undoAfternoon.status).toBe("done");
    expect(stops).toEqual([
      { scope: { agentId: w.agentId, sessionId: liveId }, reason: SESSION_START_UNDO_REASON },
    ]);
    expect(kill.isFrozen({ agentId: w.agentId })).toBe(false);
    expect(kill.isFrozen({ agentId: w.agentId, sessionId: cloud.id })).toBe(false);
    expect(kill.isFrozen({ agentId: w.agentId, sessionId: liveId })).toBe(true);
    expect((await store.changeLog.mustGet(afternoon.changeLogId ?? "")).undo_state).toBe("undone");
    await sched.release();
    kill.resume();
    const cloudNow = await store.session.mustGet(cloud.id);
    await store.session.setStatus(cloudNow.id, cloudNow.version, "completed");

    // A start queued behind a running session keeps its identity when the scheduler drains
    // the queue: its undo stops the session it then began.
    expect(
      await sched.scheduler.request({
        agentId: w.agentId,
        projectId: w.projectId,
        trigger: "manual",
        reason: "busy",
      }),
    ).toBe("started");
    await settle();
    const queued = await commands.execute(startCommand, w.turn);
    expect(queued.status).toBe("done");
    expect(sched.scheduler.pendingFor(w.agentId)?.reason).toContain(w.humanId);
    await sched.release(); // the busy session ends
    expect(sched.scheduler.isActive(w.agentId)).toBe(false);
    await sched.scheduler.tick(); // the queue drains: the queued start runs now
    await settle();
    const drained = await workSessions();
    expect(drained.map((s) => s.status)).toEqual(["running"]);
    const undoQueued = await commands.undo(queued.changeLogId ?? null, w.turn);
    expect(undoQueued.status).toBe("done");
    expect(stops.at(-1)).toEqual({
      scope: { agentId: w.agentId, sessionId: drained[0]?.id },
      reason: SESSION_START_UNDO_REASON,
    });
    expect(kill.isFrozen({ agentId: w.agentId })).toBe(false);
    await sched.release();
    await store.close();
  });
});
