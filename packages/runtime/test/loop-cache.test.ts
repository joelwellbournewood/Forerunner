import { costOf } from "@forerunner/billing";
import { FakeProvider, type ScriptedReply } from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CACHE_TTL_MARGIN_MS,
  LoopAgentDriver,
  type RunEvent,
  WRITE_MAX_TOKENS_PER_CALL,
} from "../src/agent/loop.ts";
import { ToolRegistry, type ToolSpec } from "../src/agent/tools.ts";
import { WRAP_UP_CALLS, WRAP_UP_SHARE } from "../src/enforcement/budget.ts";
import { pricingFor } from "../src/wiring/billing-ports.ts";
import { budget, harness, issue } from "./helpers.ts";

/**
 * 'cost' (L-15, the owner's budget decision of 2026-11-02, "better estimates and caching"): the
 * agent loop caches its conversation, so each call reads what the previous call sent and pays
 * the write price only for what is new; the pre-call worst case prices exactly that and is
 * never below the bill; a run that writes files gets room for a long write in one call.
 *
 * The provider is the fake with the prompt-cache stand-in (`PromptCacheSim`: Anthropic's rules,
 * a 512-token minimum, five minutes from the start of the request that wrote or read an entry),
 * priced at Sonnet 5.5's list rates, so the estimate is checked against a realistic bill.
 */

const MODEL = "claude-sonnet-5-5";
/** A page the size the loop keeps of a tool result (60,000 characters, about 15k tokens). */
const PAGE = Array.from({ length: 1_200 }, (_, i) => `Line ${i}: static site generator notes.`)
  .join("\n")
  .slice(0, 60_000);

function setup(opts: { readPages?: string[]; minutesPerRead?: number } = {}) {
  const h = harness();
  const pages = [...(opts.readPages ?? [])];
  const read: ToolSpec<{ path: string }> = {
    name: "read_file",
    description: "read a file",
    schema: z.object({ path: z.string() }),
    actionClass: "read",
    risk: "low",
    async execute(input) {
      // A tool that takes a while (a slow test run, a long page): the clock moves on.
      if (opts.minutesPerRead) await h.clock.advance(opts.minutesPerRead * 60_000);
      return { content: pages.shift() ?? `contents of ${input.path}` };
    },
  };
  const tools = new ToolRegistry().register(read);
  return { h, tools };
}

function provider(h: ReturnType<typeof harness>, replies: ScriptedReply[]) {
  return new FakeProvider({ clock: h.clock, latency: "none", replies, promptCache: true });
}

const readStep = (path: string): ScriptedReply => ({
  reply: { text: `reading ${path}`, toolCalls: [{ name: "read_file", input: { path } }] },
});

async function run(
  h: ReturnType<typeof harness>,
  p: FakeProvider,
  tools: ToolRegistry,
  over: { system?: string; runCap?: number; allowedTools?: string[] } = {},
) {
  const events: RunEvent[] = [];
  const res = await new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }).run({
    token: issue(h, {
      allowedTools: over.allowedTools ?? ["read_file"],
      budgetUsdMicro: over.runCap ?? 5_000_000,
    }),
    budget: budget("sess-1", 10_000_000, h.clock),
    provider: p,
    model: MODEL,
    billingSourceId: "bs",
    system: over.system ?? "You are the researcher. ".repeat(300),
    messages: [{ role: "user", content: "Compare three static site generators." }],
    tools,
    pricing: pricingFor(MODEL),
    timeoutMs: 3_600_000,
    onEvent: (e) => events.push(e),
  });
  const starts = events.filter(
    (e): e is Extract<RunEvent, { type: "model_call_start" }> => e.type === "model_call_start",
  );
  const ends = events.filter(
    (e): e is Extract<RunEvent, { type: "model_call_end" }> => e.type === "model_call_end",
  );
  return { res, starts, ends, events };
}

