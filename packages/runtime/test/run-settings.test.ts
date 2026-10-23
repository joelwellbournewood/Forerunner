import { BUILTIN_PRICING } from "@forerunner/billing";
import { describe, expect, it } from "vitest";
import { buildModelSettingsView } from "../src/daemon/model-settings-view.ts";
import {
  decideFastMode,
  FAST_MODE_SETTING,
  type FastModeInput,
  fastModeOf,
} from "../src/models/fast-mode.ts";
import { DEFAULT_LADDER, MODE_DEFAULTS } from "../src/models/ladder.ts";
import {
  explicitSpeedMode,
  PROJECT_FAST_MODE_KEY,
  parseAgentModelConfig,
  resolveRunSettings,
  specialistOverride,
  speedPreferenceNote,
} from "../src/models/run-settings.ts";
import { builtinModelConfig } from "../src/models/settings.ts";
import { providerCapabilities } from "../src/provider/types.ts";

const NO_TEMP = { acceptsTemperature: false, fastMode: false };
const TEMP = { acceptsTemperature: true, fastMode: false };

describe("resolveRunSettings (spec D.4, ADR 0072)", () => {
  it("takes the effort table's row for an agent mode with no override", () => {
    const r = resolveRunSettings({ mode: "planning" });
    expect(r).toMatchObject({
      tier: MODE_DEFAULTS.planning.tier,
      effort: MODE_DEFAULTS.planning.effort,
      maxTokens: 16_000,
      speedMode: "standard",
      timeoutMs: 300_000,
      temperature: null,
      targetMs: 60_000,
    });
    expect(Object.values(r.sources).every((s) => s === "table")).toBe(true);
  });

  it("caps a specialist's effort at its file's max_effort, the default and the override alike", () => {
    const capped = resolveRunSettings({
      mode: "researcher",
      specialist: { tier: "sonnet", maxEffort: "medium" },
      override: { effort: "max" },
    });
    // The research row says high, the agent asked for max: the file allows medium.
    expect(capped.effort).toBe("medium");
    expect(capped.defaults.effort).toBe("medium");
    expect(capped.sources.effort).toBe("agent");
    const under = resolveRunSettings({
      mode: "coder",
      specialist: { tier: "sonnet", maxEffort: "high" },
      override: { effort: "low" },
    });
    expect(under.effort).toBe("low");
  });

  it("keeps the rung under the ceiling it is given, whatever the override asks", () => {
    const capped = resolveRunSettings({
      mode: "planning",
      override: { tier: "fable" },
      ceiling: "opus",
    });
    expect(capped.tier).toBe("opus");
    expect(capped.sources.tier).toBe("agent");
    expect(resolveRunSettings({ mode: "planning", override: { tier: "fable" } }).tier).toBe(
      "fable",
    );
    expect(
      resolveRunSettings({ mode: "planning", override: { tier: "fable" }, ceiling: "fable" }).tier,
    ).toBe("fable");
    const low = resolveRunSettings({ mode: "planning", ceiling: "haiku" });
    expect([low.tier, low.defaults.tier]).toEqual(["haiku", "haiku"]);
  });

  it("orders the table, then the specialist file, then the agent's override", () => {
    const specialist = { tier: "haiku" as const, maxTokens: 2000, timeoutMs: 10 * 60_000 };
    const fileOnly = resolveRunSettings({ mode: "coder", specialist });
    expect(fileOnly).toMatchObject({ tier: "haiku", maxTokens: 2000, timeoutMs: 600_000 });
    expect(fileOnly.sources).toMatchObject({
      tier: "specialist",
      max_tokens: "specialist",
      speed_mode: "table",
      effort: "table",
    });
    const overridden = resolveRunSettings({
      mode: "coder",
      specialist,
      override: {
        tier: "opus",
        effort: "high",
        max_tokens: 9000,
        speed_mode: "fast",
        timeout_minutes: 3,
      },
    });
    expect(overridden).toMatchObject({
      tier: "opus",
      effort: "high",
      maxTokens: 9000,
      speedMode: "fast",
      timeoutMs: 180_000,
    });
    expect(overridden.sources).toMatchObject({
      tier: "agent",
      effort: "agent",
      max_tokens: "agent",
      speed_mode: "agent",
      timeout_minutes: "agent",
    });
    // The defaults stay what applies without the override, for the settings screen.
    expect(overridden.defaults).toMatchObject({
      tier: "haiku",
      maxTokens: 2000,
      speedMode: "standard",
    });
    expect(overridden.defaultSources.max_tokens).toBe("specialist");
  });

  it("uses the effort table in force (an adopted effort reaches the default)", () => {
    const config = builtinModelConfig();
    config.modeDefaults.text_chat = { ...config.modeDefaults.text_chat, effort: "medium" };
    expect(
      resolveRunSettings({ mode: "text_chat", modeDefaults: config.modeDefaults }).effort,
    ).toBe("medium");
  });

  it("keeps a temperature only for a provider that accepts one", () => {
    const input = {
      mode: "coder" as const,
      specialist: { tier: "sonnet" as const, temperature: 0.2 },
      override: { temperature: 0.7 },
    };
    const refused = resolveRunSettings({ ...input, capabilities: NO_TEMP });
    expect(refused.temperature).toBeNull();
    expect(refused.acceptsTemperature).toBe(false);
    expect(refused.sources.temperature).toBe("table");
    const accepted = resolveRunSettings({ ...input, capabilities: TEMP });
    expect(accepted.temperature).toBe(0.7);
    expect(accepted.sources.temperature).toBe("agent");
    expect(accepted.defaults.temperature).toBe(0.2);
  });
});

