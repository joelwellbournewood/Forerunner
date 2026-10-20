import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { BUILTIN_PRICING, costOf } from "@forerunner/billing";
import { join, SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUDGET_VAR,
  budgetConfigFromEnv,
  budgetLine,
  DEFAULT_BUDGET_USD,
  DEFAULT_RUN_CAP_USD,
  LiveBudget,
  LiveBudgetError,
  RUN_CAP_VAR,
} from "../src/budget.ts";
import { formatLedger, parseLedger, SpendLedger, type SpendRow, sumUsd } from "../src/ledger.ts";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempLedger(rows: SpendRow[] = []): SpendLedger {
  const dir = mkdtempSync(join(tmpdir(), "fr-live-ledger-"));
  temps.push(dir);
  const path = join(dir, "spend.json");
  if (rows.length) writeFileSync(path, formatLedger({ rows }), "utf8");
  return SpendLedger.load(path);
}

const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const row = (usd: number, run = "r1", model = SONNET): SpendRow => ({
  date: "2026-10-20",
  run,
  model,
  tokensIn: 1000,
  tokensOut: 100,
  cacheRead: 0,
  cacheWrite: 0,
  usd,
});

function budget(
  ledger: SpendLedger,
  opts: { capUsd?: number; runCapUsd?: number; run?: string } = {},
) {
  const warnings: string[] = [];
  const clock = new SimulatedClock("2026-10-20T10:00:00Z");
  const b = new LiveBudget({
    ledger,
    run: opts.run ?? "r1",
    config: { capUsd: opts.capUsd ?? 100, runCapUsd: opts.runCapUsd ?? 15, warnShare: 0.8 },
    clock,
    onWarn: (line) => warnings.push(line),
  });
  return { b, warnings, clock };
}

