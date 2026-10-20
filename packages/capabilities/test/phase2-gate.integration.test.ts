/**
 * Phase 2 gate (spec, Build order): simulated Alice and Bob each run 5 sessions on the same
 * project, overlapping and not. Zero duplicate tasks, zero lost commits, every ack-required
 * message acknowledged. Fake provider, one shared store (the local mode of the shared state),
 * one local bare repository as the git host's clone target; no network.
 *
 * The "either install offline for 48 simulated hours" half of the gate needs two stores joined
 * by the shared state service and is covered when that service lands (see gates.md).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isInside, join, resolve, run, SimulatedClock } from "@forerunner/platform";
import {
  EnforcementHooks,
  KillSwitch,
  LoopAgentDriver,
  LoopTaskExecutor,
  MemoryAudit,
  SessionRunner,
  type SessionStartOptions,
  type SpecialistSpec,
  StaticPlanner,
  statePorts,
  type TaskExecutor,
  TokenIssuer,
  ToolRegistry,
  type ToolSpec,
} from "@forerunner/runtime";
import { openStore, type StateStore } from "@forerunner/state";
import { FakeProvider } from "@forerunner/testenv";
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

interface Agent {
  id: string;
  name: string;
  runner: SessionRunner;
  grant: SessionStartOptions["grant"];
}

async function world(sessionCapUsdMicro: number) {
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
  const root = mkdtempSync(join(tmpdir(), "fr-p2-"));
  const bare = join(root, "sample.git");
  await run(["git", "init", "--bare", "-b", "main", bare]);
  const seed = new GitOps({ cwd: join(root, "seed"), identity });
  await seed.clone(bare);
  writeFileSync(join(root, "seed", "README.md"), "# sample\n");
  await seed.commitAll("seed");
  await seed.push("main");
  const host = new MemoryGitHost("forerunner");
  await host.createRepo({ owner: "o", name: "sample", private: true, cloneUrl: bare });
  const provider = new FakeProvider({
    mode: "script",
    replies: [
      {
        when: (req) => !lastIsToolResult(req),
        reply: {
          toolCalls: [
            {
              name: "write_file",
              // the task title is in the system prompt; one file per task keeps rebases clean
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

  const makeAgent = async (name: string): Promise<Agent> => {
    const id = (
      await store.agent.insert({
        name,
        owner_human_id: human,
        model_config: {},
        memory_location: "l",
        status: "active",
        kind: "principal",
      })
    ).id;
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
    const worktreeRoot = join(root, `wt-${name.toLowerCase()}`);
    const executor = new PrTaskExecutor({
      store,
      clock,
      host,
      inner,
      repoFor: async () => ({ clone: bare, repo: { owner: "o", name: "sample" }, base: "main" }),
      worktreeRoot,
      identity: { name, email: `${name.toLowerCase()}@example.test` },
      branchFor: (task) => `${name.toLowerCase()}/task-${task.id}`,
    });
    const runner = new SessionRunner({
      store,
      clock,
      tokens,
      kill,
      planner: new StaticPlanner(),
      executor,
    });
    return {
      id,
      name,
      runner,
      grant: {
        allowedTools: ["write_file", "read_file"],
        allowedPaths: [worktreeRoot],
        allowedDomains: [],
        grantedSecrets: [],
      },
    };
  };
  const alice = await makeAgent("Alice");
  const bob = await makeAgent("Bob");
  await store.project.patch(project, { settings: { members: [alice.id, bob.id] } as never });
  return { clock, store, project, host, bare, audit, alice, bob, sessionCapUsdMicro };
}

async function seedTasks(store: StateStore, project: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    ids.push(
      (
        await store.task.insert({
          project_id: project,
          title: `Feature ${i}`,
          outcome: `Feature ${i} works`,
          acceptance_criteria: ["file exists"],
          risk_tier: 1,
          status: "ready",
          priority: 100 - i,
          depends_on: [],
          budget_usd_micro: 300_000,
          est_cost_usd_micro: 100_000,
          actual_cost_usd_micro: 0,
          attempt: 0,
          reason: "seed",
        })
      ).id,
    );
  }
  return ids;
}

function session(w: Awaited<ReturnType<typeof world>>, a: Agent, trigger: "schedule" | "manual") {
  return a.runner.start({
    agentId: a.id,
    projectId: w.project,
    trigger,
    budgetCapUsdMicro: w.sessionCapUsdMicro,
    grant: a.grant,
  });
}

describe("phase 2 gate", () => {
  it("Alice and Bob each run 5 sessions on one project, overlapping and not: no duplicate task, no lost commit, every ack-required message acknowledged", async () => {
    // Work budget per session = cap * (1 - reserve 0.2) = 240_000 -> two 100_000 tasks per session.
    const w = await world(300_000);
    const tasks = await seedTasks(w.store, w.project, 16);

    // Rounds 1, 3 and 5 overlap (both sessions run at once); rounds 2 and 4 run one after the other.
    const results: { agent: string; sessionId: string; inReview: string[]; skipped: string[] }[] =
      [];
    const record = (a: Agent, r: Awaited<ReturnType<SessionRunner["start"]>>) =>
      results.push({
        agent: a.name,
        sessionId: r.sessionId,
        inReview: r.inReview,
        skipped: r.skipped,
      });
    for (let round = 1; round <= 5; round++) {
      if (round % 2 === 1) {
        const [ra, rb] = await Promise.all([
          session(w, w.alice, "schedule"),
          session(w, w.bob, "schedule"),
        ]);
        record(w.alice, ra);
        record(w.bob, rb);
      } else {
        record(w.alice, await session(w, w.alice, "manual"));
        w.clock.advance(60_000);
        record(w.bob, await session(w, w.bob, "manual"));
      }
      w.clock.advance(60_000);
    }
    expect(results.filter((r) => r.agent === "Alice")).toHaveLength(5);
    expect(results.filter((r) => r.agent === "Bob")).toHaveLength(5);

    // Zero duplicate tasks: every task was executed by exactly one session, and there is one
    // run and one pull request per task.
    const executed = results.flatMap((r) => r.inReview);
    expect(new Set(executed).size).toBe(executed.length);
    expect(executed.length).toBeGreaterThanOrEqual(10);
    for (const id of executed) {
      const runs = await w.store.run.forTask(id);
      expect(runs.filter((r) => r.depth === 1)).toHaveLength(1);
    }
    const prs = await w.host.listPullRequests({ owner: "o", name: "sample" });
    expect(prs).toHaveLength(executed.length);
    expect(new Set(prs.map((p) => p.head.ref)).size).toBe(prs.length);
    const rows = await w.store.task.list({ project_id: w.project } as never);
    for (const t of rows) {
      if (executed.includes(t.id)) {
        expect(t.status).toBe("in_review");
        expect(t.pr_url).toBeTruthy();
        expect(t.claimed_by).toBeNull();
      }
    }
    // The overlapping rounds produced at least one real claim collision that was reported.
    const collisionNotes = await w.store.message.list({ type: "info" } as never);
    expect(collisionNotes.some((m) => m.body.includes("you hold the claim"))).toBe(true);

    // Zero lost commits: every PR branch exists in the shared repository with the task's commit
    // on top, and main was never rewritten.
    const refs = (
      await run(["git", "--git-dir", w.bare, "for-each-ref", "--format=%(refname:short)"])
    ).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    for (const pr of prs) {
      expect(refs).toContain(pr.head.ref);
      const subject = (
        await run(["git", "--git-dir", w.bare, "log", "-1", "--format=%s", pr.head.ref])
      ).stdout.trim();
      expect(subject).toMatch(/^Feature \d+$/);
      const taskId = rows.find((t) => t.pr_url === pr.htmlUrl)?.id;
      expect(taskId).toBeTruthy();
      const body = (
        await run(["git", "--git-dir", w.bare, "log", "-1", "--format=%b", pr.head.ref])
      ).stdout;
      expect(body).toContain(`Task ${taskId}`);
    }
    const mainLog = (await run(["git", "--git-dir", w.bare, "log", "--format=%s", "main"])).stdout;
    expect(mainLog.trim()).toBe("seed");
    // Every session's PR branches still carry their commit (nothing dropped by a rebase).
    expect(refs.filter((r) => r !== "main")).toHaveLength(prs.length);

    // Every ack-required message was acknowledged by the recipient's next session; only
    // handoffs sent after the recipient's last session can still be open.
    const lastStart = async (agentId: string) =>
      (await w.store.session.latestForAgent(agentId))?.started_at ?? "";
    for (const a of [w.alice, w.bob]) {
      const open = await w.store.message.unacknowledged(a.id);
      for (const m of open) {
        const recipient = m.to_agent_id as string;
        expect(m.created_at >= (await lastStart(recipient))).toBe(true);
      }
    }
    const handoffs = await w.store.message.list({ type: "handoff" } as never);
    expect(handoffs.length).toBe(10);
    expect(handoffs.every((m) => m.requires_ack)).toBe(true);
    for (const m of handoffs) {
      if (m.created_at < (await lastStart(m.to_agent_id as string))) {
        expect(m.delivered_at).toBeTruthy();
        expect(m.read_at).toBeTruthy();
        expect(m.acted_at).toBeTruthy();
      }
    }
    expect(handoffs.filter((m) => m.acted_at).length).toBeGreaterThanOrEqual(8);

    // No tool call was ever denied and nothing ran outside its worktree.
    expect(w.audit.entries.filter((e) => !e.allowed)).toHaveLength(0);
    expect(tasks).toHaveLength(16);
    await w.store.close();
  }, 120_000);

  it.skip("either install can be offline for 48 simulated hours without breaking the other (needs the shared state service sync; recorded as pending in gates.md)", () => {});
});
