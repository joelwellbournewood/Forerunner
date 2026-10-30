import { tmpdir } from "node:os";
import { ForerunnerError, join, Logger, type LogRecord } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { describe, expect, it, vi } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import {
  LoopTaskExecutor,
  RUN_PERSIST_FAILED_AUDIT_TOOL,
  type RunSandboxPort,
  type SpecialistSpec,
} from "../src/session/executor.ts";
import { flatPricing, harness, issue, registry, ScriptedProvider, until } from "./helpers.ts";

// Credential-shaped, built by concatenation so no scanner sees a token. // not-a-secret
const KEY_LIKE = ["sk-ant-api03-", "leaked", "0".repeat(40)].join(""); // not-a-secret

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

  it("runs nothing for an unknown specialist (it waits for the person) and caps the brief budget at the specialist maximum", async () => {
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
    ).resolves.toEqual({
      // U-014: nothing ran, so the task waits for the person instead of failing.
      outcome: "needs_human",
      summary: 'No specialist is named "nope", so nothing ran.',
      costUsdMicro: 0,
    });
    await store.close();
  });
});

/** A human, a principal agent, a project, one task and a running session on the store. */
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
  return { human, agent, project, task, session };
}

/** The executor over the harness and a scripted provider, and the call that runs the seeded task. */
function executorFor(
  h: ReturnType<typeof harness>,
  store: StateStore,
  w: Awaited<ReturnType<typeof seed>>,
  provider: ScriptedProvider,
) {
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
  });
  const token = issue(h, {
    agentId: w.agent,
    ownerHumanId: w.human,
    projectId: w.project,
    allowedTools: ["echo", "read_file"],
    budgetUsdMicro: 5_000_000,
    sessionId: w.session.id,
  });
  const budget = new SessionBudget({
    sessionId: w.session.id,
    budgetUsdMicro: 5_000_000,
    stepCap: 100,
    deadlineMs: h.clock.now() + 3_600_000,
    reserveShare: 0.2,
  });
  return () =>
    exec.execute({
      task: w.task,
      session: w.session,
      token,
      budget,
      item: {
        taskId: w.task.id,
        title: w.task.title,
        specialist: "coder",
        estimateUsdMicro: 300_000,
      },
      signal: new AbortController().signal,
    });
}

describe("LoopTaskExecutor: the Run row (D.5, D.19)", () => {
  // The first live run (ADR 0040) measured ttft with performance.now(), 12.345-style fractions,
  // and the store refused the row for its INTEGER column; the error was swallowed and every
  // coder run stayed "running" with cost 0. Whole milliseconds, on the real store, no mock.
  it("persists a run whose first-token time (12.345 ms) and duration (987.65 ms) are fractional, as integers with the outcome and the cost", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const w = await seed(store);
    const provider = new ScriptedProvider(
      [{ text: "Added the endpoint.", ttftMs: 12.345, totalMs: 987.65 }],
      h.clock,
    );
    const p = executorFor(h, store, w, provider)();
    await until(() => provider.calls.length === 1, "the model call");
    await h.clock.advance(2_000);
    const res = await p;
    expect(res.outcome).toBe("done");
    expect(res.costUsdMicro).toBeGreaterThan(0);
    const runs = await store.run.forTask(w.task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: res.runId,
      outcome: "completed",
      ttft_ms: 12,
      cost_usd_micro: res.costUsdMicro,
      timed_out: false,
    });
    expect(Number.isInteger(runs[0]?.duration_ms)).toBe(true);
    expect(runs[0]?.duration_ms).toBeGreaterThanOrEqual(988);
    expect(await store.auditLog.list({ tool: RUN_PERSIST_FAILED_AUDIT_TOOL })).toEqual([]);
    await store.close();
  });

  it("keeps the session going when the Run row cannot be written, and leaves an audit row and a log line that name the run and never the prompt", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const w = await seed(store);
    const provider = new ScriptedProvider([{ text: "Added the endpoint." }], h.clock);
    vi.spyOn(store.run, "patch").mockRejectedValueOnce(
      new ForerunnerError("internal", "disk full"),
    );
    const records: LogRecord[] = [];
    const off = Logger.addSink((r) => records.push(r));
    try {
      const res = await executorFor(h, store, w, provider)();
      // The result reaches the runner as usual.
      expect(res.outcome).toBe("done");
      expect(res.summary).toBe("Added the endpoint.");
      // The honest state of the row: still running, since nothing was written.
      expect((await store.run.forTask(w.task.id))[0]).toMatchObject({
        id: res.runId,
        outcome: "running",
      });
      // The failure is an audit row with the ids, the stage and the store's message.
      const rows = await store.auditLog.list({ runId: res.runId });
      const row = rows.find((r) => r.tool === RUN_PERSIST_FAILED_AUDIT_TOOL);
      expect(row).toMatchObject({
        allowed: false,
        session_id: w.session.id,
        agent_id: w.agent,
        human_id: w.human,
        cost_usd_micro: 0,
      });
      expect(row?.denied_reason).toContain("disk full");
      expect(JSON.parse(row?.input_summary ?? "{}")).toEqual({ runId: res.runId, stage: "end" });
      // Never the prompt, the brief or the report.
      const text = JSON.stringify(rows);
      expect(text).not.toContain(coder.prompt);
      expect(text).not.toContain(w.task.outcome);
      expect(text).not.toContain("Added the endpoint.");
      // And a line through the runtime logger, with the same discipline.
      const logged = records.find((r) => r.level === "error" && r.msg === "run row not persisted");
      expect(logged?.data).toMatchObject({ runId: res.runId, stage: "end" });
      expect(logged?.data?.error).toContain("disk full");
      const log = JSON.stringify(records);
      expect(log).not.toContain(coder.prompt);
      expect(log).not.toContain(w.task.outcome);
    } finally {
      off();
      await store.close();
    }
  });
});

