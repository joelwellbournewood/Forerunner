/**
 * Estimate-versus-actual learning for the planner (spec I: "estimate before every run; actual
 * recorded after; estimate error tracked per specialist and task type"; build order phase 7:
 * "estimate-vs-actual learning feeding the planner").
 *
 * The model learns, per (specialist, task kind), the ratio of actual to estimated cost and
 * wall time as an exponentially weighted mean in log space, with a sample count and a
 * confidence that grows with samples and shrinks with dispersion. Cold start uses the registry
 * defaults of the specialist (max_budget_usd, timeout_minutes) scaled by a documented share.
 * ADR 0019 records the constants.
 *
 * Persistence: the samples are the finished `task` rows with their `run` rows and the
 * `cost_ledger`; the model is a deterministic fold over them, rebuilt with fromStore() at start
 * and extended with refresh() or, live, with observeTaskRuns() from the runner's task.finished
 * hook. Both feeds derive the sample the same way (sampleForTask) and leave out the same tasks,
 * read from their Run rows (tallyRun, isNoSample), so the state after a restart agrees with the
 * state learned live. There is no separate table: a rebuild from the store always
 * reproduces the same state, and toJSON()/fromJSON() exist for callers that want to cache it.
 *
 * The fold is incremental and bounded: a cursor (the newest finish time seen) plus an overlap
 * window. refresh() asks the store only for finished tasks updated at or after
 * `cursor - foldOverlapMs` and remembers the ids inside that window, so a task is never counted
 * twice however often refresh() runs, and neither the query nor the memory grows with the
 * install's history (ADR 0019, amendment).
 */
import { isFastModeVariant } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { RunRow, StateStore, TaskRow, TaskStatus } from "@forerunner/state";

export interface EstimateInput {
  specialist: string | null;
  risk_tier: number;
  /** The planner's or the task author's estimate; 0 or absent means none. */
  est_cost_usd_micro?: number;
  budget_usd_micro?: number;
  /** Explicit kind label; defaults to the risk tier (see kindOf). */
  kind?: string;
}

export type EstimateBasis =
  | "learned"
  | "task_estimate"
  | "calibrated"
  | "registry_default"
  | "fallback";

export interface EstimateResult {
  usdMicro: number;
  wallMs: number;
  /** 0 (no data) to 1 (many consistent samples). */
  confidence: number;
  basis: EstimateBasis;
  samples: number;
  specialist: string;
  kind: string;
  /** Multipliers applied to the base figures (1 without data). */
  costRatio: number;
  wallRatio: number;
}

/** What the planner consumes; the orchestrator wires it into StaticPlanner and cutPlanToBudget. */
export interface EstimatePort {
  estimate(task: EstimateInput): EstimateResult;
}

/** Registry frontmatter the cold start uses (SpecialistDef.max_budget_usd, timeout_minutes). */
export interface SpecialistDefaults {
  maxBudgetUsd: number;
  timeoutMinutes: number;
}

export interface EstimateSample {
  specialist: string;
  kind: string;
  estimateUsdMicro: number;
  actualUsdMicro: number;
  estimateWallMs: number;
  actualWallMs: number;
  /** ISO timestamp of the observation. */
  at: string;
  taskId?: string;
}

export interface EstimateKeyStats {
  specialist: string;
  kind: string;
  samples: number;
  costRatio: number;
  wallRatio: number;
  /** Exponentially weighted mean of |actual / estimate - 1| in percent. */
  meanAbsErrorPct: number;
  confidence: number;
  lastSampleAt: string | null;
}

