import {
  type BillingSource,
  BUILTIN_PRICING,
  costOf,
  estimateUsdMicro,
  mergePricing,
  type PricingTable,
} from "@forerunner/billing";
import { openStore, type StateStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver, type RunEvent } from "../src/agent/loop.ts";
import { type QueryLike, SdkAgentDriver } from "../src/agent/sdk.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import {
  decideFastMode,
  FAST_MODE_API_ONLY,
  FAST_MODE_AUDIT_TOOL,
  FAST_MODE_SETTING,
  fastModeEffect,
  fastModeOf,
} from "../src/models/fast-mode.ts";
import { tierOfModel } from "../src/models/ladder.ts";
import { diffPrices } from "../src/models/watch.ts";
import { AnthropicMessagesProvider } from "../src/provider/anthropic.ts";
import type {
  ModelProvider,
  ModelRef,
  ModelRequest,
  ModelResponse,
  ModelTier,
  StreamEvent,
} from "../src/provider/types.ts";
import type { TaskBillingPick } from "../src/session/billing.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../src/session/executor.ts";
import { pricingFor } from "../src/wiring/billing-ports.ts";
import {
  flatPricing,
  type Harness,
  harness,
  issue,
  registry,
  ScriptedProvider,
} from "./helpers.ts";

/**
 * Opus fast mode per project (spec D.20, ADR 0057). With the project's `fast_mode` setting on,
 * every Opus rung of the project's runs on an API-style source is requested with
 * `speed: "fast"` on the same model id, and the Run row, the ledger row and the per-call
 * estimate name and price the variant (`claude-opus-5-5-fast`) apart from the standard rung.
 * With the flag off nothing changes; a subscription (or plan credits) ignores the flag with an
 * audit row saying "API only". A stub provider named "anthropic" records the requests; the
 * adapter's wire form is pinned against an injected fetch.
 */

/** A provider that offers fast mode, as the Anthropic adapter does, over scripted replies. */
class FastCapableProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly fastMode = true;
  constructor(private readonly inner: ScriptedProvider) {}
  get calls(): ModelRequest[] {
    return this.inner.calls;
  }
  listModels(): Promise<ModelRef[]> {
    return this.inner.listModels();
  }
  stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    return this.inner.stream(req);
  }
  complete(req: ModelRequest): Promise<ModelResponse> {
    return this.inner.complete(req);
  }
  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }
}

const USAGE = { input_tokens: 10_000, output_tokens: 2_000 };

function specialist(tier: ModelTier): SpecialistSpec {
  return {
    name: "coder",
    prompt: "You are the coder.",
    promptVersion: "coder@1.0.0+abc12345",
    defaultTier: tier,
    defaultEffort: "medium",
    allowedTools: ["echo"],
    allowedDomains: [],
    maxBudgetUsdMicro: 2_000_000,
    maxTurns: 10,
    timeoutMs: 60_000,
  };
}

function source(kind: BillingSource["kind"], humanId: string): BillingSource {
  return {
    id: `${kind}-1`,
    kind,
    humanId,
    label: kind,
    credentialRef: `${kind}_ref`,
    enabled: true,
    priority: 1,
    limits: {},
  };
}

interface Outcome {
  h: Harness;
  store: StateStore;
  provider: FastCapableProvider;
  events: RunEvent[];
  run: {
    model: string;
    provider: string;
    cost_usd_micro: number;
    billing_source_id: string | null;
  };
  audit: { tool: string; input_summary: string; result_summary: string; allowed: boolean }[];
  sdkCalls: number;
}

