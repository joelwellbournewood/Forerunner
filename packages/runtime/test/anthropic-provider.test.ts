import { SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { FAST_MODE_BETA } from "../src/models/fast-mode.ts";
import {
  AnthropicMessagesProvider,
  fastModeApplies,
  MODEL_LIMIT_FAILURE_TTL_MS,
  tierFromId,
} from "../src/provider/anthropic.ts";
import { providerCapabilities } from "../src/provider/types.ts";

function sse(events: unknown[]): Response {
  const body = events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const happyEvents = [
  {
    type: "message_start",
    message: {
      id: "m1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 12,
        output_tokens: 0,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
      },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "tu_1", name: "echo", input: {} },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"text":' },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '"hi"}' },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 9 },
  },
  { type: "message_stop" },
];

describe("AnthropicMessagesProvider", () => {
  it("sends the configured default headers, such as the workspace id, on every request", async () => {
    let seen: Headers | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen = new Headers(init?.headers);
      return sse(happyEvents);
    };
    const p = new AnthropicMessagesProvider({
      apiKey: "k",
      defaultHeaders: { "anthropic-workspace-id": "wrkspc_test" },
      fetch: fetchImpl,
      maxRetries: 0,
    });
    await p.complete({
      model: "claude-haiku-5-5",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
    });
    expect(seen).not.toBeNull();
    expect((seen as unknown as Headers).get("anthropic-workspace-id")).toBe("wrkspc_test");
    expect((seen as unknown as Headers).get("x-api-key")).toBe("k");
  });

  it("maps the request (effort, caching, no temperature) and the streamed response", async () => {
    let captured: { url: string; body: Record<string, unknown>; headers: Headers } | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = {
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      };
      return sse(happyEvents);
    };
    const p = new AnthropicMessagesProvider({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 });
    const res = await p.complete({
      model: "claude-haiku-5-5",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "echo", description: "d", input_schema: { type: "object", properties: {} } }],
      max_tokens: 100,
      effort: "low",
      temperature: 0.3,
      cache: { system: true, tools: true },
    });
    expect(captured).not.toBeNull();
    const body = captured!.body;
    expect(body.stream).toBe(true);
    expect(body.temperature).toBeUndefined();
    expect(body.output_config).toEqual({ effort: "low" });
    expect((body.system as unknown[])[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect((body.tools as { cache_control?: unknown }[])[0]?.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(captured!.headers.get("x-api-key")).toBe("k");
    expect(res.content).toEqual([
      { type: "text", text: "Hello there" },
      { type: "tool_use", id: "tu_1", name: "echo", input: { text: "hi" } },
    ]);
    expect(res.stop_reason).toBe("tool_use");
    expect(res.usage).toEqual({
      input_tokens: 12,
      output_tokens: 9,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 0,
    });
  });

  it("asks thinking off only where the model accepts it at that effort, and never sends it otherwise", async () => {
    // Haiku 5.5 thinks by default (adaptive, display omitted) and its thinking tokens count
    // toward max_tokens: the real-audio run of 2026-10-26 lost most of a 400-token chat cap to
    // it. `thinking: "off"` maps to what each model accepts; a model that cannot turn thinking
    // off, or an effort above high, gets no thinking field (a 400 error otherwise).
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sse(happyEvents);
    };
    const p = new AnthropicMessagesProvider({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 });
    const ask = (model: string, over: Record<string, unknown> = {}) =>
      p.complete({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        effort: "low",
        thinking: "off",
        ...over,
      });
    await ask("claude-haiku-5-5");
    await ask("claude-haiku-5-5-20261001", { effort: "high" });
    await ask("claude-sonnet-5-5");
    await ask("claude-opus-5-5");
    await ask("claude-haiku-5-5", { effort: "xhigh" });
    await ask("claude-haiku-5-5", { thinking: undefined });
    await ask("claude-haiku-4-5");
    await ask("claude-opus-5");
    await ask("claude-opus-5", { effort: "max" });
    await ask("claude-sonnet-5");
    // Sonnet 5 thinks adaptively by default and takes `disabled` at any effort (the docs give
    // it no effort limit, unlike Haiku 5.5 and Opus 5).
    await ask("claude-sonnet-5", { effort: "max" });
    expect(bodies.map((b) => b.thinking)).toEqual([
      { type: "disabled" },
      { type: "disabled" },
      { type: "between_tools" },
      undefined,
      undefined,
      undefined,
      // Claude 4.x thinks only when asked: nothing to send.
      undefined,
      { type: "disabled" },
      undefined,
      { type: "disabled" },
      { type: "disabled" },
    ]);
  });

  it("declares no temperature, and fast mode only on an API key (ADR 0072)", () => {
    const api = new AnthropicMessagesProvider({ apiKey: "k", maxRetries: 0 });
    const sub = new AnthropicMessagesProvider({ authToken: "oat", maxRetries: 0 });
    expect(providerCapabilities(api)).toEqual({ acceptsTemperature: false, fastMode: true });
    expect(providerCapabilities(sub)).toEqual({ acceptsTemperature: false, fastMode: false });
    // A proxied copy keeps the credential and so the same flags.
    expect(api.viaProxy("http://127.0.0.1:1", {}).fastMode).toBe(true);
    expect(fastModeApplies("claude-opus-5-5", "api_key")).toBe(true);
    expect(fastModeApplies("claude-sonnet-5-5", "api_key")).toBe(false);
    expect(fastModeApplies("claude-opus-5-5", "subscription")).toBe(false);
  });

  it("sends speed fast with the beta header on an API key and an Opus id, nowhere else", async () => {
    const seen: { body: Record<string, unknown>; headers: Headers }[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return sse(happyEvents);
    };
    const req = {
      messages: [{ role: "user" as const, content: "hi" }],
      max_tokens: 3210,
      speed: "fast" as const,
    };
    const api = new AnthropicMessagesProvider({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 });
    await api.complete({ ...req, model: "claude-opus-5-5" });
    expect(seen[0]?.body.speed).toBe("fast");
    expect(seen[0]?.body.max_tokens).toBe(3210);
    expect(seen[0]?.headers.get("anthropic-beta")).toContain(FAST_MODE_BETA);
    // A non-Opus model on the same key: a standard call, never an error.
    await api.complete({ ...req, model: "claude-sonnet-5-5" });
    expect(seen[1]?.body.speed).toBeUndefined();
    expect(seen[1]?.headers.get("anthropic-beta")).toBeNull();
    // A subscription token: API only, so standard.
    const sub = new AnthropicMessagesProvider({
      authToken: "oat",
      fetch: fetchImpl,
      maxRetries: 0,
    });
    await sub.complete({ ...req, model: "claude-opus-5-5" });
    expect(seen[2]?.body.speed).toBeUndefined();
    // No speed asked: nothing sent.
    await api.complete({ ...req, speed: undefined, model: "claude-opus-5-5" });
    expect(seen[3]?.body.speed).toBeUndefined();
  });

  it("reads a model's max_tokens limit from the Models API once, and reports none when the read fails", async () => {
    const urls: string[] = [];
    let fail = false;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      if (fail) return new Response(JSON.stringify({ type: "error" }), { status: 500 });
      return new Response(
        JSON.stringify({
          type: "model",
          id: "claude-opus-5-5",
          display_name: "Opus",
          created_at: "2026-01-01T00:00:00Z",
          max_input_tokens: 200_000,
          max_tokens: 32_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const p = new AnthropicMessagesProvider({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 });
    expect(await p.maxOutputTokens("claude-opus-5-5")).toBe(32_000);
    expect(await p.maxOutputTokens("claude-opus-5-5")).toBe(32_000);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/v1/models/claude-opus-5-5");
    fail = true;
    expect(await p.maxOutputTokens("claude-sonnet-5-5")).toBeUndefined();
    expect(urls).toHaveLength(2);
  });

  it("keeps a failed limit read for a few minutes, one attempt each, whatever maxRetries says", async () => {
    const clock = new SimulatedClock("2026-10-26T10:00:00Z");
    let requests = 0;
    const fetchImpl: typeof fetch = async () => {
      requests++;
      // A subscription token the Models API rejects, say.
      return new Response(JSON.stringify({ type: "error" }), { status: 429 });
    };
    // The adapter's default retries (2) do not apply to this read.
    const p = new AnthropicMessagesProvider({ authToken: "oat", fetch: fetchImpl, clock });
    expect(await p.maxOutputTokens("claude-opus-5-5")).toBeUndefined();
    expect(requests).toBe(1);
    expect(await p.maxOutputTokens("claude-opus-5-5")).toBeUndefined();
    expect(requests).toBe(1);
    await clock.advance(MODEL_LIMIT_FAILURE_TTL_MS);
    expect(await p.maxOutputTokens("claude-opus-5-5")).toBeUndefined();
    expect(requests).toBe(2);
  });

  it("stops a limit read when the caller's signal aborts, and does not keep that as a failure", async () => {
    let requests = 0;
    const fetchImpl: typeof fetch = (_input, init) => {
      requests++;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    };
    const p = new AnthropicMessagesProvider({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 });
    const ac = new AbortController();
    const read = p.maxOutputTokens("claude-opus-5-5", { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort(new Error("run stopped"));
    expect(await read).toBeUndefined();
    const again = new AbortController();
    const second = p.maxOutputTokens("claude-opus-5-5", { signal: again.signal });
    await new Promise((r) => setTimeout(r, 10));
    expect(requests).toBe(2);
    again.abort();
    expect(await second).toBeUndefined();
  });

  it("uses a subscription token as a bearer credential when given", async () => {
    let headers: Headers | null = null;
    const fetchImpl: typeof fetch = async (_i, init) => {
      headers = new Headers(init?.headers);
      return sse(happyEvents);
    };
    const p = new AnthropicMessagesProvider({ authToken: "oat", fetch: fetchImpl, maxRetries: 0 });
    await p.complete({
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
    });
    expect(headers!.get("authorization")).toBe("Bearer oat");
    expect(headers!.get("x-api-key")).toBeNull();
  });

  it("maps HTTP errors to provider error codes", async () => {
    const mk = (status: number) =>
      new AnthropicMessagesProvider({
        apiKey: "k",
        maxRetries: 0,
        fetch: async () =>
          new Response(JSON.stringify({ error: { type: "x", message: "nope" } }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      });
    const req = {
      model: "claude-haiku-5-5",
      messages: [{ role: "user" as const, content: "hi" }],
      max_tokens: 10,
    };
    expect((await mk(401).complete(req)).stop_reason).toBe("error");
    const events401: string[] = [];
    for await (const ev of mk(401).stream(req))
      events401.push(ev.type === "error" ? ev.code : ev.type);
    expect(events401).toContain("provider_auth");
    const events429: string[] = [];
    for await (const ev of mk(429).stream(req))
      events429.push(ev.type === "error" ? ev.code : ev.type);
    expect(events429).toContain("provider_rate_limit");
  });

  it("reports the input-side usage on message_start, so a call cut off before message_end still shows its billed input tokens", async () => {
    const p = new AnthropicMessagesProvider({
      apiKey: "k",
      fetch: async () => sse(happyEvents),
      maxRetries: 0,
    });
    const events = [];
    for await (const ev of p.stream({
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
    }))
      events.push(ev);
    expect(events[0]).toEqual({
      type: "message_start",
      model: "claude-haiku-5-5",
      usage: {
        input_tokens: 12,
        output_tokens: 0,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "message_end", stop_reason: "tool_use" });
  });

  it("an abort while the stream is open ends it with `error: aborted` (the SDK exits its iterator without throwing), after the message_start that carried the input tokens", async () => {
    // A body that sends message_start and then stays open until the request's signal aborts.
    const fetchImpl: typeof fetch = async (_input, init) => {
      const first = happyEvents[0] as { type: string };
      const chunk = `event: ${first.type}\ndata: ${JSON.stringify(first)}\n\n`;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(chunk));
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const p = new AnthropicMessagesProvider({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 });
    const ac = new AbortController();
    const events = [];
    for await (const ev of p.stream({
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      signal: ac.signal,
    })) {
      events.push(ev);
      if (ev.type === "message_start") ac.abort(new Error("kill switch"));
    }
    expect(events.map((e) => e.type)).toEqual(["message_start", "error"]);
    expect(events[0]).toMatchObject({ usage: { input_tokens: 12, cache_read_input_tokens: 4 } });
    expect(events[1]).toEqual({
      type: "error",
      code: "aborted",
      message: "aborted",
      retryable: false,
    });
  });

  it("an abort after message_stop came still ends with the complete message_end and its usage", async () => {
    // The whole message is in the body, which stays open until the signal aborts: the stop lands
    // after the API's last word and before the SDK's iterator returns.
    const fetchImpl: typeof fetch = async (_input, init) => {
      const chunk = happyEvents
        .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join("");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(chunk));
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const p = new AnthropicMessagesProvider({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 });
    const ac = new AbortController();
    const events = [];
    for await (const ev of p.stream({
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      signal: ac.signal,
    })) {
      events.push(ev);
      if (ev.type === "tool_use_end") setTimeout(() => ac.abort(new Error("kill switch")), 10);
    }
    expect(events.at(-1)).toEqual({
      type: "message_end",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 12,
        output_tokens: 9,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
      },
    });
  });

  it("an abort before the response arrives is `error: aborted`, not a provider error", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      });
    const p = new AnthropicMessagesProvider({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("kill switch")), 20);
    const events = [];
    for await (const ev of p.stream({
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      signal: ac.signal,
    }))
      events.push(ev);
    expect(events).toEqual([
      { type: "error", code: "aborted", message: "aborted", retryable: false },
    ]);
  });

  it("requires a credential and classifies model ids into tiers", () => {
    expect(() => new AnthropicMessagesProvider({})).toThrow(/API key or a subscription token/);
    expect(tierFromId("claude-sonnet-5-5")).toBe("sonnet");
    expect(tierFromId("claude-fable-5-1")).toBe("fable");
    expect(tierFromId("something-else")).toBeNull();
  });
});
