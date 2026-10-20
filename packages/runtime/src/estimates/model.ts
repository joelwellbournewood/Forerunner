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
 * and extended with refresh(). There is no separate table: a rebuild from the store always
 * reproduces the same state, and toJSON()/fromJSON() exist for callers that want to cache it.
 */
import { ForerunnerError } from "@forerunner/platform";
import type { StateStore, TaskRow } from "@forerunner/state";

export interface EstimateInput {
  specialist: string | null;
  risk_tier: number;
  /** The planner's or the task author's estimate; 0 or absent means none. */
  est_cost_usd_micro?: number;
  budget_usd_micro?: number;
  /** Explicit kind label; defaults to the risk tier (see kindOf). */
  kind?: string;
}

export type EstimateBasis = "learned" | "task_estimate" | "registry_default" | "fallback";

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
  /** Pseudo-count that holds the ratio near 1 and the confidence near 0 with few samples. Default 5. */
  shrinkage?: number;
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
}

export const DEFAULT_ALPHA = 0.3;
export const DEFAULT_SHRINKAGE = 5;
export const DEFAULT_COLD_START_BUDGET_SHARE = 0.5;
export const DEFAULT_COLD_START_TIMEOUT_SHARE = 0.5;
export const DEFAULT_FALLBACK_USD_MICRO = 500_000;
export const DEFAULT_FALLBACK_WALL_MS = 20 * 60_000;
/** Per-sample ratio clamp: one runaway or aborted run cannot dominate. */
export const SAMPLE_RATIO_MIN = 0.1;
export const SAMPLE_RATIO_MAX = 10;
/** Clamp on the multiplier the planner sees. */
export const RATIO_MIN = 0.25;
export const RATIO_MAX = 4;

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
  version: 1;
  keys: KeyState[];
  recent: EstimateSample[];
  cursor: string | null;
  folded: string[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export class EstimateModel implements EstimatePort {
  private readonly keys = new Map<string, KeyState>();
  private recent: EstimateSample[] = [];
  private cursor: string | null = null;
  private readonly folded = new Set<string>();
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

  constructor(options: EstimateModelOptions = {}) {
    this.alpha = options.alpha ?? DEFAULT_ALPHA;
    this.shrinkage = options.shrinkage ?? DEFAULT_SHRINKAGE;
    if (!(this.alpha > 0 && this.alpha <= 1)) {
      throw new ForerunnerError("validation", "estimate model alpha must be in (0, 1]");
    }
    if (!(this.shrinkage >= 0)) {
      throw new ForerunnerError("validation", "estimate model shrinkage must be >= 0");
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
  }

  private keyOf(specialist: string, kind: string): string {
    return `${specialist}\u0000${kind}`;
  }

  /** Cold-start figures for a specialist: registry defaults scaled, else the fallback. */
  coldStart(specialist: string): { usdMicro: number; wallMs: number; fromRegistry: boolean } {
    const d = this.opts.defaults?.(specialist);
    if (d && d.maxBudgetUsd > 0 && d.timeoutMinutes > 0) {
      return {
        usdMicro: Math.round(d.maxBudgetUsd * 1_000_000 * this.opts.coldStartBudgetShare),
        wallMs: Math.round(d.timeoutMinutes * 60_000 * this.opts.coldStartTimeoutShare),
        fromRegistry: true,
      };
    }
    return {
      usdMicro: this.opts.fallbackUsdMicro,
      wallMs: this.opts.fallbackWallMs,
      fromRegistry: false,
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

  /** Newest task `updated_at` folded from the store, for incremental refresh. */
  get storeCursor(): string | null {
    return this.cursor;
  }

  toJSON(): EstimateModelSnapshot {
    return {
      version: 1,
      keys: [...this.keys.values()].map((k) => ({ ...k })),
      recent: this.recentSamples(),
      cursor: this.cursor,
      folded: [...this.folded],
    };
  }

  static fromJSON(
    snapshot: EstimateModelSnapshot,
    options: EstimateModelOptions = {},
  ): EstimateModel {
    if (snapshot.version !== 1) {
      throw new ForerunnerError("validation", "unknown estimate model snapshot version", {
        details: { version: String(snapshot.version) },
      });
    }
    const m = new EstimateModel(options);
    for (const k of snapshot.keys) m.keys.set(m.keyOf(k.specialist, k.kind), { ...k });
    m.recent = snapshot.recent.map((s) => ({ ...s }));
    m.cursor = snapshot.cursor;
    for (const id of snapshot.folded) m.folded.add(id);
    return m;
  }

  /**
   * Fold every finished task (done, failed, cancelled) with at least one finished run: actual
   * cost from the cost ledger (the truth for caps) or, without ledger rows, from the run rows;
   * actual wall time from the run durations; the estimate from the task row or the cold start.
   */
  static async fromStore(
    store: StateStore,
    options: EstimateModelOptions = {},
  ): Promise<EstimateModel> {
    const m = new EstimateModel(options);
    await m.refresh(store);
    return m;
  }

  /** Fold tasks finished since the last refresh. Returns how many samples were added. */
  async refresh(store: StateStore): Promise<number> {
    const tasks = await store.task.list(
      { status: ["done", "failed", "cancelled"] },
      { orderBy: [{ column: "updated_at" }, { column: "id" }] },
    );
    const fresh = tasks.filter(
      (t) => !this.folded.has(t.id) && (this.cursor === null || t.updated_at >= this.cursor),
    );
    if (fresh.length === 0) return 0;
    const runs = await store.run.list({ task_id: fresh.map((t) => t.id) });
    const byTask = new Map<string, { cost: number; wall: number; finished: number }>();
    for (const r of runs) {
      if (!r.task_id || r.outcome === "running" || r.outcome === "") continue;
      const acc = byTask.get(r.task_id) ?? { cost: 0, wall: 0, finished: 0 };
      acc.cost += r.cost_usd_micro;
      acc.wall += r.duration_ms ?? 0;
      acc.finished += 1;
      byTask.set(r.task_id, acc);
    }
    const ledger = new Map<string, number>();
    for (const b of await store.costLedger.breakdown("task_id")) {
      if (b.key && b.entries > 0) ledger.set(b.key, b.usd_micro);
    }
    let added = 0;
    for (const t of fresh) {
      this.folded.add(t.id);
      if (this.cursor === null || t.updated_at > this.cursor) this.cursor = t.updated_at;
      const sample = this.sampleFromTask(t, byTask.get(t.id), ledger.get(t.id));
      if (sample && this.observe(sample)) added += 1;
    }
    return added;
  }

  private sampleFromTask(
    t: TaskRow,
    runs: { cost: number; wall: number; finished: number } | undefined,
    ledgerUsdMicro: number | undefined,
  ): EstimateSample | null {
    if (!runs || runs.finished === 0) return null;
    const specialist = t.specialist ?? this.opts.defaultSpecialist;
    const input: EstimateInput = {
      specialist,
      risk_tier: t.risk_tier,
      est_cost_usd_micro: t.est_cost_usd_micro,
      budget_usd_micro: t.budget_usd_micro,
    };
    const kind = this.opts.kindOf ? this.opts.kindOf(input) : kindOfTask(input);
    const cold = this.coldStart(specialist);
    return {
      specialist,
      kind,
      estimateUsdMicro: t.est_cost_usd_micro > 0 ? t.est_cost_usd_micro : cold.usdMicro,
      actualUsdMicro: ledgerUsdMicro ?? runs.cost,
      estimateWallMs: cold.wallMs,
      actualWallMs: runs.wall,
      at: t.updated_at,
      taskId: t.id,
    };
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
  return port.estimate({
    specialist: task.specialist,
    risk_tier: task.risk_tier,
    est_cost_usd_micro: task.est_cost_usd_micro,
    budget_usd_micro: task.budget_usd_micro,
  }).usdMicro;
}
