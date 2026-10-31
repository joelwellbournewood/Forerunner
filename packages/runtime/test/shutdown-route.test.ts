import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAEMON_ROUTES } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp, SHUTDOWN_DELAY_MS } from "../src/daemon/server.ts";
import { readKillRequest } from "../src/enforcement/killfile.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");

/**
 * U-018 (ADR 0094): Quit in the desktop shell stops the daemon through `POST /shutdown`. The
 * route stops every run and the processes it started, answers, then ends the process; it
 * writes no kill request, so the next start runs normally.
 */
describe("POST /shutdown (U-018)", () => {
  let rt: RuntimeApp;
  let runtimeDir = "";
  const clock = new SimulatedClock("2026-10-31T08:00:00Z");
  const post = (app: ReturnType<typeof createDaemonApp>["app"], token: string, path: string) =>
    app.request(path, {
      method: "POST",
      body: "{}",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-shutdown-"));
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
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("is listed in DAEMON_ROUTES", () => {
    expect(DAEMON_ROUTES.shutdown).toContain("POST /shutdown");
  });

  it("refuses when the daemon cannot end its process", async () => {
    const { app, token } = createDaemonApp(rt);
    const res = await post(app, token, "/shutdown");
    expect(res.status).toBe(409);
  });

  it("needs the bearer token", async () => {
    let called = 0;
    const { app } = createDaemonApp(rt, { onShutdown: () => called++ });
    const res = await app.request("/shutdown", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, SHUTDOWN_DELAY_MS * 2));
    expect(called).toBe(0);
  });

  it("stops every run, answers 202, then ends the process without leaving a kill behind", async () => {
    let called = 0;
    const { app, token } = createDaemonApp(rt, { onShutdown: () => called++ });
    const ac = new AbortController();
    rt.kill.register({ agentId: rt.agent.id, sessionId: "s_quit", controller: ac });
    const res = await post(app, token, "/shutdown");
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ stopping: true, stoppedRuns: 1 });
    expect(ac.signal.aborted).toBe(true);
    // The answer goes out first; the process ends just after.
    expect(called).toBe(0);
    await new Promise((r) => setTimeout(r, SHUTDOWN_DELAY_MS * 3));
    expect(called).toBe(1);
    // Quit is not the kill switch: the next start is not stopped.
    expect(readKillRequest(runtimeDir)).toBeNull();
  });
});
