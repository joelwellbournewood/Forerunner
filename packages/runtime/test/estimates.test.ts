import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COLD_START_BUDGET_SHARE,
  DEFAULT_COLD_START_TIMEOUT_SHARE,
  DEFAULT_FALLBACK_USD_MICRO,
  DEFAULT_FALLBACK_WALL_MS,
  EstimateModel,
  type EstimatePort,
  type EstimateSample,
  kindOfTask,
  planEstimateUsdMicro,
  RATIO_MAX,
  type SpecialistDefaults,
} from "../src/estimates/model.ts";
import { EstimateAccuracyViewSchema, estimateAccuracyView } from "../src/estimates/view.ts";
import { cutPlanToBudget, type SessionPlan } from "../src/session/runner.ts";

const REGISTRY: Record<string, SpecialistDefaults> = {
  coder: { maxBudgetUsd: 3, timeoutMinutes: 45 },
  researcher: { maxBudgetUsd: 2, timeoutMinutes: 30 },
};
const defaults = (name: string) => REGISTRY[name];

function sample(over: Partial<EstimateSample> & { i: number }): EstimateSample {
  return {
    specialist: "coder",
    kind: "tier1",
    estimateUsdMicro: 1_000_000,
    actualUsdMicro: 1_500_000,
    estimateWallMs: 600_000,
    actualWallMs: 900_000,
    at: new Date(Date.UTC(2026, 9, 1, 0, over.i)).toISOString(),
    ...over,
  };
}

describe("estimate model: cold start and bases", () => {
  it("cold start uses the registry defaults scaled by the documented share, else the fallback", () => {
    const m = new EstimateModel({ defaults });
    const coder = m.estimate({ specialist: "coder", risk_tier: 1 });
    expect(coder).toMatchObject({
      basis: "registry_default",
      samples: 0,
      confidence: 0,
      costRatio: 1,
      wallRatio: 1,
      usdMicro: Math.round(3 * 1_000_000 * DEFAULT_COLD_START_BUDGET_SHARE),
      wallMs: Math.round(45 * 60_000 * DEFAULT_COLD_START_TIMEOUT_SHARE),
      specialist: "coder",
      kind: "tier1",
    });
    const unknown = m.estimate({ specialist: "designer", risk_tier: 0 });
    expect(unknown).toMatchObject({
      basis: "fallback",
      usdMicro: DEFAULT_FALLBACK_USD_MICRO,
      wallMs: DEFAULT_FALLBACK_WALL_MS,
    });
    // A task without a specialist is planned as the planner would: as coder.
    expect(m.estimate({ specialist: null, risk_tier: 2 }).specialist).toBe("coder");
  });

  it("a task's own estimate is the base when present", () => {
    const m = new EstimateModel({ defaults });
    const r = m.estimate({ specialist: "coder", risk_tier: 1, est_cost_usd_micro: 250_000 });
    expect(r).toMatchObject({ basis: "task_estimate", usdMicro: 250_000, samples: 0 });
    expect(kindOfTask({ risk_tier: 3 })).toBe("tier3");
    expect(kindOfTask({ risk_tier: 9 })).toBe("tier3");
    expect(kindOfTask({ risk_tier: 1, kind: "migration" })).toBe("migration");
  });
});

