import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { DeviceRow } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { KillFileWatcher, readKillRequest } from "../src/enforcement/killfile.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { ScriptedProvider } from "./helpers.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");

/**
 * U-019: the kill switch writes `<runtime>/kill.json` so a kill survives a crash, and every
 * runtime reads it when it starts. Resume used to lift the kill in the running daemon only, so
 * the next start (opening the app, a restart, an update) applied the old kill again and
 * sessions refused to start with "kill switch is active for this agent; resume it first".
 */
describe("kill switch resume survives a restart (U-019)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let runtimeDir = "";
  const clock = new SimulatedClock("2026-10-31T08:00:00Z");
  const req = (path: string, body: unknown = {}) =>
    app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-kill-resume-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    runtimeDir = dirs.runtime;
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("keeps the kill for the next start until Resume, and drops it on Resume", async () => {
    expect((await req("/kill", { scope: "all", reason: "test" })).status).toBe(200);
    // Until Resume, a new start applies the kill again (a crash does not lift it).
    expect(readKillRequest(runtimeDir)).not.toBeNull();
    const before = new KillSwitch();
    expect(await new KillFileWatcher(before, clock, runtimeDir).check()).toBe(true);
    expect(before.isFrozen({ agentId: rt.agent.id })).toBe(true);

    const resumed = await req("/kill/resume");
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { killActive: boolean }).killActive).toBe(false);

    // The next start finds no kill to apply.
    expect(readKillRequest(runtimeDir)).toBeNull();
    const after = new KillSwitch();
    expect(await new KillFileWatcher(after, clock, runtimeDir).check()).toBe(false);
    expect(after.isFrozen({ agentId: rt.agent.id })).toBe(false);
  });
});

/**
 * U-032: the other ways a kill is lifted. Starting a session from the phone (a plain `start`,
 * or a plan with a `session.start` step) lifts the kill in the running daemon but left
 * `kill.json`, so the next start stopped everything again. A session's Stop button lifted the
 * kill the person had set with Stop all (the stop replaced the freeze, and its `resume()`
 * lifted it), while the file still brought it back after a restart. Each case below is
 * followed by a restart: a fresh kill switch and its `KillFileWatcher` on the same runtime
 * directory, which is what every runtime does when it starts.
 */
describe("every path that lifts the kill also lifts it for the next start (U-032)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let runtimeDir = "";
  let phone: DeviceRow;
  const clock = new SimulatedClock("2026-10-31T08:00:00Z");
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
  /** What the header shows: the kill banner and Resume while `killActive` is true. */
  const killShown = async () =>
    ((await (await call("GET", "/health")).json()) as { killActive: boolean }).killActive;
  /** Quit and open Forerunner again: a new kill switch reads the runtime directory. */
  const killAfterRestart = async () => {
    const next = new KillSwitch();
    await new KillFileWatcher(next, clock, runtimeDir).check();
    return next.isFrozen({ agentId: rt.agent.id });
  };
  const stopAll = async () => {
    expect(
      (await call("POST", "/kill", { scope: "all", reason: "stop all from the UI" })).status,
    ).toBe(200);
    expect(await killShown()).toBe(true);
    expect(readKillRequest(runtimeDir)).not.toBeNull();
  };
  /** A command the paired phone sends, picked up by the daemon's next poll. */
  const fromPhone = async (command: string, params: Record<string, unknown>) => {
    const row = await rt.store.remoteCommand.enqueue({
      device_id: phone.id,
      target: "pc",
      command,
      params: params as never,
    });
    await rt.remote.watcher?.drain();
    return rt.store.remoteCommand.mustGet(row.id);
  };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-kill-paths-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    runtimeDir = dirs.runtime;
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Done for today." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      remote: { enabled: true, pollMs: 60_000, heartbeatMs: 3_600_000, deviceName: "J's PC" },
    });
    ({ app, token } = createDaemonApp(rt));
    phone = await rt.store.device.register({
      owner_human_id: rt.human.id,
      name: "J's phone",
      platform: "android",
      public_key: ["pk-", "P".repeat(40)].join(""), // not-a-secret
      kind: "phone",
    });
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("start from the phone: the kill is lifted now and after a restart", async () => {
    await stopAll();
    const done = await fromPhone("start", { reason: "start from the phone" });
    expect(done.status).toBe("done");
    expect(await killShown()).toBe(false);
    expect(readKillRequest(runtimeDir)).toBeNull();
    expect(await killAfterRestart()).toBe(false);
  });

  it("a plan from the phone that starts a session: the kill is lifted now and after a restart", async () => {
    const project = await rt.store.project.insert({
      name: "Garden",
      goal: "plant the beds",
      autonomy_level: 2,
    });
    await stopAll();
    const done = await fromPhone("start", {
      v: 1,
      kind: "plan",
      plan: [{ name: "session.start", params: { project: project.id } }],
      wordsUsed: "start a session",
      clientId: "c-start-after-kill",
      confirmedAt: clock.nowIso(),
    });
    expect(done.status).toBe("done");
    expect(await killShown()).toBe(false);
    expect(readKillRequest(runtimeDir)).toBeNull();
    expect(await killAfterRestart()).toBe(false);
  });

  it("Stop on one session during Stop all keeps the kill, now and after a restart", async () => {
    const session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: null,
      trigger: "manual",
      plan: {},
      status: "running",
      started_at: clock.nowIso(),
      summary: "a session left running",
      author_agent: rt.agent.id,
    });
    await stopAll();
    const stopped = await call("POST", `/sessions/${session.id}/stop`, {
      reason: "stopped from the live view",
    });
    expect(stopped.status).toBe(200);
    expect(await killShown()).toBe(true);
    expect(await killAfterRestart()).toBe(true);
    // Resume is still the one way out, and it holds after a restart.
    expect((await call("POST", "/kill/resume", {})).status).toBe(200);
    expect(await killShown()).toBe(false);
    expect(await killAfterRestart()).toBe(false);
  });

  it("stop from the phone during Stop all keeps the kill, now and after a restart", async () => {
    await stopAll();
    const done = await fromPhone("stop", { reason: "stop the session" });
    expect(done.status).toBe("done");
    expect(done.result).toMatchObject({ kind: "stop", frozen: false });
    expect(await killShown()).toBe(true);
    expect(await killAfterRestart()).toBe(true);
    expect((await call("POST", "/kill/resume", {})).status).toBe(200);
    expect(await killAfterRestart()).toBe(false);
  });
});
