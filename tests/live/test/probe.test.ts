import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { errorReply, FakeProvider, type ScriptedReply, textReply } from "@forerunner/testenv";
import { afterAll, describe, expect, it } from "vitest";
import { LiveBudget } from "../src/budget.ts";
import { DRY_RUN_PRICING } from "../src/dry-run.ts";
import { SpendLedger } from "../src/ledger.ts";
import { MeteredProvider } from "../src/metered.ts";
import { PROBE_MAX_TOKENS, probeCeilingUsd, probeEffort } from "../src/probe.ts";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function metered(replies: ScriptedReply[], runCapUsd = 15) {
  const dir = mkdtempSync(join(tmpdir(), "fr-live-probe-"));
  temps.push(dir);
  const clock = new SimulatedClock("2026-10-25T12:00:00Z");
  const ledger = SpendLedger.load(join(dir, "spend.json"));
  const budget = new LiveBudget({
    ledger,
    run: "dry",
    config: { capUsd: 100, runCapUsd, warnShare: 0.8 },
    pricing: DRY_RUN_PRICING,
    clock,
    onWarn: () => undefined,
  });
  const inner = new FakeProvider({ mode: "script", replies, clock, latency: "none" });
  return { ledger, provider: new MeteredProvider(inner, budget, { clock }), inner };
}

describe("effort probe", () => {
  it("sends one tiny request at the effort through the metered provider and reports it, in the ledger", async () => {
    const w = metered([textReply("ok")]);
    const r = await probeEffort(w.provider, { model: "fake-opus", effort: "max" });
    expect(r).toMatchObject({ model: "fake-opus", effort: "max", status: "ok" });
    expect(r.usd).toBeGreaterThan(0);
    expect(w.inner.calls).toHaveLength(1);
    expect(w.inner.calls[0]?.request.effort).toBe("max");
    expect(w.inner.calls[0]?.request.max_tokens).toBe(PROBE_MAX_TOKENS);
    expect(w.ledger.rows()).toHaveLength(1);
    expect(w.ledger.rows()[0]?.usd).toBe(r.usd);
  });

  it("fails with the provider's reason when the request is rejected", async () => {
    const w = metered([errorReply("invalid_request", "effort: max is not supported")]);
    let err: unknown;
    try {
      await probeEffort(w.provider, { model: "fake-opus", effort: "max" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForerunnerError);
    expect((err as ForerunnerError).code).toBe("not_supported");
    expect((err as Error).message).toContain('effort "max" on fake-opus');
    expect((err as Error).message).toContain("effort: max is not supported");
    // The rejected call is still a ledger row.
    expect(w.ledger.rows()).toHaveLength(1);
  });

  it("the probe's ceiling covers the request it sends at the model's prices", () => {
    const ceiling = probeCeilingUsd("claude-opus-5-5");
    // 200 input tokens at the cache-write rate and the max tokens at the output rate.
    expect(ceiling).toBeCloseTo((200 * 5 + PROBE_MAX_TOKENS * 20) / 1e6, 6);
  });
});
