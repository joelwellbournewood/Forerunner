import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { WaitTimeout } from "@forerunner/testenv/wait";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelCallLog } from "../../../testenv/src/bench/call-log.ts";
import { benchOptionsFromEnv, createRolePlayer } from "../../../testenv/src/bench/role-player.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { ENDED_STATUSES, type RuntimeWatch, watchRuntime } from "./runtime-watch.ts";

/**
 * The shared wait's give-up path on a run that never answers (testing.md, "Waiting on work a
 * case started"): the stand-in model's reply waits on a clock that never moves, so the session
 * runs until something stops it. A wait that gives up stops it (through the daemon's Stop now,
 * or the kill switch without a daemon), waits until nothing of it runs, and throws with what it
 * saw; `settle` does the same before the runtime closes.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

async function compose() {
  const home = mkdtempSync(join(tmpdir(), "fr-watch-"));
  const clock = new SimulatedClock("2026-11-03T09:00:00Z");
  // The reply's 60 s delay is on this clock, which nothing advances: the run never answers.
  const still = new SimulatedClock("2026-11-03T09:00:00Z");
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    stateUrl: "sqlite::memory:",
    vault: new MemoryVault(),
    provider: createRolePlayer({
      ...benchOptionsFromEnv(
        { FORERUNNER_BENCH_DELAY_MS: "60000" },
        new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
      ),
      clock: still,
    }),
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
  });
  const { app, token } = createDaemonApp(rt);
  const req = async (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const json = async (path: string, init: RequestInit = {}) =>
    (await (await req(path, init)).json()) as Json;
  return { rt, req, json };
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** A project with one ready task, a session started as the project's Start does, its task running. */
async function startRunning(
  rt: RuntimeApp,
  json: (path: string, init?: RequestInit) => Promise<Json>,
  watch: RuntimeWatch,
  name: string,
): Promise<{ sessionId: string; taskId: string }> {
  const projectId = String((await json("/projects", post({ name, goal: "A page" }))).id);
  const taskId = String(
    (
      await json(
        `/projects/${projectId}/tasks`,
        post({
          title: "Write the notes in docs/notes.md",
          outcome: "docs/notes.md lists the ideas",
          riskTier: 1,
          priority: "medium",
          status: "ready",
        }),
      )
    ).id,
  );
  const started = await json(
    "/sessions",
    post({ agentId: rt.agent.id, projectId, trigger: "manual" }),
  );
  const sessionId = watch.track(String((started.session as Json).id));
  await watch.until(
    "the task to run",
    async () => (await rt.store.task.get(taskId))?.status === "in_progress",
  );
  return { sessionId, taskId };
}

/** Nothing of the agent runs: no start, no registered run, and the session's row has ended. */
async function nothingRuns(rt: RuntimeApp, sessionId: string) {
  return {
    status: ENDED_STATUSES.includes(String((await rt.store.session.get(sessionId))?.status)),
    active: rt.scheduler.isActive(rt.agent.id),
    runs: rt.kill.activeCount({ agentId: rt.agent.id }),
  };
}

describe("the shared wait on a composed runtime, given a run that never answers", () => {
  let w: Awaited<ReturnType<typeof compose>>;
  let watch: RuntimeWatch;
  beforeAll(async () => {
    w = await compose();
    watch = watchRuntime(w.rt, { request: w.req });
  }, 120_000);
  afterAll(async () => {
    await watch?.settle();
    await w?.rt.close();
  });

  it("a wait that gives up stops the session through Stop now, waits until nothing of it runs, and says what it saw", async () => {
    const { sessionId, taskId } = await startRunning(w.rt, w.json, watch, "Never answers");
    const err = (await watch
      .sessionOver(sessionId, { seen: () => w.json(`/sessions/${sessionId}`), quietMs: 1_500 })
      .catch((e: unknown) => e)) as WaitTimeout;
    expect(err).toBeInstanceOf(WaitTimeout);
    // What it waited for, why it gave up, that it stopped, what the session page showed and
    // what ran in the runtime then.
    expect(err.message).toMatch(
      new RegExp(
        `^timed out waiting for session ${sessionId} to end \\(nothing it watches changed for 1\\.\\d s; stopped what the case started\\): saw \\{`,
      ),
    );
    expect(err.seen).toContain('"status":"running"');
    expect(err.seen).toContain('"statusText":"Working"');
    expect(err.seen).toMatch(
      new RegExp(
        `; the runtime: sessions not over: ${sessionId} running \\(\\d+ steps, \\d+ µUSD, running, last event [a-z_.]+\\).*; a start running, \\d+ run\\(s\\) registered$`,
      ),
    );
    expect(await nothingRuns(w.rt, sessionId)).toEqual({ status: true, active: false, runs: 0 });
    // Stop now's outcome, as the person would see it: the task is ready again.
    expect((await w.rt.store.task.get(taskId))?.status).toBe("ready");
  }, 60_000);

  it("settle stops what a case left running before the runtime closes; with nothing running it does nothing", async () => {
    const { sessionId } = await startRunning(w.rt, w.json, watch, "Left running");
    await watch.settle();
    expect(await nothingRuns(w.rt, sessionId)).toEqual({ status: true, active: false, runs: 0 });
    const before = await watch.progress();
    await watch.settle();
    expect(await watch.progress()).toBe(before);
  }, 60_000);
});

describe("without a daemon, the kill switch's stop", () => {
  it("stops the session the same way and the wait says so", async () => {
    const w = await compose();
    const watch = watchRuntime(w.rt);
    try {
      const { sessionId } = await startRunning(w.rt, w.json, watch, "No daemon");
      const err = (await watch
        .until("the session to end", async () => false, { quietMs: 1_000 })
        .catch((e: unknown) => e)) as WaitTimeout;
      expect(err).toBeInstanceOf(WaitTimeout);
      expect(err.stopped).toBe("stopped what the case started");
      expect(err.seen).toContain(`sessions not over: ${sessionId} running`);
      expect(await nothingRuns(w.rt, sessionId)).toEqual({ status: true, active: false, runs: 0 });
    } finally {
      await watch.settle();
      await w.rt.close();
    }
  }, 60_000);
});
