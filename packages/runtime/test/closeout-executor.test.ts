import { openStore, type StateStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../src/session/executor.ts";
import {
  flatPricing,
  type Harness,
  harness,
  issue,
  registry,
  ScriptedProvider,
  type ScriptReply,
  until,
} from "./helpers.ts";

/**
 * Requirements close-out for the task executor (spec C.6, D.17): a sub-agent's token is capped
 * by the parent's remaining budget and by the spawn depth, and a run that hits its wall-clock
 * timeout stops cleanly with its partial output on the Run row.
 */

function coder(timeoutMs: number): SpecialistSpec {
  return {
    name: "coder",
    prompt: "You are the coder.",
    promptVersion: "coder@1.0.0+abc12345",
    defaultTier: "sonnet",
    defaultEffort: "medium",
    allowedTools: ["echo", "read_file"],
    allowedDomains: [],
    maxBudgetUsdMicro: 2_000_000,
    maxTurns: 10,
    timeoutMs,
  };
}

async function seed(store: StateStore) {
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
      budget_usd_micro: 1,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
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

function executor(
  h: Harness,
  store: StateStore,
  replies: ScriptReply[],
  spec: SpecialistSpec,
  provider: ScriptedProvider = new ScriptedProvider(replies, h.clock),
) {
  return new LoopTaskExecutor({
    store,
    clock: h.clock,
    tokens: h.tokens,
    driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
    provider,
    pricing: flatPricing,
    tools: registry(),
    billingSourceId: "bs",
    specialists: (n) => (n === "coder" ? spec : undefined),
  });
}

function sessionBudget(h: Harness, sessionId: string, budgetUsdMicro: number): SessionBudget {
  return new SessionBudget({
    sessionId,
    budgetUsdMicro,
    stepCap: 100,
    deadlineMs: h.clock.now() + 3_600_000,
    reserveShare: 0.2,
  });
}

describe("closeout: sub-agent caps (C.6)", () => {
  it("the specialist's token gets the parent's remaining budget when that is the smallest cap, at depth + 1", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const s = await seed(store);
    const exec = executor(h, store, [{ text: "Done." }], coder(60_000));
    const budget = sessionBudget(h, s.session.id, 1_000_000);
    budget.record("an-earlier-run", 700_000);
    expect(budget.remainingUsdMicro()).toBe(300_000);
    const parent = issue(h, {
      agentId: s.agent,
      ownerHumanId: s.human,
      projectId: s.project,
      sessionId: s.session.id,
      allowedTools: ["echo", "read_file"],
      budgetUsdMicro: 5_000_000,
    });
    const res = await exec.execute({
      task: s.task,
      session: s.session,
      token: parent,
      budget,
      // The plan priced the task above the remaining budget; the task's own budget is higher too.
      item: {
        taskId: s.task.id,
        title: s.task.title,
        specialist: "coder",
        estimateUsdMicro: 400_000,
      },
      signal: new AbortController().signal,
    });
    expect(res.outcome).toBe("done");
    const [run] = await store.run.forTask(s.task.id);
    const child = h.tokens.claimsForRun(run?.id ?? "");
    expect(child).toBeDefined();
    expect(child?.budgetUsdMicro).toBe(300_000);
    expect(child?.depth).toBe(1);
    expect(child?.maxDepth).toBe(parent.claims.maxDepth);
    expect(run?.depth).toBe(1);
    await store.close();
  });

  it("a parent already at the maximum depth cannot spawn: the run is refused before anything starts", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const s = await seed(store);
    const exec = executor(h, store, [{ text: "never" }], coder(60_000));
    const parent = issue(h, {
      agentId: s.agent,
      ownerHumanId: s.human,
      projectId: s.project,
      sessionId: s.session.id,
      allowedTools: ["echo", "read_file"],
      depth: 2,
      maxDepth: 2,
    });
    await expect(
      exec.execute({
        task: s.task,
        session: s.session,
        token: parent,
        budget: sessionBudget(h, s.session.id, 5_000_000),
        item: { taskId: s.task.id, title: s.task.title, specialist: "coder", estimateUsdMicro: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "depth_exceeded" });
    expect(await store.run.forTask(s.task.id)).toEqual([]);
    await store.close();
  });
});

describe("closeout: wall-clock timeout of a run (D.17)", () => {
  it("stops cleanly at the specialist's timeout and keeps the partial output on the Run row and in the summary", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const s = await seed(store);
    const replies: ScriptReply[] = [
      { text: "partial answer", tools: [{ name: "echo", input: { text: "a" } }] },
      { ttftMs: 10_000, text: "never" },
    ];
    const provider = new ScriptedProvider(replies, h.clock);
    const exec = executor(h, store, replies, coder(1_000), provider);
    const p = exec.execute({
      task: s.task,
      session: s.session,
      token: issue(h, {
        agentId: s.agent,
        ownerHumanId: s.human,
        projectId: s.project,
        sessionId: s.session.id,
        allowedTools: ["echo", "read_file"],
      }),
      budget: sessionBudget(h, s.session.id, 5_000_000),
      item: {
        taskId: s.task.id,
        title: s.task.title,
        specialist: "coder",
        estimateUsdMicro: 400_000,
      },
      signal: new AbortController().signal,
    });
    // The first call and the tool run take no simulated time. Wait (on real timers) until the
    // second call has reached the provider and sleeps on the simulated clock, then let the
    // deadline pass: a fixed sleep would race the run on a slow machine.
    await until(() => provider.calls.length >= 2, "the second model call");
    await h.clock.advance(1_500);
    await h.clock.advance(10_000);
    const res = await p;
    expect(res.outcome).toBe("timeout");
    expect(res.summary).toBe("partial answer");
    const [run] = await store.run.forTask(s.task.id);
    expect(run).toMatchObject({ outcome: "timeout", timed_out: true });
    expect(run?.duration_ms).not.toBeNull();
    await store.close();
  });
});