export interface EstimateModelOptions {
  /** Weight of the newest sample in the exponentially weighted means. Default 0.3. */
  alpha?: number;
  /** Pseudo-count that holds the ratio near 1 and the confidence near 0 with few samples. Default 1. */
  shrinkage?: number;
  /**
   * What one task of a specialist's kind costs to start with, in micro-USD ('cost', L-22): the
   * calibrated table by default (`STARTING_ESTIMATES_USD_MICRO`), with
   * `DEFAULT_STARTING_ESTIMATE_USD_MICRO` for a specialist it does not name. `null`: the older
   * cold start, a share of the registry's per-run cap, else the fallback.
   */
  startingEstimates?: Readonly<Record<string, number>> | null;
  /** Registry lookup for cold-start defaults; undefined when the specialist is unknown. */
  defaults?: (specialist: string) => SpecialistDefaults | undefined;
  /** Used when neither the task nor the registry gives a figure. Default 0.5 USD, 20 minutes. */
  fallbackUsdMicro?: number;
  fallbackWallMs?: number;
  /** Share of the specialist's max budget a cold-start estimate assumes. Default 0.5. */
  coldStartBudgetShare?: number;
  /** Share of the specialist's timeout a cold-start estimate assumes. Default 0.5. */
  coldStartTimeoutShare?: number;
  /** Task kind label. Default: `tier<risk_tier>` (size and risk travel together in the spec). */
  kindOf?: (task: EstimateInput) => string;
  /** Specialist used when a task names none. Default "coder" (what StaticPlanner assumes). */
  defaultSpecialist?: string;
  /** Recent samples kept for the accuracy view. Default 200. */
  recentLimit?: number;
  /**
   * Overlap window behind the cursor that refresh() re-reads and whose task ids it remembers
   * (clock skew between writers of a shared store, and a task row finished in the store a
   * little after its live observation). Default 15 minutes.
   */
  foldOverlapMs?: number;
}

export const DEFAULT_ALPHA = 0.3;
/**
 * One pseudo-sample ('cost', L-22: it was 5, and with the multiplier clamped to x0.25 a ten-times
 * over-estimate was never corrected below x2.5). With 1 a consistent error is within x2 after 3
 * tasks of the kind and within x1.25 after 10.
 */
export const DEFAULT_SHRINKAGE = 1;

/**
 * What one task's work costs, per specialist, in micro-USD: the starting estimate of a task
 * with no estimate of its own, the band a plan's guess is kept in (`boundedPlanEstimate`) and
 * the figure the learner corrects ('cost', L-22). Calibrated on the real model's runs of
 * 2026-11-01 and 2026-11-02 (Sonnet 5.5 for every specialist; live walks 3 and 4 and the
 * phase C checks: coder runs USD 0.014 to 0.090, median about 0.03; tester 0.03 to 0.10;
 * writer, designer, data analyst, migration, reviewer and ops about 0.03 to 0.06 of work; one
 * research task USD 1.13 of work before the conversation was cached, about half that with the
 * cache). It is the work's cost (what the task's budget caps); the critic's review is paid from
 * the session's review reserve. The model watch re-checks it with the prices.
 */
export const STARTING_ESTIMATES_USD_MICRO: Readonly<Record<string, number>> = Object.freeze({
  coder: 40_000,
  tester: 60_000,
  reviewer: 30_000,
  "writer-marketing": 40_000,
  designer: 60_000,
  "data-analyst": 50_000,
  "migration-specialist": 40_000,
  "ops-deploy": 40_000,
  researcher: 500_000,
  "science-evaluator": 300_000,
});
/** The starting estimate of a specialist the table does not name: a typical task's work. */
export const DEFAULT_STARTING_ESTIMATE_USD_MICRO = 60_000;
/**
 * A plan's guessed estimate is kept within this factor of its kind's starting estimate
 * (`boundedPlanEstimate`): the planning model guessed USD 0.15 for a page that cost USD 0.01 to
 * 0.03 (L-22), while its guess still tells a larger task from a smaller one.
 */
export const PLAN_ESTIMATE_BOUND = 1.5;

/** The calibrated starting estimate of one task of `specialist`'s kind (coder when none). */
export function startingEstimateUsdMicro(
  specialist: string | null | undefined,
  table: Readonly<Record<string, number>> = STARTING_ESTIMATES_USD_MICRO,
): number {
  const own = table[specialist ?? "coder"];
  return typeof own === "number" && own > 0 ? own : DEFAULT_STARTING_ESTIMATE_USD_MICRO;
}

/**
 * The plan model's guess for one task, kept within `PLAN_ESTIMATE_BOUND` of its kind's starting
 * estimate (the intake stores this as the task's estimate, the plan card shows it); no guess,
 * the starting estimate. The learner corrects it from there.
 */
