import { SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import {
  CommandLoop,
  SESSION_START_UNDO_REASON,
  sessionCommandPorts,
} from "../src/loop/commands.ts";
import type { CommandTurn } from "../src/loop/ports.ts";
import { Scheduler } from "../src/session/triggers.ts";

/**
 * The session ports of the command registry (spec Q, E): `session.start` reports what the
 * scheduler did, and the undo of a start that only queued (or was deferred by quiet hours)
 * drops the waiting request instead of stopping the session the agent is running.
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

describe("session commands over the scheduler", () => {
  it("a queued start is undone by dropping the request; a started one and session.stop reach the kill switch", async () => {
    const clock = new SimulatedClock("2026-10-20T09:00:00Z");
    const started: string[] = [];
    const scheduler = new Scheduler({
      clock,
      start: async (req) => {
        started.push(req.reason);
        await new Promise(() => undefined); // the session never ends during the test
      },
    });
    const kill = fakeKill();
    const ports = sessionCommandPorts({ scheduler, kill });
    if (!ports.startSession || !ports.kill) throw new Error("ports missing");
    const first = await ports.startSession({
      agentId: "alice",
      projectId: "p1",
      trigger: "manual",
      reason: "first",
    });
    expect(first).toEqual({ sessionId: undefined, outcome: "started" });
    expect(scheduler.isActive("alice")).toBe(true);
    const second = await ports.startSession({
      agentId: "alice",
      projectId: "p1",
      trigger: "manual",
      reason: "second",
      budgetUsdMicro: 1_000_000,
    });
    expect(second).toEqual({ sessionId: undefined, outcome: "queued" });
    expect(scheduler.pendingFor("alice")?.reason).toBe("second");
    // Undo of the queued start: the request is dropped, nothing running is touched.
    expect(await ports.kill({ agentId: "alice" }, SESSION_START_UNDO_REASON)).toEqual({
      stoppedRuns: 0,
      killedProcesses: 0,
    });
    expect(scheduler.pendingFor("alice")).toBeUndefined();
    expect(kill.calls).toEqual([]);
    expect(scheduler.log.at(-1)).toMatchObject({ result: "cancelled", req: { reason: "second" } });
    expect(scheduler.isActive("alice")).toBe(true);
    // Undo of the start that ran: the agent's session is stopped as before.
    expect(await ports.kill({ agentId: "alice" }, SESSION_START_UNDO_REASON)).toEqual({
      stoppedRuns: 1,
      killedProcesses: 0,
    });
    expect(kill.calls).toEqual([
      { scope: { agentId: "alice" }, reason: SESSION_START_UNDO_REASON },
    ]);
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
    const quietPorts = sessionCommandPorts({ scheduler: quiet, kill });
    expect(
      await quietPorts.startSession?.({ agentId: "bob", trigger: "schedule", reason: "night" }),
    ).toEqual({ sessionId: undefined, outcome: "deferred" });
    expect(await quietPorts.kill?.({ agentId: "bob" }, SESSION_START_UNDO_REASON)).toEqual({
      stoppedRuns: 0,
      killedProcesses: 0,
    });
    expect(quiet.pendingFor("bob")).toBeUndefined();
    expect(started).toEqual(["first"]);
  });

  it("through the registry: session.start while a session runs is queued, and its undo does not kill the running session", async () => {
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
      summary: "",
      handoff: {},
      runner: "pc",
    });
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
      ports: { chfPerUsd: async () => 0.8, ...sessionCommandPorts({ scheduler, kill }) },
    });
    await commands.start();
    const turn: CommandTurn = {
      humanId: human.id,
      agentId: alice.id,
      activeProjectId: project.id,
      sessionId: chat.id,
      source: "text",
      wordsUsed: "start a session on sample with one franc",
    };
    // The agent is busy: the registry's start is queued behind it.
    expect(
      await scheduler.request({ agentId: alice.id, trigger: "manual", reason: "running" }),
    ).toBe("started");
    const started = await commands.execute(
      { name: "session.start", params: { project: "Sample", budgetChf: 1 } },
      turn,
    );
    expect(started.status).toBe("done");
    expect(scheduler.pendingFor(alice.id)?.reason).toContain(human.id);
    const undone = await commands.undo(started.changeLogId ?? null, turn);
    expect(undone.status).toBe("done");
    expect(scheduler.pendingFor(alice.id)).toBeUndefined();
    expect(kill.calls).toEqual([]);
    expect(scheduler.isActive(alice.id)).toBe(true);
    expect((await store.changeLog.mustGet(started.changeLogId ?? "")).undo_state).toBe("undone");
    await store.close();
  });
});
