import { describe, expect, it } from "vitest";
import {
  criticModeFor,
  criticSettingsOf,
  DEFAULT_DEEP_REVIEW_TIMEOUT_MS,
  pickCriticModel,
  stricterCeiling,
} from "../src/model.ts";
import { world } from "./helpers.ts";

describe("critic model pick (spec D effort table)", () => {
  it("tier 1 is Sonnet at medium effort with the 30 s target as its timeout", () => {
    const p = pickCriticModel(1, { provider: "fake" });
    expect(p).toMatchObject({
      mode: "critic_t1",
      tier: "sonnet",
      effort: "medium",
      model: "fake-sonnet",
      targetMs: 30_000,
      timeoutMs: 30_000,
      cappedByCeiling: false,
    });
    expect(criticModeFor(1)).toBe("critic_t1");
  });

  it("tiers 2 and 3 are Opus at high and max effort, timed by the task budget", () => {
    const t2 = pickCriticModel(2, { provider: "fake" });
    expect(t2).toMatchObject({
      mode: "critic_t23",
      tier: "opus",
      effort: "high",
      model: "fake-opus",
    });
    expect(t2.timeoutMs).toBe(DEFAULT_DEEP_REVIEW_TIMEOUT_MS);
    const t3 = pickCriticModel(3, { provider: "fake", timeoutMs: 1234 });
    expect(t3).toMatchObject({ tier: "opus", effort: "max", model: "fake-opus", timeoutMs: 1234 });
    expect(pickCriticModel(2, { provider: "anthropic" }).model).toBe("claude-opus-5-5");
  });

  it("the project ceiling caps the rung", () => {
    const p = pickCriticModel(2, { provider: "fake", ceiling: "sonnet" });
    expect(p).toMatchObject({ tier: "sonnet", model: "fake-sonnet", cappedByCeiling: true });
    expect(pickCriticModel(1, { provider: "fake", ceiling: "haiku" })).toMatchObject({
      tier: "haiku",
      model: "fake-haiku",
    });
    expect(pickCriticModel(1, { provider: "fake", ceiling: "fable" }).tier).toBe("sonnet");
  });

  it("the speed-versus-quality offset shifts effort one step and the prompt's max_effort caps it", () => {
    expect(pickCriticModel(1, { provider: "fake", effortOffset: 1 }).effort).toBe("high");
    expect(pickCriticModel(1, { provider: "fake", effortOffset: -1 }).effort).toBe("low");
    expect(pickCriticModel(3, { provider: "fake", maxEffort: "medium" }).effort).toBe("medium");
    expect(pickCriticModel(3, { provider: "fake", maxEffort: "max" }).effort).toBe("max");
  });

  it("reads critic_ceiling and speed_quality_offset from project settings and ignores junk", () => {
    expect(criticSettingsOf({ critic_ceiling: "sonnet", speed_quality_offset: 1 })).toEqual({
      ceiling: "sonnet",
      effortOffset: 1,
    });
    expect(criticSettingsOf({ critic_ceiling: "gpt", speed_quality_offset: 5 })).toEqual({});
    expect(criticSettingsOf(null)).toEqual({});
  });

  it("the stricter of two ceilings wins; a missing one defers to the other", () => {
    expect(stricterCeiling("opus", "sonnet")).toBe("sonnet");
    expect(stricterCeiling("sonnet", "opus")).toBe("sonnet");
    expect(stricterCeiling(undefined, "haiku")).toBe("haiku");
    expect(stricterCeiling("haiku", undefined)).toBe("haiku");
    expect(stricterCeiling(undefined, undefined)).toBeUndefined();
  });

  it("CriticService.modelFor applies the project settings; a call can lower the ceiling, never raise it", async () => {
    const w = await world();
    try {
      expect(w.critic.modelFor(2, { projectSettings: { critic_ceiling: "haiku" } }).model).toBe(
        "fake-haiku",
      );
      expect(
        w.critic.modelFor(2, { projectSettings: { critic_ceiling: "haiku" }, ceiling: "opus" })
          .model,
      ).toBe("fake-haiku");
      expect(
        w.critic.modelFor(2, { projectSettings: { critic_ceiling: "opus" }, ceiling: "sonnet" })
          .model,
      ).toBe("fake-sonnet");
      expect(w.critic.modelFor(1, {}).effort).toBe("medium");
    } finally {
      await w.close();
    }
  });

  it("CriticService.settingsFor reads the project row of the token's project when the context gives no settings", async () => {
    const w = await world({
      projectSettings: { critic_ceiling: "haiku", speed_quality_offset: -1 },
    });
    try {
      expect(await w.critic.settingsFor(w.ctx())).toEqual({
        ceiling: "haiku",
        effortOffset: -1,
      });
      // Settings given in the context are taken as they are (null means: none).
      expect(await w.critic.settingsFor(w.ctx({ projectSettings: null }))).toEqual({});
      expect(
        await w.critic.settingsFor(w.ctx({ projectSettings: { critic_ceiling: "sonnet" } })),
      ).toEqual({ ceiling: "sonnet" });
      // The context's own ceiling and offset are folded in: the stricter ceiling wins.
      expect(await w.critic.settingsFor(w.ctx({ ceiling: "opus", effortOffset: 1 }))).toEqual({
        ceiling: "haiku",
        effortOffset: 1,
      });
    } finally {
      await w.close();
    }
  });
});
