import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryLike } from "../src/agent/sdk.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { fileBudgetStopCard } from "../src/session/budget-card.ts";
import { startPendingOf } from "../src/session/prepared-work.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { AcceptingCriticProvider, ScriptedProvider } from "./helpers.ts";

/**
 * d1109-starts-engine S-5 (ADR 0118; the owner, 2026-11-09: "Off by default with the hands-off
 * setting optional"): the project's "When work is ready". Off (the default), work the person
 * makes ready on the Tasks tab waits for their next Start, and its line says so. On (asked with a
 * yes, as every widening is), the same action starts one session by itself (`by: "hands_off"`),
 * never in quiet hours: there it is held, kept on the project across a restart, and starts once
 * after them. Composed daemon on a file database, the person's routes (POST /commands/execute,
 * POST /commands/:id/confirm, POST /tasks/:id/action), the stand-in SDK answering at once; waits
 * are on the store (20 s deadline, with a message), never on real time.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixture, built by concatenation so no scanner sees a token.
const OAUTH = ["sk-ant-oat01-", "byitself", "4".repeat(40)].join(""); // not-a-secret
/** 09:00Z is 10:00 in Zurich. */
const START = "2026-10-31T09:00:00Z";

const done: QueryLike = () =>
  (async function* () {
    yield { type: "system", subtype: "init", session_id: "sdk-byitself" };
    yield {
      type: "assistant",
      message: {
        id: "m1",
        content: [{ type: "text", text: "Wrote it. Lesson: none." }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    yield { type: "result", subtype: "success", is_error: false, result: "Wrote it." };
  })();

interface World {
  rt: RuntimeApp;
  home: string;
  call: <T>(method: string, path: string, body?: unknown) => Promise<{ status: number; json: T }>;
}

const homes: string[] = [];
const open: RuntimeApp[] = [];

async function compose(opts: { home?: string; clock: SimulatedClock }): Promise<World> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "fr-byitself-"));
  if (!opts.home) homes.push(home);
  const provider = new ScriptedProvider([{ text: "Done. Lesson: none." }], opts.clock);
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock: opts.clock,
    stateUrl: `sqlite:${join(home, "state.sqlite")}`,
    vault: new MemoryVault({ [SECRET_NAMES.anthropicOauth]: OAUTH }),
    provider: new AcceptingCriticProvider(provider),
    sdkQuery: done,
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: opts.clock.nowIso() },
    startServices: false,
  });
  open.push(rt);
  const { app, token } = createDaemonApp(rt);
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as T };
  };
  return { rt, home, call };
}

