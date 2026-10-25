import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import type { ModelProvider, ModelRequest, StreamEvent, Usage } from "@forerunner/runtime";
import { errorReply, FakeProvider, type ScriptedReply, textReply } from "@forerunner/testenv";
import { afterAll, describe, expect, it } from "vitest";
import { LiveBudget, LiveBudgetError } from "../src/budget.ts";
import { DRY_RUN_PRICING } from "../src/dry-run.ts";
import { SpendLedger } from "../src/ledger.ts";
import { type LiveCall, MeteredProvider } from "../src/metered.ts";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function world(opts: { replies: ScriptedReply[]; runCapUsd?: number; capUsd?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "fr-live-metered-"));
  temps.push(dir);
  const clock = new SimulatedClock("2026-10-20T12:00:00Z");
  const ledger = SpendLedger.load(join(dir, "spend.json"));
  const budget = new LiveBudget({
    ledger,
    run: "dry",
    config: { capUsd: opts.capUsd ?? 100, runCapUsd: opts.runCapUsd ?? 15, warnShare: 0.8 },
    pricing: DRY_RUN_PRICING,
    clock,
    onWarn: () => undefined,
  });
  const inner = new FakeProvider({ mode: "script", replies: opts.replies, clock, latency: "none" });
  const calls: LiveCall[] = [];
  const provider = new MeteredProvider(inner, budget, {
    clock,
    onCall: (c) => {
      calls.push(c);
    },
  });
  return { ledger, budget, inner, provider, calls, clock };
}

const req = (model = "fake-sonnet", extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model,
  messages: [{ role: "user", content: "say hi" }],
  max_tokens: 64,
  ...extra,
});

const NO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** The input-side counts the Anthropic adapter reports on `message_start`. */
const START_USAGE: Usage = {
  input_tokens: 1200,
  output_tokens: 0,
  cache_read_input_tokens: 300,
  cache_creation_input_tokens: 0,
};

/**
 * An inner provider whose stream opens (message_start, a first chunk), then waits for the
 * request's abort signal the way the SDK's iterator does, and then either ends cleanly with a
 * `message_end` (the Anthropic SDK exits its iterator without throwing after an abort) or
 * throws an `AbortError` (the fetch path). `opened` resolves once the first chunk is out.
 * `opens: false` yields nothing before the wait (the response arrived, the message had not
 * opened when the stop landed: the probe's shape).
 */
function cutOffProvider(
  after: "message_end" | "throw",
  opts: { startUsage?: Usage; endUsage?: Usage; opens?: boolean } = {},
): { provider: ModelProvider; opened: Promise<void> } {
  let opened: () => void = () => undefined;
  const openedPromise = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const provider: ModelProvider = {
    name: "cut-off",
    listModels: async () => [],
    countTokens: (t: string) => Math.ceil(t.length / 4),
    async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
      if (opts.opens !== false) {
        yield {
          type: "message_start",
          model: req.model,
          ...(opts.startUsage ? { usage: opts.startUsage } : {}),
        };
        yield { type: "text_delta", text: "the first words of a long answer" };
      }
      opened();
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) resolve();
        else req.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      if (after === "throw") throw new DOMException("This operation was aborted", "AbortError");
      yield { type: "message_end", stop_reason: "end_turn", usage: opts.endUsage ?? NO_USAGE };
    },
    complete: () => Promise.reject(new Error("unused")),
  };
  return { provider, opened: openedPromise };
}