export function boundedPlanEstimate(
  guessUsdMicro: number,
  specialist: string | null | undefined,
): number {
  const base = startingEstimateUsdMicro(specialist);
  if (!(guessUsdMicro > 0)) return base;
  return clamp(
    Math.round(guessUsdMicro),
    Math.round(base / PLAN_ESTIMATE_BOUND),
    Math.round(base * PLAN_ESTIMATE_BOUND),
  );
}
export const DEFAULT_COLD_START_BUDGET_SHARE = 0.5;
export const DEFAULT_COLD_START_TIMEOUT_SHARE = 0.5;
export const DEFAULT_FALLBACK_USD_MICRO = 500_000;
export const DEFAULT_FALLBACK_WALL_MS = 20 * 60_000;
export const DEFAULT_FOLD_OVERLAP_MS = 15 * 60_000;
/** Task statuses the fold treats as finished. */
export const FINISHED_TASK_STATUSES: readonly TaskStatus[] = ["done", "failed", "cancelled"];
/**
 * Run outcomes that make a task no sample of what its work costs ('cost', ADR 0112): a run that
 * paused at a budget (gracefully, `paused`, or at the hard stop, `budget_exceeded`) stopped short
 * of the work, so what the task spent is a lower bound, not its cost.
 */
export const BUDGET_STOP_RUN_OUTCOMES: readonly string[] = ["paused", "budget_exceeded"];
/**
 * Executor call outcomes the live feed takes no sample from (`observeTaskRuns`): a budget stop,
 * and a call a credential stopped or kept from starting (`usage_limit`, U-078: the task runs
 * again, and what this call spent is no part of a finished task's cost on its own).
 */
export const NO_SAMPLE_CALL_OUTCOMES: readonly string[] = [
  ...BUDGET_STOP_RUN_OUTCOMES,
  "usage_limit",
];
/** The specialist name a review's Run row carries: its cost is no part of the work's. */
const CRITIC_RUN_SPECIALIST = "critic";
/** Ids per IN (...) clause when the fold lists runs (SQLite's parameter limit is far above this). */
const RUN_LIST_CHUNK = 500;
/** Per-sample ratio clamp: one runaway or aborted run cannot dominate. */
export const SAMPLE_RATIO_MIN = 0.1;
export const SAMPLE_RATIO_MAX = 10;
/**
 * Clamp on the multiplier the planner sees: as wide as one sample's ('cost', L-22: it was x0.25
 * to x4, so a ten-times over-estimate stayed two and a half times too high for good).
 */
export const RATIO_MIN = 0.1;
export const RATIO_MAX = 10;

export function kindOfTask(task: Pick<EstimateInput, "risk_tier" | "kind">): string {
  if (task.kind) return task.kind;
  const tier = Number.isInteger(task.risk_tier) ? Math.min(3, Math.max(0, task.risk_tier)) : 0;
  return `tier${tier}`;
}

interface KeyState {
  specialist: string;
  kind: string;
  n: number;
  /** Exponentially weighted mean of ln(actual / estimate) for cost. */
  costLog: number;
  wallLog: number;
  /** Exponentially weighted mean of |actual / estimate - 1| for cost. */
  absErr: number;
  /** Exponentially weighted mean of |ln ratio - prediction| (dispersion around the learned ratio). */
  resid: number;
  lastAt: string | null;
}

export interface EstimateModelSnapshot {
  version: 2;
  keys: KeyState[];
  recent: EstimateSample[];
  /** Newest finish time seen, from the store or live. */
  cursor: string | null;
  /** Task ids finished inside the overlap window behind the cursor, with their finish time. */
  folded: { id: string; at: string }[];
}

/** The actual figures of a finished task, as the runner's task.finished hook knows them. */
export interface TaskActuals {
  usdMicro: number;
  wallMs: number;
  /** When the task finished (ISO); the sample time and the fold's bookkeeping key. */
  at: string;
}

/** The task columns a sample needs; a TaskRow satisfies it. */
export type EstimateTaskInput = Pick<
  TaskRow,
  "id" | "specialist" | "risk_tier" | "est_cost_usd_micro" | "budget_usd_micro"
>;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** `iso` minus `ms`, as ISO; an unparsable timestamp comes back unchanged. */
function isoMinus(iso: string, ms: number): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(Math.max(0, t - ms)).toISOString() : iso;
}

