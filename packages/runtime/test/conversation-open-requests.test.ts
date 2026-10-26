import { openStore, type StateStore } from "@forerunner/state";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import {
  CHAT_OPEN_REQUEST_RULES,
  CONVERSATION_IDLE_MS,
  ConversationAgent,
} from "../src/conversation/agent.ts";
import { flatPricing, harness } from "./helpers.ts";

/**
 * The 2026-10-26 voice session on a fresh install: the model watch's first-boot request sat
 * open and the conversation agent brought it up in most replies ("Separately, there is one open
 * request waiting for you: a model watch..."), whatever the human had asked. Every turn is a
 * fresh model call whose facts listed every open request in full, and nothing told the model
 * it had already said so. Now the facts list an open request in full once per conversation
 * (or when the human asks what is pending, or when it blocks work), later turns carry only a
 * count, and the system rules say when to bring requests up. Scripted provider, no live model.
 */
const MODEL_WATCH_WHY =
  "Model watch 2026-10-26: 10 new, 0 retired, 0 repriced, 0 unpriced model(s).";

interface World {
  store: StateStore;
  human: string;
  alice: string;
  provider: FakeProvider;
  clock: ReturnType<typeof harness>["clock"];
  chat: (text: string, source?: "text" | "voice") => ReturnType<ConversationAgent["chat"]>;
  /** The turn's user message (the volatile facts and the line) of the i-th model call. */
  user: (i: number) => string;
  system: (i: number) => string;
}

async function setup(turns = 8): Promise<World> {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 150_000_000,
      locale: "en",
    })
  ).id;
  const alice = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: human,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    })
  ).id;
  const provider = new FakeProvider({
    replies: Array.from({ length: turns }, () => textReply("Sure.", { ttftMs: 0 })),
    clock: h.clock,
    latency: "none",
  });
  const agent = new ConversationAgent({
    store,
    clock: h.clock,
    tokens: h.tokens,
    kill: h.kill,
    provider,
    pricing: flatPricing,
    billingSourceId: "bs",
    hooksDriver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
  });
  return {
    store,
    human,
    alice,
    provider,
    clock: h.clock,
    chat: (text, source = "voice") => agent.chat({ humanId: human, agentId: alice, text, source }),
    user: (i) => String(provider.calls[i]?.request.messages[0]?.content ?? ""),
    system: (i) => String(provider.calls[i]?.request.system ?? ""),
  };
}

function modelWatchRequest(w: World, over: { why?: string; blocking?: boolean } = {}) {
  return w.store.humanRequest.insert({
    human_id: w.human,
    project_id: null,
    kind: "decision",
    why: over.why ?? MODEL_WATCH_WHY,
    steps: [],
    options: ["adopt", "ignore", "remind"],
    blocking: over.blocking ?? false,
    risk: "medium",
  });
}

describe("conversation agent: open requests are not brought up in every reply", () => {
  it("the system rules say when to mention open requests: at most once, briefly, or when asked or urgent", async () => {
    const w = await setup();
    await w.chat("how is the weather in the game?");
    expect(w.system(0)).toContain(CHAT_OPEN_REQUEST_RULES);
    expect(CHAT_OPEN_REQUEST_RULES).toMatch(/at most once/i);
    expect(CHAT_OPEN_REQUEST_RULES).toMatch(/never .*every reply/i);
    await w.store.close();
  });

  it("an open request is in the first turn's facts once; the next turn carries a count and no nudge", async () => {
    const w = await setup();
    const req = await modelWatchRequest(w);
    await w.chat("what time is it in Zurich?");
    expect(w.user(0)).toContain(`- open_requests: ${req.id.slice(0, 8)}: Model watch 2026-10-26`);
    expect(w.user(0)).toContain("not yet mentioned in this conversation");

    await w.chat("and how long until the next session?");
    expect(w.user(1)).not.toContain("Model watch");
    expect(w.user(1)).not.toContain("not yet mentioned");
    expect(w.user(1)).toContain(
      "- open_requests: 1 (already mentioned in this conversation; bring up only if the human asks)",
    );
    // The system part never changes with it: the cached prefix stays byte for byte.
    expect(w.system(1)).toBe(w.system(0));

    await w.chat("tell me a joke");
    expect(w.user(2)).not.toContain("Model watch");
    await w.store.close();
  });

  it("when the human asks what is pending the request is listed again, marked as asked", async () => {
    const w = await setup();
    await modelWatchRequest(w);
    await w.chat("good morning");
    await w.chat("what's the plan today?");
    expect(w.user(1)).not.toContain("Model watch");
    await w.chat("is anything waiting for me?");
    expect(w.user(2)).toContain("Model watch 2026-10-26");
    expect(w.user(2)).toContain("the human asked");
    await w.chat("ok thanks");
    expect(w.user(3)).not.toContain("Model watch");
    await w.store.close();
  });

  it("a request opened mid-conversation is listed once beside the count of those already mentioned", async () => {
    const w = await setup();
    await modelWatchRequest(w);
    await w.chat("hello");
    const db = await modelWatchRequest(w, { why: "Pick a database" });
    await w.chat("what next?");
    expect(w.user(1)).toContain(`${db.id.slice(0, 8)}: Pick a database`);
    expect(w.user(1)).not.toContain("Model watch");
    expect(w.user(1)).toContain("+1 already mentioned in this conversation");
    await w.chat("fine");
    expect(w.user(2)).not.toContain("Pick a database");
    expect(w.user(2)).toContain("- open_requests: 2 (already mentioned");
    await w.store.close();
  });

  it("a blocking request (work waits on it) stays listed and is marked blocking", async () => {
    const w = await setup();
    await modelWatchRequest(w, { why: "Approve the deploy key", blocking: true });
    await w.chat("hello");
    await w.chat("what next?");
    expect(w.user(1)).toContain("Approve the deploy key");
    expect(w.user(1)).toContain("[blocking]");
    await w.store.close();
  });

  it("a new conversation after a long pause mentions the open request once more", async () => {
    const w = await setup();
    await modelWatchRequest(w);
    await w.chat("hello", "text");
    await w.chat("anything else?", "text");
    expect(w.user(1)).not.toContain("Model watch");
    await w.clock.advance(CONVERSATION_IDLE_MS + 60_000);
    await w.chat("back again", "text");
    expect(w.user(2)).toContain("Model watch 2026-10-26");
    await w.store.close();
  });
});
