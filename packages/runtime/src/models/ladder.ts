import { canonicalModelId, fastModeBaseId } from "@forerunner/billing";
import type { EffortLevel, ModelTier, SpeedMode } from "../provider/types.ts";

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

/**
 * The escalation ceiling a project's settings name (`critic_ceiling`, spec D.3), or undefined
 * when the setting is absent or not a rung. The task executor reads it from the project row at
 * every run by default, so no composition (daemon, cloud runner, test world) can forget it.
 */
export function projectCeilingOf(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): ModelTier | undefined {
  const value = settings?.critic_ceiling;
  return typeof value === "string" && (TIERS as readonly string[]).includes(value)
    ? (value as ModelTier)
    : undefined;
}

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
  /** Output tokens per model call (ADR 0072): the `max_tokens` a run in this mode sends by default. */
  maxTokens: number;
  /** Speed mode by default (ADR 0072): "standard" everywhere; "fast" is asked for, never assumed. */
  speedMode: SpeedMode;
  /**
   * Wall-clock timeout of one run in this mode by default (ADR 0072). A specialist's
   * `timeout_minutes` replaces it; the agent modes (planning, chat) use it unless the agent's
   * `model_config` overrides it.
   */
  timeoutMs: number;
  /** Response target in ms and what it measures. */
  targetMs: number;
  targetKind: "first_audio" | "first_token" | "total" | "by_task";
}

const STD = "standard" as const;

/**
 * The voice and text chat modes' output cap per call. It was 400 until the real-audio run of
 * 2026-10-26, where a spoken reply was cut off mid-sentence at exactly 400 output tokens:
 * Haiku 5.5 thinks by default (adaptive, even at low effort, its thinking returned empty) and
 * thinking counts toward `max_tokens`, so the visible text got about 60 of them. 1024 is about
 * three times the largest chat turn of that run with thinking included (310 tokens out for 530
 * characters); a chat turn at low effort also asks thinking off (`ConversationAgent`), so the
 * cap is the reply's. The pre-call estimate prices the whole cap: on Haiku 5.5 that is USD
 * 0.0005 a call; a principal who moves chat to Opus (USD 20 per million out) reserves USD 0.02
 * of the turn's USD 0.05 for output.
 */
export const CHAT_MAX_TOKENS = 1024;

/**
 * Spec table "Effort and response time" (D.8 to D.15), with the per-call output cap, the speed
 * mode and the run timeout of each mode (ADR 0072: the spec's table names model, effort and the
 * response target; D.4 adds max tokens, speed mode and timeout). The numbers are the ones the
 * code used before D.4 (chat 400 tokens and 30 s, intake 16'000 tokens and 5 min, the loop's
 * 4096 per call, the critic's 8192, its tier-1 target and 10-minute deep review), so making
 * them settings changed no run; the chat cap has since been raised (`CHAT_MAX_TOKENS`).
 */
export const MODE_DEFAULTS: Record<Mode, ModeDefault> = {
  voice_chat: {
    tier: "haiku",
    effort: "low",
    maxTokens: CHAT_MAX_TOKENS,
    speedMode: STD,
    timeoutMs: 30_000,
    targetMs: 1200,
    targetKind: "first_audio",
  },
  text_chat: {
    tier: "haiku",
    effort: "low",
    maxTokens: CHAT_MAX_TOKENS,
    speedMode: STD,
    timeoutMs: 30_000,
    targetMs: 1000,
    targetKind: "first_token",
  },
  routing: {
    tier: "haiku",
    effort: "low",
    maxTokens: 1024,
    speedMode: STD,
    timeoutMs: 30_000,
    targetMs: 3000,
    targetKind: "total",
  },
  planning: {
    tier: "sonnet",
    effort: "high",
    maxTokens: 16_000,
    speedMode: STD,
    timeoutMs: 300_000,
    targetMs: 60_000,
    targetKind: "total",
  },
  coder: {
    tier: "sonnet",
    effort: "medium",
    maxTokens: 4096,
    speedMode: STD,
    timeoutMs: 1_800_000,
    targetMs: 0,
    targetKind: "by_task",
  },
  researcher: {
    tier: "sonnet",
    effort: "high",
    maxTokens: 4096,
    speedMode: STD,
    timeoutMs: 1_800_000,
    targetMs: 0,
    targetKind: "by_task",
  },
  critic_t1: {
    tier: "sonnet",
    effort: "medium",
    maxTokens: 8192,
    speedMode: STD,
    timeoutMs: 30_000,
    targetMs: 30_000,
    targetKind: "total",
  },
  critic_t23: {
    tier: "opus",
    effort: "high",
    maxTokens: 8192,
    speedMode: STD,
    timeoutMs: 600_000,
    targetMs: 0,
    targetKind: "by_task",
  },
};