describe("agent loop: the conversation is cached (cost, L-15)", () => {
  it("every request asks for the history to be cached, and cache reads grow call by call", async () => {
    const { h, tools } = setup();
    const p = provider(h, [
      readStep("a.md"),
      readStep("b.md"),
      readStep("c.md"),
      { reply: { text: "the report" } },
    ]);
    const { res, ends } = await run(h, p, tools);
    expect(res.outcome).toBe("completed");
    expect(p.calls).toHaveLength(4);
    for (const c of p.calls)
      expect(c.request.cache).toEqual({ system: true, tools: true, messages: true });
    const reads = ends.map((e) => e.usage.cache_read_input_tokens);
    // The first call writes the system prompt, the tools and the brief; every later call reads
    // all that the call before it sent, and more each time.
    expect(reads[0]).toBe(0);
    expect(ends[0]?.usage.cache_creation_input_tokens).toBeGreaterThan(0);
    for (let i = 1; i < reads.length; i++)
      expect(reads[i] as number).toBeGreaterThan(reads[i - 1] as number);
    // What is new each turn is written once, small next to what is read.
    const last = ends.at(-1)?.usage;
    expect(last?.cache_creation_input_tokens).toBeLessThan(last?.cache_read_input_tokens ?? 0);
    // The run's usage adds the reads up, and its cost is priced with the cache's rates.
    expect(res.usage.cache_read_input_tokens).toBe(reads.reduce((s, n) => s + n, 0));
  });

  it("each call's estimate is at least its bill: a first call, a large new tool result, a cache that expired", async () => {
    // b.md is a long page; reading c.md takes six minutes, past the cache's lifetime.
    const { h, tools } = setup({ readPages: ["short a", PAGE, "short c"] });
    let reads = 0;
    const slowTools = new ToolRegistry().register({
      ...(tools.get("read_file") as ToolSpec),
      async execute(input: unknown, ctx) {
        reads++;
        if (reads === 3) await h.clock.advance(6 * 60_000);
        return (tools.get("read_file") as ToolSpec).execute(input, ctx);
      },
    });
    const p = provider(h, [
      readStep("a.md"),
      readStep("b.md"),
      readStep("c.md"),
      { reply: { text: "the report" } },
    ]);
    const { res, starts, ends } = await run(h, p, slowTools);
    expect(res.outcome).toBe("completed");
    expect(starts).toHaveLength(4);
    for (const [i, end] of ends.entries()) {
      const start = starts[i] as (typeof starts)[number];
      expect(start.estimateUsdMicro, `call ${i + 1}`).toBeGreaterThanOrEqual(end.costUsdMicro);
    }
    // Call 3 sent the page: written at the write price, and its estimate covered it.
    expect(ends[2]?.usage.cache_creation_input_tokens).toBeGreaterThan(10_000);
    // Call 4 came after six minutes: nothing was read, everything was written again.
    expect(ends[3]?.usage.cache_read_input_tokens).toBe(0);
    expect(ends[3]?.usage.cache_creation_input_tokens).toBeGreaterThan(10_000);
  });

  it("a call that reads most of its input from the cache is estimated below the old whole-input figure", async () => {
    const { h, tools } = setup({ readPages: [PAGE, "short b"] });
    const p = provider(h, [readStep("a.md"), readStep("b.md"), { reply: { text: "the report" } }]);
    const { starts, ends } = await run(h, p, tools);
    const old = (i: number) => {
      // Before: the whole input at the input price, whatever the cache did.
      const u = ends[i]?.usage;
      const input =
        (u?.input_tokens ?? 0) +
        (u?.cache_read_input_tokens ?? 0) +
        (u?.cache_creation_input_tokens ?? 0);
      return costOf({ tokens_in: input, tokens_out: p.calls[i]?.request.max_tokens ?? 0 }, MODEL);
    };
    // Call 3 reads the page call 2 wrote: far below the old figure, and still above its bill.
    expect(ends[2]?.usage.cache_read_input_tokens).toBeGreaterThan(10_000);
    expect(starts[2]?.estimateUsdMicro).toBeLessThan(old(2));
    expect(starts[2]?.estimateUsdMicro).toBeGreaterThanOrEqual(ends[2]?.costUsdMicro ?? 0);
    // Calls 1 and 2 write most of what they send: not below the old figure.
    expect(starts[0]?.estimateUsdMicro).toBeGreaterThan(old(0));
    expect(starts[1]?.estimateUsdMicro).toBeGreaterThan(old(1));
  });

  it("the cache is not expected once the previous call started almost five minutes ago (the margin)", async () => {
    // The first read takes the cache's lifetime less half the margin: the entry may still be
    // there, but too near its end to count on, so call 2 is priced as if nothing were cached.
    const { h, tools } = setup();
    const ttl = 5 * 60_000;
    let first = true;
    const slow = new ToolRegistry().register({
      ...(tools.get("read_file") as ToolSpec),
      async execute(input: unknown, ctx) {
        if (first) await h.clock.advance(ttl - CACHE_TTL_MARGIN_MS / 2);
        first = false;
        return (tools.get("read_file") as ToolSpec).execute(input, ctx);
      },
    });
    const p = provider(h, [readStep("a.md"), { reply: { text: "the report" } }]);
    const { starts, ends } = await run(h, p, slow);
    const sent = p.calls[1]?.request;
    const pricing = pricingFor(MODEL);
    // What the loop counts: the system prompt, the messages and the tool definitions it sent.
    const input = new FakeProvider().countTokens(
      (sent?.system ?? "") + JSON.stringify(sent?.messages) + JSON.stringify(sent?.tools),
    );
    expect(starts[1]?.estimateUsdMicro).toBe(pricing.estimate(input, sent?.max_tokens ?? 0, 0));
    expect(starts[1]?.estimateUsdMicro).toBeGreaterThanOrEqual(ends[1]?.costUsdMicro ?? 0);
  });
});