async function runTask(opts: {
  settings: Record<string, unknown>;
  tier?: ModelTier;
  kind?: BillingSource["kind"] | null;
  table?: PricingTable;
}): Promise<Outcome> {
  const h = harness();
  const clock = h.clock;
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = (await store.human.insert({ name: "J", email: "j@x.test" })).id;
  const agent = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
  const project = (await store.project.insert({ name: "Urgent", settings: opts.settings })).id;
  const task = await store.task.insert({
    project_id: project,
    title: "Hotfix the outage",
    outcome: "fixed",
    acceptance_criteria: ["works"],
    risk_tier: 1,
    status: "in_progress",
    budget_usd_micro: 1_500_000,
    est_cost_usd_micro: 1_000_000,
    attempt: 0,
    reason: "seed",
  });
  const session = await store.session.insert({
    agent_id: agent,
    project_id: project,
    trigger: "manual",
    status: "running",
    runner: "pc",
  });
  const provider = new FastCapableProvider(
    new ScriptedProvider([{ text: "Fixed.", usage: USAGE }], clock),
  );
  const kind = opts.kind === undefined ? "api_key" : opts.kind;
  let sdkCalls = 0;
  const q: QueryLike = () => {
    sdkCalls++;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-1" };
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Fixed." }],
          usage: { ...USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Fixed.",
        total_cost_usd: 0.1,
      };
    })();
  };
  const table = opts.table ?? BUILTIN_PRICING;
  const events: RunEvent[] = [];
  const exec = new LoopTaskExecutor({
    store,
    clock,
    tokens: h.tokens,
    driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock }),
    provider,
    pricing: flatPricing,
    pricingFor: (id) => pricingFor(id, table),
    pricingTable: () => table,
    tools: registry(),
    billingSourceId: "bs",
    ...(kind
      ? {
          billing: {
            pick: async (): Promise<TaskBillingPick> => ({
              source: source(kind, human),
              driver: kind === "subscription" ? "sdk" : "loop",
              reason: "test pick",
              skipped: [],
              plan:
                kind === "subscription"
                  ? { share: 0.1, monthUsdMicro: 0, allowanceUsdMicro: null, cap: 0.9 }
                  : null,
            }),
          },
        }
      : {}),
    sdk: {
      driver: new SdkAgentDriver({ hooks: h.hooks, kill: h.kill, clock, queryImpl: q }),
      credential: async () => ({ kind: "oauth_token", value: "oauth-test-value" }),
      workRoot: "/tmp/fr-fast-mode-sdk",
      pricing: (id) => pricingFor(id, table),
    },
    specialists: (n) => (n === "coder" ? specialist(opts.tier ?? "opus") : undefined),
    onEvent: (_taskId, ev) => events.push(ev),
  });
  const token = issue(h, {
    agentId: agent,
    ownerHumanId: human,
    projectId: project,
    taskId: task.id,
    allowedTools: ["echo"],
    budgetUsdMicro: 5_000_000,
    sessionId: session.id,
  });
  const res = await exec.execute({
    task,
    session,
    token,
    budget: new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: 5_000_000,
      stepCap: 100,
      deadlineMs: clock.now() + 3_600_000,
      reserveShare: 0.2,
    }),
    item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1_000_000 },
    signal: new AbortController().signal,
  });
  expect(res.outcome).toBe("done");
  const runs = await store.run.forTask(task.id);
  const run = runs[0];
  if (!run) throw new Error("no run row");
  const audit = (await store.auditLog.list({ tool: FAST_MODE_AUDIT_TOOL })).map((r) => ({
    tool: r.tool,
    input_summary: r.input_summary,
    result_summary: r.result_summary,
    allowed: r.allowed,
  }));
  return { h, store, provider, events, run, audit, sdkCalls };
}

const STANDARD_COST = costOf({ tokens_in: 10_000, tokens_out: 2_000 }, "claude-opus-5-5");
const FAST_COST = costOf({ tokens_in: 10_000, tokens_out: 2_000 }, "claude-opus-5-5-fast");