/** The Run row columns the sample rule reads. */
export type SampleRunInput = Pick<
  RunRow,
  "specialist" | "model" | "outcome" | "cost_usd_micro" | "duration_ms" | "updated_at"
>;

/**
 * What a task's Run rows say about it as a sample. Both feeds build it with `tallyRun` and ask
 * `isNoSample`, so the live learner and the fold after a restart leave out the same tasks.
 */
export interface RunTally {
  /** The work runs' cost (the critic's reviews left out). */
  cost: number;
  /** The critic's reviews' cost: paid from the session's review reserve, not the task's budget. */
  reviews: number;
  wall: number;
  /** Finished work runs. */
  finished: number;
  /** A work run on a fast-mode variant (ADR 0057): the surcharge is no part of the work's cost. */
  fast: boolean;
  /** A work run that stopped at a budget (`BUDGET_STOP_RUN_OUTCOMES`, ADR 0112). */
  budgetStop: boolean;
  /**
   * When the last finished work run ended (its row's last update, written at its end), "" with
   * none: the sample's time in both feeds, so a restart does not move it.
   */
  endedAt: string;
}

export function emptyRunTally(): RunTally {
  return {
    cost: 0,
    reviews: 0,
    wall: 0,
    finished: 0,
    fast: false,
    budgetStop: false,
    endedAt: "",
  };
}

/** Add one Run row to a task's tally; a run still running (or never started) is left out. */
export function tallyRun(acc: RunTally, r: SampleRunInput): RunTally {
  if (r.outcome === "running" || r.outcome === "") return acc;
  // A review is paid from the session's review reserve, not the task's budget.
  if (r.specialist === CRITIC_RUN_SPECIALIST) {
    acc.reviews += r.cost_usd_micro;
    return acc;
  }
  // A fast-mode run (its Run row names the `<id>-fast` variant, spec D.20, ADR 0057) costs the
  // fast-mode surcharge: the task is no sample of what the work costs.
  if (isFastModeVariant(r.model)) acc.fast = true;
  if (BUDGET_STOP_RUN_OUTCOMES.includes(r.outcome)) acc.budgetStop = true;
  acc.cost += r.cost_usd_micro;
  acc.wall += r.duration_ms ?? 0;
  acc.finished += 1;
  if (r.updated_at > acc.endedAt) acc.endedAt = r.updated_at;
  return acc;
}

/**
 * Whether a task is no sample of what its work costs: no finished work run, a fast-mode run, or
 * a run that stopped at a budget, however the task went on afterwards (raised, continued, done
 * or cancelled: what it spent is a lower bound, 'cost', ADR 0112).
 */
export function isNoSample(t: RunTally): boolean {
  return t.finished === 0 || t.fast || t.budgetStop;
}

/**
 * What a task's work cost: the cost ledger's rows for the task (the truth for caps) less its
 * reviews, or, without ledger rows (a subscription's runs), its work runs' cost.
 */
export function workCostOf(t: RunTally, bookedUsdMicro: number | undefined): number {
  return bookedUsdMicro === undefined ? t.cost : Math.max(0, bookedUsdMicro - t.reviews);
}

export class EstimateModel implements EstimatePort {
  private readonly keys = new Map<string, KeyState>();
  private recent: EstimateSample[] = [];
  private cursor: string | null = null;
  /** Task id -> finish time, kept for the overlap window behind the cursor only. */
  private readonly folded = new Map<string, string>();
  private readonly foldOverlapMs: number;
  private readonly alpha: number;
  private readonly shrinkage: number;
  private readonly opts: Required<
    Pick<
      EstimateModelOptions,
      | "fallbackUsdMicro"
      | "fallbackWallMs"
      | "coldStartBudgetShare"
      | "coldStartTimeoutShare"
      | "defaultSpecialist"
      | "recentLimit"
    >
  > &
    Pick<EstimateModelOptions, "defaults" | "kindOf">;
  private readonly startingEstimates: Readonly<Record<string, number>> | null;

