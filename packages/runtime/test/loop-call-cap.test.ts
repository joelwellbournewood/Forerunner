import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LoopAgentDriver, type RunEvent } from "../src/agent/loop.ts";
import { ToolRegistry, type ToolSpec } from "../src/agent/tools.ts";
import { budget, flatPricing, harness, issue, ScriptedProvider } from "./helpers.ts";

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
});

describe("agent loop: per-call output cap from the budget left (maxTokensCeiling)", () => {
  const run = async (opts: {
    runCap: number;
    sessionCap?: number;
    maxTokensPerCall: number;
    maxTokensCeiling?: number;
  }) => {
    const h = harness();
    const provider = new ScriptedProvider([{ text: "done" }], h.clock);
    const events: RunEvent[] = [];
    const res = await driver(h).run({
      token: issue(h, { allowedTools: ["answer"], budgetUsdMicro: opts.runCap }),
      budget: budget("sess-1", opts.sessionCap ?? 5_000_000, h.clock),
      provider,
      model: "fake-haiku",
      billingSourceId: "bs",
      system: "s",
      messages: [{ role: "user", content: "go" }],
      tools: tools(),
      pricing: flatPricing,
      timeoutMs: 60_000,
      maxTokensPerCall: opts.maxTokensPerCall,
      ...(opts.maxTokensCeiling !== undefined ? { maxTokensCeiling: opts.maxTokensCeiling } : {}),
      onEvent: (e) => events.push(e),
    });
    const start = events.find((e) => e.type === "model_call_start") as
      | Extract<RunEvent, { type: "model_call_start" }>
      | undefined;
    return { res, cap: provider.calls[0]?.max_tokens, estimate: start?.estimateUsdMicro };
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
    const r = await run({
      runCap: 1_000_000,
      sessionCap: 15_000,
      maxTokensPerCall: 8192,
      maxTokensCeiling: 24_000,
    });
    expect(r.cap).toBeGreaterThan(8192);
    expect(r.estimate).toBe(15_000);
  });

  it("when even the floor does not fit, the call asks for the floor and the precheck refuses it", async () => {
    const r = await run({ runCap: 5_000, maxTokensPerCall: 8192, maxTokensCeiling: 24_000 });
    expect(r.cap).toBeUndefined();
    expect(r.res.outcome).toBe("budget_exceeded");
    expect(r.res.modelCalls).toBe(0);
  });
});
