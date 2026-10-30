import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { canonicalSpecialistName } from "../src/registry/specialist-names.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../src/session/executor.ts";
import { flatPricing, harness, issue, registry, ScriptedProvider } from "./helpers.ts";

/**
 * U-014: the project manager planned a task for "ops"; the registry's entry is `ops-deploy`,
 * so the task failed at once ("specialist ops is not in the registry") and spent nothing. A
 * plan's informal name now runs the registry entry it means; a name that means none waits for
 * the person, saying which names exist, instead of failing the same way on every retry.
 */
const ops: SpecialistSpec = {
  name: "ops-deploy",
  prompt: "You deploy.",
  promptVersion: "ops-deploy@1.0.0+abc12345",
  defaultTier: "sonnet",
  defaultEffort: "medium",
  allowedTools: ["echo"],
  allowedDomains: [],
  maxBudgetUsdMicro: 2_000_000,
  maxTurns: 10,
  timeoutMs: 60_000,
};

async function world() {
  const h = harness();
  const clock = h.clock;
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = (await store.human.insert({ name: "J", email: "j@x.test" })).id;
  const agent = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
  const project = (await store.project.insert({ name: "P" })).id;
  const session = await store.session.insert({
    agent_id: agent,
    project_id: project,
    trigger: "manual",
    status: "running",
    runner: "pc",
  });
  const provider = new ScriptedProvider([{ text: "Done." }], clock);
  const exec = new LoopTaskExecutor({
    store,
    clock,
    tokens: h.tokens,
    driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock }),
    provider,
    pricing: flatPricing,
    tools: registry(),
    billingSourceId: "bs",
    specialists: (n) => (n === "ops-deploy" ? ops : undefined),
    specialistNames: () => ["coder", "ops-deploy"],
  });
  const token = issue(h, {
    agentId: agent,
    ownerHumanId: human,
    projectId: project,
    allowedTools: ["echo"],
    budgetUsdMicro: 5_000_000,
    sessionId: session.id,
  });
  const run = async (specialist: string) => {
    const task = await store.task.insert({
      project_id: project,
      title: "Deploy the site",
      outcome: "the site is live",
      acceptance_criteria: ["the URL answers"],
      risk_tier: 1,
      status: "in_progress",
      specialist,
      reason: "seed",
    });
    const result = await exec.execute({
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
      item: { taskId: task.id, title: task.title, specialist, estimateUsdMicro: 300_000 },
      signal: new AbortController().signal,
    });
    return {
      result,
      task: await store.task.mustGet(task.id),
      runs: await store.run.forTask(task.id),
    };
  };
  return { run, close: () => store.close() };
}

describe("specialist names a plan uses (U-014)", () => {
  it("maps the project manager's informal names to the registry's", () => {
    expect(canonicalSpecialistName("ops")).toBe("ops-deploy");
    expect(canonicalSpecialistName("Data Analyst")).toBe("data-analyst");
    expect(canonicalSpecialistName("science evaluator")).toBe("science-evaluator");
    expect(canonicalSpecialistName("writer")).toBe("writer-marketing");
    expect(canonicalSpecialistName("migration_specialist")).toBe("migration-specialist");
    expect(canonicalSpecialistName("coder")).toBe("coder");
  });

  it('a task planned for "ops" runs ops-deploy, and the task then names it', async () => {
    const w = await world();
    try {
      const { result, task, runs } = await w.run("ops");
      expect(result.summary).not.toMatch(/not in the registry/);
      expect(runs).toHaveLength(1);
      expect(task.specialist).toBe("ops-deploy");
    } finally {
      await w.close();
    }
  });

  it("a name that means no specialist waits for the person and says which names exist", async () => {
    const w = await world();
    try {
      const { result, runs } = await w.run("wizard");
      expect(result).toEqual({
        outcome: "needs_human",
        summary:
          'No specialist is named "wizard", so nothing ran. The specialists are: coder, ops-deploy.',
        costUsdMicro: 0,
      });
      expect(runs).toEqual([]);
    } finally {
      await w.close();
    }
  });
});