describe("estimate model: learning", () => {
  it("converges on a simulated history where actuals run 1.5x the estimate (cost) and 1.5x (wall)", () => {
    const m = new EstimateModel({ defaults });
    const ratios: number[] = [];
    for (let i = 0; i < 60; i++) {
      m.observe(sample({ i }));
      ratios.push(m.estimate({ specialist: "coder", risk_tier: 1 }).costRatio);
    }
    const last = m.estimate({ specialist: "coder", risk_tier: 1, est_cost_usd_micro: 1_000_000 });
    expect(last.basis).toBe("learned");
    expect(last.samples).toBe(60);
    expect(last.costRatio).toBeGreaterThan(1.4);
    expect(last.costRatio).toBeLessThanOrEqual(1.5);
    expect(last.wallRatio).toBeGreaterThan(1.4);
    expect(last.usdMicro).toBe(Math.round(1_000_000 * last.costRatio));
    expect(last.wallMs).toBe(Math.round(45 * 60_000 * 0.5 * last.wallRatio));
    // Monotone approach toward 1.5 as the shrinkage weight grows.
    for (let i = 1; i < ratios.length; i++)
      expect(ratios[i] as number).toBeGreaterThanOrEqual(ratios[i - 1] as number);
    // A later regime change pulls the ratio back down (exponential weighting forgets).
    for (let i = 60; i < 90; i++) m.observe(sample({ i, actualUsdMicro: 800_000 }));
    expect(m.estimate({ specialist: "coder", risk_tier: 1 }).costRatio).toBeLessThan(1);
  });

  it("confidence grows with samples and falls with dispersion", () => {
    const steady = new EstimateModel({ defaults });
    const conf: number[] = [];
    for (let i = 0; i < 20; i++) {
      steady.observe(sample({ i }));
      conf.push(steady.estimate({ specialist: "coder", risk_tier: 1 }).confidence);
    }
    expect(conf[0] as number).toBeGreaterThan(0);
    expect(conf[4] as number).toBeGreaterThan(conf[0] as number);
    expect(conf[19] as number).toBeGreaterThan(conf[4] as number);
    expect(conf[19] as number).toBeLessThanOrEqual(1);

    const noisy = new EstimateModel({ defaults });
    for (let i = 0; i < 20; i++)
      noisy.observe(sample({ i, actualUsdMicro: i % 2 ? 4_000_000 : 300_000 }));
    expect(noisy.estimate({ specialist: "coder", risk_tier: 1 }).confidence).toBeLessThan(
      conf[19] as number,
    );
  });

  it("learns per (specialist, kind), clamps runaway samples and the final multiplier, ignores unusable samples", () => {
    const m = new EstimateModel({ defaults });
    for (let i = 0; i < 10; i++) m.observe(sample({ i, kind: "tier0", actualUsdMicro: 500_000 }));
    for (let i = 0; i < 10; i++)
      m.observe(sample({ i, specialist: "researcher", kind: "tier0", actualUsdMicro: 2_000_000 }));
    expect(m.estimate({ specialist: "coder", risk_tier: 0 }).costRatio).toBeLessThan(1);
    expect(m.estimate({ specialist: "coder", risk_tier: 1 }).samples).toBe(0);
    expect(m.estimate({ specialist: "researcher", risk_tier: 0 }).costRatio).toBeGreaterThan(1);
    const wild = new EstimateModel({ defaults, shrinkage: 0 });
    for (let i = 0; i < 5; i++) wild.observe(sample({ i, actualUsdMicro: 900_000_000 }));
    expect(wild.estimate({ specialist: "coder", risk_tier: 1 }).costRatio).toBe(RATIO_MAX);
    expect(m.observe(sample({ i: 99, estimateUsdMicro: 0 }))).toBe(false);
    expect(m.observe(sample({ i: 99, actualUsdMicro: 0, actualWallMs: 0 }))).toBe(false);
    expect(m.stats().map((s) => `${s.specialist}/${s.kind}`)).toEqual([
      "coder/tier0",
      "researcher/tier0",
    ]);
  });

  it("snapshots round-trip", () => {
    const m = new EstimateModel({ defaults });
    for (let i = 0; i < 7; i++) m.observe(sample({ i }));
    const copy = EstimateModel.fromJSON(JSON.parse(JSON.stringify(m.toJSON())), { defaults });
    expect(copy.estimate({ specialist: "coder", risk_tier: 1 })).toEqual(
      m.estimate({ specialist: "coder", risk_tier: 1 }),
    );
    expect(copy.recentSamples()).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------------------
// Learning from the store
// ---------------------------------------------------------------------------------------

interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  agent: string;
  project: string;
  session: string;
}

async function world(): Promise<World> {
  const clock = new SimulatedClock("2026-10-01T07:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 150_000_000,
      locale: "en",
    })
  ).id;
  const agent = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: human,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    })
  ).id;
  const project = (
    await store.project.insert({
      name: "Sample",
      goal: "Ship",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    })
  ).id;
  const session = (
    await store.session.insert({
      agent_id: agent,
      project_id: project,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 5_000_000,
      step_cap: 100,
      spent_usd_micro: 0,
      steps: 0,
      started_at: clock.nowIso(),
      status: "running",
      summary: "",
      handoff: {},
      runner: "pc",
      device_id: null,
    })
  ).id;
  return { store, clock, human, agent, project, session };
}

