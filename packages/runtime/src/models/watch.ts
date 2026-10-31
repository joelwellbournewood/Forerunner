/**
 * Weekly model watch (spec D: "checks provider model lists and pricing, runs the eval set on new
 * candidates, proposes a switch with measured quality and cost deltas. Human approves." and
 * "also tests lower effort levels"; spec M: model updates surface in the updates screen).
 *
 * One run:
 *   1. asks every registered ModelProvider for its model list and the PriceListSource for the
 *      current prices (never assumed: a model without a known price is reported, not tested);
 *   2. diffs both against the effective ladder and pricing table: new, retired, repriced;
 *   3. runs the eval sets (through the EvalRunnerPort, which the orchestrator backs with
 *      @forerunner/evals) on every priced new candidate and on one effort step below the
 *      current default of every eval target, under a hard eval budget enforced in code;
 *   4. writes a ModelWatchReport (zod) with recommendations and a pricing.json proposal,
 *      persists it as a `release` row on channel "model_watch" (what the updates screen lists),
 *      appends audit rows, and opens a decision for the human through the approval port.
 *
 * Nothing changes the ladder, the effort defaults or the pricing without a recorded "adopt"
 * answered by a human: adopt() refuses anything else with ForerunnerError("approval_required").
 * On adopt it writes <config>/pricing.json and <config>/models.json through the settings store.
 * Thresholds are ADR 0019.
 */
import {
  BUILTIN_PRICING,
  CACHE_READ_SHARE,
  CACHE_WRITE_SHARE,
  canonicalModelId,
  mergePricing,
  type PricingOverrides,
  type PricingTable,
} from "@forerunner/billing";
import { type Clock, errorMessage, ForerunnerError, log, newId } from "@forerunner/platform";
import type { HumanRequestRow, JsonValue, ReleaseRow, StateStore } from "@forerunner/state";
import { z } from "zod";
import type { ProviderRegistry } from "../provider/registry.ts";
import type { EffortLevel, ModelRef, ModelTier } from "../provider/types.ts";
import type { SpecialistDef } from "../registry/types.ts";
import type { Schedule, Scheduler, StartRequest } from "../session/triggers.ts";
import type { LadderRung, Mode } from "./ladder.ts";
import type { PriceList, PriceListSource } from "./price-list.ts";
import {
  applyModelSettings,
  builtinModelConfig,
  EFFORT_VALUES,
  type EffectiveModelConfig,
  MODE_VALUES,
  type ModelSettings,
  type ModelSettingsStore,
  TIER_VALUES,
} from "./settings.ts";

const logger = log("model-watch");

export const MODEL_WATCH_CHANNEL = "model_watch";
/**
 * Where each provider's baseline listing is kept: one row per provider (release_version is the
 * provider name), written by the first run that lists it and never moved after (ADR 0089).
 * Kept apart from the reports so the updates screen lists reports only.
 */
export const MODEL_WATCH_BASELINE_CHANNEL = "model_watch_baseline";
export const MODEL_WATCH_AGENT_ID = "model-watch";
export const MODEL_WATCH_SCHEDULE_ID = "model-watch-weekly";
/** The hourly look for "remind me" answers that are due (U-035): its own pseudo agent. */
export const MODEL_WATCH_REMINDER_AGENT_ID = "model-watch-reminders";
export const MODEL_WATCH_REMINDER_SCHEDULE_ID = "model-watch-reminders";
export const MODEL_WATCH_REMINDER_EVERY_MINUTES = 60;
/** The human's model watch settings live under this key of `human.notify_prefs` (ADR 0089). */
export const MODEL_WATCH_SETTINGS_KEY = "model_watch";

export interface ModelWatchSettings {
  /** Run the paid evals on every scheduled or manual run without asking. Default off. */
  runEvals: boolean;
  /** Let eval tasks that run commands use the process stand-in when no container engine exists. Default off. */
  allowProcessSandbox: boolean;
}

/** The human's model watch settings; anything missing or malformed is off. */
export function modelWatchSettingsOf(prefs: unknown): ModelWatchSettings {
  const raw =
    prefs && typeof prefs === "object" && !Array.isArray(prefs)
      ? (prefs as Record<string, unknown>)[MODEL_WATCH_SETTINGS_KEY]
      : undefined;
  const s =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    runEvals: s.run_evals === true,
    allowProcessSandbox: s.allow_process_sandbox === true,
  };
}
export const WEEK_MINUTES = 7 * 24 * 60;

// ---------------------------------------------------------------------------------------
// Thresholds (ADR 0019)
// ---------------------------------------------------------------------------------------

export interface WatchThresholds {
  /** A cheaper candidate is recommended when its eval cost is at least this much lower. */
  minCostSavingPct: number;
  /** A pricier candidate is recommended when it passes at least this many points more ... */
  minQualityGainPoints: number;
  /** ... and costs at most this much more. */
  maxCostIncreasePct: number;
  /** How many pass-rate points a recommendation may lose against the baseline (0: none). */
  qualityTolerancePoints: number;
  /** A lower effort is recommended when it passes and saves at least this much. */
  minEffortSavingPct: number;
  /** Eval sets smaller than this produce observations but never recommendations. */
  minEvalTasks: number;
  /** A price change below this is noise, not a repricing. */
  repriceMinDeltaPct: number;
  /** Hard cap on what one watch run may spend on evals, in micro-USD. Enforced in code. */
  evalBudgetUsdMicro: number;
}

export const DEFAULT_WATCH_THRESHOLDS: WatchThresholds = Object.freeze({
  minCostSavingPct: 10,
  minQualityGainPoints: 5,
  maxCostIncreasePct: 25,
  qualityTolerancePoints: 0,
  minEffortSavingPct: 5,
  minEvalTasks: 3,
  repriceMinDeltaPct: 0.5,
  evalBudgetUsdMicro: 5_000_000,
});

// ---------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------

export interface EvalTarget {
  /** Specialist whose eval set is run (registry `eval_set`). */
  specialist: string;
  /** The mode whose default model and effort the specialist runs at (spec D effort table). */
  mode: Mode;
}

export const DEFAULT_EVAL_TARGETS: readonly EvalTarget[] = Object.freeze([
  { specialist: "coder", mode: "coder" },
  { specialist: "researcher", mode: "researcher" },
]);

export interface EvalRunInput {
  specialist: string;
  provider: string;
  model: string;
  effort: EffortLevel;
  /** The pricing table to cost the runs with: the effective table plus the report's proposal, so a candidate is priced. */
  pricing: PricingTable;
  signal?: AbortSignal;
  /**
   * The approval gate (spec C.5, ADR 0071): run this pending proposal's eval set instead of
   * the registry's runnable entry. Only a `proposed` definition named `specialist` is
   * accepted; the run is what decides whether it may become runnable.
   */
  candidate?: SpecialistDef;
}

export interface EvalRunOutcome {
  total: number;
  passed: number;
  failed: number;
  /** Tasks left to the critic (rubric checks); counted neither way. */
  needsModel: number;
  /** passed / (passed + failed); 0 when nothing was decided. */
  passRate: number;
  costUsdMicro: number;
  durationMs: number;
}

/** Runs one specialist's eval set on one model and effort. Backed by @forerunner/evals in production. */
export interface EvalRunnerPort {
  run(input: EvalRunInput): Promise<EvalRunOutcome>;
}

/**
 * "evaluate" is the human's consent to the paid evals a report withheld (ADR 0089): nothing is
 * written, and the watch asks the daemon (`onEvalsRequested`) to run them.
 */
export type ModelWatchDecision = "adopt" | "evaluate" | "ignore" | "remind";

export interface ModelWatchAnswer {
  decision: ModelWatchDecision;
  /** Recommendation ids to adopt; omitted means every recommendation in the report. */
  adopt?: string[];
  /** Human id that answered. Required for "adopt" and "evaluate". */
  by?: string;
}

export interface ModelWatchApprovalRequest {
  reportId: string;
  humanId: string;
  summary: string;
  options: readonly ModelWatchDecision[];
  recommendations: Recommendation[];
  pricingProposal: PricingOverrides;
  /** Text lines for the inbox card. */
  steps: string[];
}

export type ModelWatchApprovalOutcome =
  | { status: "answered"; answer: ModelWatchAnswer }
  | { status: "pending"; requestId: string | null };

/** Anything that needs a human goes through here: a HumanRequest in production, a fake in tests. */
export interface ModelWatchApprovalPort {
  ask(req: ModelWatchApprovalRequest): Promise<ModelWatchApprovalOutcome>;
}

// ---------------------------------------------------------------------------------------
// Report (zod)
// ---------------------------------------------------------------------------------------

const Tier = z.enum(TIER_VALUES);
const Effort = z.enum(EFFORT_VALUES);
const ModeSchema = z.enum(MODE_VALUES);
const nonNegative = z.number().finite().nonnegative();

export const PriceRowSchema = z.object({
  input_per_mtok_usd: nonNegative,
  output_per_mtok_usd: nonNegative,
  cache_read_per_mtok_usd: nonNegative,
  cache_write_per_mtok_usd: nonNegative,
  as_of: z.string(),
  source: z.enum(["list", "assumed", "override"]),
});
export type PriceRow = z.infer<typeof PriceRowSchema>;

/** One row of the pricing.json proposal; the same shape the billing package accepts. */
export const PricingProposalRowSchema = z
  .object({
    input_per_mtok_usd: nonNegative.optional(),
    output_per_mtok_usd: nonNegative.optional(),
    cache_read_per_mtok_usd: nonNegative.optional(),
    cache_write_per_mtok_usd: nonNegative.optional(),
    source: z.enum(["list", "assumed", "override"]).optional(),
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().max(500).optional(),
  })
  .strict();
export type PricingProposalRow = z.infer<typeof PricingProposalRowSchema>;

export const EvalObservationSchema = z.object({
  specialist: z.string(),
  mode: ModeSchema,
  provider: z.string(),
  model: z.string(),
  tier: Tier,
  effort: Effort,
  role: z.enum(["baseline", "candidate", "lower_effort"]),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  needs_model: z.number().int().nonnegative(),
  pass_rate: z.number().min(0).max(1),
  cost_usd_micro: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  /** Set when the eval did not run (budget exhausted, provider error, no rung model). */
  skipped_reason: z.string().nullable(),
});
export type EvalObservation = z.infer<typeof EvalObservationSchema>;

/** One eval the run would have made had the human consented (ADR 0089). */
export const PlannedEvalSchema = z.object({
  specialist: z.string(),
  mode: ModeSchema,
  provider: z.string(),
  model: z.string(),
  tier: Tier,
  effort: Effort,
  role: z.enum(["baseline", "candidate", "lower_effort"]),
});
export type PlannedEval = z.infer<typeof PlannedEvalSchema>;