  constructor(options: EstimateModelOptions = {}) {
    this.alpha = options.alpha ?? DEFAULT_ALPHA;
    this.shrinkage = options.shrinkage ?? DEFAULT_SHRINKAGE;
    if (!(this.alpha > 0 && this.alpha <= 1)) {
      throw new ForerunnerError("validation", "estimate model alpha must be in (0, 1]");
    }
    if (!(this.shrinkage >= 0)) {
      throw new ForerunnerError("validation", "estimate model shrinkage must be >= 0");
    }
    this.foldOverlapMs = options.foldOverlapMs ?? DEFAULT_FOLD_OVERLAP_MS;
    if (!(this.foldOverlapMs >= 0)) {
      throw new ForerunnerError("validation", "estimate model foldOverlapMs must be >= 0");
    }
    this.opts = {
      fallbackUsdMicro: options.fallbackUsdMicro ?? DEFAULT_FALLBACK_USD_MICRO,
      fallbackWallMs: options.fallbackWallMs ?? DEFAULT_FALLBACK_WALL_MS,
      coldStartBudgetShare: options.coldStartBudgetShare ?? DEFAULT_COLD_START_BUDGET_SHARE,
      coldStartTimeoutShare: options.coldStartTimeoutShare ?? DEFAULT_COLD_START_TIMEOUT_SHARE,
      defaultSpecialist: options.defaultSpecialist ?? "coder",
      recentLimit: options.recentLimit ?? 200,
      defaults: options.defaults,
      kindOf: options.kindOf,
    };
    this.startingEstimates =
      options.startingEstimates === undefined
        ? STARTING_ESTIMATES_USD_MICRO
        : options.startingEstimates;
  }

  private keyOf(specialist: string, kind: string): string {
    return `${specialist}\u0000${kind}`;
  }

  /**
   * Cold-start figures for a specialist: the cost from the calibrated table ('cost', L-22), the
   * wall time from the registry's timeout scaled; without the table, the registry's per-run cap
   * scaled too, else the fallback.
   */
  coldStart(specialist: string): {
    usdMicro: number;
    wallMs: number;
    fromRegistry: boolean;
    calibrated: boolean;
  } {
    const d = this.opts.defaults?.(specialist);
    const fromRegistry = !!(d && d.maxBudgetUsd > 0 && d.timeoutMinutes > 0);
    const wallMs =
      d && fromRegistry
        ? Math.round(d.timeoutMinutes * 60_000 * this.opts.coldStartTimeoutShare)
        : this.opts.fallbackWallMs;
    if (this.startingEstimates) {
      return {
        usdMicro: startingEstimateUsdMicro(specialist, this.startingEstimates),
        wallMs,
        fromRegistry,
        calibrated: true,
      };
    }
    return {
      usdMicro:
        d && fromRegistry
          ? Math.round(d.maxBudgetUsd * 1_000_000 * this.opts.coldStartBudgetShare)
          : this.opts.fallbackUsdMicro,
      wallMs,
      fromRegistry,
      calibrated: false,
    };
  }

  /** Feed one finished task. Samples with a non-positive estimate or no actual are ignored. */
  observe(sample: EstimateSample): boolean {
    if (!sample.specialist || !sample.kind) return false;
    if (!(sample.estimateUsdMicro > 0) || !(sample.estimateWallMs > 0)) return false;
    if (!(sample.actualUsdMicro > 0) && !(sample.actualWallMs > 0)) return false;
    const key = this.keyOf(sample.specialist, sample.kind);
    const s = this.keys.get(key) ?? {
      specialist: sample.specialist,
      kind: sample.kind,
      n: 0,
      costLog: 0,
      wallLog: 0,
      absErr: 0,
      resid: 0,
      lastAt: null,
    };
    const costRatio = clamp(
      Math.max(sample.actualUsdMicro, 1) / sample.estimateUsdMicro,
      SAMPLE_RATIO_MIN,
      SAMPLE_RATIO_MAX,
    );
    const wallRatio = clamp(
      Math.max(sample.actualWallMs, 1) / sample.estimateWallMs,
      SAMPLE_RATIO_MIN,
      SAMPLE_RATIO_MAX,
    );
    const lc = Math.log(costRatio);
    const lw = Math.log(wallRatio);
    const absErr = Math.abs(costRatio - 1);
    if (s.n === 0) {
      s.costLog = lc;
      s.wallLog = lw;
      s.absErr = absErr;
      s.resid = 0;
    } else {
      s.resid += this.alpha * (Math.abs(lc - s.costLog) - s.resid);
      s.costLog += this.alpha * (lc - s.costLog);
      s.wallLog += this.alpha * (lw - s.wallLog);
      s.absErr += this.alpha * (absErr - s.absErr);
    }
    s.n += 1;
    s.lastAt = sample.at;
    this.keys.set(key, s);
    this.recent.push({ ...sample });
    if (this.recent.length > this.opts.recentLimit)
      this.recent.splice(0, this.recent.length - this.opts.recentLimit);
    return true;
  }

