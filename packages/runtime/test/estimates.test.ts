import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedPlanEstimate,
  DEFAULT_COLD_START_BUDGET_SHARE,
  DEFAULT_COLD_START_TIMEOUT_SHARE,
  DEFAULT_FALLBACK_USD_MICRO,
  DEFAULT_FALLBACK_WALL_MS,
  DEFAULT_FOLD_OVERLAP_MS,
  DEFAULT_STARTING_ESTIMATE_USD_MICRO,
  EstimateModel,
  type EstimateModelSnapshot,
  type EstimatePort,
  type EstimateSample,
  kindOfTask,
  PLAN_ESTIMATE_BOUND,
  planEstimateUsdMicro,
  RATIO_MAX,
  type SpecialistDefaults,
  STARTING_ESTIMATES_USD_MICRO,
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

describe("estimate model: the calibrated starting estimates (cost, L-22)", () => {
  it("a task with no estimate of its own starts at what its kind of work cost on the real model", () => {
    const m = new EstimateModel({ defaults });
    for (const [specialist, usdMicro] of Object.entries(STARTING_ESTIMATES_USD_MICRO)) {
      expect(m.estimate({ specialist, risk_tier: 1 }), specialist).toMatchObject({
        basis: "calibrated",
        usdMicro,
        samples: 0,
      });
    }
    // Ordinary specialist work cost USD 0.01-0.10 a task on 2026-11-01/02 (Sonnet 5.5); a
    // research task, which reads pages, about ten times that.
    for (const s of ["coder", "tester", "writer-marketing", "designer", "reviewer"])
      expect(STARTING_ESTIMATES_USD_MICRO[s], s).toBeLessThanOrEqual(100_000);
    expect(STARTING_ESTIMATES_USD_MICRO.researcher).toBeGreaterThan(300_000);
    // Before, a coder task a person made started at half the registry's cap: USD 1.50, and the
    // Start dialog said a CHF 0.50 session could run nothing.
    expect(m.estimate({ specialist: "coder", risk_tier: 1 }).usdMicro).toBeLessThan(100_000);
    // A specialist the table does not name starts at the typical figure, not at a cap.
    expect(m.estimate({ specialist: "illustrator", risk_tier: 0 })).toMatchObject({
      basis: "calibrated",
      usdMicro: DEFAULT_STARTING_ESTIMATE_USD_MICRO,
    });
  });

  it("the plan model's guess is kept within the calibrated band of its kind", () => {
    const coder = STARTING_ESTIMATES_USD_MICRO.coder as number;
    // The live plans guessed USD 0.15 for a quote page that cost about USD 0.01-0.03.
    expect(boundedPlanEstimate(150_000, "coder")).toBe(Math.round(coder * PLAN_ESTIMATE_BOUND));
    expect(boundedPlanEstimate(1, "coder")).toBe(Math.round(coder / PLAN_ESTIMATE_BOUND));
    expect(boundedPlanEstimate(coder, "coder")).toBe(coder);
    // No guess: the calibrated figure itself; a research guess stays within research's band.
    expect(boundedPlanEstimate(0, "tester")).toBe(STARTING_ESTIMATES_USD_MICRO.tester);
    expect(boundedPlanEstimate(1_200_000, "researcher")).toBe(
      Math.round((STARTING_ESTIMATES_USD_MICRO.researcher as number) * PLAN_ESTIMATE_BOUND),
    );
    expect(boundedPlanEstimate(150_000, null)).toBe(Math.round(coder * PLAN_ESTIMATE_BOUND));
  });

  it("converges on a ten-times over-estimate: within x2 after 3 tasks of the kind, within x1.25 after 10", () => {
    const m = new EstimateModel({ defaults });
    const query = { specialist: "coder", risk_tier: 1, est_cost_usd_micro: 1_000_000 };
    const off = () => m.estimate(query).usdMicro / 100_000;
    for (let i = 0; i < 3; i++) m.observe(sample({ i, actualUsdMicro: 100_000 }));
    expect(off()).toBeLessThanOrEqual(2);
    for (let i = 3; i < 10; i++) m.observe(sample({ i, actualUsdMicro: 100_000 }));
    expect(off()).toBeLessThanOrEqual(1.25);
    // And the other way: a five-times under-estimate is caught as fast.
    const low = new EstimateModel({ defaults });
    for (let i = 0; i < 3; i++) low.observe(sample({ i, actualUsdMicro: 5_000_000 }));
    expect(5_000_000 / low.estimate(query).usdMicro).toBeLessThanOrEqual(2);
  });
});

