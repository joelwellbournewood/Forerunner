import { Logger, type LogRecord, type SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { describe, expect, it, vi } from "vitest";
import { LoopAgentDriver, type RunEvent } from "../src/agent/loop.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import {
  collectStream,
  type ModelProvider,
  type ModelRequest,
  type StreamEvent,
} from "../src/provider/types.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../src/session/executor.ts";
import { seedWorld } from "./context-helpers.ts";
import {
  flatPricing,
  type Harness,
  harness,
  issue,
  registry,
  ScriptedProvider,
} from "./helpers.ts";

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

/**
 * A provider whose first content event lands `ttftMs` monotonic milliseconds after the call
 * started. On the real provider the system clock's `performance.now()` deltas are fractional;
 * the fake provider at `latency: "none"` reports the first token at 0 ms and never shows it.
 */
function fractionalFirstToken(
  inner: ModelProvider,
  clock: SimulatedClock,
  ttftMs: number,
): ModelProvider {
  async function* stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    let first = true;
    for await (const ev of inner.stream(req)) {
      if (
        first &&
        (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "tool_use_start")
      ) {
        clock.tickMonotonic(ttftMs);
        first = false;
      }
      yield ev;
    }
  }
  return {
    name: inner.name,
    listModels: () => inner.listModels(),
    countTokens: (text) => inner.countTokens(text),
    stream,
    complete: (req) => {
      const t0 = clock.monotonic();
      return collectStream(
        stream(req),
        () => t0,
        () => clock.monotonic(),
      );
    },
  };
}

/** A seeded world with one task and an executor over `provider`; `events` collects the task's run events. */
async function worldFor(provider: ModelProvider, h: Harness) {
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  const w = await seedWorld(store);
  const task = await store.task.insert({
    project_id: w.project,
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
  const session = await store.session.mustGet(w.session);
  const events: RunEvent[] = [];
  const exec = new LoopTaskExecutor({
    store,
    clock: h.clock,
    tokens: h.tokens,
    driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
    provider,
    pricing: flatPricing,
    tools: registry(),
    billingSourceId: "bs",
    specialists: (n) => (n === "coder" ? coder : undefined),
    onEvent: (_t, ev) => events.push(ev),
  });
  const token = issue(h, {
    agentId: w.agent,
    ownerHumanId: w.human,
    projectId: w.project,
    allowedTools: ["echo", "read_file"],
    budgetUsdMicro: 5_000_000,
    sessionId: session.id,
  });
  const budget = new SessionBudget({
    sessionId: session.id,
    budgetUsdMicro: 5_000_000,
    stepCap: 100,
    deadlineMs: h.clock.now() + 3_600_000,
    reserveShare: 0.2,
  });
  const execute = () =>
    exec.execute({
      task,
      session,
      token,
      budget,
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 300_000 },
      signal: new AbortController().signal,
    });
  return { store, task, events, execute };
}

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
    // A run records the specialist but never counts an attempt: the state workflow does, on
    // failed -> ready, so the retry ladder advances once per failure (spec D.2, ADR 0034).
    expect(await store.task.mustGet(task.id)).toMatchObject({ attempt: 0, specialist: "coder" });
    const brief = provider.calls[0]?.messages[0]?.content as string;
    expect(brief).toContain("Acceptance criteria");
    expect(brief).toContain("returns 200");
    expect(h.ledger.entries.every((e) => e.taskId === task.id && e.runId === runs[0]?.id)).toBe(
      true,
    );
    await store.close();
  });

  it("records the run with a whole-millisecond first-token time when the clock measures fractions (D.5, D.19)", async () => {
    const h = harness();
    // 12.5 ms to the first token, as a performance.now() delta reads on the real provider. The
    // Run row's ttft_ms is an integer column: unrounded, the codec refused the patch and the row
    // stayed "running" at cost 0 while the result went on as if nothing had happened.
    const provider = fractionalFirstToken(
      new ScriptedProvider([{ text: "Done." }], h.clock),
      h.clock,
      12.5,
    );
    const { store, task, events, execute } = await worldFor(provider, h);
    const res = await execute();
    expect(res.outcome).toBe("done");
    const runs = await store.run.forTask(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "completed", ttft_ms: 13 });
    expect(Number.isInteger(runs[0]?.duration_ms)).toBe(true);
    expect(runs[0]?.duration_ms).toBeGreaterThanOrEqual(13);
    expect(runs[0]?.cost_usd_micro).toBe(res.costUsdMicro);
    expect(res.costUsdMicro).toBeGreaterThan(0);
    expect(events.filter((ev) => ev.type === "warning")).toEqual([]);
    await store.close();
  });

  it("a Run row update that fails is logged at error level and put on the task; the result is kept", async () => {
    const h = harness();
    const { store, task, events, execute } = await worldFor(
      new ScriptedProvider([{ text: "Done." }], h.clock),
      h,
    );
    vi.spyOn(store.run, "patch").mockRejectedValueOnce(new Error("disk full"));
    const records: LogRecord[] = [];
    const removeSink = Logger.addSink((rec) => records.push(rec));
    try {
      const res = await execute();
      expect(res.outcome).toBe("done");
      expect(res.costUsdMicro).toBeGreaterThan(0);
    } finally {
      removeSink();
    }
    const warning = events.find((ev) => ev.type === "warning");
    expect(warning?.type === "warning" ? warning.message : "").toContain("disk full");
    const logged = records.find((r) => r.level === "error" && r.scope === "executor");
    expect(logged?.msg).toBe("could not record the run result");
    expect(logged?.data).toMatchObject({ taskId: task.id, error: "disk full" });
    // The row is what the failed patch left: still "running", so the log and the warning are the trace.
    expect((await store.run.forTask(task.id))[0]?.outcome).toBe("running");
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
