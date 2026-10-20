import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CHF_PER_USD,
  type FetchLike,
  FixedRateSource,
  FrankfurterRateSource,
  parseFrankfurter,
  RATE_CACHE_FILE,
  toRateDate,
} from "../src/rates.ts";

interface Call {
  url: string;
}

function fetchStub(handler: (url: string) => { status: number; body: unknown } | Error): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push({ url });
    const r = handler(url);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return { fetch, calls };
}

const ok = (rate: number, date: string) => ({
  status: 200,
  body: { amount: 1, base: "USD", date, rates: { CHF: rate } },
});
const offline = () => new TypeError("fetch failed");

describe("toRateDate", () => {
  it("normalises dates and timestamps to the UTC day", () => {
    expect(toRateDate("2026-10-20")).toBe("2026-10-20");
    expect(toRateDate("2026-10-20T23:59:59.000Z")).toBe("2026-10-20");
    expect(toRateDate("2026-10-20T23:30:00-02:00")).toBe("2026-10-21");
    expect(() => toRateDate("yesterday")).toThrow(ForerunnerError);
    expect(() => toRateDate("")).toThrow(/ISO date/);
  });
});

describe("FixedRateSource", () => {
  it("returns the fixed rate with fixed provenance", async () => {
    const s = new FixedRateSource(0.9);
    expect(await s.chfPerUsd("2026-01-01")).toBe(0.9);
    expect(await s.quote("2026-01-01T12:00:00Z")).toEqual({
      chfPerUsd: 0.9,
      requestedDate: "2026-01-01",
      rateDate: "2026-01-01",
      origin: "fixed",
      fetchedAt: null,
    });
    expect(() => new FixedRateSource(0)).toThrow(ForerunnerError);
  });
});

describe("parseFrankfurter", () => {
  it("accepts the documented shape and rejects others", () => {
    expect(parseFrankfurter({ date: "2026-10-20", rates: { CHF: 0.79 } })).toEqual({
      rate: 0.79,
      date: "2026-10-20",
    });
    expect(() => parseFrankfurter({ rates: { EUR: 0.9 } })).toThrow(ForerunnerError);
    expect(() => parseFrankfurter({ date: "2026-10-20", rates: { CHF: -1 } })).toThrow(
      /unexpected rate service response/,
    );
    expect(() => parseFrankfurter("nope")).toThrow(ForerunnerError);
  });
});

