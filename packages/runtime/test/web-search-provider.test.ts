import { SimulatedClock } from "@forerunner/platform";
import {
  FakeProvider,
  messagesApiStandIn,
  type ScriptedReply,
  standInFetch,
  textReply,
  type WebSearchStandInOptions,
} from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { AnthropicMessagesProvider, webSearchRefusal } from "../src/provider/anthropic.ts";
import {
  type ChatMessage,
  collectStream,
  type ModelRequest,
  pendingServerToolUses,
  WEB_SEARCH_LISTS_CODE,
  WEB_SEARCH_OFF_CODE,
} from "../src/provider/types.ts";

/**
 * Anthropic's web search on the API key ('web-search', the owner's decision of 2026-11-02),
 * through the app's own adapter and the Messages API stand-in, which checks every server block
 * that comes back byte for byte and answers a changed one, a pending search without its tool or
 * a follow-up with more than tool results with the API's 400. Before, the adapter sent only the
 * app's tools, dropped every server block when it sent the history back and read `pause_turn` as
 * the end of the turn.
 */
// Credential-shaped fixture, built by concatenation so no scanner sees a token.
const KEY = ["sk-ant-api03-", "search-ok-", "4".repeat(40)].join(""); // not-a-secret

const HITS = [
  { url: "https://alpha.example.com/free", title: "Alpha Pages free tier", pageAge: "2026-10-01" },
  { url: "https://beta.example.com/plans", title: "Beta Static plans" },
];

function world(replies: ScriptedReply[], search: WebSearchStandInOptions = {}) {
  const clock = new SimulatedClock("2026-11-08T09:00:00Z");
  const model = new FakeProvider({ replies, latency: "none", clock });
  const standIn = messagesApiStandIn({ model, clock, search });
  const adapter = new AnthropicMessagesProvider({
    apiKey: KEY,
    fetch: standInFetch(standIn),
    maxRetries: 0,
    clock,
  });
  const ask = (req: Partial<ModelRequest> & { messages: ChatMessage[] }) =>
    collectStream(
      adapter.stream({
        model: "claude-sonnet-5-5",
        max_tokens: 1000,
        system: "You research.",
        tools: [
          { name: "web_fetch", description: "read a page", input_schema: { type: "object" } },
        ],
        ...req,
      }),
      () => 0,
      () => clock.monotonic(),
    );
  return { model, standIn, adapter, ask };
}

const brief: ChatMessage = { role: "user", content: "Compare the free tiers of two hosts." };

