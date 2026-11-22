import type { RunPricing } from "@forerunner/runtime";
import { describe, expect, it } from "vitest";
import {
  MAX_EFFORT_TOKENS_CEILING,
  REVIEW_EVIDENCE_ALLOWANCE_TOKENS,
  REVIEW_MIN_TOKENS_PER_CALL,
  REVIEW_TOKENS_PER_CALL,
  SYSTEM_SUFFIX,
} from "../src/critic.ts";
import { CRITIC_PROMPT, world } from "./helpers.ts";

/**
 * d1116-budget-all, run C (BA-4; the owner's "yes it should count critics reviews, and fixes."):
 * what one call of a task's review may cost before it runs, so a work run keeps room for it in the
 * task's budget and the runner starts no review its budget cannot pay a first call for. It is the
 * hooks' rule: a call is admitted on its whole input plus its output cap.
 */
describe("d1116-budget-all, run C: CriticService.reviewCallUsdMicro (BA-4)", () => {
  // Sonnet 5.5 (USD 2 / 10 per million tokens) and Opus 5.5 (4 / 20), by the model's name.
  const priced = (model: string): RunPricing => {
    const [inPrice, outPrice] = /opus/i.test(model) ? [4, 20] : [2, 10];
    return {
      estimate: (i, o) => i * inPrice + o * outPrice,
      cost: (u) => u.input_tokens * inPrice + u.output_tokens * outPrice,
    };
  };

  // l4-selftasks-101 / L4-money-303 (run L4, D-L4-8): the floor is the first call's whole price at
  // the smallest output a review sized to its room asks for (2,048 tokens), not the output cap
  // alone: below it no review starts and none of its checks runs.
  it("on Sonnet 5.5: the worst case is the system prompt and the evidence allowance in, the output cap out; the floor is the same input with 2,048 tokens out", async () => {
    const w = await world({ deps: { pricing: priced } });
    try {
      const S = w.provider.countTokens(`${CRITIC_PROMPT.prompt}${SYSTEM_SUFFIX}`);
      expect(REVIEW_EVIDENCE_ALLOWANCE_TOKENS).toBe(8_000);
      const price = w.critic.reviewCallUsdMicro(1, null);
      expect(price.maxEffort).toBe(false);
      expect(REVIEW_MIN_TOKENS_PER_CALL).toBe(2_048);
      expect(price.floorUsdMicro).toBe((S + 8_000) * 2 + REVIEW_MIN_TOKENS_PER_CALL * 10);
      expect(price.worstUsdMicro).toBe((S + 8_000) * 2 + 81_920);
    } finally {
      await w.close();
    }
  });

  // The review of fix/l4-selftasks-check (non-blocking 2, the max-effort sibling of L4-money-303):
  // a review at effort max is never sized down (its first call asks for at least
  // REVIEW_TOKENS_PER_CALL, growing to the ceiling as the room pays), so its floor is the first
  // call's whole price at 8,192 tokens out. At 2,048 a review whose room lay between the two
  // prices started, ran its checks, and its first call was then refused.
  it("at effort max on Opus 5.5 (a tier 3 review): the worst case prices the ceiling of 24,000 tokens out; the floor is the same input with 8,192 tokens out, the least its first call asks for", async () => {
    const w = await world({ deps: { pricing: priced } });
    try {
      const S = w.provider.countTokens(`${CRITIC_PROMPT.prompt}${SYSTEM_SUFFIX}`);
      const price = w.critic.reviewCallUsdMicro(3, { critic_ceiling: "opus" });
      expect(price.maxEffort).toBe(true);
      expect(MAX_EFFORT_TOKENS_CEILING * 20).toBe(480_000);
      expect(price.worstUsdMicro).toBe((S + 8_000) * 4 + 480_000);
      expect(REVIEW_TOKENS_PER_CALL).toBe(8_192);
      expect(price.floorUsdMicro).toBe((S + 8_000) * 4 + REVIEW_TOKENS_PER_CALL * 20);
    } finally {
      await w.close();
    }
  });

  it("a fixed output cap per call (CriticDeps.maxTokensPerCall) is the floor's output at every effort", async () => {
    const w = await world({ deps: { pricing: priced, maxTokensPerCall: 4_000 } });
    try {
      const S = w.provider.countTokens(`${CRITIC_PROMPT.prompt}${SYSTEM_SUFFIX}`);
      expect(w.critic.reviewCallUsdMicro(1, null).floorUsdMicro).toBe((S + 8_000) * 2 + 40_000);
      expect(w.critic.reviewCallUsdMicro(3, { critic_ceiling: "opus" }).floorUsdMicro).toBe(
        (S + 8_000) * 4 + 80_000,
      );
    } finally {
      await w.close();
    }
  });
});
