/**
 * USD -> CHF exchange rates (ADR 0008).
 *
 * Budgets are shown in CHF at a daily rate; the ledger keeps the raw USD and the rate used.
 * The live source is the ECB reference rate served by Frankfurter
 * (https://api.frankfurter.app). Each day's rate is cached in one JSON file under the app
 * cache directory. When the network is unavailable the newest cached rate is used and
 * flagged `origin: "fallback"`; with no cache at all the documented default
 * DEFAULT_CHF_PER_USD is used and flagged `origin: "default"`. Lack of network never throws.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  type Clock,
  dirname,
  errorMessage,
  ForerunnerError,
  join,
  log,
} from "@forerunner/platform";
import { z } from "zod";
import { assertRate } from "./money.ts";

/** Used only when no live or cached rate exists. Conservative for a CHF budget holder. */
export const DEFAULT_CHF_PER_USD = 0.8;

export const RATE_CACHE_FILE = "rates-usd-chf.json";

export type RateOrigin = "fixed" | "frankfurter" | "cache" | "fallback" | "default";

export interface RateQuote {
  chfPerUsd: number;
  /** The date the caller asked for, YYYY-MM-DD (UTC). */
  requestedDate: string;
  /** The date the rate is actually for (ECB publishes on working days only). */
  rateDate: string;
  origin: RateOrigin;
  /** When the live value was fetched; null for fixed and default rates. */
  fetchedAt: string | null;
}

export interface RateSource {
  /** CHF per 1 USD for the given day (ISO date or timestamp). Never throws for lack of network. */
  chfPerUsd(dateIso: string): Promise<number>;
  /** Same as chfPerUsd but with provenance, for the ledger and the UI. */
  quote(dateIso: string): Promise<RateQuote>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalise an ISO date or timestamp to the UTC calendar date YYYY-MM-DD. */
export function toRateDate(dateIso: string): string {
  if (typeof dateIso !== "string" || dateIso.length === 0) {
    throw new ForerunnerError("validation", "rate date must be an ISO date string", {
      details: { value: String(dateIso) },
    });
  }
  const parsed = new Date(DATE_RE.test(dateIso) ? `${dateIso}T00:00:00.000Z` : dateIso);
  if (Number.isNaN(parsed.getTime())) {
    throw new ForerunnerError("validation", "rate date is not a valid ISO date", {
      details: { value: dateIso },
    });
  }
  return parsed.toISOString().slice(0, 10);
}

/** A constant rate: tests, offline installs, or a human-pinned rate. */
export class FixedRateSource implements RateSource {
  private readonly rate: number;

  constructor(rate: number) {
    this.rate = assertRate(rate, "rate_chf_per_usd");
  }

  async chfPerUsd(_dateIso: string): Promise<number> {
    return this.rate;
  }

  async quote(dateIso: string): Promise<RateQuote> {
    const date = toRateDate(dateIso);
    return {
      chfPerUsd: this.rate,
      requestedDate: date,
      rateDate: date,
      origin: "fixed",
      fetchedAt: null,
    };
  }
}

/** The subset of fetch we use, so tests can inject a stub without a network. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

const frankfurterSchema = z.object({
  date: z.string().regex(DATE_RE),
  rates: z.object({ CHF: z.number().positive().finite() }),
});

/** Parse a Frankfurter response body; throws ForerunnerError("provider_error") on a bad shape. */
export function parseFrankfurter(body: unknown): { rate: number; date: string } {
  const parsed = frankfurterSchema.safeParse(body);
  if (!parsed.success) {
    throw new ForerunnerError("provider_error", "unexpected rate service response", {
      details: { issues: parsed.error.issues.map((i) => i.message) },
    });
  }
  return { rate: parsed.data.rates.CHF, date: parsed.data.date };
}

interface CacheEntry {
  chfPerUsd: number;
  rateDate: string;
  fetchedAt: string;
}

interface CacheFile {
  version: 1;
  base: "USD";
  quote: "CHF";
  rates: Record<string, CacheEntry>;
}

const cacheSchema = z.object({
  version: z.literal(1),
  base: z.literal("USD"),
  quote: z.literal("CHF"),
  rates: z.record(
    z.string().regex(DATE_RE),
    z.object({
      chfPerUsd: z.number().positive().finite(),
      rateDate: z.string().regex(DATE_RE),
      fetchedAt: z.string(),
    }),
  ),
});

function emptyCache(): CacheFile {
  return { version: 1, base: "USD", quote: "CHF", rates: {} };
}

/** Keep the cache bounded: this many newest days. */
const MAX_CACHED_DAYS = 400;

export interface FrankfurterOptions {
  /** Directory for the cache file, normally appDirs().cache. */
  cacheDir: string;
  clock: Clock;
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  /** Rate used when neither network nor cache is available. */
  defaultRate?: number;
}

export class FrankfurterRateSource implements RateSource {
  private readonly file: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly defaultRate: number;
  private readonly clock: Clock;
  private readonly logger = log("billing:rates");
  private mem: CacheFile | null = null;