describe("LoopTaskExecutor: error messages before the store", () => {
  it("redacts a thrown error's message before it becomes the Run row's error artifact", async () => {
    const h = harness();
    const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
    const w = await seed(store);
    // A lease that fails quoting something credential-shaped (a tool's output, an env dump).
    const port: RunSandboxPort = {
      open: async () => {
        throw new ForerunnerError("internal", `sandbox start failed: key ${KEY_LIKE}`);
      },
    };
    const exec = new LoopTaskExecutor({
      store,
      clock: h.clock,
      tokens: h.tokens,
      driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
      provider: new ScriptedProvider([{ text: "never reached" }], h.clock),
      pricing: flatPricing,
      tools: registry(),
      billingSourceId: "bs",
      specialists: (n) => (n === "coder" ? coder : undefined),
      sandbox: port,
      worktreeFor: async () => join(tmpdir(), "worktree-never-used"),
    });
    const token = issue(h, {
      agentId: w.agent,
      ownerHumanId: w.human,
      projectId: w.project,
      allowedTools: ["echo", "read_file"],
      budgetUsdMicro: 5_000_000,
      sessionId: w.session.id,
    });
    const budget = new SessionBudget({
      sessionId: w.session.id,
      budgetUsdMicro: 5_000_000,
      stepCap: 100,
      deadlineMs: h.clock.now() + 3_600_000,
      reserveShare: 0.2,
    });
    let err: unknown = null;
    try {
      await exec.execute({
        task: w.task,
        session: w.session,
        token,
        budget,
        item: {
          taskId: w.task.id,
          title: w.task.title,
          specialist: "coder",
          estimateUsdMicro: 300_000,
        },
        signal: new AbortController().signal,
      });
    } catch (e) {
      err = e;
    }
    // The error still reaches the runner as thrown...
    expect(err).toBeInstanceOf(ForerunnerError);
    // ...and the Run row is closed as an error whose artifact never carries the value.
    const run = (await store.run.forTask(w.task.id))[0];
    expect(run?.outcome).toBe("error");
    const artifact = run?.artifacts[0] as { error: string };
    expect(artifact.error).toContain("sandbox start failed");
    expect(artifact.error).toContain("[REDACTED]");
    expect(JSON.stringify(run)).not.toContain(KEY_LIKE);
    await store.close();
  });
});
