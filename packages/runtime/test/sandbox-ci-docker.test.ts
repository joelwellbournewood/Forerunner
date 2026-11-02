import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import { composeRuntime } from "../src/daemon/compose.ts";
import { FakeContainerEngine } from "../src/sandbox/fake-engine.ts";
import { AcceptingCriticProvider, ScriptedProvider } from "./helpers.ts";

/**
 * U-079, as CI found it (2026-10-31): on Linux CI Docker runs but has no
 * `forerunner-runner:local`, and on Windows CI Docker runs Windows containers. Since U-037 a
 * task of a project without a repository runs in its workspace folder through the sandbox
 * port, and every such task failed there (`docker run failed (exit 125): Unable to find image
 * 'forerunner-runner:local'` / `invalid mount path: '/work'`), which broke the composed-runtime
 * tests that run one. A container is only used once the sandbox is ready; until then a task at
 * tier 0 or 1 runs in the process stand-in, as on a machine without Docker, and no container is
 * tried. The engine here is the stand-in for each CI machine.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");

describe("a low-tier task on a machine whose Docker cannot run the sandbox (U-079)", () => {
  it.each([
    ["Linux CI: Docker without the image", new FakeContainerEngine(), "image_missing"],
    [
      "Windows CI: Docker on Windows containers",
      new FakeContainerEngine({ osType: "windows", images: ["forerunner-runner:local"] }),
      "windows_containers",
    ],
  ])(
    "%s: the task runs in the stand-in and no container is tried",
    async (_name, engine, state) => {
      const home = mkdtempSync(join(tmpdir(), "fr-u079-ci-"));
      const clock = new SimulatedClock("2026-10-31T08:00:00Z");
      const rt = await composeRuntime({
        env: { FORERUNNER_HOME: home },
        dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
        config: null,
        clock,
        stateUrl: "sqlite::memory:",
        vault: new MemoryVault(),
        // The critic reviews every task (ADR 0104), tier 0 too: it accepts here; the subject is elsewhere.
        provider: new AcceptingCriticProvider(
          new ScriptedProvider([{ text: "Done. Nothing to report." }], clock),
        ),
        registryDir: REGISTRY,
        identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
        appVersion: "0.1.0-test",
        sandboxRun: engine.run,
        sandboxWhich: engine.which,
        startServices: false,
      });
      try {
        expect(rt.sandbox.readiness.current()?.state).toBe(state);
        const project = await rt.store.project.insert({
          name: "CI",
          goal: "Run",
          autonomy_level: 2,
        });
        const task = await rt.store.task.insert({
          project_id: project.id,
          title: "Write the notes",
          outcome: "the notes are written",
          acceptance_criteria: ["written"],
          risk_tier: 0,
          status: "ready",
          priority: 5,
          est_cost_usd_micro: 100_000,
          reason: "seed",
        });
        const r = await rt.runner.start({
          agentId: rt.agent.id,
          projectId: project.id,
          trigger: "manual",
          budgetCapUsdMicro: 5_000_000,
          grant: {
            allowedTools: rt.toolsForRun().names(),
            allowedPaths: [],
            allowedDomains: [],
            grantedSecrets: [],
          },
        });
        const after = await rt.store.task.mustGet(task.id);
        expect(after.status, `${after.reason}; ${r.summary}`).not.toBe("failed");
        expect(r.summary).not.toContain("Failed: 1");
        expect(engine.callsOf("run")).toEqual([]);
        const coder = (await rt.store.run.forTask(task.id)).filter((x) => x.specialist === "coder");
        expect(coder.map((x) => x.outcome)).toEqual(["completed"]);
      } finally {
        await rt.close();
        rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    },
    120_000,
  );
});