describe("estimate model: cold start and bases", () => {
  it("cold start uses the registry defaults scaled by the documented share, else the fallback", () => {
    // Without the calibrated table (a caller that passes none): the registry path.
    const m = new EstimateModel({ defaults, startingEstimates: null });
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

  it("snapshots round-trip; an older snapshot version is refused", () => {
    const m = new EstimateModel({ defaults });
    for (let i = 0; i < 7; i++) m.observe(sample({ i }));
    const snap = m.toJSON();
    expect(snap.version).toBe(2);
    const copy = EstimateModel.fromJSON(JSON.parse(JSON.stringify(snap)), { defaults });
    expect(copy.estimate({ specialist: "coder", risk_tier: 1 })).toEqual(
      m.estimate({ specialist: "coder", risk_tier: 1 }),
    );
    expect(copy.recentSamples()).toHaveLength(7);
    const stale = { ...snap, version: 1, folded: ["t1"] } as unknown as EstimateModelSnapshot;
    expect(() => EstimateModel.fromJSON(stale, { defaults })).toThrow(ForerunnerError);
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
    /** The model the runs name (a fast-mode variant for an urgent run, ADR 0057). */
    model?: string;
    /** Each work run's outcome (default "completed"); "paused" as budget-stop writes it. */
    outcomes?: string[];
    /** A review by the critic of this cost (its own Run row and ledger row). */
    reviewUsdMicro?: number;
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
      model: over.model ?? "fake-sonnet",
      provider: "fake",
      effort: "medium",
      cost_usd_micro: Math.round(over.actual / runs),
      duration_ms: Math.round((over.durationMs ?? 300_000) / runs),
      outcome: over.outcomes?.[i] ?? "completed",
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
  if (over.reviewUsdMicro) {
    const review = await w.store.run.insert({
      task_id: task.id,
      session_id: w.session,
      specialist: "critic",
      model: "fake-sonnet",
      provider: "fake",
      effort: "medium",
      cost_usd_micro: over.reviewUsdMicro,
      duration_ms: 60_000,
      outcome: "completed",
    });
    if (over.ledger) {
      await w.store.costLedger.record({
        human_id: w.human,
        agent_id: w.agent,
        project_id: w.project,
        session_id: w.session,
        task_id: task.id,
        run_id: review.id,
        kind: "api",
        usd_micro: over.reviewUsdMicro,
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

  it("a task with a fast-mode run is not a sample: urgent work's surcharge never inflates the standard estimate (D.20)", async () => {
    const w = await world();
    worlds.push(w);
    for (let i = 0; i < 6; i++)
      await finishedTask(w, { estimate: 1_000_000, actual: 1_000_000, ledger: true });
    // Urgent work in a fast-mode project: the same tasks at twice the cost (ADR 0057).
    for (let i = 0; i < 4; i++)
      await finishedTask(w, {
        estimate: 1_000_000,
        actual: 2_000_000,
        ledger: true,
        model: "claude-opus-5-5-fast",
      });
    const m = await EstimateModel.fromStore(w.store, { defaults });
    expect(m.stats()[0]).toMatchObject({ specialist: "coder", kind: "tier1", samples: 6 });
    const r = m.estimate({ specialist: "coder", risk_tier: 1, est_cost_usd_micro: 1_000_000 });
    expect(r.costRatio).toBeCloseTo(1, 5);
    // Folded once and skipped: a refresh neither counts nor re-reads them.
    expect(await m.refresh(w.store)).toBe(0);
    await finishedTask(w, { estimate: 1_000_000, actual: 2_000_000, model: "fake-opus-fast" });
    expect(await m.refresh(w.store)).toBe(0);
    expect(m.stats()[0]?.samples).toBe(6);
  });

  it("without a task estimate the cold-start figure is the estimate, so defaults get calibrated too", async () => {
    const w = await world();
    worlds.push(w);
    for (let i = 0; i < 6; i++)
      await finishedTask(w, {
        specialist: "researcher",
        riskTier: 2,
        estimate: 0,
        actual: 100_000,
        durationMs: 600_000,
      });
    const m = await EstimateModel.fromStore(w.store, { defaults });
    const r = m.estimate({ specialist: "researcher", risk_tier: 2 });
    // The calibrated start (USD 0.50 for research); actuals at USD 0.10 pull the ratio well
    // below 1.
    const start = STARTING_ESTIMATES_USD_MICRO.researcher as number;
    expect(r.basis).toBe("learned");
    expect(r.costRatio).toBeLessThan(0.5);
    expect(r.usdMicro).toBe(Math.round(start * r.costRatio));
    expect(r.wallRatio).toBeLessThan(1);
  });

  it("a task with a run stopped at a budget is no sample, and its reviews are no part of its work's cost (cost)", async () => {
    const w = await world();
    worlds.push(w);
    for (let i = 0; i < 3; i++)
      await finishedTask(w, { estimate: 100_000, actual: 200_000, ledger: true });
    // Paused at its budget (the Run row budget-stop writes), continued, then done: what it spent
    // is a lower bound of what the work costs, never a full sample.
    const paused = await finishedTask(w, {
      estimate: 100_000,
      actual: 900_000,
      runs: 2,
      outcomes: ["paused", "completed"],
      ledger: true,
    });
    // Stopped at the hard line and cancelled afterwards.
    const stopped = await finishedTask(w, {
      estimate: 100_000,
      actual: 900_000,
      outcomes: ["budget_exceeded"],
      status: "cancelled",
      ledger: true,
    });
    // Reviewed twice by the critic for USD 0.50: the work cost USD 0.20, as its budget saw it.
    const reviewed = await finishedTask(w, {
      estimate: 100_000,
      actual: 200_000,
      ledger: true,
      reviewUsdMicro: 500_000,
    });
    // And without ledger rows (a subscription's runs): the work runs only, too.
    const unbooked = await finishedTask(w, {
      estimate: 100_000,
      actual: 200_000,
      reviewUsdMicro: 500_000,
    });
    const m = await EstimateModel.fromStore(w.store, { defaults });
    const sampled = m.recentSamples().map((s) => s.taskId);
    expect(sampled).not.toContain(paused.id);
    expect(sampled).not.toContain(stopped.id);
    expect(m.stats()[0]?.samples).toBe(5);
    const of = (id: string) => m.recentSamples().find((s) => s.taskId === id)?.actualUsdMicro;
    expect(of(reviewed.id)).toBe(200_000);
    expect(of(unbooked.id)).toBe(200_000);
    // Every sample says twice the estimate: the learned ratio is 2, not pulled up by the stops
    // or the reviews.
    expect(m.estimate({ specialist: "coder", risk_tier: 1 }).costRatio).toBeCloseTo(
      2 ** (5 / 6),
      3,
    );
    // Folded once and skipped: a refresh neither counts them nor reads them again.
    expect(await m.refresh(w.store)).toBe(0);
  });

  it("feeds the planner through EstimatePort and cutPlanToBudget", async () => {
    const w = await world();
    worlds.push(w);
    for (let i = 0; i < 20; i++) await finishedTask(w, { estimate: 1_000_000, actual: 3_000_000 });
    const port: EstimatePort = await EstimateModel.fromStore(w.store, { defaults });
    const capped = await finishedTask(w, { estimate: 1_000_000, actual: 0, status: "ready" });
    // A task's own budget (USD 2 here) caps its runs (U-042), so it is never planned above it
    // (live walk 2, phase C: the Start dialog counted CHF 1.00 for a task with CHF 0.80).
    expect(planEstimateUsdMicro(port, capped)).toBe(2_000_000);
    // Without a budget of its own, the learned figure is what the planner gets.
    const ready = await w.store.task.patch(capped.id, { budget_usd_micro: 0 });
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

describe("estimate model: bounded incremental refresh and live learning", () => {
  it("a refresh reads only the overlap window behind the cursor, and the folded set stays bounded", async () => {
    const w = await world();
    worlds.push(w);
    // Forty tasks a minute apart; the default window covers the last few of them only.
    for (let i = 0; i < 40; i++)
      await finishedTask(w, { estimate: 1_000_000, actual: 1_200_000, ledger: true });
    const windowTasks = Math.floor(DEFAULT_FOLD_OVERLAP_MS / 60_000) + 1;
    const m = await EstimateModel.fromStore(w.store, { defaults });
    expect(m.stats()[0]?.samples).toBe(40);
    expect(m.toJSON().folded.length).toBeLessThanOrEqual(windowTasks);
    expect(m.toJSON().folded.length).toBeGreaterThan(0);

    await finishedTask(w, { estimate: 1_000_000, actual: 1_200_000, ledger: true });
    const rows = vi.spyOn(w.store.task, "rows");
    const breakdown = vi.spyOn(w.store.costLedger, "breakdown");
    expect(await m.refresh(w.store)).toBe(1);
    expect(m.stats()[0]?.samples).toBe(41);
    // The store filtered: the query returned the window plus the new task, not all 41 rows.
    const read = (await rows.mock.results[0]?.value) as TaskRow[];
    expect(read.length).toBeLessThanOrEqual(windowTasks + 1);
    expect(read.length).toBeGreaterThanOrEqual(1);
    expect(rows.mock.calls[0]?.[0]).toContain('"updated_at" >= ?');
    // The ledger breakdown is bounded too: rows older than the fresh tasks are not read.
    expect(breakdown.mock.calls[0]?.[1]?.from).toBeTypeOf("string");
    expect(m.toJSON().folded.length).toBeLessThanOrEqual(windowTasks + 1);
    expect(await m.refresh(w.store)).toBe(0);
    rows.mockRestore();
    breakdown.mockRestore();
  });

  it("live learning through observeTask matches the fold on restart; observing against the plan's corrected figure would not", async () => {
    const w = await world();
    worlds.push(w);
    const tasks: TaskRow[] = [];
    for (let i = 0; i < 40; i++)
      tasks.push(
        await finishedTask(w, { estimate: 1_000_000, actual: 2_000_000, durationMs: 600_000 }),
      );
    const restarted = await EstimateModel.fromStore(w.store, { defaults });
    const live = new EstimateModel({ defaults });
    for (const t of tasks)
      expect(live.observeTask(t, { usdMicro: 2_000_000, wallMs: 600_000, at: t.updated_at })).toBe(
        true,
      );
    expect(live.stats()).toEqual(restarted.stats());
    const query = { specialist: "coder", risk_tier: 1, est_cost_usd_micro: 1_000_000 };
    expect(live.estimate(query)).toEqual(restarted.estimate(query));
    expect(live.recentSamples()).toEqual(restarted.recentSamples());
    const truth = restarted.estimate(query).costRatio;
    expect(truth).toBeGreaterThan(1.8);

    // Feeding the planner's already-corrected figure back as the estimate measures the residual
    // after correction, so the ratio settles near the square root of the real overrun.
    const looped = new EstimateModel({ defaults });
    for (const t of tasks) {
      looped.observe({
        specialist: "coder",
        kind: "tier1",
        estimateUsdMicro: planEstimateUsdMicro(looped, t),
        actualUsdMicro: 2_000_000,
        estimateWallMs: 600_000,
        actualWallMs: 600_000,
        at: t.updated_at,
      });
    }
    expect(looped.estimate(query).costRatio).toBeLessThan(truth - 0.3);
  });

  // Review of 'cost': the live feed skipped only a call that itself paused, so a task raised or
  // continued after a budget stop was learned from until the next restart, whose fold left it
  // out. The live feed now reads the task's Run rows and leaves out what the fold leaves out.
  it("the live feed leaves out every task the fold leaves out: a budget stop before a raise, a fast-mode run, no finished work run (cost)", async () => {
    const w = await world();
    worlds.push(w);
    const plain = await finishedTask(w, { estimate: 100_000, actual: 200_000, ledger: true });
    // Stopped at its budget (hard or graceful), raised or continued, then done.
    const raised = await finishedTask(w, {
      estimate: 100_000,
      actual: 300_000,
      runs: 2,
      outcomes: ["budget_exceeded", "completed"],
      ledger: true,
    });
    const continued = await finishedTask(w, {
      estimate: 100_000,
      actual: 300_000,
      runs: 2,
      outcomes: ["paused", "completed"],
      ledger: true,
    });
    const fast = await finishedTask(w, {
      estimate: 100_000,
      actual: 400_000,
      model: "fake-opus-fast",
      ledger: true,
    });
    // A call that met a resting credential ran nothing: the task has no finished work run yet.
    const waited = await finishedTask(w, {
      estimate: 100_000,
      actual: 0,
      runs: 1,
      outcomes: ["running"],
      status: "ready",
    });
    // A run that ended before its first model call (a refused sandbox lease, a provider error on
    // the first request) spent nothing, and the person cancelled the task: a cost of 0 says
    // nothing about what the work costs (it read as a tenth of the estimate, the clamp).
    const spentNothing = await finishedTask(w, {
      estimate: 100_000,
      actual: 0,
      outcomes: ["error"],
      status: "cancelled",
      ledger: true,
    });
    // Reviewed for USD 0.50 and booked: the work's cost is what the task's budget saw.
    const reviewed = await finishedTask(w, {
      estimate: 100_000,
      actual: 300_000,
      ledger: true,
      reviewUsdMicro: 500_000,
      durationMs: 420_000,
    });
    // The critic accepts it two minutes after its run ended: the task row moves on, the run not.
    await w.clock.advance(120_000);
    await w.store.task.patch(reviewed.id, { reason: "Reviewed" });
    const live = new EstimateModel({ defaults });
    // The hook's moment is later still; a sample's time is when its work ended, in both feeds.
    await w.clock.advance(60_000);
    const feed = (t: TaskRow, outcome = "done") =>
      live.observeTaskRuns(w.store, t, w.clock.nowIso(), outcome);
    expect(await feed(plain)).toBe(true);
    // The finishing call of a raised or continued task: it did the rest of the work only.
    expect(await feed(raised)).toBe(false);
    expect(await feed(continued)).toBe(false);
    expect(await feed(fast)).toBe(false);
    expect(await feed(waited, "usage_limit")).toBe(false);
    // A call that itself stopped at a budget, before its Run row says so.
    const fresh = await finishedTask(w, { estimate: 100_000, actual: 50_000, status: "ready" });
    expect(await feed(fresh, "paused")).toBe(false);
    expect(await feed(fresh, "budget_exceeded")).toBe(false);
    // A retry a credential stopped before it spent anything: the try before it finished, but
    // this call is no measure of the task's cost (a sample of 0 would read as a tenth).
    expect(await feed(fresh, "usage_limit")).toBe(false);
    expect(await feed(spentNothing, "failed")).toBe(false);
    expect(await feed(reviewed)).toBe(true);
    expect(live.recentSamples().map((s) => s.taskId)).toEqual([plain.id, reviewed.id]);
    // The sample is the fold's, figure for figure: the work's cost (the ledger less the review)
    // and its runs' wall time, so a restart changes nothing the Performance screen shows.
    expect(live.recentSamples().find((s) => s.taskId === reviewed.id)).toMatchObject({
      actualUsdMicro: 300_000,
      actualWallMs: 420_000,
    });
    const restarted = await EstimateModel.fromStore(w.store, { defaults });
    expect(live.recentSamples()).toEqual(restarted.recentSamples());
    expect(live.stats()).toEqual(restarted.stats());
  });

  it("a task observed live is not folded again by a refresh inside the overlap window", async () => {
    const w = await world();
    worlds.push(w);
    for (let i = 0; i < 5; i++) await finishedTask(w, { estimate: 1_000_000, actual: 1_500_000 });
    const m = await EstimateModel.fromStore(w.store, { defaults });
    expect(m.stats()[0]?.samples).toBe(5);
    const t = await finishedTask(w, { estimate: 1_000_000, actual: 1_500_000 });
    expect(m.observeTask(t, { usdMicro: 1_500_000, wallMs: 300_000, at: w.clock.nowIso() })).toBe(
      true,
    );
    expect(m.stats()[0]?.samples).toBe(6);
    expect(await m.refresh(w.store)).toBe(0);
    expect(m.stats()[0]?.samples).toBe(6);
    // The sample derivation is the same one the fold uses.
    expect(m.sampleForTask(t, { usdMicro: 1, wallMs: 1, at: t.updated_at })).toMatchObject({
      specialist: "coder",
      kind: "tier1",
      estimateUsdMicro: 1_000_000,
      estimateWallMs: Math.round(45 * 60_000 * DEFAULT_COLD_START_TIMEOUT_SHARE),
      taskId: t.id,
    });
  });
});

describe("estimate accuracy view", () => {
  it("the overall error agrees with the rows: their sample-weighted mean, never beyond them (U-077)", () => {
    const m = new EstimateModel({ defaults });
    // Steady runs, then one far over its estimate: the row's error is its smoothed figure, and
    // a 40x overrun is clamped there; the overall said several hundred percent beside it.
    for (let i = 0; i < 6; i++) m.observe(sample({ i, actualUsdMicro: 1_000_000 }));
    m.observe(sample({ i: 6, actualUsdMicro: 40_000_000 }));
    for (let i = 7; i < 10; i++)
      m.observe(sample({ i, specialist: "researcher", kind: "tier2", actualUsdMicro: 1_100_000 }));
    const view = estimateAccuracyView(m, "2026-10-19T06:00:00.000Z");
    const rows = view.rows;
    expect(view.overall.samples).toBe(rows.reduce((a, r) => a + r.samples, 0));
    const weighted =
      rows.reduce((a, r) => a + r.mean_abs_error_pct * r.samples, 0) /
      rows.reduce((a, r) => a + r.samples, 0);
    expect(view.overall.mean_abs_error_pct).toBeCloseTo(weighted, 1);
    const errors = rows.map((r) => r.mean_abs_error_pct);
    expect(view.overall.mean_abs_error_pct).toBeLessThanOrEqual(Math.max(...errors));
    expect(view.overall.mean_abs_error_pct).toBeGreaterThanOrEqual(Math.min(...errors));
  });

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
    expect(EstimateAccuracyViewSchema.safeParse(empty).success).toBe(true);
    expect(empty.overall).toEqual({
      samples: 0,
      mean_abs_error_pct: 0,
      bias_pct: 0,
      within_25_pct_share: 0,
    });
  });
});
