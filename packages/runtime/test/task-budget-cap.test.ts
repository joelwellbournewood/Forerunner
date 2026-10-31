import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { LoopTaskExecutor, runCapOf, type SpecialistSpec } from "../src/session/executor.ts";
import {
  flatPricing,
  type Harness,
  harness,
  issue,
  registry,
  ScriptedProvider,
  type ScriptReply,
} from "./helpers.ts";

/**
 * U-042: the budget set on a task is its cap. Before, a run was capped at the plan's estimate
 * (`item.estimateUsdMicro || task.budget_usd_micro || ...`), so a run stopped at the estimate
 * while the Tasks tab showed the budget, and a run that stopped at a task's own cap ended the
 * whole session. Prices here are flat: one token is one micro-USD.
 */

const coder: SpecialistSpec = {
  name: "coder",
  prompt: "You are the coder.",
  promptVersion: "coder@1.0.0+abc12345",
  defaultTier: "sonnet",
  defaultEffort: "medium",
  allowedTools: ["echo"],
  allowedDomains: [],
  // The registry's per-run limit: USD 1.
  maxBudgetUsdMicro: 1_000_000,
  maxTurns: 10,
  timeoutMs: 60_000,
  maxTokens: 1_000,
};

interface World {
  h: Harness;
  store: StateStore;
  agent: string;
  human: string;
  project: string;
}

const stores: StateStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function world(): Promise<World> {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  stores.push(store);
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@x.test",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 100_000_000,
      locale: "en",
    })
  ).id;
  const agent = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: human,
      model_config: {},
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
      budget_usd_micro: 100_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    })
  ).id;
  return { h, store, agent, human, project };
}

async function runTask(
  w: World,
  task: { budget: number; estimate: number; actual?: number },
  replies: ScriptReply[],
  sessionBudgetUsdMicro = 10_000_000,
) {
  const row: TaskRow = await w.store.task.insert({
    project_id: w.project,
    title: "Add health endpoint",
    outcome: "GET /health returns 200",
    acceptance_criteria: ["returns 200"],
    risk_tier: 1,
    status: "in_progress",
    priority: 5,
    depends_on: [],
    budget_usd_micro: task.budget,
    est_cost_usd_micro: task.estimate,
    actual_cost_usd_micro: task.actual ?? 0,
    attempt: 0,
    reason: "seed",
  });
  const session = await w.store.session.insert({
    agent_id: w.agent,
    project_id: w.project,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: sessionBudgetUsdMicro,
    step_cap: 100,
    spent_usd_micro: 0,
    steps: 0,
    status: "running",
    summary: "",
    handoff: {},
    runner: "pc",
  });
  const provider = new ScriptedProvider(replies, w.h.clock);
  const exec = new LoopTaskExecutor({
    store: w.store,
    clock: w.h.clock,
    tokens: w.h.tokens,
    driver: new LoopAgentDriver({ hooks: w.h.hooks, kill: w.h.kill, clock: w.h.clock }),
    provider,
    pricing: flatPricing,
    tools: registry(),
    billingSourceId: "bs",
    specialists: (n) => (n === "coder" ? coder : undefined),
  });
  const result = await exec.execute({
    task: row,
    session,
    token: issue(w.h, {
      agentId: w.agent,
      ownerHumanId: w.human,
      projectId: w.project,
      sessionId: session.id,
      allowedTools: ["echo"],
      budgetUsdMicro: sessionBudgetUsdMicro,
    }),
    budget: new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: sessionBudgetUsdMicro,
      stepCap: 100,
      deadlineMs: w.h.clock.now() + 3_600_000,
      reserveShare: 0.2,
    }),
    // The plan priced the task at its estimate, as the static planner does.
    item: {
      taskId: row.id,
      title: row.title,
      specialist: "coder",
      estimateUsdMicro: task.estimate,
    },
    signal: new AbortController().signal,
  });
  return { result, provider, task: row };
}

/** A first call that spends `spend` micro-USD, then a closing answer. */
const spendThenFinish = (spend: number): ScriptReply[] => [
  { tools: [{ name: "echo", input: { text: "work" } }], usage: { input_tokens: spend } },
  { text: "Added the endpoint.", usage: { input_tokens: 100, output_tokens: 10 } },
];

describe("a task's run is capped at its budget, not at the estimate (U-042)", () => {
  it("a run that spends past the estimate but within the task's budget finishes", async () => {
    const w = await world();
    // Budget USD 2, estimate USD 0.30, the coder's limit USD 1: the first call spends USD 0.40.
    const { result, provider } = await runTask(
      w,
      { budget: 2_000_000, estimate: 300_000 },
      spendThenFinish(400_000),
    );
    expect(result.outcome).toBe("done");
    expect(result.summary).toBe("Added the endpoint.");
    expect(provider.calls).toHaveLength(2);
    // The brief the specialist reads states the budget it is held to.
    expect(provider.calls[0]?.messages[0]?.content as string).toContain(
      "Budget: USD 2.00 (hard cap, enforced)",
    );
  });

  it("a task without a budget is capped at the specialist's limit, not at the estimate", async () => {
    const w = await world();
    const { result } = await runTask(w, { budget: 0, estimate: 300_000 }, spendThenFinish(400_000));
    expect(result.outcome).toBe("done");
  });

  it("a run that reaches the task's budget waits for the person and leaves the session going", async () => {
    const w = await world();
    const { result, provider } = await runTask(
      w,
      { budget: 500_000, estimate: 300_000 },
      spendThenFinish(499_000),
    );
    // The second call would pass the budget: the run stops there, and the task (not the
    // session, which has USD 10) waits for the person with what to do.
    expect(provider.calls).toHaveLength(1);
    expect(result.outcome).toBe("needs_human");
    expect(result.summary).toContain("The run stopped at this task's budget of $0.50");
    expect(result.summary).toContain("Raise the task's budget on the Tasks tab");
    expect(result.costUsdMicro).toBeGreaterThanOrEqual(499_000);
  });

  it("a task whose budget is spent runs nothing and says why", async () => {
    const w = await world();
    const { result, provider } = await runTask(
      w,
      { budget: 500_000, estimate: 300_000, actual: 500_000 },
      spendThenFinish(10),
    );
    expect(provider.calls).toHaveLength(0);
    expect(result).toEqual({
      outcome: "needs_human",
      summary:
        "This task's budget of $0.50 is spent ($0.50 so far), so nothing ran. Raise its budget on the Tasks tab and set it back to ready, or cancel it.",
      costUsdMicro: 0,
    });
  });

  it("a stop at the session's budget is still the session's: budget_exceeded", async () => {
    const w = await world();
    const { result } = await runTask(
      w,
      { budget: 5_000_000, estimate: 300_000 },
      spendThenFinish(449_500),
      450_000,
    );
    expect(result.outcome).toBe("budget_exceeded");
  });

  it("runCapOf: what is left of the task's budget, else the specialist's limit", () => {
    expect(runCapOf({ budget_usd_micro: 2_000_000, actual_cost_usd_micro: 500_000 }, 1)).toEqual({
      usdMicro: 1_500_000,
      source: "task_budget",
    });
    expect(runCapOf({ budget_usd_micro: 0, actual_cost_usd_micro: 0 }, 3_000_000)).toEqual({
      usdMicro: 3_000_000,
      source: "specialist_limit",
    });
  });
});
