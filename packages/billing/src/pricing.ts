/**
 * Pricing table keyed by model id, and the cost of a run from its token usage.
 *
 * Prices are USD per million tokens. Cost comes out in usd_micro, which makes the arithmetic
 * exact: usd_micro = tokens * price_per_mtok (1e6 micro per USD cancels 1e6 tokens per MTok),
 * rounded half-up once at the end.
 *
 * Unknown models throw; a cost is never silently zero. Humans and the weekly model watch
 * correct prices without a release through <appDirs().config>/pricing.json (loadPricing).
 */
import { readFile } from "node:fs/promises";
import { appDirs, ForerunnerError, join } from "@forerunner/platform";
import { z } from "zod";
import { roundHalfUp } from "./money.ts";
import type { BillingSourceKind } from "./sources.ts";

export type PriceSource = "list" | "assumed" | "override";

export interface ModelPrice {
  input_per_mtok_usd: number;
  output_per_mtok_usd: number;
  cache_read_per_mtok_usd: number;
  cache_write_per_mtok_usd: number;
  /** list: provider price list. assumed: copied from a sibling model. override: pricing.json. */
  source: PriceSource;
  /** Date the price was last confirmed, YYYY-MM-DD. */
  as_of: string;
  notes?: string;
}

export type PricingTable = Readonly<Record<string, ModelPrice>>;

export interface TokenUsage {
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export const PRICING_FILE_NAME = "pricing.json";

/** Prompt-cache multipliers on the provider price list: reads 10% of input, writes 125%. */
export const CACHE_READ_SHARE = 0.1;
export const CACHE_WRITE_SHARE = 1.25;

const FAST_MODE_RATE_NOTE_TEXT = "research-preview rate";

function price(
  input: number,
  output: number,
  as_of: string,
  opts: { source?: PriceSource; cacheRead?: number; cacheWrite?: number; notes?: string } = {},
): ModelPrice {
  const p: ModelPrice = {
    input_per_mtok_usd: input,
    output_per_mtok_usd: output,
    cache_read_per_mtok_usd: opts.cacheRead ?? round6(input * CACHE_READ_SHARE),
    cache_write_per_mtok_usd: opts.cacheWrite ?? round6(input * CACHE_WRITE_SHARE),
    source: opts.source ?? "list",
    as_of,
  };
  if (opts.notes) p.notes = opts.notes;
  return p;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------------------
// !! PRICES CHANGE. The weekly model watch (spec module D) MUST re-check every row below
// !! against the provider price list and write corrections to <config>/pricing.json or
// !! to this table. `as_of` is the date a price was last confirmed. Rows marked
// !! source:"assumed" were never confirmed against a price list and are estimates.
// TODO(model-watch): re-verify the 5.5 generation rows weekly; they were taken from the
// provider reference cached on 2026-10-06, and Haiku 5.5 has a second price tier above
// 100K prompt tokens (0.50 / 2.50) that costOf does not model yet.
// ---------------------------------------------------------------------------------------
export const BUILTIN_PRICING: PricingTable = Object.freeze({
  // Claude 4.5 generation: list prices at launch.
  "claude-haiku-4-5": price(1, 5, "2025-10-15"),
  "claude-sonnet-4-5": price(3, 15, "2025-09-29"),
  "claude-opus-4-5": price(5, 25, "2025-11-24"),
  // Claude 4.6 / 4.7 / 4.8 generation: same per-tier list prices as 4.5.
  "claude-sonnet-4-6": price(3, 15, "2026-10-06"),
  "claude-opus-4-6": price(5, 25, "2026-10-06"),
  "claude-opus-4-7": price(5, 25, "2026-10-06"),
  "claude-opus-4-8": price(5, 25, "2026-10-06"),
  // Claude 5 generation.
  "claude-sonnet-5": price(2, 10, "2026-10-06", { cacheRead: 0.2 }),
  "claude-opus-5": price(5, 25, "2026-10-06"),
  "claude-fable-5": price(10, 50, "2026-10-06", { cacheRead: 1.0 }),
  // Claude 5.5 generation and Fable 5.1: the spec's default ladder. See the banner above.
  "claude-haiku-5-5": price(0.1, 0.5, "2026-10-06", {
    notes:
      "Base tier (prompts up to 100K tokens). Above that the list price is 0.50 / 2.50; not modelled.",
  }),
  "claude-sonnet-5-5": price(2, 10, "2026-10-06", { cacheRead: 0.2 }),
  "claude-opus-5-5": price(4, 20, "2026-10-06", { cacheRead: 0.2 }),
  "claude-fable-5-1": price(10, 50, "2026-10-06", { cacheRead: 0.25 }),
  // Opus fast mode (spec D.20, ADR 0057): the same model requested with `speed: "fast"`,
  // priced apart under its own `<base>-fast` row so the ledger, estimates and cost tables show
  // it apart. The 4.6 row is the published research-preview list price (30 / 150, six times
  // 5 / 25, cache multipliers on top); the 5.5 row applies that multiplier to every price of
  // the 5.5 row above and is marked assumed until the model watch confirms it.
  "claude-opus-4-6-fast": price(30, 150, "2026-10-23", {
    notes: `Opus 4.6 fast mode (speed: fast), ${FAST_MODE_RATE_NOTE_TEXT}: 6x the standard row.`,
  }),
  "claude-opus-5-5-fast": price(24, 120, "2026-10-23", {
    source: "assumed",
    cacheRead: 1.2,
    cacheWrite: 30,
    notes: `Opus 5.5 fast mode (speed: fast), ${FAST_MODE_RATE_NOTE_TEXT}: 6x every price of claude-opus-5-5, the multiplier published for Opus 4.6 fast mode.`,
  }),
});

/**
 * Fast mode (spec D.20, ADR 0057). A fast-mode run is the base model requested with the
 * provider's speed parameter; everything Forerunner records about it (the Run row, the ledger
 * row, the estimate, the price row) names the variant `<canonical base id>-fast`.
 */
export const FAST_MODE_SUFFIX = "-fast";
/** Every fast-mode price row's notes say this: the rate is the provider's research preview. */
export const FAST_MODE_RATE_NOTE = FAST_MODE_RATE_NOTE_TEXT;

/** True for a variant id (`claude-opus-5-5-fast`). */
export function isFastModeVariant(modelId: string): boolean {
  return canonicalModelId(modelId).endsWith(FAST_MODE_SUFFIX);
}

/** The variant id of a model: its canonical id plus `-fast`; a variant is returned unchanged. */
export function fastModeVariantId(modelId: string): string {
  const id = canonicalModelId(modelId);
  return id.endsWith(FAST_MODE_SUFFIX) ? id : `${id}${FAST_MODE_SUFFIX}`;
}

/** The base model of a variant id, or null for an id that is not a variant. */
export function fastModeBaseId(modelId: string): string | null {
  const id = canonicalModelId(modelId);
  return id.endsWith(FAST_MODE_SUFFIX) ? id.slice(0, -FAST_MODE_SUFFIX.length) : null;
}

/**
 * Fast mode is an API feature (spec D.20: "API only"): only an API-style source pays for it.
 * A subscription or plan credits run at the standard speed whatever the project says. The
 * fake source bills like the API (`ledgerKindFor`), so tests exercise the API path.
 */
export function fastModeBillable(kind: BillingSourceKind): boolean {
  return kind === "api_key" || kind === "fake";
}

/**
 * Canonical model id for table lookup: lower case, without a provider prefix
 * ("anthropic."), a dated snapshot suffix ("-20250929" or "@20250929"), a Bedrock version
 * suffix ("-v1:0"), "-latest", or a "[1m]" context marker.
 */
export function canonicalModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/^anthropic\./, "")
    .replace(/\[1m\]$/, "")
    .replace(/-v\d+:\d+$/, "")
    .replace(/(?:-|@)\d{8}$/, "")
    .replace(/-latest$/, "");
}

