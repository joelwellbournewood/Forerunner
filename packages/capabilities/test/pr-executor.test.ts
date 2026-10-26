import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, run, SimulatedClock } from "@forerunner/platform";
import { KillSwitch, SessionBudget, type TaskExecutor, TokenIssuer } from "@forerunner/runtime";
import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { GitOps } from "../src/githost/git.ts";
import { MemoryGitHost } from "../src/githost/memory.ts";
import { PrTaskExecutor } from "../src/githost/pr-executor.ts";

const identity = { name: "Forerunner", email: "agent@example.test" };

async function world() {
  const clock = new SimulatedClock("2026-03-03T08:00:00Z");
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
      name: "Sample",
      goal: "g",
      repos: ["o/sample"],
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
  const root = mkdtempSync(join(tmpdir(), "fr-pr-"));
  const bare = join(root, "sample.git");
  await run(["git", "init", "--bare", "-b", "main", bare]);
  const seed = new GitOps({ cwd: join(root, "seed"), identity });
  await seed.clone(bare);
  writeFileSync(join(root, "seed", "README.md"), "# sample\n");
  await seed.commitAll("seed");
  await seed.push("main");
  const host = new MemoryGitHost("alice");
  await host.createRepo({ owner: "o", name: "sample", private: true, cloneUrl: bare });
  const tokens = new TokenIssuer({ now: () => clock.now() });
  const token = tokens.issue({
    runId: "r",
    sessionId: session.id,
    agentId: agent,
    ownerHumanId: human,
    projectId: project,
    allowedTools: ["echo"],
    allowedPaths: [],
    allowedDomains: [],
    grantedSecrets: [],
    budgetUsdMicro: 1_000_000,
    depth: 0,
    maxDepth: 2,
    autonomy: 2,
    planApproved: false,
    expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
  });
  const budget = new SessionBudget({
    sessionId: session.id,
    budgetUsdMicro: 5_000_000,
    stepCap: 100,
    deadlineMs: clock.now() + 3_600_000,
    reserveShare: 0.2,
  });
  return {
    clock,
    store,
    human,
    agent,
    project,
    session,
    root,
    bare,
    host,
    token,
    budget,
    kill: new KillSwitch(),
  };
}

function innerWriting(
  files: Record<string, string>,
  outcome: "done" | "failed" = "done",
): TaskExecutor & { withWorktree: (dir: string) => TaskExecutor } {
  return {
    async execute() {
      return { outcome, summary: "no worktree", costUsdMicro: 0 };
    },
    withWorktree(dir) {
      return {
        async execute() {
          for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
          return { outcome, summary: "wrote files", costUsdMicro: 1000, checksPassed: true };
        },
      };
    },
  };
}

