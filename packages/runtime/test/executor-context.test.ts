import { BUILTIN_PRICING, CostLedger, FixedRateSource, roundHalfUp } from "@forerunner/billing";
import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { ToolRegistry } from "../src/agent/tools.ts";
import { ContextManager } from "../src/context/manager.ts";
import { DEFAULT_CONTEXT_SETTINGS } from "../src/context/pipeline.ts";
import { costView } from "../src/daemon/views.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import type { LedgerEntry, LedgerPort } from "../src/enforcement/ports.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../src/session/executor.ts";
import { StateLedgerStore } from "../src/wiring/billing-ports.ts";
import { StateLedger } from "../src/wiring/state-ports.ts";
import {
  FakeHeadroom,
  NOISY_OUTPUT,
  noisyTool,
  ProxyableScriptedProvider,
  seedWorld,
} from "./context-helpers.ts";
import { flatPricing, harness, issue, ScriptedProvider } from "./helpers.ts";

const coder: SpecialistSpec = {
  name: "coder",
  prompt: "You are the coder.",
  promptVersion: "coder@1.0.0+abc12345",
  defaultTier: "sonnet",
  defaultEffort: "medium",
  allowedTools: ["noisy"],
  allowedDomains: [],
  maxBudgetUsdMicro: 2_000_000,
  maxTurns: 10,
  timeoutMs: 60_000,
};

const replies = () => [{ tools: [{ name: "noisy", input: {} }] }, { text: "Done." }];

async function setup(policy: "off" | "native" | "headroom", headroom: FakeHeadroom) {
  // The hooks' ledger writes to the store so the cost view can find the run by project.
  const holder: { port: LedgerPort | null } = { port: null };
  const h = harness({ ledger: { record: (e: LedgerEntry) => holder.port?.record(e) } });
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  holder.port = new StateLedger(store, { chfPerUsd: () => 0.8 });
  const w = await seedWorld(store, { context: { compression: policy } });
  const task = await store.task.insert({
    project_id: w.project,
    title: "Investigate the build",
    outcome: "The failing step is named",
    acceptance_criteria: ["names the step"],
    risk_tier: 1,
    status: "in_progress",
    priority: 5,
    depends_on: [],
    budget_usd_micro: 500_000,
    est_cost_usd_micro: 300_000,
    actual_cost_usd_micro: 0,
    attempt: 0,
    reason: "seed",
  });
  const session = await store.session.mustGet(w.session);
  const context = new ContextManager({
    clock: h.clock,
    headroom,
    settingsFor: async () => ({ ...DEFAULT_CONTEXT_SETTINGS, compression: policy }),
  });
  const execute = async (provider: ScriptedProvider) => {
    const exec = new LoopTaskExecutor({
      store,
      clock: h.clock,
      tokens: h.tokens,
      driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
      provider,
      pricing: flatPricing,
      tools: new ToolRegistry().register(noisyTool),
      context,
      billingSourceId: "bs",
      specialists: (n) => (n === "coder" ? coder : undefined),
    });
    const token = issue(h, {
      sessionId: session.id,
      agentId: w.agent,
      ownerHumanId: w.human,
      projectId: w.project,
      allowedTools: ["noisy"],
    });
    const budget = new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: 5_000_000,
      stepCap: 100,
      deadlineMs: h.clock.now() + 3_600_000,
      reserveShare: 0.2,
    });
    const r = await exec.execute({
      task,
      session,
      token,
      budget,
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 300_000 },
      signal: new AbortController().signal,
    });
    const [run] = await store.run.forSession(session.id);
    if (!run) throw new Error("no run row");
    return { result: r, run };
  };
  return { h, store, w, context, execute };
}