/** The price row for a model, or ForerunnerError("validation") when the model is unknown. */
export function priceFor(modelId: string, table: PricingTable = BUILTIN_PRICING): ModelPrice {
  const key = canonicalModelId(modelId);
  const row = table[key];
  if (!row) {
    throw new ForerunnerError("validation", `no price known for model "${modelId}"`, {
      details: { model: modelId, canonical: key, known: Object.keys(table).sort() },
    });
  }
  return row;
}

export function knownModels(table: PricingTable = BUILTIN_PRICING): string[] {
  return Object.keys(table).sort();
}

function assertTokens(n: number | undefined, what: string): number {
  const v = n ?? 0;
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new ForerunnerError("validation", `${what} must be a non-negative integer`, {
      details: { what, value: String(n) },
    });
  }
  return v;
}

/** Cost of a run in usd_micro. Unknown model throws; never returns a silent zero. */
export function costOf(
  usage: TokenUsage,
  modelId: string,
  table: PricingTable = BUILTIN_PRICING,
): number {
  const p = priceFor(modelId, table);
  const tokensIn = assertTokens(usage.tokens_in, "tokens_in");
  const tokensOut = assertTokens(usage.tokens_out, "tokens_out");
  const cacheRead = assertTokens(usage.cache_read_tokens, "cache_read_tokens");
  const cacheWrite = assertTokens(usage.cache_write_tokens, "cache_write_tokens");
  const micro =
    tokensIn * p.input_per_mtok_usd +
    tokensOut * p.output_per_mtok_usd +
    cacheRead * p.cache_read_per_mtok_usd +
    cacheWrite * p.cache_write_per_mtok_usd;
  return roundHalfUp(micro);
}

/**
 * Conservative pre-run estimate: the whole input at the full input price plus the output
 * ceiling at the output price. Cache hits only make the actual cheaper.
 */