describe("agent model_config (ADR 0072)", () => {
  it("reads modes and specialists, keeps other keys, and refuses a malformed document whole", () => {
    const ok = parseAgentModelConfig({
      modes: { planning: { max_tokens: 20_000 } },
      specialists: { coder: { speed_mode: "fast" } },
      later_feature: { x: 1 },
    });
    expect(ok.error).toBeNull();
    expect(specialistOverride(ok.config, "coder")).toEqual({ speed_mode: "fast" });
    expect(specialistOverride(ok.config, "tester")).toEqual({});
    expect(specialistOverride(ok.config, "constructor")).toEqual({});
    const bad = parseAgentModelConfig({
      specialists: { coder: { max_tokens: -1, colour: "red" } },
    });
    expect(bad.config).toEqual({});
    expect(bad.error).toMatch(/specialists\.coder/);
    expect(parseAgentModelConfig(null)).toEqual({ config: {}, error: null });
  });
});

describe("speed mode meets the project's Opus fast mode (D.4 with D.20's decideFastMode)", () => {
  const base: FastModeInput = {
    enabled: true,
    tier: "opus",
    model: "claude-opus-5-5",
    driver: "loop",
    sourceKind: "api_key",
    provider: { name: "anthropic", fastMode: true },
    pricing: BUILTIN_PRICING,
    speedMode: "fast",
  };

  it("goes fast only when every condition holds; no preference leaves it to the project", () => {
    const applied = {
      kind: "applied",
      model: "claude-opus-5-5",
      variant: "claude-opus-5-5-fast",
    };
    expect(decideFastMode(base)).toEqual(applied);
    expect(decideFastMode({ ...base, sourceKind: null })).toEqual(applied);
    // The table's `standard` is no preference: D.20's project flag alone decides.
    const { speedMode: _none, ...noPreference } = base;
    expect(decideFastMode(noPreference)).toEqual(applied);
    // An explicit `standard` keeps a fast-mode project's Opus run standard, and says so.
    const standard = decideFastMode({ ...base, speedMode: "standard" });
    expect(standard.kind).toBe("ignored");
    if (standard.kind === "ignored") expect(standard.reason).toMatch(/speed mode is standard/);
  });

  it("stays standard and says why for each missing condition", () => {
    const cases: [Partial<FastModeInput>, RegExp][] = [
      [{ driver: "sdk" }, /Agent SDK/],
      [{ sourceKind: "subscription" }, /API only/],
      [{ sourceKind: "plan_credits" }, /API only/],
      [{ provider: { name: "fake", fastMode: false } }, /no fast mode/],
      [{ pricing: {} }, /no fast-mode price row/],
    ];
    for (const [change, reason] of cases) {
      const d = decideFastMode({ ...base, ...change });
      expect(d.kind).toBe("ignored");
      if (d.kind === "ignored") expect(d.reason).toMatch(reason);
    }
    // Without the project's leave or off Opus the decision is off; the preference's note says why.
    expect(decideFastMode({ ...base, enabled: false })).toEqual({ kind: "off" });
    expect(decideFastMode({ ...base, tier: "sonnet" })).toEqual({ kind: "off" });
    expect(speedPreferenceNote({ speedMode: "fast", projectAllows: false, tier: "opus" })).toMatch(
      /project does not allow fast mode/,
    );
    expect(speedPreferenceNote({ speedMode: "fast", projectAllows: true, tier: "sonnet" })).toMatch(
      /Opus only/,
    );
    expect(
      speedPreferenceNote({ speedMode: "fast", projectAllows: true, tier: "opus" }),
    ).toBeNull();
    expect(
      speedPreferenceNote({ speedMode: "standard", projectAllows: false, tier: "opus" }),
    ).toBeNull();
    expect(
      speedPreferenceNote({ speedMode: undefined, projectAllows: false, tier: "opus" }),
    ).toBeNull();
  });

  it("passes a speed mode on only when the file or the agent set one", () => {
    const table = resolveRunSettings({ mode: "coder", specialist: { tier: "opus" } });
    expect(explicitSpeedMode(table)).toBeUndefined();
    const file = resolveRunSettings({
      mode: "coder",
      specialist: { tier: "opus", speedMode: "standard" },
    });
    expect(explicitSpeedMode(file)).toBe("standard");
    const agent = resolveRunSettings({
      mode: "coder",
      specialist: { tier: "opus" },
      override: { speed_mode: "fast" },
    });
    expect(explicitSpeedMode(agent)).toBe("fast");
  });

  it("reads the project's leave from the fast_mode key D.20 owns, literal true only", () => {
    expect(PROJECT_FAST_MODE_KEY).toBe(FAST_MODE_SETTING);
    expect(fastModeOf({ fast_mode: true })).toBe(true);
    expect(fastModeOf({ fast_mode: "true" })).toBe(false);
    expect(fastModeOf({})).toBe(false);
    expect(fastModeOf(undefined)).toBe(false);
  });

  it("fills a provider's missing capabilities with no temperature and no fast mode", () => {
    expect(providerCapabilities({})).toEqual(NO_TEMP);
    expect(providerCapabilities({ capabilities: TEMP })).toEqual(TEMP);
    expect(providerCapabilities({ fastMode: true })).toEqual({
      acceptsTemperature: false,
      fastMode: true,
    });
  });
});

