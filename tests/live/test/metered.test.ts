import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import type { ModelRequest } from "@forerunner/runtime";
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