describe("spend ledger file", () => {
  it("round-trips rows, validates shapes and sums in micro-USD", () => {
    const ledger = tempLedger();
    expect(ledger.rows()).toEqual([]);
    expect(existsSync(ledger.path)).toBe(false);
    ledger.append(row(0.1));
    ledger.append({ ...row(0.2, "r2", HAIKU), note: "error: provider_rate_limit" });
    const text = readFileSync(ledger.path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(parseLedger(text).rows).toHaveLength(2);
    expect(ledger.totalUsd()).toBe(0.3);
    expect(ledger.runUsd("r2")).toBe(0.2);
    expect(ledger.byModel()[HAIKU]).toMatchObject({ calls: 1, usd: 0.2, tokensIn: 1000 });
    // float noise never changes a total: 0.1 + 0.2 is exactly 0.3 in micro-USD arithmetic
    expect(sumUsd([row(0.1), row(0.2)])).toBe(0.3);
    expect(() => parseLedger("[]")).toThrow(/rows array/);
    expect(() =>
      parseLedger(
        '{"rows":[{"date":"d","run":"r","model":"m","tokensIn":-1,"tokensOut":0,"usd":0}]}',
      ),
    ).toThrow(/tokensIn/);
    expect(() => parseLedger("{nope")).toThrow(/not JSON/);
  });
});

describe("live budget", () => {
  it("reads the caps from the environment with the spec defaults and refuses nonsense", () => {
    expect(budgetConfigFromEnv({})).toEqual({
      capUsd: DEFAULT_BUDGET_USD,
      runCapUsd: DEFAULT_RUN_CAP_USD,
      warnShare: 0.8,
    });
    expect(budgetConfigFromEnv({ [BUDGET_VAR]: "40", [RUN_CAP_VAR]: "5" })).toMatchObject({
      capUsd: 40,
      runCapUsd: 5,
    });
    // the run cap can never exceed the budget
    expect(budgetConfigFromEnv({ [BUDGET_VAR]: "10", [RUN_CAP_VAR]: "50" }).runCapUsd).toBe(10);
    expect(() => budgetConfigFromEnv({ [BUDGET_VAR]: "0" })).toThrow(/positive/);
    expect(() => budgetConfigFromEnv({ [RUN_CAP_VAR]: "lots" })).toThrow(/positive/);
  });

  it("estimates the next call at the cache-write input price (the dearest input rate) plus max_tokens at the output price", () => {
    const { b } = budget(tempLedger());
    const req = {
      model: SONNET,
      system: "s".repeat(400),
      messages: [{ role: "user" as const, content: "u".repeat(1200) }],
      max_tokens: 500,
    };
    const countTokens = (text: string) => Math.ceil(text.length / 4);
    const inputTokens = countTokens(
      `${req.system}${JSON.stringify(req.messages)}${JSON.stringify([])}`,
    );
    const p = BUILTIN_PRICING[SONNET];
    expect(p).toBeDefined();
    if (!p) return;
    // sonnet 5.5: input 2, cache write 2.5 (1.25x), output 10 USD per MTok
    expect(p.cache_write_per_mtok_usd).toBeGreaterThan(p.input_per_mtok_usd);
    const expected = Math.round(
      inputTokens * p.cache_write_per_mtok_usd + req.max_tokens * p.output_per_mtok_usd,
    );
    expect(b.estimateFor(req, countTokens)).toBe(expected);
    // never below the plain input-price estimate the hooks use
    expect(b.estimateFor(req, countTokens)).toBeGreaterThan(
      Math.round(inputTokens * p.input_per_mtok_usd + req.max_tokens * p.output_per_mtok_usd),
    );
    expect(() => b.estimateFor({ ...req, model: "mystery-model" }, countTokens)).toThrow(
      /no price known/,
    );
  });

  it("allows a call under both caps, settles it at the table price and writes the row", () => {
    const ledger = tempLedger([row(1.5, "earlier")]);
    const { b } = budget(ledger);
    const estimate = 50_000; // USD 0.05
    const res = b.reserve(estimate, SONNET);
    expect(b.snapshot()).toMatchObject({ ledgerUsd: 1.5, runUsd: 0, inFlightUsd: 0.05 });
    const usage = {
      input_tokens: 2000,
      output_tokens: 300,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 100,
    };
    const written = b.settle(res, usage);
    const expectedMicro = costOf(
      { tokens_in: 2000, tokens_out: 300, cache_read_tokens: 500, cache_write_tokens: 100 },
      SONNET,
      BUILTIN_PRICING,
    );
    expect(written).toEqual({
      date: "2026-10-20",
      run: "r1",
      model: SONNET,
      tokensIn: 2000,
      tokensOut: 300,
      cacheRead: 500,
      cacheWrite: 100,
      usd: expectedMicro / 1_000_000,
    });
    expect(ledger.rows()).toHaveLength(2);
    expect(b.snapshot().inFlightUsd).toBe(0);
    expect(b.snapshot().runUsd).toBe(written.usd);
  });

  it("refuses a call that would cross the live budget, naming the ledger total, and sends nothing", () => {
    const ledger = tempLedger([row(99.98, "earlier")]);
    const { b } = budget(ledger);
    expect(() => b.reserve(30_000, SONNET)).toThrow(LiveBudgetError);
    try {
      b.reserve(30_000, SONNET);
    } catch (e) {
      const err = e as LiveBudgetError;
      expect(err.code).toBe("budget_exceeded");
      expect(err.message).toContain("over the live budget of USD 100.0000");
      expect(err.message).toContain("ledger total USD 99.9800");
      expect(err.decision.snapshot.remainingUsd).toBeCloseTo(0.02, 6);
    }
    expect(b.refusals).toHaveLength(2);
    expect(ledger.rows()).toHaveLength(1);
    expect(b.snapshot().inFlightUsd).toBe(0);
  });

  it("keeps one run under the per-run cap even when the budget has room, counting calls in flight", () => {
    const ledger = tempLedger([row(14.9, "r1"), row(50, "other-run")]);
    const { b } = budget(ledger);
    // 14.9 + 0.05 fits; a second 0.1 in flight would not
    const first = b.reserve(50_000, SONNET);
    expect(() => b.reserve(100_000, SONNET)).toThrow(/over the per-run cap of USD 15.0000/);
    expect(b.refusals[0]?.reason).toContain("in flight USD 0.0500");
    b.release(first);
    expect(b.decide(50_000, SONNET).allowed).toBe(true);
    expect(b.decide(150_000, SONNET).allowed).toBe(false);
  });

  it("prints the 80% warning once per cap and the summary line names both totals", () => {
    const ledger = tempLedger([row(79, "earlier")]);
    const { b, warnings } = budget(ledger);
    const r1 = b.reserve(1_500_000, SONNET); // 79 + 1.5 = 80.5 >= 80
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("80% of the live budget reached");
    b.settle(r1, {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const r2 = b.reserve(1_500_000, SONNET);
    b.release(r2);
    expect(warnings).toHaveLength(1);
    // the run cap's own line
    const ledger2 = tempLedger([row(11.9, "r1")]);
    const w2 = budget(ledger2);
    w2.b.release(w2.b.reserve(200_000, SONNET));
    expect(w2.warnings.map((w) => w.includes("per-run cap"))).toEqual([true]);
    expect(budgetLine(w2.b)).toMatch(
      /ledger USD 11\.9000 of USD 100\.0000, this run USD 11\.9000 of USD 15\.0000/,
    );
  });

  it("settles a failed call with the usage it saw, or a zero row with a note, so the ledger never misses a call", () => {
    const ledger = tempLedger();
    const { b } = budget(ledger);
    const r = b.reserve(10_000, HAIKU);
    const written = b.settle(r, null, { note: "error: provider_error" });
    expect(written).toMatchObject({
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      note: "no usage reported; error: provider_error",
    });
    const r2 = b.reserve(10_000, HAIKU);
    const partial = b.settle(
      r2,
      {
        input_tokens: 400,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      { note: "aborted" },
    );
    expect(partial.usd).toBe(costOf({ tokens_in: 400, tokens_out: 0 }, HAIKU) / 1_000_000);
    expect(partial.note).toBe("aborted");
    expect(ledger.rows()).toHaveLength(2);
  });

  it("prices a dated snapshot id by its canonical row and falls back to the requested id for an unknown answer", () => {
    const ledger = tempLedger();
    const { b } = budget(ledger);
    const usage = {
      input_tokens: 1000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const snap = b.settle(b.reserve(1, SONNET), usage, {
      model: `${SONNET}-20260601`,
      requestedModel: SONNET,
    });
    expect(snap.model).toBe(`${SONNET}-20260601`);
    expect(snap.usd).toBe(costOf({ tokens_in: 1000, tokens_out: 0 }, SONNET) / 1_000_000);
    const fallback = b.settle(b.reserve(1, SONNET), usage, {
      model: "mystery-model",
      requestedModel: SONNET,
    });
    expect(fallback.usd).toBe(snap.usd);
    expect(() =>
      b.settle(b.reserve(1, SONNET), usage, {
        model: "mystery-model",
        requestedModel: "mystery-model",
      }),
    ).toThrow(/no price known/);
  });
});
