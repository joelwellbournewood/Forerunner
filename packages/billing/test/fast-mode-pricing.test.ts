import { SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { CostLedger } from "../src/ledger.ts";
import {
  BUILTIN_PRICING,
  canonicalModelId,
  costOf,
  estimateUsdMicro,
  FAST_MODE_RATE_NOTE,
  FAST_MODE_SUFFIX,
  fastModeBaseId,
  fastModeBillable,
  fastModeVariantId,
  isFastModeVariant,
  mergePricing,
  priceFor,
} from "../src/pricing.ts";
import { FixedRateSource } from "../src/rates.ts";
import { InMemoryLedger } from "../src/sink.ts";
import { BILLING_SOURCE_KINDS, makeBillingSource } from "../src/sources.ts";

/**
 * Opus fast mode (spec D.20, ADR 0057): the variant is priced from its own rows named for it
 * (`<base>-fast`), so the ledger, the estimates and the cost tables show it apart from the
 * standard rung. The rows are the provider's published fast-mode rates and live in the one price table.
 */
const M = 1_000_000;

describe("fast-mode price rows (D.20)", () => {
  it("the Opus 5.5 variant has its own row at the published fast-mode rate, twice the standard row", () => {
    const fast = priceFor("claude-opus-5-5-fast");
    const standard = priceFor("claude-opus-5-5");
    expect(fast).toMatchObject({
      input_per_mtok_usd: 8,
      output_per_mtok_usd: 40,
      cache_read_per_mtok_usd: 0.4,
      cache_write_per_mtok_usd: 10,
    });
    for (const field of [
      "input_per_mtok_usd",
      "output_per_mtok_usd",
      "cache_read_per_mtok_usd",
      "cache_write_per_mtok_usd",
    ] as const) {
      expect(fast[field]).toBeCloseTo(standard[field] * 2, 9);
    }
    expect(fast.notes).toContain(FAST_MODE_RATE_NOTE);
    // Generally available on Opus 5.5 (provider pricing page, 2026-10-25): not a research preview.
    expect(fast.notes).not.toContain("research preview");
    // Read off the provider's fast-mode price list (2026-10-25), no longer derived from 4.6's 6x.
    expect(fast.source).toBe("list");
    expect(fast.as_of).toBe("2026-10-25");
  });

  it("the Opus 4.6 variant keeps the research-preview list price published when ADR 0057 was written", () => {
    const fast = priceFor("claude-opus-4-6-fast");
    expect(fast).toMatchObject({
      input_per_mtok_usd: 30,
      output_per_mtok_usd: 150,
      source: "list",
    });
    expect(fast.notes).toContain(FAST_MODE_RATE_NOTE);
    expect(fast.input_per_mtok_usd / priceFor("claude-opus-4-6").input_per_mtok_usd).toBe(6);
  });

  it("every fast row is named for a variant of a standard row in the same table", () => {
    const variants = Object.keys(BUILTIN_PRICING).filter(isFastModeVariant);
    expect(variants.sort()).toEqual(["claude-opus-4-6-fast", "claude-opus-5-5-fast"]);
    for (const v of variants) {
      const base = fastModeBaseId(v);
      expect(base && BUILTIN_PRICING[base]).toBeTruthy();
      expect(v).toBe(`${base}${FAST_MODE_SUFFIX}`);
    }
  });

  it("names the variant from any spelling of the base id and back", () => {
    expect(fastModeVariantId("claude-opus-5-5")).toBe("claude-opus-5-5-fast");
    expect(fastModeVariantId("anthropic.claude-opus-5-5-20261001")).toBe("claude-opus-5-5-fast");
    // Already a variant: unchanged, never "-fast-fast".
    expect(fastModeVariantId("claude-opus-5-5-fast")).toBe("claude-opus-5-5-fast");
    expect(fastModeBaseId("claude-opus-5-5-fast")).toBe("claude-opus-5-5");
    expect(fastModeBaseId("claude-opus-5-5")).toBeNull();
    expect(isFastModeVariant("claude-opus-5-5")).toBe(false);
    // canonicalModelId keeps the suffix: the variant is a row of its own, not a spelling.
    expect(canonicalModelId("claude-opus-5-5-fast")).toBe("claude-opus-5-5-fast");
  });

  it("costs and estimates read the variant's rate, apart from the standard rung", () => {
    const usage = { tokens_in: 10_000, tokens_out: 2_000 };
    const standard = costOf(usage, "claude-opus-5-5");
    const fast = costOf(usage, "claude-opus-5-5-fast");
    expect(standard).toBe(10_000 * 4 + 2_000 * 20);
    expect(fast).toBe(10_000 * 8 + 2_000 * 40);
    expect(fast).toBe(standard * 2);
    expect(
      estimateUsdMicro({ inputTokens: 1_000, maxOutputTokens: 4_096 }, "claude-opus-5-5-fast"),
    ).toBe(1_000 * 8 + 4_096 * 40);
  });

  it("an override in pricing.json corrects the variant without touching the standard row", () => {
    const table = mergePricing(BUILTIN_PRICING, {
      "claude-opus-5-5-fast": { input_per_mtok_usd: 30, output_per_mtok_usd: 150 },
    });
    expect(priceFor("claude-opus-5-5-fast", table)).toMatchObject({
      input_per_mtok_usd: 30,
      output_per_mtok_usd: 150,
      source: "override",
    });
    expect(priceFor("claude-opus-5-5", table)).toEqual(BUILTIN_PRICING["claude-opus-5-5"]);
  });

  it("fast mode is billable on API-style sources only", () => {
    const billable = BILLING_SOURCE_KINDS.filter(fastModeBillable);
    expect(billable.sort()).toEqual(["api_key", "fake"]);
    expect(fastModeBillable("subscription")).toBe(false);
    expect(fastModeBillable("plan_credits")).toBe(false);
  });

  it("the ledger records the variant under its own model and the allocation lists it apart", async () => {
    const clock = new SimulatedClock("2026-10-23T10:00:00.000Z");
    const mem = new InMemoryLedger(clock);
    const ledger = new CostLedger({
      sink: mem,
      query: mem,
      rates: new FixedRateSource(0.8),
      clock,
    });
    const source = makeBillingSource({ id: "alice-api", kind: "api_key", humanId: "alice" });
    const scope = { humanId: "alice", projectId: "p1", sessionId: "s1" };
    const std = await ledger.record({
      usage: { tokens_in: M, tokens_out: 0 },
      model: "claude-opus-5-5",
      source,
      scope: { ...scope, runId: "r1" },
    });
    const fast = await ledger.record({
      usage: { tokens_in: M, tokens_out: 0 },
      model: "claude-opus-5-5-fast",
      source,
      scope: { ...scope, runId: "r2" },
    });
    expect(std.entry).toMatchObject({ model: "claude-opus-5-5", usd_micro: 4 * M });
    expect(fast.entry).toMatchObject({ model: "claude-opus-5-5-fast", usd_micro: 8 * M });
    const report = await ledger.allocation({ projectId: "p1" }, () => "open");
    const byModel = Object.fromEntries(report.byModel.map((b) => [b.key, b.usd_micro]));
    expect(byModel).toEqual({ "claude-opus-5-5": 4 * M, "claude-opus-5-5-fast": 8 * M });
  });
});
