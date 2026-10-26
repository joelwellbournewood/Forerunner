import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LoopAgentDriver, type RunEvent, type RunPricing } from "../src/agent/loop.ts";
import { ToolRegistry, type ToolSpec } from "../src/agent/tools.ts";
import { AutoApprove, type CapDecision, type CapsPort } from "../src/enforcement/ports.ts";
import {
  budget,
  deleteRepoTool,
  flatPricing,
  harness,
  issue,
  ScriptedProvider,
} from "./helpers.ts";

/**
 * Two loop features a run that ends with one recorded answer needs (the critic's tier 3 review,
 * ADR 0028 amendment of 2026-10-26): a tool result that ends the run (no closing call priced
 * at a full output cap after the answer is in), and a per-call output cap sized from the
 * budget left for the run, between the run's floor and a ceiling.
 */

function driver(h: ReturnType<typeof harness>) {
  return new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock });
}

const answerTool: ToolSpec<{ text: string }> = {
  name: "answer",
  description: "record the answer",
  schema: z.object({ text: z.string() }),
  actionClass: "read",
  risk: "low",
  async execute(input) {
    return { content: `recorded ${input.text}`, endRun: true };
  },
};

const tools = () => new ToolRegistry().register(answerTool);

/** Opus 5.5 list rates in micro-USD per token (USD 4 / 20 per MTok). */
const OPUS: RunPricing = {
  estimate: (i, o) => Math.ceil(4 * i + 20 * o),
  cost: (u) => 4 * u.input_tokens + 20 * u.output_tokens,
};

/**
 * One outer cap (a project's, say) with `left` micro-USD left: like the billing CapChecker it
 * stops a call whose estimate reaches what is left, and reports `left` as its remainder unless
 * `read` is false (a port without the read).
 */
class RemainingCaps implements CapsPort {
  readonly checked: number[] = [];
  remainingUsdMicro?: () => number;
  constructor(
    private readonly left: number,
    opts: { read?: boolean } = {},
  ) {
    if (opts.read !== false) this.remainingUsdMicro = () => this.left;
  }
  check(_scope: unknown, estimateUsdMicro: number): CapDecision {
    this.checked.push(estimateUsdMicro);
    return estimateUsdMicro >= this.left
      ? { decision: "stop", level: "project", message: "project cap reached" }
      : { decision: "allow", remainingUsdMicro: this.left };
  }
}

describe("agent loop: a tool result that ends the run", () => {
  it("makes no further model call after a result with endRun, and the run completes", async () => {
    const h = harness();
    const provider = new ScriptedProvider(
      [{ tools: [{ name: "answer", input: { text: "x" } }] }, { text: "closing words" }],
      h.clock,
    );
    const res = await driver(h).run({
      token: issue(h, { allowedTools: ["answer"] }),
      budget: budget("sess-1", 5_000_000, h.clock),
      provider,
      model: "fake-haiku",
      billingSourceId: "bs",
      system: "s",
      messages: [{ role: "user", content: "answer" }],
      tools: tools(),
      pricing: flatPricing,
      timeoutMs: 60_000,
    });
    expect(res.outcome).toBe("completed");
    expect(res.modelCalls).toBe(1);
    expect(res.toolCalls).toBe(1);
    expect(provider.calls).toHaveLength(1);
    // The transcript keeps the tool result, so the record shows what the tool answered.
    expect(JSON.stringify(res.messages.at(-1)?.content)).toContain("recorded x");
  });

  it("ignores endRun on an error result: the model gets its turn to recover", async () => {
    const failing: ToolSpec<{ text: string }> = {
      ...answerTool,
      async execute() {
        return { content: "ERROR: not recorded", isError: true, endRun: true };
      },
    };
    const h = harness();
    const provider = new ScriptedProvider(
      [{ tools: [{ name: "answer", input: { text: "x" } }] }, { text: "after the error" }],
      h.clock,
    );
    const res = await driver(h).run({
      token: issue(h, { allowedTools: ["answer"] }),
      budget: budget("sess-1", 5_000_000, h.clock),
      provider,
      model: "fake-haiku",
      billingSourceId: "bs",
      system: "s",
      messages: [{ role: "user", content: "answer" }],
      tools: new ToolRegistry().register(failing),
      pricing: flatPricing,
      timeoutMs: 60_000,
    });
    expect(res.outcome).toBe("completed");
    expect(res.modelCalls).toBe(2);
    expect(res.finalText).toBe("after the error");
  });

  it("endRun together with a call waiting on a human ends the run needs_human", async () => {
    const h = harness({ approvals: new AutoApprove("pending") });
    const provider = new ScriptedProvider(
      [
        {
          tools: [
            { name: "answer", input: { text: "x" } },
            { name: "delete_repo", input: { repo: "r" } },
          ],
        },
        { text: "closing words" },
      ],
      h.clock,
    );
    const res = await driver(h).run({
      token: issue(h, { allowedTools: ["answer", "delete_repo"] }),
      budget: budget("sess-1", 5_000_000, h.clock),
      provider,
      model: "fake-haiku",
      billingSourceId: "bs",
      system: "s",
      messages: [{ role: "user", content: "answer" }],
      tools: new ToolRegistry().register(answerTool).register(deleteRepoTool),
      pricing: flatPricing,
      timeoutMs: 60_000,
    });
    expect(res.outcome).toBe("needs_human");
    expect(res.pending).toBeTruthy();
    expect(res.modelCalls).toBe(1);
    expect(JSON.stringify(res.messages.at(-1)?.content)).toContain("recorded x");
  });
});

