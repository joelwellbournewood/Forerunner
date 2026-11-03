import { SimulatedClock } from "@forerunner/platform";
import {
  FakeProvider,
  keyIdOf,
  keyRule,
  messagesApiStandIn,
  standInFetch,
  textReply,
  toolReply,
} from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { AnthropicMessagesProvider } from "../src/provider/anthropic.ts";
import { collectStream } from "../src/provider/types.ts";

/**
 * The Messages API stand-in (testenv/src/provider/messages-api.ts, U-078) answers in the forms
 * the app's own adapter reads: a refused key is `provider_auth`, a key at its spend cap or spend
 * limit is `provider_usage_limit` with the reset the message names (ADR 0100 point 6), any other
 * key gets the model behind it, text and tool calls. Its log names keys by id, never by text.
 */
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const OK = ["sk-ant-api03-", "standin-ok-", "1".repeat(40)].join(""); // not-a-secret
const REFUSED = ["sk-ant-api03-", "standin-refused-", "2".repeat(40)].join(""); // not-a-secret
const LIMITED = ["sk-ant-api03-", "standin-limited-", "3".repeat(40)].join(""); // not-a-secret

function adapter(key: string, fetchImpl: typeof fetch, clock: SimulatedClock) {
  return new AnthropicMessagesProvider({ apiKey: key, fetch: fetchImpl, maxRetries: 0, clock });
}

const ask = (p: AnthropicMessagesProvider, clock: SimulatedClock) =>
  collectStream(
    p.stream({
      model: "claude-sonnet-5-5",
      max_tokens: 100,
      system: "You are a test.",
      messages: [{ role: "user", content: "Say hi." }],
      tools: [{ name: "write_file", description: "write", input_schema: { type: "object" } }],
    }),
    () => 0,
    () => clock.monotonic(),
  );

describe("the Messages API stand-in (U-078)", () => {
  it("serves text and tool calls, refuses one key and limits another until its reset", async () => {
    const clock = new SimulatedClock("2026-11-03T15:30:20Z");
    const model = new FakeProvider({
      replies: [toolReply("write_file", { path: "a.txt", content: "hi" }), textReply("Done.")],
    });
    const standIn = messagesApiStandIn({
      model,
      clock,
      answerFor: keyRule({ refuse: ["refused"], limit: ["limited"], limitMs: 10 * 60_000 }),
    });
    const f = standInFetch(standIn);

    const tool = await ask(adapter(OK, f, clock), clock);
    expect(tool.stop_reason).toBe("tool_use");
    expect(tool.content).toContainEqual({
      type: "tool_use",
      id: expect.any(String),
      name: "write_file",
      input: { path: "a.txt", content: "hi" },
    });
    const text = await ask(adapter(OK, f, clock), clock);
    expect(text.content).toEqual([{ type: "text", text: "Done." }]);

    const refused = await ask(adapter(REFUSED, f, clock), clock);
    expect(refused.stop_reason).toBe("error");
    expect(refused.error?.code).toBe("provider_auth");

    const limited = await ask(adapter(LIMITED, f, clock), clock);
    expect(limited.error?.code).toBe("provider_usage_limit");
    // "You will regain access on 2026-11-03 at 15:41 UTC": ten minutes from the first call, on a
    // whole minute.
    expect(limited.error?.resetAt).toBe("2026-11-03T15:41:00.000Z");

    // After the reset the key is served again.
    clock.advance(11 * 60_000);
    const later = await ask(adapter(LIMITED, f, clock), clock);
    expect(later.stop_reason).not.toBe("error");

    // The log names each key by id only: no part of a key is in it.
    const log = JSON.stringify(standIn.requests);
    for (const k of [OK, REFUSED, LIMITED]) expect(log).not.toContain(k.slice(13, 30));
    expect(standIn.requests.map((r) => [r.keyId, r.status, r.answer])).toEqual([
      [keyIdOf(OK), 200, "ok"],
      [keyIdOf(OK), 200, "ok"],
      [keyIdOf(REFUSED), 401, "refused"],
      [keyIdOf(LIMITED), 429, "limit"],
      [keyIdOf(LIMITED), 200, "ok"],
    ]);
  });

  it("the spend limit the person set (a 400) reads as the same usage limit", async () => {
    const clock = new SimulatedClock("2026-11-03T15:30:00Z");
    const standIn = messagesApiStandIn({
      model: new FakeProvider({ replies: [textReply("x")] }),
      clock,
      answerFor: keyRule({ limit: ["limited"], limitMs: 5 * 60_000, form: "400" }),
    });
    const limited = await ask(adapter(LIMITED, standInFetch(standIn), clock), clock);
    expect(limited.error?.code).toBe("provider_usage_limit");
    expect(limited.error?.resetAt).toBe("2026-11-03T15:35:00.000Z");
    expect(standIn.requests[0]?.status).toBe(400);
  });
});