async function finishedTask(
  w: World,
  over: {
    specialist?: string;
    riskTier?: number;
    estimate: number;
    actual: number;
    durationMs?: number;
    ledger?: boolean;
    status?: TaskRow["status"];
    runs?: number;
  },
): Promise<TaskRow> {
  await w.clock.advance(60_000);
  const task = await w.store.task.insert({
    project_id: w.project,
    title: `t-${w.clock.now()}`,
    outcome: "done",
    acceptance_criteria: ["works"],
    risk_tier: over.riskTier ?? 1,
    status: over.status ?? "done",
    priority: 1,
    depends_on: [],
    budget_usd_micro: 2_000_000,
    est_cost_usd_micro: over.estimate,
    actual_cost_usd_micro: over.actual,
    specialist: over.specialist ?? "coder",
  });
  const runs = over.runs ?? 1;
  for (let i = 0; i < runs; i++) {
    const run = await w.store.run.insert({
      task_id: task.id,
      session_id: w.session,
      specialist: over.specialist ?? "coder",
      model: "fake-sonnet",
      provider: "fake",
      effort: "medium",
      cost_usd_micro: Math.round(over.actual / runs),
      duration_ms: Math.round((over.durationMs ?? 300_000) / runs),
      outcome: "completed",
    });
    if (over.ledger) {
      await w.store.costLedger.record({
        human_id: w.human,
        agent_id: w.agent,
        project_id: w.project,
        session_id: w.session,
        task_id: task.id,
        run_id: run.id,
        kind: "api",
        usd_micro: Math.round(over.actual / runs),
        model: "fake-sonnet",
      });
    }
  }
  return w.store.task.mustGet(task.id);
}

let worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds) await w.store.close();
  worlds = [];
});

