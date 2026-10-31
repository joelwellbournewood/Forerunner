/**
 * "Estimate accuracy" view for the Performance screen (spec I: estimate error tracked per
 * specialist and task type). Zod shapes so the UI and the daemon validate both ways.
 */
import { z } from "zod";
import type { EstimateModel } from "./model.ts";

export const EstimateAccuracyRowSchema = z.object({
  specialist: z.string(),
  kind: z.string(),
  samples: z.number().int().nonnegative(),
  /** Multiplier the planner applies to a base estimate for this key. */
  cost_ratio: z.number(),
  wall_ratio: z.number(),
  mean_abs_error_pct: z.number(),
  confidence: z.number().min(0).max(1),
  last_sample_at: z.string().nullable(),
});
export type EstimateAccuracyRow = z.infer<typeof EstimateAccuracyRowSchema>;

export const EstimateAccuracySampleSchema = z.object({
  task_id: z.string().nullable(),
  specialist: z.string(),
  kind: z.string(),
  estimate_usd_micro: z.number().int(),
  actual_usd_micro: z.number().int(),
  /** (actual - estimate) / estimate in percent; positive when the task cost more than planned. */
  error_pct: z.number(),
  estimate_wall_ms: z.number().int(),
  actual_wall_ms: z.number().int(),
  at: z.string(),
});
export type EstimateAccuracySample = z.infer<typeof EstimateAccuracySampleSchema>;

export const EstimateAccuracyViewSchema = z.object({
  generated_at: z.string(),
  overall: z.object({
    /** Every sample the rows count (their sum), so the screen's totals agree (U-077). */
    samples: z.number().int().nonnegative(),
    /**
     * The rows' mean |error| weighted by their samples, in percent: it lies between the rows'
     * figures (U-077: it was a plain mean of unclamped recent errors and could exceed them all).
     */
    mean_abs_error_pct: z.number(),
    /** Mean signed error over the recent samples; positive means estimates run low. */
    bias_pct: z.number(),
    /** Share of recent samples whose actual landed within 25% of the estimate. */
    within_25_pct_share: z.number().min(0).max(1),
  }),
  rows: z.array(EstimateAccuracyRowSchema),
  recent: z.array(EstimateAccuracySampleSchema),
});
export type EstimateAccuracyView = z.infer<typeof EstimateAccuracyViewSchema>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function estimateAccuracyView(
  model: EstimateModel,
  nowIso: string,
  opts: { recentLimit?: number } = {},
): EstimateAccuracyView {
  const recentAll = model.recentSamples();
  const recent = recentAll.slice(-(opts.recentLimit ?? 50)).reverse();
  const errors = recentAll.map((s) =>
    s.estimateUsdMicro > 0
      ? ((s.actualUsdMicro - s.estimateUsdMicro) / s.estimateUsdMicro) * 100
      : 0,
  );
  const n = errors.length;
  const bias = n ? errors.reduce((a, e) => a + e, 0) / n : 0;
  const within = n ? errors.filter((e) => Math.abs(e) <= 25).length / n : 0;
  // The overall error is the rows' own, weighted by their samples (U-077).
  const stats = model.stats();
  const counted = stats.reduce((a, r) => a + r.samples, 0);
  const meanAbs = counted
    ? stats.reduce((a, r) => a + r.meanAbsErrorPct * r.samples, 0) / counted
    : 0;
  return EstimateAccuracyViewSchema.parse({
    generated_at: nowIso,
    overall: {
      samples: counted,
      mean_abs_error_pct: round2(meanAbs),
      bias_pct: round2(bias),
      within_25_pct_share: round2(within),
    },
    rows: stats.map((r) => ({
      specialist: r.specialist,
      kind: r.kind,
      samples: r.samples,
      cost_ratio: r.costRatio,
      wall_ratio: r.wallRatio,
      mean_abs_error_pct: r.meanAbsErrorPct,
      confidence: r.confidence,
      last_sample_at: r.lastSampleAt,
    })),
    recent: recent.map((s) => ({
      task_id: s.taskId ?? null,
      specialist: s.specialist,
      kind: s.kind,
      estimate_usd_micro: Math.round(s.estimateUsdMicro),
      actual_usd_micro: Math.round(s.actualUsdMicro),
      error_pct: round2(
        s.estimateUsdMicro > 0
          ? ((s.actualUsdMicro - s.estimateUsdMicro) / s.estimateUsdMicro) * 100
          : 0,
      ),
      estimate_wall_ms: Math.round(s.estimateWallMs),
      actual_wall_ms: Math.round(s.actualWallMs),
      at: s.at,
    })),
  });
}