  private ratios(s: KeyState | undefined): { cost: number; wall: number; confidence: number } {
    if (!s || s.n === 0) return { cost: 1, wall: 1, confidence: 0 };
    const weight = s.n / (s.n + this.shrinkage);
    return {
      cost: clamp(Math.exp(s.costLog * weight), RATIO_MIN, RATIO_MAX),
      wall: clamp(Math.exp(s.wallLog * weight), RATIO_MIN, RATIO_MAX),
      confidence: Math.min(1, weight * Math.exp(-s.resid)),
    };
  }

  estimate(task: EstimateInput): EstimateResult {
    const specialist = task.specialist ?? this.opts.defaultSpecialist;
    const kind = this.opts.kindOf ? this.opts.kindOf(task) : kindOfTask(task);
    const cold = this.coldStart(specialist);
    const taskEstimate = task.est_cost_usd_micro ?? 0;
    const baseCost = taskEstimate > 0 ? Math.round(taskEstimate) : cold.usdMicro;
    const baseWall = cold.wallMs;
    const s = this.keys.get(this.keyOf(specialist, kind));
    const raw = this.ratios(s);
    const r = { cost: round4(raw.cost), wall: round4(raw.wall), confidence: raw.confidence };
    const samples = s?.n ?? 0;
    const basis: EstimateBasis =
      samples > 0
        ? "learned"
        : taskEstimate > 0
          ? "task_estimate"
          : cold.calibrated
            ? "calibrated"
            : cold.fromRegistry
              ? "registry_default"
              : "fallback";
    return {
      usdMicro: Math.max(1, Math.round(baseCost * r.cost)),
      wallMs: Math.max(1, Math.round(baseWall * r.wall)),
      confidence: round4(r.confidence),
      basis,
      samples,
      specialist,
      kind,
      costRatio: r.cost,
      wallRatio: r.wall,
    };
  }

  stats(): EstimateKeyStats[] {
    return [...this.keys.values()]
      .map((s) => {
        const r = this.ratios(s);
        return {
          specialist: s.specialist,
          kind: s.kind,
          samples: s.n,
          costRatio: round4(r.cost),
          wallRatio: round4(r.wall),
          meanAbsErrorPct: round2(s.absErr * 100),
          confidence: round4(r.confidence),
          lastSampleAt: s.lastAt,
        };
      })
      .sort((a, b) => a.specialist.localeCompare(b.specialist) || a.kind.localeCompare(b.kind));
  }

  recentSamples(): EstimateSample[] {
    return this.recent.map((s) => ({ ...s }));
  }

  /** Newest finish time seen (task `updated_at` from the store, or `at` of a live observation). */
  get storeCursor(): string | null {
    return this.cursor;
  }

  toJSON(): EstimateModelSnapshot {
    return {
      version: 2,
      keys: [...this.keys.values()].map((k) => ({ ...k })),
      recent: this.recentSamples(),
      cursor: this.cursor,
      folded: [...this.folded].map(([id, at]) => ({ id, at })),
    };
  }

  static fromJSON(
    snapshot: EstimateModelSnapshot,
    options: EstimateModelOptions = {},
  ): EstimateModel {
    if (snapshot.version !== 2) {
      throw new ForerunnerError("validation", "unknown estimate model snapshot version", {
        details: { version: String(snapshot.version) },
      });
    }
    const m = new EstimateModel(options);
    for (const k of snapshot.keys) m.keys.set(m.keyOf(k.specialist, k.kind), { ...k });
    m.recent = snapshot.recent.map((s) => ({ ...s }));
    m.cursor = snapshot.cursor;
    for (const f of snapshot.folded) m.folded.set(f.id, f.at);
    m.prune();
    return m;
  }

  /** Remember a finished task inside the window and move the cursor forward. */
  private remember(taskId: string, at: string): void {
    this.folded.set(taskId, at);
    if (this.cursor === null || at > this.cursor) this.cursor = at;
  }

