import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryGitHost } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { ScriptedProvider } from "./helpers.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const KEY = ["sk-ant-api03-", "cmds-", "4".repeat(40)].join(""); // not-a-secret
const OAUTH = ["sk-ant-oat01-", "cmds-", "5".repeat(40)].join(""); // not-a-secret

/**
 * R-codecommandsrestart (leftovers of wave 7; AGENTS.md "Persisted state is tested across a
 * restart"): "Code tasks that need commands" (`code_commands`, U-078) set to the API key in
 * Settings is still the API key after Forerunner starts again, and a coder task still runs there.
 */
describe("'Code tasks that need commands' survives a restart (R-codecommandsrestart)", () => {
  it("set to the API key, then the daemon starts again: Settings and the coder's runs-on line still say the API key", async () => {
    const clock = new SimulatedClock(Date.parse("2026-11-08T10:00:00Z"));
    const home = mkdtempSync(join(tmpdir(), "fr-code-commands-"));
    const vault = new MemoryVault({
      [SECRET_NAMES.anthropic]: KEY,
      [SECRET_NAMES.anthropicOauth]: OAUTH,
    });
    const compose = () =>
      composeRuntime({
        env: { FORERUNNER_HOME: home },
        dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
        config: null,
        clock,
        stateUrl: `sqlite:${join(home, "state.sqlite")}`,
        vault,
        provider: new ScriptedProvider([], clock),
        gitHost: new MemoryGitHost("alice"),
        registryDir: REGISTRY,
        identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
        appVersion: "1.0.0",
        sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
        startServices: false,
      });
    let rt: RuntimeApp = await compose();
    const call = async (path: string, body?: unknown) => {
      const { app, token } = createDaemonApp(rt);
      const r = await app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await r.json()) as Record<string, unknown>;
    };
    const row = async () =>
      ((await call("/settings")) as unknown as { key: string; value: unknown }[]).find(
        (s) => s.key === "human.code_commands",
      )?.value;
    const coderRunsOn = async (projectId: string) =>
      (
        (await call(`/settings/models?project=${projectId}`)) as unknown as {
          specialists: { name: string; runsOn?: { kind: string } | null }[];
        }
      ).specialists.find((s) => s.name === "coder")?.runsOn?.kind;
    try {
      const project = await rt.store.project.insert({ name: "Site", goal: "g", repos: [] });
      expect(await row()).toBe("first_choice");
      // As the Settings dialog sends it: a yes first (it costs money).
      const asked = await call("/commands/execute", {
        commands: [{ name: "settings.set", params: { key: "code_commands", value: "api_key" } }],
        wordsUsed:
          "Settings: Code tasks that need commands to The API key (runs their tests; costs money)",
        source: "ui",
      });
      expect(asked.status).toBe("pending");
      const yes = await call(`/commands/${String(asked.pendingId)}/confirm`, { answer: "yes" });
      expect(yes.status).toBe("done");
      expect(await row()).toBe("api_key");
      expect(await coderRunsOn(project.id)).toBe("api_key");

      // Quit and start again on the same home.
      await rt.close();
      rt = await compose();
      expect(await row()).toBe("api_key");
      expect(await coderRunsOn(project.id)).toBe("api_key");
    } finally {
      await rt.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
