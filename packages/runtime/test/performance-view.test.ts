import { isForerunnerError, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PerformanceView } from "../src/daemon/api-types.ts";
import {
  eventSample,
  nearestRank,
  OFFSET_MODES,
  performanceView,
  runMode,
} from "../src/daemon/views.ts";
import { DEFAULT_LADDER, INTAKE_RUN_SPECIALIST, MODE_DEFAULTS } from "../src/models/ladder.ts";
import { seedWorld } from "./context-helpers.ts";

/**
 * The Performance view (spec D.7, D.19) from the store: Run rows across the modes, chat and
 * voice turns, grouped per mode with the median and p90 by nearest rank of time to first token
 * and total time against the mode's target (D.8 to D.15), inside a window of days, for the
 * install's human only, with the effort in force.
 */
const NOW = "2026-10-20T08:00:00.000Z";
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

describe("nearest-rank percentiles", () => {
  it("takes sorted[ceil(p/100 * n) - 1], whatever the input order", () => {
    const ten = [10, 3, 7, 1, 9, 2, 8, 4, 6, 5];
    expect(nearestRank(ten, 50)).toBe(5);
    expect(nearestRank(ten, 90)).toBe(9);
    expect(nearestRank(ten, 100)).toBe(10);
    expect(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 90)).toBe(10);
    expect(nearestRank([3, 1, 2], 50)).toBe(2);
    expect(nearestRank([3, 1, 2], 90)).toBe(3);
    expect(nearestRank([42], 50)).toBe(42);
    expect(nearestRank([42], 90)).toBe(42);
    expect(nearestRank([], 90)).toBeNull();
    // The input is not reordered in place.
    expect(ten[0]).toBe(10);
  });
});

describe("mode derivation", () => {
  it("reads the mode from the specialist, the review tier and the critic's rung", () => {
    expect(runMode({ specialist: "coder", model: "fake-sonnet" })).toBe("coder");
    expect(runMode({ specialist: "tester", model: "fake-sonnet" })).toBe("coder");
    expect(runMode({ specialist: "researcher", model: "fake-opus" })).toBe("researcher");
    expect(runMode({ specialist: INTAKE_RUN_SPECIALIST, model: "fake-sonnet" })).toBe("planning");
    expect(runMode({ specialist: "critic", model: "fake-sonnet" }, 1)).toBe("critic_t1");
    expect(runMode({ specialist: "critic", model: "fake-sonnet" }, 2)).toBe("critic_t23");
    expect(runMode({ specialist: "critic", model: "fake-opus" }, 3)).toBe("critic_t23");
    // Without a Review row: the rung of the model (opus and above is tier 2 or 3).
    expect(runMode({ specialist: "critic", model: "claude-opus-5-5" })).toBe("critic_t23");
    expect(runMode({ specialist: "critic", model: "claude-sonnet-5-5" })).toBe("critic_t1");
    expect(runMode({ specialist: "critic", model: "unknown-model" })).toBe("critic_t1");
  });

  it("reads text chat from chat.reply rows and voice from voice.turn rows, skipping the rest", () => {
    const base = {
      id: "ev",
      created_at: NOW,
      updated_at: NOW,
      author_agent: null,
      author_human: null,
      version: 1,
      session_id: "s",
      seq: 1,
      cost_usd_micro: 0,
      redacted: false,
    };
    expect(
      eventSample({
        ...base,
        type: "chat.reply",
        payload: { ttftMs: 400, durationMs: 900, model: "m", effort: "low", source: "text" },
      }),
    ).toMatchObject({ mode: "text_chat", source: "chat", ttftMs: 400, durationMs: 900 });
    // A row written before the total time was recorded still counts its first token.
    expect(eventSample({ ...base, type: "chat.reply", payload: { ttftMs: 300 } })).toMatchObject({
      mode: "text_chat",
      ttftMs: 300,
      durationMs: null,
      model: "",
    });
    // No model call (a yes answered by the registry), or a voice turn's reply: not a sample.
    expect(eventSample({ ...base, type: "chat.reply", payload: { text: "Done." } })).toBeNull();
    expect(
      eventSample({ ...base, type: "chat.reply", payload: { ttftMs: 1, source: "voice" } }),
    ).toBeNull();
    expect(
      eventSample({
        ...base,
        type: "voice.turn",
        payload: { latency: { totalToFirstAudioMs: 950, modelFirstTokenMs: 400 } },
      }),
    ).toMatchObject({ mode: "voice_chat", source: "voice", ttftMs: 950, durationMs: null });
    expect(
      eventSample({ ...base, type: "voice.turn", payload: { latency: { firstAudioMs: null } } }),
    ).toBeNull();
    expect(eventSample({ ...base, type: "chat.human", payload: { ttftMs: 1 } })).toBeNull();
  });
});

