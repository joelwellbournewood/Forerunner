import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import {
  BUILTIN_PRICING,
  costOf,
  mergePricing,
  type PricingTable,
  parsePricingOverrides,
} from "@forerunner/billing";
import { ForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { FAKE_MODELS, FakeProvider, type ScriptedReply } from "@forerunner/testenv";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { type EvalDriver, type EvalTask, runEvalSet } from "../../../evals/src/index.ts";
import { effortForTask, modelIdFor } from "../src/models/ladder.ts";
import {
  FetchPriceListSource,
  FixturePriceListSource,
  type PriceList,
  priceListUrlFromEnv,
} from "../src/models/price-list.ts";
import {
  applyModelSettings,
  builtinModelConfig,
  FileModelSettingsStore,
  MemoryModelSettingsStore,
  type ModelSettingsStore,
  parseModelSettings,
} from "../src/models/settings.ts";
import {
  answerFromHumanRequest,
  DEFAULT_WATCH_THRESHOLDS,
  diffModels,
  diffPrices,
  type EvalObservation,
  type EvalRunInput,
  type EvalRunnerPort,
  isModelWatchRequest,
  MODEL_WATCH_AGENT_ID,
  MODEL_WATCH_CHANNEL,
  ModelWatch,
  type ModelWatchAdoptedEvent,
  type ModelWatchApprovalOutcome,
  type ModelWatchApprovalPort,
  type ModelWatchApprovalRequest,
  type ModelWatchEvalsRequestedEvent,
  ModelWatchReportSchema,
  recommendLowerEffort,
  recommendSwitch,
  StateModelWatchApprovals,
  scheduleModelWatch,
  WEEK_MINUTES,
} from "../src/models/watch.ts";
import { registerModelWatchCli } from "../src/models/watch-cli.ts";
import { createModelWatchRoutes } from "../src/models/watch-routes.ts";
import { ProviderRegistry } from "../src/provider/registry.ts";
import type {
  ModelProvider,
  ModelRef,
  ModelRequest,
  ModelResponse,
} from "../src/provider/types.ts";
import { memoryFiredKeys, Scheduler, type StartRequest } from "../src/session/triggers.ts";

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const PRICING: PricingTable = mergePricing(BUILTIN_PRICING, {
  "fake-haiku": {
    input_per_mtok_usd: 1,
    output_per_mtok_usd: 5,
    cache_read_per_mtok_usd: 0.1,
    cache_write_per_mtok_usd: 1.25,
    as_of: "2026-10-01",
  },
  "fake-sonnet": {
    input_per_mtok_usd: 3,
    output_per_mtok_usd: 15,
    cache_read_per_mtok_usd: 0.3,
    cache_write_per_mtok_usd: 3.75,
    as_of: "2026-10-01",
  },
  "fake-opus": {
    input_per_mtok_usd: 15,
    output_per_mtok_usd: 75,
    cache_read_per_mtok_usd: 1.5,
    cache_write_per_mtok_usd: 18.75,
    as_of: "2026-10-01",
  },
  "fake-fable": {
    input_per_mtok_usd: 30,
    output_per_mtok_usd: 150,
    cache_read_per_mtok_usd: 3,
    cache_write_per_mtok_usd: 37.5,
    as_of: "2026-10-01",
  },
});

/** fake-sonnet input repriced -20%; fake-sonnet-6 is new and half the price; fake-haiku unchanged. */
const PRICE_LIST: PriceList = {
  as_of: "2026-10-19",
  source: "fixture",
  models: {
    "fake-sonnet": { input_per_mtok_usd: 2.4, output_per_mtok_usd: 15 },
    "fake-sonnet-6": { input_per_mtok_usd: 1.5, output_per_mtok_usd: 7.5 },
    "fake-haiku": { input_per_mtok_usd: 1, output_per_mtok_usd: 5 },
  },
};

/** The provider lists: the ladder minus fake-opus (retired), plus a priced and an unpriced new model. */
const LISTED: ModelRef[] = [
  ...FAKE_MODELS.filter((m) => m.id !== "fake-opus"),
  { provider: "fake", id: "fake-sonnet-6", tier: "sonnet" },
  { provider: "fake", id: "fake-mystery", tier: "opus" },
];

class ListingProvider implements ModelProvider {
  readonly name = "fake";
  constructor(
    private readonly inner: FakeProvider,
    private readonly models: ModelRef[],
  ) {}
  async listModels(): Promise<ModelRef[]> {
    return this.models.map((m) => ({ ...m }));
  }
  stream(req: ModelRequest) {
    return this.inner.stream(req);
  }
  complete(req: ModelRequest): Promise<ModelResponse> {
    return this.inner.complete(req);
  }
  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }
}

const USAGE_MEDIUM = { input_tokens: 1000, output_tokens: 500 };
const USAGE_LOW = { input_tokens: 1000, output_tokens: 250 };

/** Scripted replies: every eval task asks "<taskId> <effort>"; the fake answers PASS or FAIL. */
function replies(
  opts: { lowFailsTask?: string; candidateFailsTask?: string } = {},
): ScriptedReply[] {
  const out: ScriptedReply[] = [];
  if (opts.lowFailsTask)
    out.push({
      when: { model: "fake-sonnet", lastUserIncludes: `${opts.lowFailsTask} low` },
      reply: { text: "FAIL", usage: USAGE_LOW },
      times: Number.POSITIVE_INFINITY,
    });
  if (opts.candidateFailsTask)
    out.push({
      when: { model: "fake-sonnet-6", lastUserIncludes: `${opts.candidateFailsTask} medium` },
      reply: { text: "FAIL", usage: USAGE_MEDIUM },
      times: Number.POSITIVE_INFINITY,
    });
  out.push(
    {
      when: { model: "fake-sonnet", lastUserIncludes: "medium" },
      reply: { text: "PASS", usage: USAGE_MEDIUM },
      times: Number.POSITIVE_INFINITY,
    },
    {
      when: { model: "fake-sonnet", lastUserIncludes: "low" },
      reply: { text: "PASS", usage: USAGE_LOW },
      times: Number.POSITIVE_INFINITY,
    },
    {
      when: { model: "fake-sonnet-6" },
      reply: { text: "PASS", usage: USAGE_MEDIUM },
      times: Number.POSITIVE_INFINITY,
    },
  );
  return out;
}

const EVAL_TASKS: EvalTask[] = [1, 2, 3, 4].map((n) => ({
  id: `coder-00${n}`,
  specialist: "coder",
  title: `Synthetic coder task ${n}`,
  brief: {
    goal: `Answer PASS for synthetic task ${n} when the work is done.`,
    contextLinks: ["none"],
    constraints: ["none stated"],
    acceptanceCriteria: ["the final text contains PASS"],
    budgetUsdMicro: 100_000,
    riskTier: 1,
  },
  setup: { files: {} },
  checks: [{ kind: "file_contains", text: "PASS", expect: "present" }],
  tags: [],
}));