export const SwitchModelRecommendationSchema = z.object({
  id: z.string(),
  kind: z.literal("switch_model"),
  provider: z.string(),
  rung: Tier,
  from: z.string(),
  to: z.string(),
  /** Mean pass-rate difference across eval targets, in points (+3 = three points better). */
  quality_delta_points: z.number(),
  /** Lowest per-target pass-rate difference, in points. */
  min_quality_delta_points: z.number(),
  /** Eval cost difference in percent (-20 = a fifth cheaper); null when the baseline cost nothing. */
  cost_delta_pct: z.number().nullable(),
  evidence: z.array(z.string()),
  text: z.string(),
});
export const LowerEffortRecommendationSchema = z.object({
  id: z.string(),
  kind: z.literal("lower_effort"),
  mode: ModeSchema,
  specialist: z.string(),
  provider: z.string(),
  model: z.string(),
  from: Effort,
  to: Effort,
  pass_rate: z.number(),
  baseline_pass_rate: z.number(),
  cost_delta_pct: z.number().nullable(),
  evidence: z.array(z.string()),
  text: z.string(),
});
export const RepriceRecommendationSchema = z.object({
  id: z.string(),
  kind: z.literal("reprice"),
  model: z.string(),
  changes: z.array(
    z.object({
      field: z.enum([
        "input_per_mtok_usd",
        "output_per_mtok_usd",
        "cache_read_per_mtok_usd",
        "cache_write_per_mtok_usd",
      ]),
      before: z.number().nullable(),
      after: z.number(),
      delta_pct: z.number().nullable(),
    }),
  ),
  text: z.string(),
});
export const RecommendationSchema = z.discriminatedUnion("kind", [
  SwitchModelRecommendationSchema,
  LowerEffortRecommendationSchema,
  RepriceRecommendationSchema,
]);
export type Recommendation = z.infer<typeof RecommendationSchema>;
export type SwitchModelRecommendation = z.infer<typeof SwitchModelRecommendationSchema>;
export type LowerEffortRecommendation = z.infer<typeof LowerEffortRecommendationSchema>;
export type RepriceRecommendation = z.infer<typeof RepriceRecommendationSchema>;

export const ModelWatchReportSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  generated_at: z.string(),
  price_list: z.object({
    source: z.string(),
    as_of: z.string().nullable(),
    models: z.number().int().nonnegative(),
    error: z.string().nullable(),
  }),
  providers: z.array(
    z.object({
      name: z.string(),
      listed: z.array(z.object({ id: z.string(), tier: Tier })),
      error: z.string().nullable(),
    }),
  ),
  diff: z.object({
    new_models: z.array(
      z.object({
        provider: z.string(),
        id: z.string(),
        tier: Tier,
        priced: z.boolean(),
        price_origin: z.enum(["table", "price_list", "none"]),
        price: PriceRowSchema.nullable(),
      }),
    ),
    retired_models: z.array(
      z.object({ provider: z.string(), id: z.string(), tier: Tier, rung_affected: z.boolean() }),
    ),
    repriced: z.array(RepriceRecommendationSchema.omit({ id: true, kind: true, text: true })),
    unpriced: z.array(z.object({ provider: z.string(), id: z.string(), tier: Tier })),
  }),
  evals: z.array(EvalObservationSchema),
  recommendations: z.array(RecommendationSchema),
  pricing_proposal: z.record(z.string(), PricingProposalRowSchema),
  eval_cost_usd_micro: z.number().int().nonnegative(),
  eval_budget_usd_micro: z.number().int().nonnegative(),
  /**
   * Set when the run made no paid eval because the human has not consented (ADR 0089): why,
   * and the evals it would have run. Null when the evals ran (or a report predates the field).
   */
  evals_deferred: z
    .object({ reason: z.string(), planned: z.array(PlannedEvalSchema) })
    .nullable()
    .default(null),
  /**
   * Providers whose listing this run recorded as their baseline (their first listing, ADR
   * 0089): none of their models is new in this run. Empty on later runs and on older reports.
   */
  baseline_providers: z.array(z.string()).default([]),
  /**
   * `provider/id` of the models evaluated as candidates because they were named (`--model`,
   * or an "evaluate" answer on a report), not because they were news. Empty by default.
   */
  forced_candidates: z.array(z.string()).default([]),
  /** Earlier pending reports this run closed because the baseline now holds their new models. */
  closed_requests: z.number().int().nonnegative().default(0),
  skipped: z.array(z.string()),
  summary: z.string(),
});
export type ModelWatchReport = z.infer<typeof ModelWatchReportSchema>;

/** What the updates screen lists (spec M.5). */
export const ModelWatchReportSummarySchema = z.object({
  id: z.string(),
  generated_at: z.string(),
  status: z.string(),
  decision: z.string(),
  request_id: z.string().nullable(),
  decided_at: z.string().nullable(),
  recommendations: z.number().int().nonnegative(),
  new_models: z.number().int().nonnegative(),
  retired_models: z.number().int().nonnegative(),
  repriced: z.number().int().nonnegative(),
  summary: z.string(),
});
export type ModelWatchReportSummary = z.infer<typeof ModelWatchReportSummarySchema>;

/** What the release row's `health` column carries for a model watch report. */
export interface ModelWatchHealth {
  decision: "pending" | "nothing_to_decide" | "adopted" | "evaluate" | "ignored" | "remind";
  request_id: string | null;
  decided_at: string | null;
  by: string | null;
  applied: string[];
  remind_at: string | null;
}

// ---------------------------------------------------------------------------------------
// Pure maths (exported for tests and for the report renderer)
// ---------------------------------------------------------------------------------------

