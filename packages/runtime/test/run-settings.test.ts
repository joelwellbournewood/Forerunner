import { describe, expect, it } from "vitest";
import { buildModelSettingsView } from "../src/daemon/model-settings-view.ts";
import { DEFAULT_LADDER, MODE_DEFAULTS } from "../src/models/ladder.ts";
import {
  decideSpeed,
  parseAgentModelConfig,
  projectAllowsFastMode,
  resolveRunSettings,
  type SpeedDecisionInput,
  specialistOverride,
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

describe("decideSpeed: a fast preference meets the project's leave (D.4 with D.20)", () => {
  const base: SpeedDecisionInput = {
    speedMode: "fast",
    projectAllows: true,
    tier: "opus",
    driver: "loop",
    sourceKind: "api_key",
    capabilities: { acceptsTemperature: false, fastMode: true },
    priced: true,
  };

  it("goes fast only when every condition holds", () => {
    expect(decideSpeed(base)).toEqual({ kind: "fast" });
    expect(decideSpeed({ ...base, sourceKind: null })).toEqual({ kind: "fast" });
    expect(decideSpeed({ ...base, speedMode: "standard" })).toEqual({ kind: "standard" });
  });

  it("stays standard and says why for each missing condition", () => {
    const cases: [Partial<SpeedDecisionInput>, RegExp][] = [
      [{ projectAllows: false }, /project does not allow fast mode/],
      [{ tier: "sonnet" }, /Opus only/],
      [{ driver: "sdk" }, /Agent SDK/],
      [{ sourceKind: "subscription" }, /API only/],
      [{ sourceKind: "plan_credits" }, /API only/],
      [{ capabilities: { acceptsTemperature: false, fastMode: false } }, /no fast mode/],
      [{ priced: false }, /no fast-mode price/],
    ];
    for (const [change, reason] of cases) {
      const d = decideSpeed({ ...base, ...change });
      expect(d.kind).toBe("ignored");
      if (d.kind === "ignored") expect(d.reason).toMatch(reason);
    }
  });

  it("reads the project's leave from the fast_mode key D.20 owns, literal true only", () => {
    expect(projectAllowsFastMode({ fast_mode: true })).toBe(true);
    expect(projectAllowsFastMode({ fast_mode: "true" })).toBe(false);
    expect(projectAllowsFastMode({})).toBe(false);
    expect(projectAllowsFastMode(undefined)).toBe(false);
  });

  it("fills a provider's missing capabilities with no temperature and no fast mode", () => {
    expect(providerCapabilities({})).toEqual(NO_TEMP);
    expect(providerCapabilities({ capabilities: TEMP })).toEqual(TEMP);
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
