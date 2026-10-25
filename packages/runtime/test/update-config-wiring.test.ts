import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { updateConfigPath } from "../src/update/config.ts";
import { UpdatesView } from "../src/update/screen.ts";
import { ScriptedProvider } from "./helpers.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");

/**
 * The daemon with a broken update configuration (review of 58f4d7c): updates are off (no feed,
 * no trusted key, never the built-in ones) and the Updates screen says why.
 */
describe("a broken update configuration through the composed daemon", () => {
  const open: RuntimeApp[] = [];
  afterEach(async () => {
    for (const rt of open.splice(0)) await rt.close();
  });

  async function daemonWith(file: string | null, env: Record<string, string> = {}) {
    const home = mkdtempSync(join(tmpdir(), "fr-update-cfg-wiring-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    mkdirSync(dirs.config, { recursive: true });
    if (file !== null) writeFileSync(updateConfigPath(dirs), file);
    const clock = new SimulatedClock("2026-10-25T20:00:00Z");
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home, ...env },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Hello." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "1.0.0",
    });
    open.push(rt);
    const { app, token } = createDaemonApp(rt);
    const view = UpdatesView.parse(
      await (
        await app.request("/updates", { headers: { authorization: `Bearer ${token}` } })
      ).json(),
    );
    return { rt, view };
  }

  it("a malformed update.json: updates off, the reason on the screen", async () => {
    const { rt, view } = await daemonWith('{"feed": null,');
    expect(rt.updateConfigError).toMatch(/not valid JSON/);
    expect(rt.updates.status().trustedKeyIds).toEqual([]);
    expect(view.app.lastError).toMatch(
      /^update\.json ignored \(updates are off\): .*not valid JSON/,
    );
    expect(view.app.state).toBe("unknown");
  }, 120_000);

  it("a valid file with a bad environment override: updates off, the override named", async () => {
    const { rt, view } = await daemonWith("{}", { FORERUNNER_UPDATE_CHANNEL: "nightly" });
    expect(rt.updateConfigError).toMatch(/FORERUNNER_UPDATE_CHANNEL/);
    expect(rt.updates.status().trustedKeyIds).toEqual([]);
    expect(view.app.lastError).toMatch(/FORERUNNER_UPDATE_CHANNEL/);
  }, 120_000);

  it("no file at all: the built-in key, no error", async () => {
    const { rt, view } = await daemonWith(null);
    expect(rt.updateConfigError).toBeNull();
    expect(rt.updates.status().trustedKeyIds).toEqual(["26fae7f48427e5eb"]);
    expect(view.app.lastError).toBeNull();
  }, 120_000);
});
