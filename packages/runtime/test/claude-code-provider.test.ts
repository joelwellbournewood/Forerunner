import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import type { QueryLike } from "../src/agent/sdk.ts";
import { AnthropicMessagesProvider } from "../src/provider/anthropic.ts";
import {
  CLAUDE_CODE_TOOL_SERVER,
  ClaudeCodeProvider,
  promptFor,
  shapeOf,
} from "../src/provider/claude-code.ts";
import type { ModelRequest, ToolDefinition } from "../src/provider/types.ts";
import { validateAnthropicKey } from "../src/setup/validators.ts";

/**
 * `ClaudeCodeProvider` (U-048, ADR 0098): one model call is one Claude Code turn through the
 * Agent SDK. A fake `query` stands in for the SDK; nothing is spawned.
 */
const OAUTH = ["sk-ant-oat01-", "provider", "0".repeat(40)].join(""); // not-a-secret
type SdkMessage = Record<string, unknown>;
const ev = (event: Record<string, unknown>): SdkMessage => ({ type: "stream_event", event });

function fake(script: () => AsyncIterable<SdkMessage>) {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  const query: QueryLike = ({ prompt, options }) => {
    calls.push({ prompt, options: options ?? {} });
    return script();
  };
  return { query, calls };
}

const cwd = () => mkdtempSync(join(tmpdir(), "fr-cc-"));
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "claude-haiku-5-5",
  system: "You are the critic.",
  messages: [{ role: "user", content: "Review this." }],
  max_tokens: 2048,
  ...over,
});

describe("ClaudeCodeProvider (U-048)", () => {
  it("hands the model's tool call to the caller under its own name, and stops at the response", async () => {
    let afterStop = false;
    const { query, calls } = fake(async function* () {
      yield ev({
        type: "message_start",
        message: { model: "claude-sonnet-5-5", usage: { input_tokens: 90, output_tokens: 0 } },
      });
      yield ev({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: `mcp__${CLAUDE_CODE_TOOL_SERVER}__submit_review`,
        },
      });
      yield ev({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"verdict":' },
      });
      yield ev({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"pass"}' },
      });
      yield ev({ type: "content_block_stop", index: 0 });
      yield ev({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 12 },
      });
      yield ev({ type: "message_stop" });
      // What Claude Code would do next (deny the call, ask the model again) is never read.
      afterStop = true;
      yield ev({ type: "message_start", message: { model: "x", usage: { input_tokens: 1 } } });
    });
    const servers: { name: string; tools: ToolDefinition[] }[] = [];
    const p = new ClaudeCodeProvider({
      token: async () => OAUTH,
      cwd: cwd(),
      query,
      mcpServer: async (name, tools) => {
        servers.push({ name, tools });
        return { type: "sdk", name };
      },
    });
    const tool: ToolDefinition = {
      name: "submit_review",
      description: "Submit the verdict",
      input_schema: { type: "object", properties: { verdict: { type: "string" } } },
    };
    const res = await p.complete(req({ tools: [tool], effort: "low", thinking: "off" }));
    expect(res.stop_reason).toBe("tool_use");
    expect(res.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "submit_review", input: { verdict: "pass" } },
    ]);
    expect(res.usage).toMatchObject({ input_tokens: 90, output_tokens: 12 });
    expect(res.model).toBe("claude-sonnet-5-5");
    expect(afterStop).toBe(false);
    expect(servers).toEqual([{ name: CLAUDE_CODE_TOOL_SERVER, tools: [tool] }]);
    const o = calls[0]?.options ?? {};
    expect(o).toMatchObject({
      model: "claude-haiku-5-5",
      effort: "low",
      thinking: { type: "disabled" },
      systemPrompt: { type: "custom", prompt: "You are the critic." },
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      mcpServers: { [CLAUDE_CODE_TOOL_SERVER]: { type: "sdk", name: CLAUDE_CODE_TOOL_SERVER } },
      maxTurns: 1,
    });
    const env = o.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("2048");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0]?.prompt).toBe("Review this.");
  });

  it("quotes earlier turns, tool calls and results in the one user turn Claude Code takes", () => {
    const prompt = promptFor([
      { role: "user", content: "Pause the project." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "project_pause", input: { id: "p1" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Paused." }] },
    ]);
    expect(prompt).toContain("[user] Pause the project.");
    expect(prompt).toContain('[assistant called the tool project_pause with {"id":"p1"}]');
    expect(prompt).toContain("[tool result] Paused.");
    expect(prompt).toContain("Continue as the assistant");
  });

  it("refuses a call without a token, and says where to add one", async () => {
    const { query, calls } = fake(async function* () {});
    const p = new ClaudeCodeProvider({ token: async () => null, cwd: cwd(), query });
    const res = await p.complete(req());
    expect(res.stop_reason).toBe("error");
    expect(calls).toHaveLength(0);
    const events = [];
    for await (const e of p.stream(req())) events.push(e);
    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        code: "provider_auth",
        message: expect.stringContaining("Settings → Accounts and keys"),
      }),
    ]);
  });

  it("maps Claude Code's refusal of the token to provider_auth, without the token in the message", async () => {
    const { query } = fake(async function* () {
      yield {
        type: "assistant",
        error: "authentication_failed",
        message: { content: [{ type: "text", text: "Invalid bearer token" }] },
      };
      yield { type: "result", subtype: "success", is_error: true, result: "Invalid bearer token" };
    });
    const p = new ClaudeCodeProvider({ token: async () => OAUTH, cwd: cwd(), query });
    const events = [];
    for await (const e of p.stream(req())) events.push(e);
    expect(events).toEqual([
      expect.objectContaining({ type: "error", code: "provider_auth", retryable: false }),
    ]);
    expect(JSON.stringify(events)).not.toContain(OAUTH);
  });

  it("turns a tool's JSON Schema into the shape the SDK's tool() takes", () => {
    const shape = shapeOf({
      type: "object",
      properties: { amount: { type: "number" }, note: { type: "string" } },
      required: ["amount"],
    });
    expect(Object.keys(shape).sort()).toEqual(["amount", "note"]);
    expect(shapeOf({ type: "string" })).toEqual({});
  });
});