describe("LoopTaskExecutor: context layer", () => {
  it("records tokens before/after, the transforms and headroom_used on the Run; the cost view prices the savings", async () => {
    const headroom = new FakeHeadroom("healthy", {});
    const { h, store, w, context, execute } = await setup("headroom", headroom);
    const provider = new ProxyableScriptedProvider(replies(), h.clock);
    const { result, run } = await execute(provider);
    expect(result.outcome).toBe("done");
    expect(run.outcome).toBe("completed");
    expect(run.tokens_before_compression).toBeGreaterThan(run.tokens_after_compression);
    expect(run.tokens_after_compression).toBeGreaterThan(0);
    expect(run.context_transforms).toEqual(expect.arrayContaining(["logs", "truncate"]));
    expect(run.headroom_used).toBe(true);
    // The calls went through the proxied provider with the project header; the original was idle.
    expect(provider.calls).toHaveLength(0);
    expect(provider.children).toHaveLength(1);
    expect(provider.children[0]?.calls).toHaveLength(2);
    expect(provider.children[0]?.proxied).toEqual({
      baseURL: headroom.url,
      headers: { "X-Headroom-Project": w.project },
    });
    expect(context.get(w.session)?.selection.headroomUsed).toBe(true);

    // Cost view (module I): savings from the Run rows, priced at read time, never netted.
    const ledgerStore = new StateLedgerStore(store);
    const ledger = new CostLedger({
      sink: ledgerStore,
      query: ledgerStore,
      runs: ledgerStore,
      sessions: ledgerStore,
      rates: new FixedRateSource(0.8),
      clock: h.clock,
      pricing: {
        ...BUILTIN_PRICING,
        [run.model]: {
          input_per_mtok_usd: 3,
          output_per_mtok_usd: 15,
          cache_read_per_mtok_usd: 0.3,
          cache_write_per_mtok_usd: 3.75,
          source: "assumed",
          as_of: "2026-10-20",
        },
      },
    });
    const saved = run.tokens_before_compression - run.tokens_after_compression;
    const view = await costView(store, { projectId: w.project }, 0.8, ledger);
    expect(view.savings.compressionTokens).toBe(saved);
    expect(view.savings.compression).toEqual({
      usdMicro: saved * 3,
      chfMicro: roundHalfUp(saved * 3 * 0.8),
    });
    expect(view.savings.cacheTokens).toBe(0);
    expect(view.totals.usdMicro).toBeGreaterThan(0);
    const report = await ledger.savings({ sessionId: w.session });
    expect(report.headroom.runs).toBe(1);
    expect(report.transforms.truncate).toBe(1);
    expect(report.byModel[0]?.key).toBe(run.model);
    expect(report.bySpecialist[0]?.key).toBe("coder");
    expect(report.byProject[0]?.key).toBe(w.project);
    // Without a priced model the tokens still show and the money is honestly zero.
    const unpriced = await costView(store, { projectId: w.project }, 0.8);
    expect(unpriced.savings.compressionTokens).toBe(saved);
    expect(unpriced.savings.compression).toEqual({ usdMicro: 0, chfMicro: 0 });
  });

  it("keeps headroom_used false for a provider that cannot be proxied while the baseline still compresses", async () => {
    const headroom = new FakeHeadroom("healthy", {});
    const { h, execute } = await setup("headroom", headroom);
    const provider = new ScriptedProvider(replies(), h.clock);
    const { run } = await execute(provider);
    expect(run.headroom_used).toBe(false);
    expect(run.tokens_after_compression).toBeLessThan(run.tokens_before_compression);
    expect(provider.calls).toHaveLength(2);
    expect(headroom.probes).toBe(1);
  });

  it("with the policy off nothing is transformed and nothing is probed; the measurement is honest", async () => {
    const headroom = new FakeHeadroom("healthy", {});
    const { h, execute } = await setup("off", headroom);
    const { run } = await execute(new ScriptedProvider(replies(), h.clock));
    expect(run.tokens_before_compression).toBe(Math.ceil(NOISY_OUTPUT.length / 4));
    expect(run.tokens_after_compression).toBe(run.tokens_before_compression);
    expect(run.context_transforms).toEqual([]);
    expect(run.headroom_used).toBe(false);
    expect(headroom.probes).toBe(0);
  });
});