describe("web search through the Anthropic adapter ('web-search')", () => {
  it("sends the server tool with max_uses and the block list, and sends its blocks back byte for byte", async () => {
    const w = world([
      {
        reply: {
          text: "I'll search first.",
          searches: [{ query: "static site host free tier", results: HITS }],
          toolCalls: [{ name: "web_fetch", input: { url: HITS[0]?.url } }],
        },
      },
      textReply("Alpha gives 100 GB."),
    ]);
    expect(w.adapter.serverWebSearch).toBe(true);
    const first = await w.ask({
      messages: [brief],
      webSearch: { maxUses: 3, blockedDomains: ["example.org"] },
      cache: { system: true, tools: true, messages: true },
    });
    // The request offered the server tool, after the app's own tool.
    expect(w.standIn.requests[0]?.webSearch).toEqual({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3,
      blocked_domains: ["example.org"],
    });
    expect(first.stop_reason).toBe("tool_use");
    // The app reads the search and its results' plain fields; the sealed part is only in `raw`.
    expect(first.content.map((b) => b.type)).toEqual([
      "text",
      "server_tool_use",
      "server_tool_result",
      "tool_use",
    ]);
    expect(first.content[2]).toMatchObject({
      type: "server_tool_result",
      name: "web_search",
      results: [
        { url: HITS[0]?.url, title: "Alpha Pages free tier", pageAge: "2026-10-01" },
        { url: HITS[1]?.url, title: "Beta Static plans" },
      ],
    });
    expect(JSON.stringify(first.content)).not.toContain("encrypted_content");
    expect(JSON.stringify(first.raw)).toContain("encrypted_content");
    expect(first.usage.server_tool_use).toEqual({ web_search_requests: 1 });

    // The next request sends the turn back as it came, with the page's text: no 400.
    const toolUse = first.content.find((b) => b.type === "tool_use");
    const second = await w.ask({
      messages: [
        brief,
        { role: "assistant", content: first.content, ...(first.raw ? { raw: first.raw } : {}) },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse?.type === "tool_use" ? toolUse.id : "",
              content: "100 GB",
            },
          ],
        },
      ],
      webSearch: { maxUses: 2, blockedDomains: ["example.org"] },
      cache: { system: true, tools: true, messages: true },
    });
    expect(w.standIn.refusals).toEqual([]);
    expect(second.stop_reason).toBe("end_turn");
    expect(w.standIn.requests[1]?.status).toBe(200);
    expect(w.standIn.requests[1]?.serverBlocksBack).toBe(2);
    // The model behind the API saw its own search and its results in the history.
    const seen = w.model.calls[1]?.request.messages[1]?.content;
    expect(Array.isArray(seen) && seen.map((b) => b.type)).toEqual([
      "text",
      "server_tool_use",
      "server_tool_result",
      "tool_use",
    ]);
  });

  it("a search result changed on its way back is refused by the API, as the stand-in checks", async () => {
    const w = world([
      { reply: { searches: [{ query: "hosts", results: HITS }], text: "Found two." } },
      textReply("x"),
    ]);
    const first = await w.ask({ messages: [brief], webSearch: { maxUses: 1 } });
    const raw = structuredClone(first.raw ?? []);
    const result = raw.find((b) => b.type === "web_search_tool_result") as {
      content: { encrypted_content: string }[];
    };
    const r0 = result.content[0];
    if (r0) r0.encrypted_content = `${r0.encrypted_content}x`;
    const second = await w.ask({
      messages: [
        brief,
        { role: "assistant", content: first.content, raw },
        { role: "user", content: "Go on." },
      ],
      webSearch: { maxUses: 1 },
    });
    expect(second.stop_reason).toBe("error");
    expect(w.standIn.refusals[0]).toContain("must be passed back exactly as received");
  });

  it("a mixed step: the deferred search runs at the start of the next request, which holds the tool results only", async () => {
    const w = world(
      [
        {
          reply: {
            searches: [{ id: "srvtoolu_mixed_1", query: "beta static plans", pending: true }],
            toolCalls: [{ name: "web_fetch", input: { url: HITS[0]?.url } }],
          },
        },
        textReply("Both read."),
      ],
      { results: () => [HITS[1] as (typeof HITS)[number]] },
    );
    const first = await w.ask({ messages: [brief], webSearch: { maxUses: 4 } });
    expect(first.stop_reason).toBe("tool_use");
    const turn: ChatMessage = {
      role: "assistant",
      content: first.content,
      ...(first.raw ? { raw: first.raw } : {}),
    };
    expect(pendingServerToolUses([turn])).toEqual(["srvtoolu_mixed_1"]);
    // Not yet run, not yet billed.
    expect(first.usage.server_tool_use).toBeUndefined();
    const toolUse = first.content.find((b) => b.type === "tool_use");
    const results: ChatMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse?.type === "tool_use" ? toolUse.id : "",
          content: "page",
        },
      ],
    };
    const second = await w.ask({ messages: [brief, turn, results], webSearch: { maxUses: 4 } });
    expect(w.standIn.refusals).toEqual([]);
    // The API ran the deferred search first: its result starts the reply, billed once.
    expect(second.content[0]).toMatchObject({
      type: "server_tool_result",
      tool_use_id: "srvtoolu_mixed_1",
      results: [{ url: HITS[1]?.url }],
    });
    expect(second.usage.server_tool_use).toEqual({ web_search_requests: 1 });
    expect(
      pendingServerToolUses([turn, results, { role: "assistant", content: second.content }]),
    ).toEqual([]);

    // Without the search tool, or with text after the tool results, the API refuses.
    const w2 = world([
      {
        reply: {
          searches: [{ query: "q", pending: true }],
          toolCalls: [{ name: "web_fetch", input: { url: HITS[0]?.url } }],
        },
      },
    ]);
    const f2 = await w2.ask({ messages: [brief], webSearch: { maxUses: 4 } });
    const t2 = f2.content.find((b) => b.type === "tool_use");
    const turn2: ChatMessage = {
      role: "assistant",
      content: f2.content,
      ...(f2.raw ? { raw: f2.raw } : {}),
    };
    const withText = await w2.ask({
      messages: [
        brief,
        turn2,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: t2?.type === "tool_use" ? t2.id : "",
              content: "page",
            },
            { type: "text", text: "About a fifth of this task's budget is left." },
          ],
        },
      ],
      webSearch: { maxUses: 4 },
    });
    expect(withText.stop_reason).toBe("error");
    const noTool = await w2.ask({
      messages: [
        brief,
        turn2,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: t2?.type === "tool_use" ? t2.id : "",
              content: "page",
            },
          ],
        },
      ],
    });
    expect(noTool.stop_reason).toBe("error");
    expect(w2.standIn.refusals).toEqual([
      expect.stringContaining("was found without a corresponding `web_search_tool_result` block"),
      expect.stringContaining("but no `web_search` tool was provided"),
    ]);
  });

  it("a paused turn (pause_turn) is read as paused and continues when sent back unchanged, cache marks kept off it", async () => {
    const w = world([
      {
        reply: {
          text: "Searching.",
          searches: [{ query: "hosts", results: HITS }],
          stopReason: "pause_turn",
        },
      },
      textReply("Done comparing."),
    ]);
    const first = await w.ask({
      messages: [brief],
      webSearch: { maxUses: 5 },
      cache: { system: true, tools: true, messages: true },
    });
    expect(first.stop_reason).toBe("pause_turn");
    expect(first.raw?.length).toBe(3);
    const second = await w.ask({
      messages: [
        brief,
        { role: "assistant", content: first.content, ...(first.raw ? { raw: first.raw } : {}) },
      ],
      webSearch: { maxUses: 4 },
      cache: { system: true, tools: true, messages: true },
    });
    expect(w.standIn.refusals).toEqual([]);
    expect(second.stop_reason).toBe("end_turn");
    expect(second.content).toEqual([{ type: "text", text: "Done comparing." }]);
  });

  it("an account with web search off and a refused site list are told apart from any other 400", async () => {
    const off = world([textReply("x")], { enabled: false });
    const r1 = await off.ask({ messages: [brief], webSearch: { maxUses: 2 } });
    expect(r1.error?.code).toBe(WEB_SEARCH_OFF_CODE);
    // The same account without the tool is served.
    const r1b = await off.ask({ messages: [brief] });
    expect(r1b.stop_reason).toBe("end_turn");

    const wild = world([textReply("x")]);
    const r2 = await wild.ask({
      messages: [brief],
      webSearch: { maxUses: 2, blockedDomains: ["*.example.org"] },
    });
    expect(r2.error?.code).toBe(WEB_SEARCH_LISTS_CODE);
    expect(wild.standIn.refusals[0]).toContain("wildcards are not allowed in the domain");

    const org = world([textReply("x")], { orgAllowedDomains: ["mozilla.org"] });
    const r3 = await org.ask({
      messages: [brief],
      webSearch: { maxUses: 2, allowedDomains: ["developer.mozilla.org", "example.com"] },
    });
    expect(r3.error?.code).toBe(WEB_SEARCH_LISTS_CODE);
    expect(org.standIn.refusals[0]).toContain("example.com");

    // A 400 about something else stays a provider error; a request without the tool is never
    // read as a search refusal.
    expect(webSearchRefusal("max_tokens: must be at most 64000")).toBeNull();
    expect(webSearchRefusal("Web search is not enabled for this organization.")).toBe("off");
    expect(webSearchRefusal("web_search.blocked_domains: invalid domain")).toBe("lists");
  });

  it("a gateway's bearer token runs no web search: the tool is not sent", async () => {
    const clock = new SimulatedClock("2026-11-08T09:00:00Z");
    const standIn = messagesApiStandIn({
      model: new FakeProvider({ replies: [textReply("x")] }),
      clock,
    });
    const gateway = new AnthropicMessagesProvider({
      authToken: "gateway-bearer-token-not-a-secret",
      fetch: standInFetch(standIn),
      maxRetries: 0,
      clock,
    });
    expect(gateway.serverWebSearch).toBe(false);
    await collectStream(
      gateway.stream({
        model: "claude-sonnet-5-5",
        max_tokens: 10,
        messages: [brief],
        webSearch: { maxUses: 2 },
      }),
      () => 0,
      () => 0,
    );
    expect(standIn.requests[0]?.webSearch).toBeUndefined();
  });
});