// 12 to 33 git subprocesses per test (counted with a PATH wrapper), the same load as
// git.test.ts. A loaded Windows runner has run them 3 to 8 times slower than usual (run
// 40401068999: the conflict case past 20 s, git.test.ts's 43-process case 34.6 s), so this
// suite gets git.test.ts's 120 s budget instead of the unit project's 20 s default.
describe("PrTaskExecutor", { timeout: 120_000 }, () => {
  it("clones into a worktree, branches, commits, rebases, pushes and opens a pull request", async () => {
    const w = await world();
    const task = await w.store.task.insert({
      project_id: w.project,
      title: "Add health endpoint",
      outcome: "GET /health works",
      acceptance_criteria: ["returns 200"],
      risk_tier: 1,
      status: "in_progress",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1,
      est_cost_usd_micro: 1,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
    const exec = new PrTaskExecutor({
      store: w.store,
      clock: w.clock,
      host: w.host,
      inner: innerWriting({ "health.ts": "export const ok = true;\n" }),
      repoFor: async () => ({ clone: w.bare, repo: { owner: "o", name: "sample" }, base: "main" }),
      worktreeRoot: join(w.root, "wt"),
      identity,
    });
    const res = await exec.execute({
      task,
      session: w.session,
      token: w.token,
      budget: w.budget,
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
    });
    expect(res.outcome).toBe("in_review");
    expect(res.prUrl).toContain("/pull/1");
    expect(res.branch).toMatch(/^fr\/[0-9a-f]{8}-add-health-endpoint$/);
    const prs = await w.host.listPullRequests({ owner: "o", name: "sample" });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.body).toContain("returns 200");
    expect((await w.store.task.mustGet(task.id)).branch).toBe(res.branch);
    // The branch really exists on the remote with the file.
    const check = new GitOps({ cwd: join(w.root, "check"), identity });
    await check.clone(w.bare, { branch: res.branch });
    expect((await check.log(1))[0]?.subject).toBe("Add health endpoint");

    // A second run on the same task updates the PR instead of opening another.
    const again = await new PrTaskExecutor({
      store: w.store,
      clock: w.clock,
      host: w.host,
      inner: innerWriting({ "health.ts": "export const ok = 1;\n" }),
      repoFor: async () => ({ clone: w.bare, repo: { owner: "o", name: "sample" }, base: "main" }),
      worktreeRoot: join(w.root, "wt"),
      identity,
    }).execute({
      task: await w.store.task.mustGet(task.id),
      session: w.session,
      token: w.token,
      budget: w.budget,
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
    });
    expect(again.outcome).toBe("in_review");
    expect(await w.host.listPullRequests({ owner: "o", name: "sample" })).toHaveLength(1);
    expect(
      (await w.host.listPullRequestComments({ owner: "o", name: "sample" }, 1))[0]?.body,
    ).toContain("Updated by session");
    await w.store.close();
  });

  it("turns a rebase conflict into a blocking human request and makes no PR", async () => {
    const w = await world();
    const task = await w.store.task.insert({
      project_id: w.project,
      title: "Edit readme",
      outcome: "o",
      acceptance_criteria: [],
      risk_tier: 1,
      status: "in_progress",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1,
      est_cost_usd_micro: 1,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
    // Someone else changes README on main while the agent works.
    const inner: TaskExecutor & { withWorktree: (dir: string) => TaskExecutor } = {
      async execute() {
        return { outcome: "done", summary: "", costUsdMicro: 0 };
      },
      withWorktree(dir) {
        return {
          async execute() {
            const other = new GitOps({ cwd: join(w.root, "other"), identity });
            await other.clone(w.bare);
            writeFileSync(join(w.root, "other", "README.md"), "# sample\nby other\n");
            await other.commitAll("other");
            await other.push("main");
            writeFileSync(join(dir, "README.md"), "# sample\nby agent\n");
            return { outcome: "done", summary: "edited", costUsdMicro: 0, checksPassed: true };
          },
        };
      },
    };
    const exec = new PrTaskExecutor({
      store: w.store,
      clock: w.clock,
      host: w.host,
      inner,
      repoFor: async () => ({ clone: w.bare, repo: { owner: "o", name: "sample" }, base: "main" }),
      worktreeRoot: join(w.root, "wt"),
      identity,
    });
    const res = await exec.execute({
      task,
      session: w.session,
      token: w.token,
      budget: w.budget,
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
    });
    expect(res.outcome).toBe("needs_human");
    expect(res.summary).toContain("README.md");
    const reqs = await w.store.humanRequest.open({ humanId: w.human });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.blocking).toBe(true);
    expect(await w.host.listPullRequests({ owner: "o", name: "sample" })).toHaveLength(0);
    await w.store.close();
  });

  it("fails cleanly when the specialist changed nothing and skips git for tasks without a repository", async () => {
    const w = await world();
    const task = await w.store.task.insert({
      project_id: w.project,
      title: "Nothing",
      outcome: "o",
      acceptance_criteria: [],
      risk_tier: 0,
      status: "in_progress",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1,
      est_cost_usd_micro: 1,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
    const ctx = {
      task,
      session: w.session,
      token: w.token,
      budget: w.budget,
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
    };
    const noChange = await new PrTaskExecutor({
      store: w.store,
      clock: w.clock,
      host: w.host,
      inner: innerWriting({}),
      repoFor: async () => ({ clone: w.bare, repo: { owner: "o", name: "sample" }, base: "main" }),
      worktreeRoot: join(w.root, "wt"),
      identity,
    }).execute(ctx);
    expect(noChange.outcome).toBe("failed");
    expect(noChange.summary).toContain("no changes");
    const noRepo = await new PrTaskExecutor({
      store: w.store,
      clock: w.clock,
      host: w.host,
      inner: innerWriting({}),
      repoFor: async () => null,
      worktreeRoot: join(w.root, "wt"),
      identity,
    }).execute(ctx);
    expect(noRepo.summary).toBe("no worktree");
    await w.store.close();
  });
});
