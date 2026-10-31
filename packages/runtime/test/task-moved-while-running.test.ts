import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore, type TaskRow } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import {
  type SessionResult,
  SessionRunner,
  StaticPlanner,
  type TaskExecutor,
} from "../src/session/runner.ts";
import { seedWorld } from "./context-helpers.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-039: Cancel, Mark failed or Needs me on a task that is running ended the whole session as
 * failed and the other planned tasks never started. The person's move went to the store and
 * nothing told the run: it went on, and when it returned the runner moved the task from the
 * state the person set (`cancelled -> in_review` is no edge), which threw out of the session.
 *
 * Now the person's move stops that task's run (the daemon's transition route through
 * `KillSwitch.stopTask`; any other path, the phone or Chat, through the runner's watch of the
 * task row), the runner re-reads the task when the run returns and never moves it from the
 * state the person set, and the session goes on with its other tasks; its counts and summary
 * include the person's move.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

/** Real time to wait for something the fix makes happen at once (no simulated clock moves). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "still running"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"still running">((resolve) => {
    timer = setTimeout(() => resolve("still running"), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls `cond` in real time; the error says what was seen last (`what`). */
async function until(cond: () => Promise<boolean>, what: () => Promise<string>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${await what()}`);
}

describe("a person's move on a running task stops that task's run; the session goes on (U-039)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let provider: ScriptedProvider;
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-u039-"));
    // The first run waits for its first token an hour of simulated time that never passes:
    // it only ends when something stops it. Every later run answers at once.
    provider = new ScriptedProvider(
      [{ ttftMs: 3_600_000, text: "never sent" }, { text: "Second task done." }],
      clock,
    );
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  const task = (projectId: string, title: string, priority: number) =>
    rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: `${title} is done`,
      acceptance_criteria: ["works"],
      risk_tier: 0,
      status: "ready",
      priority,
      est_cost_usd_micro: 100_000,
      reason: "seed",
    });

  it("Cancel on the Tasks tab stops the running task; the next task runs and the session completes", async () => {
    const project = await rt.store.project.insert({
      name: "Moves",
      goal: "Keep going",
      autonomy_level: 2,
    });
    const first = await task(project.id, "Long first task", 9);
    const second = await task(project.id, "Second task", 1);
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const run = rt.runner.start({
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
      onEvent: (type, payload) => events.push({ type, payload }),
    });
    await until(
      async () =>
        (await rt.store.task.mustGet(first.id)).status === "in_progress" &&
        provider.calls.length === 1,
      async () =>
        `the first task to run (task ${(await rt.store.task.mustGet(first.id)).status}, ${
          provider.calls.length
        } model calls, events: ${events.map((e) => e.type).join(" ")})`,
    );
    // What the Tasks tab's Cancel sends: the version it loaded, the target and a reason.
    const loaded = await rt.store.task.mustGet(first.id);
    const res = await app.request(`/tasks/${first.id}/transition`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: loaded.version, to: "cancelled", reason: "Not needed" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("cancelled");

    const result = await within(run, 5_000);
    expect(result, "the session must not wait on a task the person cancelled").not.toBe(
      "still running",
    );
    const r = result as SessionResult;
    expect(r.status).toBe("completed");
    // The person's move stands; the runner never moved the task from it.
    const cancelled = await rt.store.task.mustGet(first.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.reason).toBe("Not needed");
    // The other planned task ran.
    expect((await rt.store.task.mustGet(second.id)).status).toBe("done");
    expect(r.completed).toEqual([second.id]);
    expect(provider.calls).toHaveLength(2);
    // The counts and the summary the person reads include the move.
    expect(r.cancelled).toEqual([first.id]);
    expect(r.summary).toContain("Cancelled: 1.");
    expect(r.summary).toContain(
      'Moved by you while it ran: "Long first task" (cancelled); its run was stopped and the session went on.',
    );
    expect(events.find((e) => e.type === "task.moved_while_running")?.payload).toMatchObject({
      taskId: first.id,
      status: "cancelled",
      byPerson: true,
    });
    expect(events.find((e) => e.type === "session.ended")?.payload).toMatchObject({
      status: "completed",
      completed: 1,
      cancelled: 1,
    });
  });
});

describe("the session runner after a person's move on a running task (U-039)", () => {
  async function world() {
    const clock = new SimulatedClock("2026-03-02T07:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const w = await seedWorld(store, {}, { session: false });
    const add = (title: string, priority: number) =>
      store.task.insert({
        project_id: w.project,
        title,
        outcome: `${title} done`,
        acceptance_criteria: ["works"],
        risk_tier: 0,
        status: "ready",
        priority,
        est_cost_usd_micro: 100_000,
        reason: "seed",
      });
    return { clock, store, w, add };
  }

  it("a run that returns 'done' after the person's Needs me leaves the task as the person set it", async () => {
    const { clock, store, w, add } = await world();
    const first = await add("Ask me first", 9);
    const second = await add("Then this", 1);
    const ran: string[] = [];
    // An executor that does not listen to the stop: it finishes as if nothing happened.
    const executor: TaskExecutor = {
      async execute({ task }) {
        ran.push(task.id);
        if (task.id === first.id) {
          const now = await store.task.mustGet(first.id);
          await store.task.transition(now.id, now.version, "needs_human", "I want to look", {
            humanId: w.human,
          });
        }
        return { outcome: "done", summary: "done", costUsdMicro: 0, checksPassed: true };
      },
    };
    const runner = new SessionRunner({
      store,
      clock,
      tokens: new TokenIssuer({ now: () => clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor,
    });
    const r = await runner.start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
    });
    expect(r.status).toBe("completed");
    expect(ran).toEqual([first.id, second.id]);
    const asked = (await store.task.mustGet(first.id)) as TaskRow;
    expect(asked.status).toBe("needs_human");
    expect(asked.reason).toBe("I want to look");
    expect(r.needsHuman).toEqual([first.id]);
    expect(r.completed).toEqual([second.id]);
    expect(r.summary).toContain("Needs you: 1.");
    expect(r.summary).toContain('"Ask me first" (needs you)');
    await store.close();
  });

  it("a move made elsewhere (the phone, Chat) reaches the run through the runner's watch of the task", async () => {
    const { clock, store, w, add } = await world();
    const first = await add("Long one", 9);
    const second = await add("Short one", 1);
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor: TaskExecutor = {
      async execute({ task, signal }) {
        if (task.id !== first.id)
          return { outcome: "done", summary: "done", costUsdMicro: 0, checksPassed: true };
        started();
        // Runs until stopped, as a model call does.
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        return { outcome: "killed", summary: "stopped", costUsdMicro: 0 };
      },
    };
    const runner = new SessionRunner({
      store,
      clock,
      tokens: new TokenIssuer({ now: () => clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor,
    });
    const run = runner.start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
    });
    await running;
    // The store write the state service makes for the phone's "Mark failed": no route of this
    // process is called, so nothing but the runner's watch can see it.
    const now = await store.task.mustGet(first.id);
    await store.task.transition(now.id, now.version, "failed", "Wrong approach", {
      humanId: w.human,
    });
    await clock.advance(5_000);
    const result = await within(run, 5_000);
    expect(result).not.toBe("still running");
    const r = result as SessionResult;
    expect(r.status).toBe("completed");
    expect((await store.task.mustGet(first.id)).status).toBe("failed");
    expect(r.failed).toEqual([first.id]);
    expect(r.completed).toEqual([second.id]);
    expect(r.summary).toContain("Failed: 1.");
    await store.close();
  });
});
