/**
 * Settings per agent and per specialist (spec D.4, ADR 0072): model (the ladder rung), effort,
 * max tokens, speed mode, timeout and, only for a provider that accepts one, temperature.
 *
 * Where a value comes from, lowest first:
 *
 *   1. the effort table (`MODE_DEFAULTS`, D.8 to D.15) row of the run's mode, as adopted by the
 *      model watch (`EffectiveModelConfig.modeDefaults`);
 *   2. for a specialist, its registry frontmatter (`default_tier`, `max_tokens`, `speed_mode`,
 *      `timeout_minutes`, `temperature`);
 *   3. the agent row's `model_config`: `modes.<planning|text_chat>` for the principal's own
 *      runs, `specialists.<name>` for the specialists it delegates to. The settings screen and
 *      chat write it through the `model.settings.set` command (one change log row per change).
 *
 * The effort of a specialist run keeps the table's coding/research rules (tier 2+ coding runs
 * at high, `effortForTask`); an agent override replaces the table's base effort only.
 *
 * Speed mode composes with the project's Opus fast mode (spec D.20, ADR 0057), whose
 * `decideFastMode` stays the one place a run is made fast: a project with `fast_mode` on runs
 * its Opus rungs fast unless the specialist's file or the agent sets `speed_mode: standard`; a
 * `fast` preference takes effect only where the project allows it, and otherwise runs standard
 * and says why (`explicitSpeedMode`, `speedPreferenceNote`).
 *
 * Browser-safe: zod and the pure tables only, so `daemon/api-types.ts` and the UI can use it.
 */
import { z } from "zod";
import {
  DEFAULT_PROVIDER_CAPABILITIES,
  type EffortLevel,
  type ModelTier,
  type ProviderCapabilities,
  type SpeedMode,
} from "../provider/types.ts";
import {
  EFFORT_VALUES,
  MaxTokensSchema,
  NAME_RE,
  SpeedModeSchema,
  TemperatureSchema,
  TIER_VALUES,
  TimeoutMinutesSchema,
} from "../registry/types.ts";
import { MODE_DEFAULTS, type Mode, type ModeDefault } from "./ladder.ts";

/** The settings D.4 names, as the `model_config` and frontmatter keys spell them. */
export const RUN_SETTING_FIELDS = [
  "tier",
  "effort",
  "max_tokens",
  "speed_mode",
  "timeout_minutes",
  "temperature",
] as const;
export type RunSettingField = (typeof RUN_SETTING_FIELDS)[number];

/** One override set: every key optional; an absent key falls back to the next source down. */
export const RunSettingsOverrideSchema = z
  .object({
    tier: z.enum(TIER_VALUES).optional(),
    effort: z.enum(EFFORT_VALUES).optional(),
    max_tokens: MaxTokensSchema.optional(),
    speed_mode: SpeedModeSchema.optional(),
    timeout_minutes: TimeoutMinutesSchema.optional(),
    temperature: TemperatureSchema.optional(),
  })
  .strict();
export type RunSettingsOverride = z.infer<typeof RunSettingsOverrideSchema>;

/**
 * The modes a principal agent's own runs are in: planning (the intake plan) and text chat (the
 * conversation turns that speak for it). The critic's model and effort follow its review tiers
 * (spec H, `pickCriticModel`) and are shown, not set, here.
 */
export const AGENT_SETTING_MODES = ["planning", "text_chat"] as const satisfies readonly Mode[];
export type AgentSettingMode = (typeof AGENT_SETTING_MODES)[number];

/** `agent.model_config`: the D.4 overrides; other keys a later feature adds are kept as they are. */
export const AgentModelConfigSchema = z.looseObject({
  modes: z.partialRecord(z.enum(AGENT_SETTING_MODES), RunSettingsOverrideSchema).optional(),
  specialists: z
    .record(
      z.string().regex(NAME_RE, "specialist names are registry names"),
      RunSettingsOverrideSchema,
    )
    .optional(),
});
export type AgentModelConfig = z.infer<typeof AgentModelConfigSchema>;

