import { describe, expect, it } from "vitest";
import {
  effortForTask,
  effortWithOffset,
  modelIdFor,
  nextRung,
  retryAction,
  startingTier,
  tierOfModel,
} from "../src/models/ladder.ts";

describe("model ladder", () => {
  it("escalates one rung and never above the ceiling", () => {
    expect(nextRung("haiku")).toBe("sonnet");
    expect(nextRung("sonnet")).toBe("opus");
    expect(nextRung("opus")).toBeNull();
    expect(nextRung("opus", "fable")).toBe("fable");
    expect(nextRung("fable", "fable")).toBeNull();
  });

  it("applies the speed/quality offset within bounds", () => {
    expect(effortWithOffset("low", -1)).toBe("low");
    expect(effortWithOffset("high", 1)).toBe("xhigh");
    expect(effortWithOffset("max", 1)).toBe("max");
  });

  it("coding at tier 2+ uses high effort; tier 3 starts one rung higher", () => {
    expect(effortForTask("coder", 1)).toBe("medium");
    expect(effortForTask("coder", 2)).toBe("high");
    expect(effortForTask("critic_t23", 3)).toBe("max");
    expect(startingTier("sonnet", 3)).toBe("opus");
    expect(startingTier("sonnet", 1)).toBe("sonnet");
    expect(startingTier("opus", 3)).toBe("opus");
    expect(startingTier("fable", 0, "opus")).toBe("opus");
  });

  it("follows the retry ladder", () => {
    expect(retryAction(1, "sonnet")).toBe("improve_brief");
    expect(retryAction(2, "sonnet")).toBe("split_or_change_specialist");
    expect(retryAction(3, "sonnet")).toBe("escalate");
    expect(retryAction(3, "opus")).toBe("human");
    expect(retryAction(4, "sonnet")).toBe("human");
  });

  it("maps tiers to provider model ids", () => {
    expect(modelIdFor("haiku", "anthropic")).toBe("claude-haiku-5-5");
    expect(modelIdFor("sonnet", "fake")).toBe("fake-sonnet");
    expect(tierOfModel("claude-opus-5-5")).toBe("opus");
    expect(() => modelIdFor("haiku", "nope")).toThrow();
  });
});
