/**
 * Estimate-versus-actual tracking per specialist and task type (spec module I: "estimate
 * error tracked per specialist and task type"). The planner multiplies its next estimate by
 * suggestedMultiplier() so chronic under-estimates stop surprising the caps.
 *
 * ratio = (actual - estimate) / max(estimate, 1 micro), clamped to [-1, 10] so one runaway
 * run cannot dominate. bias is the mean signed ratio (positive: actuals run above estimates),
 * meanAbsErrorRatio the mean |ratio|.
 */
import { ForerunnerError } from "@forerunner/platform";
import { assertMicro } from "./money.ts";

export interface EstimateSample {
  specialist: string;
  taskType: string;
  estimateUsdMicro: number;
  actualUsdMicro: number;
  ratio: number;
}

export interface EstimateErrorStats {
  n: number;
  meanAbsErrorRatio: number;
  bias: number;
}

export const MULTIPLIER_MIN = 0.5;
export const MULTIPLIER_MAX = 3;
const RATIO_MIN = -1;
const RATIO_MAX = 10;

export interface EstimateTrackerOptions {
  /** Newest samples kept per (specialist, taskType). Default 500. */
  maxSamplesPerKey?: number;
  /** Pseudo-count that shrinks the multiplier toward 1 with few samples. Default 3. */
  shrinkage?: number;
}

export class EstimateTracker {
  private samples: EstimateSample[] = [];
  private readonly maxPerKey: number;
  private readonly shrinkage: number;

  constructor(opts: EstimateTrackerOptions = {}) {
    this.maxPerKey = opts.maxSamplesPerKey ?? 500;
    this.shrinkage = opts.shrinkage ?? 3;
  }

  record(
    specialist: string,
    taskType: string,
    estimateUsdMicro: number,
    actualUsdMicro: number,
  ): EstimateSample {
    if (!specialist || !taskType) {
      throw new ForerunnerError("validation", "specialist and taskType are required");
    }
    assertMicro(estimateUsdMicro, "estimateUsdMicro");
    assertMicro(actualUsdMicro, "actualUsdMicro");
    if (estimateUsdMicro < 0 || actualUsdMicro < 0) {
      throw new ForerunnerError("validation", "estimate and actual must not be negative");
    }
    const raw = (actualUsdMicro - estimateUsdMicro) / Math.max(estimateUsdMicro, 1);
    const ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, raw));
    const sample: EstimateSample = {
      specialist,
      taskType,
      estimateUsdMicro,
      actualUsdMicro,
      ratio,
    };
    this.samples.push(sample);
    const same = this.samples.filter((s) => s.specialist === specialist && s.taskType === taskType);
    if (same.length > this.maxPerKey) {
      const drop = same[0];
      this.samples = this.samples.filter((s) => s !== drop);
    }
    return sample;
  }

  private select(specialist: string, taskType?: string): EstimateSample[] {
    return this.samples.filter(
      (s) => s.specialist === specialist && (taskType === undefined || s.taskType === taskType),
    );
  }

  errorStats(specialist: string, taskType?: string): EstimateErrorStats {
    const rows = this.select(specialist, taskType);
    if (rows.length === 0) return { n: 0, meanAbsErrorRatio: 0, bias: 0 };
    let abs = 0;
    let signed = 0;
    for (const r of rows) {
      abs += Math.abs(r.ratio);
      signed += r.ratio;
    }
    return { n: rows.length, meanAbsErrorRatio: abs / rows.length, bias: signed / rows.length };
  }

  /**
   * Factor for the next estimate: 1 + bias, shrunk toward 1 when there are few samples
   * (weight n / (n + shrinkage)) and clamped to [0.5, 3]. 1 without data.
   */
  suggestedMultiplier(specialist: string, taskType?: string): number {
    const stats = this.errorStats(specialist, taskType);
    if (stats.n === 0) return 1;
    const weight = stats.n / (stats.n + this.shrinkage);
    const m = 1 + stats.bias * weight;
    return Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, m));
  }

  /** Samples for persistence. */
  toJSON(): EstimateSample[] {
    return [...this.samples];
  }

  static fromJSON(
    samples: readonly EstimateSample[],
    opts: EstimateTrackerOptions = {},
  ): EstimateTracker {
    const t = new EstimateTracker(opts);
    for (const s of samples)
      t.record(s.specialist, s.taskType, s.estimateUsdMicro, s.actualUsdMicro);
    return t;
  }
}