/**
 * The effort-table row a specialist's defaults come from (ADR 0072): the researcher runs in the
 * research mode, every other specialist in the coding mode (the rule the executor's effort uses).
 */
export function specialistMode(name: string): Mode {
  return name === "researcher" ? "researcher" : "coder";
}

/**
 * The specialist name on the Run row of the intake call (spec A.2): the one planning-rung call
 * the PM makes. The Performance view (daemon/views.ts) reads it as the planning mode.
 */
export const INTAKE_RUN_SPECIALIST = "intake";

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

/** The speed-versus-quality slider's three positions (spec D.16): speed, balanced, quality. */
export type EffortOffset = -1 | 0 | 1;

/** Shift effort by the project's speed-versus-quality offset (-1, 0, +1). */
export function effortWithOffset(effort: EffortLevel, offset: EffortOffset): EffortLevel {
  const i = EFFORTS.indexOf(effort);
  const j = Math.min(EFFORTS.length - 1, Math.max(0, i + offset));
  return EFFORTS[j] ?? effort;
}

/**
 * The project's slider from its settings (`speed_quality_offset`, spec D.16). Anything but -1,
 * 0 or +1 (unset, a string, an out-of-range number) is the balanced position, as the critic
 * reads it (`criticSettingsOf`).
 */
export function speedQualityOffsetOf(settings: unknown): EffortOffset {
  if (typeof settings !== "object" || settings === null) return 0;
  const v = (settings as { speed_quality_offset?: unknown }).speed_quality_offset;
  return v === -1 || v === 1 ? v : 0;
}

/**
 * A mode's effort for a project (spec D.16): the default from the table in force, shifted one
 * step by the project's slider. Callers read the project row per run, turn or planning session,
 * so a slider change applies to the next one without a restart.
 */
export function modeEffort(
  mode: Mode,
  offset: EffortOffset = 0,
  defaults: Record<Mode, ModeDefault> = MODE_DEFAULTS,
): EffortLevel {
  return effortWithOffset((defaults[mode] ?? MODE_DEFAULTS[mode]).effort, offset);
}

/**
 * Coding at tier 2+ runs at high effort (spec D). `defaults` is the effort table in force: the
 * built-in one, or the one `applyModelSettings` produces after the model watch adopted a lower
 * effort (`<config>/models.json`).
 */
export function effortForTask(
  mode: Mode,
  riskTier: 0 | 1 | 2 | 3,
  offset: EffortOffset = 0,
  defaults: Record<Mode, ModeDefault> = MODE_DEFAULTS,
): EffortLevel {
  let base = defaults[mode].effort;
  if (mode === "coder" && riskTier >= 2) base = "high";
  if (mode === "critic_t23" && riskTier === 3) base = "max";
  return effortWithOffset(base, offset);
}

/**
 * An effort held at a cap (the registry entry's `max_effort`): the tier rule and the project's
 * slider raise effort, never above what the specialist declares. No cap leaves it unchanged.
 */
export function capEffort(effort: EffortLevel, max: EffortLevel | undefined): EffortLevel {
  if (!max) return effort;
  return EFFORTS.indexOf(effort) > EFFORTS.indexOf(max) ? max : effort;
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

/**
 * The rung of a model id on the ladder. A fast-mode variant (`claude-opus-5-5-fast`, the id a
 * Run row carries for a fast-mode run, ADR 0057) is on its base model's rung.
 */
export function tierOfModel(
  modelId: string,
  ladder: LadderRung[] = DEFAULT_LADDER,
): ModelTier | null {
  for (const r of ladder) if (Object.values(r.models).includes(modelId)) return r.tier;
  const base = fastModeBaseId(modelId);
  if (base) {
    for (const r of ladder)
      if (Object.values(r.models).some((m) => canonicalModelId(m) === base)) return r.tier;
  }
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
