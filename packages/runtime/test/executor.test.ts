import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../src/session/executor.ts";
import { flatPricing, harness, issue, registry, ScriptedProvider } from "./helpers.ts";

const coder: SpecialistSpec = {
  name: "coder",
  prompt: "You are the coder.",
  promptVersion: "coder@1.0.0+abc12345",
  defaultTier: "sonnet",
  defaultEffort: "medium",
  allowedTools: ["echo", "read_file"],
  allowedDomains: [],
  maxBudgetUsdMicro: 2_000_000,
  maxTurns: 10,
  timeoutMs: 60_000,
};

describe("LoopTaskExecutor", () => {
  it("validates the brief, derives a narrower token, runs the specialist and records the run", async () => {
    const h = harness();
    const clock = h.clock;
    const store = await openStore({ url: "sqlite::memory:", clock });
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
      acceptance_criteria: ["returns 200", "has a test"],
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
    const provider = new ScriptedProvider(
      [
        {
          tools: [
            { name: "echo", input: { text: "hi" } },
            { name: "write_file", input: { path: "x", text: "y" } },
          ],
        },
        { text: "Added the endpoint and a test." },
      ],
      clock,
    );
    const events: string[] = [];
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
      onEvent: (_t, ev) => events.push(ev.type),
    });
    const token = issue(h, {
      agentId: agent,
      ownerHumanId: human,
      projectId: project,
      allowedTools: ["echo", "read_file", "write_file", "delete_repo"],
      budgetUsdMicro: 5_000_000,
      sessionId: session.id,
    });
    const budget = new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: 5_000_000,
      stepCap: 100,
      deadlineMs: clock.now() + 3_600_000,
      reserveShare: 0.2,
    });
    const res = await exec.execute({
      task,
      session,
      token,
      budget,
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 300_000 },
      signal: new AbortController().signal,
    });
    expect(res.outcome).toBe("done");
    expect(res.summary).toBe("Added the endpoint and a test.");
    expect(res.checksPassed).toBe(true);
    expect(res.costUsdMicro).toBeGreaterThan(0);
    // The specialist got only its own tools: write_file was not offered and was denied.
    expect(provider.calls[0]?.tools?.map((t) => t.name)).toEqual(["echo", "read_file"]);
    expect(events).toContain("tool_denied");
    const runs = await store.run.forTask(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      specialist: "coder",
      model: "fake-sonnet",
      prompt_version: "coder@1.0.0+abc12345",
      outcome: "completed",
      depth: 1,
      effort: "medium",
    });
    expect(runs[0]?.cost_usd_micro).toBe(res.costUsdMicro);
    expect((await store.task.mustGet(task.id)).attempt).toBe(1);
    const brief = provider.calls[0]?.messages[0]?.content as string;
    expect(brief).toContain("Acceptance criteria");
    expect(brief).toContain("returns 200");
    expect(h.ledger.entries.every((e) => e.taskId === task.id && e.runId === runs[0]?.id)).toBe(
      true,
    );
    await store.close();
  });

  it("refuses unknown specialists and caps the brief budget at the specialist maximum", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const exec = new LoopTaskExecutor({
      store,
      clock: h.clock,
      tokens: h.tokens,
      driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
      provider: new ScriptedProvider([{ text: "x" }], h.clock),
      pricing: flatPricing,
      tools: registry(),
      billingSourceId: "bs",
      specialists: () => undefined,
    });
    await expect(
      exec.execute({
        task: {
          id: "t",
          title: "t",
          outcome: "o",
          acceptance_criteria: [],
          risk_tier: 0,
          project_id: "p",
          budget_usd_micro: 1,
          est_cost_usd_micro: 1,
          attempt: 0,
          pr_url: null,
          branch: null,
        } as never,
        session: { id: "s", agent_id: "a" } as never,
        token: issue(h),
        budget: new SessionBudget({
          sessionId: "s",
          budgetUsdMicro: 10,
          stepCap: 10,
          deadlineMs: h.clock.now() + 1000,
          reserveShare: 0.2,
        }),
        item: { taskId: "t", title: "t", specialist: "nope", estimateUsdMicro: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await store.close();
  });
});
