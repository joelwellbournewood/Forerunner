import { BUILTIN_PRICING, type PricingTable } from "@forerunner/billing";
import { openStore, type StateStore } from "@forerunner/state";
import { FakeProvider } from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver, type RunEvent, type RunPricing } from "../src/agent/loop.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { FAST_MODE_AUDIT_TOOL } from "../src/models/fast-mode.ts";
import type { ProviderCapabilities } from "../src/provider/types.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../src/session/executor.ts";
import { budget, flatPricing, harness, issue, registry } from "./helpers.ts";

/**
 * Spec D.4 (ADR 0072): the settings per agent and specialist reach the model request. The loop
 * honours max tokens and sends a temperature or a speed only where the provider's capability
 * flags allow; the executor resolves the effort table, the registry file and the agent's
 * `model_config` override, and sends `speed: "fast"` only where the project allows it: D.20's
 * `decideFastMode` decides, with the run's explicit speed mode as one more input.
 */

const fake = (capabilities: Partial<ProviderCapabilities> = {}) =>
  new FakeProvider({ latency: "none", capabilities });

function driver(h: ReturnType<typeof harness>) {
  return new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock });
}

describe("the loop and the provider's capability flags", () => {
  const run = (h: ReturnType<typeof harness>, provider: FakeProvider, extra: object) =>
    driver(h).run({
      token: issue(h),
      budget: budget("sess-1", 5_000_000, h.clock),
      provider,
      model: "fake-opus",
      billingSourceId: "bs",
      system: "s",
      messages: [{ role: "user", content: "hello" }],
      tools: registry(),
      pricing: flatPricing,
      timeoutMs: 60_000,
      ...extra,
    });

  it("sends the run's max tokens on every call, 4096 when the run names none", async () => {
    const h = harness();
    const p = fake();
    await run(h, p, { maxTokensPerCall: 1234 });
    expect(p.calls[0]?.request.max_tokens).toBe(1234);
    await run(h, p, {});
    expect(p.calls[1]?.request.max_tokens).toBe(4096);
  });

  it("sends a temperature only to a provider whose flag accepts one", async () => {
    const h = harness();
    const refuses = fake({ acceptsTemperature: false });
    await run(h, refuses, { temperature: 0.4 });
    expect(refuses.calls[0]?.request).not.toHaveProperty("temperature");
    const accepts = fake({ acceptsTemperature: true });
    await run(h, accepts, { temperature: 0.4 });
    expect(accepts.calls[0]?.request.temperature).toBe(0.4);
    await run(h, accepts, {});
    expect(accepts.calls[1]?.request).not.toHaveProperty("temperature");
  });

  it("sends speed fast only to a provider with fast mode", async () => {
    const h = harness();
    const slow = fake({ fastMode: false });
    await run(h, slow, { speed: "fast" });
    expect(slow.calls[0]?.request).not.toHaveProperty("speed");
    const fast = fake({ fastMode: true });
    await run(h, fast, { speed: "fast" });
    expect(fast.calls[0]?.request.speed).toBe("fast");
    await run(h, fast, {});
    expect(fast.calls[1]?.request).not.toHaveProperty("speed");
  });
});

const coder: SpecialistSpec = {
  name: "coder",
  prompt: "You are the coder.",
  promptVersion: "coder@1.0.0+abc12345",
  defaultTier: "sonnet",
  defaultEffort: "medium",
  allowedTools: ["echo"],
  allowedDomains: [],
  maxBudgetUsdMicro: 2_000_000,
  maxTurns: 10,
  timeoutMs: 20 * 60_000,
};