describe("Opus fast mode per project (D.20)", () => {
  it("flag on: the Opus call carries speed fast and the run, the ledger and the estimate price the variant apart", async () => {
    const o = await runTask({ settings: { [FAST_MODE_SETTING]: true } });
    // The wire: the same Opus model id, the speed parameter set.
    expect(o.provider.calls).toHaveLength(1);
    expect(o.provider.calls[0]?.model).toBe("claude-opus-5-5");
    expect(o.provider.calls[0]?.speed).toBe("fast");
    // The run row names the variant and carries its price.
    expect(o.run.model).toBe("claude-opus-5-5-fast");
    expect(o.run.cost_usd_micro).toBe(FAST_COST);
    expect(FAST_COST).toBe(STANDARD_COST * 6);
    // The ledger row: the variant's model id at the variant's rate, an API row.
    expect(o.h.ledger.entries).toHaveLength(1);
    expect(o.h.ledger.entries[0]).toMatchObject({
      model: "claude-opus-5-5-fast",
      usdMicro: FAST_COST,
      kind: "api",
      billingSourceId: "api_key-1",
    });
    // The estimate before the call reads the variant's rate (spec I.3).
    const start = o.events.find((e) => e.type === "model_call_start");
    const est = start && start.type === "model_call_start" ? start.estimateUsdMicro : 0;
    // The estimate is the input count at 24 USD/MTok plus the 4096-token output ceiling at 120.
    const ceiling = estimateUsdMicro(
      { inputTokens: 0, maxOutputTokens: 4096 },
      "claude-opus-5-5-fast",
    );
    expect(ceiling).toBe(4096 * 120);
    expect(est).toBeGreaterThan(ceiling);
    expect((est - ceiling) % 24).toBe(0);
    const runStart = o.events.find((e) => e.type === "run_start");
    expect(runStart && runStart.type === "run_start" ? runStart.model : "").toBe(
      "claude-opus-5-5-fast",
    );
    // One audit row says what happened, with the variant and the source.
    expect(o.audit).toHaveLength(1);
    expect(o.audit[0]?.allowed).toBe(true);
    expect(o.audit[0]?.result_summary).toMatch(
      /^applied: claude-opus-5-5 requested with speed fast/,
    );
    expect(JSON.parse(o.audit[0]?.input_summary ?? "{}")).toMatchObject({
      model: "claude-opus-5-5",
      variant: "claude-opus-5-5-fast",
      tier: "opus",
      kind: "api_key",
      driver: "loop",
    });
    await o.store.close();
  });

  it("flag off: the Opus call is unchanged, priced at the standard rung, no audit row", async () => {
    const o = await runTask({ settings: {} });
    expect(o.provider.calls[0]?.model).toBe("claude-opus-5-5");
    expect(o.provider.calls[0]?.speed).toBeUndefined();
    expect(o.run.model).toBe("claude-opus-5-5");
    expect(o.run.cost_usd_micro).toBe(STANDARD_COST);
    expect(o.h.ledger.entries[0]).toMatchObject({
      model: "claude-opus-5-5",
      usdMicro: STANDARD_COST,
    });
    expect(o.audit).toEqual([]);
    // Explicitly off is the same as unset.
    const off = await runTask({ settings: { [FAST_MODE_SETTING]: false } });
    expect(off.provider.calls[0]?.speed).toBeUndefined();
    expect(off.run.model).toBe("claude-opus-5-5");
    expect(off.audit).toEqual([]);
    await o.store.close();
    await off.store.close();
  });

  it("flag on, a run below the Opus rung: unchanged (only Opus rungs go fast)", async () => {
    const o = await runTask({ settings: { [FAST_MODE_SETTING]: true }, tier: "sonnet" });
    expect(o.provider.calls[0]?.model).toBe("claude-sonnet-5-5");
    expect(o.provider.calls[0]?.speed).toBeUndefined();
    expect(o.run.model).toBe("claude-sonnet-5-5");
    expect(o.audit).toEqual([]);
    await o.store.close();
  });

  it("subscription source: the flag is ignored with an audit row saying API only, the run stays standard", async () => {
    const o = await runTask({ settings: { [FAST_MODE_SETTING]: true }, kind: "subscription" });
    // The subscription runs on the Agent SDK path; the loop provider is never called.
    expect(o.sdkCalls).toBe(1);
    expect(o.provider.calls).toHaveLength(0);
    expect(o.run.model).toBe("claude-opus-5-5");
    expect(o.run.provider).toBe("anthropic-sdk");
    expect(o.h.ledger.entries[0]).toMatchObject({
      model: "claude-opus-5-5",
      kind: "subscription",
    });
    expect(o.audit).toHaveLength(1);
    expect(o.audit[0]?.result_summary).toContain(FAST_MODE_API_ONLY);
    expect(o.audit[0]?.result_summary).toMatch(/^ignored \(API only\)/);
    expect(JSON.parse(o.audit[0]?.input_summary ?? "{}")).toMatchObject({
      model: "claude-opus-5-5",
      kind: "subscription",
      driver: "sdk",
    });
    expect(
      o.events.some((e) => e.type === "warning" && e.message.includes(FAST_MODE_API_ONLY)),
    ).toBe(true);
    await o.store.close();
  });

  it("plan credits: ignored as API only too, on the loop path without the speed parameter", async () => {
    const o = await runTask({ settings: { [FAST_MODE_SETTING]: true }, kind: "plan_credits" });
    expect(o.provider.calls[0]?.speed).toBeUndefined();
    expect(o.run.model).toBe("claude-opus-5-5");
    expect(o.audit[0]?.result_summary).toMatch(/^ignored \(API only\)/);
    await o.store.close();
  });

  it("no billing port (the composition's one API-style source): fast mode applies", async () => {
    const o = await runTask({ settings: { [FAST_MODE_SETTING]: true }, kind: null });
    expect(o.provider.calls[0]?.speed).toBe("fast");
    expect(o.run.model).toBe("claude-opus-5-5-fast");
    await o.store.close();
  });

  it("an Opus rung with no fast-mode price row is never run unpriced: ignored with the reason", async () => {
    const table = Object.fromEntries(
      Object.entries(BUILTIN_PRICING).filter(([id]) => id !== "claude-opus-5-5-fast"),
    );
    const o = await runTask({ settings: { [FAST_MODE_SETTING]: true }, table });
    expect(o.provider.calls[0]?.speed).toBeUndefined();
    expect(o.run.model).toBe("claude-opus-5-5");
    expect(o.audit[0]?.result_summary).toMatch(/no fast-mode price row for claude-opus-5-5-fast/);
    await o.store.close();
  });
});

