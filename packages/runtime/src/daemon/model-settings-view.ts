/**
 * The settings screen's model section (spec D.4, ADR 0072): every agent mode and every
 * runnable specialist with the model, effort, max tokens, speed mode and timeout in force, the
 * default each falls back to (the effort table or the registry file) and where the value comes
 * from; temperature only when the provider in use accepts one. Pure: the route hands it rows.
 */
import {
  DEFAULT_CEILING,
  type LadderRung,
  MODE_DEFAULTS,
  type Mode,
  type ModeDefault,
  specialistMode,
} from "../models/ladder.ts";
import {
  AGENT_SETTING_MODES,
  modeOverride,
  parseAgentModelConfig,
  type ResolvedRunSettings,
  type RunSettingField,
  resolveRunSettings,
  specialistOverride,
} from "../models/run-settings.ts";
import { DEFAULT_PROVIDER_CAPABILITIES, type ProviderCapabilities } from "../provider/types.ts";
import type { SpecialistDef } from "../registry/types.ts";
import type { ModelSettingsView, ModelSettingValueView, RunSettingsView } from "./api-types.ts";

export interface ModelSettingsViewInput {
  provider: { name: string; capabilities: ProviderCapabilities } | null;
  ladder: LadderRung[];
  modeDefaults: Record<Mode, ModeDefault>;
  /** The human's principal agent: its own modes and the specialist overrides it holds. */
  principal: { id: string; name: string; kind: string; model_config: unknown };
  /** Further agents of the human (the critic), shown read-only. */
  others: { id: string; name: string; kind: string }[];
  specialists: Pick<
    SpecialistDef,
    | "name"
    | "description"
    | "default_tier"
    | "max_effort"
    | "max_tokens"
    | "speed_mode"
    | "timeout_minutes"
    | "temperature"
  >[];
}

const minutes = (ms: number) => Math.round((ms / 60_000) * 100) / 100;

function value(
  r: ResolvedRunSettings,
  field: RunSettingField,
  pick: (v: ResolvedRunSettings["defaults"]) => string | number | null,
): ModelSettingValueView {
  return {
    value: pick(r),
    default: pick(r.defaults),
    source: r.sources[field],
    defaultSource: r.defaultSources[field],
  };
}

function settingsView(r: ResolvedRunSettings, input: ModelSettingsViewInput): RunSettingsView {
  const providerName = input.provider?.name;
  const rung = input.ladder.find((l) => l.tier === r.tier);
  return {
    mode: r.mode,
    model: providerName ? (rung?.models[providerName] ?? null) : null,
    tier: value(r, "tier", (v) => v.tier),
    effort: value(r, "effort", (v) => v.effort),
    maxTokens: value(r, "max_tokens", (v) => v.maxTokens),
    speedMode: value(r, "speed_mode", (v) => v.speedMode),
    timeoutMinutes: value(r, "timeout_minutes", (v) => minutes(v.timeoutMs)),
    // Temperature appears only for a provider that accepts it (spec D.4).
    ...(r.acceptsTemperature ? { temperature: value(r, "temperature", (v) => v.temperature) } : {}),
  };
}

export function buildModelSettingsView(input: ModelSettingsViewInput): ModelSettingsView {
  const capabilities = input.provider?.capabilities ?? DEFAULT_PROVIDER_CAPABILITIES;
  const parsed = parseAgentModelConfig(input.principal.model_config);
  const modeDefaults = input.modeDefaults ?? MODE_DEFAULTS;
  const principalModes = AGENT_SETTING_MODES.map((mode) =>
    settingsView(
      resolveRunSettings({
        mode,
        modeDefaults,
        override: modeOverride(parsed.config, mode),
        capabilities,
        // What runs: the chat and the intake stay under the default ceiling (spec D.3).
        ceiling: DEFAULT_CEILING,
      }),
      input,
    ),
  );
  const critic = (mode: Mode) =>
    settingsView(resolveRunSettings({ mode, modeDefaults, capabilities }), input);
  return {
    provider: {
      name: input.provider?.name ?? null,
      acceptsTemperature: capabilities.acceptsTemperature,
      fastMode: capabilities.fastMode,
    },
    table: (Object.keys(modeDefaults) as Mode[]).map((mode) => {
      const row = modeDefaults[mode];
      return {
        mode,
        tier: row.tier,
        effort: row.effort,
        maxTokens: row.maxTokens,
        speedMode: row.speedMode,
        timeoutMinutes: minutes(row.timeoutMs),
        targetMs: row.targetMs,
      };
    }),
    agents: [
      {
        id: input.principal.id,
        name: input.principal.name,
        kind: input.principal.kind,
        editable: true,
        note: null,
        modes: principalModes,
      },
      ...input.others.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        editable: false,
        note:
          a.kind === "critic"
            ? "The critic's model and effort follow its review tiers (spec H): tier 1 and tiers 2 and 3."
            : "Runs with the effort table's defaults.",
        modes: a.kind === "critic" ? [critic("critic_t1"), critic("critic_t23")] : [],
      })),
    ],
    specialists: input.specialists.map((d) => ({
      name: d.name,
      description: d.description,
      maxEffort: d.max_effort,
      overridesAgentId: input.principal.id,
      settings: settingsView(
        resolveRunSettings({
          mode: specialistMode(d.name),
          modeDefaults,
          specialist: {
            tier: d.default_tier,
            maxEffort: d.max_effort,
            timeoutMs: d.timeout_minutes * 60_000,
            ...(d.max_tokens !== undefined ? { maxTokens: d.max_tokens } : {}),
            ...(d.speed_mode !== undefined ? { speedMode: d.speed_mode } : {}),
            ...(d.temperature !== undefined ? { temperature: d.temperature } : {}),
          },
          override: specialistOverride(parsed.config, d.name),
          capabilities,
        }),
        input,
      ),
    })),
    configError: parsed.error,
  };
}
