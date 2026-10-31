import { type BillingSource, makeBillingSource } from "@forerunner/billing";
import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { fallbackSentence, RoutedProvider } from "../src/provider/routed.ts";
import type { ModelProvider, ModelRequest, StreamEvent } from "../src/provider/types.ts";
import type { TaskBillingPick, TaskBillingRequest } from "../src/session/billing.ts";

/**
 * `RoutedProvider` (U-078, ADR 0100) on its own: one retry on the next source after a usage
 * limit, never a second one, never after the reply began, and a plain reason when nothing can
 * serve. The router is a stand-in that picks the first source not excluded.
 */
const sub = makeBillingSource({
  id: "sub",
  kind: "subscription",
  humanId: "h",
  label: "Claude subscription",
});
const key = makeBillingSource({
  id: "key",
  kind: "api_key",
  humanId: "h",
  label: "Anthropic API key",
});

const limit: StreamEvent = {
  type: "error",
  code: "provider_usage_limit",
  message: "limit",
  retryable: false,
  resetAt: "2026-10-31T11:00:00.000Z",
};
const reply = (text: string): StreamEvent[] => [
  { type: "message_start", model: "claude-haiku-5-5" },
  { type: "text_delta", text },
  {
    type: "message_end",
    stop_reason: "end_turn",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
];

function provider(events: StreamEvent[]): ModelProvider & { calls: number } {
  const p = {
    name: "anthropic",
    calls: 0,
    listModels: async () => [],
    countTokens: (t: string) => t.length,
    complete: async () => {
      throw new Error("not used");
    },
    async *stream() {
      p.calls++;
      for (const e of events) yield e;
    },
  };
  return p;
}

function world(sources: BillingSource[], byId: Record<string, ModelProvider>) {
  const picks: TaskBillingRequest[] = [];
  const rests: string[] = [];
  const sentences: string[] = [];
  const routed = new RoutedProvider({
    billing: {
      async pick(req) {
        picks.push(req);
        const s = sources.find((x) => !(req.exclude ?? []).includes(x.id));
        if (!s)
          throw new ForerunnerError("unavailable", "none", {
            details: {
              skipped: sources.map((x) => ({ sourceId: x.id, kind: x.kind, code: "cooldown" })),
            },
          });
        return {
          source: s,
          driver: "loop",
          reason: "",
          skipped: [],
          plan: null,
        } as TaskBillingPick;
      },
      async rest(sourceId, resetAt) {
        rests.push(sourceId);
        return resetAt ?? "2026-10-31T10:00:00.000Z";
      },
    },
    providerFor: async (s) => byId[s.id] ?? null,
    sources: async () => sources,
    humanId: "h",
    agentId: "a",
    clock: new SimulatedClock("2026-10-31T09:00:00Z"),
    onFallback: (s) => sentences.push(s),
  });
  return { routed, picks, rests, sentences };
}

const req: ModelRequest = {
  model: "claude-haiku-5-5",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 64,
};

async function events(p: ModelProvider): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of p.stream(req)) out.push(e);
  return out;
}

describe("RoutedProvider (U-078)", () => {
  it("answers on the next source after a usage limit, once, and books the call to it", async () => {
    const a = provider([limit]);
    const b = provider(reply("from the key"));
    const w = world([sub, key], { sub: a, key: b });
    const res = await w.routed.complete(req);
    expect(res.content).toEqual([{ type: "text", text: "from the key" }]);
    expect(res.billing).toEqual({ sourceId: "key", kind: "api" });
    expect(w.rests).toEqual(["sub"]);
    expect(w.picks.map((p) => p.exclude)).toEqual([[], ["sub"]]);
    expect(w.picks.every((p) => p.purpose === "chat")).toBe(true);
    expect(w.sentences).toEqual([
      "The Claude subscription reached its usage limit and rests until 2026-10-31 11:00 UTC; the API key answered instead.",
    ]);
  });

  it("a second usage limit is the call's error; there is no third try", async () => {
    const a = provider([limit]);
    const b = provider([limit]);
    const w = world([sub, key], { sub: a, key: b });
    const out = await events(w.routed);
    expect(out).toEqual([
      expect.objectContaining({ type: "error", code: "provider_usage_limit", sourceId: "key" }),
    ]);
    expect([a.calls, b.calls]).toEqual([1, 1]);
    expect(w.rests).toEqual(["sub", "key"]);
    expect(w.sentences.at(-1)).toBe(
      "The API key reached its usage limit and rests until 2026-10-31 11:00 UTC; no other Claude credential can be used now.",
    );
  });

  it("a limit after the reply began is not made twice", async () => {
    const a = provider([
      { type: "message_start", model: "m" },
      { type: "text_delta", text: "Hel" },
      limit,
    ]);
    const b = provider(reply("never"));
    const w = world([sub, key], { sub: a, key: b });
    const out = await events(w.routed);
    expect(out.at(-1)).toMatchObject({ type: "error", code: "provider_usage_limit" });
    expect(b.calls).toBe(0);
    expect(w.rests).toEqual(["sub"]);
  });

  it("another error is passed on as it is, with no rest and no retry", async () => {
    const a = provider([
      { type: "error", code: "provider_auth", message: "refused", retryable: false },
    ]);
    const b = provider(reply("never"));
    const w = world([sub, key], { sub: a, key: b });
    const out = await events(w.routed);
    expect(out).toEqual([expect.objectContaining({ code: "provider_auth", sourceId: "sub" })]);
    expect(b.calls).toBe(0);
    expect(w.rests).toEqual([]);
  });

  it("with nothing that can serve, says so in plain words", async () => {
    const w = world([], {});
    const out = await events(w.routed);
    expect(out).toEqual([
      expect.objectContaining({
        type: "error",
        code: "unavailable",
        message: expect.stringContaining("No Claude credential can be used now"),
      }),
    ]);
  });

  it("names the sources in the sentence the session log shows", () => {
    expect(fallbackSentence(key, sub, "2026-11-01T00:00:00Z")).toBe(
      "The API key reached its usage limit and rests until 2026-11-01 00:00 UTC; the Claude subscription answered instead.",
    );
  });
});