/**
 * An agent row's `model_config`, read leniently: a document that does not validate yields no
 * overrides and the reason, so a hand-edited typo falls back to the defaults and is reported,
 * never applied half-way and never fatal to a run.
 */
export function parseAgentModelConfig(json: unknown): {
  config: AgentModelConfig;
  error: string | null;
} {
  const parsed = AgentModelConfigSchema.safeParse(json ?? {});
  if (parsed.success) return { config: parsed.data, error: null };
  return {
    config: {},
    error: parsed.error.issues.map((i) => `${i.path.join(".") || "-"}: ${i.message}`).join("; "),
  };
}

/** The agent's override for one specialist (empty when it has none). */
export function specialistOverride(config: AgentModelConfig, name: string): RunSettingsOverride {
  const all = config.specialists ?? {};
  return Object.hasOwn(all, name) ? (all[name] ?? {}) : {};
}

/** The agent's override for one of its own modes (empty when it has none). */
export function modeOverride(
  config: AgentModelConfig,
  mode: AgentSettingMode,
): RunSettingsOverride {
  return config.modes?.[mode] ?? {};
}

/** What a specialist's registry file says about the D.4 settings (absent keys: the table). */
export interface SpecialistRunDefaults {
  tier: ModelTier;
  maxTokens?: number;
  speedMode?: SpeedMode;
  timeoutMs?: number;
  temperature?: number;
}

/** Where a value in force came from. */
export type RunSettingSource = "table" | "specialist" | "agent";

export interface RunSettingsValues {
  tier: ModelTier;
  effort: EffortLevel;
  maxTokens: number;
  speedMode: SpeedMode;
  timeoutMs: number;
  /** Null: no temperature is sent (the provider does not accept one, or nothing sets it). */
  temperature: number | null;
}

export interface ResolvedRunSettings extends RunSettingsValues {
  mode: Mode;
  /** The mode's response target from the table (not a setting: what the run is measured against). */
  targetMs: number;
  /** The source of each value in force. */
  sources: Record<RunSettingField, RunSettingSource>;
  /** What applies without the agent's override: the specialist file, else the effort table. */
  defaults: RunSettingsValues;
  defaultSources: Record<RunSettingField, Exclude<RunSettingSource, "agent">>;
  /** Whether the provider accepts a temperature; when false the setting is never sent or shown. */
  acceptsTemperature: boolean;
}

export interface ResolveRunSettingsInput {
  mode: Mode;
  /** The effort table in force (built-ins plus adopted overrides); default the built-ins. */
  modeDefaults?: Record<Mode, ModeDefault>;
  /** For a specialist run: what its registry file says. */
  specialist?: SpecialistRunDefaults;
  /** The agent row's override for this mode or specialist. */
  override?: RunSettingsOverride;
  /** The provider's capability flags; default: no temperature, no fast mode. */
  capabilities?: ProviderCapabilities;
}

