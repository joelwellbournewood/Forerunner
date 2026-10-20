/**
 * Phase 1 gate (spec, Build order): on a sample repo in the test environment, one agent plans
 * and completes 10 tasks via PRs without exceeding any cap; a deliberate overspend attempt is
 * blocked by code; the kill switch stops everything within 2 seconds; text chat first token
 * is measured. Runs with the fake provider and a local bare repository; no network.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isInside, join, resolve, run, SimulatedClock } from "@forerunner/platform";
import {
  ConversationAgent,
  EnforcementHooks,
  KillSwitch,
  LoopAgentDriver,
  LoopTaskExecutor,
  MemoryAudit,
  SessionRunner,
  type SpecialistSpec,
  StaticPlanner,
  statePorts,
  type TaskExecutor,
  TokenIssuer,
  ToolRegistry,
  type ToolSpec,
} from "@forerunner/runtime";
import { openStore } from "@forerunner/state";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GitOps } from "../src/githost/git.ts";
import { MemoryGitHost } from "../src/githost/memory.ts";
import { PrTaskExecutor } from "../src/githost/pr-executor.ts";

const identity = { name: "Forerunner", email: "agent@example.test" };
const lastIsToolResult = (req: { messages: { role: string; content: unknown }[] }): boolean => {
  const last = req.messages.at(-1);
  return (
    !!last &&
    Array.isArray(last.content) &&
    last.content.some((b) => (b as { type?: string }).type === "tool_result")
  );
};
const pricing = {
  estimate: (i: number, o: number) => i + o,
  cost: (u: { input_tokens: number; output_tokens: number }) => u.input_tokens + u.output_tokens,
};

const coder: SpecialistSpec = {
  name: "coder",
  prompt: "You are the coder specialist.",
  promptVersion: "coder@0.1.0+test",
  defaultTier: "sonnet",
  defaultEffort: "medium",
  allowedTools: ["write_file", "read_file"],
  allowedDomains: [],
  maxBudgetUsdMicro: 400_000,
  maxTurns: 40,
  timeoutMs: 60_000,
};

function fileTools(): ToolRegistry {
  const write: ToolSpec<{ path: string; content: string }> = {
    name: "write_file",
    description: "write a file in the worktree",
    schema: z.object({ path: z.string(), content: z.string() }),
    actionClass: "routine_reversible",
    risk: "low",
    pathFields: ["path"],
    async execute(input, ctx) {
      const abs = resolve(ctx.cwd ?? ".", input.path);
      if (!ctx.allowedPaths.some((r) => isInside(r, abs)))
        return { content: "outside worktree", isError: true };
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, input.content);
      return { content: `wrote ${input.path}` };
    },
  };
  const read: ToolSpec<{ path: string }> = {
    name: "read_file",
    description: "read a file",
    schema: z.object({ path: z.string() }),
    actionClass: "read",
    risk: "low",
    pathFields: ["path"],
    async execute(input) {
      return { content: `(contents of ${input.path})` };
    },
  };
  return new ToolRegistry().register(write).register(read);
}

async function world(opts: {
  replies: ReturnType<typeof textReply>[];
  sessionCapUsdMicro: number;
}) {
  const clock = new SimulatedClock("2026-03-04T06:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@x.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 150_000_000,
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
      name: "Sample",
      goal: "A sample service",
      repos: ["o/sample"],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    })
  ).id;
  const root = mkdtempSync(join(tmpdir(), "fr-p1-"));
  const bare = join(root, "sample.git");
  await run(["git", "init", "--bare", "-b", "main", bare]);
  const seed = new GitOps({ cwd: join(root, "seed"), identity });
  await seed.clone(bare);
  writeFileSync(join(root, "seed", "README.md"), "# sample\n");
  await seed.commitAll("seed");
  await seed.push("main");
  const host = new MemoryGitHost("alice");
  await host.createRepo({ owner: "o", name: "sample", private: true, cloneUrl: bare });
  const provider = new FakeProvider({
    mode: "script",
    replies: opts.replies,
    clock,
    latency: "none",
    onNoMatch: "echo",
  });
  const tokens = new TokenIssuer({ now: () => clock.now() });
  const kill = new KillSwitch(tokens);
  const ports = statePorts(store, { chfPerUsd: () => 0.8 });
  const audit = new MemoryAudit();
  const hooks = new EnforcementHooks({
    tokens,
    caps: { check: () => ({ decision: "allow" }) },
    secrets: { resolve: async (i) => i, redact: (t) => t },
    kill,
    clock,
    ledger: ports.ledger,
    audit,
    approvals: ports.approvals,
  });
  const driver = new LoopAgentDriver({ hooks, kill, clock });
  const tools = fileTools();
  const loopDeps = {
    store,
    clock,
    tokens,
    driver,
    provider,
    pricing,
    tools,
    billingSourceId: "bs",
    specialists: (n: string) => (n === "coder" ? coder : undefined),
  };
  const inner: TaskExecutor & { withWorktree: (dir: string) => TaskExecutor } = {
    execute: (ctx) => new LoopTaskExecutor(loopDeps).execute(ctx),
    withWorktree: (dir) => new LoopTaskExecutor({ ...loopDeps, worktreeFor: async () => dir }),
  };
  const executor = new PrTaskExecutor({
    store,
    clock,
    host,
    inner,
    repoFor: async () => ({ clone: bare, repo: { owner: "o", name: "sample" }, base: "main" }),
    worktreeRoot: join(root, "wt"),
    identity,
  });
  const runner = new SessionRunner({
    store,
    clock,
    tokens,
    kill,
    planner: new StaticPlanner(),
    executor,
  });
  const grant = {
    allowedTools: ["write_file", "read_file"],
    allowedPaths: [join(root, "wt")],
    allowedDomains: [] as string[],
    grantedSecrets: [] as string[],
  };
  return {
    clock,
    store,
    grant,
    human,
    agent,
    project,
    host,
    provider,
    tokens,
    kill,
    hooks,
    driver,
    runner,
    audit,
    sessionCap: opts.sessionCapUsdMicro,
  };
}

describe("phase 1 gate", () => {
  it("one agent plans and completes 10 tasks via pull requests without exceeding any cap", async () => {
    const w = await world({
      replies: [
        {
          when: (req) => !lastIsToolResult(req),
          reply: {
            toolCalls: [
              {
                name: "write_file",
                input: { path: "src/feature.ts", content: "export const ok = true;\n" },
              },
            ],
          },
          times: Number.POSITIVE_INFINITY,
        },
        {
          when: (req) => lastIsToolResult(req),
          reply: { text: "Implemented the feature and verified it." },
          times: Number.POSITIVE_INFINITY,
        },
      ],
      sessionCapUsdMicro: 5_000_000,
    });
    for (let i = 1; i <= 10; i++) {
      await w.store.task.insert({
        project_id: w.project,
        title: `Feature ${i}`,
        outcome: `Feature ${i} works`,
        acceptance_criteria: ["file exists"],
        risk_tier: 1,
        status: "ready",
        priority: 10 - i,
        depends_on: [],
        budget_usd_micro: 300_000,
        est_cost_usd_micro: 100_000,
        actual_cost_usd_micro: 0,
        attempt: 0,
        reason: "seed",
      });
    }
    const res = await w.runner.start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "schedule",
      budgetCapUsdMicro: w.sessionCap,
      grant: w.grant,
    });
    expect(res.status).toBe("completed");
    expect(res.inReview).toHaveLength(10);
    expect(res.failed).toHaveLength(0);
    const prs = await w.host.listPullRequests({ owner: "o", name: "sample" });
    expect(prs).toHaveLength(10);
    expect(new Set(prs.map((p) => p.head.ref)).size).toBe(10);
    const tasks = await w.store.task.list({ project_id: w.project } as never);
    expect(tasks.every((t) => t.status === "in_review" && t.pr_url && t.claimed_by === null)).toBe(
      true,
    );
    // Caps: session total under the cap, every run under the task cap, ledger matches the session.
    const spent = (await w.store.costLedger.sum({ sessionId: res.sessionId })).usd_micro;
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(w.sessionCap);
    const runs = await w.store.run.forSession(res.sessionId);
    expect(runs).toHaveLength(10);
    expect(
      runs.every((r) => r.cost_usd_micro <= 300_000 && r.outcome === "completed" && r.depth === 1),
    ).toBe(true);
    expect(w.audit.entries.filter((a) => !a.allowed)).toHaveLength(0);
    const session = await w.store.session.mustGet(res.sessionId);
    expect(session.summary).toContain("In review: 10");
    await w.store.close();
  });

  it("blocks a deliberate overspend in code and the session stops cleanly with a handoff", async () => {
    const w = await world({
      replies: [
        // The specialist keeps calling tools forever; each call costs tokens until the run cap stops it.
        {
          when: { systemIncludes: "coder" },
          reply: {
            toolCalls: [{ name: "read_file", input: { path: "README.md" } }],
            text: "x".repeat(4000),
          },
          times: Number.POSITIVE_INFINITY,
        },
      ],
      sessionCapUsdMicro: 1_000_000,
    });
    await w.store.task.insert({
      project_id: w.project,
      title: "Runaway",
      outcome: "never",
      acceptance_criteria: [],
      risk_tier: 1,
      status: "ready",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 60_000,
      est_cost_usd_micro: 60_000,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
    await w.store.task.insert({
      project_id: w.project,
      title: "After",
      outcome: "o",
      acceptance_criteria: [],
      risk_tier: 1,
      status: "ready",
      priority: 1,
      depends_on: [],
      budget_usd_micro: 200_000,
      est_cost_usd_micro: 100_000,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
    const res = await w.runner.start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: w.sessionCap,
      grant: w.grant,
    });
    const runs = await w.store.run.forSession(res.sessionId);
    expect(runs[0]?.outcome).toBe("budget_exceeded");
    expect(runs[0]?.cost_usd_micro).toBeLessThanOrEqual(60_000);
    expect(
      (await w.store.costLedger.sum({ sessionId: res.sessionId })).usd_micro,
    ).toBeLessThanOrEqual(w.sessionCap);
    expect(res.needsHuman).toHaveLength(1);
    expect(res.stopReason).toBe("budget_exceeded");
    expect(res.handoff).toMatchObject({ stop_reason: "budget_exceeded" });
    expect(await w.host.listPullRequests({ owner: "o", name: "sample" })).toHaveLength(0);
    await w.store.close();
  });

  it("the kill switch stops a running session within 2 seconds and releases claims", async () => {
    const w = await world({
      replies: [
        {
          when: { systemIncludes: "coder" },
          reply: { text: "slow", ttftMs: 60_000 },
          times: Number.POSITIVE_INFINITY,
        },
      ],
      sessionCapUsdMicro: 5_000_000,
    });
    // Real latency this time: a provider that waits on a real timer so the kill is measured in wall time.
    const slow = new FakeProvider({
      mode: "script",
      replies: [{ reply: { text: "slow", ttftMs: 30_000 }, times: Number.POSITIVE_INFINITY }],
      latency: "simulated",
    });
    const slowExec = new LoopTaskExecutor({
      store: w.store,
      clock: w.clock,
      tokens: w.tokens,
      driver: w.driver,
      provider: slow,
      pricing,
      tools: fileTools(),
      billingSourceId: "bs",
      specialists: () => coder,
    });
    const runner = new SessionRunner({
      store: w.store,
      clock: w.clock,
      tokens: w.tokens,
      kill: w.kill,
      planner: new StaticPlanner(),
      executor: slowExec,
    });
    for (let i = 0; i < 3; i++)
      await w.store.task.insert({
        project_id: w.project,
        title: `Slow task ${i}`,
        outcome: `Slow task ${i} completes eventually`,
        acceptance_criteria: [],
        risk_tier: 1,
        status: "ready",
        priority: 5,
        depends_on: [],
        budget_usd_micro: 300_000,
        est_cost_usd_micro: 100_000,
        actual_cost_usd_micro: 0,
        attempt: 0,
        reason: "seed",
      });
    const p = runner.start({
      agentId: w.agent,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant: w.grant,
    });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = performance.now();
    const report = await w.kill.stop("all", "gate test");
    const res = await p;
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(report.stoppedRuns).toBeGreaterThan(0);
    expect(res.status).toBe("killed");
    const tasks = await w.store.task.list({ project_id: w.project } as never);
    expect(tasks.every((t) => t.claimed_by === null)).toBe(true);
    w.kill.resume();
    await w.store.close();
  });

  it("text chat answers with a measured first token under the 1 s target (simulated latency)", async () => {
    const w = await world({ replies: [], sessionCapUsdMicro: 1 });
    const chat = new FakeProvider({
      mode: "script",
      replies: [textReply("Three PRs are open on Sample.", { ttftMs: 250 })],
      clock: w.clock,
      latency: "simulated",
    });
    const agent = new ConversationAgent({
      store: w.store,
      clock: w.clock,
      tokens: w.tokens,
      kill: w.kill,
      provider: chat,
      pricing,
      billingSourceId: "bs",
      hooksDriver: w.driver,
      modelId: "fake-haiku",
    });
    const p = agent.chat({
      humanId: w.human,
      agentId: w.agent,
      projectId: w.project,
      text: "status?",
    });
    await new Promise((r) => setTimeout(r, 20));
    await w.clock.advance(2_000);
    const res = await p;
    expect(res.reply).toContain("Three PRs");
    expect(res.ttftMs).toBe(250);
    expect(res.ttftMs ?? 0).toBeLessThan(1000);
    await w.store.close();
  });
});