/** The production shape: the evals runner from @forerunner/evals driven by the (fake) provider. */
function evalRunner(
  provider: ModelProvider,
  clock: SimulatedClock,
  workRoot: string,
): EvalRunnerPort {
  return {
    async run(input) {
      const driver: EvalDriver = async ({ task, workDir }) => {
        const res = await provider.complete({
          model: input.model,
          effort: input.effort,
          max_tokens: 64,
          messages: [{ role: "user", content: `${task.id} ${input.effort}` }],
        });
        const text = res.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        const usdMicro = costOf(
          { tokens_in: res.usage.input_tokens, tokens_out: res.usage.output_tokens },
          input.model,
          input.pricing,
        );
        return { outputDir: workDir, finalText: text, cost: { usdMicro, model: input.model } };
      };
      const r = await runEvalSet({
        specialist: input.specialist,
        tasks: EVAL_TASKS,
        driver,
        clock,
        workRoot: join(workRoot, `${input.model}-${input.effort}`),
      });
      return {
        total: r.summary.total,
        passed: r.summary.passed,
        failed: r.summary.failed,
        needsModel: r.summary.needsModel,
        passRate: r.summary.passRate,
        costUsdMicro: r.summary.costUsdMicro,
        durationMs: r.summary.durationMs,
      };
    },
  };
}

class FakeApprovals implements ModelWatchApprovalPort {
  readonly requests: ModelWatchApprovalRequest[] = [];
  constructor(private readonly outcome: ModelWatchApprovalOutcome) {}
  async ask(req: ModelWatchApprovalRequest): Promise<ModelWatchApprovalOutcome> {
    this.requests.push(req);
    return this.outcome;
  }
}

interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  provider: FakeProvider;
  registry: ProviderRegistry;
  settings: MemoryModelSettingsStore;
  workRoot: string;
}

async function world(
  opts: { replies?: ScriptedReply[]; listed?: ModelRef[] } = {},
): Promise<World> {
  const clock = new SimulatedClock("2026-10-19T06:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
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
  const provider = new FakeProvider({
    replies: opts.replies ?? replies(),
    latency: "none",
    clock,
    onNoMatch: "throw",
  });
  const registry = new ProviderRegistry().register(
    new ListingProvider(provider, opts.listed ?? LISTED),
  );
  const settings = new MemoryModelSettingsStore(() => clock.nowIso());
  const workRoot = mkdtempSync(join(os.tmpdir(), "fr-model-watch-"));
  return { store, clock, human, provider, registry, settings, workRoot };
}

function watchFor(
  w: World,
  over: {
    approvals?: ModelWatchApprovalPort;
    settings?: ModelSettingsStore;
    priceList?: PriceList;
    thresholds?: Partial<typeof DEFAULT_WATCH_THRESHOLDS>;
    evals?: EvalRunnerPort;
    onAdopted?: (event: ModelWatchAdoptedEvent) => void | Promise<void>;
    /** The human's opt-in to paid evals. The eval maths tests opt in; the consent tests do not. */
    autoEvals?: (() => boolean) | null;
    onEvalsRequested?: (event: ModelWatchEvalsRequestedEvent) => void | Promise<void>;
    signal?: AbortSignal;
  } = {},
): ModelWatch {
  const autoEvals = over.autoEvals === undefined ? () => true : over.autoEvals;
  return new ModelWatch({
    ...(autoEvals ? { autoEvals } : {}),
    ...(over.onEvalsRequested ? { onEvalsRequested: over.onEvalsRequested } : {}),
    ...(over.signal ? { signal: over.signal } : {}),
    clock: w.clock,
    store: w.store,
    providers: w.registry,
    priceList: new FixturePriceListSource(over.priceList ?? PRICE_LIST),
    evals: over.evals ?? evalRunner(w.registry.get("fake"), w.clock, w.workRoot),
    approvals: over.approvals ?? new FakeApprovals({ status: "pending", requestId: null }),
    settings: over.settings ?? w.settings,
    humanId: w.human,
    agentId: "alice",
    pricing: PRICING,
    evalTargets: [{ specialist: "coder", mode: "coder" }],
    thresholds: over.thresholds,
    onAdopted: over.onAdopted,
  });
}

const obs = (over: Partial<EvalObservation>): EvalObservation => ({
  specialist: "coder",
  mode: "coder",
  provider: "fake",
  model: "fake-sonnet",
  tier: "sonnet",
  effort: "medium",
  role: "baseline",
  total: 10,
  passed: 8,
  failed: 2,
  needs_model: 0,
  pass_rate: 0.8,
  cost_usd_micro: 1000,
  duration_ms: 0,
  skipped_reason: null,
  ...over,
});

let worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds) {
    await w.store.close();
    rmSync(w.workRoot, { recursive: true, force: true });
  }
  worlds = [];
});
async function make(opts?: Parameters<typeof world>[0]): Promise<World> {
  const w = await world(opts);
  worlds.push(w);
  return w;
}

// ---------------------------------------------------------------------------------------
// Diff detection and report content
// ---------------------------------------------------------------------------------------