  /** Drop remembered ids older than the overlap window behind the cursor. */
  private prune(): void {
    if (this.cursor === null) return;
    const floor = isoMinus(this.cursor, this.foldOverlapMs);
    for (const [id, at] of this.folded) if (at < floor) this.folded.delete(id);
  }

  /**
   * Fold every finished task (done, failed, cancelled) with at least one finished work run:
   * actual cost from the cost ledger (the truth for caps) less its reviews (the critic's Run
   * rows: the work's cost is what the task's budget caps, 'cost') or, without ledger rows, from
   * the work runs; actual wall time from the work runs' durations; the estimate from the task
   * row or the cold start. A task with a run that stopped at a budget (`paused`,
   * `budget_exceeded`) is no sample ('cost', ADR 0112), nor is one whose work spent nothing (no
   * model call ran: a refused sandbox lease, an error on the first request).
   */
  static async fromStore(
    store: StateStore,
    options: EstimateModelOptions = {},
  ): Promise<EstimateModel> {
    const m = new EstimateModel(options);
    await m.refresh(store);
    return m;
  }

  /**
   * Fold tasks finished since the last refresh. The store returns only finished tasks updated
   * at or after `cursor - foldOverlapMs`; ids remembered from that window are skipped, so a
   * refresh never counts a task twice. Returns how many samples were added.
   */
  async refresh(store: StateStore): Promise<number> {
    const since = this.cursor === null ? null : isoMinus(this.cursor, this.foldOverlapMs);
    const w = store.task.where({ status: [...FINISHED_TASK_STATUSES] });
    const tasks = await store.task.rows(
      `SELECT * FROM ${store.task.qt}${w.sql}${since === null ? "" : ' AND "updated_at" >= ?'} ORDER BY "updated_at" ASC, "id" ASC`,
      since === null ? w.params : [...w.params, since],
    );
    const fresh = tasks.filter((t) => !this.folded.has(t.id));
    if (fresh.length === 0) {
      this.prune();
      return 0;
    }
    const byTask = new Map<string, RunTally>();
    for (let i = 0; i < fresh.length; i += RUN_LIST_CHUNK) {
      const ids = fresh.slice(i, i + RUN_LIST_CHUNK).map((t) => t.id);
      for (const r of await store.run.list({ task_id: ids })) {
        if (!r.task_id) continue;
        byTask.set(r.task_id, tallyRun(byTask.get(r.task_id) ?? emptyRunTally(), r));
      }
    }
    // A task's ledger rows are recorded after the task exists, so the oldest fresh task's
    // creation (less the window, for skew) bounds the breakdown instead of the whole ledger.
    let oldest = fresh[0]?.created_at ?? "";
    for (const t of fresh) if (t.created_at < oldest) oldest = t.created_at;
    const ledger = new Map<string, number>();
    for (const b of await store.costLedger.breakdown("task_id", {
      from: isoMinus(oldest, this.foldOverlapMs),
    })) {
      if (b.key && b.entries > 0) ledger.set(b.key, b.usd_micro);
    }
    let added = 0;
    for (const t of fresh) {
      this.remember(t.id, t.updated_at);
      const runs = byTask.get(t.id);
      if (!runs || isNoSample(runs)) continue;
      const usdMicro = workCostOf(runs, ledger.get(t.id));
      // Nothing spent: no model call ran, so it says nothing of what the work costs.
      if (!(usdMicro > 0)) continue;
      const sample = this.sampleForTask(t, {
        usdMicro,
        wallMs: runs.wall,
        at: runs.endedAt || t.updated_at,
      });
      if (this.observe(sample)) added += 1;
    }
    this.prune();
    return added;
  }

