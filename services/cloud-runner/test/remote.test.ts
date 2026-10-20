import { SimulatedClock } from "@forerunner/platform";
import { KillSwitch, type StartRequest, TokenIssuer } from "@forerunner/runtime";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REMOTE_AUDIT_TOOL, RemoteCommandWatcher } from "../src/remote.ts";
import { type Seed, seedWorld } from "./helpers.ts";

/**
 * Remote commands from the shared state: a kill from any device stops the runner's runs within
 * one poll interval, stop lifts the freeze, start resumes and asks the scheduler, pause is
 * refused, and every command gets a result row and an audit row.
 */
let store: StateStore;
let clock: SimulatedClock;
let seed: Seed;
let kill: KillSwitch;
let phoneId: string;
let runnerId: string;
const started: StartRequest[] = [];

beforeEach(async () => {
  clock = new SimulatedClock("2026-03-02T22:00:00Z");
  store = await openStore({ url: "sqlite::memory:", clock });
  seed = await seedWorld(store);
  kill = new KillSwitch(new TokenIssuer({ now: () => clock.now() }));
  started.length = 0;
  phoneId = (
    await store.device.register({
      owner_human_id: seed.human.id,
      name: "phone",
      platform: "android",
      public_key: "pk-phone",
      kind: "phone",
    })
  ).id;
  runnerId = (
    await store.device.register({
      owner_human_id: seed.human.id,
      name: "runner-test",
      platform: "linux-runner",
      public_key: "pk-runner",
      kind: "runner",
    })
  ).id;
});
afterEach(async () => {
  await store.close();
});

function watcher(pollMs = 500) {
  return new RemoteCommandWatcher({
    store,
    clock,
    kill,
    runnerDeviceId: runnerId,
    agentId: seed.agent.id,
    humanId: seed.human.id,
    pollMs,
    start: async (req) => {
      started.push(req);
      return "started";
    },
  });
}