describe("FrankfurterRateSource", () => {
  let dir: string;
  let clock: SimulatedClock;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fr-billing-rates-"));
    clock = new SimulatedClock("2026-10-20T09:00:00.000Z");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fetches today's rate from /latest and caches it on disk", async () => {
    const stub = fetchStub(() => ok(0.79, "2026-10-20"));
    const src = new FrankfurterRateSource({ cacheDir: dir, clock, fetch: stub.fetch });
    const q = await src.quote("2026-10-20T15:00:00Z");
    expect(q).toEqual({
      chfPerUsd: 0.79,
      requestedDate: "2026-10-20",
      rateDate: "2026-10-20",
      origin: "frankfurter",
      fetchedAt: "2026-10-20T09:00:00.000Z",
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe("https://api.frankfurter.app/latest?from=USD&to=CHF");

    const file = join(dir, RATE_CACHE_FILE);
    expect((await stat(file)).isFile()).toBe(true);
    const cached = JSON.parse(await readFile(file, "utf8")) as {
      rates: Record<string, { chfPerUsd: number }>;
    };
    expect(cached.rates["2026-10-20"]?.chfPerUsd).toBe(0.79);
    expect(src.cacheFile).toBe(file);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("serves the same day from the cache without a second fetch, also across instances", async () => {
    const stub = fetchStub(() => ok(0.79, "2026-10-20"));
    const a = new FrankfurterRateSource({ cacheDir: dir, clock, fetch: stub.fetch });
    await a.chfPerUsd("2026-10-20");
    const again = await a.quote("2026-10-20");
    expect(again.origin).toBe("cache");
    expect(stub.calls).toHaveLength(1);

    const b = new FrankfurterRateSource({ cacheDir: dir, clock, fetch: stub.fetch });
    const fromDisk = await b.quote("2026-10-20");
    expect(fromDisk.chfPerUsd).toBe(0.79);
    expect(fromDisk.origin).toBe("cache");
    expect(stub.calls).toHaveLength(1);
  });

  it("asks for a historical date by path", async () => {
    const stub = fetchStub(() => ok(0.75, "2026-10-15"));
    const src = new FrankfurterRateSource({ cacheDir: dir, clock, fetch: stub.fetch });
    await src.chfPerUsd("2026-10-15");
    expect(stub.calls[0]?.url).toBe("https://api.frankfurter.app/2026-10-15?from=USD&to=CHF");
  });

  it("keeps the published rate date when the ECB had no fixing for the requested day", async () => {
    const stub = fetchStub(() => ok(0.78, "2026-10-16"));
    const src = new FrankfurterRateSource({ cacheDir: dir, clock, fetch: stub.fetch });
    const q = await src.quote("2026-10-18");
    expect(q.requestedDate).toBe("2026-10-18");
    expect(q.rateDate).toBe("2026-10-16");
    expect(q.chfPerUsd).toBe(0.78);
  });

  it("falls back to the newest cached rate when offline and never throws", async () => {
    const online = fetchStub(() => ok(0.79, "2026-10-20"));
    const warm = new FrankfurterRateSource({ cacheDir: dir, clock, fetch: online.fetch });
    await warm.chfPerUsd("2026-10-20");

    await clock.set("2026-10-21T09:00:00.000Z");
    const down = fetchStub(() => offline());
    const src = new FrankfurterRateSource({ cacheDir: dir, clock, fetch: down.fetch });
    const q = await src.quote("2026-10-21");
    expect(q.origin).toBe("fallback");
    expect(q.chfPerUsd).toBe(0.79);
    expect(q.rateDate).toBe("2026-10-20");
    expect(down.calls).toHaveLength(1);

    const http500 = fetchStub(() => ({ status: 500, body: "boom" }));
    const q2 = await new FrankfurterRateSource({
      cacheDir: dir,
      clock,
      fetch: http500.fetch,
    }).quote("2026-10-22");
    expect(q2.origin).toBe("fallback");
    expect(q2.chfPerUsd).toBe(0.79);

    const garbage = fetchStub(() => ({ status: 200, body: { nope: true } }));
    const q3 = await new FrankfurterRateSource({
      cacheDir: dir,
      clock,
      fetch: garbage.fetch,
    }).quote("2026-10-22");
    expect(q3.origin).toBe("fallback");
  });

  it("prefers the newest cached rate on or before the requested day", async () => {
    await clock.set("2026-10-25T09:00:00.000Z");
    const online = fetchStub((url) =>
      url.includes("/2026-10-10?") ? ok(0.7, "2026-10-10") : ok(0.9, "2026-10-25"),
    );
    const warm = new FrankfurterRateSource({ cacheDir: dir, clock, fetch: online.fetch });
    await warm.chfPerUsd("2026-10-10");
    await warm.chfPerUsd("2026-10-25");

    const down = fetchStub(() => offline());
    const src = new FrankfurterRateSource({ cacheDir: dir, clock, fetch: down.fetch });
    expect((await src.quote("2026-10-20")).chfPerUsd).toBe(0.7);
    expect((await src.quote("2026-10-05")).chfPerUsd).toBe(0.9);
  });

  it("uses the documented default and flags it when there is no cache at all", async () => {
    const down = fetchStub(() => offline());
    const src = new FrankfurterRateSource({ cacheDir: dir, clock, fetch: down.fetch });
    const q = await src.quote("2026-10-20");
    expect(q).toEqual({
      chfPerUsd: DEFAULT_CHF_PER_USD,
      requestedDate: "2026-10-20",
      rateDate: "2026-10-20",
      origin: "default",
      fetchedAt: null,
    });
    expect(DEFAULT_CHF_PER_USD).toBe(0.8);
    await expect(src.chfPerUsd("2026-10-20")).resolves.toBe(0.8);

    const custom = new FrankfurterRateSource({
      cacheDir: dir,
      clock,
      fetch: down.fetch,
      defaultRate: 0.85,
    });
    expect((await custom.quote("2026-10-20")).chfPerUsd).toBe(0.85);
  });

  it("recovers once the network is back", async () => {
    let up = false;
    const stub = fetchStub(() => (up ? ok(0.81, "2026-10-20") : offline()));
    const src = new FrankfurterRateSource({ cacheDir: dir, clock, fetch: stub.fetch });
    expect((await src.quote("2026-10-20")).origin).toBe("default");
    up = true;
    expect((await src.quote("2026-10-20")).origin).toBe("frankfurter");
    expect((await src.quote("2026-10-20")).origin).toBe("cache");
  });
});
