import { describe, expect, it } from "vitest";
import {
  chfMicroToUsdMicro,
  chfToMicro,
  formatAmount,
  formatChf,
  formatMoney,
  moneyTooltip,
  percent,
  spendRatio,
} from "../src/lib/money.ts";

describe("money formatting", () => {
  it("shows CHF with two decimals from chfMicro", () => {
    expect(formatChf(0)).toBe("CHF 0.00");
    expect(formatChf(12_340_000)).toBe("CHF 12.34");
    expect(formatChf(5_000)).toBe("CHF 0.01");
    expect(formatChf(4_999)).toBe("CHF 0.00");
    expect(formatChf(-1_500_000)).toBe("CHF -1.50");
  });

  it("rounds half-up with ties away from zero like the billing package", () => {
    expect(formatAmount(1_005_000)).toBe("1.01");
    expect(formatAmount(1_004_999)).toBe("1.00");
    expect(formatAmount(-1_005_000)).toBe("-1.01");
    expect(formatAmount(1_234_567, 4)).toBe("1.2346");
    expect(formatAmount(1_234_567, 0)).toBe("1");
  });

  it("groups thousands with the Swiss apostrophe", () => {
    expect(formatChf(1_234_567_000_000)).toBe("CHF 1'234'567.00");
  });

  it("refuses non-integer micro amounts", () => {
    expect(() => formatChf(1.5)).toThrow(/integer/);
  });

  it("never puts USD in the display string, only in the tooltip", () => {
    const value = { usdMicro: 10_000_000, chfMicro: 8_000_000 };
    expect(formatMoney(value)).toBe("CHF 8.00");
    expect(formatMoney(value)).not.toContain("USD");
    expect(moneyTooltip(value)).toBe("USD 10.00 at the day's rate");
  });

  it("computes the spend ratio against the cap and clamps it", () => {
    const cap = { usdMicro: 125_000_000, chfMicro: 100_000_000 };
    expect(spendRatio({ usdMicro: 0, chfMicro: 25_000_000 }, cap)).toBe(0.25);
    expect(spendRatio({ usdMicro: 0, chfMicro: 150_000_000 }, cap)).toBe(1);
    expect(spendRatio({ usdMicro: 0, chfMicro: 1 }, { usdMicro: 0, chfMicro: 0 })).toBe(0);
    expect(percent(0.256)).toBe("26%");
  });

  it("parses CHF input into micro-units", () => {
    expect(chfToMicro("5")).toBe(5_000_000);
    expect(chfToMicro(" 4.50 ")).toBe(4_500_000);
    expect(chfToMicro("1'250.10")).toBe(1_250_100_000);
    expect(chfToMicro("")).toBeNull();
    expect(chfToMicro("-1")).toBeNull();
    expect(chfToMicro("abc")).toBeNull();
  });

  it("converts CHF to USD micro at the rate implied by a Money pair, else the default 0.80", () => {
    expect(chfMicroToUsdMicro(4_000_000, { usdMicro: 125_000_000, chfMicro: 100_000_000 })).toBe(
      5_000_000,
    );
    expect(chfMicroToUsdMicro(4_000_000)).toBe(5_000_000);
    expect(chfMicroToUsdMicro(4_000_000, { usdMicro: 0, chfMicro: 0 })).toBe(5_000_000);
  });
});