async function seed(store: StateStore, modelConfig: object, projectSettings: object) {
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@x.test",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 1,
      locale: "en",
    })
  ).id;
  const agent = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: human,
      model_config: modelConfig as never,
      memory_location: "l",
      status: "active",
      kind: "principal",
    })
  ).id;
  const project = (
    await store.project.insert({
      name: "P",
      goal: "g",
      repos: [],
      stage: "s",
      status: "active",
      budget_usd_micro: 1,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: projectSettings as never,
      small_project_mode: false,
      active: true,
    })
  ).id;
  const task = await store.task.insert({
    project_id: project,
    title: "Add health endpoint",
    outcome: "GET /health returns 200",
    acceptance_criteria: ["returns 200"],
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
  const session = await store.session.insert({
    agent_id: agent,
    project_id: project,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 5_000_000,
    step_cap: 100,
    spent_usd_micro: 0,
    steps: 0,
    status: "running",
    summary: "",
    handoff: {},
    runner: "pc",
  });
  return { human, agent, project, task, session };
}

interface ExecOptions {
  spec?: SpecialistSpec;
  modelConfig?: object;
  projectSettings?: object;
  capabilities?: Partial<ProviderCapabilities>;
  /** The price table in force (D.20): fast mode needs the variant's row. Default: built-ins. */
  pricingTable?: PricingTable;
  pricingFor?: (model: string) => RunPricing;
}

async function runTask(o: ExecOptions = {}) {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  const w = await seed(store, o.modelConfig ?? {}, o.projectSettings ?? {});
  const provider = fake(o.capabilities);
  const events: RunEvent[] = [];
  const spec = o.spec ?? coder;
  const exec = new LoopTaskExecutor({
    store,
    clock: h.clock,
    tokens: h.tokens,
    driver: driver(h),
    provider,
    pricing: flatPricing,
    tools: registry(),
    billingSourceId: "bs",
    specialists: (n) => (n === spec.name ? spec : undefined),
    onEvent: (_t, ev) => events.push(ev),
    ...(o.pricingTable ? { pricingTable: () => o.pricingTable as PricingTable } : {}),
    ...(o.pricingFor ? { pricingFor: o.pricingFor } : {}),
  });
  const token = issue(h, {
    agentId: w.agent,
    ownerHumanId: w.human,
    projectId: w.project,
    allowedTools: ["echo"],
    budgetUsdMicro: 5_000_000,
    sessionId: w.session.id,
  });
  const res = await exec.execute({
    task: w.task,
    session: w.session,
    token,
    budget: new SessionBudget({
      sessionId: w.session.id,
      budgetUsdMicro: 5_000_000,
      stepCap: 100,
      deadlineMs: h.clock.now() + 3_600_000,
      reserveShare: 0.2,
    }),
    item: {
      taskId: w.task.id,
      title: w.task.title,
      specialist: spec.name,
      estimateUsdMicro: 1_000_000,
    },
    signal: new AbortController().signal,
  });
  const runs = await store.run.forTask(w.task.id);
  const audit = await store.auditLog.list({ tool: FAST_MODE_AUDIT_TOOL });
  await store.close();
  return { res, provider, events, run: runs[0], audit };
}

const warnings = (events: RunEvent[]) =>
  events.filter((e) => e.type === "warning").map((e) => (e as { message: string }).message);

describe("the executor honours the D.4 settings of a specialist run", () => {
  it("uses the effort table's row when neither the file nor the agent names a value", async () => {
    const { res, provider, run } = await runTask();
    expect(res.outcome).toBe("done");
    const req = provider.calls[0]?.request;
    expect(req?.max_tokens).toBe(4096);
    expect(req).not.toHaveProperty("speed");
    expect(req).not.toHaveProperty("temperature");
    expect(run).toMatchObject({ model: "fake-sonnet", effort: "medium" });
  });

  it("uses the registry file's max tokens and temperature where the provider accepts one", async () => {
    const spec = { ...coder, maxTokens: 2500, temperature: 0.2 };
    const refused = await runTask({ spec });
    expect(refused.provider.calls[0]?.request.max_tokens).toBe(2500);
    expect(refused.provider.calls[0]?.request).not.toHaveProperty("temperature");
    const accepted = await runTask({ spec, capabilities: { acceptsTemperature: true } });
    expect(accepted.provider.calls[0]?.request.temperature).toBe(0.2);
  });

  it("lets the agent's model_config override the file: rung, effort, max tokens, timeout", async () => {
    const { provider, run, events } = await runTask({
      spec: { ...coder, maxTokens: 2500 },
      modelConfig: {
        specialists: {
          coder: { tier: "opus", effort: "high", max_tokens: 9000, timeout_minutes: 7 },
        },
      },
    });
    expect(provider.calls[0]?.request.max_tokens).toBe(9000);
    expect(provider.calls[0]?.request.effort).toBe("high");
    expect(provider.calls[0]?.request.model).toBe("fake-opus");
    expect(run).toMatchObject({ model: "fake-opus", effort: "high" });
    expect(warnings(events)).toEqual([]);
  });

  it("prices the run as the model it calls when the agent changes the rung", async () => {
    const priced: string[] = [];
    const perModel = (model: string): RunPricing => {
      priced.push(model);
      const k = model === "fake-opus" ? 5 : 1;
      return {
        estimate: (i, o) => k * (i + o),
        cost: (u) => k * (u.input_tokens + u.output_tokens),
      };
    };
    const table = await runTask({ pricingFor: perModel });
    const opus = await runTask({
      pricingFor: perModel,
      modelConfig: { specialists: { coder: { tier: "opus" } } },
    });
    expect(priced).toEqual(["fake-sonnet", "fake-opus"]);
    expect(opus.provider.calls[0]?.request.model).toBe("fake-opus");
    // Same tokens, five times the price: the override is not priced at the sonnet rung.
    expect(opus.res.costUsdMicro).toBe(5 * table.res.costUsdMicro);
  });

  it("never runs a specialist above its max_effort: not by the agent's override, not by the offset", async () => {
    const capped = { ...coder, maxEffort: "medium" as const };
    const override = await runTask({
      spec: capped,
      modelConfig: { specialists: { coder: { effort: "max" } } },
    });
    expect(override.provider.calls[0]?.request.effort).toBe("medium");
    expect(override.run).toMatchObject({ effort: "medium" });
    expect(warnings(override.events).join("\n")).toMatch(
      /coder runs at effort medium, its max_effort/,
    );
    // The project's speed-versus-quality slider at +1 (spec D.16, medium -> high) stops at the
    // cap too; the slider is read from the project row the run loads.
    const quality = { speed_quality_offset: 1 };
    const offset = await runTask({ spec: capped, projectSettings: quality });
    expect(offset.provider.calls[0]?.request.effort).toBe("medium");
    expect(
      (await runTask({ projectSettings: quality })).provider.calls[0]?.request.effort,
    ).toBe("high");
    // Without the cap the override is what runs.
    const free = await runTask({ modelConfig: { specialists: { coder: { effort: "max" } } } });
    expect(free.provider.calls[0]?.request.effort).toBe("max");
  });

  it("gives the run the overridden timeout: the brief names it instead of the file's", async () => {
    const brief = (r: Awaited<ReturnType<typeof runTask>>) =>
      r.provider.calls[0]?.request.messages[0]?.content as string;
    const file = await runTask({});
    expect(brief(file)).toContain("- Timeout: 1200 s");
    const overridden = await runTask({
      modelConfig: { specialists: { coder: { timeout_minutes: 2 } } },
    });
    expect(brief(overridden)).toContain("- Timeout: 120 s");
    expect(overridden.run?.outcome).toBe("completed");
  });

  it("ignores a malformed model_config, says so, and keeps the defaults", async () => {
    const { provider, events } = await runTask({
      modelConfig: { specialists: { coder: { max_tokens: "lots" } } },
    });
    expect(provider.calls[0]?.request.max_tokens).toBe(4096);
    expect(warnings(events).join("\n")).toMatch(/model settings are malformed.*max_tokens/);
  });
});

describe("speed mode: a specialist's fast only takes effect where the project allows it", () => {
  const fastPrice: RunPricing = {
    estimate: (i, o) => 6 * (i + o),
    cost: (u) => 6 * (u.input_tokens + u.output_tokens),
  };
  // The fake ladder's Opus rung with its fast-mode variant row (D.20: never priced from a guess).
  const withFastRow: PricingTable = {
    ...BUILTIN_PRICING,
    "fake-opus": { ...(BUILTIN_PRICING["claude-opus-5-5"] as PricingTable[string]) },
    "fake-opus-fast": { ...(BUILTIN_PRICING["claude-opus-5-5-fast"] as PricingTable[string]) },
  };
  const fastSetup: ExecOptions = {
    spec: { ...coder, defaultTier: "opus", speedMode: "fast" },
    projectSettings: { fast_mode: true },
    capabilities: { fastMode: true },
    pricingTable: withFastRow,
    // Every run priced by the model its records name: the variant at the fast price.
    pricingFor: (model) => (model.endsWith("-fast") ? fastPrice : flatPricing),
  };

  it("sends speed fast and prices the run at the fast row when every condition holds", async () => {
    const { provider, run, res, events } = await runTask(fastSetup);
    expect(provider.calls[0]?.request.speed).toBe("fast");
    expect(run?.model).toBe("fake-opus-fast");
    expect(run?.artifacts).toContainEqual({ speed: "fast" });
    const standard = await runTask({
      ...fastSetup,
      spec: { ...coder, defaultTier: "opus", speedMode: "standard" },
    });
    expect(standard.provider.calls[0]?.request).not.toHaveProperty("speed");
    // Same tokens, six times the price: the fast run was priced at the fast row.
    expect(res.costUsdMicro).toBe(6 * standard.res.costUsdMicro);
    expect(warnings(events)).toEqual([]);
  });

  it("leaves a specialist without a speed preference to the project's flag (D.20 unchanged)", async () => {
    const noPreference = await runTask({ ...fastSetup, spec: { ...coder, defaultTier: "opus" } });
    expect(noPreference.provider.calls[0]?.request.speed).toBe("fast");
    expect(noPreference.run?.model).toBe("fake-opus-fast");
    const projectOff = await runTask({
      ...fastSetup,
      spec: { ...coder, defaultTier: "opus" },
      projectSettings: {},
    });
    expect(projectOff.provider.calls[0]?.request).not.toHaveProperty("speed");
    expect(warnings(projectOff.events)).toEqual([]);
  });

  it("stays standard without the project's leave and says why", async () => {
    const { provider, events } = await runTask({ ...fastSetup, projectSettings: {} });
    expect(provider.calls[0]?.request).not.toHaveProperty("speed");
    expect(warnings(events).join("\n")).toMatch(
      /asks for fast mode but this run stays at the standard speed: the project does not allow fast mode/,
    );
  });

  it("stays standard off the Opus rung, without a fast-mode price, or on a provider without it", async () => {
    const sonnet = await runTask({ ...fastSetup, spec: { ...coder, speedMode: "fast" } });
    expect(sonnet.provider.calls[0]?.request).not.toHaveProperty("speed");
    expect(warnings(sonnet.events).join("\n")).toMatch(/Opus only/);
    const unpriced = await runTask({ ...fastSetup, pricingTable: BUILTIN_PRICING });
    expect(unpriced.provider.calls[0]?.request).not.toHaveProperty("speed");
    expect(warnings(unpriced.events).join("\n")).toMatch(/no fast-mode price/);
    const noFast = await runTask({ ...fastSetup, capabilities: { fastMode: false } });
    expect(noFast.provider.calls[0]?.request).not.toHaveProperty("speed");
    expect(warnings(noFast.events).join("\n")).toMatch(/no fast mode/);
  });

  it("an agent's speed_mode override turns fast on for one specialist, and standard off", async () => {
    const on = await runTask({
      ...fastSetup,
      spec: { ...coder, defaultTier: "opus" },
      projectSettings: {},
      modelConfig: { specialists: { coder: { speed_mode: "fast" } } },
    });
    // Without the project's leave the agent's fast is not enough.
    expect(on.provider.calls[0]?.request).not.toHaveProperty("speed");
    const allowed = await runTask({
      ...fastSetup,
      spec: { ...coder, defaultTier: "opus", speedMode: "standard" },
      modelConfig: { specialists: { coder: { speed_mode: "fast" } } },
    });
    expect(allowed.provider.calls[0]?.request.speed).toBe("fast");
    const off = await runTask({
      ...fastSetup,
      modelConfig: { specialists: { coder: { speed_mode: "standard" } } },
    });
    expect(off.provider.calls[0]?.request).not.toHaveProperty("speed");
    // D.20 records every decision that meets an Opus rung: ignored, with the reason.
    expect(off.audit[0]?.result_summary).toMatch(/^ignored: the run's speed mode is standard/);
    expect(warnings(off.events).join("\n")).toMatch(/speed mode is standard/);
  });
});
