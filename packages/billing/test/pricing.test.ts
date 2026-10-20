import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ForerunnerError, isForerunnerError, join } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_PRICING,
  cacheSavingsUsdMicro,
  canonicalModelId,
  costOf,
  estimateUsdMicro,
  knownModels,
  loadPricing,
  mergePricing,
  parsePricingOverrides,
  priceFor,
  pricingOverridesPath,
} from "../src/pricing.ts";

const M = 1_000_000;

describe("costOf", () => {
  it("prices input, output and cache tokens from the table", () => {
    expect(costOf({ tokens_in: M, tokens_out: 0 }, "claude-haiku-4-5")).toBe(1 * M);
    expect(costOf({ tokens_in: 0, tokens_out: M }, "claude-haiku-4-5")).toBe(5 * M);
    expect(costOf({ tokens_in: 0, tokens_out: 0, cache_read_tokens: M }, "claude-haiku-4-5")).toBe(
      100_000,
    );
    expect(costOf({ tokens_in: 0, tokens_out: 0, cache_write_tokens: M }, "claude-haiku-4-5")).toBe(
      1_250_000,
    );
    expect(
      costOf(
        { tokens_in: 1234, tokens_out: 567, cache_read_tokens: 10_000, cache_write_tokens: 2_000 },
        "claude-sonnet-4-5",
      ),
    ).toBe(1234 * 3 + 567 * 15 + 3_000 + 7_500);
  });

  it("rounds the total half-up once", () => {
    expect(costOf({ tokens_in: 7, tokens_out: 0 }, "claude-haiku-5-5")).toBe(1);
    expect(costOf({ tokens_in: 4, tokens_out: 0 }, "claude-haiku-5-5")).toBe(0);
    expect(costOf({ tokens_in: 5, tokens_out: 0 }, "claude-haiku-5-5")).toBe(1);
    expect(costOf({ tokens_in: 0, tokens_out: 0 }, "claude-haiku-5-5")).toBe(0);
  });

  it("throws for unknown models instead of returning zero", () => {
    expect(() => costOf({ tokens_in: 1, tokens_out: 1 }, "gpt-5")).toThrow(ForerunnerError);
    try {
      costOf({ tokens_in: 1, tokens_out: 1 }, "claude-nonesuch-9");
    } catch (e) {
      expect(isForerunnerError(e, "validation")).toBe(true);
      expect((e as ForerunnerError).details.model).toBe("claude-nonesuch-9");
      expect((e as ForerunnerError).details.known).toContain("claude-sonnet-5-5");
    }
  });

  it("rejects negative or fractional token counts", () => {
    expect(() => costOf({ tokens_in: -1, tokens_out: 0 }, "claude-sonnet-4-5")).toThrow(
      /tokens_in/,
    );
    expect(() => costOf({ tokens_in: 1.5, tokens_out: 0 }, "claude-sonnet-4-5")).toThrow(
      ForerunnerError,
    );
  });

  it("resolves dated, prefixed and suffixed model ids", () => {
    expect(canonicalModelId("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(canonicalModelId("anthropic.claude-opus-4-5-20251101-v1:0")).toBe("claude-opus-4-5");
    expect(canonicalModelId("claude-opus-4-5@20251101")).toBe("claude-opus-4-5");
    expect(canonicalModelId("Claude-Haiku-4-5[1m]")).toBe("claude-haiku-4-5");
    expect(canonicalModelId("claude-sonnet-5-5-latest")).toBe("claude-sonnet-5-5");
    expect(costOf({ tokens_in: M, tokens_out: 0 }, "claude-sonnet-4-5-20250929")).toBe(3 * M);
  });

  it("estimates conservatively and values cache reads at full price", () => {
    expect(
      estimateUsdMicro({ inputTokens: 1000, maxOutputTokens: 1000 }, "claude-sonnet-4-5"),
    ).toBe(18_000);
    expect(
      cacheSavingsUsdMicro(
        { tokens_in: 0, tokens_out: 0, cache_read_tokens: M },
        "claude-sonnet-4-5",
      ),
    ).toBe(2_700_000);
  });
});

describe("BUILTIN_PRICING", () => {
  it("covers the spec's ladder and is internally consistent", () => {
    for (const id of [
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
    ]) {
      expect(knownModels()).toContain(id);
    }
    for (const [id, p] of Object.entries(BUILTIN_PRICING)) {
      expect(p.input_per_mtok_usd, id).toBeGreaterThan(0);
      expect(p.output_per_mtok_usd, id).toBeGreaterThanOrEqual(p.input_per_mtok_usd);
      expect(p.cache_read_per_mtok_usd, id).toBeLessThan(p.input_per_mtok_usd);
      expect(p.cache_write_per_mtok_usd, id).toBeGreaterThan(p.input_per_mtok_usd);
      expect(p.as_of, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["list", "assumed"], id).toContain(p.source);
    }
    expect(priceFor("claude-haiku-4-5").cache_read_per_mtok_usd).toBe(0.1);
    expect(priceFor("claude-haiku-4-5").cache_write_per_mtok_usd).toBe(1.25);
    expect(priceFor("claude-opus-4-5").output_per_mtok_usd).toBe(25);
  });
});

describe("overrides", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fr-billing-pricing-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the built-in table when there is no overrides file", async () => {
    const table = await loadPricing(join(dir, "pricing.json"));
    expect(table).toEqual(BUILTIN_PRICING);
  });

  it("merges partial overrides for known models and whole rows for new ones", async () => {
    const file = join(dir, "pricing.json");
    await writeFile(
      file,
      JSON.stringify({
        "claude-sonnet-4-5": { input_per_mtok_usd: 2.5, as_of: "2026-11-01" },
        "claude-zeta-1": {
          input_per_mtok_usd: 1,
          output_per_mtok_usd: 2,
          cache_read_per_mtok_usd: 0.1,
          cache_write_per_mtok_usd: 1.25,
          as_of: "2026-11-01",
          notes: "new provider",
        },
      }),
      "utf8",
    );
    const table = await loadPricing(file);
    expect(table["claude-sonnet-4-5"]).toMatchObject({
      input_per_mtok_usd: 2.5,
      output_per_mtok_usd: 15,
      source: "override",
      as_of: "2026-11-01",
    });
    expect(table["claude-zeta-1"]).toMatchObject({ source: "override", notes: "new provider" });
    expect(costOf({ tokens_in: M, tokens_out: 0 }, "claude-sonnet-4-5", table)).toBe(2_500_000);
    expect(BUILTIN_PRICING["claude-sonnet-4-5"]?.input_per_mtok_usd).toBe(3);
  });

  it("reads from <config>/pricing.json by default, honouring FORERUNNER_HOME", async () => {
    const env = { FORERUNNER_HOME: dir } as NodeJS.ProcessEnv;
    const file = pricingOverridesPath(env);
    expect(file).toBe(join(dir, "config", "pricing.json"));
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(file, JSON.stringify({ "claude-opus-4-5": { output_per_mtok_usd: 30 } }));
    const table = await loadPricing(undefined, { env });
    expect(table["claude-opus-4-5"]?.output_per_mtok_usd).toBe(30);
  });

  it("refuses malformed files loudly", async () => {
    const file = join(dir, "pricing.json");
    await writeFile(file, "{ not json", "utf8");
    await expect(loadPricing(file)).rejects.toMatchObject({ code: "validation" });

    await writeFile(file, JSON.stringify({ "claude-sonnet-4-5": { bogus: 1 } }), "utf8");
    await expect(loadPricing(file)).rejects.toThrow(/malformed/);

    await writeFile(file, JSON.stringify({ "claude-sonnet-4-5": { input_per_mtok_usd: -1 } }));
    await expect(loadPricing(file)).rejects.toMatchObject({ code: "validation" });

    expect(() =>
      mergePricing(
        BUILTIN_PRICING,
        parsePricingOverrides(JSON.stringify({ "claude-x": { input_per_mtok_usd: 1 } })),
      ),
    ).toThrow(/missing output_per_mtok_usd/);
  });
});