describe("remote commands from the shared state", () => {
  it("a kill stops every registered run within one poll interval and freezes new work", async () => {
    const controller = new AbortController();
    kill.register({
      agentId: seed.agent.id,
      sessionId: "s1",
      controller,
      label: "cloud session",
    });
    const w = watcher(500);
    w.start();
    const row = await store.remoteCommand.enqueue({
      device_id: phoneId,
      target: "cloud",
      command: "kill",
      params: { reason: "stop everything" },
    });
    const t0 = Date.now();
    await clock.advance(500);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(controller.signal.aborted).toBe(true);
    expect(kill.isFrozen({ agentId: seed.agent.id })).toBe(true);
    const done = await store.remoteCommand.mustGet(row.id);
    expect(done.status).toBe("done");
    expect(done.result).toMatchObject({ stoppedRuns: 1 });
    expect(w.stats).toMatchObject({ handled: 1 });
    expect(w.stats.lastKill?.durationMs).toBeLessThan(2_000);
    const audit = await store.auditLog.list({ tool: REMOTE_AUDIT_TOOL });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ allowed: true, agent_id: seed.agent.id });
    expect(JSON.parse(audit[0]?.input_summary ?? "{}")).toMatchObject({
      command: "kill",
      deviceId: phoneId,
    });
    w.stop();
  });

  it("stop ends the agent's runs but lifts the freeze; start resumes and asks the scheduler", async () => {
    const controller = new AbortController();
    kill.register({ agentId: seed.agent.id, sessionId: "s2", controller, label: "run" });
    const w = watcher();
    await store.remoteCommand.enqueue({ device_id: phoneId, target: "cloud", command: "stop" });
    expect(await w.drain()).toBe(1);
    expect(controller.signal.aborted).toBe(true);
    expect(kill.isFrozen({ agentId: seed.agent.id })).toBe(false);

    await kill.stop("all");
    expect(kill.isFrozen({ agentId: seed.agent.id })).toBe(true);
    const start = await store.remoteCommand.enqueue({
      device_id: phoneId,
      target: "cloud",
      command: "start",
      params: { projectId: seed.project.id, budgetUsdMicro: 2_000_000 },
    });
    expect(await w.drain()).toBe(1);
    expect(kill.isFrozen({ agentId: seed.agent.id })).toBe(false);
    expect(started).toEqual([
      expect.objectContaining({
        agentId: seed.agent.id,
        projectId: seed.project.id,
        trigger: "remote",
        budgetUsdMicro: 2_000_000,
      }),
    ]);
    expect((await store.remoteCommand.mustGet(start.id)).result).toMatchObject({
      result: "started",
    });
  });

  it("pause is refused with a failed result; commands for the PC or another runner are left alone", async () => {
    const w = watcher();
    const pause = await store.remoteCommand.enqueue({
      device_id: phoneId,
      target: "cloud",
      command: "pause",
    });
    const forPc = await store.remoteCommand.enqueue({
      device_id: phoneId,
      target: "pc",
      command: "kill",
    });
    const otherRunner = await store.device.register({
      owner_human_id: seed.human.id,
      name: "runner-2",
      platform: "linux-runner",
      public_key: "pk-runner-2",
      kind: "runner",
    });
    const forOther = await store.remoteCommand.enqueue({
      device_id: phoneId,
      target: "cloud",
      target_device_id: otherRunner.id,
      command: "kill",
    });
    expect(await w.drain()).toBe(1);
    expect((await store.remoteCommand.mustGet(pause.id)).status).toBe("failed");
    expect((await store.remoteCommand.mustGet(forPc.id)).status).toBe("pending");
    expect((await store.remoteCommand.mustGet(forOther.id)).status).toBe("pending");
    const audit = await store.auditLog.list({ tool: REMOTE_AUDIT_TOOL });
    expect(audit[0]).toMatchObject({ allowed: false });
    expect(audit[0]?.denied_reason).toMatch(/pause/);
  });

  it("refuses commands from another human's device and a start for another agent; the runner's run survives", async () => {
    // Human B with an agent and a phone on the same shared state. The store's pickUp is keyed
    // on the target only, so B's commands land on A's runner; the watcher must refuse them.
    const humanB = await store.human.insert({
      name: "B",
      email: "b@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 0,
      locale: "en",
    });
    const agentB = await store.agent.insert({
      name: "Bobby",
      owner_human_id: humanB.id,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    });
    const phoneB = await store.device.register({
      owner_human_id: humanB.id,
      name: "B's phone",
      platform: "android",
      public_key: "pk-phone-b",
      kind: "phone",
    });
    const controller = new AbortController();
    kill.register({ agentId: seed.agent.id, sessionId: "s3", controller, label: "A's session" });
    const w = watcher();
    const startB = await store.remoteCommand.enqueue({
      device_id: phoneB.id,
      target: "cloud",
      command: "start",
      params: { agentId: agentB.id },
    });
    const killB = await store.remoteCommand.enqueue({
      device_id: phoneB.id,
      target: "cloud",
      command: "kill",
    });
    // A's own phone asking this runner to run B's agent is refused as well.
    const startOtherAgent = await store.remoteCommand.enqueue({
      device_id: phoneId,
      target: "cloud",
      command: "start",
      params: { agentId: agentB.id },
    });
    expect(await w.drain()).toBe(3);
    expect(controller.signal.aborted).toBe(false);
    expect(kill.isFrozen({ agentId: seed.agent.id })).toBe(false);
    expect(started).toHaveLength(0);
    for (const id of [startB.id, killB.id]) {
      const row = await store.remoteCommand.mustGet(id);
      expect(row.status).toBe("failed");
      expect(row.result).toMatchObject({ error: "forbidden: device of another human" });
    }
    const other = await store.remoteCommand.mustGet(startOtherAgent.id);
    expect(other.status).toBe("failed");
    expect(String((other.result as { error?: unknown })?.error)).toMatch(
      /forbidden: agent .* is not this runner's agent/,
    );
    const audit = await store.auditLog.list({ tool: REMOTE_AUDIT_TOOL });
    expect(audit).toHaveLength(3);
    for (const row of audit) {
      expect(row.allowed).toBe(false);
      expect(row.denied_reason).toMatch(/^forbidden: /);
      expect(row.human_id).toBe(seed.human.id);
    }
  });
});