  constructor(opts: FrankfurterOptions) {
    this.file = join(opts.cacheDir, RATE_CACHE_FILE);
    this.clock = opts.clock;
    this.fetchImpl =
      opts.fetch ?? ((url, init) => globalThis.fetch(url, init) as Promise<FetchResponseLike>);
    this.baseUrl = (opts.baseUrl ?? "https://api.frankfurter.app").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.defaultRate = assertRate(opts.defaultRate ?? DEFAULT_CHF_PER_USD, "default rate");
  }

  /** Path of the cache file (for diagnostics and tests). */
  get cacheFile(): string {
    return this.file;
  }

  async chfPerUsd(dateIso: string): Promise<number> {
    return (await this.quote(dateIso)).chfPerUsd;
  }

  async quote(dateIso: string): Promise<RateQuote> {
    const date = toRateDate(dateIso);
    const cache = await this.load();
    const hit = cache.rates[date];
    if (hit) {
      return {
        chfPerUsd: hit.chfPerUsd,
        requestedDate: date,
        rateDate: hit.rateDate,
        origin: "cache",
        fetchedAt: hit.fetchedAt,
      };
    }

    const today = this.clock.nowIso().slice(0, 10);
    const path = date >= today ? "latest" : date;
    const url = `${this.baseUrl}/${path}?from=USD&to=CHF`;
    try {
      const live = await this.fetchRate(url);
      const fetchedAt = this.clock.nowIso();
      cache.rates[date] = { chfPerUsd: live.rate, rateDate: live.date, fetchedAt };
      prune(cache);
      await this.save(cache);
      return {
        chfPerUsd: live.rate,
        requestedDate: date,
        rateDate: live.date,
        origin: "frankfurter",
        fetchedAt,
      };
    } catch (e) {
      const newest = newestEntry(cache, date);
      if (newest) {
        this.logger.warn("rate fetch failed; using the newest cached rate", {
          requested: date,
          cached: newest.key,
          error: errorMessage(e),
        });
        return {
          chfPerUsd: newest.entry.chfPerUsd,
          requestedDate: date,
          rateDate: newest.entry.rateDate,
          origin: "fallback",
          fetchedAt: newest.entry.fetchedAt,
        };
      }
      this.logger.warn("rate fetch failed and no cached rate exists; using the default rate", {
        requested: date,
        defaultRate: this.defaultRate,
        error: errorMessage(e),
      });
      return {
        chfPerUsd: this.defaultRate,
        requestedDate: date,
        rateDate: date,
        origin: "default",
        fetchedAt: null,
      };
    }
  }

  private async fetchRate(url: string): Promise<{ rate: number; date: string }> {
    const ac = new AbortController();
    const cancel = this.clock.setTimeout(
      () => ac.abort(new Error(`rate fetch timed out after ${this.timeoutMs} ms`)),
      this.timeoutMs,
    );
    try {
      const res = await this.fetchImpl(url, {
        signal: ac.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new ForerunnerError("provider_error", `rate service answered HTTP ${res.status}`, {
          details: { status: res.status },
          retryable: true,
        });
      }
      return parseFrankfurter(await res.json());
    } finally {
      cancel();
    }
  }

  private async load(): Promise<CacheFile> {
    if (this.mem) return this.mem;
    let loaded: CacheFile | null = null;
    try {
      const text = await readFile(this.file, "utf8");
      const parsed = cacheSchema.safeParse(JSON.parse(text));
      if (parsed.success) loaded = parsed.data;
      else this.logger.warn("ignoring malformed rate cache", { file: this.file });
    } catch {
      // missing or unreadable cache: start empty
    }
    this.mem = loaded ?? emptyCache();
    return this.mem;
  }

  private async save(cache: CacheFile): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
      await rename(tmp, this.file);
    } catch (e) {
      // A cache write failure must never block a cost record.
      this.logger.warn("could not write the rate cache", {
        file: this.file,
        error: errorMessage(e),
      });
    }
  }
}

function prune(cache: CacheFile): void {
  const keys = Object.keys(cache.rates).sort();
  while (keys.length > MAX_CACHED_DAYS) {
    const oldest = keys.shift();
    if (oldest) delete cache.rates[oldest];
  }
}

/** Newest cached entry on or before `date`, else the newest overall. */
function newestEntry(
  cache: CacheFile,
  date: string,
): { key: string; entry: CacheEntry } | undefined {
  const keys = Object.keys(cache.rates).sort();
  if (keys.length === 0) return undefined;
  const onOrBefore = keys.filter((k) => k <= date);
  const key = onOrBefore.length > 0 ? onOrBefore[onOrBefore.length - 1] : keys[keys.length - 1];
  if (!key) return undefined;
  const entry = cache.rates[key];
  return entry ? { key, entry } : undefined;
}