export function estimateUsdMicro(
  est: { inputTokens: number; maxOutputTokens: number },
  modelId: string,
  table: PricingTable = BUILTIN_PRICING,
): number {
  return costOf({ tokens_in: est.inputTokens, tokens_out: est.maxOutputTokens }, modelId, table);
}

/**
 * Counterfactual value of tokens the context layer removed before the call (ADR 0003): saved
 * tokens at the model's full input price, rounded half-up once (ADR 0008). Unknown model throws.
 */
export function compressionSavingsUsdMicro(
  savedTokens: number,
  modelId: string,
  table: PricingTable = BUILTIN_PRICING,
): number {
  const p = priceFor(modelId, table);
  return roundHalfUp(assertTokens(savedTokens, "saved_tokens") * p.input_per_mtok_usd);
}

/** What cache reads in `usage` would have cost at the full input price minus what was paid. */
export function cacheSavingsUsdMicro(
  usage: TokenUsage,
  modelId: string,
  table: PricingTable = BUILTIN_PRICING,
): number {
  const p = priceFor(modelId, table);
  const reads = assertTokens(usage.cache_read_tokens, "cache_read_tokens");
  return roundHalfUp(reads * (p.input_per_mtok_usd - p.cache_read_per_mtok_usd));
}

const nonNegative = z.number().finite().nonnegative();
const overrideRowSchema = z
  .object({
    input_per_mtok_usd: nonNegative.optional(),
    output_per_mtok_usd: nonNegative.optional(),
    cache_read_per_mtok_usd: nonNegative.optional(),
    cache_write_per_mtok_usd: nonNegative.optional(),
    source: z.enum(["list", "assumed", "override"]).optional(),
    as_of: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();
const overridesSchema = z.record(z.string().min(1), overrideRowSchema);

export type PricingOverrides = z.infer<typeof overridesSchema>;

/** Validate the overrides JSON text. Throws ForerunnerError("validation") with the file name. */
export function parsePricingOverrides(text: string, file = PRICING_FILE_NAME): PricingOverrides {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ForerunnerError("validation", `pricing overrides are not valid JSON: ${file}`, {
      details: { file },
      cause: e,
    });
  }
  const parsed = overridesSchema.safeParse(json);
  if (!parsed.success) {
    throw new ForerunnerError("validation", `pricing overrides are malformed: ${file}`, {
      details: {
        file,
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
    });
  }
  return parsed.data;
}

/**
 * Merge overrides onto a base table. Existing rows may be partially overridden (the result is
 * marked source "override" unless the row says otherwise); new rows need all four prices and
 * an as_of date.
 */
export function mergePricing(base: PricingTable, overrides: PricingOverrides): PricingTable {
  const out: Record<string, ModelPrice> = { ...base };
  for (const [rawId, row] of Object.entries(overrides)) {
    const id = canonicalModelId(rawId);
    const existing = out[id];
    if (existing) {
      out[id] = {
        ...existing,
        ...stripUndefined(row),
        source: row.source ?? "override",
        as_of: row.as_of ?? existing.as_of,
      };
      continue;
    }
    const missing = (
      [
        "input_per_mtok_usd",
        "output_per_mtok_usd",
        "cache_read_per_mtok_usd",
        "cache_write_per_mtok_usd",
        "as_of",
      ] as const
    ).filter((k) => row[k] === undefined);
    if (missing.length > 0) {
      throw new ForerunnerError(
        "validation",
        `pricing override for new model "${rawId}" is missing ${missing.join(", ")}`,
        { details: { model: rawId, missing } },
      );
    }
    out[id] = {
      input_per_mtok_usd: row.input_per_mtok_usd as number,
      output_per_mtok_usd: row.output_per_mtok_usd as number,
      cache_read_per_mtok_usd: row.cache_read_per_mtok_usd as number,
      cache_write_per_mtok_usd: row.cache_write_per_mtok_usd as number,
      source: row.source ?? "override",
      as_of: row.as_of as string,
      ...(row.notes ? { notes: row.notes } : {}),
    };
  }
  return Object.freeze(out);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Default location of the overrides file: <appDirs().config>/pricing.json. */
export function pricingOverridesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(appDirs({ env }).config, PRICING_FILE_NAME);
}

/**
 * Built-in table merged with the overrides file. A missing file is fine; a malformed file
 * throws so a typo cannot silently zero a price.
 */
export async function loadPricing(
  overridesPath?: string,
  opts: { env?: NodeJS.ProcessEnv; base?: PricingTable } = {},
): Promise<PricingTable> {
  const base = opts.base ?? BUILTIN_PRICING;
  const file = overridesPath ?? pricingOverridesPath(opts.env);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return base;
    throw new ForerunnerError("validation", `cannot read pricing overrides: ${file}`, {
      details: { file },
      cause: e,
    });
  }
  return mergePricing(base, parsePricingOverrides(text, file));
}
