import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { CostLedgerRow } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryLike } from "../src/agent/sdk.ts";
import { BillingOrderView, EventView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";

/**
 * U-078 (ADR 0100): the person chooses which Claude credential is used first, every call follows
 * it, and when one cannot serve the next one does. Here the daemon is composed as `fr daemon`
 * composes it, with both credentials in the vault: the Messages API is a `fetchImpl` stand-in,
 * Claude Code an Agent SDK `query` stand-in. The person sets the order through the route the
 * Settings section posts to and sends chat messages; the test reads what reached which
 * provider, the ledger rows each call left, the session log and the Settings view, then
 * restarts the daemon on the same home and store.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const KEY = ["sk-ant-api03-", "orderkey", "3".repeat(40)].join(""); // not-a-secret
const OAUTH = ["sk-ant-oat01-", "ordertoken", "4".repeat(40)].join(""); // not-a-secret

type SdkMessage = Record<string, unknown>;
const ev = (event: Record<string, unknown>): SdkMessage => ({ type: "stream_event", event });

/** One model response as Claude Code streams it with `includePartialMessages`. */
async function* claudeCodeReply(text: string): AsyncIterable<SdkMessage> {
  yield { type: "system", subtype: "init", session_id: "cc-1" };
  yield ev({
    type: "message_start",
    message: { model: "claude-haiku-5-5", usage: { input_tokens: 20_000, output_tokens: 0 } },
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

/** Claude Code when the subscription's limit is reached (Agent SDK 0.3.304's messages). */
async function* claudeCodeLimit(resetIso: string): AsyncIterable<SdkMessage> {
  yield { type: "system", subtype: "init", session_id: "cc-limit" };
  yield {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      resetsAt: Date.parse(resetIso) / 1000,
      rateLimitType: "five_hour",
    },
  };
  yield {
    type: "assistant",
    error: "rate_limit",
    message: { content: [{ type: "text", text: "You've hit your limit · resets 11am" }] },
  };
  yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit" };
}

function sse(text: string): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 30, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("which Claude credential is used first (U-078)", () => {
  const clock = new SimulatedClock("2026-10-31T09:00:00Z");
  const vault = new MemoryVault();
  const home = mkdtempSync(join(tmpdir(), "fr-billing-order-"));
  const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  /** Every request to the Messages API, with the key it carried. */
  const apiCalls: string[] = [];
  /** Every Claude Code turn, with its environment. */
  const sdkCalls: { prompt: string; env: Record<string, string | undefined> }[] = [];
  let claudeCode: "reply" | "limit" = "reply";
  const resetAt = "2026-10-31T11:00:00.000Z";

  const fetchImpl: typeof fetch = async (input, init) => {
    const r = input instanceof Request ? input : null;
    const url = new URL(String(r ? r.url : input));
    const headers = new Headers(init?.headers ?? r?.headers);
    if (url.pathname === "/v1/messages") {
      apiCalls.push(headers.get("x-api-key") ?? "");
      return sse("From the API.");
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const sdkQuery: QueryLike = ({ prompt, options }) => {
    sdkCalls.push({ prompt, env: (options?.env ?? {}) as Record<string, string | undefined> });
    return claudeCode === "limit" ? claudeCodeLimit(resetAt) : claudeCodeReply("From Claude Code.");
  };

  async function start(): Promise<void> {
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl,
      vault,
      fetchImpl,
      sdkQuery,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
    });
    ({ app, token } = createDaemonApp(rt));
  }
  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
  const view = async () =>
    BillingOrderView.parse(await (await call("/settings/billing-order")).json());
  const setOrder = async (order: string[]) => {
    const r = await call("/settings/billing-order", {
      method: "POST",
      body: JSON.stringify({ order }),
    });
    expect(r.status).toBe(200);
    return BillingOrderView.parse(await r.json());
  };
  const chat = async (text: string) => {
    const r = await call("/chat", {
      method: "POST",
      body: JSON.stringify({ humanId: rt.human.id, agentId: rt.agent.id, text }),
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { reply: string }).reply;
  };
  /** The ledger rows written since `before` rows existed, oldest first. */
  const ledgerSince = async (before: number): Promise<CostLedgerRow[]> => {
    const rows = await rt.store.costLedger.list({ human_id: rt.human.id } as never, {
      limit: 1000,
    });
    return [...rows].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)).slice(before);
  };
  const ledgerCount = async () =>
    (await rt.store.costLedger.list({ human_id: rt.human.id } as never, { limit: 1000 })).length;
  const sourceOf = async (kind: string) =>
    (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === kind,
    );

  beforeAll(async () => {
    await vault.set(SECRET_NAMES.anthropic, KEY);
    await vault.set(SECRET_NAMES.anthropicOauth, OAUTH);
    await start();
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("without a chosen order, chat uses the API key first as before (ADR 0098)", async () => {
    const v = await view();
    expect(v.chosen).toBe(false);
    // The rows in the order task runs use by default: the subscription first.
    expect(v.sources.map((s) => [s.kind, s.via, s.usable])).toEqual([
      ["subscription", "claude_code", true],
      ["api_key", "api", true],
    ]);
    const before = await ledgerCount();
    expect(await chat("hello")).toBe("From the API.");
    expect(apiCalls).toEqual([KEY]);
    expect(sdkCalls).toHaveLength(0);
    const rows = await ledgerSince(before);
    expect(rows.map((r) => r.kind)).toEqual(["api"]);
    expect(rows[0]?.billing_source_id).toBe((await sourceOf("api_key"))?.id);
  });

  it("with the API key first, a chat turn reaches the Messages API and its row is kind api", async () => {
    const v = await setOrder(["api_key", "subscription"]);
    expect(v.chosen).toBe(true);
    expect(v.order).toEqual(["api_key", "subscription"]);
    expect(v.sources.map((s) => s.kind)).toEqual(["api_key", "subscription"]);
    // Recorded in Changes, with the order in words.
    const changes = await rt.store.changeLog.list({ human_id: rt.human.id } as never, {
      limit: 50,
    });
    expect(changes.map((c) => c.sentence)).toContain(
      "Set which Claude credential is used first from not chosen (the defaults) to the API key, then the Claude subscription: every model call uses them in this order, and when one cannot be used the next one is. Undo.",
    );
    const apiBefore = apiCalls.length;
    const before = await ledgerCount();
    expect(await chat("what is next?")).toBe("From the API.");
    expect(apiCalls.slice(apiBefore)).toEqual([KEY]);
    expect(sdkCalls).toHaveLength(0);
    const rows = await ledgerSince(before);
    expect(rows.map((r) => [r.kind, r.billing_source_id])).toEqual([
      ["api", (await sourceOf("api_key"))?.id],
    ]);
  });

  it("with the subscription first, the turn reaches Claude Code with the token only and its row is kind subscription", async () => {
    const v = await setOrder(["subscription", "api_key"]);
    expect(v.sources.map((s) => s.kind)).toEqual(["subscription", "api_key"]);
    const apiBefore = apiCalls.length;
    const before = await ledgerCount();
    expect(await chat("and now?")).toBe("From Claude Code.");
    expect(apiCalls.length).toBe(apiBefore);
    expect(sdkCalls).toHaveLength(1);
    expect(sdkCalls[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(sdkCalls[0]?.env.ANTHROPIC_API_KEY).toBeUndefined();
    const rows = await ledgerSince(before);
    expect(rows.map((r) => [r.kind, r.billing_source_id])).toEqual([
      ["subscription", (await sourceOf("subscription"))?.id],
    ]);
    // The plan's share moved with the call, so the allowance shown in Settings is right.
    expect(rows[0]?.plan_usage_share).toBeGreaterThan(0);
    const sub = (await view()).sources.find((s) => s.kind === "subscription");
    expect(sub?.planShare).toBeGreaterThan(0);
    expect(sub?.monthSpent.usdMicro).toBeGreaterThan(0);
  });

  it("a usage limit in Claude Code falls back to the API key within the call; the next call skips the resting subscription", async () => {
    claudeCode = "limit";
    const apiBefore = apiCalls.length;
    const before = await ledgerCount();
    expect(await chat("one more thing")).toBe("From the API.");
    expect(sdkCalls).toHaveLength(2);
    expect(apiCalls.slice(apiBefore)).toEqual([KEY]);
    const rows = await ledgerSince(before);
    expect(rows.map((r) => r.kind)).toEqual(["api"]);
    // The session log says it in a plain sentence.
    const sessionId = rows[0]?.session_id as string;
    const events = EventView.array().parse(
      await (await call(`/sessions/${sessionId}/events`)).json(),
    );
    const fallback = events.filter((e) => e.type === "billing.fallback");
    expect(fallback.map((e) => [e.text, e.level])).toEqual([
      [
        "The Claude subscription reached its usage limit and rests until 2026-10-31 11:00 UTC; the API key answered instead.",
        "warning",
      ],
    ]);
    // Settings says why the subscription cannot be used now, and until when.
    const sub = (await view()).sources.find((s) => s.kind === "subscription");
    expect(sub).toMatchObject({ usable: false, blocked: "resting", restingUntil: resetAt });

    // The next call does not try the subscription while it rests, even if it would answer.
    claudeCode = "reply";
    expect(await chat("thanks")).toBe("From the API.");
    expect(sdkCalls).toHaveLength(2);
    expect(apiCalls.length).toBe(apiBefore + 2);
  });

  it("the order and the rest survive a restart; after the reset the subscription serves again", async () => {
    await rt.close();
    await start();
    const v = await view();
    expect(v.chosen).toBe(true);
    expect(v.order).toEqual(["subscription", "api_key"]);
    expect(v.sources.find((s) => s.kind === "subscription")).toMatchObject({ blocked: "resting" });
    const sdkBefore = sdkCalls.length;
    expect(await chat("after the restart")).toBe("From the API.");
    expect(sdkCalls.length).toBe(sdkBefore);

    // Past the reset the person's first choice serves again.
    clock.advance(2 * 60 * 60 * 1000 + 1000);
    expect((await view()).sources.find((s) => s.kind === "subscription")?.usable).toBe(true);
    expect(await chat("later")).toBe("From Claude Code.");
    expect(sdkCalls.length).toBe(sdkBefore + 1);
  });

  it("refuses an order that names a credential twice or an unknown one", async () => {
    for (const order of [[], ["api_key", "api_key"], ["fake"], ["openai"]]) {
      const r = await call("/settings/billing-order", {
        method: "POST",
        body: JSON.stringify({ order }),
      });
      expect(r.status, JSON.stringify(order)).toBe(400);
      expect(((await r.json()) as { message: string }).message).toContain("each once");
    }
    expect((await view()).order).toEqual(["subscription", "api_key"]);
  });
});
