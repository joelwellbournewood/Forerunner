import { criticSettingsOf } from "@forerunner/critic";
import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../src/session/executor.ts";
import { flatPricing, harness, issue, registry, ScriptedProvider } from "./helpers.ts";

/**
 * The retry ladder's escalation rung (spec D.2, D.3) under the project's ceiling: a task on
 * its third retry climbs one rung, but never above `project.settings.critic_ceiling`. The
 * executor reads the ceiling per run through `projectCeiling` (what the daemon passes); with
 * nothing passed the ladder's default ceiling (opus) applies, which is the bug this pins.
 */
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
  timeoutMs: 60_000,
};

/**
 * One executor over one project; `run` executes a fresh task on its third retry and returns
 * the model its run used. The project row stays editable between runs (`setSettings`).
 */
async function ladderWorld(settings: Record<string, unknown>, projectCeiling: boolean) {
  const h = harness();
  const clock = h.clock;
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = (await store.human.insert({ name: "J", email: "j@x.test" })).id;
  const agent = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
  const project = (await store.project.insert({ name: "P", settings })).id;
  const session = await store.session.insert({
    agent_id: agent,
    project_id: project,
    trigger: "manual",
    status: "running",
    runner: "pc",
  });
  const provider = new ScriptedProvider(
    [{ text: "Done." }, { text: "Done." }, { text: "Done." }],
    clock,
  );
  const exec = new LoopTaskExecutor({
    store,
    clock,
    tokens: h.tokens,
    driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock }),
    provider,
    pricing: flatPricing,
    tools: registry(),
    billingSourceId: "bs",
    specialists: (n) => (n === "coder" ? coder : undefined),
    ...(projectCeiling ? { projectCeiling: (s) => criticSettingsOf(s).ceiling } : {}),
  });
  const token = issue(h, {
    agentId: agent,
    ownerHumanId: human,
    projectId: project,
    allowedTools: ["echo"],
    budgetUsdMicro: 5_000_000,
    sessionId: session.id,
  });
  const run = async (title: string): Promise<string> => {
    const task = await store.task.insert({
      project_id: project,
      title,
      outcome: "done",
      acceptance_criteria: ["works"],
      risk_tier: 1,
      status: "in_progress",
      budget_usd_micro: 500_000,
      est_cost_usd_micro: 300_000,
      attempt: 3,
      reason: "seed",
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
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 300_000 },
      signal: new AbortController().signal,
    });
    expect(res.outcome).toBe("done");
    return (await store.run.forTask(task.id))[0]?.model ?? "";
  };
  return {
    run,
    setSettings: async (next: Record<string, unknown>) => {
      await store.project.patch(project, { settings: next });
    },
    close: () => store.close(),
  };
}

async function runAtAttempt3(
  settings: Record<string, unknown>,
  projectCeiling: boolean,
): Promise<string> {
  const world = await ladderWorld(settings, projectCeiling);
  try {
    return await world.run("Third retry");
  } finally {
    await world.close();
  }
}

describe("the retry ladder under the project's ceiling", () => {
  it("a project ceiling of sonnet never escalates the third retry to opus", async () => {
    expect(await runAtAttempt3({ critic_ceiling: "sonnet" }, true)).toBe("fake-sonnet");
  });

  it("a project ceiling of haiku (the first rung) keeps the third retry at haiku", async () => {
    // The coder's default rung (sonnet) is capped down to the ceiling, and the retry's climb
    // has no rung left under it.
    expect(await runAtAttempt3({ critic_ceiling: "haiku" }, true)).toBe("fake-haiku");
  });

  it("the ceiling is read from the project row at every run, not when the executor is made", async () => {
    const world = await ladderWorld({}, true);
    try {
      expect(await world.run("Before the cap")).toBe("fake-opus");
      await world.setSettings({ critic_ceiling: "haiku" });
      expect(await world.run("After the cap")).toBe("fake-haiku");
      await world.setSettings({ critic_ceiling: "sonnet" });
      expect(await world.run("Cap raised")).toBe("fake-sonnet");
    } finally {
      await world.close();
    }
  });

  it("without a project ceiling the third retry climbs to opus (the default ceiling)", async () => {
    expect(await runAtAttempt3({}, true)).toBe("fake-opus");
  });

  it("without the projectCeiling port the setting is ignored (what the daemon must not do)", async () => {
    expect(await runAtAttempt3({ critic_ceiling: "sonnet" }, false)).toBe("fake-opus");
  });
});
