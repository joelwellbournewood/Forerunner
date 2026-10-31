import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { KillFileWatcher, readKillRequest } from "../src/enforcement/killfile.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";

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