describe("model watch: diff detection", () => {
  it("detects new, retired, repriced and unpriced models against the ladder and the pricing table", async () => {
    const w = await make();
    const r = await watchFor(w).run();
    const d = r.report.diff;
    expect(d.new_models.map((m) => [m.id, m.priced, m.price_origin])).toEqual([
      ["fake-sonnet-6", true, "price_list"],
      ["fake-mystery", false, "none"],
    ]);
    expect(d.retired_models).toEqual([
      { provider: "fake", id: "fake-opus", tier: "opus", rung_affected: true },
    ]);
    expect(d.unpriced).toEqual([{ provider: "fake", id: "fake-mystery", tier: "opus" }]);
    expect(d.repriced).toHaveLength(1);
    expect(d.repriced[0]?.model).toBe("fake-sonnet");
    expect(d.repriced[0]?.changes).toEqual([
      { field: "input_per_mtok_usd", before: 3, after: 2.4, delta_pct: -20 },
    ]);
    expect(r.report.price_list).toMatchObject({
      source: "fixture",
      as_of: "2026-10-19",
      models: 3,
    });
  });

  it("never assumes a price: an unpriced model is reported, not evaluated, and gets no recommendation", async () => {
    const w = await make();
    const r = await watchFor(w).run();
    expect(r.report.evals.some((e) => e.model === "fake-mystery")).toBe(false);
    expect(
      r.report.recommendations.some((x) => x.kind === "switch_model" && x.to === "fake-mystery"),
    ).toBe(false);
    expect(r.report.pricing_proposal["fake-mystery"]).toBeUndefined();
    const steps = (await w.store.release.list({ channel: MODEL_WATCH_CHANNEL }))[0];
    expect(steps).toBeDefined();
    expect(JSON.stringify(steps?.artifacts)).toContain("fake-mystery");
  });

  it("pure diff helpers: priced from the table beats the list, cache prices follow the list multipliers", () => {
    const cfg = builtinModelConfig();
    const d = diffModels(
      { fake: [...FAKE_MODELS, { provider: "fake", id: "fake-sonnet-6", tier: "sonnet" }] },
      cfg.ladder,
      mergePricing(PRICING, {
        "fake-sonnet-6": {
          input_per_mtok_usd: 9,
          output_per_mtok_usd: 9,
          cache_read_per_mtok_usd: 9,
          cache_write_per_mtok_usd: 9,
          as_of: "2026-01-01",
        },
      }),
      PRICE_LIST,
    );
    expect(d.new_models[0]?.price_origin).toBe("table");
    expect(d.retired_models).toEqual([]);
    const fromList = diffModels(
      { fake: [{ provider: "fake", id: "fake-sonnet-6", tier: "sonnet" }] },
      cfg.ladder,
      PRICING,
      PRICE_LIST,
    );
    expect(fromList.new_models[0]?.price).toEqual({
      input_per_mtok_usd: 1.5,
      output_per_mtok_usd: 7.5,
      cache_read_per_mtok_usd: 0.15,
      cache_write_per_mtok_usd: 1.875,
      as_of: "2026-10-19",
      source: "list",
    });
    const p = diffPrices(PRICING, PRICE_LIST);
    expect(p.repriced.map((x) => x.model)).toEqual(["fake-sonnet"]);
    expect(p.proposal["fake-sonnet"]).toMatchObject({
      input_per_mtok_usd: 2.4,
      as_of: "2026-10-19",
      source: "list",
    });
    expect(p.proposal["fake-haiku"]).toBeUndefined();
  });

  it("the report validates against its schema and carries the proposal, costs and deltas", async () => {
    const w = await make();
    const r = await watchFor(w).run();
    expect(ModelWatchReportSchema.safeParse(r.report).success).toBe(true);
    // Evals are costed at the latest known prices (the proposal applied), so deltas compare like
    // with like: 4 tasks x (1000 in x 2.4 + 500 out x 15) = 39_600 at medium on fake-sonnet.
    const baseline = r.report.evals.find((e) => e.role === "baseline" && e.model === "fake-sonnet");
    expect(baseline).toMatchObject({ total: 4, passed: 4, pass_rate: 1, cost_usd_micro: 39_600 });
    const sw = r.report.recommendations.find((x) => x.kind === "switch_model");
    expect(sw).toMatchObject({
      rung: "sonnet",
      from: "fake-sonnet",
      to: "fake-sonnet-6",
      quality_delta_points: 0,
      cost_delta_pct: -46.97,
    });
    const le = r.report.recommendations.find((x) => x.kind === "lower_effort");
    expect(le).toMatchObject({ mode: "coder", from: "medium", to: "low", cost_delta_pct: -37.88 });
    expect(Object.keys(r.report.pricing_proposal).sort()).toEqual(["fake-sonnet", "fake-sonnet-6"]);
    expect(r.report.eval_cost_usd_micro).toBe(39_600 + 24_600 + 21_000);
    expect(r.report.summary).toContain("2 new, 1 retired, 1 repriced, 1 unpriced");
    expect(r.report.summary).toContain("Switch rung sonnet");
  });

  it("recommendation maths: switch on cost saving or on quality gain within the cost ceiling, never on a quality loss", () => {
    const base = obs({});
    const pair = (candidate: EvalObservation) => ({
      id: "s",
      provider: "fake",
      rung: "sonnet" as const,
      from: "fake-sonnet",
      to: "fake-x",
      pairs: [
        { target: { specialist: "coder", mode: "coder" as const }, baseline: base, candidate },
      ],
    });
    const cheaper = recommendSwitch(
      pair(obs({ model: "fake-x", role: "candidate", cost_usd_micro: 800 })),
    );
    expect(cheaper).toMatchObject({ quality_delta_points: 0, cost_delta_pct: -20 });
    const better = recommendSwitch(
      pair(
        obs({
          model: "fake-x",
          role: "candidate",
          passed: 9,
          failed: 1,
          pass_rate: 0.9,
          cost_usd_micro: 1200,
        }),
      ),
    );
    expect(better).toMatchObject({ quality_delta_points: 10, cost_delta_pct: 20 });
    expect(
      recommendSwitch(
        pair(
          obs({
            model: "fake-x",
            role: "candidate",
            passed: 9,
            failed: 1,
            pass_rate: 0.9,
            cost_usd_micro: 1300,
          }),
        ),
      ),
    ).toBeNull();
    expect(
      recommendSwitch(pair(obs({ model: "fake-x", role: "candidate", cost_usd_micro: 950 }))),
    ).toBeNull();
    expect(
      recommendSwitch(
        pair(
          obs({
            model: "fake-x",
            role: "candidate",
            passed: 7,
            failed: 3,
            pass_rate: 0.7,
            cost_usd_micro: 100,
          }),
        ),
      ),
    ).toBeNull();
    expect(
      recommendSwitch(
        pair(
          obs({
            model: "fake-x",
            role: "candidate",
            total: 2,
            passed: 2,
            failed: 0,
            pass_rate: 1,
            cost_usd_micro: 10,
          }),
        ),
        { ...DEFAULT_WATCH_THRESHOLDS, minEvalTasks: 3 },
      ),
    ).toBeNull();
  });

  it("recommendation maths: a lower effort needs the baseline pass rate and a saving", () => {
    const target = { specialist: "coder", mode: "coder" as const };
    const base = obs({});
    const ok = recommendLowerEffort({
      id: "l",
      target,
      baseline: base,
      lower: obs({ role: "lower_effort", effort: "low", cost_usd_micro: 700 }),
    });
    expect(ok).toMatchObject({ from: "medium", to: "low", cost_delta_pct: -30 });
    expect(
      recommendLowerEffort({
        id: "l",
        target,
        baseline: base,
        lower: obs({
          role: "lower_effort",
          effort: "low",
          passed: 7,
          failed: 3,
          pass_rate: 0.7,
          cost_usd_micro: 700,
        }),
      }),
    ).toBeNull();
    expect(
      recommendLowerEffort({
        id: "l",
        target,
        baseline: base,
        lower: obs({ role: "lower_effort", effort: "low", cost_usd_micro: 990 }),
      }),
    ).toBeNull();
    expect(
      recommendLowerEffort({
        id: "l",
        target,
        baseline: base,
        lower: obs({
          role: "lower_effort",
          effort: "low",
          cost_usd_micro: 0,
          skipped_reason: "budget_exceeded: cap",
        }),
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Evals on the fake provider
// ---------------------------------------------------------------------------------------

describe("model watch: evals through the evals runner on the fake provider", () => {
  it("a candidate that passes the scripted eval set is recommended; one that fails a task is not", async () => {
    const good = await make();
    const r1 = await watchFor(good).run();
    expect(r1.report.recommendations.filter((x) => x.kind === "switch_model")).toHaveLength(1);
    const cand = r1.report.evals.find((e) => e.role === "candidate");
    expect(cand).toMatchObject({
      model: "fake-sonnet-6",
      passed: 4,
      total: 4,
      cost_usd_micro: 21_000,
    });
    expect(good.provider.calls.filter((c) => c.request.model === "fake-sonnet-6")).toHaveLength(4);

    const bad = await make({ replies: replies({ candidateFailsTask: "coder-003" }) });
    const r2 = await watchFor(bad).run();
    expect(r2.report.recommendations.filter((x) => x.kind === "switch_model")).toHaveLength(0);
    expect(r2.report.evals.find((e) => e.role === "candidate")).toMatchObject({
      passed: 3,
      failed: 1,
    });
  });

  it("a lower effort is recommended only when it passes the whole set", async () => {
    const passes = await make();
    const r1 = await watchFor(passes).run();
    expect(r1.report.recommendations.filter((x) => x.kind === "lower_effort")).toHaveLength(1);
    expect(passes.provider.calls.some((c) => c.request.effort === "low")).toBe(true);

    const fails = await make({ replies: replies({ lowFailsTask: "coder-002" }) });
    const r2 = await watchFor(fails).run();
    expect(r2.report.recommendations.filter((x) => x.kind === "lower_effort")).toHaveLength(0);
    expect(r2.report.evals.find((e) => e.role === "lower_effort")).toMatchObject({
      passed: 3,
      failed: 1,
      pass_rate: 0.75,
    });
  });

  it("the eval budget is enforced in code: evals past the cap are skipped with budget_exceeded", async () => {
    const w = await make();
    const r = await watchFor(w, { thresholds: { evalBudgetUsdMicro: 50_000 } }).run();
    const cand = r.report.evals.find((e) => e.role === "candidate");
    expect(cand?.skipped_reason).toMatch(/^budget_exceeded:/);
    expect(r.report.recommendations.filter((x) => x.kind === "switch_model")).toHaveLength(0);
    expect(r.report.eval_cost_usd_micro).toBe(39_600 + 24_600);
    expect(r.report.skipped.some((s) => s.includes("budget_exceeded"))).toBe(true);
    expect(w.provider.calls.filter((c) => c.request.model === "fake-sonnet-6")).toHaveLength(0);
  });

  it("a provider that fails to list and a price list that fails to load land in the report, not in an exception", async () => {
    const w = await make();
    const broken: ModelProvider = {
      name: "broken",
      async listModels() {
        throw new Error("boom");
      },
      stream: w.provider.stream.bind(w.provider),
      complete: w.provider.complete.bind(w.provider),
      countTokens: (t) => t.length,
    };
    w.registry.register(broken);
    const watch = new ModelWatch({
      clock: w.clock,
      store: w.store,
      providers: w.registry,
      priceList: {
        name: "down",
        async fetch() {
          throw new Error("offline");
        },
      },
      evals: evalRunner(w.registry.get("fake"), w.clock, w.workRoot),
      approvals: new FakeApprovals({ status: "pending", requestId: null }),
      settings: w.settings,
      humanId: w.human,
      pricing: PRICING,
      evalTargets: [{ specialist: "coder", mode: "coder" }],
      evalProvider: "fake",
      autoEvals: () => true,
    });
    const r = await watch.run();
    expect(r.report.providers.find((p) => p.name === "broken")?.error).toBe("boom");
    expect(r.report.price_list.error).toBe("offline");
    // Without a price list the new fake-sonnet-6 has no price and is not tested.
    expect(r.report.diff.unpriced.map((u) => u.id).sort()).toEqual([
      "fake-mystery",
      "fake-sonnet-6",
    ]);
    expect(r.report.diff.repriced).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Human approval: nothing changes without a yes
// ---------------------------------------------------------------------------------------

describe("model watch: proposals need a human", () => {
  it("pending: the report is persisted as a model_watch release, a decision is asked, nothing is written", async () => {
    const w = await make();
    const approvals = new FakeApprovals({ status: "pending", requestId: "hr-1" });
    const r = await watchFor(w, { approvals }).run();
    expect(r.decision).toBe("pending");
    expect(r.requestId).toBe("hr-1");
    expect(approvals.requests).toHaveLength(1);
    expect(approvals.requests[0]?.options).toEqual(["adopt", "ignore", "remind"]);
    expect(approvals.requests[0]?.steps.join("\n")).toContain("Switch rung sonnet");
    expect(w.settings.writes).toEqual({ pricing: 0, models: 0 });
    expect(w.settings.settings).toBeNull();
    const releases = await w.store.release.list({ channel: MODEL_WATCH_CHANNEL });
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ status: "published", release_version: r.report.id });
    expect(releases[0]?.health).toMatchObject({ decision: "pending", request_id: "hr-1" });
    const effective = applyModelSettings(
      await w.settings.readModelSettings(),
      builtinModelConfig(),
    );
    expect(effective.ladder.find((x) => x.tier === "sonnet")?.models.fake).toBe("fake-sonnet");
    expect(effective.modeDefaults.coder.effort).toBe("medium");
  });

  it("adopt: pricing overrides and the ladder/effort settings are written, the release is installed, every step is audited", async () => {
    const w = await make();
    const approvals = new FakeApprovals({
      status: "answered",
      answer: { decision: "adopt", by: w.human },
    });
    const r = await watchFor(w, { approvals }).run();
    expect(r.decision).toBe("adopted");
    expect(r.applied).toEqual([
      "pricing overrides written for fake-sonnet, fake-sonnet-6",
      "ladder sonnet/fake: fake-sonnet -> fake-sonnet-6",
      "effort coder: medium -> low",
    ]);
    expect(w.settings.pricing["fake-sonnet"]).toMatchObject({
      input_per_mtok_usd: 2.4,
      as_of: "2026-10-19",
    });
    expect(w.settings.pricing["fake-sonnet-6"]).toMatchObject({
      input_per_mtok_usd: 1.5,
      output_per_mtok_usd: 7.5,
    });
    expect(mergePricing(PRICING, w.settings.pricing)["fake-sonnet-6"]?.output_per_mtok_usd).toBe(
      7.5,
    );
    const settings = await w.settings.readModelSettings();
    expect(settings.ladder.sonnet).toEqual({ fake: "fake-sonnet-6" });
    expect(settings.efforts.coder).toBe("low");
    expect(settings.history[0]).toMatchObject({ report_id: r.report.id, by: w.human });
    const effective = applyModelSettings(settings, builtinModelConfig());
    expect(effective.ladder.find((x) => x.tier === "sonnet")?.models).toEqual({
      anthropic: "claude-sonnet-5-5",
      fake: "fake-sonnet-6",
    });
    expect(effective.modeDefaults.coder.effort).toBe("low");
    expect(effective.modeDefaults.planning.effort).toBe("high");
    expect(r.release.status).toBe("installed");
    expect(r.release.health).toMatchObject({ decision: "adopted", by: w.human });
    const tools = (await w.store.auditLog.list({ humanId: w.human })).map((a) => a.tool);
    for (const t of [
      "model_watch.price_list",
      "model_watch.eval",
      "model_watch.report",
      "model_watch.request",
      "model_watch.write_pricing",
      "model_watch.write_settings",
      "model_watch.decision",
    ])
      expect(tools).toContain(t);
    expect(tools.filter((t) => t === "model_watch.eval")).toHaveLength(3);
  });

  it("onAdopted hands the daemon the pricing and config now in force; a failing hook is audited and the adoption stands", async () => {
    const w = await make();
    const seen: ModelWatchAdoptedEvent[] = [];
    const r = await watchFor(w, {
      approvals: new FakeApprovals({
        status: "answered",
        answer: { decision: "adopt", by: w.human },
      }),
      onAdopted: (e) => {
        seen.push(e);
      },
    }).run();
    expect(r.decision).toBe("adopted");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ reportId: r.report.id, by: w.human, applied: r.applied });
    expect(seen[0]?.config.ladder.find((x) => x.tier === "sonnet")?.models).toEqual({
      anthropic: "claude-sonnet-5-5",
      fake: "fake-sonnet-6",
    });
    expect(seen[0]?.config.modeDefaults.coder.effort).toBe("low");
    expect(seen[0]?.pricing["fake-sonnet-6"]?.output_per_mtok_usd).toBe(7.5);
    expect(seen[0]?.pricing["fake-sonnet"]?.input_per_mtok_usd).toBe(2.4);
    const reloaded = (await w.store.auditLog.list({ humanId: w.human })).find(
      (a) => a.tool === "model_watch.reload",
    );
    expect(reloaded).toMatchObject({ allowed: true });

    // ignore and remind never fire it.
    const w2 = await make();
    const fired: string[] = [];
    await watchFor(w2, {
      approvals: new FakeApprovals({
        status: "answered",
        answer: { decision: "ignore", by: w2.human },
      }),
      onAdopted: () => {
        fired.push("ignore");
      },
    }).run();
    expect(fired).toEqual([]);

    // A hook that throws: the files stay written, the release stays installed, the failure is
    // an audit row with allowed=false, and the caller sees the adoption.
    const w3 = await make();
    const r3 = await watchFor(w3, {
      approvals: new FakeApprovals({
        status: "answered",
        answer: { decision: "adopt", by: w3.human },
      }),
      onAdopted: () => {
        throw new Error("reload failed");
      },
    }).run();
    expect(r3.decision).toBe("adopted");
    expect(r3.release.status).toBe("installed");
    expect((await w3.settings.readModelSettings()).efforts.coder).toBe("low");
    const failed = (await w3.store.auditLog.list({ humanId: w3.human })).find(
      (a) => a.tool === "model_watch.reload",
    );
    expect(failed).toMatchObject({ allowed: false });
    expect(failed?.result_summary).toContain("reload failed");
  });

  it("adopt with the file store writes <config>/pricing.json and <config>/models.json that parse back", async () => {
    const w = await make();
    const configDir = join(w.workRoot, "config");
    const files = new FileModelSettingsStore({ configDir, nowIso: () => w.clock.nowIso() });
    expect(existsSync(join(configDir, "pricing.json"))).toBe(false);
    const pending = await watchFor(w, { settings: files }).run();
    expect(existsSync(join(configDir, "pricing.json"))).toBe(false);
    expect(existsSync(join(configDir, "models.json"))).toBe(false);
    await watchFor(w, { settings: files }).resolve(pending.report.id, {
      decision: "adopt",
      by: w.human,
    });
    const pricing = parsePricingOverrides(readFileSync(join(configDir, "pricing.json"), "utf8"));
    expect(pricing["fake-sonnet-6"]).toMatchObject({ input_per_mtok_usd: 1.5, source: "list" });
    const models = parseModelSettings(readFileSync(join(configDir, "models.json"), "utf8"));
    expect(models.ladder.sonnet?.fake).toBe("fake-sonnet-6");
    expect(models.efforts.coder).toBe("low");
    expect(await files.readPricingOverrides()).toEqual(pricing);
  });

  it("ignore and remind record the decision and change nothing", async () => {
    const w = await make();
    const ignored = await watchFor(w, {
      approvals: new FakeApprovals({
        status: "answered",
        answer: { decision: "ignore", by: w.human },
      }),
    }).run();
    expect(ignored.decision).toBe("ignored");
    expect(ignored.release.status).toBe("published");
    const remind = await watchFor(w, {
      approvals: new FakeApprovals({
        status: "answered",
        answer: { decision: "remind", by: w.human },
      }),
    }).run();
    expect(remind.decision).toBe("remind");
    expect(remind.release.health).toMatchObject({
      decision: "remind",
      remind_at: new Date(w.clock.now() + WEEK_MINUTES * 60_000).toISOString(),
    });
    expect(w.settings.writes).toEqual({ pricing: 0, models: 0 });
  });

  it("adopt is refused without a human's recorded answer and cannot be applied twice; unknown ids are rejected", async () => {
    const w = await make();
    const watch = watchFor(w);
    const r = await watch.run();
    await expect(watch.resolve(r.report.id, { decision: "adopt" })).rejects.toMatchObject({
      code: "approval_required",
    });
    expect(w.settings.writes).toEqual({ pricing: 0, models: 0 });
    await expect(
      watch.resolve(r.report.id, { decision: "adopt", by: w.human, adopt: ["nope"] }),
    ).rejects.toMatchObject({ code: "validation" });
    await watch.resolve(r.report.id, { decision: "adopt", by: w.human });
    await expect(
      watch.resolve(r.report.id, { decision: "ignore", by: w.human }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      watch.resolve("missing", { decision: "ignore", by: w.human }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("a partial adopt applies only the chosen recommendations", async () => {
    const w = await make();
    const watch = watchFor(w);
    const r = await watch.run();
    const lower = r.report.recommendations.find((x) => x.kind === "lower_effort");
    const out = await watch.resolve(r.report.id, {
      decision: "adopt",
      by: w.human,
      adopt: [lower?.id ?? ""],
    });
    expect(out.applied).toEqual(["effort coder: medium -> low"]);
    expect(w.settings.writes).toEqual({ pricing: 0, models: 1 });
    expect((await w.settings.readModelSettings()).ladder.sonnet).toBeUndefined();
  });

  it("nothing to decide: when the listing matches the ladder and prices are unchanged no request is opened", async () => {
    const w = await make({ listed: [...FAKE_MODELS] });
    const approvals = new FakeApprovals({ status: "pending", requestId: null });
    const quiet: PriceList = {
      as_of: "2026-10-19",
      models: { "fake-sonnet": { input_per_mtok_usd: 3, output_per_mtok_usd: 15 } },
    };
    const r = await watchFor(w, {
      approvals,
      priceList: quiet,
      thresholds: { minEffortSavingPct: 50 },
    }).run();
    expect(r.decision).toBe("nothing_to_decide");
    expect(approvals.requests).toHaveLength(0);
    expect(r.report.recommendations).toEqual([]);
  });

  it("production port: a HumanRequest is opened and its answer closes the loop through syncPendingAnswers", async () => {
    const w = await make();
    const watch = watchFor(w, {
      approvals: new StateModelWatchApprovals(w.store, { agentId: "alice" }),
    });
    const r = await watch.run();
    expect(r.decision).toBe("pending");
    const open = await w.store.humanRequest.open({ humanId: w.human });
    expect(open).toHaveLength(1);
    const req = open[0];
    expect(req).toMatchObject({
      kind: "decision",
      options: ["adopt", "ignore", "remind"],
      blocking: false,
    });
    expect(req?.change_card).toMatchObject({ key: `model_watch:${r.report.id}` });
    expect(r.requestId).toBe(req?.id);
    expect(await watch.syncPendingAnswers()).toBe(0);
    expect(w.settings.writes).toEqual({ pricing: 0, models: 0 });
    await w.store.humanRequest.answer(req?.id ?? "", req?.version ?? 1, "adopt", w.human);
    expect(answerFromHumanRequest(await w.store.humanRequest.mustGet(req?.id ?? ""))).toEqual({
      decision: "adopt",
      by: w.human,
    });
    expect(await watch.syncPendingAnswers()).toBe(1);
    expect(w.settings.writes).toEqual({ pricing: 1, models: 1 });
    expect((await watch.getReport(r.report.id)).health.decision).toBe("adopted");
    expect(await watch.syncPendingAnswers()).toBe(0);
  });

  it("answers in several shapes are read; unreadable ones are not", () => {
    const row = (answer: unknown) =>
      ({ answer, answered_by: "h1" }) as unknown as Parameters<typeof answerFromHumanRequest>[0];
    expect(answerFromHumanRequest(row("Adopt"))).toEqual({ decision: "adopt", by: "h1" });
    expect(answerFromHumanRequest(row("remind next week"))).toEqual({
      decision: "remind",
      by: "h1",
    });
    expect(answerFromHumanRequest(row({ choice: "ignore" }))).toEqual({
      decision: "ignore",
      by: "h1",
    });
    expect(answerFromHumanRequest(row({ decision: "adopt", adopt: ["switch-1"] }))).toEqual({
      decision: "adopt",
      by: "h1",
      adopt: ["switch-1"],
    });
    expect(answerFromHumanRequest(row("maybe"))).toBeNull();
    expect(answerFromHumanRequest(row(42))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Price list sources
// ---------------------------------------------------------------------------------------

describe("price list sources", () => {
  it("fetches and validates a JSON price list; bad documents and HTTP failures never become prices", async () => {
    const calls: string[] = [];
    const src = new FetchPriceListSource({
      url: "https://prices.example.test/claude.json",
      fetch: async (url) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...PRICE_LIST,
            models: {
              "Anthropic.Claude-Sonnet-5-5@20260101": {
                input_per_mtok_usd: 2,
                output_per_mtok_usd: 10,
              },
            },
          }),
        };
      },
    });
    const list = await src.fetch();
    expect(calls).toEqual(["https://prices.example.test/claude.json"]);
    expect(Object.keys(list.models)).toEqual(["claude-sonnet-5-5"]);
    const bad = new FetchPriceListSource({
      url: "https://p.example.test/x",
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ models: { a: { input_per_mtok_usd: -1 } } }),
      }),
    });
    await expect(bad.fetch()).rejects.toMatchObject({ code: "validation" });
    const down = new FetchPriceListSource({
      url: "https://p.example.test/x",
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    await expect(down.fetch()).rejects.toMatchObject({ code: "unavailable", retryable: true });
    const net = new FetchPriceListSource({
      url: "https://p.example.test/x",
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    await expect(net.fetch()).rejects.toMatchObject({ code: "unavailable" });
    expect(() => new FetchPriceListSource({ url: "ftp://x" })).toThrow();
    expect(
      priceListUrlFromEnv({ FORERUNNER_PRICE_LIST_URL: " https://p.example.test/l.json " }),
    ).toBe("https://p.example.test/l.json");
    expect(priceListUrlFromEnv({})).toBeUndefined();
  });

  it("the fixture source rejects a malformed list up front and canonicalises ids", () => {
    expect(() => new FixturePriceListSource({ as_of: "yesterday", models: {} })).toThrow();
    const s = new FixturePriceListSource({
      as_of: "2026-10-19",
      models: { "FAKE-SONNET-latest": { input_per_mtok_usd: 1, output_per_mtok_usd: 2 } },
    });
    return expect(s.fetch()).resolves.toMatchObject({
      models: { "fake-sonnet": { input_per_mtok_usd: 1 } },
    });
  });
});

// ---------------------------------------------------------------------------------------
// Weekly trigger
// ---------------------------------------------------------------------------------------

describe("model watch: weekly trigger", () => {
  it("registers a weekly schedule the Scheduler fires once per week as a model watch request", async () => {
    const clock = new SimulatedClock("2026-10-19T06:00:00Z");
    const started: StartRequest[] = [];
    const scheduler = new Scheduler(
      { clock, start: async (req) => void started.push(req) },
      60_000,
    );
    const schedule = scheduleModelWatch(scheduler, { timezone: "Europe/Zurich" });
    expect(schedule).toMatchObject({
      id: "model-watch-weekly",
      agentId: MODEL_WATCH_AGENT_ID,
      kind: "every",
      everyMinutes: WEEK_MINUTES,
      enabled: true,
    });
    expect(scheduler.list().map((s) => s.id)).toEqual(["model-watch-weekly"]);
    await scheduler.tick();
    expect(started).toHaveLength(1);
    expect(isModelWatchRequest(started[0] as StartRequest)).toBe(true);
    expect(isModelWatchRequest({ agentId: "alice", trigger: "schedule", reason: "" })).toBe(false);
    expect(
      isModelWatchRequest({ agentId: MODEL_WATCH_AGENT_ID, trigger: "manual", reason: "" }),
    ).toBe(false);
    await clock.advance(6 * 24 * 60 * 60_000);
    await scheduler.tick();
    expect(started).toHaveLength(1);
    await clock.advance(1 * 24 * 60 * 60_000);
    await scheduler.tick();
    expect(started).toHaveLength(2);
  });

  it("a daemon restarted within the week does not run the watch again: the last run is kept in the fired store", async () => {
    // 2026-10-26: two short daemon sessions on a fresh install each ran the watch at their
    // first tick, because the weekly schedule's last run lived only in process memory.
    const clock = new SimulatedClock("2026-10-26T00:40:00Z");
    const fired = memoryFiredKeys();
    const started: StartRequest[] = [];
    const boot = () => {
      const s = new Scheduler(
        { clock, fired, start: async (req) => void started.push(req) },
        60_000,
      );
      scheduleModelWatch(s, { timezone: "Europe/Zurich" });
      return s;
    };
    await boot().tick();
    expect(started).toHaveLength(1);
    await clock.advance(90 * 60_000);
    await boot().tick();
    expect(started).toHaveLength(1);
    await clock.advance(3 * 24 * 60 * 60_000);
    await boot().tick();
    expect(started).toHaveLength(1);
    await clock.advance(4 * 24 * 60 * 60_000);
    const again = boot();
    await again.tick();
    expect(started).toHaveLength(2);
    // Once fired in this process, the in-memory mark still applies.
    await again.tick();
    expect(started).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------
// Paid evals need the human's consent (ADR 0089; the 2026-10-26 fresh-install incident)
// ---------------------------------------------------------------------------------------

/** An eval runner that records its calls and never spends anything. */
class CountingEvals implements EvalRunnerPort {
  readonly calls: EvalRunInput[] = [];
  constructor(private readonly onRun?: (input: EvalRunInput, n: number) => Promise<void> | void) {}
  async run(input: EvalRunInput) {
    this.calls.push(input);
    await this.onRun?.(input, this.calls.length);
    return {
      total: 4,
      passed: 4,
      failed: 0,
      needsModel: 0,
      passRate: 1,
      costUsdMicro: 1000,
      durationMs: 1,
    };
  }
}

describe("model watch: paid evals need the human's consent", () => {
  it("by default (no opt-in) a run checks lists and prices, runs no eval and puts the planned evals to the human", async () => {
    const w = await make();
    const evals = new CountingEvals();
    const approvals = new FakeApprovals({ status: "pending", requestId: "hr-1" });
    const r = await watchFor(w, { evals, approvals, autoEvals: null }).run();
    expect(evals.calls).toHaveLength(0);
    expect(w.provider.calls).toHaveLength(0);
    expect(r.report.evals).toEqual([]);
    expect(r.report.eval_cost_usd_micro).toBe(0);
    // The free part still works: the diff, the repricing proposal and the decision request.
    expect(r.report.diff.new_models.map((m) => m.id)).toContain("fake-sonnet-6");
    expect(r.report.recommendations.map((x) => x.kind)).toEqual(["reprice"]);
    expect(r.report.evals_deferred?.reason).toMatch(/consent/);
    const planned = r.report.evals_deferred?.planned ?? [];
    expect(planned.map((p) => `${p.role}:${p.model}@${p.effort}`)).toEqual([
      "baseline:fake-sonnet@medium",
      "lower_effort:fake-sonnet@low",
      "candidate:fake-sonnet-6@medium",
    ]);
    expect(r.decision).toBe("pending");
    expect(approvals.requests[0]?.options).toEqual(["adopt", "evaluate", "ignore", "remind"]);
    expect(approvals.requests[0]?.steps.join("\n")).toMatch(/Evaluations not run/);
    expect(ModelWatchReportSchema.safeParse(r.report).success).toBe(true);
  });

  it("an opt-in setting that is off stays off; an explicit run({ evals: true }) runs them", async () => {
    const w = await make();
    const evals = new CountingEvals();
    const watch = watchFor(w, { evals, autoEvals: () => false });
    await watch.run();
    expect(evals.calls).toHaveLength(0);
    const r = await watch.run({ evals: true });
    expect(evals.calls.length).toBe(3);
    expect(r.report.evals_deferred).toBeNull();
    expect(r.report.evals.every((e) => e.skipped_reason === null)).toBe(true);
  });

  it("a report with nothing new and evals withheld asks nothing (no weekly nag for lower-effort probes)", async () => {
    const w = await make({ listed: [...FAKE_MODELS] });
    const evals = new CountingEvals();
    const approvals = new FakeApprovals({ status: "pending", requestId: "hr-1" });
    const r = await watchFor(w, {
      evals,
      approvals,
      autoEvals: null,
      priceList: { as_of: "2026-10-19", models: {} },
    }).run();
    expect(evals.calls).toHaveLength(0);
    expect(r.decision).toBe("nothing_to_decide");
    expect(approvals.requests).toHaveLength(0);
  });

  it("'evaluate' writes nothing and asks the daemon to run the evals; so does 'adopt' on a report whose evals were withheld", async () => {
    const w = await make();
    const requested: ModelWatchEvalsRequestedEvent[] = [];
    const watch = watchFor(w, {
      evals: new CountingEvals(),
      autoEvals: null,
      onEvalsRequested: (ev) => void requested.push(ev),
    });
    const first = await watch.run();
    const ev = await watch.resolve(first.report.id, { decision: "evaluate", by: w.human });
    expect(ev.decision).toBe("evaluate");
    expect(ev.applied).toEqual([]);
    expect(w.settings.writes).toEqual({ pricing: 0, models: 0 });
    expect(requested).toEqual([{ reportId: first.report.id, by: w.human }]);
    await expect(watch.resolve(first.report.id, { decision: "evaluate" })).rejects.toMatchObject({
      code: "approval_required",
    });

    const second = await watch.run();
    const adopted = await watch.resolve(second.report.id, { decision: "adopt", by: w.human });
    expect(adopted.decision).toBe("adopted");
    expect(w.settings.writes.pricing).toBe(1);
    expect(requested.map((r) => r.reportId)).toEqual([first.report.id, second.report.id]);
  });

  it("reads 'evaluate' and 'run evaluations' answers from the inbox", () => {
    const row = (answer: unknown) =>
      ({ answer, answered_by: "h1" }) as unknown as Parameters<typeof answerFromHumanRequest>[0];
    expect(answerFromHumanRequest(row("evaluate"))).toEqual({ decision: "evaluate", by: "h1" });
    expect(answerFromHumanRequest(row("Run evaluations"))).toEqual({
      decision: "evaluate",
      by: "h1",
    });
    expect(answerFromHumanRequest(row({ decision: "run evals" }))).toEqual({
      decision: "evaluate",
      by: "h1",
    });
  });

  it("a cap stop ends the run's evals: no later eval reaches the runner", async () => {
    const w = await make();
    const evals = new CountingEvals(() => {
      throw new ForerunnerError("budget_exceeded", "month cap reached");
    });
    const r = await watchFor(w, { evals }).run();
    expect(evals.calls).toHaveLength(1);
    expect(r.report.evals.map((e) => e.skipped_reason?.split(":")[0])).toEqual([
      "budget_exceeded",
      "budget_exceeded",
      "budget_exceeded",
    ]);
  });

  it("an abort (daemon stopping) ends the run: no eval starts after it and run() rejects", async () => {
    const w = await make();
    const stop = new AbortController();
    const evals = new CountingEvals((input) => {
      expect(input.signal?.aborted).toBe(false);
      stop.abort(new ForerunnerError("killed", "daemon stopping"));
    });
    const watch = watchFor(w, { evals, signal: stop.signal });
    await expect(watch.run()).rejects.toMatchObject({ code: "killed" });
    expect(evals.calls).toHaveLength(1);
    await watch.settled();
    const rows = await w.store.release.list({ channel: MODEL_WATCH_CHANNEL }, { limit: 10 });
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// CLI and routes
// ---------------------------------------------------------------------------------------

describe("model watch: fr models watch|report and routes", () => {
  it("fr models report says when there is nothing, fr models watch runs and prints, report --json prints the report", async () => {
    const w = await make();
    const watch = watchFor(w);
    const lines: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerModelWatchCli(program, () => ({ watch, out: (l) => lines.push(l) }));
    await program.parseAsync(["models", "report"], { from: "user" });
    expect(lines.join("\n")).toContain("No model watch report yet");
    lines.length = 0;
    await program.parseAsync(["models", "watch"], { from: "user" });
    const text = lines.join("\n");
    expect(text).toContain("Model watch 2026-10-19");
    expect(text).toContain("=> [switch-");
    expect(text).toContain("Decision: pending");
    lines.length = 0;
    await program.parseAsync(["models", "report", "--json"], { from: "user" });
    const parsed = JSON.parse(lines.join("\n")) as {
      report: { id: string };
      health: { decision: string };
    };
    expect(ModelWatchReportSchema.safeParse(parsed.report).success).toBe(true);
    expect(parsed.health.decision).toBe("pending");
    lines.length = 0;
    await program.parseAsync(["models", "report", "--list"], { from: "user" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(parsed.report.id);
  });

  it("routes: list, read, answer (with the human id) and 404 for unknown reports", async () => {
    const w = await make();
    const watch = watchFor(w);
    const app = createModelWatchRoutes({ watch });
    const run = await app.request("/run", { method: "POST" });
    expect(run.status).toBe(200);
    const ran = (await run.json()) as { report: { id: string }; decision: string };
    expect(ran.decision).toBe("pending");
    const list = (await (await app.request("/reports")).json()) as {
      reports: { id: string; decision: string }[];
    };
    expect(list.reports).toHaveLength(1);
    expect(list.reports[0]).toMatchObject({
      id: ran.report.id,
      decision: "pending",
      recommendations: 3,
    });
    expect((await app.request("/reports/nope")).status).toBe(404);
    const noBy = await app.request(`/reports/${ran.report.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "adopt" }),
    });
    expect(noBy.status).toBe(400);
    expect(w.settings.writes).toEqual({ pricing: 0, models: 0 });
    const yes = await app.request(`/reports/${ran.report.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "adopt", by: w.human }),
    });
    expect(yes.status).toBe(200);
    expect(await yes.json()).toMatchObject({ decision: "adopted", status: "installed" });
    expect(w.settings.writes).toEqual({ pricing: 1, models: 1 });
    const latest = (await (await app.request("/reports/latest")).json()) as {
      health: { decision: string };
    };
    expect(latest.health.decision).toBe("adopted");
    expect(await (await app.request("/sync", { method: "POST" })).json()).toEqual({ resolved: 0 });
  });
});

describe("model settings", () => {
  it("the file store round-trips and refuses malformed documents", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "fr-model-settings-"));
    try {
      const clock = new SimulatedClock("2026-10-19T06:00:00Z");
      const store = new FileModelSettingsStore({ configDir: dir, nowIso: () => clock.nowIso() });
      expect(await store.readModelSettings()).toEqual({
        version: 1,
        updated_at: clock.nowIso(),
        ladder: {},
        efforts: {},
        history: [],
      });
      await store.writeModelSettings({
        version: 1,
        updated_at: clock.nowIso(),
        ladder: { opus: { anthropic: "claude-opus-6" } },
        efforts: { routing: "low" },
        history: [],
      });
      expect((await store.readModelSettings()).ladder.opus).toEqual({ anthropic: "claude-opus-6" });
      expect(() => parseModelSettings('{"version": 2}')).toThrow();
      expect(() => parseModelSettings("not json")).toThrow();
      await expect(
        store.writePricingOverrides({ "new-model": { input_per_mtok_usd: 1 } }),
      ).resolves.toBeUndefined();
      expect(store.describe().pricing.endsWith("pricing.json")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an adopted models.json changes the rung the executor picks and the effort a task runs at", () => {
    const adopted = applyModelSettings(
      {
        version: 1,
        updated_at: "2026-10-19T06:00:00.000Z",
        ladder: { sonnet: { fake: "fake-sonnet-6" } },
        efforts: { coder: "low" },
        history: [],
      },
      builtinModelConfig(),
    );
    expect(modelIdFor("sonnet", "fake", adopted.ladder)).toBe("fake-sonnet-6");
    expect(modelIdFor("sonnet", "anthropic", adopted.ladder)).toBe("claude-sonnet-5-5");
    expect(modelIdFor("sonnet", "fake")).toBe("fake-sonnet");
    expect(effortForTask("coder", 1, 0, adopted.modeDefaults)).toBe("low");
    expect(effortForTask("coder", 1)).toBe("medium");
    // Tier 2+ coding stays at high whatever was adopted; the project offset still applies.
    expect(effortForTask("coder", 2, 0, adopted.modeDefaults)).toBe("high");
    expect(effortForTask("coder", 1, 1, adopted.modeDefaults)).toBe("medium");
    expect(effortForTask("planning", 1, 0, adopted.modeDefaults)).toBe("high");
  });
});
