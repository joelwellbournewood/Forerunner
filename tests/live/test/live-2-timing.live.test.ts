import { MODE_DEFAULTS, type ModelTier, modelIdFor } from "@forerunner/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { budgetLine } from "../src/budget.ts";
import { type LiveProvider, liveProvider } from "../src/harness.ts";
import { liveEnabled, reportDir, SKIP_REASON, writeReport } from "../src/report.ts";
import { ms, type Summary, summarize } from "../src/stats.ts";

/**
 * First-token timing for the response-time table (spec D.8 to D.15): ten short requests per
 * tier (Haiku, Sonnet) with a small `max_tokens`, time to first token and total time measured
 * by the Anthropic adapter's streaming through the metered provider, median and p90 per tier
 * against the targets of the effort table. The numbers go to the report; gates.md carries the
 * table. The text chat target (first token under 1 s median, Haiku) is the phase 1 gate's own
 * line and is asserted; the rest is recorded.
 */
const LIVE = liveEnabled();
const live = it.skipIf(!LIVE);
const SAMPLES = 10;
const TIERS: readonly ModelTier[] = ["haiku", "sonnet"];

export interface TierTiming {
  tier: ModelTier;
  model: string;
  samples: number;
  errors: number;
  ttft: Summary;
  total: Summary;
  outputTokens: number;
  usd: number;
}

describe(`response-time table, live (spec D.8 to D.15)${LIVE ? "" : ` (${SKIP_REASON})`}`, () => {
  let lp: LiveProvider;
  let dir = "";
  const timings: TierTiming[] = [];

  beforeAll(() => {
    if (!LIVE) return;
    dir = reportDir();
    lp = liveProvider();
  });
  afterAll(() => {
    if (!lp) return;
    const targets = {
      voice_chat: MODE_DEFAULTS.voice_chat,
      text_chat: MODE_DEFAULTS.text_chat,
      routing: MODE_DEFAULTS.routing,
      planning: MODE_DEFAULTS.planning,
      critic_t1: MODE_DEFAULTS.critic_t1,
    };
    const file = writeReport(dir, "timing-live", {
      run: lp.run,
      samplesPerTier: SAMPLES,
      maxTokens: 16,
      timings,
      targets,
      budget: lp.budget.snapshot(),
      calls: lp.provider.calls,
    });
    console.log(`timing report: ${file}\n${budgetLine(lp.budget)}`);
  });

  for (const tier of TIERS) {
    live(`${tier}: ${SAMPLES} short requests, time to first token and total time`, async () => {
      const model = modelIdFor(tier, "anthropic");
      const ttft: number[] = [];
      const total: number[] = [];
      let errors = 0;
      let outputTokens = 0;
      let usd = 0;
      const mark = lp.provider.calls.length;
      for (let i = 0; i < SAMPLES; i++) {
        const res = await lp.provider.complete({
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: `Reply with exactly one word: ready (${i + 1})` }],
        });
        if (res.stop_reason === "error") {
          errors++;
          continue;
        }
        ttft.push(res.time_to_first_token_ms);
        total.push(res.duration_ms);
        outputTokens += res.usage.output_tokens;
      }
      for (const c of lp.provider.calls.slice(mark)) usd += c.usd;
      const row: TierTiming = {
        tier,
        model,
        samples: ttft.length,
        errors,
        ttft: summarize(ttft),
        total: summarize(total),
        outputTokens,
        usd: Math.round(usd * 1e6) / 1e6,
      };
      timings.push(row);
      console.log(
        `${tier} (${model}): n=${row.samples} errors=${errors} ttft median ${ms(row.ttft.median)} p90 ${ms(row.ttft.p90)} ` +
          `max ${ms(row.ttft.max)}; total median ${ms(row.total.median)} p90 ${ms(row.total.p90)}; USD ${row.usd}`,
      );
      expect(errors).toBe(0);
      expect(row.samples).toBe(SAMPLES);
      expect(lp.budget.refusals).toEqual([]);
      if (tier === "haiku") {
        // Phase 1 gate: "Text chat first token under 1 s median" (D.9).
        expect(row.ttft.median).toBeLessThan(MODE_DEFAULTS.text_chat.targetMs);
      }
    });
  }
});
