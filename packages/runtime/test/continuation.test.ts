import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { QueryLike } from "../src/agent/sdk.ts";
import type { ContinuationCancelView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { describeEvent } from "../src/daemon/views.ts";
import { CONTINUES_EVENT } from "../src/session/runner.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import {
  AcceptingCriticProvider,
  removeHomes,
  ScriptedProvider,
  settleSessions,
} from "./helpers.ts";

/**
 * d1109-starts-engine S-10 (ADR 0118 amending 0100; the owner, 2026-11-09: "A session the person
 * started keeps going by itself until its work is done, including after a credential wait inside
 * it"). A session the person started that ended to wait for its Claude credential goes on by
 * itself once at the reset: a continuation (`by: "continuation"`), with the rest of its promise
 * and of its budget, its first line naming the session it goes on with. Quiet hours hold it, Cancel
 * and Stop all drop it, none is kept for a session the person stopped or for work outside a
 * session they started, one wait per project, and it survives a restart without going on twice.
 * Composed daemon on a file database, the person's routes, the stand-in SDK meeting the
 * subscription's limit once; no real time is waited on (the clock is simulated, waits are on
 * the store with a 20 s deadline and a message).
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const OAUTH = ["sk-ant-oat01-", "continues", "7".repeat(40)].join(""); // not-a-secret
const API_KEY = ["sk-ant-api03-", "continues", "8".repeat(40)].join(""); // not-a-secret
/** 09:00Z is 10:00 in Zurich; the subscription's limit resets at 14:00Z, 15:00 in Zurich. */
const START = "2026-10-31T09:00:00Z";
const RESET = "2026-10-31T14:00:00.000Z";
const BUDGET = 5_000_000;

/** The stand-in Claude Code: the first `limited` calls meet the plan's usage limit. */
function claudeCode(
  calls: string[],
  opts: { limited?: number; onCall?: () => Promise<void> } = {},
) {
  const query: QueryLike = ({ prompt }) => {
    calls.push(prompt);
    const limited = calls.length <= (opts.limited ?? 1);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-continues" };
      await opts.onCall?.();
      if (!limited) {
        yield {
          type: "assistant",
          message: {
            id: `m${calls.length}`,
            content: [{ type: "text", text: "Wrote it on the subscription. Lesson: none." }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Wrote it on the subscription. Lesson: none.",
        };
        return;
      }
      yield {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: Date.parse(RESET) / 1000,
          rateLimitType: "five_hour",
        },
      };
      yield {
        type: "assistant",
        error: "rate_limit",
        message: { content: [{ type: "text", text: "You've hit your limit · resets 3pm" }] },
      };
      yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit" };
    })();
  };
  return query;
}

interface World {
  rt: RuntimeApp;
  home: string;
  clock: SimulatedClock;
  calls: string[];
  post: <T>(path: string, body?: unknown) => Promise<{ status: number; json: T }>;
  get: <T>(path: string) => Promise<{ status: number; json: T }>;
  close: () => Promise<void>;
}

const homes: string[] = [];
const open: RuntimeApp[] = [];

async function compose(
  opts: {
    home?: string;
    clock?: SimulatedClock;
    calls?: string[];
    limited?: number;
    onCall?: (w: World) => Promise<void>;
  } = {},
): Promise<World> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "fr-continues-"));
  if (!opts.home) homes.push(home);
  const clock = opts.clock ?? new SimulatedClock(START);
  const calls = opts.calls ?? [];
  let world: World | undefined;
  const provider = new ScriptedProvider([{ text: "Done on the API key. Lesson: none." }], clock);
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    stateUrl: `sqlite:${join(home, "state.sqlite")}`,
    vault: new MemoryVault({
      [SECRET_NAMES.anthropicOauth]: OAUTH,
      [SECRET_NAMES.anthropic]: API_KEY,
    }),
    provider: new AcceptingCriticProvider(provider),
    sdkQuery: claudeCode(calls, {
      ...(opts.limited !== undefined ? { limited: opts.limited } : {}),
      ...(opts.onCall
        ? {
            onCall: () => (world ? (opts.onCall?.(world) ?? Promise.resolve()) : Promise.resolve()),
          }
        : {}),
    }),
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    startServices: false,
  });
  open.push(rt);
  const { app, token } = createDaemonApp(rt);
  const post = async <T>(path: string, body?: unknown) => {
    const res = await app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, json: (await res.json()) as T };
  };
  const get = async <T>(path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, json: (await res.json()) as T };
  };
  world = {
    rt,
    home,
    clock,
    calls,
    post,
    get,
    close: async () => {
      await settleSessions(rt);
      await rt.close();
      open.splice(open.indexOf(rt), 1);
    },
  };
  return world;
}