  /**
   * The sample for a finished task: the estimate is the task's own `est_cost_usd_micro` when
   * > 0, else the cold start; the wall estimate is always the cold start. Never the figure the
   * planner already corrected: measuring against that feeds the correction back into itself.
   */
  sampleForTask(task: EstimateTaskInput, actual: TaskActuals): EstimateSample {
    const specialist = task.specialist ?? this.opts.defaultSpecialist;
    const input: EstimateInput = {
      specialist,
      risk_tier: task.risk_tier,
      est_cost_usd_micro: task.est_cost_usd_micro,
      budget_usd_micro: task.budget_usd_micro,
    };
    const kind = this.opts.kindOf ? this.opts.kindOf(input) : kindOfTask(input);
    const cold = this.coldStart(specialist);
    return {
      specialist,
      kind,
      estimateUsdMicro: task.est_cost_usd_micro > 0 ? task.est_cost_usd_micro : cold.usdMicro,
      actualUsdMicro: actual.usdMicro,
      estimateWallMs: cold.wallMs,
      actualWallMs: actual.wallMs,
      at: actual.at,
      taskId: task.id,
    };
  }

  /**
   * Live feed for the runner's task.finished hook: the same sample the store fold would build,
   * so the state learned live agrees with the state after a restart. The task is remembered so
   * a refresh() inside the overlap window does not fold it again. Returns whether the sample
   * was usable (see observe).
   */
  observeTask(task: EstimateTaskInput, actual: TaskActuals): boolean {
    const ok = this.observe(this.sampleForTask(task, actual));
    this.remember(task.id, actual.at);
    this.prune();
    return ok;
  }

  /**
   * The runner's task.finished hook, built as the fold builds it (review of 'cost'): the task's
   * Run rows and cost-ledger rows are read, and
   * - a task the fold leaves out gives no sample live either (`isNoSample`): a work run that
   *   stopped at a budget, also one before the budget was raised or the task continued; a
   *   fast-mode run; no finished work run (a call that met a resting credential); or work that
   *   spent nothing (no model call ran; it read as a tenth of the estimate). Before, the
   *   live feed skipped only a call that itself paused, so a raised task was learned from until
   *   the next restart, whose fold left it out;
   * - the actual is the fold's: the work's cost so far (`workCostOf`) and its runs' wall time,
   *   not the executor call's figures, whose wall time also counted the call's setup, so the
   *   Performance screen's time ratio moved with a restart; and its time is when the last work
   *   run ended (`at` only when no row says), not the hook's moment.
   * `callOutcome` is the executor call's outcome: a budget stop is no sample whatever its Run row
   * says, nor is a call a credential stopped (`usage_limit`: the task goes back to ready and
   * runs again). A task tried more than once is a sample at each try, the last one with what the
   * fold counts for it.
   */
  async observeTaskRuns(
    store: StateStore,
    task: EstimateTaskInput,
    at: string,
    callOutcome?: string,
  ): Promise<boolean> {
    if (callOutcome !== undefined && NO_SAMPLE_CALL_OUTCOMES.includes(callOutcome)) return false;
    const tally = emptyRunTally();
    for (const r of await store.run.forTask(task.id)) tallyRun(tally, r);
    if (isNoSample(tally)) return false;
    const booked = await store.costLedger.sum({ taskId: task.id });
    const usdMicro = workCostOf(tally, booked.entries > 0 ? booked.usd_micro : undefined);
    if (!(usdMicro > 0)) return false;
    return this.observeTask(task, { usdMicro, wallMs: tally.wall, at: tally.endedAt || at });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Convenience for the planner: the learned estimate for a task row, in micro-USD. */
export function planEstimateUsdMicro(port: EstimatePort, task: TaskRow): number {
  return withinTaskBudget(
    port.estimate({
      specialist: task.specialist,
      risk_tier: task.risk_tier,
      est_cost_usd_micro: task.est_cost_usd_micro,
      budget_usd_micro: task.budget_usd_micro,
    }).usdMicro,
    task,
  );
}

/**
 * An estimate no larger than what is left of the task's own budget (U-042: the budget caps its
 * runs, so a run never spends more). Live walk 2 (phase C): a task with a budget of CHF 0.80
 * was estimated at about CHF 1.00, and the Start dialog and the plan counted the larger figure.
 * A task without a budget keeps the estimate.
 */
export function withinTaskBudget(
  estimateUsdMicro: number,
  task: Pick<TaskRow, "budget_usd_micro" | "actual_cost_usd_micro">,
): number {
  if (!(task.budget_usd_micro > 0)) return estimateUsdMicro;
  const left = Math.max(0, task.budget_usd_micro - (task.actual_cost_usd_micro ?? 0));
  return Math.min(estimateUsdMicro, left);
}