describe("a subscription token never reaches the Messages API from Forerunner (U-048)", () => {
  it("the Messages adapter refuses one", () => {
    expect(() => new AnthropicMessagesProvider({ authToken: OAUTH })).toThrow(/Claude Code/);
    expect(() => new AnthropicMessagesProvider({ apiKey: OAUTH })).toThrow(/Claude Code/);
  });

  it("the setup check takes its format and sends nothing", async () => {
    let requests = 0;
    const r = await validateAnthropicKey({
      key: OAUTH,
      apiBase: "http://x",
      fetchImpl: (async () => {
        requests++;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(requests).toBe(0);
    expect(r).toMatchObject({ ok: true, details: { kind: "subscription", verified: "format" } });
  });
});

/**
 * U-078 (ADR 0100): an API key never runs through Claude Code, and both ways Forerunner calls
 * Claude report "this credential's limit is reached" as one code, `provider_usage_limit`, with
 * the reset time when the provider gives one.
 */
describe("only the subscription in Claude Code, and usage limits as one code (U-078)", () => {
  const KEY = ["sk-ant-", "api03-", "z".repeat(30)].join(""); // not-a-secret

  it("ClaudeCodeProvider refuses anything but the subscription token, and starts nothing", async () => {
    const { query, calls } = fake(async function* () {});
    const p = new ClaudeCodeProvider({ token: async () => KEY, cwd: cwd(), query });
    const events = [];
    for await (const e of p.stream(req())) events.push(e);
    expect(calls).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        code: "provider_auth",
        message:
          "Only a Claude subscription token runs through Claude Code; an API key goes straight to the API.",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it("Claude Code's usage limit is provider_usage_limit with the reset it reported", async () => {
    const resetsAt = Date.parse("2026-11-01T15:00:00Z") / 1000;
    const { query } = fake(async function* () {
      yield { type: "system", subtype: "init", session_id: "s" };
      yield {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
      };
      yield {
        type: "assistant",
        error: "rate_limit",
        message: { content: [{ type: "text", text: "You've hit your limit · resets 3pm" }] },
      };
      yield { type: "result", subtype: "success", is_error: true, result: "limit" };
    });
    const p = new ClaudeCodeProvider({ token: async () => OAUTH, cwd: cwd(), query });
    const events = [];
    for await (const e of p.stream(req())) events.push(e);
    expect(events).toEqual([
      {
        type: "error",
        code: "provider_usage_limit",
        message:
          "The Claude subscription's usage limit is reached: You've hit your limit · resets 3pm",
        retryable: false,
        resetAt: "2026-11-01T15:00:00.000Z",
      },
    ]);
  });

  it("a rate_limit without the plan's limit stays a throttle; a billing_error is a usage limit", async () => {
    const run = async (error: string, text: string) => {
      const { query } = fake(async function* () {
        yield { type: "assistant", error, message: { content: [{ type: "text", text }] } };
        yield { type: "result", subtype: "success", is_error: true, result: text };
      });
      const p = new ClaudeCodeProvider({ token: async () => OAUTH, cwd: cwd(), query });
      const events = [];
      for await (const e of p.stream(req())) events.push(e);
      return events[0] as { code: string; resetAt?: string };
    };
    expect((await run("rate_limit", "Request rejected (429) · try again")).code).toBe(
      "provider_rate_limit",
    );
    const billing = await run("billing_error", "Credit balance is too low");
    expect(billing.code).toBe("provider_usage_limit");
    expect(billing.resetAt).toBeUndefined();
  });

  it("the Messages API's credit balance, spend limit and spend cap are provider_usage_limit", async () => {
    const answer = (status: number, error: Record<string, unknown>) =>
      (async () =>
        new Response(JSON.stringify({ type: "error", error }), {
          status,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
    const call = async (fetchImpl: typeof fetch) => {
      const p = new AnthropicMessagesProvider({ apiKey: KEY, fetch: fetchImpl, maxRetries: 0 });
      const events = [];
      for await (const e of p.stream(req())) events.push(e);
      return events[0] as { type: string; code: string; resetAt?: string; message: string };
    };
    const credit = await call(
      answer(400, {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      }),
    );
    expect(credit).toMatchObject({ type: "error", code: "provider_usage_limit" });
    expect(credit.resetAt).toBeUndefined();
    expect(credit.message).not.toContain(KEY);
    const own = await call(
      answer(400, {
        type: "invalid_request_error",
        message:
          "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
      }),
    );
    expect(own).toMatchObject({
      code: "provider_usage_limit",
      resetAt: "2026-12-01T00:00:00.000Z",
    });
    const cap = await call(
      answer(429, {
        type: "rate_limit_error",
        message:
          "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-12-01 at 00:00 UTC.",
        details: { error_code: "enforced_spend_limit_reached" },
      }),
    );
    expect(cap).toMatchObject({
      code: "provider_usage_limit",
      resetAt: "2026-12-01T00:00:00.000Z",
    });
    // A per-minute rate limit stays a throttle, which the SDK retries.
    const minute = await call(
      answer(429, {
        type: "rate_limit_error",
        message: "Number of request tokens has exceeded your per-minute rate limit",
      }),
    );
    expect(minute.code).toBe("provider_rate_limit");
  });
});