describe("estimate model: learning from run rows and the cost ledger", () => {
  it("folds finished tasks, prefers the ledger, sums retries, and refresh never double counts", async () => {
    const w = await world();
    worlds.push(w);
    for (let i = 0; i < 8; i++)
      await finishedTask(w, { estimate: 1_000_000, actual: 2_000_000, ledger: true, runs: 2 });
    // A ledger row that disagrees with the run rows: the ledger wins.
    const t = await finishedTask(w, { estimate: 1_000_000, actual: 2_000_000, ledger: true });
    await w.store.costLedger.record({
      human_id: w.human,
      task_id: t.id,
      kind: "api",
      usd_micro: 500_000,
      model: "fake-sonnet",
    });
    // Open or run-less tasks are not samples.
    await finishedTask(w, { estimate: 1_000_000, actual: 9_000_000, status: "in_progress" });
    await w.store.task.insert({
      project_id: w.project,
      title: "no runs",
      status: "done",
      specialist: "coder",
      est_cost_usd_micro: 1_000_000,
    });

    const m = await EstimateModel.fromStore(w.store, { defaults });
    const stats = m.stats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ specialist: "coder", kind: "tier1", samples: 9 });
    const r = m.estimate({ specialist: "coder", risk_tier: 1, est_cost_usd_micro: 1_000_000 });
    expect(r.basis).toBe("learned");
    expect(r.costRatio).toBeGreaterThan(1.5);
    expect(r.costRatio).toBeLessThan(2);
    const recent = m.recentSamples();
    expect(recent[recent.length - 1]).toMatchObject({ taskId: t.id, actualUsdMicro: 2_500_000 });
    // The cursor is the newest finished task folded, sample or not (the run-less task came last).
    expect(m.storeCursor !== null && m.storeCursor >= t.updated_at).toBe(true);

    expect(await m.refresh(w.store)).toBe(0);
    expect(m.stats()[0]?.samples).toBe(9);
    await finishedTask(w, { estimate: 1_000_000, actual: 1_000_000, durationMs: 100_000 });
    expect(await m.refresh(w.store)).toBe(1);
    expect(m.stats()[0]?.samples).toBe(10);
    expect(await m.refresh(w.store)).toBe(0);
  });

  it("without a task estimate the cold-start figure is the estimate, so defaults get calibrated too", async () => {
    const w = await world();
    worlds.push(w);
    for (let i = 0; i < 6; i++)
      await finishedTask(w, {
        specialist: "researcher",
        riskTier: 2,
        estimate: 0,
        actual: 250_000,
        durationMs: 600_000,
      });
    const m = await EstimateModel.fromStore(w.store, { defaults });
    const r = m.estimate({ specialist: "researcher", risk_tier: 2 });
    // registry cold start: 2 USD * 0.5 = 1 USD; actuals at 0.25 USD pull the ratio well below 1.
    expect(r.basis).toBe("learned");
    expect(r.costRatio).toBeLessThan(0.5);
    expect(r.usdMicro).toBe(Math.round(1_000_000 * r.costRatio));
    expect(r.wallRatio).toBeLessThan(1);
  });

  it("feeds the planner through EstimatePort and cutPlanToBudget", async () => {
    const w = await world();
    worlds.push(w);
    for (let i = 0; i < 20; i++) await finishedTask(w, { estimate: 1_000_000, actual: 3_000_000 });
    const port: EstimatePort = await EstimateModel.fromStore(w.store, { defaults });
    const ready = await finishedTask(w, { estimate: 1_000_000, actual: 0, status: "ready" });
    const learned = planEstimateUsdMicro(port, ready);
    expect(learned).toBeGreaterThan(2_000_000);
    const plan: SessionPlan = {
      items: [
        { taskId: ready.id, title: ready.title, specialist: "coder", estimateUsdMicro: learned },
        { taskId: "t2", title: "t2", specialist: "coder", estimateUsdMicro: learned },
      ],
      estimateUsdMicro: learned * 2,
      summary: "2 tasks",
    };
    const cut = cutPlanToBudget(plan, 4_000_000);
    expect(cut.items).toHaveLength(1);
    expect(cut.summary).toContain("1 item(s) cut");
  });
});

describe("estimate accuracy view", () => {
  it("renders per-key rows, overall error, bias and the within-25% share, validating its schema", () => {
    const m = new EstimateModel({ defaults });
    for (let i = 0; i < 10; i++)
      m.observe(sample({ i, actualUsdMicro: 1_200_000, taskId: `t${i}` }));
    for (let i = 10; i < 14; i++)
      m.observe(sample({ i, specialist: "researcher", kind: "tier2", actualUsdMicro: 2_000_000 }));
    const view = estimateAccuracyView(m, "2026-10-19T06:00:00.000Z", { recentLimit: 5 });
    expect(EstimateAccuracyViewSchema.safeParse(view).success).toBe(true);
    expect(view.overall.samples).toBe(14);
    // 10 samples at +20%, 4 at +100%: mean |err| = (10*20 + 4*100) / 14.
    expect(view.overall.mean_abs_error_pct).toBe(
      Math.round(((10 * 20 + 4 * 100) / 14) * 100) / 100,
    );
    expect(view.overall.bias_pct).toBe(view.overall.mean_abs_error_pct);
    expect(view.overall.within_25_pct_share).toBe(Math.round((10 / 14) * 100) / 100);
    expect(view.rows.map((r) => [r.specialist, r.kind, r.samples])).toEqual([
      ["coder", "tier1", 10],
      ["researcher", "tier2", 4],
    ]);
    expect(view.rows[0]?.mean_abs_error_pct).toBe(20);
    expect(view.rows[0]?.confidence).toBeGreaterThan(view.rows[1]?.confidence ?? 1);
    expect(view.recent).toHaveLength(5);
    expect(view.recent[0]).toMatchObject({ specialist: "researcher", error_pct: 100 });
    const empty = estimateAccuracyView(new EstimateModel(), "2026-10-19T06:00:00.000Z");
    expect(empty.overall).toEqual({
      samples: 0,
      mean_abs_error_pct: 0,
      bias_pct: 0,
      within_25_pct_share: 0,
    });
  });
});
