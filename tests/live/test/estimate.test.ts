import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import { LiveBudget } from "../src/budget.ts";
import { estimateLine, estimateSpend, plannedMicro, preflight } from "../src/estimate.ts";
import { formatLedger, SpendLedger, type SpendRow } from "../src/ledger.ts";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

function budgetOn(rows: SpendRow[], config: { capUsd: number; runCapUsd: number }): LiveBudget {
  const dir = mkdtempSync(join(tmpdir(), "fr-live-estimate-"));
  temps.push(dir);
  const path = join(dir, "spend.json");
  writeFileSync(path, formatLedger({ rows }), "utf8");
  return new LiveBudget({
    ledger: SpendLedger.load(path),
    run: "r2",
    config: { ...config, warnShare: 0.8 },
    clock: new SimulatedClock("2026-10-25T10:00:00Z"),
    onWarn: () => undefined,
  });
}

const row = (usd: number, run: string): SpendRow => ({
  date: "2026-10-25",
  run,
  model: SONNET,
  tokensIn: 1000,
  tokensOut: 100,
  cacheRead: 0,
  cacheWrite: 0,
  usd,
});

describe("pre-run cost estimate", () => {
  it("prices the input at the dearest input rate and the output at the output rate, from the billing table", () => {
    // Opus 5.5: input 4, cache write 5 (1.25x), output 20 USD per MTok.
    expect(
      plannedMicro({ label: "x", model: OPUS, calls: 2, inputTokens: 1000, outputTokens: 500 }),
    ).toBe(2 * (1000 * 5 + 500 * 20));
    // Sonnet 5.5: input 2, cache write 2.5, output 10.
    expect(
      plannedMicro({ label: "y", model: SONNET, calls: 1, inputTokens: 4000, outputTokens: 0 }),
    ).toBe(10_000);
    expect(() =>
      plannedMicro({
        label: "z",
        model: "no-such-model",
        calls: 1,
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toThrow();
  });

  it("sums the planned shapes, keeps the ceiling at least the expectation, and prints both", () => {
    const e = estimateSpend(
      "file",
      [
        { label: "a", model: OPUS, calls: 2, inputTokens: 1000, outputTokens: 500 },
        { label: "b", model: SONNET, calls: 1, inputTokens: 4000, outputTokens: 0 },
      ],
      1,
    );
    expect(e.expectedUsd).toBe(0.04);
    expect(e.ceilingUsd).toBe(1);
    expect(e.planned.map((p) => p.usd)).toEqual([0.03, 0.01]);
    expect(estimateSpend("low", e.planned, 0.001).ceilingUsd).toBe(0.04);
    const line = estimateLine(e);
    expect(line).toContain("expected USD 0.0400, ceiling USD 1.0000");
    expect(line).toContain(`a: 2 x ${OPUS} (1000 in, 500 out) USD 0.0300`);
  });

  it("starts a file whose ceiling fits under both caps and refuses one that does not, before any call", () => {
    // Ledger 7.5 in all, 2.5 of it this run; caps 10 overall and 3 per run.
    const b = budgetOn([row(5, "r1"), row(2.5, "r2")], { capUsd: 10, runCapUsd: 3 });
    const fits = preflight(b, estimateSpend("ok", [], 0.5));
    expect(fits.decision.allowed).toBe(true);
    expect(fits.line).toContain(
      "left: USD 2.5000 of the live budget, USD 0.5000 of the per-run cap",
    );

    let err: unknown;
    try {
      preflight(b, estimateSpend("too-big", [], 0.6));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForerunnerError);
    expect((err as ForerunnerError).code).toBe("budget_exceeded");
    expect((err as Error).message).toContain("too-big refused to start");
    expect((err as Error).message).toContain("this run USD 2.5000 of USD 3.0000");

    // The overall budget binds too, whatever the run has spent.
    const tight = budgetOn([row(9.8, "r1")], { capUsd: 10, runCapUsd: 3 });
    expect(() => preflight(tight, estimateSpend("over-cap", [], 0.3))).toThrow(/refused to start/);
    // A preflight takes no reservation and records no refusal.
    expect(b.snapshot().inFlightUsd).toBe(0);
    expect(b.refusals).toEqual([]);
    expect(tight.refusals).toEqual([]);
  });
});
