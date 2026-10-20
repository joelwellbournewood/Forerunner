import { describe, expect, it } from "vitest";
import { LoopAgentDriver, type RunEvent, type RunRequest } from "../src/agent/loop.ts";
import { ToolRegistry } from "../src/agent/tools.ts";
import { dedupWithinBlock } from "../src/context/dedup.ts";
import { elideDenseLines } from "../src/context/dense.ts";
import { collapseLogs } from "../src/context/logs.ts";
import { ContextPipeline } from "../src/context/pipeline.ts";
import type { ChatMessage, ContentBlock } from "../src/provider/types.ts";
import { NOISY_OUTPUT, noisyTool } from "./context-helpers.ts";
import { budget, flatPricing, type Harness, harness, issue, ScriptedProvider } from "./helpers.ts";

const replies = () => [{ tools: [{ name: "noisy", input: {} }] }, { text: "done" }];

function toolResultText(messages: ChatMessage[]): string {
  const m = messages.find((x) => x.role === "user" && Array.isArray(x.content));
  if (!m) return "";
  const block = (m.content as ContentBlock[])[0];
  return block?.type === "tool_result" ? block.content : "";
}

function toolResults(messages: ChatMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const block of m.content as ContentBlock[])
      if (block.type === "tool_result") out.push(block.content);
  }
  return out;
}

/** The lossless in-block transforms as the pipeline applies them before the cross-turn step. */
function inBlock(text: string): string {
  const ctx = { countTokens: (t: string) => Math.ceil(t.length / 4) };
  let out = text;
  for (const fn of [collapseLogs, elideDenseLines, dedupWithinBlock]) out = fn(out, ctx).text;
  return out;
}

function run(h: Harness, provider: ScriptedProvider, extra: Partial<RunRequest> = {}) {
  const events: RunEvent[] = [];
  const result = new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }).run({
    token: issue(h, { allowedTools: ["noisy"] }),
    budget: budget("sess-1", 5_000_000, h.clock),
    provider,
    model: "fake-haiku",
    billingSourceId: "bs",
    system: "s",
    messages: [{ role: "user", content: "go" }],
    tools: new ToolRegistry().register(noisyTool),
    pricing: flatPricing,
    timeoutMs: 60_000,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { result, events };
}

describe("agent loop: context layer", () => {
  it("compresses the live zone, keeps the FATAL line, measures the run and reports it as an event", async () => {
    const h = harness();
    const provider = new ScriptedProvider(replies(), h.clock);
    const { result, events } = run(h, provider);
    const res = await result;
    expect(res.outcome).toBe("completed");
    expect(res.context.tokensBefore).toBeGreaterThan(0);
    expect(res.context.tokensAfter).toBeLessThan(res.context.tokensBefore);
    expect(res.context.saved).toBe(res.context.tokensBefore - res.context.tokensAfter);
    expect(res.context.transforms).toEqual(expect.arrayContaining(["logs", "dense", "truncate"]));
    expect(res.context.headroomUsed).toBe(false);
    const sent = toolResultText(res.messages);
    expect(sent.length).toBeLessThan(NOISY_OUTPUT.length);
    expect(sent).toContain("FATAL: database connection refused");
    const compressed = events.filter((e) => e.type === "context_compressed");
    expect(compressed).toHaveLength(1);
    expect(compressed[0]).toMatchObject({
      tool: "noisy",
      tokensBefore: res.context.tokensBefore,
      tokensAfter: res.context.tokensAfter,
      transforms: res.context.transforms,
    });
    expect(JSON.stringify(compressed[0])).not.toContain("row 1 ");
    // The budget hook counts the request after compression: the estimate is below the raw size.
    const second = events.find((e) => e.type === "model_call_start" && e.turn === 2);
    expect(second?.type === "model_call_start" && second.estimateUsdMicro).toBeLessThan(
      Math.ceil(NOISY_OUTPUT.length / 4),
    );
    expect(provider.calls.map((c) => c.compression)).toEqual(["default", "default"]);
  });

  it('"off" bypasses every transform: the tool result reaches the model byte-identical', async () => {
    const h = harness();
    const provider = new ScriptedProvider(replies(), h.clock);
    const { result, events } = run(h, provider, { compression: "off" });
    const res = await result;
    expect(toolResultText(res.messages)).toBe(NOISY_OUTPUT);
    expect(res.context).toEqual({
      tokensBefore: Math.ceil(NOISY_OUTPUT.length / 4),
      tokensAfter: Math.ceil(NOISY_OUTPUT.length / 4),
      saved: 0,
      transforms: [],
      headroomUsed: false,
    });
    expect(events.some((e) => e.type === "context_compressed")).toBe(false);
    expect(provider.calls.map((c) => c.compression)).toEqual(["off", "off"]);
  });

  it("measures each run on a shared session pipeline separately, echoes headroomUsed, and never references a result from another run", async () => {
    const h = harness();
    const pipeline = new ContextPipeline();
    const a = await run(h, new ScriptedProvider(replies(), h.clock), {
      context: pipeline,
      headroomUsed: true,
    }).result;
    expect(a.context.headroomUsed).toBe(true);
    expect(pipeline.savings().records).toBe(1);
    const b = await run(h, new ScriptedProvider(replies(), h.clock), { context: pipeline }).result;
    expect(b.context.headroomUsed).toBe(false);
    expect(pipeline.savings().records).toBe(2);
    expect(b.context.tokensBefore).toBe(a.context.tokensBefore);
    // Run B is a fresh transcript: run A's tool result is not in its model context, so the block
    // must be compressed on its own, never replaced by a reference to something B cannot see.
    const sentB = toolResultText(b.messages);
    expect(sentB).not.toContain("[same as tool result");
    expect(b.context.transforms).not.toContain("dedup-cross");
    expect(sentB).toContain("FATAL: database connection refused");
    expect(b.context.tokensAfter).toBe(a.context.tokensAfter);
    expect(b.context.saved).toBe(a.context.saved);
    expect(pipeline.savings().saved).toBe(a.context.saved + b.context.saved);
  });

  it("a cross-turn reference points at a tool result that is in the same transcript, by its transcript number", async () => {
    const h = harness();
    const pipeline = new ContextPipeline();
    const provider = new ScriptedProvider(
      [
        { tools: [{ name: "noisy", input: {} }] },
        { tools: [{ name: "noisy", input: { what: "again" } }] },
        { text: "done" },
      ],
      h.clock,
    );
    const res = await run(h, provider, { context: pipeline }).result;
    expect(res.outcome).toBe("completed");
    const results = toolResults(res.messages);
    expect(results).toHaveLength(2);
    const first = results[0] ?? "";
    const second = results[1] ?? "";
    expect(first).not.toContain("[same as tool result");
    const refs = [...second.matchAll(/\[same as tool result #(\d+) lines (\d+)-(\d+)\]/g)];
    expect(refs.length).toBeGreaterThan(0);
    expect(res.context.transforms).toContain("dedup-cross");
    const firstLines = first.split("\n");
    for (const m of refs) {
      const k = Number(m[1]);
      const from = Number(m[2]);
      const to = Number(m[3]);
      // #k is transcript-relative and exists; the lines it names are present as sent.
      expect(k).toBe(1);
      expect(to).toBeLessThanOrEqual(firstLines.length);
      const span = firstLines.slice(from - 1, to).join("\n");
      expect(span.length).toBeGreaterThanOrEqual(200);
      // The span is exactly what the second result would otherwise have repeated (after the
      // in-block transforms that run before the cross-turn step).
      expect(inBlock(NOISY_OUTPUT)).toContain(span);
    }
  });
});