describe("the fast-mode decision", () => {
  const base = {
    enabled: true,
    tier: "opus" as ModelTier,
    model: "claude-opus-5-5",
    driver: "loop" as const,
    sourceKind: "api_key" as const,
    provider: { name: "anthropic", fastMode: true },
    pricing: BUILTIN_PRICING,
  };

  it("applies on an Opus rung of an API source on a provider that offers it", () => {
    expect(decideFastMode(base)).toEqual({
      kind: "applied",
      model: "claude-opus-5-5",
      variant: "claude-opus-5-5-fast",
    });
  });

  it("is off when the flag is off or the rung is not Opus", () => {
    expect(decideFastMode({ ...base, enabled: false })).toEqual({ kind: "off" });
    expect(decideFastMode({ ...base, tier: "fable", model: "claude-fable-5-1" })).toEqual({
      kind: "off",
    });
  });

  it("is ignored with a reason on a provider without fast mode or the SDK path", () => {
    const fake = decideFastMode({ ...base, provider: { name: "fake" }, model: "fake-opus" });
    expect(fake.kind).toBe("ignored");
    expect(fake.kind === "ignored" && fake.reason).toMatch(/provider fake has no fast mode/);
    const sdk = decideFastMode({ ...base, driver: "sdk" });
    expect(sdk.kind === "ignored" && sdk.reason).toMatch(/Agent SDK/);
  });

  it("reads the flag from the project's settings, true only for a literal true", () => {
    expect(fastModeOf({ fast_mode: true })).toBe(true);
    expect(fastModeOf({ fast_mode: "true" })).toBe(false);
    expect(fastModeOf({})).toBe(false);
    expect(fastModeOf(null)).toBe(false);
    expect(fastModeOf(undefined)).toBe(false);
  });

  it("the effect sentence names the surcharge both ways, from the price table in force", () => {
    expect(fastModeEffect(true)).toBe(
      "Opus runs of this project on an API key are requested in fast mode (research preview) at USD 24 / 120 per million input / output tokens instead of USD 4 / 20, a 6x surcharge; a subscription ignores it (API only)",
    );
    expect(fastModeEffect(false)).toBe(
      "Opus runs of this project go back to the standard speed at USD 4 / 20 per million input / output tokens; the fast-mode surcharge (6x, USD 24 / 120) stops",
    );
    const corrected = mergePricing(BUILTIN_PRICING, {
      "claude-opus-5-5-fast": { input_per_mtok_usd: 30, output_per_mtok_usd: 150 },
    });
    expect(fastModeEffect(true, corrected)).toContain("USD 30 / 150");
    expect(fastModeEffect(true, corrected)).toContain("7.5x");
  });
});

describe("the variant elsewhere in the runtime", () => {
  it("a Run row naming the variant is on the Opus rung for the retry ladder", () => {
    expect(tierOfModel("claude-opus-5-5-fast")).toBe("opus");
    expect(tierOfModel("claude-opus-5-5")).toBe("opus");
    expect(tierOfModel("claude-nonesuch-fast")).toBeNull();
  });

  it("the model watch reprices the variant's own row from a price list that lists it", () => {
    const diff = diffPrices(BUILTIN_PRICING, {
      as_of: "2026-10-30",
      models: {
        "claude-opus-5-5": { input_per_mtok_usd: 4, output_per_mtok_usd: 20 },
        "claude-opus-5-5-fast": { input_per_mtok_usd: 30, output_per_mtok_usd: 150 },
      },
    });
    expect(diff.repriced.map((r) => r.model)).toEqual(["claude-opus-5-5-fast"]);
    expect(diff.proposal["claude-opus-5-5-fast"]).toMatchObject({
      input_per_mtok_usd: 30,
      output_per_mtok_usd: 150,
      source: "list",
    });
  });
});

describe("the Anthropic adapter's fast mode on the wire", () => {
  function sse(): Response {
    const events = [
      {
        type: "message_start",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  async function send(speed?: "fast") {
    let body: Record<string, unknown> = {};
    let headers = new Headers();
    const p = new AnthropicMessagesProvider({
      apiKey: "k",
      maxRetries: 0,
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        headers = new Headers(init?.headers);
        return sse();
      },
    });
    expect(p.fastMode).toBe(true);
    const r = await p.complete({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      ...(speed ? { speed } : {}),
    });
    expect(r.stop_reason).toBe("end_turn");
    return { body, headers };
  }

  it("sends speed fast on the Opus model id with the fast-mode beta header", async () => {
    const { body, headers } = await send("fast");
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.speed).toBe("fast");
    expect(headers.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
  });

  it("sends neither without the speed field", async () => {
    const { body, headers } = await send();
    expect(body.speed).toBeUndefined();
    expect(headers.get("anthropic-beta") ?? "").not.toContain("fast-mode");
  });
});