/** Percent change from `before` to `after`; null when `before` is 0 (nothing to compare against). */
export function pctDelta(before: number, after: number): number | null {
  if (!(before > 0)) return null;
  return round2(((after - before) / before) * 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function signed(n: number | null, unit: string): string {
  if (n === null) return "n/a";
  return `${n > 0 ? "+" : ""}${round2(n)}${unit}`;
}

export function effortBelow(effort: EffortLevel): EffortLevel | null {
  const i = EFFORT_VALUES.indexOf(effort);
  return i > 0 ? (EFFORT_VALUES[i - 1] ?? null) : null;
}

export interface PriceDiff {
  repriced: Omit<RepriceRecommendation, "id" | "kind" | "text">[];
  proposal: Record<string, PricingProposalRow>;
}

const PRICE_FIELDS = [
  "input_per_mtok_usd",
  "output_per_mtok_usd",
  "cache_read_per_mtok_usd",
  "cache_write_per_mtok_usd",
] as const;

/** Price changes between the effective table and the price list, and the override rows that fix them. */
export function diffPrices(
  table: PricingTable,
  list: PriceList,
  thresholds: WatchThresholds = DEFAULT_WATCH_THRESHOLDS,
): PriceDiff {
  const repriced: PriceDiff["repriced"] = [];
  const proposal: Record<string, PricingProposalRow> = {};
  for (const [id, entry] of Object.entries(list.models)) {
    const existing = table[id];
    if (!existing) continue;
    const changes: PriceDiff["repriced"][number]["changes"] = [];
    for (const field of PRICE_FIELDS) {
      const after = entry[field];
      if (after === undefined) continue;
      const before = existing[field];
      const delta = pctDelta(before, after);
      const changed =
        delta === null ? after !== before : Math.abs(delta) >= thresholds.repriceMinDeltaPct;
      if (changed) changes.push({ field, before, after, delta_pct: delta });
    }
    if (changes.length === 0) continue;
    repriced.push({ model: id, changes });
    const row: PricingProposalRow = {
      as_of: list.as_of,
      source: "list",
      notes: `model watch: price list${list.source ? ` ${list.source}` : ""} as of ${list.as_of}`,
    };
    for (const c of changes) row[c.field] = c.after;
    proposal[id] = row;
  }
  return { repriced, proposal };
}

/** A full price row for a model the price list knows and the table does not. Cache prices follow the list multipliers. */
export function priceRowFromList(list: PriceList, modelId: string): PriceRow | null {
  const entry = list.models[canonicalModelId(modelId)];
  if (!entry) return null;
  return {
    input_per_mtok_usd: entry.input_per_mtok_usd,
    output_per_mtok_usd: entry.output_per_mtok_usd,
    cache_read_per_mtok_usd:
      entry.cache_read_per_mtok_usd ?? round6(entry.input_per_mtok_usd * CACHE_READ_SHARE),
    cache_write_per_mtok_usd:
      entry.cache_write_per_mtok_usd ?? round6(entry.input_per_mtok_usd * CACHE_WRITE_SHARE),
    as_of: list.as_of,
    source: "list",
  };
}

export interface ModelDiff {
  new_models: ModelWatchReport["diff"]["new_models"];
  retired_models: ModelWatchReport["diff"]["retired_models"];
  unpriced: ModelWatchReport["diff"]["unpriced"];
}

/**
 * New and retired models per provider against the ladder; prices from the table or the list,
 * never assumed. `known` names listed models that are not news (the provider's baseline, the
 * install's own price table, ADR 0089): they are neither new nor unpriced.
 */
export function diffModels(
  listed: Record<string, ModelRef[]>,
  ladder: LadderRung[],
  table: PricingTable,
  list: PriceList | null,
  known: (provider: string, modelId: string) => boolean = () => false,
): ModelDiff {
  const out: ModelDiff = { new_models: [], retired_models: [], unpriced: [] };
  for (const [provider, models] of Object.entries(listed)) {
    const onLadder = new Set(
      ladder.map((r) => r.models[provider]).filter((m): m is string => typeof m === "string"),
    );
    const ids = new Set(models.map((m) => m.id));
    for (const m of models) {
      if (onLadder.has(m.id)) continue;
      if (known(provider, m.id)) continue;
      const key = canonicalModelId(m.id);
      const tableRow = table[key];
      if (tableRow) {
        out.new_models.push({
          provider,
          id: m.id,
          tier: m.tier,
          priced: true,
          price_origin: "table",
          price: {
            input_per_mtok_usd: tableRow.input_per_mtok_usd,
            output_per_mtok_usd: tableRow.output_per_mtok_usd,
            cache_read_per_mtok_usd: tableRow.cache_read_per_mtok_usd,
            cache_write_per_mtok_usd: tableRow.cache_write_per_mtok_usd,
            as_of: tableRow.as_of,
            source: tableRow.source,
          },
        });
        continue;
      }
      const listRow = list ? priceRowFromList(list, m.id) : null;
      if (listRow) {
        out.new_models.push({
          provider,
          id: m.id,
          tier: m.tier,
          priced: true,
          price_origin: "price_list",
          price: listRow,
        });
        continue;
      }
      out.new_models.push({
        provider,
        id: m.id,
        tier: m.tier,
        priced: false,
        price_origin: "none",
        price: null,
      });
      out.unpriced.push({ provider, id: m.id, tier: m.tier });
    }
    for (const rung of ladder) {
      const id = rung.models[provider];
      if (id && !ids.has(id)) {
        out.retired_models.push({ provider, id, tier: rung.tier, rung_affected: true });
      }
    }
  }
  return out;
}

export interface SwitchPair {
  target: EvalTarget;
  baseline: EvalObservation;
  candidate: EvalObservation;
}

/** The switch_model rule (ADR 0019). Null when the candidate does not earn a recommendation. */
export function recommendSwitch(
  input: {
    id: string;
    provider: string;
    rung: ModelTier;
    from: string;
    to: string;
    pairs: SwitchPair[];
  },
  thresholds: WatchThresholds = DEFAULT_WATCH_THRESHOLDS,
): SwitchModelRecommendation | null {
  const usable = input.pairs.filter(
    (p) =>
      p.baseline.skipped_reason === null &&
      p.candidate.skipped_reason === null &&
      p.baseline.total >= thresholds.minEvalTasks &&
      p.candidate.total >= thresholds.minEvalTasks,
  );
  if (usable.length === 0) return null;
  const deltas = usable.map((p) => round2((p.candidate.pass_rate - p.baseline.pass_rate) * 100));
  const minQuality = Math.min(...deltas);
  const meanQuality = round2(deltas.reduce((s, d) => s + d, 0) / deltas.length);
  const costBase = usable.reduce((s, p) => s + p.baseline.cost_usd_micro, 0);
  const costCand = usable.reduce((s, p) => s + p.candidate.cost_usd_micro, 0);
  const costDelta = pctDelta(costBase, costCand);
  if (minQuality < -thresholds.qualityTolerancePoints) return null;
  const cheaper = costDelta !== null && costDelta <= -thresholds.minCostSavingPct;
  const better =
    meanQuality >= thresholds.minQualityGainPoints &&
    (costDelta === null || costDelta <= thresholds.maxCostIncreasePct);
  if (!cheaper && !better) return null;
  const evidence = usable.map(
    (p) =>
      `${p.target.specialist}: ${p.candidate.passed}/${p.candidate.total} passed at ${p.candidate.effort} vs ${p.baseline.passed}/${p.baseline.total} on ${p.baseline.model}; cost ${signed(pctDelta(p.baseline.cost_usd_micro, p.candidate.cost_usd_micro), "%")}`,
  );
  return {
    id: input.id,
    kind: "switch_model",
    provider: input.provider,
    rung: input.rung,
    from: input.from,
    to: input.to,
    quality_delta_points: meanQuality,
    min_quality_delta_points: minQuality,
    cost_delta_pct: costDelta,
    evidence,
    text: `Switch rung ${input.rung} on ${input.provider} from ${input.from} to ${input.to}: quality ${signed(meanQuality, " points")}, cost ${signed(costDelta, "%")}`,
  };
}

/** The lower_effort rule (ADR 0019): the lower effort must pass as well as the baseline and save cost. */
export function recommendLowerEffort(
  input: { id: string; target: EvalTarget; baseline: EvalObservation; lower: EvalObservation },
  thresholds: WatchThresholds = DEFAULT_WATCH_THRESHOLDS,
): LowerEffortRecommendation | null {
  const { baseline, lower } = input;
  if (baseline.skipped_reason !== null || lower.skipped_reason !== null) return null;
  if (baseline.total < thresholds.minEvalTasks || lower.total < thresholds.minEvalTasks)
    return null;
  const passes =
    lower.pass_rate * 100 >= baseline.pass_rate * 100 - thresholds.qualityTolerancePoints;
  const costDelta = pctDelta(baseline.cost_usd_micro, lower.cost_usd_micro);
  const saves = costDelta !== null && costDelta <= -thresholds.minEffortSavingPct;
  if (!passes || !saves) return null;
  return {
    id: input.id,
    kind: "lower_effort",
    mode: input.target.mode,
    specialist: input.target.specialist,
    provider: lower.provider,
    model: lower.model,
    from: baseline.effort,
    to: lower.effort,
    pass_rate: lower.pass_rate,
    baseline_pass_rate: baseline.pass_rate,
    cost_delta_pct: costDelta,
    evidence: [
      `${input.target.specialist}: ${lower.passed}/${lower.total} passed at ${lower.effort} vs ${baseline.passed}/${baseline.total} at ${baseline.effort} on ${lower.model}`,
    ],
    text: `Lower effort for mode ${input.target.mode} from ${baseline.effort} to ${lower.effort}: passes ${Math.round(lower.pass_rate * 100)}% at ${signed(costDelta, "%")} cost`,
  };
}

// ---------------------------------------------------------------------------------------
// The watch
// ---------------------------------------------------------------------------------------

export interface ModelWatchDeps {
  clock: Clock;
  store: StateStore;
  providers: ProviderRegistry;
  priceList: PriceListSource;
  evals: EvalRunnerPort;
  approvals: ModelWatchApprovalPort;
  settings: ModelSettingsStore;
  /** Human who owns this install and decides on proposals. */
  humanId: string;
  agentId?: string | null;
  /** Base pricing table; overrides from the settings store are merged on top. Default BUILTIN_PRICING. */
  pricing?: PricingTable;
  /** Built-in ladder and effort table; adopted settings are applied on top. Default: spec D. */
  baseConfig?: EffectiveModelConfig;
  evalTargets?: readonly EvalTarget[];
  /** Provider whose rung models are the baseline and run the lower-effort probes. Default: first with ladder entries. */
  evalProvider?: string;
  /** Providers the watch ignores (e.g. "fake" in production). */
  ignoreProviders?: readonly string[];
  thresholds?: Partial<WatchThresholds>;
  /**
   * Called once after a successful adopt with the pricing table and the ladder/effort config
   * now in force, so the daemon can replace what it loaded at compose without a restart. A
   * hook that throws is logged and audited (`model_watch.reload`, allowed=false); the adoption
   * stands, since the files are already written.
   */
  onAdopted?: (event: ModelWatchAdoptedEvent) => void | Promise<void>;
  /**
   * The human's standing opt-in to paid evals on every run (ADR 0089). Absent, or false: a run
   * makes no eval unless it is asked to (`run({ evals: true })`), and records what it would
   * have run in `evals_deferred`. Read at every run, so a settings change applies at the next.
   */
  autoEvals?: () => boolean | Promise<boolean>;
  /**
   * Called when a human consents to a report's withheld evals: an "evaluate" answer on a
   * pending or reminded report, and nothing else (an adopt never starts a paid run). The
   * daemon runs `run({ evals: true })` in the background; paid runs are single-flight, so an
   * evaluate during a paid run joins it. A hook that throws is logged, the decision stands.
   */
  onEvalsRequested?: (event: ModelWatchEvalsRequestedEvent) => void | Promise<void>;
  /**
   * The owner's stop (the daemon's shutdown): every run is aborted with it, no eval starts
   * after it, and `settled()` resolves once the runs in flight have ended.
   */
  signal?: AbortSignal;
}

/** A human's consent to run the evals a report withheld. */
export interface ModelWatchEvalsRequestedEvent {
  reportId: string;
  by: string;
}

/** What an adopt changed and the tables in force afterwards (settings store already written). */
export interface ModelWatchAdoptedEvent {
  reportId: string;
  /** The human whose recorded answer was applied. */
  by: string;
  /** Human-readable descriptions of what was changed (same as ModelWatchResolveResult.applied). */
  applied: string[];
  /** Base pricing plus the overrides file as just written. */
  pricing: PricingTable;
  /** Built-in ladder and effort table plus the model settings as just written. */
  config: EffectiveModelConfig;
}

export interface ModelWatchRunResult {
  report: ModelWatchReport;
  release: ReleaseRow;
  decision: ModelWatchHealth["decision"];
  requestId: string | null;
  /** Human-readable descriptions of what was changed (only after an adopt). */
  applied: string[];
}

export interface ModelWatchResolveResult {
  release: ReleaseRow;
  decision: ModelWatchHealth["decision"];
  applied: string[];
}

export const EVALS_DEFERRED_REASON =
  "paid evals need the human's consent: answer 'evaluate', run evaluations, or turn on the model_watch run_evals setting";

export class ModelWatch {
  readonly thresholds: WatchThresholds;
  private readonly inFlight = new Set<Promise<unknown>>();
  /**
   * Paid runs in flight or queued, oldest first (single flight, ADR 0089): one runs at a time.
   * A paid run asked for joins the oldest one whose named candidates cover its own (a plain
   * run names none, so it joins the first); one that names more waits for the last to end.
   */
  private paidRuns: { run: Promise<ModelWatchRunResult>; named: Set<string>; started: boolean }[] =
    [];
  /** Serialises the paid-or-free decision of each run in call order. */
  private decisions: Promise<void> = Promise.resolve();
  /** Whether `syncPendingAnswers` withdrew the open cards of decided reports in this process. */
  private staleCardsSwept = false;

  constructor(private readonly deps: ModelWatchDeps) {
    this.thresholds = { ...DEFAULT_WATCH_THRESHOLDS, ...(deps.thresholds ?? {}) };
    for (const [k, v] of Object.entries(this.thresholds)) {
      if (!Number.isFinite(v) || v < 0) {
        throw new ForerunnerError("validation", `model watch threshold ${k} must be >= 0`, {
          details: { threshold: k, value: String(v) },
        });
      }
    }
  }

  /** The ladder and effort table in force: built-ins plus adopted settings. */
  async effectiveConfig(): Promise<{ config: EffectiveModelConfig; settings: ModelSettings }> {
    const settings = await this.deps.settings.readModelSettings();
    const config = applyModelSettings(settings, this.deps.baseConfig ?? builtinModelConfig());
    return { config, settings };
  }

  /** The pricing table in force: base plus the overrides file. */
  async effectivePricing(): Promise<PricingTable> {
    const overrides = await this.deps.settings.readPricingOverrides();
    return mergePricing(this.deps.pricing ?? BUILTIN_PRICING, overrides);
  }

  /**
   * One weekly run. Never throws for a provider or price list failure: those land in the
   * report. Paid evals run only with consent (ADR 0089): `evals: true` is an explicit "run
   * evaluations"; unset, the human's `autoEvals` setting decides (default off); `false` never.
   * An abort (the caller's or the owner's signal) ends the run without a report.
   *
   * `models` (`provider/id`) and `forReport` (the candidates of that report) name models to
   * evaluate as candidates even when they are not news, e.g. a model in the baseline. Naming
   * one is a paid request: it needs `evals: true` and is refused (`validation`) without it.
   */
  run(
    opts: { signal?: AbortSignal; evals?: boolean; models?: string[]; forReport?: string } = {},
  ): Promise<ModelWatchRunResult> {
    const named = new Set([
      ...(opts.models ?? []),
      ...(opts.forReport ? [`report:${opts.forReport}`] : []),
    ]);
    if (named.size && opts.evals !== true) {
      return Promise.reject(
        new ForerunnerError(
          "validation",
          "naming a model to evaluate runs paid evals: it needs evals: true (fr models watch --evals --model <provider/id>)",
          { details: { models: [...named] } },
        ),
      );
    }
    const signals = [opts.signal, this.deps.signal].filter((x): x is AbortSignal => !!x);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    // Decide paid or free in call order (a chain), so that two runs asked for at once see each
    // other: a paid run while one is in flight joins it instead of starting a second one.
    // The chain carries the run in a box: it must not wait for the run itself to end.
    const decided = this.decisions.then(
      async (): Promise<{ run: Promise<ModelWatchRunResult> }> => {
        const paid =
          opts.evals ?? (this.deps.autoEvals ? (await this.deps.autoEvals()) === true : false);
        // The names are read when the run starts, so names merged into a queued run count.
        const startWith = (names: Set<string>) => () =>
          this.runOnce({
            signal,
            evals: paid,
            models: [...names].filter((n) => !n.startsWith("report:")),
            forReports: [...names]
              .filter((n) => n.startsWith("report:"))
              .map((n) => n.slice("report:".length)),
          });
        if (!paid) return { run: startWith(named)() };
        const covering = this.paidRuns.find((e) => [...named].every((n) => e.named.has(n)));
        if (covering) return { run: covering.run };
        // At most one run waits behind the one in flight: new names join the waiting one.
        const waiting = this.paidRuns.find((e) => !e.started);
        if (waiting) {
          for (const n of named) waiting.named.add(n);
          return { run: waiting.run };
        }
        const last = this.paidRuns.at(-1);
        const entry: { run: Promise<ModelWatchRunResult>; named: Set<string>; started: boolean } = {
          run: Promise.resolve() as never,
          named: new Set(named),
          started: false,
        };
        const start = () => {
          entry.started = true;
          return startWith(entry.named)();
        };
        const run = last ? last.run.then(start, start) : start();
        entry.run = run;
        this.paidRuns.push(entry);
        const clear = () => {
          this.paidRuns = this.paidRuns.filter((e) => e !== entry);
        };
        void run.then(clear, clear);
        return { run };
      },
    );
    this.decisions = decided.then(
      () => undefined,
      () => undefined,
    );
    const p = decided.then((box) => box.run);
    this.inFlight.add(p);
    void p.then(
      () => this.inFlight.delete(p),
      () => this.inFlight.delete(p),
    );
    return p;
  }

  /** Resolves once every run started so far (and any it requested) has ended, either way. */
  async settled(): Promise<void> {
    while (this.inFlight.size) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private async runOnce(opts: {
    signal?: AbortSignal;
    evals?: boolean;
    models: string[];
    forReports: string[];
  }): Promise<ModelWatchRunResult> {
    const { clock, store } = this.deps;
    throwIfStopped(opts.signal);
    const evalsAllowed = opts.evals === true;
    const planned: PlannedEval[] = [];
    const id = newId(clock.now());
    const skipped: string[] = [];
    const { config } = await this.effectiveConfig();
    const pricing = await this.effectivePricing();

    // 1. Price list and provider listings.
    let priceList: PriceList | null = null;
    let priceListError: string | null = null;
    try {
      priceList = await this.deps.priceList.fetch(opts.signal);
      await this.audit("model_watch.price_list", `source ${this.deps.priceList.name}`, {
        result: `${Object.keys(priceList.models).length} model(s) as of ${priceList.as_of}`,
      });
    } catch (e) {
      priceListError = errorMessage(e);
      skipped.push(`price list: ${priceListError}`);
      await this.audit("model_watch.price_list", `source ${this.deps.priceList.name}`, {
        result: priceListError,
        allowed: false,
      });
    }
    const ignore = new Set(this.deps.ignoreProviders ?? []);
    const providers: ModelWatchReport["providers"] = [];
    const listed: Record<string, ModelRef[]> = {};
    for (const name of this.deps.providers.names()) {
      if (ignore.has(name)) continue;
      try {
        const models = await this.deps.providers.get(name).listModels();
        listed[name] = models;
        providers.push({
          name,
          listed: models.map((m) => ({ id: m.id, tier: m.tier })),
          error: null,
        });
      } catch (e) {
        providers.push({ name, listed: [], error: errorMessage(e) });
        skipped.push(`provider ${name}: ${errorMessage(e)}`);
      }
    }

    // 2. Diffs. What is news (ADR 0089): a listed model that is not on the ladder and not in the
    // provider's baseline (its first listing). The price table does not decide it.
    // A provider without a baseline row on an install that has reports (one from before the
    // baseline rule) takes the listing of the earliest report that listed it. A provider
    // never listed before records this run's listing: none of its models is news in this
    // run. A run where every listed provider does so is a baseline run: it runs no eval and
    // asks nothing, whatever the opt-in says, unless models are named for evaluation.
    const baselines = await readModelWatchBaselines(store);
    await this.seedBaselinesFromReports(
      Object.keys(listed).filter((p) => !baselines.has(p)),
      baselines,
    );
    const baselineProviders = Object.keys(listed).filter((p) => !baselines.has(p));
    const named = await this.namedCandidates(opts.models, opts.forReports);
    const baselineRun =
      named.length === 0 &&
      baselineProviders.length > 0 &&
      baselineProviders.length === Object.keys(listed).length;
    const known = (provider: string, modelId: string): boolean =>
      baselineProviders.includes(provider) ||
      (baselines.get(provider)?.has(canonicalModelId(modelId)) ?? false);
    const modelDiff = diffModels(listed, config.ladder, pricing, priceList, known);
    if (baselineRun)
      skipped.push(
        "baseline run: the model listing is recorded; evals and requests start with the next run",
      );
    // Named candidates: listed, off the ladder, priced; evaluated whether news or not.
    const forced: ModelDiff["new_models"] = [];
    for (const name of named) {
      const slash = name.indexOf("/");
      const provider = slash > 0 ? name.slice(0, slash) : "";
      const modelId = slash > 0 ? name.slice(slash + 1) : "";
      const ref = (listed[provider] ?? []).find(
        (m) => canonicalModelId(m.id) === canonicalModelId(modelId),
      );
      if (!provider || !modelId) {
        skipped.push(`candidate ${name}: expected provider/model`);
        continue;
      }
      if (!ref) {
        skipped.push(`candidate ${name}: not listed by ${provider}`);
        continue;
      }
      if (config.ladder.some((r) => r.models[provider] === ref.id)) {
        skipped.push(`candidate ${name}: already on the ladder`);
        continue;
      }
      if (forced.some((f) => f.provider === provider && f.id === ref.id)) continue;
      const already = modelDiff.new_models.find((m) => m.provider === provider && m.id === ref.id);
      const entry =
        already ?? diffModels({ [provider]: [ref] }, [], pricing, priceList).new_models[0];
      if (!entry?.priced) {
        skipped.push(`candidate ${name}: no price (add a pricing.json row or a price list)`);
        continue;
      }
      forced.push(entry);
    }
    const forcedNames = forced.map((m) => `${m.provider}/${m.id}`);
    const candidates = [
      ...modelDiff.new_models,
      ...forced.filter((f) => !modelDiff.new_models.includes(f)),
    ];
    const priceDiff = priceList
      ? diffPrices(pricing, priceList, this.thresholds)
      : { repriced: [], proposal: {} };
    const pricingProposal: Record<string, PricingProposalRow> = { ...priceDiff.proposal };
    for (const m of candidates) {
      if (m.price_origin === "price_list" && m.price) {
        pricingProposal[canonicalModelId(m.id)] = {
          input_per_mtok_usd: m.price.input_per_mtok_usd,
          output_per_mtok_usd: m.price.output_per_mtok_usd,
          cache_read_per_mtok_usd: m.price.cache_read_per_mtok_usd,
          cache_write_per_mtok_usd: m.price.cache_write_per_mtok_usd,
          as_of: m.price.as_of,
          source: "list",
          notes: `model watch: new model on ${m.provider}, price list as of ${m.price.as_of}`,
        };
      }
    }

    // 3. Evals under a hard budget. Candidates are costed with their proposed price rows.
    const evalPricing = mergePricing(pricing, pricingProposal);
    const evals: EvalObservation[] = [];
    let evalSpent = 0;
    let halted: ForerunnerError | null = null;
    const cache = new Map<string, EvalObservation>();
    const observe = async (
      base: Omit<
        EvalObservation,
        | "total"
        | "passed"
        | "failed"
        | "needs_model"
        | "pass_rate"
        | "cost_usd_micro"
        | "duration_ms"
        | "skipped_reason"
      >,
    ): Promise<EvalObservation> => {
      const key = `${base.specialist}|${base.provider}|${base.model}|${base.effort}`;
      const hit = cache.get(key);
      if (hit) return { ...hit, role: base.role, mode: base.mode, tier: base.tier };
      const unrun = (reason: string): EvalObservation => ({
        ...base,
        total: 0,
        passed: 0,
        failed: 0,
        needs_model: 0,
        pass_rate: 0,
        cost_usd_micro: 0,
        duration_ms: 0,
        skipped_reason: reason,
      });
      if (!evalsAllowed) {
        // No consent: plan it, run nothing. The placeholder never feeds a recommendation.
        const deferred = unrun("deferred: no consent to paid evals");
        planned.push({
          specialist: base.specialist,
          mode: base.mode,
          provider: base.provider,
          model: base.model,
          tier: base.tier,
          effort: base.effort,
          role: base.role,
        });
        cache.set(key, deferred);
        return deferred;
      }
      throwIfStopped(opts.signal);
      let obs: EvalObservation;
      try {
        if (halted) throw halted;
        this.guardEvalBudget(evalSpent, `${base.specialist} on ${base.model} at ${base.effort}`);
        const out = await this.deps.evals.run({
          specialist: base.specialist,
          provider: base.provider,
          model: base.model,
          effort: base.effort,
          pricing: evalPricing,
          signal: opts.signal,
        });
        evalSpent += Math.max(0, Math.round(out.costUsdMicro));
        obs = {
          ...base,
          total: out.total,
          passed: out.passed,
          failed: out.failed,
          needs_model: out.needsModel,
          pass_rate: out.passRate,
          cost_usd_micro: Math.max(0, Math.round(out.costUsdMicro)),
          duration_ms: Math.max(0, Math.round(out.durationMs)),
          skipped_reason: null,
        };
        await this.audit(
          "model_watch.eval",
          `${base.specialist} on ${base.provider}/${base.model} at ${base.effort} (${base.role})`,
          {
            result: `${out.passed}/${out.total} passed`,
            cost: obs.cost_usd_micro,
          },
        );
      } catch (e) {
        // Stopped (the daemon is closing, the kill switch): no report, no further eval.
        throwIfStopped(opts.signal);
        const code = e instanceof ForerunnerError ? e.code : "internal";
        // A cap stop or a kill applies to every later eval too: none reaches the runner.
        if (e instanceof ForerunnerError && (code === "budget_exceeded" || code === "killed"))
          halted = e;
        const reason = `${code}: ${errorMessage(e)}`;
        obs = unrun(reason);
        skipped.push(`eval ${base.specialist} on ${base.model} at ${base.effort}: ${reason}`);
      }
      cache.set(key, obs);
      evals.push(obs);
      return obs;
    };

    const targets = this.deps.evalTargets ?? DEFAULT_EVAL_TARGETS;
    const evalProvider =
      this.deps.evalProvider ??
      Object.keys(listed).find((p) => config.ladder.some((r) => r.models[p] !== undefined)) ??
      null;
    const rungModel = (tier: ModelTier, provider: string): string | null =>
      config.ladder.find((r) => r.tier === tier)?.models[provider] ?? null;

    const recommendations: Recommendation[] = [];
    let seq = 0;
    const nextId = (kind: string) => `${kind}-${++seq}`;

    // 3a. Baselines and lower-effort probes per target (none in a baseline run).
    const baselineEvals = new Map<string, EvalObservation>();
    if (baselineRun) {
      // Nothing to evaluate: no candidate, and no request would carry a probe's result.
    } else if (evalProvider) {
      for (const target of targets) {
        const md = config.modeDefaults[target.mode];
        const model = rungModel(md.tier, evalProvider);
        if (!model) {
          skipped.push(`target ${target.specialist}: no ${md.tier} model on ${evalProvider}`);
          continue;
        }
        const baseline = await observe({
          specialist: target.specialist,
          mode: target.mode,
          provider: evalProvider,
          model,
          tier: md.tier,
          effort: md.effort,
          role: "baseline",
        });
        baselineEvals.set(`${target.specialist}|${md.tier}|${evalProvider}`, baseline);
        const lowerEffort = effortBelow(md.effort);
        if (!lowerEffort) continue;
        const lower = await observe({
          specialist: target.specialist,
          mode: target.mode,
          provider: evalProvider,
          model,
          tier: md.tier,
          effort: lowerEffort,
          role: "lower_effort",
        });
        const rec = recommendLowerEffort(
          { id: nextId("lower-effort"), target, baseline, lower },
          this.thresholds,
        );
        if (rec) recommendations.push(rec);
      }
    } else {
      skipped.push("evals: no provider with ladder entries is registered");
    }

    // 3b. Candidates: every priced new model, on every target, against the same rung's model.
    for (const cand of candidates) {
      if (!cand.priced) continue;
      const from = rungModel(cand.tier, cand.provider);
      if (!from) {
        skipped.push(`candidate ${cand.id}: no ${cand.tier} rung model on ${cand.provider}`);
        continue;
      }
      const pairs: SwitchPair[] = [];
      for (const target of targets) {
        const md = config.modeDefaults[target.mode];
        const bKey = `${target.specialist}|${cand.tier}|${cand.provider}`;
        let baseline = baselineEvals.get(bKey);
        if (!baseline) {
          baseline = await observe({
            specialist: target.specialist,
            mode: target.mode,
            provider: cand.provider,
            model: from,
            tier: cand.tier,
            effort: md.effort,
            role: "baseline",
          });
          baselineEvals.set(bKey, baseline);
        }
        const candidate = await observe({
          specialist: target.specialist,
          mode: target.mode,
          provider: cand.provider,
          model: cand.id,
          tier: cand.tier,
          effort: md.effort,
          role: "candidate",
        });
        pairs.push({ target, baseline, candidate });
      }
      const rec = recommendSwitch(
        {
          id: nextId("switch"),
          provider: cand.provider,
          rung: cand.tier,
          from,
          to: cand.id,
          pairs,
        },
        this.thresholds,
      );
      if (rec) recommendations.push(rec);
    }

    // 3c. Repricing is always proposed, never applied.
    for (const r of priceDiff.repriced) {
      recommendations.push({
        id: nextId("reprice"),
        kind: "reprice",
        model: r.model,
        changes: r.changes,
        text: `Reprice ${r.model}: ${r.changes
          .map((c) => `${c.field} ${c.before ?? "n/a"} -> ${c.after} (${signed(c.delta_pct, "%")})`)
          .join(", ")}`,
      });
    }

    // 4. Report, persistence, decision.
    const report: ModelWatchReport = ModelWatchReportSchema.parse({
      version: 1,
      id,
      generated_at: clock.nowIso(),
      price_list: {
        source: this.deps.priceList.name,
        as_of: priceList?.as_of ?? null,
        models: priceList ? Object.keys(priceList.models).length : 0,
        error: priceListError,
      },
      providers,
      diff: {
        new_models: modelDiff.new_models,
        retired_models: modelDiff.retired_models,
        repriced: priceDiff.repriced,
        unpriced: modelDiff.unpriced,
      },
      evals,
      recommendations,
      pricing_proposal: pricingProposal,
      eval_cost_usd_micro: evalSpent,
      eval_budget_usd_micro: this.thresholds.evalBudgetUsdMicro,
      evals_deferred:
        !evalsAllowed && planned.length ? { reason: EVALS_DEFERRED_REASON, planned } : null,
      baseline_providers: baselineProviders,
      forced_candidates: forcedNames,
      skipped,
      summary: "",
    });
    report.summary = summarizeReport(report);

    throwIfStopped(opts.signal);
    // Withheld evals alone ask the human only when they would test something new (a candidate);
    // the weekly lower-effort probes never nag, and a candidate the human already ignored with
    // its evals withheld is not asked about again, nor is its new price row (ADR 0089).
    const ignored = report.evals_deferred
      ? await this.ignoredDeferredCandidates()
      : new Set<string>();
    const isIgnored = (provider: string, model: string) =>
      ignored.has(`${provider}/${canonicalModelId(model)}`);
    const ignoredRows = new Set(
      modelDiff.new_models
        .filter((m) => m.price_origin === "price_list" && isIgnored(m.provider, m.id))
        .map((m) => canonicalModelId(m.id)),
    );
    // A baseline run asks nothing (ADR 0089): what it found is the starting point, not news.
    const needsDecision =
      !baselineRun &&
      (report.recommendations.length > 0 ||
        Object.keys(report.pricing_proposal).some((k) => !ignoredRows.has(k)) ||
        (report.evals_deferred?.planned.some(
          (p) => p.role === "candidate" && !isIgnored(p.provider, p.model),
        ) ??
          false));
    let health: ModelWatchHealth = {
      decision: needsDecision ? "pending" : "nothing_to_decide",
      request_id: null,
      decided_at: null,
      by: null,
      applied: [],
      remind_at: null,
    };
    let release = await store.release.insert({
      release_version: report.id,
      channel: MODEL_WATCH_CHANNEL,
      changelog: report.summary,
      signature: "",
      status: "draft",
      artifacts: [report as unknown as JsonValue],
      published_at: null,
      health: health as unknown as JsonValue,
      author_agent: this.deps.agentId ?? null,
      author_human: null,
    });
    await this.audit("model_watch.report", `report ${report.id}`, {
      result: report.summary,
      cost: evalSpent,
    });
    release = await store.release.setStatus(
      release.id,
      release.version,
      "published",
      health as unknown as JsonValue,
    );
    // The report is stored: record the first listing of every provider that had none.
    for (const provider of baselineProviders) {
      await recordModelWatchBaseline(store, {
        provider,
        models: listed[provider] ?? [],
        reportId: report.id,
        agentId: this.deps.agentId ?? null,
      });
      await this.audit("model_watch.baseline", `provider ${provider}`, {
        result: `${listed[provider]?.length ?? 0} model(s) recorded as the baseline`,
      });
      baselines.set(provider, new Set((listed[provider] ?? []).map((m) => canonicalModelId(m.id))));
    }
    // A baseline can make older requests moot: close those it covers. Not only after a seed
    // here: a boot that stopped between seed and close, or one that skipped it while sync was
    // paused, leaves covered requests that this run closes.
    if (baselines.size) {
      const closed = await this.closeCoveredRequests(baselines, report.id);
      if (closed) {
        report.closed_requests = closed;
        report.summary = summarizeReport(report);
        release = await store.release.patch(release.id, {
          changelog: report.summary,
          artifacts: [report as unknown as JsonValue],
        });
      }
    }
    if (!needsDecision) {
      return { report, release, decision: health.decision, requestId: null, applied: [] };
    }

    const outcome = await this.ask(report);
    if (outcome.status === "pending") {
      health = { ...health, request_id: outcome.requestId };
      release = await store.release.patch(release.id, { health: health as unknown as JsonValue });
      return { report, release, decision: "pending", requestId: outcome.requestId, applied: [] };
    }
    const resolved = await this.resolve(report.id, outcome.answer);
    return {
      report,
      release: resolved.release,
      decision: resolved.decision,
      requestId: null,
      applied: resolved.applied,
    };
  }

  /** Put the report's question to the human (the Inbox card in production) and audit it. */
  private async ask(report: ModelWatchReport, note?: string): Promise<ModelWatchApprovalOutcome> {
    const outcome = await this.deps.approvals.ask({
      reportId: report.id,
      humanId: this.deps.humanId,
      summary: report.summary,
      options: report.evals_deferred
        ? ["adopt", "evaluate", "ignore", "remind"]
        : ["adopt", "ignore", "remind"],
      recommendations: report.recommendations,
      pricingProposal: report.pricing_proposal,
      steps: proposalSteps(report),
    });
    const result =
      outcome.status === "pending" ? `pending (${outcome.requestId ?? "no id"})` : "answered";
    await this.audit("model_watch.request", `report ${report.id}`, {
      result: note ? `${note}: ${result}` : result,
    });
    return outcome;
  }

  /**
   * Take the report's card out of the Inbox while it is still open: the question was decided
   * elsewhere (the Updates page), so a click there would do nothing (U-035). An answered card
   * is left as it is. A failure is logged; the decision stands.
   */
  private async closeRequest(reportId: string, requestId: string | null): Promise<boolean> {
    if (!requestId) return false;
    const { store } = this.deps;
    try {
      const req = await store.humanRequest.get(requestId);
      if (req?.status !== "open") return false;
      await store.humanRequest.withdraw(req.id, req.version);
      return true;
    } catch (e) {
      logger.warn("model watch request not withdrawn", {
        reportId,
        requestId,
        error: errorMessage(e),
      });
      return false;
    }
  }

  /**
   * Apply a human's answer to a report. "adopt" writes the pricing overrides and the model
   * settings; "ignore" and "remind" only record the decision ("remind" sets `remind_at` a week
   * out, and `fileDueReminders` asks again then). A report that was already adopted cannot be
   * decided again. The answer may come from the Inbox card (`syncPendingAnswers`) or from the
   * Updates page; once it is recorded the card leaves the Inbox if it is still open (U-035).
   */
  async resolve(reportId: string, answer: ModelWatchAnswer): Promise<ModelWatchResolveResult> {
    const { store, clock } = this.deps;
    const release = await this.releaseFor(reportId);
    const report = reportFromRelease(release);
    const health = healthOf(release);
    if (health.decision === "adopted") {
      throw new ForerunnerError(
        "validation",
        `model watch report ${reportId} was already adopted`,
        {
          details: { reportId },
        },
      );
    }
    const now = clock.nowIso();
    let next: ModelWatchHealth;
    let applied: string[] = [];
    if (answer.decision === "evaluate") {
      if (!answer.by) {
        throw new ForerunnerError(
          "approval_required",
          "running the model watch evals costs money and needs a human's recorded answer",
          { details: { reportId } },
        );
      }
      // One paid run per answer: only an open (or reminded) report can be sent to evaluation.
      if (health.decision !== "pending" && health.decision !== "remind") {
        throw new ForerunnerError(
          "validation",
          `model watch report ${reportId} is ${health.decision}; only a pending or reminded report can be evaluated`,
          { details: { reportId, decision: health.decision } },
        );
      }
      next = { ...health, decision: "evaluate", decided_at: now, by: answer.by };
    } else if (answer.decision === "adopt") {
      applied = await this.applyAdoption(report, answer);
      next = {
        ...health,
        decision: "adopted",
        decided_at: now,
        by: answer.by ?? null,
        applied,
        remind_at: null,
      };
    } else if (answer.decision === "ignore") {
      next = { ...health, decision: "ignored", decided_at: now, by: answer.by ?? null };
    } else if (answer.decision === "remind") {
      next = {
        ...health,
        decision: "remind",
        decided_at: now,
        by: answer.by ?? null,
        remind_at: new Date(clock.now() + WEEK_MINUTES * 60_000).toISOString(),
      };
    } else {
      throw new ForerunnerError(
        "validation",
        `unknown model watch decision "${String(answer.decision)}"`,
      );
    }
    let updated: ReleaseRow;
    if (answer.decision === "adopt") {
      const current = await store.release.mustGet(release.id);
      updated = await store.release.setStatus(
        current.id,
        current.version,
        "installed",
        next as unknown as JsonValue,
      );
    } else {
      updated = await store.release.patch(release.id, { health: next as unknown as JsonValue });
    }
    // Decided on the Updates page: the Inbox card is the same question and leaves the Inbox.
    await this.closeRequest(reportId, health.request_id);
    await this.audit("model_watch.decision", `report ${reportId}: ${answer.decision}`, {
      result: applied.length ? applied.join("; ") : answer.decision,
      humanId: answer.by,
    });
    if (answer.decision === "adopt" && answer.by && this.deps.onAdopted) {
      await this.notifyAdopted({ reportId, by: answer.by, applied });
    }
    // Consent to the withheld evals is "evaluate" and nothing else: an adopt ("yes", "ok",
    // "approve") applies the report's rows and never starts a paid run (ADR 0089).
    if (answer.by && answer.decision === "evaluate") {
      await this.requestEvals({ reportId, by: answer.by });
    }
    return { release: updated, decision: next.decision, applied };
  }

  /** `provider/model` of the candidates of reports the human ignored with their evals withheld. */
  private async ignoredDeferredCandidates(): Promise<Set<string>> {
    const rows = await this.deps.store.release.list(
      { channel: MODEL_WATCH_CHANNEL },
      { orderBy: "created_at desc", limit: 200 },
    );
    const out = new Set<string>();
    for (const row of rows) {
      if (healthOf(row).decision !== "ignored") continue;
      let report: ModelWatchReport;
      try {
        report = reportFromRelease(row);
      } catch {
        continue;
      }
      for (const p of report.evals_deferred?.planned ?? [])
        if (p.role === "candidate") out.add(`${p.provider}/${canonicalModelId(p.model)}`);
    }
    return out;
  }

  private async requestEvals(event: ModelWatchEvalsRequestedEvent): Promise<void> {
    await this.audit("model_watch.evals_requested", `report ${event.reportId}`, {
      result: this.deps.onEvalsRequested ? "requested" : "no runner wired",
      humanId: event.by,
    });
    try {
      await this.deps.onEvalsRequested?.(event);
    } catch (e) {
      logger.warn("model watch evals request failed", {
        reportId: event.reportId,
        error: errorMessage(e),
      });
    }
  }

  /** Hand the tables now in force to the daemon; a failing hook never undoes the adoption. */
  private async notifyAdopted(info: { reportId: string; by: string; applied: string[] }) {
    const hook = this.deps.onAdopted;
    if (!hook) return;
    try {
      const { config } = await this.effectiveConfig();
      const pricing = await this.effectivePricing();
      await hook({ ...info, pricing, config });
      await this.audit("model_watch.reload", `report ${info.reportId}`, {
        result: "adopted pricing and model settings handed to the runtime",
        humanId: info.by,
      });
    } catch (e) {
      const message = errorMessage(e);
      logger.warn("model watch reload hook failed; adoption stands, restart to apply", {
        reportId: info.reportId,
        error: message,
      });
      await this.audit("model_watch.reload", `report ${info.reportId}`, {
        result: message,
        allowed: false,
        humanId: info.by,
      });
    }
  }

  /**
   * Close the loop for reports whose HumanRequest was answered since the last check (the
   * production approval port returns "pending"). Returns the number of reports resolved. The
   * first call in a process also withdraws the cards of reports already decided (1.0.4 left a
   * card open when the Updates page decided its report, and a click there did nothing; U-035).
   */
  async syncPendingAnswers(): Promise<number> {
    const { store } = this.deps;
    const sweep = !this.staleCardsSwept;
    this.staleCardsSwept = true;
    const rows = await store.release.list(
      sweep
        ? { channel: MODEL_WATCH_CHANNEL }
        : { channel: MODEL_WATCH_CHANNEL, status: "published" },
      { orderBy: "created_at desc", limit: 50 },
    );
    let resolved = 0;
    for (const row of rows) {
      const health = healthOf(row);
      if (!health.request_id) continue;
      if (health.decision !== "pending") {
        if (sweep) await this.closeRequest(row.release_version, health.request_id);
        continue;
      }
      const req = await store.humanRequest.get(health.request_id);
      if (req?.status !== "answered") continue;
      const answer = answerFromHumanRequest(req);
      if (!answer) {
        logger.warn("unreadable model watch answer", { requestId: req.id });
        continue;
      }
      await this.resolve(row.release_version, answer);
      resolved += 1;
    }
    return resolved;
  }

  /**
   * "Remind me" (U-035): each report the human put off whose `remind_at` has passed is asked
   * again, once. The report is pending again first, under its row version, so a second call
   * finds nothing due and the Updates page shows its buttons again; then the same question is
   * filed in the Inbox. The scheduler calls this every hour (`scheduleModelWatchReminders`).
   * Returns the ids of the reports asked again.
   */
  async fileDueReminders(): Promise<string[]> {
    const { store, clock } = this.deps;
    const rows = await store.release.list(
      { channel: MODEL_WATCH_CHANNEL, status: "published" },
      { orderBy: "created_at desc", limit: 200 },
    );
    const asked: string[] = [];
    for (const row of rows) {
      const health = healthOf(row);
      if (health.decision !== "remind" || !health.remind_at) continue;
      const due = Date.parse(health.remind_at);
      if (!Number.isFinite(due) || due > clock.now()) continue;
      let report: ModelWatchReport;
      try {
        report = reportFromRelease(row);
      } catch {
        continue;
      }
      const pending: ModelWatchHealth = {
        ...health,
        decision: "pending",
        request_id: null,
        decided_at: null,
        by: null,
        remind_at: null,
      };
      try {
        const claimed = await store.release.update(row.id, row.version, {
          health: pending as unknown as JsonValue,
        });
        const outcome = await this.ask(report, "reminder");
        if (outcome.status === "pending") {
          await store.release.patch(claimed.id, {
            health: { ...pending, request_id: outcome.requestId } as unknown as JsonValue,
          });
        } else {
          await this.resolve(report.id, outcome.answer);
        }
        asked.push(report.id);
      } catch (e) {
        logger.warn("model watch reminder not filed", {
          reportId: report.id,
          error: errorMessage(e),
        });
      }
    }
    return asked;
  }

  /** Reports newest first, as the updates screen shows them. */
  async listReports(opts: { limit?: number } = {}): Promise<ModelWatchReportSummary[]> {
    const rows = await this.deps.store.release.list(
      { channel: MODEL_WATCH_CHANNEL },
      { orderBy: "created_at desc", limit: opts.limit ?? 20 },
    );
    return rows.map(summaryFromRelease);
  }

  async getReport(
    reportId: string,
  ): Promise<{ report: ModelWatchReport; health: ModelWatchHealth; release: ReleaseRow }> {
    const release = await this.releaseFor(reportId);
    return { report: reportFromRelease(release), health: healthOf(release), release };
  }

  async latestReport(): Promise<{
    report: ModelWatchReport;
    health: ModelWatchHealth;
    release: ReleaseRow;
  } | null> {
    const [row] = await this.deps.store.release.list(
      { channel: MODEL_WATCH_CHANNEL },
      { orderBy: "created_at desc", limit: 1 },
    );
    if (!row) return null;
    return { report: reportFromRelease(row), health: healthOf(row), release: row };
  }

  // -- internals ------------------------------------------------------------------------

  private guardEvalBudget(spent: number, what: string): void {
    const cap = this.thresholds.evalBudgetUsdMicro;
    if (spent >= cap) {
      throw new ForerunnerError(
        "budget_exceeded",
        `model watch eval budget exhausted (${spent} of ${cap} micro-USD) before ${what}`,
        { details: { spent, cap, what } },
      );
    }
  }

  /** The only code path that changes pricing, ladder or efforts. Refuses anything but a human's "adopt". */
  private async applyAdoption(
    report: ModelWatchReport,
    answer: ModelWatchAnswer,
  ): Promise<string[]> {
    if (answer.decision !== "adopt" || !answer.by) {
      throw new ForerunnerError(
        "approval_required",
        "model watch changes need a human's recorded 'adopt' answer",
        { details: { reportId: report.id, decision: answer.decision } },
      );
    }
    const wanted = answer.adopt ? new Set(answer.adopt) : null;
    const chosen = report.recommendations.filter((r) => !wanted || wanted.has(r.id));
    if (wanted) {
      const known = new Set(report.recommendations.map((r) => r.id));
      const unknown = [...wanted].filter((id) => !known.has(id));
      if (unknown.length) {
        throw new ForerunnerError(
          "validation",
          `unknown recommendation id(s): ${unknown.join(", ")}`,
          {
            details: { reportId: report.id, unknown },
          },
        );
      }
    }
    const applied: string[] = [];
    const { clock, settings } = this.deps;

    // Pricing: repricings chosen, plus the price rows of adopted new models.
    const pricingRows: PricingOverrides = {};
    for (const rec of chosen) {
      if (rec.kind === "reprice") {
        const row = report.pricing_proposal[rec.model];
        if (row) pricingRows[rec.model] = row;
      } else if (rec.kind === "switch_model") {
        const row = report.pricing_proposal[canonicalModelId(rec.to)];
        if (row) pricingRows[canonicalModelId(rec.to)] = row;
      }
    }
    if (!wanted) {
      // "adopt everything" also takes price rows that have no recommendation of their own.
      for (const [model, row] of Object.entries(report.pricing_proposal)) pricingRows[model] = row;
    }
    if (Object.keys(pricingRows).length > 0) {
      const existing = await settings.readPricingOverrides();
      const merged: PricingOverrides = { ...existing };
      for (const [model, row] of Object.entries(pricingRows)) {
        merged[model] = { ...(existing[model] ?? {}), ...row };
      }
      // Validate the result against the base table before anything is written.
      mergePricing(this.deps.pricing ?? BUILTIN_PRICING, merged);
      await settings.writePricingOverrides(merged);
      const names = Object.keys(pricingRows).sort();
      applied.push(`pricing overrides written for ${names.join(", ")}`);
      await this.audit("model_watch.write_pricing", settings.describe().pricing, {
        result: names.join(", "),
        humanId: answer.by,
      });
    }

    // Ladder and effort settings.
    const switches = chosen.filter(
      (r): r is SwitchModelRecommendation => r.kind === "switch_model",
    );
    const efforts = chosen.filter((r): r is LowerEffortRecommendation => r.kind === "lower_effort");
    if (switches.length || efforts.length) {
      const current = await settings.readModelSettings();
      const next: ModelSettings = structuredClone(current);
      const changes: string[] = [];
      for (const s of switches) {
        const rung = { ...(next.ladder[s.rung] ?? {}) };
        rung[s.provider] = s.to;
        next.ladder[s.rung] = rung;
        changes.push(`ladder ${s.rung}/${s.provider}: ${s.from} -> ${s.to}`);
      }
      for (const e of efforts) {
        next.efforts[e.mode] = e.to;
        changes.push(`effort ${e.mode}: ${e.from} -> ${e.to}`);
      }
      next.updated_at = clock.nowIso();
      next.history.push({
        at: clock.nowIso(),
        report_id: report.id,
        by: answer.by,
        changes,
      });
      await settings.writeModelSettings(next);
      applied.push(...changes);
      await this.audit("model_watch.write_settings", settings.describe().models, {
        result: changes.join("; "),
        humanId: answer.by,
      });
    }
    return applied;
  }

  /**
   * The free, local half of a run's baseline step, for the daemon's start (ADR 0089): each
   * registered provider without a baseline row takes the listing of the earliest report that
   * listed it. Then, whenever any baseline exists (seeded now or before), the pending reports
   * it covers are closed with the run's guarded close, so a boot that stopped between seed and
   * close is finished by the next. No provider is listed, no model or eval is called and no
   * report is written, so an upgraded install's covered requests close at the restart instead
   * of at the next weekly run. A provider with no report keeps waiting for its first listing.
   * Idempotent: with nothing left to seed or close it only reads.
   */
  async seedBaselinesAtStart(): Promise<{ seeded: string[]; closed: number }> {
    const ignore = new Set(this.deps.ignoreProviders ?? []);
    const baselines = await readModelWatchBaselines(this.deps.store);
    const missing = this.deps.providers.names().filter((p) => !ignore.has(p) && !baselines.has(p));
    const seeded = await this.seedBaselinesFromReports(missing, baselines);
    if (!baselines.size) return { seeded, closed: 0 };
    const closed = await this.closeCoveredRequests(baselines, null);
    if (closed) logger.info("model watch: closed requests the baseline covers", { closed });
    return { seeded, closed };
  }

  /**
   * An install from before the baseline rule has reports and no baseline rows: each provider
   * missing one takes the listing of the earliest report that listed it without an error.
   * Adds to `baselines` and returns the providers seeded.
   */
  private async seedBaselinesFromReports(
    missing: string[],
    baselines: Map<string, Set<string>>,
  ): Promise<string[]> {
    if (!missing.length) return [];
    const rows = await this.deps.store.release.list(
      { channel: MODEL_WATCH_CHANNEL },
      { orderBy: "created_at asc", limit: 500 },
    );
    const seeded: string[] = [];
    for (const provider of missing) {
      for (const row of rows) {
        let report: ModelWatchReport;
        try {
          report = reportFromRelease(row);
        } catch {
          continue;
        }
        const entry = report.providers.find((p) => p.name === provider && p.error === null);
        if (!entry) continue;
        const models = entry.listed.map((m) => ({ provider, id: m.id, tier: m.tier }));
        await recordModelWatchBaseline(this.deps.store, {
          provider,
          models,
          reportId: report.id,
          agentId: this.deps.agentId ?? null,
        });
        await this.audit("model_watch.baseline", `provider ${provider}`, {
          result: `${models.length} model(s) seeded from report ${report.id}`,
        });
        baselines.set(provider, new Set(models.map((m) => canonicalModelId(m.id))));
        seeded.push(provider);
        break;
      }
    }
    return seeded;
  }

  /** `provider/id` names to evaluate: the given ones, plus the candidates of each report. */
  private async namedCandidates(models: string[], forReports: string[]): Promise<string[]> {
    const out = [...models];
    for (const forReport of forReports) {
      const report = reportFromRelease(await this.releaseFor(forReport));
      for (const p of report.evals_deferred?.planned ?? [])
        if (p.role === "candidate") out.push(`${p.provider}/${p.model}`);
      for (const m of report.diff.new_models) if (m.priced) out.push(`${m.provider}/${m.id}`);
    }
    return [...new Set(out)];
  }

  /**
   * Close every pending report whose only matter was new models that a baseline now holds:
   * at least one new model, all of them in their provider's baseline, and no recommendation
   * (a repricing or an eval result stays a question). Its request is withdrawn and the report
   * marked `nothing_to_decide`.
   */
  private async closeCoveredRequests(
    baselines: Map<string, Set<string>>,
    currentReportId: string | null,
  ): Promise<number> {
    const { store } = this.deps;
    const rows = await store.release.list(
      { channel: MODEL_WATCH_CHANNEL, status: "published" },
      { orderBy: "created_at desc", limit: 200 },
    );
    let closed = 0;
    for (const row of rows) {
      if (row.release_version === currentReportId) continue;
      if (healthOf(row).decision !== "pending") continue;
      let report: ModelWatchReport;
      try {
        report = reportFromRelease(row);
      } catch {
        continue;
      }
      const news = report.diff.new_models;
      if (!news.length || report.recommendations.length) continue;
      if (!news.every((m) => baselines.get(m.provider)?.has(canonicalModelId(m.id)))) continue;
      // A human may answer at any moment: the request is withdrawn only while still open,
      // the report closed only when this call withdrew its request (or it has none), and
      // only while the stored row still says pending. Any race leaves the human's answer.
      try {
        const requestId = healthOf(row).request_id;
        if (requestId) {
          const req = await store.humanRequest.get(requestId);
          if (req?.status !== "open") continue;
          await store.humanRequest.withdraw(req.id, req.version);
        }
        const current = await store.release.get(row.id);
        if (!current) continue;
        const health = healthOf(current);
        if (health.decision !== "pending") {
          logger.info("model watch report decided while the baseline closed it; left as decided", {
            reportId: report.id,
            decision: health.decision,
          });
          continue;
        }
        await store.release.update(current.id, current.version, {
          health: { ...health, decision: "nothing_to_decide" } as unknown as JsonValue,
        });
        closed += 1;
        await this.audit("model_watch.decision", `report ${report.id}: closed by the baseline`, {
          result: "its new models are all in the baseline; request withdrawn",
        });
      } catch (e) {
        logger.warn("model watch report not closed by the baseline; the human's answer stands", {
          reportId: report.id,
          error: errorMessage(e),
        });
      }
    }
    return closed;
  }

  private async releaseFor(reportId: string): Promise<ReleaseRow> {
    const [row] = await this.deps.store.release.list(
      { channel: MODEL_WATCH_CHANNEL, release_version: reportId },
      { limit: 1 },
    );
    if (!row) {
      throw new ForerunnerError("not_found", `model watch report ${reportId} not found`, {
        details: { reportId },
      });
    }
    return row;
  }

  private async audit(
    tool: string,
    inputSummary: string,
    opts: { result: string; cost?: number; allowed?: boolean; humanId?: string | undefined },
  ): Promise<void> {
    await this.deps.store.auditLog.append({
      session_id: null,
      run_id: null,
      agent_id: this.deps.agentId ?? null,
      human_id: opts.humanId ?? this.deps.humanId,
      tool,
      input_summary: inputSummary.slice(0, 500),
      result_summary: opts.result.slice(0, 1000),
      allowed: opts.allowed ?? true,
      denied_reason: null,
      cost_usd_micro: opts.cost ?? 0,
      token_id: null,
    });
  }
}

// ---------------------------------------------------------------------------------------
// Baseline listings (ADR 0089: the first run is the baseline, not news)
// ---------------------------------------------------------------------------------------

const BaselineArtifactSchema = z.object({
  provider: z.string(),
  models: z.array(z.object({ id: z.string(), tier: z.string() })),
  report_id: z.string().nullable(),
});

/**
 * Record a provider's baseline listing: the models it listed the first time the watch saw it.
 * Written once per provider; a second call (two runs racing on a fresh install) keeps the
 * first and returns quietly.
 */
export async function recordModelWatchBaseline(
  store: StateStore,
  input: {
    provider: string;
    models: readonly ModelRef[];
    reportId?: string | null;
    agentId?: string | null;
  },
): Promise<void> {
  const existing = await store.release.list(
    { channel: MODEL_WATCH_BASELINE_CHANNEL, release_version: input.provider },
    { limit: 1 },
  );
  if (existing.length) return;
  const artifact = {
    provider: input.provider,
    models: input.models.map((m) => ({ id: m.id, tier: m.tier })),
    report_id: input.reportId ?? null,
  };
  try {
    await store.release.insert({
      release_version: input.provider,
      channel: MODEL_WATCH_BASELINE_CHANNEL,
      changelog: `model watch baseline for ${input.provider}: ${artifact.models.length} model(s)`,
      signature: "",
      status: "installed",
      artifacts: [artifact as unknown as JsonValue],
      published_at: null,
      health: {},
      author_agent: input.agentId ?? null,
      author_human: null,
    });
  } catch (e) {
    const now = await store.release.list(
      { channel: MODEL_WATCH_BASELINE_CHANNEL, release_version: input.provider },
      { limit: 1 },
    );
    if (!now.length) throw e;
  }
}

/** Each provider's baseline listing as canonical model ids. A provider without one is absent. */
export async function readModelWatchBaselines(
  store: StateStore,
): Promise<Map<string, Set<string>>> {
  const rows = await store.release.list({ channel: MODEL_WATCH_BASELINE_CHANNEL }, { limit: 200 });
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const parsed = BaselineArtifactSchema.safeParse(row.artifacts[0]);
    if (!parsed.success) {
      // Never a silent provider: an unreadable baseline counts as an empty one, so its
      // models are compared with the ladder and the price table only.
      logger.warn("unreadable model watch baseline; compared without it", {
        provider: row.release_version,
      });
      out.set(row.release_version, new Set());
      continue;
    }
    out.set(parsed.data.provider, new Set(parsed.data.models.map((m) => canonicalModelId(m.id))));
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Release row <-> report
// ---------------------------------------------------------------------------------------

export function reportFromRelease(row: ReleaseRow): ModelWatchReport {
  const raw = row.artifacts[0];
  const parsed = ModelWatchReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ForerunnerError(
      "validation",
      `release ${row.id} does not carry a model watch report`,
      {
        details: { releaseId: row.id, issues: parsed.error.issues.map((i) => i.message) },
      },
    );
  }
  return parsed.data;
}

export function healthOf(row: ReleaseRow): ModelWatchHealth {
  const h = (row.health ?? {}) as unknown as Partial<ModelWatchHealth>;
  return {
    decision: h.decision ?? "pending",
    request_id: h.request_id ?? null,
    decided_at: h.decided_at ?? null,
    by: h.by ?? null,
    applied: Array.isArray(h.applied) ? h.applied : [],
    remind_at: h.remind_at ?? null,
  };
}

export function summaryFromRelease(row: ReleaseRow): ModelWatchReportSummary {
  const report = reportFromRelease(row);
  const health = healthOf(row);
  return ModelWatchReportSummarySchema.parse({
    id: report.id,
    generated_at: report.generated_at,
    status: row.status,
    decision: health.decision,
    request_id: health.request_id,
    decided_at: health.decided_at,
    recommendations: report.recommendations.length,
    new_models: report.diff.new_models.length,
    retired_models: report.diff.retired_models.length,
    repriced: report.diff.repriced.length,
    summary: report.summary,
  });
}

/** The lines a human reads in the inbox card. */
export function proposalSteps(report: ModelWatchReport): string[] {
  const steps: string[] = [];
  for (const r of report.recommendations) steps.push(r.text);
  const priced = Object.keys(report.pricing_proposal);
  if (priced.length) steps.push(`pricing.json rows proposed for: ${priced.sort().join(", ")}`);
  for (const u of report.diff.unpriced)
    steps.push(
      `${u.provider}/${u.id} (${u.tier}) has no known price: add one to pricing.json to test it`,
    );
  for (const r of report.diff.retired_models)
    steps.push(`${r.provider}/${r.id} is no longer listed; rung ${r.tier} needs a replacement`);
  const deferred = report.evals_deferred;
  if (deferred) {
    const n = deferred.planned.length;
    steps.push(
      `Evaluations not run (they cost money): ${n} eval set run(s) planned, at most USD ${(report.eval_budget_usd_micro / 1e6).toFixed(2)}. Only "evaluate" runs them; "adopt" applies the price rows and runs nothing.`,
    );
  }
  return steps;
}

export function summarizeReport(report: ModelWatchReport): string {
  const d = report.diff;
  const baseline = report.baseline_providers.length
    ? ` baseline recorded for ${report.baseline_providers
        .map(
          (p) =>
            `${p} (${report.providers.find((x) => x.name === p)?.listed.length ?? 0} model(s))`,
        )
        .join(", ")};`
    : "";
  const parts = [
    `Model watch ${report.generated_at.slice(0, 10)}:${baseline} ${d.new_models.length} new, ${d.retired_models.length} retired, ${d.repriced.length} repriced, ${d.unpriced.length} unpriced model(s).`,
    `${report.evals.filter((e) => e.skipped_reason === null).length} eval run(s) for USD ${(report.eval_cost_usd_micro / 1e6).toFixed(4)}.`,
    report.recommendations.length
      ? `${report.recommendations.length} recommendation(s): ${report.recommendations.map((r) => r.text).join(" | ")}`
      : "No recommendation.",
  ];
  if (report.price_list.error) parts.push(`Price list unavailable: ${report.price_list.error}.`);
  if (report.evals_deferred)
    parts.push(
      `${report.evals_deferred.planned.length} eval run(s) not made: paid evals need consent.`,
    );
  if (report.skipped.length) parts.push(`${report.skipped.length} item(s) skipped.`);
  if (report.closed_requests)
    parts.push(
      `Baseline: closed ${report.closed_requests} earlier request(s) the baseline covers.`,
    );
  return parts.join(" ");
}

/** One-screen text rendering for the CLI and progress reports. */
export function formatModelWatchReport(
  report: ModelWatchReport,
  health?: ModelWatchHealth,
): string {
  const lines = [report.summary];
  if (health) lines.push(`Decision: ${health.decision}${health.by ? ` by ${health.by}` : ""}`);
  for (const p of report.providers)
    lines.push(
      `  provider ${p.name}: ${p.error ? `error ${p.error}` : `${p.listed.length} model(s)`}`,
    );
  for (const m of report.diff.new_models)
    lines.push(
      `  new      ${m.provider}/${m.id} (${m.tier}) ${m.priced ? `priced from ${m.price_origin}` : "UNPRICED"}`,
    );
  for (const m of report.diff.retired_models)
    lines.push(`  retired  ${m.provider}/${m.id} (${m.tier})`);
  for (const r of report.diff.repriced)
    lines.push(
      `  repriced ${r.model}: ${r.changes.map((c) => `${c.field} ${c.before ?? "n/a"} -> ${c.after}`).join(", ")}`,
    );
  for (const e of report.evals)
    lines.push(
      `  eval     ${e.role.padEnd(12)} ${e.specialist} ${e.provider}/${e.model} @${e.effort}: ${e.skipped_reason ? `skipped (${e.skipped_reason})` : `${e.passed}/${e.total} passed, USD ${(e.cost_usd_micro / 1e6).toFixed(4)}`}`,
    );
  for (const r of report.recommendations) lines.push(`  => [${r.id}] ${r.text}`);
  for (const p of report.evals_deferred?.planned ?? [])
    lines.push(
      `  planned  ${p.role.padEnd(12)} ${p.specialist} ${p.provider}/${p.model} @${p.effort}: not run (no consent to paid evals)`,
    );
  for (const s of report.skipped) lines.push(`  skipped: ${s}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Production approval port: a HumanRequest in the inbox
// ---------------------------------------------------------------------------------------

export const MODEL_WATCH_REQUEST_PREFIX = "model_watch:";

/** Parse a human's answer on a model watch HumanRequest; null when it is not readable. */
export function answerFromHumanRequest(row: HumanRequestRow): ModelWatchAnswer | null {
  const by = row.answered_by ?? undefined;
  const raw = row.answer;
  const decisionOf = (s: string): ModelWatchDecision | null => {
    const t = s.trim().toLowerCase();
    if (/^(adopt|yes|approve|approved|ok)\b/.test(t)) return "adopt";
    if (/^(evaluate|run (the )?eval(uation)?s?)\b/.test(t)) return "evaluate";
    if (/^(ignore|no|reject|dismiss)\b/.test(t)) return "ignore";
    if (/^(remind|later|next week|snooze)\b/.test(t)) return "remind";
    return null;
  };
  if (typeof raw === "string") {
    const decision = decisionOf(raw);
    return decision ? { decision, by } : null;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as { decision?: unknown; choice?: unknown; answer?: unknown; adopt?: unknown };
    const chosen = o.decision ?? o.choice ?? o.answer;
    if (typeof chosen !== "string") return null;
    const decision = decisionOf(chosen);
    if (!decision) return null;
    const adopt = Array.isArray(o.adopt)
      ? o.adopt.filter((x): x is string => typeof x === "string")
      : undefined;
    return { decision, by, ...(adopt ? { adopt } : {}) };
  }
  return null;
}

/** Opens a non-blocking decision request; the answer arrives later through syncPendingAnswers(). */
export class StateModelWatchApprovals implements ModelWatchApprovalPort {
  constructor(
    private readonly store: StateStore,
    private readonly opts: { agentId?: string | null } = {},
  ) {}

  async ask(req: ModelWatchApprovalRequest): Promise<ModelWatchApprovalOutcome> {
    const row = await this.store.humanRequest.insert({
      human_id: req.humanId,
      project_id: null,
      task_id: null,
      session_id: null,
      kind: "decision",
      why: req.summary,
      steps: req.steps,
      options: [...req.options],
      blocking: false,
      risk: "medium",
      change_card: {
        key: `${MODEL_WATCH_REQUEST_PREFIX}${req.reportId}`,
        report_id: req.reportId,
        recommendations: req.recommendations as unknown as JsonValue,
        pricing_proposal: req.pricingProposal as unknown as JsonValue,
      },
      author_agent: this.opts.agentId ?? null,
    });
    return { status: "pending", requestId: row.id };
  }
}

// ---------------------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------------------

export interface ScheduleModelWatchOptions {
  /** Pseudo agent id the scheduler keys the schedule on. Default MODEL_WATCH_AGENT_ID. */
  agentId?: string;
  timezone?: string;
  /** Default: weekly. */
  everyMinutes?: number;
  enabled?: boolean;
}

/**
 * Register the weekly trigger with the session Scheduler. The scheduler calls its `start`
 * callback with a StartRequest for MODEL_WATCH_AGENT_ID; the orchestrator routes such requests
 * (isModelWatchRequest) to ModelWatch.run() instead of starting a session.
 */
export function scheduleModelWatch(
  scheduler: Scheduler,
  opts: ScheduleModelWatchOptions = {},
): Schedule {
  const schedule: Schedule = {
    id: MODEL_WATCH_SCHEDULE_ID,
    agentId: opts.agentId ?? MODEL_WATCH_AGENT_ID,
    kind: "every",
    everyMinutes: opts.everyMinutes ?? WEEK_MINUTES,
    timezone: opts.timezone ?? "UTC",
    enabled: opts.enabled ?? true,
    // The last run survives a restart (`scheduler-fired.json`): weekly means weekly, not per boot.
    persist: true,
  };
  scheduler.add(schedule);
  return schedule;
}

export function isModelWatchRequest(
  req: StartRequest,
  agentId: string = MODEL_WATCH_AGENT_ID,
): boolean {
  return req.agentId === agentId && req.trigger === "schedule";
}

/**
 * Register the hourly look for due reminders (U-035): the scheduler calls its `start` with a
 * StartRequest for MODEL_WATCH_REMINDER_AGENT_ID, which the orchestrator routes
 * (`isModelWatchReminderRequest`) to `ModelWatch.fileDueReminders()`. Not persisted: a daemon
 * that starts looks at once, and a reminder due while it was off is filed then.
 */
export function scheduleModelWatchReminders(
  scheduler: Scheduler,
  opts: { timezone?: string; enabled?: boolean } = {},
): Schedule {
  const schedule: Schedule = {
    id: MODEL_WATCH_REMINDER_SCHEDULE_ID,
    agentId: MODEL_WATCH_REMINDER_AGENT_ID,
    kind: "every",
    everyMinutes: MODEL_WATCH_REMINDER_EVERY_MINUTES,
    timezone: opts.timezone ?? "UTC",
    enabled: opts.enabled ?? true,
  };
  scheduler.add(schedule);
  return schedule;
}

export function isModelWatchReminderRequest(req: StartRequest): boolean {
  return req.agentId === MODEL_WATCH_REMINDER_AGENT_ID && req.trigger === "schedule";
}

/** Throws the signal's reason as a `killed` ForerunnerError when the run was stopped. */
function throwIfStopped(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const r: unknown = signal.reason;
  if (r instanceof ForerunnerError) throw r;
  throw new ForerunnerError("killed", `model watch stopped: ${errorMessage(r)}`);
}
