import {
  compareTiers,
  DEFAULT_CEILING,
  DEFAULT_LADDER,
  type EffortLevel,
  effortIndex,
  effortWithOffset,
  type LadderRung,
  MODE_DEFAULTS,
  type Mode,
  type ModeDefault,
  type ModelTier,
  modelIdFor,
  TIERS,
} from "@forerunner/runtime";
import type { JsonObject } from "@forerunner/state";
import type { ReviewTier } from "./types.ts";

export interface CriticSettings {
  ceiling?: ModelTier;
  effortOffset?: -1 | 0 | 1;
}

/** Reads `critic_ceiling` and `speed_quality_offset` from a project's settings object. */
export function criticSettingsOf(settings: JsonObject | null | undefined): CriticSettings {
  const out: CriticSettings = {};
  if (!settings) return out;
  const ceiling = settings.critic_ceiling;
  if (typeof ceiling === "string" && (TIERS as readonly string[]).includes(ceiling))
    out.ceiling = ceiling as ModelTier;
  const offset = settings.speed_quality_offset;
  if (offset === -1 || offset === 0 || offset === 1) out.effortOffset = offset;
  return out;
}

/**
 * The lower of two ceilings (D.3): a caller may tighten the project's `critic_ceiling` for one
 * review, never raise it. A missing ceiling defers to the other; both missing is undefined.
 */
export function stricterCeiling(
  a: ModelTier | undefined,
  b: ModelTier | undefined,
): ModelTier | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareTiers(a, b) <= 0 ? a : b;
}

/**
 * Which model reviews at which tier (spec D, table "Effort and response time"):
 * tier 1 Sonnet at medium effort with a 30 s target; tiers 2 and 3 Opus at high effort, max at
 * tier 3. The project's ceiling caps the rung, the speed-versus-quality slider shifts the effort
 * one step, and the registry prompt's max_effort caps it.
 */
export interface CriticModelPick {
  mode: Mode;
  tier: ModelTier;
  effort: EffortLevel;
  model: string;
  /** Response target from the spec table (0 = set by the task budget). */
  targetMs: number;
  /** Wall-clock timeout for the review run. */
  timeoutMs: number;
  /** True when the ceiling pulled the rung below the spec default. */
  cappedByCeiling: boolean;
}

export interface PickCriticModelOptions {
  provider: string;
  ceiling?: ModelTier;
  effortOffset?: -1 | 0 | 1;
  /** From the registry critic prompt (`max_effort`). */
  maxEffort?: EffortLevel;
  ladder?: LadderRung[];
  modeDefaults?: Record<Mode, ModeDefault>;
  /** Timeout for tiers 2 and 3; tier 1 always uses its response target. Default 10 minutes. */
  timeoutMs?: number;
}

export const DEFAULT_DEEP_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

export function criticModeFor(tier: Exclude<ReviewTier, 0>): Mode {
  return tier === 1 ? "critic_t1" : "critic_t23";
}

export function pickCriticModel(
  reviewTier: Exclude<ReviewTier, 0>,
  opts: PickCriticModelOptions,
): CriticModelPick {
  const mode = criticModeFor(reviewTier);
  const defaults = (opts.modeDefaults ?? MODE_DEFAULTS)[mode];
  const ceiling = opts.ceiling ?? DEFAULT_CEILING;
  const cappedByCeiling = compareTiers(defaults.tier, ceiling) > 0;
  const tier = cappedByCeiling ? ceiling : defaults.tier;
  let effort: EffortLevel = mode === "critic_t23" && reviewTier === 3 ? "max" : defaults.effort;
  effort = effortWithOffset(effort, opts.effortOffset ?? 0);
  if (opts.maxEffort && effortIndex(effort) > effortIndex(opts.maxEffort)) effort = opts.maxEffort;
  const model = modelIdFor(tier, opts.provider, opts.ladder ?? DEFAULT_LADDER);
  const timeoutMs =
    reviewTier === 1 ? defaults.targetMs : (opts.timeoutMs ?? DEFAULT_DEEP_REVIEW_TIMEOUT_MS);
  return { mode, tier, effort, model, targetMs: defaults.targetMs, timeoutMs, cappedByCeiling };
}
