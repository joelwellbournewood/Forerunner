import { describe, expect, it } from "vitest";
import { AnthropicMessagesProvider, tierFromId } from "../src/provider/anthropic.ts";

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

  it("requires a credential and classifies model ids into tiers", () => {
    expect(() => new AnthropicMessagesProvider({})).toThrow(/API key or a subscription token/);
    expect(tierFromId("claude-sonnet-5-5")).toBe("sonnet");
    expect(tierFromId("claude-fable-5-1")).toBe("fable");
    expect(tierFromId("something-else")).toBeNull();
  });
});
