import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QueryLike } from "../src/agent/sdk.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";

/**
 * U-048: an install whose only Claude credential is a subscription token from
 * `claude setup-token`. Anthropic documents that token for Claude Code only (it goes into the
 * unmodified Claude Code binary as `CLAUDE_CODE_OAUTH_TOKEN`); 1.0.4 sent it from Forerunner's
 * own Messages adapter as a bearer token, which the API refuses without the beta header Claude
 * Code adds (and which is not the documented use). Here the person sends a chat message on such
 * an install: the reply comes from a call through the Agent SDK with the token in Claude Code's
 * environment, and nothing Forerunner itself sends carries the token or reaches the Messages API.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixture, built by concatenation so no scanner sees a token.
const OAUTH = ["sk-ant-oat01-", "subscriptiononly", "0".repeat(40)].join(""); // not-a-secret

type SdkMessage = Record<string, unknown>;
const ev = (event: Record<string, unknown>): SdkMessage => ({ type: "stream_event", event });

/** One model response as Claude Code streams it with `includePartialMessages`. */
async function* reply(text: string): AsyncIterable<SdkMessage> {
  yield { type: "system", subtype: "init", session_id: "cc-1" };
  yield ev({
    type: "message_start",
    message: { model: "claude-haiku-5-5", usage: { input_tokens: 40, output_tokens: 0 } },
  });
  yield ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  yield ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  yield ev({ type: "content_block_stop", index: 0 });
  yield ev({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 7 },
  });
  yield ev({ type: "message_stop" });
  yield { type: "result", subtype: "success", is_error: false, result: text };
}

describe("a subscription-only install (U-048)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  const vault = new MemoryVault();
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  const sent: { url: string; headers: Headers }[] = [];
  const sdkQuery: QueryLike = ({ prompt, options }) => {
    calls.push({ prompt, options: options ?? {} });
    return reply("Hello from Claude Code.");
  };
  const clock = new SimulatedClock("2026-10-31T09:00:00Z");
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });

  beforeAll(async () => {
    // Every request Forerunner itself makes in this process, answered as the API answers a
    // subscription token sent without Claude Code's header.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const r = input instanceof Request ? input : null;
      sent.push({
        url: String(r ? r.url : input),
        headers: new Headers(init?.headers ?? r?.headers),
      });
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "authentication_error",
            message: "OAuth authentication is currently not supported.",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });
    await vault.set(SECRET_NAMES.anthropicOauth, OAUTH);
    const home = mkdtempSync(join(tmpdir(), "fr-subonly-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault,
      sdkQuery,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    vi.restoreAllMocks();
  });

  it("answers a chat message through Claude Code with the token, and sends the token to no API itself", async () => {
    const r = await req("/chat", {
      method: "POST",
      body: JSON.stringify({ humanId: rt.human.id, agentId: rt.agent.id, text: "hello" }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { reply: string }).reply).toBe("Hello from Claude Code.");

    // One Claude Code turn: the token in its environment and nowhere else, no API key or
    // gateway token beside it, no Claude Code tool, nothing it may run, no settings read.
    expect(calls).toHaveLength(1);
    const options = calls[0]?.options ?? {};
    const env = options.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(options).toMatchObject({
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      includePartialMessages: true,
      systemPrompt: { type: "custom" },
    });
    expect(calls[0]?.prompt).toContain("hello");
    expect(JSON.stringify(options.systemPrompt)).not.toContain(OAUTH);

    // Forerunner's own requests: none to the Messages API, none with the token in a header.
    const leaks = sent.filter(
      (s) =>
        s.url.includes("anthropic.com") ||
        [...s.headers.values()].some((v) => v.includes(OAUTH) || v.includes("oauth-")),
    );
    expect(leaks).toEqual([]);
  });
});
