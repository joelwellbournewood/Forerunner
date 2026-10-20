import type { EffortLevel, ModelTier } from "../provider/types.ts";

/** The model ladder (spec D, Open decisions): Haiku -> Sonnet -> Opus -> Fable, ceiling Opus by default. */
export const TIERS: readonly ModelTier[] = ["haiku", "sonnet", "opus", "fable"] as const;

export interface LadderRung {
  tier: ModelTier;
  /** provider name -> model id */
  models: Record<string, string>;
}

export const DEFAULT_LADDER: LadderRung[] = [
  { tier: "haiku", models: { anthropic: "claude-haiku-5-5", fake: "fake-haiku" } },
  { tier: "sonnet", models: { anthropic: "claude-sonnet-5-5", fake: "fake-sonnet" } },
  { tier: "opus", models: { anthropic: "claude-opus-5-5", fake: "fake-opus" } },
  { tier: "fable", models: { anthropic: "claude-fable-5-1", fake: "fake-fable" } },
];

export const DEFAULT_CEILING: ModelTier = "opus";

export type Mode =
  | "voice_chat"
  | "text_chat"
  | "routing"
  | "planning"
  | "coder"
  | "researcher"
  | "critic_t1"
  | "critic_t23";

export interface ModeDefault {
  tier: ModelTier;
  effort: EffortLevel;
  /** Response target in ms and what it measures. */
  targetMs: number;
  targetKind: "first_audio" | "first_token" | "total" | "by_task";
}

/** Spec table "Effort and response time". */
export const MODE_DEFAULTS: Record<Mode, ModeDefault> = {
  voice_chat: { tier: "haiku", effort: "low", targetMs: 1200, targetKind: "first_audio" },
  text_chat: { tier: "haiku", effort: "low", targetMs: 1000, targetKind: "first_token" },
  routing: { tier: "haiku", effort: "low", targetMs: 3000, targetKind: "total" },
  planning: { tier: "sonnet", effort: "high", targetMs: 60_000, targetKind: "total" },
  coder: { tier: "sonnet", effort: "medium", targetMs: 0, targetKind: "by_task" },
  researcher: { tier: "sonnet", effort: "high", targetMs: 0, targetKind: "by_task" },
  critic_t1: { tier: "sonnet", effort: "medium", targetMs: 30_000, targetKind: "total" },
  critic_t23: { tier: "opus", effort: "high", targetMs: 0, targetKind: "by_task" },
};

const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"] as const;

export function tierIndex(t: ModelTier): number {
  return TIERS.indexOf(t);
}

export function compareTiers(a: ModelTier, b: ModelTier): number {
  return tierIndex(a) - tierIndex(b);
}

/** Next rung up, or null at the ceiling. Never goes above the ceiling. */
export function nextRung(
  current: ModelTier,
  ceiling: ModelTier = DEFAULT_CEILING,
): ModelTier | null {
  const i = tierIndex(current);
  const c = tierIndex(ceiling);
  if (i < 0 || i >= c) return null;
  return TIERS[i + 1] ?? null;
}

/** Shift effort by the project's speed-versus-quality offset (-1, 0, +1). */
export function effortWithOffset(effort: EffortLevel, offset: -1 | 0 | 1): EffortLevel {
  const i = EFFORTS.indexOf(effort);
  const j = Math.min(EFFORTS.length - 1, Math.max(0, i + offset));
  return EFFORTS[j] ?? effort;
}

/** Coding at tier 2+ runs at high effort (spec D). */
export function effortForTask(
  mode: Mode,
  riskTier: 0 | 1 | 2 | 3,
  offset: -1 | 0 | 1 = 0,
): EffortLevel {
  let base = MODE_DEFAULTS[mode].effort;
  if (mode === "coder" && riskTier >= 2) base = "high";
  if (mode === "critic_t23" && riskTier === 3) base = "max";
  return effortWithOffset(base, offset);
}

/** Starting rung for a task: the specialist's default; tier 3 starts one rung higher when allowed. */
export function startingTier(
  specialistDefault: ModelTier,
  riskTier: 0 | 1 | 2 | 3,
  ceiling: ModelTier = DEFAULT_CEILING,
): ModelTier {
  if (riskTier === 3) return nextRung(specialistDefault, ceiling) ?? specialistDefault;
  return compareTiers(specialistDefault, ceiling) > 0 ? ceiling : specialistDefault;
}

export function modelIdFor(
  tier: ModelTier,
  provider: string,
  ladder: LadderRung[] = DEFAULT_LADDER,
): string {
  const rung = ladder.find((r) => r.tier === tier);
  const id = rung?.models[provider];
  if (!id) throw new Error(`no model for tier ${tier} on provider ${provider}`);
  return id;
}

export function tierOfModel(
  modelId: string,
  ladder: LadderRung[] = DEFAULT_LADDER,
): ModelTier | null {
  for (const r of ladder) if (Object.values(r.models).includes(modelId)) return r.tier;
  return null;
}

/** Retry policy (spec D): 1st failure improve brief, 2nd split or change specialist, 3rd escalate, then human. */
export type RetryAction = "improve_brief" | "split_or_change_specialist" | "escalate" | "human";

export function retryAction(
  failedAttempts: number,
  current: ModelTier,
  ceiling: ModelTier = DEFAULT_CEILING,
): RetryAction {
  if (failedAttempts <= 0) throw new Error("retryAction expects at least one failed attempt");
  if (failedAttempts === 1) return "improve_brief";
  if (failedAttempts === 2) return "split_or_change_specialist";
  if (failedAttempts === 3) return nextRung(current, ceiling) ? "escalate" : "human";
  return "human";
}
