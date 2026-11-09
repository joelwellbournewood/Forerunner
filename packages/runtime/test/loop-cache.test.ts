import { costOf } from "@forerunner/billing";
import { FakeProvider, type ScriptedReply } from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CACHE_TTL_MARGIN_MS,
  LoopAgentDriver,
  type RunEvent,
  WRAP_UP_TEXT,
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

/**
 * w15-run, wave 15 (W15-13, live check 2's RUN-1 and F8): a file-writing run's output cap and the
 * cut-off retry follow one rule, the one web search follows: a call is paid only from the money
 * below the run's wrap-up line. Before, the write cap was a flat tenth of the run's cap (on
 * Sonnet 5.5 that is the 4,096 floor for any run under about USD 1.70), so the first long write
 * was cut; the cut reply, its complete write_file calls included, was thrown away; and the retry
 * asked four times the limit with no room check and kept it as the floor of every later call.
 * Its worst case passed the line, so a CHF 0.20 coder heard "about a fifth is left" after
 * spending CHF 0.05 and paused with nothing written.
 */
describe("w15-run, wave 15: the write cap and the cut-off retry are paid from the money below the line (W15-13)", () => {
  const coderTools = (written: string[]) => {
    const read: ToolSpec<{ path: string }> = {
      name: "read_file",
      description: "read a file",
      schema: z.object({ path: z.string() }),
      actionClass: "read",
      risk: "low",
      async execute(input) {
        return { content: `contents of ${input.path}`.repeat(20) };
      },
    };
    const write: ToolSpec<{ path: string; content: string }> = {
      name: "write_file",
      description: "write a file",
      schema: z.object({ path: z.string(), content: z.string() }),
      actionClass: "routine_reversible",
      risk: "low",
      async execute(input) {
        written.push(input.path);
        return { content: `wrote ${input.path}` };
      },
    };
    return new ToolRegistry().register(read).register(write);
  };
  const FILES = ["src/elo.js", "src/swiss.js", "test/elo.test.js", "test/swiss.test.js"];
  const writeCall = (path: string) => ({
    name: "write_file",
    input: { path, content: "x".repeat(500) },
  });

  async function coderRun(replies: ScriptedReply[], runCap: number) {
    const h = harness();
    const written: string[] = [];
    const p = provider(h, replies);
    const events: RunEvent[] = [];
    const res = await new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }).run({
      token: issue(h, { allowedTools: ["read_file", "write_file"], budgetUsdMicro: runCap }),
      budget: budget("sess-1", 6_250_000, h.clock),
      provider: p,
      model: MODEL,
      billingSourceId: "bs",
      system: "You are the coder. ".repeat(150),
      messages: [{ role: "user", content: "Write the Swiss pairing tool with tests." }],
      tools: coderTools(written),
      pricing: pricingFor(MODEL),
      timeoutMs: 3_600_000,
      wrapUp: WRAP_UP_TEXT,
      onEvent: (e) => events.push(e),
    });
    const line = events.find((e) => e.type === "budget_line");
    const lineUsd = line?.type === "budget_line" ? line.lineUsdMicro : 0;
    // Each call's spend before it plus its worst case, while the run has not been told to wrap up.
    const before: { spent: number; estimate: number }[] = [];
    let spent = 0;
    for (const e of events) {
      if (e.type === "model_call_start") before.push({ spent, estimate: e.estimateUsdMicro });
      if (e.type === "model_call_end") spent += e.costUsdMicro;
    }
    const maxTokens = p.calls.map((c) => c.request.max_tokens);
    const heard = p.calls.map((c) =>
      JSON.stringify(c.request.messages).includes(WRAP_UP_TEXT.slice(0, 30)),
    );
    return { res, events, written, lineUsd, before, maxTokens, heard, p };
  }

  it("RUN-1: the first write after reading gets the room below the line, so four files are not cut and no wrap-up comes", async () => {
    // A reply of four files needs about 6,000 output tokens: cut below that, whole above.
    const replies: ScriptedReply[] = [
      {
        reply: {
          text: "reading",
          toolCalls: [{ name: "read_file", input: { path: "README.md" } }],
        },
      },
      {
        when: (r) => r.max_tokens < 6_000,
        reply: {
          toolCalls: FILES.map(writeCall),
          stopReason: "max_tokens",
          usage: { output_tokens: 4_096 },
        },
      },
      { reply: { toolCalls: FILES.map(writeCall), usage: { output_tokens: 6_000 } } },
      { reply: { text: "Wrote the four files.\n\nWhere I stopped: done.\n\nLeft to do: nothing" } },
    ];
    // CHF 0.20, the live task's budget.
    const r = await coderRun(replies, 250_000);
    expect(r.res.outcome).toBe("completed");
    expect(r.written.sort()).toEqual([...FILES].sort());
    expect(r.events.some((e) => e.type === "warning" && e.message.includes("cut off"))).toBe(false);
    expect(r.events.some((e) => e.type === "wrap_up_sent")).toBe(false);
    expect(r.heard.some(Boolean)).toBe(false);
    // The write call asked more than the floor, and every call stayed below the run's line.
    expect(r.maxTokens[1]).toBeGreaterThanOrEqual(6_000);
    expect(r.lineUsd).toBeGreaterThan(0);
    for (const c of r.before) expect(c.spent + c.estimate).toBeLessThanOrEqual(r.lineUsd);
  });

  it("a cut reply keeps its complete writes; the retry asks more only from the money below the line, once", async () => {
    // The run's first call writes (its cap keeps to half the fifth kept to wrap up: 4,096 here),
    // and is cut inside the fourth write.
    const replies: ScriptedReply[] = [
      {
        when: (r) => r.max_tokens <= 4_096,
        reply: {
          toolCalls: FILES.map(writeCall),
          stopReason: "max_tokens",
          usage: { output_tokens: 4_096 },
        },
      },
      {
        when: (r) => JSON.stringify(r.messages).includes("so that call did not run"),
        reply: { toolCalls: [writeCall("test/swiss.test.js")], usage: { output_tokens: 2_000 } },
      },
      { reply: { text: "Wrote the four files.\n\nWhere I stopped: done.\n\nLeft to do: nothing" } },
    ];
    const r = await coderRun(replies, 250_000);
    expect(r.res.outcome).toBe("completed");
    // The three complete writes of the cut reply ran once; the cut one ran only when asked again.
    expect(r.written).toEqual(FILES);
    const asked = r.p.calls[1]?.request.messages.at(-1);
    expect(JSON.stringify(asked)).toContain(
      "Your last reply was cut off at the output limit (4096 tokens) inside a write_file call, so that call did not run; the calls before it ran. Make it again on its own.",
    );
    // The retry asked more than the cut call, less than 16,384, and below the line; the call
    // after it is fitted again (no raised floor kept), and no wrap-up came.
    expect(r.maxTokens[0]).toBe(4_096);
    expect(r.maxTokens[1]).toBeGreaterThan(4_096);
    expect(r.maxTokens[1]).toBeLessThan(WRITE_MAX_TOKENS_PER_CALL);
    expect(r.maxTokens[2]).toBeLessThanOrEqual(r.maxTokens[1] ?? 0);
    expect(r.events.some((e) => e.type === "wrap_up_sent")).toBe(false);
    for (const c of r.before) expect(c.spent + c.estimate).toBeLessThanOrEqual(r.lineUsd);
  });

  it("F8: a CHF 0.48 research run that has read pages writes its 8 KB file in one call, never cut", async () => {
    const h = harness();
    const pages = [PAGE.slice(0, 48_000), PAGE.slice(0, 48_000), PAGE.slice(0, 48_000)];
    const read: ToolSpec<{ path: string }> = {
      name: "read_file",
      description: "read a page",
      schema: z.object({ path: z.string() }),
      actionClass: "read",
      risk: "low",
      async execute() {
        return { content: pages.shift() ?? "" };
      },
    };
    let writes = 0;
    const write: ToolSpec<{ path: string; content: string }> = {
      name: "write_file",
      description: "write a file",
      schema: z.object({ path: z.string(), content: z.string() }),
      actionClass: "routine_reversible",
      risk: "low",
      async execute(input) {
        writes++;
        return { content: `wrote ${input.path}` };
      },
    };
    const tools = new ToolRegistry().register(read).register(write);
    const replies: ScriptedReply[] = [
      readStep("a"),
      readStep("b"),
      readStep("c"),
      {
        // The 8 KB file and what the reply says around it need about 6,000 tokens.
        when: (r) => r.max_tokens < 8_000,
        reply: {
          toolCalls: [{ name: "write_file", input: { path: "comparison.md", content: "half" } }],
          stopReason: "max_tokens",
          usage: { output_tokens: 4_096 },
        },
      },
      {
        reply: {
          toolCalls: [{ name: "write_file", input: { path: "comparison.md", content: "whole" } }],
          usage: { output_tokens: 3_801 },
        },
      },
      { reply: { text: "Wrote comparison.md." } },
    ];
    const p = provider(h, replies);
    const r = await run(h, p, tools, {
      runCap: 600_000,
      allowedTools: ["read_file", "write_file"],
    });
    expect(r.res.outcome).toBe("completed");
    expect(writes).toBe(1);
    expect(r.events.some((e) => e.type === "warning" && e.message.includes("cut off"))).toBe(false);
    // Every call was paid from below the line and none asked more than a whole file's room.
    const line = r.events.find((e) => e.type === "budget_line");
    const lineUsd = line?.type === "budget_line" ? line.lineUsdMicro : 0;
    let spent = 0;
    for (const e of r.events) {
      if (e.type === "model_call_start")
        expect(spent + e.estimateUsdMicro).toBeLessThanOrEqual(lineUsd);
      if (e.type === "model_call_end") spent += e.costUsdMicro;
    }
    for (const c of p.calls)
      expect(c.request.max_tokens).toBeLessThanOrEqual(WRITE_MAX_TOKENS_PER_CALL);
    // Every call billed was a reply that was used: one per step, nothing thrown away.
    expect(p.calls).toHaveLength(5);
  });

  it("a retry the money below the line cannot raise is asked again with a note to send less, never at four times the limit", async () => {
    // USD 0.13: the line leaves no room above the cut call's own limit.
    const replies: ScriptedReply[] = [
      {
        when: (r) => !JSON.stringify(r.messages).includes("Send less in one reply"),
        reply: {
          toolCalls: [writeCall("src/elo.js")],
          stopReason: "max_tokens",
          usage: { output_tokens: 4_096 },
        },
      },
      { reply: { toolCalls: [writeCall("src/elo.js")], usage: { output_tokens: 1_000 } } },
      { reply: { text: "Wrote src/elo.js.\n\nLeft to do: nothing" } },
    ];
    const r = await coderRun(replies, 130_000);
    expect(r.res.outcome).toBe("completed");
    expect(r.maxTokens[1]).toBeLessThanOrEqual(r.maxTokens[0] ?? 0);
    expect(JSON.stringify(r.p.calls[1]?.request.messages.at(-1))).toContain(
      "Your last reply was cut off at the output limit (4096 tokens) inside a write_file call, and nothing of it was used. Send less in one reply: one file per call, short enough to fit.",
    );
    expect(r.written).toEqual(["src/elo.js"]);
  });
});
