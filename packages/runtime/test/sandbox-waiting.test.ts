import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { SANDBOX_NOTICE_AUTHOR } from "../src/daemon/sandbox-wiring.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { FakeContainerEngine } from "../src/sandbox/fake-engine.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-079: while the Docker sandbox is not ready, a full-review task (tier 2+) waits: the session
 * leaves it out of the plan and goes on with the others, its attempt count does not change, the
 * summary and the Start dialog name it with the step, and one Inbox notice says Docker is
 * needed (not one card per task, not one per session). The download starts by itself when the
 * image is all that is missing; once the sandbox is ready the next session runs the task in
 * the container. The engine is a stand-in (no test depends on the machine's Docker).
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const IMAGE = "registry.example/forerunner-runner:test";

describe("full-review tasks wait for the Docker sandbox (U-079)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let home: string;
  const engine = new FakeContainerEngine({
    registry: { [IMAGE]: { layers: 3, bytes: 900_000_000 } },
  });
  const clock = new SimulatedClock("2026-10-31T08:00:00Z");

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-u079-wait-"));
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home, FORERUNNER_RUNNER_IMAGE: IMAGE },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Done. Nothing to report." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxRun: engine.run,
      sandboxWhich: engine.which,
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const get = async (path: string) =>
    (await app.request(path, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<
      Record<string, unknown>
    >;
  const session = (projectId: string) =>
    rt.runner.start({
      agentId: rt.agent.id,
      projectId,
      trigger: "manual",
      budgetCapUsdMicro: 20_000_000,
      grant: {
        allowedTools: rt.toolsForRun().names(),
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
      },
    });
  const notices = async () =>
    (await rt.store.humanRequest.list({ author_agent: SANDBOX_NOTICE_AUTHOR } as never)).filter(
      (r) => r.status === "open",
    );

  it("waits with its attempt count unchanged while the image downloads, then runs in the container", async () => {
    const project = await rt.store.project.insert({
      name: "Reviewed",
      goal: "Ship it",
      autonomy_level: 2,
    });
    const task = (title: string, risk_tier: number, priority: number) =>
      rt.store.task.insert({
        project_id: project.id,
        title,
        outcome: `${title} is done`,
        acceptance_criteria: ["works"],
        risk_tier,
        status: "ready",
        priority,
        est_cost_usd_micro: 100_000,
        reason: "seed",
      });
    const full = await task("Payment flow", 2, 9);
    const small = await task("Fix a typo", 0, 1);
    expect(rt.sandbox.readiness.current()?.state).toBe("image_missing");

    // The Start dialog names the waiting task and the step before the person starts.
    const check = await get(`/projects/${project.id}/start-check`);
    expect((check.runnable as { title: string }[]).map((t) => t.title)).toEqual(["Fix a typo"]);
    expect(check.waitingForSandbox).toMatchObject({
      state: "image_missing",
      step: "click Download the sandbox in Settings → Sandbox (Docker)",
      tasks: [{ title: "Payment flow" }],
    });

    // Session 1: the download starts by itself and is held; the small task runs, the
    // full-review task waits.
    const release = engine.holdPulls();
    const first = await session(project.id);
    // The result names the wait in one line (design §5); the card says what to do.
    expect(first.summary.split("\n")[0]).toBe('Waiting for Docker: "Payment flow".');
    const afterFirst = await rt.store.task.mustGet(full.id);
    expect(afterFirst).toMatchObject({ status: "ready", attempt: 0 });
    expect((await rt.store.task.mustGet(small.id)).status).not.toBe("ready");
    expect(rt.sandbox.readiness.current()?.state).toBe("pulling");
    expect(engine.callsOf("pull")).toEqual([["docker", "pull", IMAGE]]);
    const [notice, ...more] = await notices();
    expect(more).toEqual([]);
    expect(notice?.why).toContain(
      "Full-review tasks wait for the Docker sandbox: Downloading the sandbox.",
    );
    expect(notice?.why).toContain('Waiting: "Payment flow".');
    expect(notice?.blocking).toBe(false);
    // Settings → Sandbox (Docker) shows the download and the waiting task.
    const status = await get("/sandbox");
    expect(status).toMatchObject({ state: "pulling", waiting: 1, image: IMAGE });

    // Session 2 while it downloads: still waiting, still one notice, still attempt 0.
    const second = await session(project.id);
    expect(second.summary).toContain('Waiting for Docker: "Payment flow"');
    expect(await notices()).toHaveLength(1);
    expect((await rt.store.task.mustGet(full.id)).attempt).toBe(0);
    expect(engine.callsOf("run")).toEqual([]);

    // The download ends: the sandbox is ready and the notice goes.
    release();
    await rt.sandbox.readiness.settled;
    await rt.sandbox.readiness.check({ force: true });
    expect(rt.sandbox.readiness.current()?.state).toBe("ready");
    for (let i = 0; i < 50 && (await notices()).length > 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(await notices()).toEqual([]);

    // Session 3 runs it, in the container: the coder's run, then the critic's review (the
    // scripted model's reply is no verdict, so the critic sends it back, and the rework runs
    // in the same session, design §4.3), each run in a container of its own.
    expect(await rt.store.run.forTask(full.id)).toEqual([]);
    const third = await session(project.id);
    expect(third.summary).not.toContain("Waiting for Docker");
    const runs = (await rt.store.run.forTask(full.id)).filter((r) => r.specialist !== "critic");
    // The coder first; the ladder may hand a later attempt to another specialist.
    expect(runs.map((r) => r.specialist)).toContain("coder");
    const started = engine.callsOf("run");
    expect(started.length).toBe(runs.length);
    for (const call of started) {
      expect(call).toContain(IMAGE);
      expect(call.join(" ")).toContain("dst=/work");
    }
    expect(engine.containers.size).toBe(0);
  }, 120_000);

  it("a project setting cannot put a full-review task in the process stand-in", async () => {
    engine.set({ running: false });
    await rt.sandbox.readiness.check({ force: true });
    const project = await rt.store.project.insert({
      name: "No escape",
      goal: "Reviewed for real",
      autonomy_level: 2,
      settings: { allowProcessSandbox: true },
    });
    const t = await rt.store.task.insert({
      project_id: project.id,
      title: "Migrate the database",
      outcome: "migrated",
      acceptance_criteria: ["works"],
      risk_tier: 3,
      status: "ready",
      priority: 5,
      est_cost_usd_micro: 100_000,
      reason: "seed",
    });
    const r = await session(project.id);
    expect(r.summary.split("\n")[0]).toBe('Waiting for Docker: "Migrate the database".');
    // The step is on the one card per project, not repeated in the result.
    expect((await notices())[0]?.steps.at(-1)).toBe(
      "Click Check again in Settings → Sandbox (Docker).",
    );
    expect(await rt.store.task.mustGet(t.id)).toMatchObject({ status: "ready", attempt: 0 });
    // One notice, for the new state.
    const open = await notices();
    expect(open).toHaveLength(1);
    expect(open[0]?.why).toContain("Docker is installed but not running.");
    engine.set({ running: true });
  }, 120_000);

  it("a task an older version failed for want of a sandbox is ready again once the sandbox is, its attempts as they were", async () => {
    engine.set({ running: false });
    await rt.sandbox.readiness.check({ force: true });
    const project = await rt.store.project.insert({
      name: "From 1.0.4",
      goal: "Recovered",
      autonomy_level: 2,
    });
    const failed = async (title: string, risk_tier: number, reason: string) => {
      const t = await rt.store.task.insert({
        project_id: project.id,
        title,
        outcome: `${title} is done`,
        acceptance_criteria: ["works"],
        risk_tier,
        status: "failed",
        priority: 5,
        est_cost_usd_micro: 100_000,
        reason,
      });
      return rt.store.task.patch(t.id, { attempt: 1 });
    };
    const old = await failed(
      "Harden the login",
      2,
      "docker run failed (exit 125): Unable to find image 'forerunner-runner:local' locally",
    );
    const windows = await failed(
      "Upgrade the parser",
      3,
      "docker run failed (exit 125): docker: Error response from daemon: invalid mount config for type \"bind\": invalid mount path: '/work'.",
    );
    const other = await failed("Fix the build", 2, "tests failed: 3 of 40");
    // Docker starts; the person clicks Check again.
    engine.set({ running: true });
    expect((await rt.sandbox.readiness.check({ force: true })).state).toBe("ready");
    for (let i = 0; i < 100 && (await rt.store.task.mustGet(old.id)).status !== "ready"; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(await rt.store.task.mustGet(old.id)).toMatchObject({ status: "ready", attempt: 1 });
    expect(await rt.store.task.mustGet(windows.id)).toMatchObject({ status: "ready", attempt: 1 });
    expect((await rt.store.task.mustGet(other.id)).status).toBe("failed");
  }, 120_000);
});