describe("agent loop: a long write gets its tokens the first time (cost, L-15)", () => {
  const writeTool: ToolSpec<{ path: string; content: string }> = {
    name: "write_file",
    description: "write a file",
    schema: z.object({ path: z.string(), content: z.string() }),
    actionClass: "routine_reversible",
    risk: "low",
    async execute(input) {
      return { content: `wrote ${input.path}` };
    },
  };

  const once = async (opts: { runCap: number; withWrite: boolean }) => {
    const h = harness();
    const tools = new ToolRegistry();
    if (opts.withWrite) tools.register(writeTool);
    const p = provider(h, [{ reply: { text: "done" } }]);
    const r = await run(h, p, tools, {
      system: "s",
      runCap: opts.runCap,
      allowedTools: opts.withWrite ? ["write_file"] : [],
    });
    return {
      ...r,
      maxTokens: p.calls[0]?.request.max_tokens,
      estimate: r.starts[0]?.estimateUsdMicro,
    };
  };

  it("a run that can write files asks for a whole file's room when its budget keeps its wrap-up reserve", async () => {
    const r = await once({ runCap: 5_000_000, withWrite: true });
    expect(r.maxTokens).toBe(WRITE_MAX_TOKENS_PER_CALL);
    // Two calls at that size still fit in the fifth of the run's budget kept to wrap up.
    expect(WRAP_UP_CALLS * (r.estimate ?? 0)).toBeLessThanOrEqual(WRAP_UP_SHARE * 5_000_000);
  });

  it("a small budget keeps the usual cap, so its wrap-up reserve does not grow", async () => {
    // USD 0.30: 16k output tokens alone are USD 0.16 on Sonnet 5.5, two of them more than a
    // fifth of the budget.
    const small = await once({ runCap: 300_000, withWrite: true });
    expect(small.maxTokens).toBe(4096);
    // Between the two, as much as keeps two calls within the fifth kept to wrap up.
    const mid = await once({ runCap: 1_000_000, withWrite: true });
    expect(mid.maxTokens).toBeGreaterThan(4096);
    expect(mid.maxTokens).toBeLessThan(WRITE_MAX_TOKENS_PER_CALL);
    expect(WRAP_UP_CALLS * (mid.estimate ?? 0)).toBeLessThanOrEqual(WRAP_UP_SHARE * 1_000_000);
  });

  it("a run without a file-writing tool keeps the usual cap", async () => {
    const r = await once({ runCap: 5_000_000, withWrite: false });
    expect(r.maxTokens).toBe(4096);
  });
});
