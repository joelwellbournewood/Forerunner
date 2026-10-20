import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
// Test-only relative import of the runtime's shared collector, to prove the fake's complete()
// agrees with it. testenv itself never imports the runtime at runtime.
import { collectStream } from "../../packages/runtime/src/provider/types.ts";
import {
  chunkText,
  errorReply,
  FakeProvider,
  FakeUsageSource,
  type ModelRequest,
  requestText,
  type StreamEvent,
  seqReplies,
  type ToolDefinition,
  textReply,
  toolReply,
} from "../src/provider/index.ts";

const tools: ToolDefinition[] = [
  { name: "read_file", description: "read a file", input_schema: { type: "object" } },
  { name: "write_file", description: "write a file", input_schema: { type: "object" } },
];

function req(user: string, extra: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: "fake-haiku",
    messages: [{ role: "user", content: user }],
    max_tokens: 256,
    ...extra,
  };
}

/** Let queued microtasks and the current macrotask settle without moving a simulated clock. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function events(p: FakeProvider, r: ModelRequest): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of p.stream(r)) out.push(ev);
  return out;
}

describe("FakeProvider script mode", () => {
  it("answers from the queue in order, consuming each reply once by default", async () => {
    const p = new FakeProvider({ latency: "none", replies: seqReplies(["first", "second"]) });
    const a = await p.complete(req("one"));
    const b = await p.complete(req("two"));
    expect(a.content).toEqual([{ type: "text", text: "first" }]);
    expect(b.content).toEqual([{ type: "text", text: "second" }]);
    expect(p.remainingReplies()).toBe(0);
    // exhausted: the default is an echo of the last user message
    const c = await p.complete(req("three"));
    expect(c.content).toEqual([{ type: "text", text: "three" }]);
    expect(p.calls.map((c) => c.source)).toEqual(["script", "script", "echo"]);
  });

  it("throws a not_found ForerunnerError when nothing matches and onNoMatch is throw", async () => {
    const p = new FakeProvider({ latency: "none", onNoMatch: "throw", replies: [] });
    const err = await p.complete(req("hello")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForerunnerError);
    expect((err as ForerunnerError).code).toBe("not_found");
    expect((err as ForerunnerError).message).toContain("no scripted reply matched");
    // the failed request is still recorded
    expect(p.calls).toHaveLength(1);
  });

  it("matches with a predicate function", async () => {
    const p = new FakeProvider({
      latency: "none",
      replies: [
        textReply("opus answer", { when: (r) => r.model === "fake-opus" }),
        textReply("other answer"),
      ],
    });
    const a = await p.complete(req("q", { model: "fake-haiku" }));
    const b = await p.complete(req("q", { model: "fake-opus" }));
    expect(a.content).toEqual([{ type: "text", text: "other answer" }]);
    expect(b.content).toEqual([{ type: "text", text: "opus answer" }]);
  });

  it("matches on systemIncludes, lastUserIncludes (including tool results), toolAvailable, model", async () => {
    const p = new FakeProvider({
      latency: "none",
      onNoMatch: "throw",
      replies: [
        textReply("sys", { when: { systemIncludes: "You are the critic" }, times: Infinity }),
        textReply("tool", { when: { toolAvailable: "write_file" }, times: Infinity }),
        textReply("model", { when: { model: "fake-fable" }, times: Infinity }),
        textReply("result", { when: { lastUserIncludes: "exit code 1" }, times: Infinity }),
        textReply("user", { when: { lastUserIncludes: "please" }, times: Infinity }),
      ],
    });
    const text = async (r: ModelRequest) =>
      (await p.complete(r)).content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(await text(req("x", { system: "You are the critic." }))).toBe("sys");
    expect(await text(req("x", { tools }))).toBe("tool");
    expect(await text(req("x", { model: "fake-fable" }))).toBe("model");
    expect(await text(req("please help"))).toBe("user");
    expect(
      await text({
        model: "fake-haiku",
        max_tokens: 10,
        messages: [
          { role: "user", content: "run it" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "run", input: {} }] },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "tests: exit code 1" }],
          },
        ],
      }),
    ).toBe("result");
    // every field of a matcher must hold
    await expect(
      p.complete(req("x", { system: "You are the critic", model: "fake-sonnet" })),
    ).resolves.toBeTruthy();
    await expect(p.complete(req("nothing here"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("honours times: consumed after N uses, Infinity never consumed, pushReplies and reset", async () => {
    const p = new FakeProvider({
      latency: "none",
      replies: [textReply("twice", { times: 2 }), textReply("always", { times: Infinity })],
    });
    const texts: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await p.complete(req("go"));
      texts.push(r.content[0]?.type === "text" ? r.content[0].text : "");
    }
    expect(texts).toEqual(["twice", "twice", "always", "always"]);
    expect(p.remainingReplies()).toBe(1);
    p.pushReplies(textReply("late"));
    // "always" still matches first; a later entry only answers when earlier ones do not match
    const r = await p.complete(req("go"));
    expect(r.content).toEqual([{ type: "text", text: "always" }]);
    p.reset();
    expect(p.calls).toHaveLength(0);
    expect(p.remainingReplies()).toBe(2);
    const again = await p.complete(req("go"));
    expect(again.content).toEqual([{ type: "text", text: "twice" }]);
  });

  it("rejects an invalid script", () => {
    expect(() => new FakeProvider({ replies: [{ reply: { text: "x" }, times: 0 }] })).toThrow(
      /times/,
    );
    expect(() => new FakeProvider({ replies: [{ reply: { text: "x", ttftMs: -1 } }] })).toThrow(
      /ttftMs/,
    );
  });

  it("records every request in .calls as a copy without the signal", async () => {
    const p = new FakeProvider({
      latency: "none",
      replies: [toolReply("read_file", { path: "a" })],
    });
    const ac = new AbortController();
    const r = req("record me", { tools, signal: ac.signal, system: "sys" });
    await p.complete(r);
    expect(p.calls).toHaveLength(1);
    const call = p.calls[0];
    expect(call?.index).toBe(0);
    expect(call?.request.model).toBe("fake-haiku");
    expect(call?.request.system).toBe("sys");
    expect(call?.request.messages).toEqual(r.messages);
    expect(call?.request.messages).not.toBe(r.messages);
    expect("signal" in (call?.request ?? {})).toBe(false);
    expect(call?.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(call?.source).toBe("script");
    expect(call?.reply?.toolCalls?.[0]?.name).toBe("read_file");
    expect(p.lastCall).toBe(call);
  });
});

describe("FakeProvider echo mode", () => {
  it("returns the last user message deterministically", async () => {
    const p = new FakeProvider({ mode: "echo", latency: "none" });
    const a = await p.complete(req("say this back"));
    const b = await p.complete(req("say this back"));
    expect(a.content).toEqual([{ type: "text", text: "say this back" }]);
    expect(b.content).toEqual(a.content);
    expect(a.stop_reason).toBe("end_turn");
    expect(a.model).toBe("fake-haiku");
    const empty = await p.complete({ model: "fake-haiku", messages: [], max_tokens: 1 });
    expect(empty.content).toEqual([{ type: "text", text: "(no user message)" }]);
  });
});

describe("FakeProvider streaming", () => {
  const longText =
    "The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly " +
    "and sphinx of black quartz judges my vow, which is long enough for several chunks.";

  it("emits message_start, text in ~4-8 token chunks, tool_use start/delta/end, then message_end", async () => {
    const p = new FakeProvider({
      latency: "none",
      replies: [
        {
          reply: {
            text: longText,
            toolCalls: [
              { name: "read_file", input: { path: "src/index.ts", encoding: "utf8" } },
              { name: "write_file", input: { path: "src/out.ts", text: "export {};\n" } },
            ],
          },
        },
      ],
    });
    const evs = await events(p, req("go", { tools }));
    expect(evs[0]).toEqual({ type: "message_start", model: "fake-haiku" });
    expect(evs[evs.length - 1]?.type).toBe("message_end");
    const types = evs.map((e) => e.type);
    const firstTool = types.indexOf("tool_use_start");
    const lastText = types.lastIndexOf("text_delta");
    expect(lastText).toBeGreaterThan(0);
    expect(firstTool).toBeGreaterThan(lastText);

    const chunks = evs.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.join("")).toBe(longText);
    for (const [i, c] of chunks.entries()) {
      expect(c.length).toBeLessThanOrEqual(32); // 8 tokens at 4 chars
      if (i < chunks.length - 1) expect(c.length).toBeGreaterThanOrEqual(16); // 4 tokens
    }

    const toolEvents = evs.filter(
      (e) =>
        e.type === "tool_use_start" || e.type === "tool_use_delta" || e.type === "tool_use_end",
    );
    const ids = [...new Set(toolEvents.map((e) => ("id" in e ? e.id : "")))];
    expect(ids).toEqual(["toolu_fake_0_0", "toolu_fake_0_1"]);
    for (const id of ids) {
      const mine = toolEvents.filter((e) => "id" in e && e.id === id);
      expect(mine[0]?.type).toBe("tool_use_start");
      expect(mine[mine.length - 1]?.type).toBe("tool_use_end");
      const deltas = mine.filter((e) => e.type === "tool_use_delta");
      expect(deltas.length).toBeGreaterThan(1);
      const json = deltas.map((d) => (d.type === "tool_use_delta" ? d.partial_json : "")).join("");
      const end = mine[mine.length - 1];
      expect(JSON.parse(json)).toEqual(end?.type === "tool_use_end" ? end.input : null);
      // a single partial delta is not valid JSON on its own
      const first = deltas[0];
      expect(() =>
        JSON.parse(first?.type === "tool_use_delta" ? first.partial_json : ""),
      ).toThrow();
    }
    const end = evs[evs.length - 1];
    expect(end?.type === "message_end" && end.stop_reason).toBe("tool_use");
  });

  it("chunkText keeps every character and ends chunks on whitespace when it can", () => {
    const chunks = chunkText(longText, 20);
    expect(chunks.join("")).toBe(longText);
    for (const c of chunks.slice(0, -1)) expect(c.length).toBeGreaterThanOrEqual(20);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunkText("", 20)).toEqual([]);
    // a tail shorter than the slack is absorbed into the last chunk (still within 1.5x)
    expect(chunkText("a".repeat(45), 20)).toEqual(["a".repeat(20), "a".repeat(25)]);
    expect(chunkText("a".repeat(60), 20)).toEqual(["a".repeat(20), "a".repeat(20), "a".repeat(20)]);
  });

  it("emits thinking before text and collects it as a thinking block", async () => {
    const p = new FakeProvider({
      latency: "none",
      replies: [{ reply: { thinking: "let me think about it", text: "answer" } }],
    });
    const evs = await events(p, req("q"));
    const types = evs.map((e) => e.type);
    expect(types.indexOf("thinking_delta")).toBeLessThan(types.indexOf("text_delta"));
    const res = await new FakeProvider({
      latency: "none",
      replies: [{ reply: { thinking: "let me think about it", text: "answer" } }],
    }).complete(req("q"));
    expect(res.content).toContainEqual({ type: "thinking", text: "let me think about it" });
    expect(res.content).toContainEqual({ type: "text", text: "answer" });
  });

  it("complete() equals the runtime's collectStream over the same stream", async () => {
    const script = () => [toolReply("read_file", { path: "x" }, longText)];
    const clock = new SimulatedClock(0);
    const a = new FakeProvider({ clock, latency: "none", replies: script() });
    const b = new FakeProvider({ clock, latency: "none", replies: script() });
    const r = req("same", { tools });
    const viaComplete = await a.complete(r);
    const viaCollect = await collectStream(
      b.stream(r),
      () => clock.monotonic(),
      () => clock.monotonic(),
    );
    expect(viaComplete).toEqual(viaCollect);
    expect(viaComplete.content.map((c) => c.type)).toEqual(["text", "tool_use"]);
    expect(viaComplete.stop_reason).toBe("tool_use");
  });

  it("computes usage from the request and the reply, overridable per field", async () => {
    const p = new FakeProvider({
      latency: "none",
      replies: [
        textReply("four  chars x3"), // 14 chars -> 4 tokens
        textReply("x", { usage: { output_tokens: 50_000, cache_read_input_tokens: 7 } }),
      ],
    });
    const r = req("hello world", { system: "be brief", tools });
    const a = await p.complete(r);
    expect(a.usage.input_tokens).toBe(Math.ceil(requestText(r).length / 4));
    expect(a.usage.input_tokens).toBeGreaterThan(10);
    expect(a.usage.output_tokens).toBe(4);
    expect(a.usage.cache_read_input_tokens).toBe(0);
    const b = await p.complete(r);
    expect(b.usage.output_tokens).toBe(50_000);
    expect(b.usage.cache_read_input_tokens).toBe(7);
    expect(b.usage.input_tokens).toBe(a.usage.input_tokens);
    expect(p.countTokens("abcdefghi")).toBe(3);
  });
});

describe("FakeProvider latency", () => {
  it("measures TTFT and duration equal to the scripted ttftMs/totalMs on a SimulatedClock", async () => {
    const clock = new SimulatedClock(0);
    const p = new FakeProvider({
      clock,
      replies: [
        textReply("one two three four five six seven eight nine ten eleven twelve thirteen", {
          ttftMs: 250,
          totalMs: 1000,
        }),
      ],
    });
    const pending = p.complete(req("go"));
    await clock.advance(250); // first token lands exactly here
    await clock.advance(750); // the rest is spread up to totalMs
    const res = await pending;
    expect(res.time_to_first_token_ms).toBe(250);
    expect(res.duration_ms).toBe(1000);
    expect(res.content).toHaveLength(1);
  });

  it("waits the default 300 ms before the first token and nothing arrives earlier", async () => {
    const clock = new SimulatedClock(0);
    const p = new FakeProvider({ clock, replies: [textReply("hello there")] });
    const seen: StreamEvent[] = [];
    const consumer = (async () => {
      for await (const ev of p.stream(req("hi"))) seen.push(ev);
    })();
    await settle();
    expect(seen.map((e) => e.type)).toEqual(["message_start"]);
    await clock.advance(299);
    await settle();
    expect(seen.map((e) => e.type)).toEqual(["message_start"]);
    await clock.advance(1);
    await settle();
    expect(seen.some((e) => e.type === "text_delta")).toBe(true);
    await clock.advance(10_000);
    await consumer;
    expect(seen[seen.length - 1]?.type).toBe("message_end");
  });

  it("spreads chunks between ttft and total so a timeout can fire mid-stream", async () => {
    const clock = new SimulatedClock(0);
    const p = new FakeProvider({
      clock,
      replies: [{ reply: { text: "a".repeat(200), ttftMs: 100, totalMs: 2000 } }],
    });
    const seen: StreamEvent[] = [];
    const consumer = (async () => {
      for await (const ev of p.stream(req("hi"))) seen.push(ev);
    })();
    await clock.advance(100);
    await settle();
    const afterFirst = seen.filter((e) => e.type === "text_delta").length;
    expect(afterFirst).toBe(1);
    await clock.advance(1000);
    await settle();
    const midway = seen.filter((e) => e.type === "text_delta").length;
    expect(midway).toBeGreaterThan(afterFirst);
    expect(midway).toBeLessThan(10); // 200 chars / 20 = 10 chunks in total
    expect(clock.pendingTimers()).toBe(1);
    await clock.advance(900);
    await consumer;
    expect(seen.filter((e) => e.type === "text_delta").length).toBe(10);
    expect(clock.now()).toBe(2000);
  });

  it("latency none skips every sleep even when the script asks for latency", async () => {
    const clock = new SimulatedClock(0);
    const p = new FakeProvider({
      clock,
      latency: "none",
      replies: [textReply("fast", { ttftMs: 5000, totalMs: 9000 })],
    });
    const res = await p.complete(req("hi"));
    expect(res.time_to_first_token_ms).toBe(0);
    expect(res.duration_ms).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe("FakeProvider abort", () => {
  it("stops mid-stream with an aborted error event when the signal fires between chunks", async () => {
    const p = new FakeProvider({
      latency: "none",
      replies: [textReply("one two three four five six seven eight nine ten eleven twelve")],
    });
    const ac = new AbortController();
    const seen: StreamEvent[] = [];
    for await (const ev of p.stream(req("go", { signal: ac.signal }))) {
      seen.push(ev);
      if (ev.type === "text_delta") ac.abort();
    }
    expect(seen.filter((e) => e.type === "text_delta")).toHaveLength(1);
    expect(seen[seen.length - 1]).toEqual({
      type: "error",
      code: "aborted",
      message: "aborted",
      retryable: false,
    });
    expect(seen.some((e) => e.type === "message_end")).toBe(false);
  });

  it("aborts a pending simulated sleep and complete() returns the partial reply as aborted", async () => {
    const clock = new SimulatedClock(0);
    const p = new FakeProvider({
      clock,
      replies: [
        textReply("alpha beta gamma delta epsilon zeta eta theta", { ttftMs: 100, totalMs: 1000 }),
      ],
    });
    const ac = new AbortController();
    const pending = p.complete(req("go", { signal: ac.signal }));
    await clock.advance(100);
    await settle();
    ac.abort(new Error("timeout"));
    const res = await pending;
    expect(res.stop_reason).toBe("aborted");
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.type === "text" && res.content[0].text.length).toBeLessThan(40);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe("FakeProvider errors", () => {
  it.each([
    ["rate_limit", "provider_rate_limit", true],
    ["auth", "provider_auth", false],
    ["overloaded", "provider_error", false],
  ])(
    "maps %s to %s (retryable %s) in the stream and throws from complete()",
    async (code, mapped, retryable) => {
      const p = new FakeProvider({
        latency: "none",
        replies: [errorReply(code, `boom ${code}`, { times: 2 })],
      });
      const evs = await events(p, req("x"));
      expect(evs.map((e) => e.type)).toEqual(["message_start", "error"]);
      expect(evs[1]).toEqual({ type: "error", code: mapped, message: `boom ${code}`, retryable });
      const err = await p.complete(req("x")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForerunnerError);
      expect((err as ForerunnerError).code).toBe(mapped);
      expect((err as ForerunnerError).retryable).toBe(retryable);
      expect((err as ForerunnerError).message).toBe(`boom ${code}`);
    },
  );

  it("lets a script override retryable and waits ttft before failing", async () => {
    const clock = new SimulatedClock(0);
    const p = new FakeProvider({
      clock,
      replies: [errorReply("rate_limit", "slow down", { retryable: false, ttftMs: 500 })],
    });
    const pending = p.complete(req("x")).catch((e: unknown) => e);
    await clock.advance(499);
    await settle();
    expect(clock.pendingTimers()).toBe(1);
    await clock.advance(1);
    const err = (await pending) as ForerunnerError;
    expect(err.code).toBe("provider_rate_limit");
    expect(err.retryable).toBe(false);
  });
});

describe("FakeProvider models and helpers", () => {
  it("lists the fake ladder with tiers, cheapest first", async () => {
    const p = new FakeProvider();
    const models = await p.listModels();
    expect(models).toEqual([
      { provider: "fake", id: "fake-haiku", tier: "haiku" },
      { provider: "fake", id: "fake-sonnet", tier: "sonnet" },
      { provider: "fake", id: "fake-opus", tier: "opus" },
      { provider: "fake", id: "fake-fable", tier: "fable" },
    ]);
    expect(p.name).toBe("fake");
    // copies: a caller cannot mutate the ladder
    const first = models[0];
    if (first) first.id = "changed";
    expect((await p.listModels())[0]?.id).toBe("fake-haiku");
  });

  it("builds replies with textReply, toolReply, errorReply and seqReplies", () => {
    expect(textReply("hi")).toEqual({ reply: { text: "hi" } });
    expect(textReply("hi", { times: 3, ttftMs: 10 })).toEqual({
      reply: { text: "hi", ttftMs: 10 },
      times: 3,
    });
    expect(toolReply("read_file", { path: "a" }, "reading")).toEqual({
      reply: { text: "reading", toolCalls: [{ name: "read_file", input: { path: "a" } }] },
    });
    expect(toolReply("read_file", { path: "a" }).reply.text).toBeUndefined();
    expect(errorReply("auth")).toEqual({
      reply: { error: { code: "auth", message: "fake provider error: auth" } },
    });
    expect(errorReply("rate_limit", "m", { retryable: false }).reply.error).toEqual({
      code: "rate_limit",
      message: "m",
      retryable: false,
    });
    const seq = seqReplies(["a", { text: "b" }, textReply("c", { times: 5 }), toolReply("t", {})]);
    expect(seq.map((s) => s.times)).toEqual([1, 1, 5, 1]);
    expect(seq.map((s) => s.reply.text)).toEqual(["a", "b", "c", undefined]);
  });

  it("FakeUsageSource reports a movable plan usage share and validates it", async () => {
    const clock = new SimulatedClock("2026-02-01T00:00:00Z");
    const u = new FakeUsageSource(0.25, clock);
    expect(await u.status()).toEqual({
      available: true,
      planUsageShare: 0.25,
      checkedAt: "2026-02-01T00:00:00.000Z",
    });
    u.set(0.9);
    u.available = false;
    expect((await u.status()).planUsageShare).toBe(0.9);
    expect((await u.status()).available).toBe(false);
    expect(() => u.set(1.5)).toThrow(ForerunnerError);
    expect(() => new FakeUsageSource(-1)).toThrow(/between 0 and 1/);
    expect(new FakeUsageSource().planUsageShare).toBe(0);
  });

  it("rejects replay and record modes without their dependencies", () => {
    expect(() => new FakeProvider({ mode: "replay" })).toThrow(/RecordingStore/);
    expect(() => new FakeProvider({ mode: "record" })).toThrow(/inner provider/);
  });
});