describe("agent loop: per-call output cap from the budget left (maxTokensCeiling)", () => {
  const run = async (opts: {
    runCap: number;
    sessionCap?: number;
    /** Spent by an earlier run of the session before this one starts. */
    sessionSpent?: number;
    maxTokensPerCall: number;
    maxTokensCeiling?: number;
    pricing?: RunPricing;
    phase?: "work" | "review";
    caps?: CapsPort;
    /** The provider's `max_tokens` limit for the model. */
    modelLimit?: number;
  }) => {
    const h = harness(opts.caps ? { caps: opts.caps } : {});
    const provider = new ScriptedProvider([{ text: "done" }], h.clock);
    if (opts.modelLimit !== undefined) {
      const limit = opts.modelLimit;
      Object.assign(provider, { maxOutputTokens: async () => limit });
    }
    const b = budget("sess-1", opts.sessionCap ?? 5_000_000, h.clock);
    if (opts.sessionSpent) b.record("run-0", opts.sessionSpent);
    const events: RunEvent[] = [];
    const res = await driver(h).run({
      token: issue(h, { allowedTools: ["answer"], budgetUsdMicro: opts.runCap }),
      budget: b,
      provider,
      model: "fake-haiku",
      billingSourceId: "bs",
      system: "s",
      messages: [{ role: "user", content: "go" }],
      tools: tools(),
      pricing: opts.pricing ?? flatPricing,
      timeoutMs: 60_000,
      maxTokensPerCall: opts.maxTokensPerCall,
      ...(opts.maxTokensCeiling !== undefined ? { maxTokensCeiling: opts.maxTokensCeiling } : {}),
      ...(opts.phase ? { phase: opts.phase } : {}),
      onEvent: (e) => events.push(e),
    });
    const start = events.find((e) => e.type === "model_call_start") as
      | Extract<RunEvent, { type: "model_call_start" }>
      | undefined;
    return {
      res,
      budget: b,
      cap: provider.calls[0]?.max_tokens,
      estimate: start?.estimateUsdMicro,
    };
  };

  it("without a ceiling the cap is maxTokensPerCall, as before", async () => {
    const r = await run({ runCap: 1_000_000, maxTokensPerCall: 8192 });
    expect(r.cap).toBe(8192);
  });

  it("with room, the cap is the ceiling", async () => {
    const r = await run({ runCap: 1_000_000, maxTokensPerCall: 8192, maxTokensCeiling: 24_000 });
    expect(r.cap).toBe(24_000);
    expect(r.res.outcome).toBe("completed");
  });

  it("the cap is the largest whose priced estimate fits the run's budget left, never below the floor", async () => {
    // flatPricing: one token one micro-USD, so a 20000 run cap leaves 20000 - input for output.
    const r = await run({ runCap: 20_000, maxTokensPerCall: 8192, maxTokensCeiling: 24_000 });
    expect(r.cap).toBeGreaterThan(8192);
    expect(r.cap).toBeLessThan(20_000);
    expect(r.estimate).toBe(20_000);
    expect(r.res.outcome).toBe("completed");
  });

  it("the session's budget left bounds the cap too", async () => {
    // The session is already past its 80% line (no new work), so only its cap bounds the room:
    // 100000 cap, 85000 spent, 15000 left.
    const r = await run({
      runCap: 1_000_000,
      sessionCap: 100_000,
      sessionSpent: 85_000,
      maxTokensPerCall: 8192,
      maxTokensCeiling: 24_000,
    });
    expect(r.cap).toBeGreaterThan(8192);
    expect(r.estimate).toBe(15_000);
  });

  it("a larger cap never flips the session to no-new-work: the room stops below the 80% line", async () => {
    // Review finding of 2026-10-26: cap USD 5, USD 3.60 spent. At Opus rates (20 micro-USD per
    // output token) a 24000 cap is priced at USD 0.48 and reaches the USD 4.00 line, which sets
    // the session's no-new-work flag for good, though the call costs a fraction of that.
    const r = await run({
      runCap: 5_000_000,
      sessionCap: 5_000_000,
      sessionSpent: 3_600_000,
      maxTokensPerCall: 8192,
      maxTokensCeiling: 24_000,
      pricing: OPUS,
      phase: "review",
    });
    expect(r.cap).toBeGreaterThan(8192);
    expect(r.cap).toBeLessThan(24_000);
    expect(r.estimate).toBeLessThan(400_000);
    expect(r.res.outcome).toBe("completed");
    expect(r.res.finishCurrent).toBe(false);
    expect(r.budget.noNewWork).toBe(false);
  });

  it("for work, the room also stops at the review reserve", async () => {
    // reserve 20%: the work ceiling is the same 80% line; the session still takes new work.
    const r = await run({
      runCap: 5_000_000,
      sessionCap: 5_000_000,
      sessionSpent: 3_600_000,
      maxTokensPerCall: 8192,
      maxTokensCeiling: 24_000,
      pricing: OPUS,
      phase: "work",
    });
    expect(r.estimate).toBeLessThanOrEqual(400_000);
    expect(r.budget.noNewWork).toBe(false);
  });

  it("the outer caps' smallest remainder bounds the cap: a cap with room for the floor still runs", async () => {
    // Review finding of 2026-10-26: a project cap with room for the 8192 estimate but not the
    // 24000 one refused the call, and the review ended with no verdict.
    const outer = new RemainingCaps(15_000);
    const r = await run({
      runCap: 1_000_000,
      maxTokensPerCall: 8192,
      maxTokensCeiling: 24_000,
      caps: outer,
    });
    expect(r.res.outcome).toBe("completed");
    expect(r.cap).toBeGreaterThan(8192);
    expect(r.estimate).toBe(14_999);
    expect(outer.checked).toEqual([14_999]);
  });

  it("a caps port without a remainder read bounds nothing; its check still decides", async () => {
    const outer = new RemainingCaps(15_000, { read: false });
    const r = await run({
      runCap: 1_000_000,
      maxTokensPerCall: 8192,
      maxTokensCeiling: 24_000,
      caps: outer,
    });
    expect(r.res.outcome).toBe("budget_exceeded");
    expect(r.res.modelCalls).toBe(0);
  });

  it("the ceiling is clamped to the model's output limit when the provider reports one", async () => {
    const r = await run({
      runCap: 1_000_000,
      maxTokensPerCall: 8192,
      maxTokensCeiling: 24_000,
      modelLimit: 16_000,
    });
    expect(r.cap).toBe(16_000);
    expect(r.res.outcome).toBe("completed");
  });

  it("a model limit under the floor leaves the floor (the ceiling only ever raises the cap)", async () => {
    const r = await run({
      runCap: 1_000_000,
      maxTokensPerCall: 8192,
      maxTokensCeiling: 24_000,
      modelLimit: 4_000,
    });
    expect(r.cap).toBe(8192);
  });

  it("a ceiling that is not a positive whole number is refused before the run starts", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        run({ runCap: 1_000_000, maxTokensPerCall: 8192, maxTokensCeiling: bad }),
      ).rejects.toMatchObject({ code: "validation" });
    }
  });

  it("when even the floor does not fit, the call asks for the floor and the precheck refuses it", async () => {
    const r = await run({ runCap: 5_000, maxTokensPerCall: 8192, maxTokensCeiling: 24_000 });
    expect(r.cap).toBeUndefined();
    expect(r.res.outcome).toBe("budget_exceeded");
    expect(r.res.modelCalls).toBe(0);
  });
});
