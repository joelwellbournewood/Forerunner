import { ForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  assertMicro,
  chfMicro,
  chfToUsdMicro,
  formatAmount,
  formatChf,
  formatUsd,
  fromCents,
  ratioOf,
  roundHalfUp,
  shareOf,
  sumMicro,
  toCents,
  toDecimal,
  usdMicro,
  usdToChfMicro,
} from "../src/money.ts";

describe("roundHalfUp", () => {
  it("rounds ties away from zero", () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-0.5)).toBe(-1);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(0.49)).toBe(0);
    expect(roundHalfUp(-0.49)).toBe(0);
    expect(Object.is(roundHalfUp(-0.2), 0)).toBe(true);
  });

  it("rejects non-finite input", () => {
    expect(() => roundHalfUp(Number.NaN)).toThrow(ForerunnerError);
    expect(() => roundHalfUp(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });
});

describe("micro-unit conversion", () => {
  it("converts decimals to micro-units without float noise", () => {
    expect(usdMicro(1.5)).toBe(1_500_000);
    expect(usdMicro(1.005)).toBe(1_005_000);
    expect(chfMicro(0.1 + 0.2)).toBe(300_000);
    expect(usdMicro(0.0000005)).toBe(1);
    expect(usdMicro(-0.0000005)).toBe(-1);
    expect(usdMicro(0.0000004)).toBe(0);
  });

  it("converts cents both ways", () => {
    expect(fromCents(123)).toBe(1_230_000);
    expect(toCents(1_235_000)).toBe(124);
    expect(toCents(1_234_999)).toBe(123);
    expect(() => fromCents(1.5)).toThrow(ForerunnerError);
    expect(toDecimal(2_500_000)).toBe(2.5);
  });

  it("only accepts integers as micro-units", () => {
    expect(assertMicro(5)).toBe(5);
    expect(() => assertMicro(1.5)).toThrow(/integer/);
    expect(() => assertMicro(Number.NaN)).toThrow(ForerunnerError);
    expect(() => sumMicro([1, 2.5])).toThrow(ForerunnerError);
    expect(sumMicro([1, 2, 3])).toBe(6);
  });
});

describe("formatting", () => {
  it("shows two decimals, rounding half-up", () => {
    expect(formatUsd(1_234_567)).toBe("USD 1.23");
    expect(formatChf(1_235_000)).toBe("CHF 1.24");
    expect(formatChf(1_234_999)).toBe("CHF 1.23");
    expect(formatChf(0)).toBe("CHF 0.00");
    expect(formatChf(-1_500_000)).toBe("CHF -1.50");
    expect(formatChf(5_000)).toBe("CHF 0.01");
    expect(formatChf(4_999)).toBe("CHF 0.00");
  });

  it("supports grouping and other precisions", () => {
    expect(formatAmount(1_234_567_890, { grouping: "'" })).toBe("1'234.57");
    expect(formatAmount(1_500_000, { decimals: 0 })).toBe("2");
    expect(formatAmount(5_000, { decimals: 4 })).toBe("0.0050");
    expect(formatAmount(123, { decimals: 6 })).toBe("0.000123");
    expect(() => formatAmount(1, { decimals: 7 })).toThrow(ForerunnerError);
  });
});

describe("currency conversion", () => {
  it("converts USD to CHF at a rate, rounding half-up", () => {
    expect(usdToChfMicro(1_000_000, 0.8)).toBe(800_000);
    expect(usdToChfMicro(1, 0.8)).toBe(1);
    expect(usdToChfMicro(3, 0.5)).toBe(2);
    expect(usdToChfMicro(1, 0.4)).toBe(0);
    expect(usdToChfMicro(-1_000_000, 0.8)).toBe(-800_000);
  });

  it("converts CHF to USD and rejects bad rates", () => {
    expect(chfToUsdMicro(800_000, 0.8)).toBe(1_000_000);
    expect(chfToUsdMicro(150_000_000, 0.8)).toBe(187_500_000);
    expect(() => usdToChfMicro(1, 0)).toThrow(ForerunnerError);
    expect(() => usdToChfMicro(1, -1)).toThrow(/positive/);
    expect(() => usdToChfMicro(1.5, 0.8)).toThrow(/integer/);
  });

  it("computes shares and ratios", () => {
    expect(shareOf(1_000_000, 0.2)).toBe(200_000);
    expect(shareOf(5, 0.5)).toBe(3);
    expect(ratioOf(800_000, 1_000_000)).toBe(0.8);
    expect(() => ratioOf(1, 0)).toThrow(ForerunnerError);
  });
});