describe("the settings screen's view (GET /settings/models)", () => {
  const specialists = [
    {
      name: "coder",
      description: "writes code",
      default_tier: "sonnet" as const,
      max_effort: "high" as const,
      timeout_minutes: 45,
      max_tokens: undefined,
      speed_mode: undefined,
      temperature: 0.4,
    },
  ];
  const view = (acceptsTemperature: boolean, model_config: unknown = {}) =>
    buildModelSettingsView({
      provider: { name: "fake", capabilities: { acceptsTemperature, fastMode: false } },
      ladder: DEFAULT_LADDER,
      modeDefaults: MODE_DEFAULTS,
      principal: { id: "a1", name: "Alice", kind: "principal", model_config },
      others: [{ id: "c1", name: "Critic", kind: "critic" }],
      specialists,
    });

  it("shows model, effort, max tokens, speed mode and timeout with defaults and sources", () => {
    const v = view(false, { specialists: { coder: { max_tokens: 9000 } } });
    expect(v.provider).toEqual({ name: "fake", acceptsTemperature: false, fastMode: false });
    const alice = v.agents[0];
    expect(alice?.editable).toBe(true);
    expect(alice?.modes.map((m) => m.mode)).toEqual(["planning", "text_chat"]);
    expect(alice?.modes[1]).toMatchObject({
      model: "fake-haiku",
      maxTokens: { value: 400, default: 400, source: "table" },
      timeoutMinutes: { value: 0.5, source: "table" },
      speedMode: { value: "standard" },
    });
    expect(v.agents[1]).toMatchObject({ kind: "critic", editable: false });
    expect(v.agents[1]?.modes.map((m) => m.mode)).toEqual(["critic_t1", "critic_t23"]);
    const coder = v.specialists[0];
    expect(coder?.settings).toMatchObject({
      model: "fake-sonnet",
      maxTokens: { value: 9000, default: 4096, source: "agent", defaultSource: "table" },
      timeoutMinutes: { value: 45, source: "specialist" },
    });
    expect(v.table.find((r) => r.mode === "coder")).toMatchObject({
      maxTokens: 4096,
      speedMode: "standard",
    });
    expect(v.configError).toBeNull();
  });

  it("shows the rung and the effort that can run: the agent modes under the default ceiling, a specialist under its max_effort", () => {
    const v = view(false, {
      modes: { planning: { tier: "fable" } },
      specialists: { coder: { effort: "max" } },
    });
    expect(v.agents[0]?.modes[0]).toMatchObject({
      model: "fake-opus",
      tier: { value: "opus", source: "agent" },
    });
    expect(v.specialists[0]?.settings.effort).toMatchObject({ value: "high", source: "agent" });
  });

  it("carries temperature only when the provider's flag is true", () => {
    const without = view(false);
    expect(without.specialists[0]?.settings).not.toHaveProperty("temperature");
    expect(without.agents[0]?.modes[0]).not.toHaveProperty("temperature");
    const withTemp = view(true);
    expect(withTemp.specialists[0]?.settings.temperature).toEqual({
      value: 0.4,
      default: 0.4,
      source: "specialist",
      defaultSource: "specialist",
    });
    expect(withTemp.agents[0]?.modes[0]?.temperature).toMatchObject({ value: null });
  });

  it("names a malformed model_config and shows the defaults", () => {
    const v = view(false, { modes: { planning: { max_tokens: "lots" } } });
    expect(v.configError).toMatch(/modes\.planning\.max_tokens/);
    expect(v.agents[0]?.modes[0]?.maxTokens.value).toBe(16_000);
  });
});
