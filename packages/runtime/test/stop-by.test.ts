import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeRuntime } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { KillFileWatcher, writeKillRequest } from "../src/enforcement/killfile.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { sessionCommandPorts } from "../src/loop/commands.ts";
import {
  type SessionResult,
  SessionRunner,
  StaticPlanner,
  type TaskExecutionResult,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { personStopOf } from "../src/session/stop-words.ts";
import { seedWorld } from "./context-helpers.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Whose stop it was is decided where the stop is asked for, never from its words (design §4.9).
 * Before, the runner matched the kill switch's free-text reason against three fixed strings:
 * the header's Stop all sends "stop all from the UI", the chat's stop "human <id> via chat",
 * the phone's "remote stop from device <id>", and each of them ended the session as an error
 * ("error  Error: killed session stopped during task", stop reason "killed", badge "Stopped",
 * a result that named no stop). The real-daemon case of the header's Stop all is in
 * apps/ui/test/real-daemon.test.ts; the phone's verbs are in remote-watcher.test.ts.
 */
const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

describe("a stop asked for in the chat, in its own words, says whose stop it was", () => {
  let store: Awaited<ReturnType<typeof openStore>>;
  let clock: SimulatedClock;
  let agent = "";
  let project = "";

  beforeEach(async () => {
    clock = new SimulatedClock("2026-11-01T09:00:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    ({ agent, project } = await seedWorld(store, {}, { session: false }));
  });
  afterEach(async () => {
    await store.close();
  });

  /** A session whose one task is stopped, while it runs, by `stop` (the request site). */
  async function runStoppedBy(
    kill: KillSwitch,
    stop: (sessionId: string) => Promise<unknown>,
  ): Promise<{ r: SessionResult; events: { type: string; payload: Record<string, unknown> }[] }> {
    await store.task.insert({
      project_id: project,
      title: "Write one.html",
      outcome: "one.html exists",
      acceptance_criteria: ["exists"],
      risk_tier: 0,
      status: "ready",
      priority: 5,
      reason: "seed",
    });
    const executor: TaskExecutor = {
      execute({ signal, session }) {
        return new Promise<TaskExecutionResult>((resolve) => {
          signal.addEventListener("abort", () =>
            resolve({ outcome: "killed", summary: "stopped", costUsdMicro: 0 }),
          );
          void stop(session.id);
        });
      },
    };
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const runner = new SessionRunner({
      store,
      clock,
      tokens: new TokenIssuer({ now: () => clock.now() }),
      kill,
      planner: new StaticPlanner(),
      executor,
    });
    const r = await runner.start({
      agentId: agent,
      projectId: project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
      onEvent: (type, payload) => events.push({ type, payload }),
    });
    return { r, events };
  }

  /** The registry's kill port as the daemon wires it (`session.stop` calls it). */
  const chatPorts = (kill: KillSwitch) => {
    const ports = sessionCommandPorts({
      scheduler: {
        requestStart: () => {
          throw new Error("not under test");
        },
        cancelPending: () => undefined,
        waitingAhead: () => undefined,
        activeStart: () => undefined,
      },
      kill,
      store,
    });
    const port = ports.kill;
    if (!port) throw new Error("the command ports have no kill port");
    return { kill: port };
  };

  it("'stop' in the chat stops the agent and freezes it: the session reads Stop all, not an error", async () => {
    const kill = new KillSwitch();
    const ports = chatPorts(kill);
    // What `session.stop` sends from the chat: the agent's scope and the actor's words.
    const { r, events } = await runStoppedBy(kill, () =>
      ports.kill({ agentId: agent }, `human h-1 via chat`),
    );
    expect(r.stopReason).toBe("stop_all");
    expect(events.map((e) => e.type)).not.toContain("session.error");
    expect(events.find((e) => e.type === "session.stopped")?.payload).toMatchObject({
      by: "stop_all",
      text: 'Stopped: Stop all during "Write one.html". It is ready again.',
    });
    const task = (await store.task.forProject(project))[0];
    expect(task).toMatchObject({ status: "ready", reason: "Stopped: Stop all" });
    expect(r.summary.split("\n").at(-1)).toBe(
      'Stopped: Stop all. "Write one.html" is ready to continue. CHF 0.00.',
    );
    // The chat's stop is the kill switch: no session starts until it is allowed again.
    expect(kill.isFrozen({ agentId: agent })).toBe(true);
  });

  it("'stop this session' in the chat is the person's Stop now", async () => {
    const kill = new KillSwitch();
    const ports = chatPorts(kill);
    const { r, events } = await runStoppedBy(kill, (sessionId) =>
      ports.kill({ sessionId }, `human h-1 via chat`),
    );
    expect(r.stopReason).toBe("you");
    expect(events.map((e) => e.type)).not.toContain("session.error");
    const task = (await store.task.forProject(project))[0];
    expect(task).toMatchObject({ status: "ready", reason: "Stopped by you" });
    expect(kill.isFrozen({ agentId: agent })).toBe(false);
  });

  it("an abort nobody asked for by name is still an error, never dressed up as a person's stop", async () => {
    const kill = new KillSwitch();
    // Words that look like a person's stop, with no request site behind them.
    const { r, events } = await runStoppedBy(kill, (sessionId) =>
      kill.stop({ sessionId }, "stopped by you", { freeze: false }),
    );
    expect(r.stopReason).toBe("killed");
    expect(events.map((e) => e.type)).toContain("session.error");
  });
});

describe("the kill file (`fr kill`, a kill that survives a restart) is Stop all", () => {
  it("whatever its reason says", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-stop-by-"));
    try {
      const clock = new SimulatedClock("2026-11-01T09:00:00Z");
      const kill = new KillSwitch();
      const controller = new AbortController();
      kill.register({ agentId: "alice", sessionId: "s1", controller, label: "run" });
      writeKillRequest(
        {
          scope: "all",
          reason: "manual stop from the command line",
          requestedAt: "2026-11-01T09:00:00.000Z",
          requestedBy: "fr kill",
        },
        dir,
      );
      expect(await new KillFileWatcher(kill, clock, dir).check()).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(personStopOf(controller.signal.reason)).toBe("stop_all");
      // A run that registers while the kill is in force is stopped by the same Stop all.
      const late = new AbortController();
      kill.register({ agentId: "alice", sessionId: "s2", controller: late, label: "run" });
      expect(personStopOf(late.signal.reason)).toBe("stop_all");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Quit while a task runs (the desktop shell's POST /shutdown)", () => {
  it("ends the session as 'Forerunner was closed', not as an error, and its task is ready again", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-stop-by-quit-"));
    const clock = new SimulatedClock("2026-11-01T09:00:00Z");
    // The specialist's model call waits an hour of simulated time that never passes.
    const provider = new ScriptedProvider([{ ttftMs: 3_600_000, text: "never sent" }], clock);
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      registryDir: join(process.cwd(), "evals", "registry"),
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: {
        engine: "none",
        problem: "not_installed",
        reason: "test: no engine",
        checkedAt: "2026-11-01T09:00:00.000Z",
      },
    });
    let quits = 0;
    const { app, token } = createDaemonApp(rt, { onShutdown: () => quits++ });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    try {
      const project = await rt.store.project.insert({
        name: "Quit page",
        goal: "One page",
        stage: "build",
        status: "active",
        budget_usd_micro: 50_000_000,
        autonomy_level: 2,
      });
      const task = await rt.store.task.insert({
        project_id: project.id,
        title: "Write one.html",
        outcome: "one.html exists",
        acceptance_criteria: ["exists"],
        risk_tier: 0,
        status: "ready",
        priority: 5,
      });
      const started = await call("POST", "/sessions", {
        agentId: rt.agent.id,
        projectId: project.id,
      });
      expect(started.status).toBeLessThan(300);
      const sessionId = String((started.body.session as { id?: string } | null)?.id ?? "");
      expect(sessionId).not.toBe("");
      const until = async (cond: () => Promise<boolean>, what: string) => {
        for (let i = 0; i < 600; i++) {
          if (await cond()) return;
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error(`timed out waiting for ${what}`);
      };
      await until(
        async () =>
          (await rt.store.task.mustGet(task.id)).status === "in_progress" &&
          provider.calls.length === 1,
        "the task's model call",
      );

      // Quit, as the desktop shell sends it.
      expect((await call("POST", "/shutdown", {})).status).toBe(202);
      await until(
        async () =>
          !["running", "paused"].includes((await rt.store.session.mustGet(sessionId)).status),
        "the session to end",
      );
      const view = (await call("GET", `/sessions/${sessionId}`)).body;
      expect(view).toMatchObject({
        stopReason: "quit",
        statusText: "Stopped: Forerunner was closed",
      });
      expect(await rt.store.task.mustGet(task.id)).toMatchObject({
        status: "ready",
        reason: "Forerunner was closed",
      });
      const events = (await call("GET", `/sessions/${sessionId}/events`)).body as unknown as {
        type: string;
        payload: Record<string, unknown>;
      }[];
      expect(events.map((e) => e.type)).not.toContain("session.error");
      expect(events.find((e) => e.type === "session.stopped")?.payload).toMatchObject({
        by: "quit",
      });
    } finally {
      await rt.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
