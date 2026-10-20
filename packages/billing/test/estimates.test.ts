import { ForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { DEFAULT_RESERVE_SHARE } from "../src/caps.ts";
import {
  capsFromChf,
  DEFAULT_MONTHLY_CAP_CHF,
  DEFAULT_SESSION_CAP_CHF,
  defaultCaps,
} from "../src/defaults.ts";
import { EstimateTracker, MULTIPLIER_MAX, MULTIPLIER_MIN } from "../src/estimates.ts";
import { FixedRateSource } from "../src/rates.ts";
import { DEFAULT_PLAN_SHARE_CAP } from "../src/router.ts";

describe("EstimateTracker", () => {
  it("tracks mean absolute error and bias per specialist and task type", () => {
    const t = new EstimateTracker();
    t.record("coder", "code", 100, 150);
    t.record("coder", "code", 100, 50);
    expect(t.errorStats("coder", "code")).toEqual({ n: 2, meanAbsErrorRatio: 0.5, bias: 0 });
    t.record("coder", "test", 200, 300);
    expect(t.errorStats("coder")).toEqual({ n: 3, meanAbsErrorRatio: 0.5, bias: 0.5 / 3 });
    expect(t.errorStats("coder", "test")).toEqual({ n: 1, meanAbsErrorRatio: 0.5, bias: 0.5 });
    expect(t.errorStats("tester")).toEqual({ n: 0, meanAbsErrorRatio: 0, bias: 0 });
  });

  it("suggests a multiplier from the bias, shrunk toward 1 with few samples", () => {
    const t = new EstimateTracker();
    expect(t.suggestedMultiplier("coder")).toBe(1);
    for (let i = 0; i < 3; i++) t.record("coder", "code", 100, 150);
    expect(t.suggestedMultiplier("coder")).toBeCloseTo(1.25, 9);
    const many = new EstimateTracker({ shrinkage: 0 });
    many.record("coder", "code", 100, 150);
    expect(many.suggestedMultiplier("coder")).toBeCloseTo(1.5, 9);
  });

  it("clamps the multiplier to 0.5..3 and the ratio to -1..10", () => {
    const over = new EstimateTracker();
    for (let i = 0; i < 50; i++) over.record("coder", "code", 1, 1_000_000);
    expect(over.errorStats("coder").bias).toBe(10);
    expect(over.suggestedMultiplier("coder")).toBe(MULTIPLIER_MAX);
    const under = new EstimateTracker();
    for (let i = 0; i < 50; i++) under.record("coder", "code", 100, 0);
    expect(under.errorStats("coder").bias).toBe(-1);
    expect(under.suggestedMultiplier("coder")).toBe(MULTIPLIER_MIN);
    const zero = new EstimateTracker();
    expect(zero.record("coder", "code", 0, 5).ratio).toBe(5);
  });

  it("keeps only the newest samples per key", () => {
    const t = new EstimateTracker({ maxSamplesPerKey: 2 });
    t.record("coder", "code", 100, 100);
    t.record("coder", "code", 100, 200);
    t.record("coder", "code", 100, 300);
    t.record("coder", "test", 100, 100);
    expect(t.errorStats("coder", "code")).toEqual({ n: 2, meanAbsErrorRatio: 1.5, bias: 1.5 });
    expect(t.errorStats("coder").n).toBe(3);
  });

  it("round-trips through JSON and validates input", () => {
    const t = new EstimateTracker();
    t.record("coder", "code", 100, 120);
    t.record("writer", "docs", 50, 40);
    const copy = EstimateTracker.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
    expect(copy.errorStats("coder")).toEqual(t.errorStats("coder"));
    expect(copy.suggestedMultiplier("writer")).toBe(t.suggestedMultiplier("writer"));
    expect(() => t.record("", "code", 1, 1)).toThrow(ForerunnerError);
    expect(() => t.record("coder", "code", -1, 1)).toThrow(ForerunnerError);
    expect(() => t.record("coder", "code", 1.5, 1)).toThrow(ForerunnerError);
  });
});

describe("defaults", () => {
  it("converts the CHF defaults at the day's rate", async () => {
    expect(DEFAULT_MONTHLY_CAP_CHF).toBe(150);
    expect(DEFAULT_SESSION_CAP_CHF).toBe(5);
    expect(capsFromChf({}, 0.8)).toEqual({
      monthUsdMicro: 187_500_000,
      sessionUsdMicro: 6_250_000,
      reserveShare: DEFAULT_RESERVE_SHARE,
      planShareCap: DEFAULT_PLAN_SHARE_CAP,
    });
    expect(capsFromChf({}, 1).monthUsdMicro).toBe(150_000_000);
    expect(
      capsFromChf({ projectChf: 20, taskChf: 1, runChf: 0.5, reserveShare: 0.25 }, 0.8),
    ).toMatchObject({
      projectUsdMicro: 25_000_000,
      taskUsdMicro: 1_250_000,
      runUsdMicro: 625_000,
      reserveShare: 0.25,
    });
    const caps = await defaultCaps(new FixedRateSource(0.75), "2026-10-20", { sessionChf: 3 });
    expect(caps.monthUsdMicro).toBe(200_000_000);
    expect(caps.sessionUsdMicro).toBe(4_000_000);
  });
});