/** The settings in force for one run (pure; see the module comment for the order). */
export function resolveRunSettings(input: ResolveRunSettingsInput): ResolvedRunSettings {
  const row = (input.modeDefaults ?? MODE_DEFAULTS)[input.mode] ?? MODE_DEFAULTS[input.mode];
  const caps = { ...DEFAULT_PROVIDER_CAPABILITIES, ...(input.capabilities ?? {}) };
  const s = input.specialist;
  const o = input.override ?? {};

  const pick = <T>(
    specialist: T | undefined,
    table: T,
  ): { value: T; source: Exclude<RunSettingSource, "agent"> } =>
    specialist !== undefined
      ? { value: specialist, source: "specialist" }
      : { value: table, source: "table" };

  const tier = s ? { value: s.tier, source: "specialist" as const } : pick(undefined, row.tier);
  const effort = pick<EffortLevel>(undefined, row.effort);
  const maxTokens = pick(s?.maxTokens, row.maxTokens);
  const speedMode = pick(s?.speedMode, row.speedMode);
  const timeoutMs = pick(s?.timeoutMs, row.timeoutMs);
  const temperature = pick<number | null>(
    caps.acceptsTemperature ? s?.temperature : undefined,
    null,
  );

  const defaults: RunSettingsValues = {
    tier: tier.value,
    effort: effort.value,
    maxTokens: maxTokens.value,
    speedMode: speedMode.value,
    timeoutMs: timeoutMs.value,
    temperature: temperature.value,
  };
  const defaultSources: Record<RunSettingField, Exclude<RunSettingSource, "agent">> = {
    tier: tier.source,
    effort: effort.source,
    max_tokens: maxTokens.source,
    speed_mode: speedMode.source,
    timeout_minutes: timeoutMs.source,
    temperature: temperature.source,
  };

  const sources: Record<RunSettingField, RunSettingSource> = { ...defaultSources };
  const values: RunSettingsValues = { ...defaults };
  if (o.tier !== undefined) {
    values.tier = o.tier;
    sources.tier = "agent";
  }
  if (o.effort !== undefined) {
    values.effort = o.effort;
    sources.effort = "agent";
  }
  if (o.max_tokens !== undefined) {
    values.maxTokens = o.max_tokens;
    sources.max_tokens = "agent";
  }
  if (o.speed_mode !== undefined) {
    values.speedMode = o.speed_mode;
    sources.speed_mode = "agent";
  }
  if (o.timeout_minutes !== undefined) {
    values.timeoutMs = o.timeout_minutes * 60_000;
    sources.timeout_minutes = "agent";
  }
  if (o.temperature !== undefined && caps.acceptsTemperature) {
    values.temperature = o.temperature;
    sources.temperature = "agent";
  }
  return {
    mode: input.mode,
    targetMs: row.targetMs,
    ...values,
    sources,
    defaults,
    defaultSources,
    acceptsTemperature: caps.acceptsTemperature,
  };
}

/**
 * The project settings key that allows fast mode: `fast_mode` (spec D.20 owns the key, its
 * command and `fastModeOf` in `models/fast-mode.ts`; this module repeats the name so it stays
 * browser-safe, and a test keeps the two equal).
 */
export const PROJECT_FAST_MODE_KEY = "fast_mode";

/**
 * The run's speed mode when something set it explicitly (the specialist's file or the agent's
 * `model_config`), else undefined: the effort table's `standard` is no preference, so a project
 * with `fast_mode` on still runs its Opus rungs fast (spec D.20, ADR 0057). This is the
 * `speedMode` input of `decideFastMode` (ADR 0072, amendment after the rebase onto D.20).
 */
export function explicitSpeedMode(
  settings: Pick<ResolvedRunSettings, "speedMode" | "sources">,
): SpeedMode | undefined {
  return settings.sources.speed_mode === "table" ? undefined : settings.speedMode;
}

export interface SpeedPreferenceInput {
  /** `explicitSpeedMode(settings)`. */
  speedMode: SpeedMode | undefined;
  /** The project's `fast_mode` flag; false for a run without a project. */
  projectAllows: boolean;
  tier: ModelTier;
}

/**
 * Why a `fast` preference cannot take effect before `decideFastMode` is asked: the project does
 * not allow fast mode, or the run is not on the Opus rung. Null when there is no `fast`
 * preference or those two hold (then `decideFastMode` decides, with its own reasons: API only,
 * the Agent SDK path, the provider, the price row). Pure; the executor warns with it.
 */
export function speedPreferenceNote(input: SpeedPreferenceInput): string | null {
  if (input.speedMode !== "fast") return null;
  if (!input.projectAllows)
    return `the project does not allow fast mode (project setting ${PROJECT_FAST_MODE_KEY})`;
  if (input.tier !== "opus") return `fast mode exists for Opus only; this run is on ${input.tier}`;
  return null;
}