afterEach(async () => {
  // Every daemon is closed and every home removed; then the first failure, if any, fails the test.
  const failures: unknown[] = [];
  for (const rt of open.splice(0)) {
    await settleSessions(rt).catch((e: unknown) => failures.push(e));
    await rt.close().catch(() => undefined);
  }
  try {
    removeHomes(homes.splice(0));
  } catch (e) {
    failures.push(e);
  }
  if (failures.length > 0) throw failures[0];
});

async function changelog(rt: RuntimeApp) {
  const project = await rt.store.project.insert({
    name: "Limits",
    goal: "Keep working",
    autonomy_level: 2,
  });
  const task = await rt.store.task.insert({
    project_id: project.id,
    title: "Write the changelog",
    outcome: "the changelog is written",
    acceptance_criteria: ["it is written"],
    risk_tier: 0,
    status: "ready",
    priority: 5,
    est_cost_usd_micro: 100_000,
    reason: "seed",
  });
  return { project, task };
}

/** Waits on the store (never on time): up to 20 s, then fails with what it waited for. */
async function until(what: string, fn: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 20_000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`still waiting after 20 s for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sessionsOf = async (rt: RuntimeApp, projectId: string) =>
  (await rt.store.session.forProject(projectId, { limit: 50 })).reverse();

/** The person presses Start (POST /sessions); the session ends to wait for its credential. */
async function personStartsAndWaits(w: World, projectId: string) {
  const started = await w.post<{ result: string; session: { id: string } | null }>("/sessions", {
    agentId: w.rt.agent.id,
    projectId,
    trigger: "manual",
    budgetUsdMicro: BUDGET,
  });
  expect(started.status, JSON.stringify(started.json)).toBe(202);
  expect(started.json.result).toBe("started");
  await until("the person's session to end", async () => {
    const all = await sessionsOf(w.rt, projectId);
    return all.length === 1 && !["running", "planned", "paused"].includes(String(all[0]?.status));
  });
  const [first] = await sessionsOf(w.rt, projectId);
  if (!first) throw new Error("no session");
  return first;
}

async function atTheReset(w: World, iso = "2026-10-31T14:01:00Z") {
  w.clock.set(Date.parse(iso));
  await w.rt.scheduler.tick();
}

describe("d1109-starts-engine S-10: the person's session goes on after its credential wait", () => {
  it("goes on once at the reset, as a continuation with the rest of its budget, and its first line names the session it goes on with", async () => {
    const w = await compose();
    const { project, task } = await changelog(w.rt);
    const first = await personStartsAndWaits(w, project.id);
    expect(first.summary?.split("\n")[0]).toBe(
      "Waits until 15:00 (your subscription's limit); then your session goes on.",
    );
    expect(await w.rt.continuations.waiting(project.id)).toBe(
      "Your session of 10:00 goes on by itself at 15:00.",
    );
    // One wait per project: a Start pressed while it waits keeps nothing new and says when.
    const again = await w.post<{ error?: { message?: string } }>("/sessions", {
      agentId: w.rt.agent.id,
      projectId: project.id,
      trigger: "manual",
    });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.json)).toContain(
      "Your session of 10:00 goes on by itself at 15:00.",
    );
    expect(await sessionsOf(w.rt, project.id)).toHaveLength(1);

    await atTheReset(w);
    await until(
      "the task to be done",
      async () => (await w.rt.store.task.mustGet(task.id)).status === "done",
    );
    const all = await sessionsOf(w.rt, project.id);
    expect(all).toHaveLength(2);
    const second = all[1];
    expect((second?.plan as { startedBy?: unknown } | null)?.startedBy).toMatchObject({
      by: "continuation",
      continues: first.id,
      continuesAt: "10:00",
    });
    // The rest of its budget, never more.
    expect(second?.budget_cap_usd_micro).toBe(BUDGET - first.spent_usd_micro);
    const events = await w.rt.store.event.list(second?.id ?? "");
    const continues = events.find((e) => e.type === CONTINUES_EVENT);
    expect(continues).toBeDefined();
    expect(
      describeEvent(CONTINUES_EVENT, (continues?.payload ?? {}) as Record<string, unknown>),
    ).toBe("Goes on with your session of 10:00.");
    // Fix-up of the review: it is the session log's first line, before the budget line.
    expect(events[0]?.type).toBe(CONTINUES_EVENT);
    expect(events[1]?.type).toBe("session.started");
    // Once: the next ticks start nothing more, and nothing waits any longer.
    await atTheReset(w, "2026-10-31T14:30:00Z");
    await atTheReset(w, "2026-10-31T15:30:00Z");
    expect(await sessionsOf(w.rt, project.id)).toHaveLength(2);
    expect(await w.rt.continuations.waiting(project.id)).toBeNull();
  }, 60_000);

  it("quiet hours hold it: nothing starts in them, the sentence names their end, and it goes on once they end", async () => {
    const w = await compose();
    const { project, task } = await changelog(w.rt);
    await personStartsAndWaits(w, project.id);
    // 14:30 to 17:00 in Zurich covers the reset (15:00); set in Settings, it holds at once.
    const set = await w.post<{ status: string }>("/commands/execute", {
      commands: [
        {
          name: "settings.set",
          params: { key: "quiet_hours", value: { start: "14:30", end: "17:00" } },
        },
      ],
      source: "ui",
      confirm: "tap",
    });
    expect(set.json.status, JSON.stringify(set.json)).toBe("done");
    expect(await w.rt.continuations.waiting(project.id)).toBe(
      "Your session of 10:00 goes on by itself at 17:00.",
    );
    await atTheReset(w);
    expect(await sessionsOf(w.rt, project.id)).toHaveLength(1);
    expect((await w.rt.store.task.mustGet(task.id)).status).toBe("ready");
    // 16:01Z is 17:01 in Zurich: the quiet hours ended.
    await atTheReset(w, "2026-10-31T16:01:00Z");
    await until(
      "the task to be done",
      async () => (await w.rt.store.task.mustGet(task.id)).status === "done",
    );
    const all = await sessionsOf(w.rt, project.id);
    expect(all).toHaveLength(2);
    expect((all[1]?.plan as { startedBy?: { by?: string } } | null)?.startedBy?.by).toBe(
      "continuation",
    );
  }, 60_000);

  // Fix-up of the review (S-10: "every sentence that says when it goes on names the later of the
  // stop's end and the end of the quiet hours"): with quiet hours set before the session met its
  // limit, the session's end sentence, the task's row and the log named the reset (15:00) while
  // the continuation went on at 17:00.
  it("quiet hours over the reset, set before the session: its end sentence, the task's row, the log and the Start check name their end", async () => {
    const w = await compose();
    const { project, task } = await changelog(w.rt);
    const set = await w.post<{ status: string }>("/commands/execute", {
      commands: [
        {
          name: "settings.set",
          params: { key: "quiet_hours", value: { start: "14:30", end: "17:00" } },
        },
      ],
      source: "ui",
      confirm: "tap",
    });
    expect(set.json.status, JSON.stringify(set.json)).toBe("done");
    const first = await personStartsAndWaits(w, project.id);
    const said = "Waits until 17:00 (after your quiet hours); then your session goes on.";
    expect(first.summary?.split("\n")[0]).toBe(said);
    const rows = await w.get<{ id: string; display?: { label?: string; detail?: string } }[]>(
      `/projects/${project.id}/tasks`,
    );
    expect(rows.json.find((t) => t.id === task.id)?.display).toMatchObject({
      label: "Waits until 17:00 (after your quiet hours)",
      detail: "Then your session goes on.",
    });
    const log = (await w.rt.store.event.list(first.id))
      .map((e) => describeEvent(e.type, (e.payload ?? {}) as Record<string, unknown>))
      .filter((l): l is string => typeof l === "string" && /Waits until|waits until/.test(l));
    expect(log.length, log.join("\n")).toBeGreaterThan(1);
    expect(
      log.some((l) => l.endsWith("then your session goes on.")),
      log.join("\n"),
    ).toBe(true);
    for (const line of log) {
      expect(line).toContain("until 17:00 (after your quiet hours)");
      expect(line).not.toContain("15:00");
    }
    const check = await w.get<{ blocked: { sentence?: string } | null }>(
      `/projects/${project.id}/start-check`,
    );
    // d1109-cred-screens (CS-3): with the API key able to serve, the Start dialog names the
    // waiting session and when it goes on by itself (the quiet hours' end, 17:00), the same words
    // a Start answers with (before: "Nothing can run until 17:00 (after your quiet hours); then
    // your session goes on.").
    expect(check.json.blocked?.sentence).toBe("Your session of 10:00 goes on by itself at 17:00.");
    expect(await w.rt.continuations.waiting(project.id)).toBe(
      "Your session of 10:00 goes on by itself at 17:00.",
    );
  }, 60_000);

  // Fix-up of the review (S-10, "Start at 15:40"): a Start pressed while the subscription rested
  // and nothing was kept ran a session that only met the wait and became a continuation, which
  // quiet hours then held although the person chose the time; the project's status never said
  // when it starts. The Start is kept for the reset now and starts once then, by the person.
  it("a Start pressed while the credential is out is kept: nothing runs now, the status says when, and it starts once at the reset by the person, quiet hours not holding it, also after a restart", async () => {
    const clock = new SimulatedClock(START);
    const calls: string[] = [];
    const w1 = await compose({ clock, calls, limited: 0 });
    const { project, task } = await changelog(w1.rt);
    // The subscription rests until the reset (another session met its limit earlier).
    const sub = (await w1.rt.store.billingSource.list({} as never, { limit: 20 })).find(
      (s) => s.kind === "subscription",
    );
    if (!sub) throw new Error("no subscription source");
    await w1.rt.store.billingSource.patch(sub.id, {
      limits: { ...sub.limits, restingUntil: RESET },
    });
    const check = await w1.get<{ blocked: Record<string, unknown> | null }>(
      `/projects/${project.id}/start-check`,
    );
    expect(check.json.blocked).toMatchObject({
      sentence:
        "Nothing can run until 15:00 (your subscription's limit). Press Start at 15:00 and the work starts then.",
      startable: true,
      startLabel: "Start at 15:00",
    });
    const pressed = await w1.post<{ result: string; session: unknown; sentence?: string }>(
      "/sessions",
      {
        agentId: w1.rt.agent.id,
        projectId: project.id,
        trigger: "manual",
        budgetUsdMicro: BUDGET,
        note: "Keep it to one paragraph.",
      },
    );
    expect(pressed.status, JSON.stringify(pressed.json)).toBe(202);
    expect(pressed.json).toMatchObject({
      result: "kept",
      session: null,
      sentence: "A session of Limits starts at 15:00.",
    });
    // Nothing ran: no session, no model call.
    expect(await sessionsOf(w1.rt, project.id)).toEqual([]);
    expect(calls).toEqual([]);
    const card = await w1.get<{ statusLine?: { text?: string } }>(`/projects/${project.id}`);
    // d1109-run-visible (V-3): the kept Start is said with Cancel, without ": 1 task".
    expect(card.json.statusLine?.text).toBe("Starts at 15:00 (your subscription's limit)");
    expect(
      (
        await w1.get<{ blocked: Record<string, unknown> | null }>(
          `/projects/${project.id}/start-check`,
        )
      ).json.blocked,
    ).toMatchObject({ kept: true });
    // One wait per project: a second Start keeps nothing new and says when.
    const again = await w1.post("/sessions", {
      agentId: w1.rt.agent.id,
      projectId: project.id,
      trigger: "manual",
    });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.json)).toContain("A session of Limits starts at 15:00.");
    // Quiet hours over the reset hold a start nobody pressed; this one the person pressed.
    const set = await w1.post<{ status: string }>("/commands/execute", {
      commands: [
        {
          name: "settings.set",
          params: { key: "quiet_hours", value: { start: "14:30", end: "17:00" } },
        },
      ],
      source: "ui",
      confirm: "tap",
    });
    expect(set.json.status, JSON.stringify(set.json)).toBe("done");
    await w1.close();

    const w2 = await compose({ home: w1.home, clock, calls, limited: 0 });
    expect(await w2.rt.continuations.waiting(project.id)).toBe(
      "A session of Limits starts at 15:00.",
    );
    await atTheReset(w2);
    await until(
      "the task to be done",
      async () => (await w2.rt.store.task.mustGet(task.id)).status === "done",
    );
    const all = await sessionsOf(w2.rt, project.id);
    expect(all).toHaveLength(1);
    expect(all[0]?.trigger).toBe("budget_reset");
    expect((all[0]?.plan as { startedBy?: unknown } | null)?.startedBy).toEqual({ by: "person" });
    expect(all[0]?.budget_cap_usd_micro).toBe(BUDGET);
    // The note the person gave reached the brief, as their own words.
    expect(calls.some((c) => c.includes("Keep it to one paragraph."))).toBe(true);
    await atTheReset(w2, "2026-10-31T14:30:00Z");
    expect(await sessionsOf(w2.rt, project.id)).toHaveLength(1);
    await w2.close();

    const w3 = await compose({ home: w1.home, clock, calls, limited: 0 });
    expect(await w3.rt.continuations.waiting(project.id)).toBeNull();
    await atTheReset(w3, "2026-10-31T16:30:00Z");
    expect(await sessionsOf(w3.rt, project.id)).toHaveLength(1);
  }, 90_000);

  it("Cancel drops it: nothing starts at the reset and its task waits for the next Start", async () => {
    const w = await compose();
    const { project, task } = await changelog(w.rt);
    await personStartsAndWaits(w, project.id);
    const cancelled = await w.post<ContinuationCancelView>(
      `/projects/${project.id}/continuation/cancel`,
    );
    expect(cancelled.json).toEqual({
      cancelled: true,
      sentence: "Cancelled: nothing goes on by itself; its tasks run at your next Start.",
    });
    expect(
      (await w.post<ContinuationCancelView>(`/projects/${project.id}/continuation/cancel`)).json,
    ).toEqual({ cancelled: false, sentence: "Nothing waits to go on for this project." });
    expect(await w.rt.continuations.waiting(project.id)).toBeNull();
    await atTheReset(w);
    await atTheReset(w, "2026-10-31T15:00:00Z");
    expect(await sessionsOf(w.rt, project.id)).toHaveLength(1);
    expect((await w.rt.store.task.mustGet(task.id)).status).toBe("ready");
  }, 60_000);

  it("Stop all drops it: nothing starts at the reset, even after Resume", async () => {
    const w = await compose();
    const { project } = await changelog(w.rt);
    await personStartsAndWaits(w, project.id);
    expect((await w.post("/kill", { scope: "all" })).status).toBe(200);
    expect(await w.rt.continuations.waiting(project.id)).toBeNull();
    expect((await w.post("/kill/resume", {})).status).toBe(200);
    await atTheReset(w);
    await atTheReset(w, "2026-10-31T15:00:00Z");
    expect(await sessionsOf(w.rt, project.id)).toHaveLength(1);
  }, 60_000);

  it("none for a session the person stopped (Stop after this task): its task waits for the next Start", async () => {
    let stopped = false;
    const w = await compose({
      onCall: async (world) => {
        if (stopped) return;
        stopped = true;
        const running = (await world.rt.store.session.list({} as never, { limit: 10 })).find(
          (s) => s.status === "running",
        );
        if (!running) throw new Error("no running session to stop");
        expect((await world.post(`/sessions/${running.id}/pause`, {})).status).toBe(200);
      },
    });
    const { project, task } = await changelog(w.rt);
    await personStartsAndWaits(w, project.id);
    expect(stopped).toBe(true);
    expect(await w.rt.continuations.waiting(project.id)).toBeNull();
    await atTheReset(w);
    await atTheReset(w, "2026-10-31T15:00:00Z");
    expect(await sessionsOf(w.rt, project.id)).toHaveLength(1);
    expect((await w.rt.store.task.mustGet(task.id)).status).toBe("ready");
  }, 60_000);

  it("none for work outside a session the person started: a system schedule's session waits, and at the reset nothing starts", async () => {
    const w = await compose();
    const { project, task } = await changelog(w.rt);
    await w.rt.runner.start({
      agentId: w.rt.agent.id,
      projectId: project.id,
      trigger: "schedule",
      by: "schedule",
      budgetCapUsdMicro: BUDGET,
      grant: {
        allowedTools: [...w.rt.toolsForRun().names(), ...claudeCodeToolNames()],
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
      },
    });
    const [only] = await sessionsOf(w.rt, project.id);
    expect(only?.summary?.split("\n")[0]).toBe(
      "Waits until 15:00 (your subscription's limit); then it runs at your next Start.",
    );
    expect(await w.rt.continuations.waiting(project.id)).toBeNull();
    await atTheReset(w);
    await atTheReset(w, "2026-10-31T15:00:00Z");
    expect(await sessionsOf(w.rt, project.id)).toHaveLength(1);
    expect((await w.rt.store.task.mustGet(task.id)).status).toBe("ready");
  }, 60_000);

  it("survives a restart: the restarted daemon says it waits, goes on once at the reset, and a second restart starts nothing more", async () => {
    const clock = new SimulatedClock(START);
    const calls: string[] = [];
    const w1 = await compose({ clock, calls });
    const { project, task } = await changelog(w1.rt);
    const first = await personStartsAndWaits(w1, project.id);
    await w1.close();

    const w2 = await compose({ home: w1.home, clock, calls });
    expect(await w2.rt.continuations.waiting(project.id)).toBe(
      "Your session of 10:00 goes on by itself at 15:00.",
    );
    await atTheReset(w2);
    await until(
      "the task to be done",
      async () => (await w2.rt.store.task.mustGet(task.id)).status === "done",
    );
    const all = await sessionsOf(w2.rt, project.id);
    expect(all).toHaveLength(2);
    expect((all[1]?.plan as { startedBy?: unknown } | null)?.startedBy).toMatchObject({
      by: "continuation",
      continues: first.id,
    });
    await w2.close();

    const w3 = await compose({ home: w1.home, clock, calls });
    expect(await w3.rt.continuations.waiting(project.id)).toBeNull();
    await atTheReset(w3, "2026-10-31T15:00:00Z");
    expect(await sessionsOf(w3.rt, project.id)).toHaveLength(2);
  }, 90_000);
});