afterEach(async () => {
  for (const rt of open.splice(0)) await rt.close().catch(() => undefined);
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

async function draftTask(rt: RuntimeApp) {
  const project = await rt.store.project.insert({
    name: "Quote page",
    goal: "A quote page",
    autonomy_level: 2,
  });
  const task = await rt.store.task.insert({
    project_id: project.id,
    title: "Write the intro",
    outcome: "the intro is written",
    acceptance_criteria: ["it is written"],
    risk_tier: 0,
    status: "draft",
    priority: 5,
    est_cost_usd_micro: 100_000,
    reason: "seed",
  });
  return { project, task };
}

async function until(what: string, fn: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 20_000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`still waiting after 20 s for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sessionsOf = async (rt: RuntimeApp, projectId: string) =>
  (await rt.store.session.forProject(projectId, { limit: 50 })).reverse();

/** Make ready on the Tasks row, as the app sends it. */
async function makeReady(w: World, taskId: string) {
  const task = await w.rt.store.task.mustGet(taskId);
  const r = await w.call<{ change: { sentence: string } | null }>(
    "POST",
    `/tasks/${taskId}/action`,
    { version: task.version, action: "make_ready" },
  );
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.change?.sentence ?? "";
}

/** "When work is ready: Start a session by itself", as Settings sends it: a yes, then done. */
async function turnOn(w: World, projectId: string) {
  const asked = await w.call<{ status: string; pendingId?: string; card?: unknown }>(
    "POST",
    "/commands/execute",
    {
      commands: [
        {
          name: "settings.set",
          params: { key: "start_by_itself", value: true, project: projectId },
        },
      ],
      source: "ui",
    },
  );
  expect(asked.json.status, JSON.stringify(asked.json)).toBe("pending");
  const yes = await w.call<{ status: string }>(
    "POST",
    `/commands/${asked.json.pendingId}/confirm`,
    { answer: "yes" },
  );
  expect(yes.json.status, JSON.stringify(yes.json)).toBe("done");
  return asked.json;
}

describe("d1109-starts-engine S-5: the project's 'When work is ready'", () => {
  it("off by default: Make ready on the Tasks row starts nothing and says it runs at the next Start", async () => {
    const clock = new SimulatedClock(START);
    const w = await compose({ clock });
    const { project, task } = await draftTask(w.rt);
    expect(await makeReady(w, task.id)).toBe(
      '"Write the intro" is ready. It runs at your next Start.',
    );
    await w.rt.scheduler.tick();
    expect(await sessionsOf(w.rt, project.id)).toEqual([]);
    expect(w.rt.scheduler.log.filter((e) => e.req.projectId === project.id)).toEqual([]);
    expect((await w.rt.store.task.mustGet(task.id)).status).toBe("ready");
  }, 60_000);

  it("on (after a yes): Make ready starts one session by itself, which says so, and no second one", async () => {
    const clock = new SimulatedClock(START);
    const w = await compose({ clock });
    const { project, task } = await draftTask(w.rt);
    const asked = await turnOn(w, project.id);
    expect(JSON.stringify(asked)).toContain(
      "sessions of Quote page will start by themselves when work you made ready can run, up to CHF",
    );
    expect(await makeReady(w, task.id)).toBe(
      '"Write the intro" is ready. A session started for it (this project starts by itself when work is ready).',
    );
    await until(
      "the task to be done",
      async () => (await w.rt.store.task.mustGet(task.id)).status === "done",
    );
    const all = await sessionsOf(w.rt, project.id);
    expect(all).toHaveLength(1);
    expect((all[0]?.plan as { startedBy?: unknown } | null)?.startedBy).toEqual({
      by: "hands_off",
    });
    await w.rt.scheduler.tick();
    await w.rt.scheduler.tick();
    expect(await sessionsOf(w.rt, project.id)).toHaveLength(1);
  }, 60_000);

  // C2-left-4 (run C step 2's leftover): a pause that got no further waits for the person's answer.
  // With the budget wake now preparing work, it stays out of every automatic start (the hands-off
  // setting, a raised limit), also after a restart, until the person answers its card.
  it("a task whose pause got no further stays out of every automatic start, after a restart too, until the person answers its card", async () => {
    const clock = new SimulatedClock(START);
    const w1 = await compose({ clock });
    const { project, task } = await draftTask(w1.rt);
    await w1.rt.store.project.patch(project.id, { budget_usd_micro: 1_000_000 });
    await w1.rt.store.task.patch(task.id, { status: "needs_human", reason: "paused" });
    await turnOn(w1, project.id);
    const paused = await w1.rt.store.task.mustGet(task.id);
    await fileBudgetStopCard({
      store: w1.rt.store,
      task: paused,
      session: null,
      humanId: w1.rt.human.id,
      agentId: w1.rt.agent.id,
      runId: null,
      stop: {
        capUsdMicro: 1_000_000,
        spentUsdMicro: 1_000_000,
        source: "project",
        specialist: "coder",
      },
      handoff: { stopped: "Half.", leftToDo: ["The rest"], stoppedBy: "budget" },
      now: clock.nowIso(),
      noProgress: true,
    });
    // The person raises the project's budget in Settings: the limit has room now.
    const raised = await w1.call<{ status: string; pendingId?: string }>(
      "POST",
      "/commands/execute",
      {
        commands: [
          { name: "budget.set", params: { scope: "project", amountChf: 5, project: project.id } },
        ],
        source: "ui",
        confirm: "tap",
      },
    );
    expect(raised.json.status, JSON.stringify(raised.json)).toBe("done");
    await w1.rt.scheduler.tick();
    await w1.rt.scheduler.tick();
    expect(await sessionsOf(w1.rt, project.id)).toEqual([]);
    expect((await w1.rt.store.task.mustGet(task.id)).status).toBe("needs_human");
    const cards = await w1.rt.store.humanRequest.list({
      task_id: task.id,
      status: "open",
    } as never);
    expect(cards.map((r) => (r.change_card as { question?: unknown }).question)).toEqual([true]);
    await w1.rt.close();
    open.splice(open.indexOf(w1.rt), 1);
    const w2 = await compose({ home: w1.home, clock });
    clock.set(Date.parse("2026-10-31T12:00:00Z"));
    await w2.rt.scheduler.tick();
    await w2.rt.scheduler.tick();
    expect(await sessionsOf(w2.rt, project.id)).toEqual([]);
    expect((await w2.rt.store.task.mustGet(task.id)).status).toBe("needs_human");
    expect(
      await w2.rt.store.humanRequest.list({ task_id: task.id, status: "open" } as never),
    ).toHaveLength(1);
  }, 90_000);

  it("on, in quiet hours: the start is held and kept on the project across a restart, then starts once after them", async () => {
    const clock = new SimulatedClock(START);
    const w1 = await compose({ clock });
    const { project, task } = await draftTask(w1.rt);
    await turnOn(w1, project.id);
    // 09:30 to 12:00 in Zurich holds now (10:00).
    const quiet = await w1.call<{ status: string }>("POST", "/commands/execute", {
      commands: [
        {
          name: "settings.set",
          params: { key: "quiet_hours", value: { start: "09:30", end: "12:00" } },
        },
      ],
      source: "ui",
      confirm: "tap",
    });
    expect(quiet.json.status, JSON.stringify(quiet.json)).toBe("done");
    expect(await makeReady(w1, task.id)).toBe(
      '"Write the intro" is ready. It runs after your quiet hours.',
    );
    expect(await sessionsOf(w1.rt, project.id)).toEqual([]);
    expect(startPendingOf(await w1.rt.store.project.mustGet(project.id))).toMatchObject({
      why: "deferred",
    });
    await w1.rt.close();
    open.splice(open.indexOf(w1.rt), 1);

    const w2 = await compose({ home: w1.home, clock });
    await w2.rt.scheduler.tick();
    expect(await sessionsOf(w2.rt, project.id)).toEqual([]);
    // 11:01Z is 12:01 in Zurich: the quiet hours ended.
    clock.set(Date.parse("2026-10-31T11:01:00Z"));
    await w2.rt.scheduler.tick();
    await until(
      "the task to be done",
      async () => (await w2.rt.store.task.mustGet(task.id)).status === "done",
    );
    const all = await sessionsOf(w2.rt, project.id);
    expect(all).toHaveLength(1);
    expect((all[0]?.plan as { startedBy?: unknown } | null)?.startedBy).toEqual({
      by: "hands_off",
    });
    expect(startPendingOf(await w2.rt.store.project.mustGet(project.id))).toBeNull();
    await w2.rt.scheduler.tick();
    expect(await sessionsOf(w2.rt, project.id)).toHaveLength(1);
  }, 90_000);
});