describe("metered provider", () => {
  it("meters every call: a reservation before, the reported usage priced into the ledger after", async () => {
    const w = world({
      replies: [
        textReply("hi there", { usage: { input_tokens: 1200, output_tokens: 7 }, times: 2 }),
      ],
    });
    const res = await w.provider.complete(req());
    expect(res.stop_reason).toBe("end_turn");
    const rows = w.ledger.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run: "dry",
      model: "fake-sonnet",
      tokensIn: 1200,
      tokensOut: 7,
    });
    // sonnet 5.5: 2 USD / MTok in, 10 USD / MTok out
    expect(rows[0]?.usd).toBe((1200 * 2 + 7 * 10) / 1_000_000);
    expect(rows[0]?.note).toBeUndefined();
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({
      status: "ok",
      tokensIn: 1200,
      tokensOut: 7,
      stopReason: "end_turn",
    });
    expect(w.calls[0]?.estimateUsd).toBeGreaterThan(0);
    await w.provider.complete(req("fake-haiku"));
    expect(w.ledger.rows().map((r) => r.model)).toEqual(["fake-sonnet", "fake-haiku"]);
    expect(w.budget.snapshot().inFlightUsd).toBe(0);
    expect(w.provider.totals()).toMatchObject({ calls: 2, refused: 0 });
  });

  it("refuses in code before anything is sent when the run cap would be crossed, and the failure names the ledger", async () => {
    const w = world({ replies: [textReply("never", { times: 5 })], runCapUsd: 0.0001 });
    await expect(w.provider.complete(req())).rejects.toThrow(LiveBudgetError);
    expect(w.inner.calls).toHaveLength(0);
    expect(w.ledger.rows()).toHaveLength(0);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ status: "refused", usd: 0 });
    expect(w.calls[0]?.reason).toContain("per-run cap of USD 0.0001");
    expect(w.budget.refusals).toHaveLength(1);
  });

  it("records the effort each request asked for, on sent and on refused calls", async () => {
    const w = world({ replies: [textReply("hi", { times: 2 })] });
    await w.provider.complete(req("fake-opus", { effort: "max" }));
    await w.provider.complete(req("fake-sonnet"));
    expect(w.calls.map((c) => c.effort)).toEqual(["max", null]);
    const tight = world({ replies: [textReply("never")], runCapUsd: 0.0001 });
    await expect(tight.provider.complete(req("fake-opus", { effort: "high" }))).rejects.toThrow(
      LiveBudgetError,
    );
    expect(tight.calls[0]).toMatchObject({ status: "refused", effort: "high" });
  });

  it("writes the row for a failed call too, with the error in the note", async () => {
    const w = world({ replies: [errorReply("rate_limit", "slow down")] });
    const res = await w.provider.complete(req());
    expect(res.stop_reason).toBe("error");
    const [row] = w.ledger.rows();
    expect(row).toMatchObject({ tokensIn: 0, tokensOut: 0, usd: 0 });
    expect(row?.note).toBe("no usage reported; error: provider_rate_limit: slow down");
    expect(w.calls[0]?.status).toBe("error");
  });

  it("an abort mid-stream still settles: the row carries the abort note and nothing stays in flight", async () => {
    const w = world({ replies: [] });
    const slow = new FakeProvider({
      mode: "script",
      replies: [
        textReply("a slow answer that gets cut off half way through", {
          ttftMs: 50,
          totalMs: 10_000,
        }),
      ],
      latency: "simulated",
    });
    const provider = new MeteredProvider(slow, w.budget, {
      clock: w.clock,
      onCall: (c) => {
        w.calls.push(c);
      },
    });
    const ac = new AbortController();
    const p = provider.complete(req("fake-sonnet", { signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 120));
    ac.abort(new Error("kill switch"));
    const res = await p;
    expect(res.stop_reason).toBe("error");
    const [row] = w.ledger.rows();
    expect(row?.note).toMatch(/aborted/);
    expect(w.calls.at(-1)?.status).toBe("aborted");
    expect(w.budget.snapshot().inFlightUsd).toBe(0);
  });

  it("classifies a call as aborted when the signal fired before it settled although the stream ended cleanly, and keeps the usage it reported", async () => {
    // The Anthropic SDK exits its iterator without throwing after an abort, so the adapter ends
    // the stream with a message_end and the usage it had: the kill-switch probe of 2026-10-23
    // recorded such a call as ok. The run's signal, not the stream's last event, decides.
    const w = world({ replies: [] });
    const inner = cutOffProvider("message_end", { startUsage: START_USAGE, endUsage: START_USAGE });
    const provider = new MeteredProvider(inner.provider, w.budget, {
      clock: w.clock,
      onCall: (c) => {
        w.calls.push(c);
      },
    });
    const ac = new AbortController();
    const p = provider.complete(req("fake-sonnet", { signal: ac.signal }));
    await inner.opened;
    ac.abort(new Error("kill switch"));
    const res = await p;
    // the stream's own events pass through unchanged; only the record is reclassified
    expect(res.stop_reason).toBe("end_turn");
    const call = w.calls.at(-1);
    expect(call?.status).toBe("aborted");
    expect(call?.reason).toMatch(/abort signal fired before the call settled/);
    expect(call).toMatchObject({ tokensIn: 1200, cacheRead: 300, tokensOut: 0 });
    expect(call?.usd).toBeGreaterThan(0);
    const [row] = w.ledger.rows();
    expect(row).toMatchObject({ tokensIn: 1200, cacheRead: 300, tokensOut: 0, usd: call?.usd });
    expect(row?.note).toMatch(/^aborted: /);
    expect(row?.note).not.toContain("no usage reported");
    expect(w.budget.snapshot().inFlightUsd).toBe(0);
  });

  it("the probe's shape: aborted before the message opened, the stream ended cleanly with no usage", async () => {
    const w = world({ replies: [] });
    const inner = cutOffProvider("message_end", { opens: false });
    const provider = new MeteredProvider(inner.provider, w.budget, {
      clock: w.clock,
      onCall: (c) => {
        w.calls.push(c);
      },
    });
    const ac = new AbortController();
    const p = provider.complete(req("fake-sonnet", { signal: ac.signal }));
    await inner.opened;
    ac.abort(new Error("kill switch"));
    await p;
    expect(w.calls.at(-1)).toMatchObject({ status: "aborted", usd: 0, tokensIn: 0, ttftMs: null });
    expect(w.calls.at(-1)?.reason).toMatch(/abort signal fired before the call settled/);
    expect(w.ledger.rows()[0]?.note).toMatch(/^aborted: /);
    expect(w.budget.snapshot().inFlightUsd).toBe(0);
  });

  it("records the usage from message_start when the stream throws AbortError before message_end", async () => {
    const w = world({ replies: [] });
    const inner = cutOffProvider("throw", { startUsage: START_USAGE });
    const provider = new MeteredProvider(inner.provider, w.budget, {
      clock: w.clock,
      onCall: (c) => {
        w.calls.push(c);
      },
    });
    const ac = new AbortController();
    const p = provider.complete(req("fake-sonnet", { signal: ac.signal }));
    await inner.opened;
    ac.abort(new Error("kill switch"));
    await expect(p).rejects.toThrow(/This operation was aborted/);
    const call = w.calls.at(-1);
    expect(call?.status).toBe("aborted");
    expect(call?.reason).toBe("This operation was aborted");
    expect(call).toMatchObject({ tokensIn: 1200, cacheRead: 300, tokensOut: 0 });
    expect(call?.usd).toBeGreaterThan(0);
    const [row] = w.ledger.rows();
    expect(row).toMatchObject({ tokensIn: 1200, cacheRead: 300, tokensOut: 0, usd: call?.usd });
    expect(row?.note).toBe(
      "aborted: This operation was aborted; input usage from message_start, output tokens not reported",
    );
    expect(w.budget.snapshot().inFlightUsd).toBe(0);
    // the same stream without a message_start usage is the old blind spot: the row says so
    const bare = cutOffProvider("throw");
    const metered = new MeteredProvider(bare.provider, w.budget, { clock: w.clock });
    const ac2 = new AbortController();
    const p2 = metered.complete(req("fake-sonnet", { signal: ac2.signal }));
    await bare.opened;
    ac2.abort(new Error("kill switch"));
    await expect(p2).rejects.toThrow();
    expect(metered.calls[0]).toMatchObject({ status: "aborted", usd: 0 });
    expect(w.ledger.rows()[1]?.note).toBe("no usage reported; aborted: This operation was aborted");
    expect(w.budget.snapshot().inFlightUsd).toBe(0);
  });

  it("a call whose message_end arrived before the stop stays ok", async () => {
    const w = world({
      replies: [
        textReply("done before the kill", { usage: { input_tokens: 90, output_tokens: 5 } }),
      ],
    });
    const ac = new AbortController();
    const it = w.provider.stream(req("fake-sonnet", { signal: ac.signal }))[Symbol.asyncIterator]();
    const seen: string[] = [];
    for (;;) {
      const { value, done } = await it.next();
      if (done) break;
      seen.push(value.type);
      if (value.type === "message_end") break;
    }
    expect(seen.at(-1)).toBe("message_end");
    // the stop lands after the provider's last word and before the wrapper settles the call
    ac.abort(new Error("kill switch"));
    expect((await it.next()).done).toBe(true);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ status: "ok", tokensIn: 90, tokensOut: 5 });
    expect(w.ledger.rows()[0]?.note).toBeUndefined();
    expect(w.budget.snapshot().inFlightUsd).toBe(0);
  });

  it("a call whose message_end arrived before the stop stays ok when the stream then throws AbortError", async () => {
    // A provider whose iterator waits on the open body after the message's last event (as the
    // SDK's does) throws once the stop lands: the message was complete, the status rule keeps ok.
    const w = world({ replies: [] });
    const endUsage: Usage = { ...START_USAGE, output_tokens: 40 };
    const inner: ModelProvider = {
      name: "trailing-abort",
      listModels: async () => [],
      countTokens: (t: string) => Math.ceil(t.length / 4),
      async *stream(r: ModelRequest): AsyncIterable<StreamEvent> {
        yield { type: "message_start", model: r.model, usage: START_USAGE };
        yield { type: "text_delta", text: "a whole answer" };
        yield { type: "message_end", stop_reason: "end_turn", usage: endUsage };
        await new Promise<void>((resolve) => {
          if (r.signal?.aborted) resolve();
          else r.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("This operation was aborted", "AbortError");
      },
      complete: () => Promise.reject(new Error("unused")),
    };
    const provider = new MeteredProvider(inner, w.budget, {
      clock: w.clock,
      onCall: (c) => {
        w.calls.push(c);
      },
    });
    const ac = new AbortController();
    const it = provider.stream(req("fake-sonnet", { signal: ac.signal }))[Symbol.asyncIterator]();
    for (;;) {
      const { value, done } = await it.next();
      if (done || value.type === "message_end") break;
    }
    ac.abort(new Error("kill switch"));
    await expect(it.next()).rejects.toThrow(/This operation was aborted/);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({
      status: "ok",
      tokensIn: 1200,
      tokensOut: 40,
      cacheRead: 300,
    });
    expect(w.calls[0]?.reason).toBeUndefined();
    expect(w.ledger.rows()[0]?.note).toBeUndefined();
    expect(w.budget.snapshot().inFlightUsd).toBe(0);
  });

  it("redacts the credentials from a provider error before it reaches the call record, the ledger note and the audit row", async () => {
    const apiKey = ["sk-ant-", "api03-", "y".repeat(24)].join(""); // not-a-secret
    const workspaceId = ["wrkspc_", "1".repeat(12)].join(""); // not-a-secret
    const w = world({
      replies: [errorReply("provider_auth", `401 invalid x-api-key ${apiKey} for ${workspaceId}`)],
    });
    const provider = new MeteredProvider(w.inner, w.budget, {
      clock: w.clock,
      redact: (text) => text.split(apiKey).join("[REDACTED]").split(workspaceId).join("[REDACTED]"),
      onCall: (c) => {
        w.calls.push(c);
      },
    });
    const res = await provider.complete(req());
    expect(res.stop_reason).toBe("error");
    const call = w.calls[0];
    expect(call?.status).toBe("error");
    expect(call?.reason).toBe("provider_auth: 401 invalid x-api-key [REDACTED] for [REDACTED]");
    const [row] = w.ledger.rows();
    expect(row?.note).toBe(
      "no usage reported; error: provider_auth: 401 invalid x-api-key [REDACTED] for [REDACTED]",
    );
    const text = JSON.stringify({ rows: w.ledger.rows(), calls: w.calls, calls2: provider.calls });
    expect(text).not.toContain(apiKey);
    expect(text).not.toContain(workspaceId);
    // a provider that throws (not an error event) goes through the same redaction
    const thrower = {
      name: "thrower",
      listModels: async () => [],
      countTokens: (t: string) => Math.ceil(t.length / 4),
      // biome-ignore lint/correctness/useYield: a stream that fails before its first event
      async *stream(): AsyncIterable<never> {
        throw new Error(`ECONNRESET while sending ${apiKey}`);
      },
      complete: () => Promise.reject(new Error("unused")),
    };
    const metered = new MeteredProvider(thrower, w.budget, {
      clock: w.clock,
      redact: (text) => text.split(apiKey).join("[REDACTED]"),
    });
    await expect(metered.complete(req())).rejects.toThrow(/ECONNRESET/);
    expect(metered.calls[0]?.reason).toBe("ECONNRESET while sending [REDACTED]");
    expect(w.ledger.rows()[1]?.note).toBe(
      "no usage reported; error: ECONNRESET while sending [REDACTED]",
    );
  });

  it("never lets a credential-looking value into the ledger or the call records", async () => {
    const secretLike = ["sk-ant-", "api03-", "z".repeat(24)].join(""); // not-a-secret
    const w = world({ replies: [textReply(`echo ${secretLike}`)] });
    await w.provider.complete(req("fake-sonnet", { system: secretLike }));
    const text = JSON.stringify({ rows: w.ledger.rows(), calls: w.calls });
    expect(text).not.toContain(secretLike);
  });
});