describe("performanceView over seeded Run rows and turns", () => {
  let store: StateStore;
  let clock: SimulatedClock;
  let w: Awaited<ReturnType<typeof seedWorld>>;
  let otherProjectSession = "";
  let conversation = "";

  const run = (over: Record<string, unknown>) =>
    store.run.insert({
      session_id: w.session,
      specialist: "coder",
      model: "fake-sonnet",
      effort: "medium",
      outcome: "completed",
      created_at: ago(1),
      ...over,
    });

  beforeEach(async () => {
    clock = new SimulatedClock(NOW);
    store = await openStore({ url: "sqlite::memory:", clock });
    // The project leans to quality: one effort step up where the code applies the offset.
    w = await seedWorld(store, { speed_quality_offset: 1 });

    // Critic tier 1: ten reviews, 5 s to 40 s. p50 = 25 s, p90 = 29 s (rank 9 of 10) <= 30 s.
    const t1 = [5, 10, 15, 20, 25, 26, 27, 28, 29, 40];
    for (const [i, s] of t1.entries())
      await run({
        specialist: "critic",
        model: "fake-sonnet",
        ttft_ms: 100 * (i + 1),
        duration_ms: s * 1000,
        created_at: ago(10 - i),
      });
    // Critic tier 2 on a sonnet rung (a lowered ceiling): the Review row's tier decides.
    const t2 = await run({
      specialist: "critic",
      model: "fake-sonnet",
      effort: "high",
      ttft_ms: 700,
      duration_ms: 50_000,
      created_at: ago(2),
    });
    await store.review.insert({
      task_id: null,
      session_id: w.session,
      critic_model: "fake-sonnet",
      tier: 2,
      grade: 80,
      confidence: 0.8,
      verdict: "accept",
      evidence: ["prompt:critic@1", `run:${t2.id}`],
      summary: "ok",
    });
    // Critic on opus without a Review row (the review was refused): tier 2 or 3 by its rung.
    await run({ specialist: "critic", model: "fake-opus", ttft_ms: 900, duration_ms: 70_000 });
    // Coding specialist: set by the task, no target; the effort table's medium.
    await run({ ttft_ms: 800, duration_ms: 180_000, created_at: ago(5) });
    await run({ specialist: "tester", ttft_ms: 1200, duration_ms: 240_000, created_at: ago(4) });
    // Planning: the intake call, 70 s against 60 s.
    await run({
      specialist: INTAKE_RUN_SPECIALIST,
      effort: "high",
      ttft_ms: 2000,
      duration_ms: 70_000,
      created_at: ago(3),
    });
    // Not measurements: a run still going, a run older than the window.
    await run({ outcome: "running", ttft_ms: null, duration_ms: null });
    await run({
      specialist: "researcher",
      ttft_ms: 1500,
      duration_ms: 300_000,
      created_at: ago(8 * 24),
    });

    // Another project of the same human.
    const other = await store.project.insert({
      name: "Q",
      goal: "g",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 1,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    });
    otherProjectSession = (
      await store.session.insert({
        agent_id: w.agent,
        project_id: other.id,
        trigger: "manual",
        plan: {},
        budget_cap_usd_micro: 1,
        step_cap: 1,
        status: "planned",
      })
    ).id;
    await run({
      session_id: otherProjectSession,
      specialist: "researcher",
      ttft_ms: 1100,
      duration_ms: 200_000,
      created_at: ago(6),
    });

    // Another human's agent: never counted, whatever the project.
    const bob = await store.human.insert({ name: "Bob", email: "bob@example.test" });
    const bobAgent = await store.agent.insert({
      name: "Bobby",
      owner_human_id: bob.id,
      kind: "principal",
    });
    const bobSession = await store.session.insert({
      agent_id: bobAgent.id,
      project_id: w.project,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 1,
      step_cap: 1,
      status: "planned",
    });
    await run({ session_id: bobSession.id, ttft_ms: 1, duration_ms: 1, created_at: ago(1) });
    await store.event.append(bobSession.id, "chat.reply", { ttftMs: 1, durationMs: 2 });

    // Chat and voice turns on the conversation session of the project.
    conversation = (
      await store.session.insert({
        agent_id: w.agent,
        project_id: w.project,
        trigger: "manual",
        plan: {},
        budget_cap_usd_micro: 1,
        step_cap: 1,
        status: "planned",
        summary: "conversation",
      })
    ).id;
    for (const [ttft, total] of [
      [400, 1800],
      [600, 2200],
      [1300, 4000],
    ] as const) {
      await clock.advance(1000);
      await store.event.append(conversation, "chat.reply", {
        ttftMs: ttft,
        durationMs: total,
        model: "fake-haiku",
        effort: "low",
        source: "text",
      });
    }
    await store.event.append(conversation, "chat.reply", { text: "Done.", actions: [] });
    await store.event.append(conversation, "chat.reply", { ttftMs: 50, source: "voice" });
    await clock.advance(1000);
    await store.event.append(conversation, "voice.turn", {
      turn: 1,
      latency: { totalToFirstAudioMs: 900, modelFirstTokenMs: 400 },
    });
    await clock.advance(1000);
    await store.event.append(conversation, "voice.turn", {
      turn: 2,
      latency: { totalToFirstAudioMs: 1500, modelFirstTokenMs: 700 },
    });
  });
  afterEach(async () => {
    await store.close();
  });

  const modeOf = (v: PerformanceView, mode: string) => {
    const m = v.modes.find((x) => x.mode === mode);
    if (!m) throw new Error(`no ${mode} row`);
    return m;
  };

  it("groups the project's samples per mode with p50 and p90 by nearest rank against the target", async () => {
    const v = await performanceView(store, {
      humanId: w.human,
      projectId: w.project,
      nowIso: clock.nowIso(),
    });
    expect(PerformanceView.safeParse(v).success).toBe(true);
    expect(v.days).toBe(7);
    expect(v.from).toBe(new Date(clock.now() - 7 * 86_400_000).toISOString());
    expect(v.projectId).toBe(w.project);
    expect(v.effortOffset).toBe(1);
    // Every mode of the effort table, in the spec's order, with its target (D.8 to D.15).
    expect(v.modes.map((m) => m.mode)).toEqual(Object.keys(MODE_DEFAULTS));
    for (const m of v.modes) {
      const d = MODE_DEFAULTS[m.mode as keyof typeof MODE_DEFAULTS];
      expect(m.targetMs).toBe(d.targetMs);
      expect(m.targetKind).toBe(d.targetKind);
      expect(m.tier).toBe(d.tier);
    }

    const t1 = modeOf(v, "critic_t1");
    expect(t1).toMatchObject({
      label: "Critic tier 1",
      samples: 10,
      ttftP50Ms: 500,
      ttftP90Ms: 900,
      totalP50Ms: 25_000,
      totalP90Ms: 29_000,
      withinTargetShare: 0.9,
      met: true,
      lastAt: ago(1),
    });
    const t23 = modeOf(v, "critic_t23");
    expect(t23).toMatchObject({ samples: 2, totalP50Ms: 50_000, totalP90Ms: 70_000 });
    // Tier 2 and 3 have no numeric target: no share, no verdict.
    expect(t23).toMatchObject({ targetKind: "by_task", withinTargetShare: null, met: null });

    const planning = modeOf(v, "planning");
    expect(planning).toMatchObject({
      samples: 1,
      ttftP50Ms: 2000,
      totalP90Ms: 70_000,
      withinTargetShare: 0,
      met: false,
    });

    const coder = modeOf(v, "coder");
    expect(coder).toMatchObject({
      samples: 2,
      ttftP50Ms: 800,
      ttftP90Ms: 1200,
      totalP50Ms: 180_000,
      totalP90Ms: 240_000,
      met: null,
      withinTargetShare: null,
    });

    // Text chat: three model turns (the registry's "Done." and the voice reply are not), the
    // first token against 1 s: p90 = 1.3 s, two of three within.
    const text = modeOf(v, "text_chat");
    expect(text).toMatchObject({
      samples: 3,
      ttftP50Ms: 600,
      ttftP90Ms: 1300,
      totalP50Ms: 2200,
      totalP90Ms: 4000,
      met: false,
    });
    expect(text.withinTargetShare).toBeCloseTo(2 / 3, 5);

    // Voice: end of turn to first audio against 1.2 s.
    const voice = modeOf(v, "voice_chat");
    expect(voice).toMatchObject({
      samples: 2,
      ttftP50Ms: 900,
      ttftP90Ms: 1500,
      totalP50Ms: null,
      withinTargetShare: 0.5,
      met: false,
      lastAt: clock.nowIso(),
    });

    // Nothing measured: the mode is listed with its target and no figures.
    expect(modeOf(v, "routing")).toMatchObject({
      samples: 0,
      ttftP50Ms: null,
      ttftP90Ms: null,
      totalP50Ms: null,
      totalP90Ms: null,
      withinTargetShare: null,
      met: null,
      lastAt: null,
    });
    // The other project's researcher run and the run older than the window are not here.
    expect(modeOf(v, "researcher").samples).toBe(0);
  });

  it("shows the effort in force: the table's effort, shifted by the project's offset where it applies", async () => {
    const v = await performanceView(store, {
      humanId: w.human,
      projectId: w.project,
      nowIso: clock.nowIso(),
    });
    expect(modeOf(v, "critic_t1")).toMatchObject({
      baseEffort: "medium",
      effort: "high",
      offsetApplied: true,
    });
    expect(modeOf(v, "critic_t23")).toMatchObject({ baseEffort: "high", effort: "xhigh" });
    // The effort a risky task raises the mode to, as effortForTask applies it: the coder at
    // risk tier 2 and above runs at high (the offset does not reach it), a tier 3 review at
    // max (one step up from max is max).
    expect(modeOf(v, "coder")).toMatchObject({
      effort: "medium",
      riskEffort: "high",
      riskTierFrom: 2,
    });
    expect(modeOf(v, "critic_t23")).toMatchObject({ riskEffort: "max", riskTierFrom: 3 });
    for (const mode of [
      "voice_chat",
      "text_chat",
      "routing",
      "planning",
      "researcher",
      "critic_t1",
    ])
      expect(modeOf(v, mode)).toMatchObject({ riskEffort: null, riskTierFrom: null });
    // The offset does not reach the executor, chat, voice or planning yet (D.16).
    for (const mode of ["coder", "text_chat", "voice_chat", "planning", "routing"]) {
      const m = modeOf(v, mode);
      expect(m.offsetApplied).toBe(false);
      expect(m.effort).toBe(m.baseEffort);
    }
    expect(OFFSET_MODES).toEqual(["critic_t1", "critic_t23"]);
    // The table in force: an effort adopted by the model watch is what the view shows.
    const adopted = await performanceView(store, {
      humanId: w.human,
      projectId: w.project,
      nowIso: clock.nowIso(),
      modelConfig: {
        ladder: DEFAULT_LADDER,
        modeDefaults: {
          ...MODE_DEFAULTS,
          critic_t1: { ...MODE_DEFAULTS.critic_t1, effort: "low" },
          text_chat: { ...MODE_DEFAULTS.text_chat, effort: "medium" },
          coder: { ...MODE_DEFAULTS.coder, effort: "high" },
        },
      },
    });
    expect(modeOf(adopted, "critic_t1")).toMatchObject({ baseEffort: "low", effort: "medium" });
    expect(modeOf(adopted, "text_chat")).toMatchObject({ baseEffort: "medium", effort: "medium" });
    // A table whose coder already runs at high: no risk tier changes it.
    expect(modeOf(adopted, "coder")).toMatchObject({ effort: "high", riskEffort: null });
    // All projects: no single offset, so none is applied.
    const all = await performanceView(store, { humanId: w.human, nowIso: clock.nowIso() });
    expect(all.effortOffset).toBe(0);
    expect(modeOf(all, "critic_t1").effort).toBe("medium");
  });

  it("covers all of the human's projects without a project, and the window follows ?days", async () => {
    const all = await performanceView(store, { humanId: w.human, nowIso: clock.nowIso() });
    expect(all.projectId).toBeNull();
    // The other project's researcher run counts; the eight-day-old one does not.
    expect(modeOf(all, "researcher")).toMatchObject({ samples: 1, totalP50Ms: 200_000 });
    // Bob's run and chat turn never count: coder stays at Alice's two, text chat at three.
    expect(modeOf(all, "coder").samples).toBe(2);
    expect(modeOf(all, "text_chat").samples).toBe(3);

    const ten = await performanceView(store, {
      humanId: w.human,
      days: 10,
      nowIso: clock.nowIso(),
    });
    expect(ten.days).toBe(10);
    expect(modeOf(ten, "researcher")).toMatchObject({ samples: 2, totalP90Ms: 300_000 });
    // One day: only the last 24 hours (the critic runs 1 to 10 hours ago all count).
    const one = await performanceView(store, { humanId: w.human, days: 1, nowIso: clock.nowIso() });
    expect(modeOf(one, "critic_t1").samples).toBe(10);
    expect(modeOf(one, "researcher").samples).toBe(1);
    // The window is bounded.
    const huge = await performanceView(store, {
      humanId: w.human,
      days: 1000,
      nowIso: clock.nowIso(),
    });
    expect(huge.days).toBe(90);
    // A later "now" moves the window: two weeks on, nothing of this is in the last 7 days.
    const later = await performanceView(store, {
      humanId: w.human,
      nowIso: new Date(clock.now() + 14 * 86_400_000).toISOString(),
    });
    expect(later.modes.every((m) => m.samples === 0)).toBe(true);
    expect(later.recent).toHaveLength(0);
  });

  it("lists the newest measurements first with their source, and refuses an unknown project", async () => {
    const v = await performanceView(store, {
      humanId: w.human,
      projectId: w.project,
      nowIso: clock.nowIso(),
      recentLimit: 4,
    });
    expect(v.recent).toHaveLength(4);
    expect(v.recent.map((r) => r.source)).toEqual(["voice", "voice", "chat", "chat"]);
    expect(v.recent[0]).toMatchObject({ mode: "voice_chat", ttftMs: 1500, at: clock.nowIso() });
    expect(v.recent[2]).toMatchObject({
      mode: "text_chat",
      specialist: "conversation",
      model: "fake-haiku",
      effort: "low",
      ttftMs: 1300,
      durationMs: 4000,
    });
    const ats = v.recent.map((r) => r.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    const full = await performanceView(store, {
      humanId: w.human,
      projectId: w.project,
      nowIso: clock.nowIso(),
    });
    expect(full.recent).toHaveLength(20);
    const runs = full.recent.filter((r) => r.source === "run");
    expect(runs.every((r) => r.runId.length > 0 && r.model.length > 0)).toBe(true);

    const err = await performanceView(store, {
      humanId: w.human,
      projectId: "proj_missing",
      nowIso: clock.nowIso(),
    }).catch((e: unknown) => e);
    expect(isForerunnerError(err) && err.code).toBe("not_found");
  });
});

describe("what counts as a measurement", () => {
  it("leaves out runs and chat turns that never reached a model, and keeps timeouts", async () => {
    const clock = new SimulatedClock(NOW);
    const store = await openStore({ url: "sqlite::memory:", clock });
    const w = await seedWorld(store);
    const critic = (over: Record<string, unknown>) =>
      store.run.insert({
        session_id: w.session,
        specialist: "critic",
        model: "fake-sonnet",
        effort: "medium",
        outcome: "completed",
        created_at: ago(1),
        ...over,
      });
    // A real tier 1 review over its target.
    await critic({ ttft_ms: 900, duration_ms: 45_000 });
    // Closed by `endRunWithError` (a refused lease, a missing secret): a few ms, no first token.
    await critic({ outcome: "error", ttft_ms: null, duration_ms: 3 });
    // Refused by the budget before the call.
    await critic({ outcome: "budget_exceeded", ttft_ms: null, duration_ms: 1 });
    // A call that hung until its wall clock: no first token, but a real response time.
    await critic({ outcome: "timeout", timed_out: true, ttft_ms: null, duration_ms: 60_000 });
    // The planning call that threw before the driver ran: not a planning sample.
    await store.run.insert({
      session_id: w.session,
      specialist: INTAKE_RUN_SPECIALIST,
      model: "fake-sonnet",
      effort: "high",
      outcome: "failed",
      ttft_ms: null,
      duration_ms: 2,
      created_at: ago(1),
    });
    // Chat: a model turn, a turn whose model call failed at once, a turn that timed out.
    const conv = w.session;
    await store.event.append(conv, "chat.reply", { ttftMs: 500, durationMs: 1500 });
    await store.event.append(conv, "chat.reply", {
      ttftMs: null,
      durationMs: 4,
      outcome: "error",
    });
    await store.event.append(conv, "chat.reply", {
      ttftMs: null,
      durationMs: 30_000,
      outcome: "timeout",
    });

    const v = await performanceView(store, { humanId: w.human, nowIso: clock.nowIso() });
    const t1 = v.modes.find((m) => m.mode === "critic_t1");
    expect(t1).toMatchObject({
      samples: 2,
      ttftP50Ms: 900,
      totalP50Ms: 45_000,
      totalP90Ms: 60_000,
      withinTargetShare: 0,
      met: false,
    });
    expect(v.modes.find((m) => m.mode === "planning")).toMatchObject({
      samples: 0,
      withinTargetShare: null,
      met: null,
    });
    expect(v.modes.find((m) => m.mode === "text_chat")).toMatchObject({
      samples: 2,
      ttftP50Ms: 500,
      totalP50Ms: 1500,
      totalP90Ms: 30_000,
    });
    expect(v.recent.some((r) => r.durationMs === 3 || r.durationMs === 4)).toBe(false);
    await store.close();
  });
});
