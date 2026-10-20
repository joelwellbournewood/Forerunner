/**
 * Price list port for the weekly model watch (spec D "checks provider model lists and pricing").
 *
 * A price is never assumed. A model that is on neither the pricing table nor the fetched price
 * list is reported as "unpriced": it is not evaluated and never recommended until a human adds
 * a row to <config>/pricing.json. The live source reads one JSON document from a configurable
 * URL (FORERUNNER_PRICE_LIST_URL); the fixture source serves a list handed to it, for tests and
 * for installs that pin prices by hand.
 */
import { canonicalModelId, type FetchLike } from "@forerunner/billing";
import { errorMessage, ForerunnerError } from "@forerunner/platform";
import { z } from "zod";

const nonNegative = z.number().finite().nonnegative();

export const PriceListEntrySchema = z
  .object({
    input_per_mtok_usd: nonNegative,
    output_per_mtok_usd: nonNegative,
    cache_read_per_mtok_usd: nonNegative.optional(),
    cache_write_per_mtok_usd: nonNegative.optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();
export type PriceListEntry = z.infer<typeof PriceListEntrySchema>;

/**
 * The document a price list URL serves:
 * `{ "as_of": "YYYY-MM-DD", "source": "...", "models": { "<model id>": { prices } } }`.
 * Model ids are canonicalised on parse (see canonicalModelId in @forerunner/billing).
 */
export const PriceListSchema = z
  .object({
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "as_of is YYYY-MM-DD"),
    source: z.string().min(1).optional(),
    models: z.record(z.string().min(1), PriceListEntrySchema),
  })
  .strict();
export type PriceList = z.infer<typeof PriceListSchema>;

export interface PriceListSource {
  readonly name: string;
  /** The current price list. Throws `unavailable` or `validation`; never returns a guess. */
  fetch(signal?: AbortSignal): Promise<PriceList>;
}

/** Validate a parsed JSON document and canonicalise its model ids. */
export function parsePriceList(json: unknown, origin: string): PriceList {
  const parsed = PriceListSchema.safeParse(json);
  if (!parsed.success) {
    throw new ForerunnerError("validation", `price list is malformed: ${origin}`, {
      details: {
        origin,
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
    });
  }
  const models: Record<string, PriceListEntry> = {};
  for (const [id, row] of Object.entries(parsed.data.models)) {
    const key = canonicalModelId(id);
    if (models[key]) {
      throw new ForerunnerError("validation", `price list lists "${key}" twice: ${origin}`, {
        details: { origin, model: key },
      });
    }
    models[key] = row;
  }
  return { ...parsed.data, models };
}

/** A fixed list: tests, offline installs, prices pinned by a human. */
export class FixturePriceListSource implements PriceListSource {
  readonly name = "fixture";
  private readonly list: PriceList;

  constructor(list: PriceList) {
    this.list = parsePriceList(list, "fixture");
  }

  async fetch(): Promise<PriceList> {
    return structuredClone(this.list);
  }
}

export const PRICE_LIST_URL_ENV = "FORERUNNER_PRICE_LIST_URL";

/** The configured price list URL, or undefined when none is set (the watch then reports it). */
export function priceListUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[PRICE_LIST_URL_ENV]?.trim();
  return v ? v : undefined;
}

export interface FetchPriceListOptions {
  url: string;
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: FetchLike;
  timeoutMs?: number;
}

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/** Reads the JSON price list from a URL. Network problems become `unavailable`, bad documents `validation`. */
export class FetchPriceListSource implements PriceListSource {
  readonly name: string;
  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: FetchPriceListOptions) {
    let parsed: URL;
    try {
      parsed = new URL(opts.url);
    } catch {
      throw new ForerunnerError("validation", "price list URL is not a valid URL", {
        details: { url: opts.url },
      });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ForerunnerError("validation", "price list URL must be http(s)", {
        details: { url: opts.url },
      });
    }
    this.url = opts.url;
    this.name = `url:${parsed.host}`;
    this.fetchImpl = opts.fetch ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async fetch(signal?: AbortSignal): Promise<PriceList> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(this.url, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
      } catch (e) {
        throw new ForerunnerError("unavailable", `price list not reachable: ${errorMessage(e)}`, {
          details: { url: this.url },
          cause: e,
          retryable: true,
        });
      }
      if (!res.ok) {
        throw new ForerunnerError("unavailable", `price list returned HTTP ${res.status}`, {
          details: { url: this.url, status: res.status },
          retryable: res.status >= 500,
        });
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        throw new ForerunnerError("validation", "price list is not valid JSON", {
          details: { url: this.url },
          cause: e,
        });
      }
      return parsePriceList(json, this.url);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
