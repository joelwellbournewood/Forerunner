import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, run, SimulatedClock } from "@forerunner/platform";
import { KillSwitch, SessionBudget, type TaskExecutor, TokenIssuer } from "@forerunner/runtime";
import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { GitOps } from "../src/githost/git.ts";
import { MemoryGitHost } from "../src/githost/memory.ts";
import { DEPS_BASE_REF, PrTaskExecutor } from "../src/githost/pr-executor.ts";

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

  it("an empty repository gets a first commit (a README) on its default branch, then the task's branch and pull request (GitHub walk, 2026-11-02)", async () => {
    // Before: every task of a project linked to a repository just created on GitHub failed with
    // "git checkout -B fr/... failed: fatal: 'origin/main' is not a commit and a branch ...
    // cannot be created from it".
    const w = await world();
    const empty = join(w.root, "empty.git");
    await run(["git", "init", "--bare", "-b", "main", empty]);
    await w.host.createRepo({ owner: "o", name: "empty", private: true, cloneUrl: empty });
    const task = await w.store.task.insert({
      project_id: w.project,
      title: "Create index.html",
      outcome: "index.html exists",
      acceptance_criteria: ["index.html shows a quote"],
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
      inner: innerWriting({ "index.html": "<h1>quote</h1>\n" }),
      repoFor: async () => ({ clone: empty, repo: { owner: "o", name: "empty" }, base: "main" }),
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
    expect(res.summary).not.toContain("is not a commit");
    expect(res.outcome).toBe("in_review");
    expect(res.prUrl).toContain("/pull/1");
    // main holds the first commit: the README with the project's name and goal.
    const main = new GitOps({ cwd: join(w.root, "main-check"), identity });
    await main.clone(empty, { branch: "main" });
    expect((await main.log(5)).map((c) => c.subject)).toEqual([
      "Start the repository with a README",
    ]);
    expect(readFileSync(join(w.root, "main-check", "README.md"), "utf8")).toBe("# Sample\n\ng\n");
    // The task's branch starts from it and carries only the task's change.
    const check = new GitOps({ cwd: join(w.root, "branch-check"), identity });
    await check.clone(empty, { branch: res.branch });
    expect((await check.log(5)).map((c) => c.subject)).toEqual([
      "Create index.html",
      "Start the repository with a README",
    ]);
    expect(res.changedFiles).toEqual(["index.html"]);
    await w.store.close();
  });

  it("a push the host refuses fails the task in words with what to do, not git's output", async () => {
    // Before: "push failed: git push fr/... failed: remote: ... error: failed to push some refs".
    const w = await world();
    // The host refuses every push to the repository, as GitHub does for a read-only token.
    const hook = join(w.bare, "hooks", "pre-receive");
    writeFileSync(
      hook,
      "#!/bin/sh\necho 'Permission to o/sample denied to the token.' >&2\nexit 1\n",
    );
    chmodSync(hook, 0o755);
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
    expect(res.outcome).toBe("failed");
    expect(res.summary).toBe(
      `Forerunner could not push the branch ${res.branch} to o/sample: GitHub refused it: "Permission to o/sample denied to the token". Check the GitHub token in Settings and the repository on GitHub, then press Try again.`,
    );
    expect(res.summary).not.toContain("git push");
    await w.store.close();
  });

  it("an empty repository whose host refuses the first commit fails the task in words with what to do, not git's output (review, 2026-11-02)", async () => {
    // Before: 'o/empty is empty and Forerunner could not make its first commit: git push main
    // failed: fatal: expected ...\nwarning: push negotiation failed ...\nremote: Permission to
    // o/empty denied to the token.\nTo /tmp/.../empty.git\n ! [remote rejected] main -> main
    // (pre-receive hook declined). Add a first commit ...', which the runner made the task's
    // reason and the failed-task card's text.
    const w = await world();
    const empty = join(w.root, "empty.git");
    await run(["git", "init", "--bare", "-b", "main", empty]);
    const hook = join(empty, "hooks", "pre-receive");
    writeFileSync(
      hook,
      "#!/bin/sh\necho 'Permission to o/empty denied to the token.' >&2\nexit 1\n",
    );
    chmodSync(hook, 0o755);
    await w.host.createRepo({ owner: "o", name: "empty", private: true, cloneUrl: empty });
    const task = await w.store.task.insert({
      project_id: w.project,
      title: "Create index.html",
      outcome: "index.html exists",
      acceptance_criteria: ["index.html shows a quote"],
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
    let ran = false;
    const inner = innerWriting({ "index.html": "<h1>quote</h1>\n" });
    const exec = new PrTaskExecutor({
      store: w.store,
      clock: w.clock,
      host: w.host,
      inner: {
        execute: (ctx) => {
          ran = true;
          return inner.execute(ctx);
        },
      },
      repoFor: async () => ({ clone: empty, repo: { owner: "o", name: "empty" }, base: "main" }),
      worktreeRoot: join(w.root, "wt"),
      identity,
    });
    const ctx = {
      task,
      session: w.session,
      token: w.token,
      budget: w.budget,
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
    };
    const words =
      'o/empty is empty and GitHub refused Forerunner\'s first commit: "Permission to o/empty denied to the token". Check the token in Settings, then press Try again.';
    // The runner makes the message the task's reason (cut at 200) and the failed-task card's
    // text; the code is not a transient one, so the runner does not try again at once.
    await expect(exec.execute(ctx)).rejects.toMatchObject({
      message: words,
      code: "provider_auth",
    });
    expect(words.length).toBeLessThanOrEqual(200);
    expect(ran).toBe(false);
    expect((await run(["git", "--git-dir", empty, "branch", "-a"])).stdout.trim()).toBe("");
    await w.store.close();
  });

  it("a first commit refused for another reason names the host's one line, not git's output", async () => {
    const w = await world();
    const empty = join(w.root, "archived.git");
    await run(["git", "init", "--bare", "-b", "main", empty]);
    const hook = join(empty, "hooks", "pre-receive");
    writeFileSync(
      hook,
      "#!/bin/sh\necho 'This repository is archived and read-only.' >&2\nexit 1\n",
    );
    chmodSync(hook, 0o755);
    await w.host.createRepo({ owner: "o", name: "archived", private: true, cloneUrl: empty });
    const task = await w.store.task.insert({
      project_id: w.project,
      title: "Create index.html",
      outcome: "index.html exists",
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
    const exec = new PrTaskExecutor({
      store: w.store,
      clock: w.clock,
      host: w.host,
      inner: innerWriting({ "index.html": "<h1>quote</h1>\n" }),
      repoFor: async () => ({
        clone: empty,
        repo: { owner: "o", name: "archived" },
        base: "main",
      }),
      worktreeRoot: join(w.root, "wt"),
      identity,
    });
    await expect(
      exec.execute({
        task,
        session: w.session,
        token: w.token,
        budget: w.budget,
        item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      /^o\/archived is empty and Forerunner could not make its first commit: git said "This repository is archived and read-only"\. Add a README on GitHub, then press Try again\.$/,
    );
    await w.store.close();
  });

  it("a repository with branches but not the default one fails in words, with what to check", async () => {
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
    const exec = new PrTaskExecutor({
      store: w.store,
      clock: w.clock,
      host: w.host,
      inner: innerWriting({ "README.md": "# x\n" }),
      // The seeded repository has main; the host says its default branch is "trunk".
      repoFor: async () => ({ clone: w.bare, repo: { owner: "o", name: "sample" }, base: "trunk" }),
      worktreeRoot: join(w.root, "wt"),
      identity,
    });
    await expect(
      exec.execute({
        task,
        session: w.session,
        token: w.token,
        budget: w.budget,
        item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      'o/sample has no branch "trunk" to start from (it has main). Set its default branch on GitHub, then press Try again.',
    );
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

/**
 * C-49 / L-14 (the session lead's default, ADR 0106): in a repository project every task
 * branched from `origin/<default>`, so a task that waits for a done task whose pull request is
 * not merged yet did not see that work. Live (2026-11-02, forerunner-sandbox): "Check the page
 * and README section" failed with "The worktree has neither `index.html` nor a "Hello page"
 * section", because PR #4 was open and the tester branched from main. Now the dependencies'
 * unmerged branches are merged into the task's branch before it runs; its PR still targets the
 * default branch and names the PRs whose work it includes; its changed files (and the critic's
 * diff, `DEPS_BASE_REF`) are its own work only.
 */
describe("a task that waits for unmerged work builds on it (C-49)", { timeout: 120_000 }, () => {
  const repo = { owner: "o", name: "sample" };
  type W = Awaited<ReturnType<typeof world>>;

  async function taskOf(w: W, title: string, dependsOn: string[] = []) {
    return w.store.task.insert({
      project_id: w.project,
      title,
      outcome: `${title} is done`,
      acceptance_criteria: [],
      risk_tier: 1,
      status: "in_progress",
      priority: 5,
      depends_on: dependsOn,
      budget_usd_micro: 1,
      est_cost_usd_micro: 1,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
  }

  /** Run a task through the executor as the session does, then close it as the critic does. */
  async function runTask(
    w: W,
    taskId: string,
    inner: TaskExecutor & { withWorktree: (dir: string) => TaskExecutor },
    opts: { done?: boolean } = {},
  ) {
    const task = await w.store.task.mustGet(taskId);
    const res = await new PrTaskExecutor({
      store: w.store,
      clock: w.clock,
      host: w.host,
      inner,
      repoFor: async () => ({ clone: w.bare, repo, base: "main" }),
      worktreeRoot: join(w.root, "wt"),
      identity,
    }).execute({
      task,
      session: w.session,
      token: w.token,
      budget: w.budget,
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
    });
    if (res.prUrl || res.branch)
      await w.store.task.patch(taskId, {
        ...(res.prUrl ? { pr_url: res.prUrl } : {}),
        ...(res.branch ? { branch: res.branch } : {}),
      });
    if (opts.done !== false && res.outcome === "in_review") {
      let t = await w.store.task.mustGet(taskId);
      t = await w.store.task.transition(t.id, t.version, "in_review", "review", { agentId: "a" });
      await w.store.task.transition(t.id, t.version, "done", "critic accepted", { agentId: "a" });
    }
    return res;
  }

  /** An inner executor that records the files its worktree has, then writes its own. */
  function seeing(files: Record<string, string>) {
    const saw: string[][] = [];
    const inner: TaskExecutor & { withWorktree: (dir: string) => TaskExecutor } = {
      async execute() {
        return { outcome: "failed", summary: "no worktree", costUsdMicro: 0 };
      },
      withWorktree(dir) {
        return {
          async execute() {
            saw.push(
              readdirSync(dir)
                .filter((f) => f !== ".git")
                .sort(),
            );
            for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
            return {
              outcome: "done",
              summary: "**Summary**\nWrote the files.\nLesson: check the folder first.",
              costUsdMicro: 1000,
            };
          },
        };
      },
    };
    return { inner, saw };
  }

  async function filesOn(w: W, branch: string) {
    const r = await run(["git", "--git-dir", w.bare, "ls-tree", "-r", "--name-only", branch]);
    return r.stdout.split(/\r?\n/).filter(Boolean).sort();
  }

  async function prOf(w: W, branch: string | undefined) {
    return (await w.host.listPullRequests(repo, { state: "open" })).find(
      (p) => p.head.ref === branch,
    );
  }

  it("B sees A's unmerged file; B's PR targets main and names A's PR; B's changed files and diff base are its own", async () => {
    const w = await world();
    const a = await taskOf(w, "Add index.html");
    const ra = await runTask(w, a.id, seeing({ "index.html": "<h1>hello</h1>\n" }).inner);
    expect(ra.outcome).toBe("in_review");
    const b = await taskOf(w, "Check the page", [a.id]);
    const sb = seeing({ "check.sh": "test -f index.html\n" });
    const rb = await runTask(w, b.id, sb.inner);
    expect(rb.outcome).toBe("in_review");
    // The check ran in a folder that has the page it checks.
    expect(sb.saw[0]).toContain("index.html");
    expect(await filesOn(w, rb.branch ?? "")).toEqual(["README.md", "check.sh", "index.html"]);
    // B's PR targets the default branch and says it carries A's unmerged work.
    const prB = await prOf(w, rb.branch);
    expect(prB?.base.ref).toBe("main");
    // How to merge it so nothing conflicts (ADR 0111): never "Merge in any order".
    expect(prB?.body).toContain(
      "Builds on #1 (not merged yet): this pull request includes its changes. Merge #1 first, or use Merge in Forerunner, which merges them in order.",
    );
    expect(prB?.body).not.toMatch(/any order/i);
    // Only B's own work is B's: the session's files and the critic's diff base.
    expect(rb.changedFiles).toEqual(["check.sh"]);
    const wt = new GitOps({ cwd: join(w.root, "wt", b.id), identity });
    expect(await wt.hasRef(DEPS_BASE_REF)).toBe(true);
    expect(await wt.filesBetween(DEPS_BASE_REF)).toEqual(["check.sh"]);
    // A task with nothing unmerged before it keeps no such base (the critic diffs the branch).
    const wa = new GitOps({ cwd: join(w.root, "wt", a.id), identity });
    expect(await wa.hasRef(DEPS_BASE_REF)).toBe(false);
    await w.store.close();
  });

  it("a chain: C waits for B, which waits for A, and gets both; a dependency merged meanwhile is not named", async () => {
    const w = await world();
    const a = await taskOf(w, "Add index.html");
    await runTask(w, a.id, seeing({ "index.html": "<h1>hello</h1>\n" }).inner);
    const b = await taskOf(w, "Add styles.css", [a.id]);
    const rb = await runTask(w, b.id, seeing({ "styles.css": "h1 { color: red }\n" }).inner);
    const c = await taskOf(w, "Write the notes", [b.id]);
    const sc = seeing({ "NOTES.md": "notes\n" });
    const rc = await runTask(w, c.id, sc.inner);
    expect(sc.saw[0]).toEqual(["README.md", "index.html", "styles.css"]);
    expect((await prOf(w, rc.branch))?.body).toContain(
      "Builds on #1 and #2 (not merged yet): this pull request includes their changes. Merge #1 and #2 first, or use Merge in Forerunner, which merges them in order.",
    );
    expect(rc.changedFiles).toEqual(["NOTES.md"]);
    expect(rb.changedFiles).toEqual(["styles.css"]);

    // A's PR is merged on the host (the person merged it): a fourth task names only B's.
    const merger = new GitOps({ cwd: join(w.root, "merger"), identity });
    await merger.clone(w.bare);
    const aBranch = (await w.store.task.mustGet(a.id)).branch ?? "";
    expect((await merger.mergeFrom(`origin/${aBranch}`, "Merge A")).ok).toBe(true);
    await merger.push("main");
    await w.host.mergePullRequest(repo, 1);
    const d = await taskOf(w, "Add a footer", [a.id, b.id]);
    const rd = await runTask(w, d.id, seeing({ "footer.html": "<footer></footer>\n" }).inner);
    const prD = await prOf(w, rd.branch);
    expect(prD?.body).toContain(
      "Builds on #2 (not merged yet): this pull request includes its changes. Merge #2 first, or use Merge in Forerunner, which merges them in order.",
    );
    expect(prD?.body).not.toContain("#1");
    expect(rd.changedFiles).toEqual(["footer.html"]);
    await w.store.close();
  });

  it("B's next attempt (sent back) keeps the base it started from: its files stay its own, its PR gets a comment, no new merge", async () => {
    const w = await world();
    const a = await taskOf(w, "Add index.html");
    await runTask(w, a.id, seeing({ "index.html": "<h1>hello</h1>\n" }).inner);
    const b = await taskOf(w, "Check the page", [a.id]);
    const first = await runTask(w, b.id, seeing({ "check.sh": "true\n" }).inner, { done: false });
    const wt = new GitOps({ cwd: join(w.root, "wt", b.id), identity });
    const merges = async () =>
      (
        await run([
          "git",
          "-C",
          join(w.root, "wt", b.id),
          "rev-list",
          "--merges",
          "--count",
          "HEAD",
        ])
      ).stdout.trim();
    const before = await merges();
    // A second run in a later session (the worktree is reused, as after a restart).
    const second = await runTask(w, b.id, seeing({ "check.sh": "test -f index.html\n" }).inner);
    expect(second.outcome).toBe("in_review");
    expect(second.prUrl).toBe(first.prUrl);
    expect(second.changedFiles).toEqual(["check.sh"]);
    expect(await merges()).toBe(before);
    expect(await wt.filesBetween(DEPS_BASE_REF)).toEqual(["check.sh"]);
    const comments = await w.host.listPullRequestComments(repo, 2);
    expect(comments.at(-1)?.body).toContain(
      "Builds on #1 (not merged yet): this pull request includes its changes. Merge #1 first, or use Merge in Forerunner, which merges them in order.",
    );
    expect(comments.at(-1)?.body).not.toMatch(/Lesson:/);
    await w.store.close();
  });

  it("two dependencies whose work conflicts: the task waits for the person with the reason in words; nothing runs", async () => {
    const w = await world();
    const a = await taskOf(w, "Write the page");
    await runTask(w, a.id, seeing({ "index.html": "<h1>one</h1>\n" }).inner);
    const b = await taskOf(w, "Write the other page");
    await runTask(w, b.id, seeing({ "index.html": "<h1>two</h1>\n" }).inner);
    const c = await taskOf(w, "Check both pages", [a.id, b.id]);
    const sc = seeing({ "check.sh": "true\n" });
    const rc = await runTask(w, c.id, sc.inner, { done: false });
    expect(sc.saw).toEqual([]);
    expect(rc.outcome).toBe("needs_human");
    expect(rc.costUsdMicro).toBe(0);
    expect(rc.summary).toBe(
      'The work it builds on conflicts: "Write the other page" (pull request #2) and "Write the page" (pull request #1) both change index.html. Merge them on GitHub, resolving the conflict, then press Try again.',
    );
    await w.store.close();
  });

  it("PR texts carry no model leftovers: no empty criteria heading, no Lesson lines, a plain commit message (L-19)", async () => {
    const w = await world();
    const a = await taskOf(w, "Add index.html");
    const ra = await runTask(w, a.id, seeing({ "index.html": "<h1>hello</h1>\n" }).inner);
    const body = (await prOf(w, ra.branch))?.body ?? "";
    expect(body).not.toContain("Acceptance criteria:");
    expect(body).not.toMatch(/Lesson:/);
    expect(body).toContain("Wrote the files.");
    const log = await run([
      "git",
      "--git-dir",
      w.bare,
      "log",
      "-1",
      "--format=%B",
      ra.branch ?? "",
    ]);
    expect(log.stdout).not.toContain("**");
    expect(log.stdout).not.toMatch(/Lesson:/);
    expect(log.stdout).toContain("Wrote the files.");
    await w.store.close();
  });
});

describe("Local only: the person's folder the run can use and that never leaves this computer (merged-copy, ADR 0113)", {
  timeout: 120_000,
}, () => {
  /** A run that does `work` in the worktree; what it saw is kept. */
  function agent(work: (dir: string) => Promise<void> | void): TaskExecutor & {
    withWorktree: (dir: string) => TaskExecutor;
  } {
    return {
      async execute() {
        return { outcome: "done", summary: "no worktree", costUsdMicro: 0 };
      },
      withWorktree(dir) {
        return {
          async execute() {
            await work(dir);
            return { outcome: "done", summary: "Wrote the page.", costUsdMicro: 1000 };
          },
        };
      },
    };
  }
  async function setup() {
    const w = await world();
    const source = join(w.root, "copy", "Local only");
    mkdirSync(join(source, "drafts"), { recursive: true });
    writeFileSync(join(source, "notes.txt"), "the person's notes\n");
    writeFileSync(join(source, "drafts", "plan.md"), "# plan\n");
    const task = await w.store.task.insert({
      project_id: w.project,
      title: "Write the page",
      outcome: "page.html holds the page",
      acceptance_criteria: ["page.html exists"],
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
    const exec = (inner: TaskExecutor & { withWorktree: (dir: string) => TaskExecutor }) =>
      new PrTaskExecutor({
        store: w.store,
        clock: w.clock,
        host: w.host,
        inner,
        repoFor: async () => ({
          clone: w.bare,
          repo: { owner: "o", name: "sample" },
          base: "main",
        }),
        worktreeRoot: join(w.root, "wt"),
        identity,
        localOnlyFor: async () => source,
      });
    const ctx = async () => ({
      task: await w.store.task.mustGet(task.id),
      session: w.session,
      token: w.token,
      budget: w.budget,
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
    });
    const onHost = async (branch: string | undefined) =>
      (
        await run(["git", "--git-dir", w.bare, "ls-tree", "-r", "--name-only", branch ?? "main"], {
          allowFailure: true,
        })
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean);
    return { w, source, task, exec, ctx, onHost, wt: join(w.root, "wt", task.id) };
  }

  it("the run reads and writes it in its worktree; it is copied back, never committed, pushed, in the PR or the changed files", async () => {
    const { w, source, exec, ctx, onHost, wt } = await setup();
    const seen: string[] = [];
    const res = await exec(
      agent((dir) => {
        seen.push(readFileSync(join(dir, "Local only", "notes.txt"), "utf8"));
        seen.push(readFileSync(join(dir, "Local only", "drafts", "plan.md"), "utf8"));
        writeFileSync(join(dir, "Local only", "summary.txt"), "the agent's summary\n");
        writeFileSync(join(dir, "Local only", "drafts", "plan.md"), "# plan, done\n");
        writeFileSync(join(dir, "page.html"), "<h1>page</h1>\n");
      }),
    ).execute(await ctx());
    expect(seen).toEqual(["the person's notes\n", "# plan\n"]);
    expect(res.outcome).toBe("in_review");
    expect(res.changedFiles).toEqual(["page.html"]);
    expect(await onHost(res.branch)).toEqual(["README.md", "page.html"]);
    const pr = (await w.host.listPullRequests({ owner: "o", name: "sample" }))[0];
    expect(pr?.body ?? "").not.toContain("Local only");
    // Back in the person's folder: the new file and the changed one; theirs untouched.
    expect(readFileSync(join(source, "summary.txt"), "utf8")).toBe("the agent's summary\n");
    expect(readFileSync(join(source, "drafts", "plan.md"), "utf8")).toBe("# plan, done\n");
    expect(readFileSync(join(source, "notes.txt"), "utf8")).toBe("the person's notes\n");
    // The worktree keeps no copy for the review to read, and no marker.
    expect(existsSync(join(wt, "Local only"))).toBe(false);
    expect(existsSync(join(wt, ".git", "forerunner-local-only.json"))).toBe(false);
    expect(res.summary).toBe("Wrote the page.");
    await w.store.close();
  });

  it("a file the person changed during the run keeps their version; the agent's is beside it, and the task's result says so", async () => {
    const { w, source, exec, ctx } = await setup();
    const res = await exec(
      agent((dir) => {
        writeFileSync(join(dir, "Local only", "notes.txt"), "the agent's notes\n");
        writeFileSync(join(dir, "page.html"), "<h1>page</h1>\n");
        // The person edits the same file in their folder meanwhile.
        writeFileSync(join(source, "notes.txt"), "the person's newer notes\n");
      }),
    ).execute(await ctx());
    expect(res.outcome).toBe("in_review");
    expect(readFileSync(join(source, "notes.txt"), "utf8")).toBe("the person's newer notes\n");
    expect(readFileSync(join(source, "notes (from Write the page).txt"), "utf8")).toBe(
      "the agent's notes\n",
    );
    expect(res.summary).toBe(
      'You changed "notes.txt" in Local only during this run, so your version stays and the agent\'s is beside it as "notes (from Write the page).txt".\n\nWrote the page.',
    );
    // Never in the pull request.
    const pr = (await w.host.listPullRequests({ owner: "o", name: "sample" }))[0];
    expect(pr?.body ?? "").not.toContain("Local only");
    await w.store.close();
  });

  it("an agent's own commit of a Local only file is refused at the push with one sentence; nothing reaches the host", async () => {
    const { w, exec, ctx, onHost } = await setup();
    const res = await exec(
      agent(async (dir) => {
        writeFileSync(join(dir, "page.html"), "<h1>page</h1>\n");
        await run(["git", "add", "-f", "Local only/notes.txt"], { cwd: dir });
        await run(
          [
            "git",
            "-c",
            "user.name=Agent",
            "-c",
            "user.email=agent@example.test",
            "commit",
            "-q",
            "-m",
            "my own commit",
          ],
          { cwd: dir },
        );
      }),
    ).execute(await ctx());
    expect(res.outcome).toBe("failed");
    expect(res.summary).toMatch(
      /^Forerunner did not upload the branch fr\/[0-9a-f]{8}-write-the-page: it holds "Local only\/notes\.txt", files of Local only, which never leave this computer\. Press Try again to redo the work without them\.$/,
    );
    expect(await onHost(res.branch)).toEqual([]);
    expect(await w.host.listPullRequests({ owner: "o", name: "sample" })).toEqual([]);
    await w.store.close();
  });

  it("a link inside Local only that points out of it is not followed, either way", async () => {
    const { w, source, exec, ctx } = await setup();
    const outside = join(w.root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "not the run's\n");
    // A link (a junction on Windows) to a folder outside Local only, in the person's folder.
    symlinkSync(outside, join(source, "elsewhere"), "junction");
    let sawLink = true;
    let planted = "";
    const res = await exec(
      agent((dir) => {
        sawLink = existsSync(join(dir, "Local only", "elsewhere"));
        // The agent plants its own link out of the folder, and writes through it.
        planted = join(w.root, "planted-target");
        mkdirSync(planted, { recursive: true });
        symlinkSync(planted, join(dir, "Local only", "out"), "junction");
        writeFileSync(join(dir, "Local only", "out", "x.txt"), "through the link\n");
        writeFileSync(join(dir, "page.html"), "<h1>page</h1>\n");
      }),
    ).execute(await ctx());
    expect(res.outcome).toBe("in_review");
    expect(sawLink).toBe(false);
    // The agent's link was not copied back, nor followed into the person's folder.
    expect(existsSync(join(source, "out"))).toBe(false);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("not the run's\n");
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
    await w.store.close();
  });

  it("a review's try folder a dead daemon left is never committed or pushed, in a workspace or a repository (W6-26)", async () => {
    // Before: `.forerunner-try/` (the try's samples, its server driver) was not excluded, so
    // the next "Workspace before" commit or a retry's PR commit picked it up.
    const { w, exec, ctx, onHost } = await setup();
    const res = await exec(
      agent((dir) => {
        mkdirSync(join(dir, ".forerunner-try"), { recursive: true });
        writeFileSync(join(dir, ".forerunner-try", "sample-1.txt"), "left by a review\n");
        writeFileSync(join(dir, "page.html"), "<h1>page</h1>\n");
      }),
    ).execute(await ctx());
    expect(res.outcome).toBe("in_review");
    expect(await onHost(res.branch)).toEqual(["README.md", "page.html"]);
    // A project's own folder (no repository): the baseline and the run's change leave it out.
    const workspace = join(w.root, "workspace");
    mkdirSync(join(workspace, ".forerunner-try"), { recursive: true });
    writeFileSync(join(workspace, ".forerunner-try", "driver.mjs"), "// a try's driver\n");
    writeFileSync(join(workspace, "notes.md"), "# notes\n");
    const inWorkspace = new PrTaskExecutor({
      store: w.store,
      clock: w.clock,
      host: w.host,
      inner: agent((dir) => {
        writeFileSync(join(dir, "page.html"), "<h1>page</h1>\n");
      }),
      repoFor: async () => null,
      workspaceFor: async () => workspace,
      worktreeRoot: join(w.root, "wt"),
      identity,
    });
    const ran = await inWorkspace.execute(await ctx());
    expect(ran.outcome).toBe("done");
    expect(ran.changedFiles).toEqual(["page.html"]);
    const tracked = await run(["git", "ls-files"], { cwd: workspace });
    expect(tracked.stdout).toContain("notes.md");
    expect(tracked.stdout).not.toContain(".forerunner-try");
    await w.store.close();
  });

  it("a run killed after the copy in is recovered at the next start, by the same rules", async () => {
    const { w, source, exec, ctx, wt } = await setup();
    // The app closes in the middle of the run: the run never returns.
    let stop: () => void = () => undefined;
    const killed = new Promise<void>((r) => {
      stop = r;
    });
    void exec(
      agent(async (dir) => {
        writeFileSync(join(dir, "Local only", "summary.txt"), "written before the crash\n");
        stop();
        await new Promise(() => undefined);
      }),
    ).execute(await ctx());
    await killed;
    expect(existsSync(join(wt, ".git", "forerunner-local-only.json"))).toBe(true);
    expect(existsSync(join(source, "summary.txt"))).toBe(false);
    // The next start (a new executor on the same folders) copies back what the run changed.
    const next = exec(agent(() => undefined));
    expect(next.recoverLocalOnly()).toBe(1);
    expect(readFileSync(join(source, "summary.txt"), "utf8")).toBe("written before the crash\n");
    expect(readFileSync(join(source, "notes.txt"), "utf8")).toBe("the person's notes\n");
    expect(existsSync(join(wt, "Local only"))).toBe(false);
    expect(existsSync(join(wt, ".git", "forerunner-local-only.json"))).toBe(false);
    expect(next.recoverLocalOnly()).toBe(0);
    await w.store.close();
  });

  it("a task branch whose repository now tracks a folder named Local only gets none of the person's files, and its pull request keeps the repository's (review of merged-copy)", async () => {
    // Before: the copy's record still said "folder" until its next refresh, so the run got the
    // person's folder in place of the repository's: the copy in removed the repository's files,
    // the copy back removed the folder, and the pull request deleted them.
    const { w, source, exec, ctx, onHost, wt } = await setup();
    const seed = new GitOps({ cwd: join(w.root, "seed"), identity });
    mkdirSync(join(w.root, "seed", "Local only"), { recursive: true });
    writeFileSync(join(w.root, "seed", "Local only", "readme.md"), "the repository's own\n");
    await seed.commitAll("a folder of that name");
    await seed.push("main");
    let sawTheirs = "";
    let sawMine = true;
    const res = await exec(
      agent((dir) => {
        sawTheirs = readFileSync(join(dir, "Local only", "readme.md"), "utf8");
        sawMine = existsSync(join(dir, "Local only", "notes.txt"));
        writeFileSync(join(dir, "page.html"), "<h1>page</h1>\n");
      }),
    ).execute(await ctx());
    expect(res.outcome).toBe("in_review");
    expect(sawTheirs).toBe("the repository's own\n");
    expect(sawMine).toBe(false);
    expect(res.changedFiles).toEqual(["page.html"]);
    expect(await onHost(res.branch)).toEqual(["Local only/readme.md", "README.md", "page.html"]);
    expect(readFileSync(join(source, "notes.txt"), "utf8")).toBe("the person's notes\n");
    expect(existsSync(join(source, "readme.md"))).toBe(false);
    expect(existsSync(join(wt, ".git", "forerunner-local-only.json"))).toBe(false);
    await w.store.close();
  });
});

/**
 * budget-resume (ADR 0112 amended, the owner's decision of 2026-11-02): a paused task keeps its
 * work and continues from it. Before, the executor returned before any commit for every outcome
 * but done, so a paused run's files stayed uncommitted in the task's worktree; the next run's
 * `checkout -B <branch> origin/main` carried them over or, when main had changed the same file,
 * git refused ("Please commit your changes or stash them"), a provider_error retried once and
 * then Failed, and Try again failed the same way. In a project's folder, the next task's
 * "Workspace before ..." snapshot (or the session's own commit) took them in as everyone's start.
 */
describe("a paused task keeps its work and continues from it (budget-resume)", {
  timeout: 120_000,
}, () => {
  type Inner = TaskExecutor & { withWorktree: (dir: string) => TaskExecutor };
  /** A run that does `work` in its folder and ends as `result` says. */
  function agent(
    work: (dir: string) => Promise<void> | void,
    result: Partial<Awaited<ReturnType<TaskExecutor["execute"]>>> = {},
  ): Inner {
    return {
      async execute() {
        return { outcome: "done", summary: "no worktree", costUsdMicro: 0 };
      },
      withWorktree(dir) {
        return {
          async execute() {
            await work(dir);
            return {
              outcome: "done",
              summary: "Wrote the guide.",
              costUsdMicro: 1000,
              checksPassed: true,
              ...result,
            };
          },
        };
      },
    };
  }
  /** What a run that heard the wrap-up returns (`executor.ts`, ADR 0112). */
  const pausedResult = (leftToDo: string[]) => ({
    outcome: "paused" as const,
    summary:
      "The run paused before its budget of CHF 0.08 ran out: it spent CHF 0.06 and listed 2 things left to do.",
    costUsdMicro: 60_000,
    budgetStop: {
      capUsdMicro: 100_000,
      spentUsdMicro: 60_000,
      source: "task_budget" as const,
      specialist: "coder",
      stoppedBy: "wrap_up" as const,
    },
    handoff: { stopped: "guide.md has part 1.", leftToDo, stoppedBy: "wrap_up" as const },
  });

  async function setup(opts: { folder?: boolean; push?: boolean; localOnly?: boolean } = {}) {
    const w = await world();
    const source = join(w.root, "copy", "Local only");
    if (opts.localOnly) {
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "notes.txt"), "the person's notes\n");
    }
    const newTask = (title: string) =>
      w.store.task.insert({
        project_id: w.project,
        title,
        outcome: "guide.md explains the club",
        acceptance_criteria: ["guide.md exists"],
        risk_tier: 1,
        status: "in_progress",
        priority: 5,
        depends_on: [],
        budget_usd_micro: 100_000,
        est_cost_usd_micro: 1,
        actual_cost_usd_micro: 0,
        attempt: 0,
        reason: "seed",
      });
    const task = await newTask("Write the guide");
    const workspace = join(w.root, "workspace");
    const exec = (inner: Inner) =>
      new PrTaskExecutor({
        store: w.store,
        clock: w.clock,
        host: w.host,
        inner,
        repoFor: async () =>
          opts.folder
            ? null
            : { clone: w.bare, repo: { owner: "o", name: "sample" }, base: "main" },
        ...(opts.folder ? { workspaceFor: async () => workspace } : {}),
        worktreeRoot: join(w.root, "wt"),
        identity,
        ...(opts.localOnly ? { localOnlyFor: async () => source } : {}),
        pushUnfinishedFor: async () => !!opts.push,
      });
    const ctx = async (id = task.id) => {
      const t = await w.store.task.mustGet(id);
      return {
        task: t,
        session: w.session,
        token: w.token,
        budget: w.budget,
        item: { taskId: t.id, title: t.title, specialist: "coder", estimateUsdMicro: 1 },
        signal: new AbortController().signal,
      };
    };
    const hostBranches = async () =>
      (
        await run(["git", "--git-dir", w.bare, "for-each-ref", "--format=%(refname:short)"], {
          allowFailure: true,
        })
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean);
    const onHost = async (branch: string) =>
      (
        await run(["git", "--git-dir", w.bare, "ls-tree", "-r", "--name-only", branch], {
          allowFailure: true,
        })
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean);
    /** main changes `file` meanwhile (someone else's merge). */
    const mainChanges = async (file: string, content: string) => {
      const seed = new GitOps({ cwd: join(w.root, "seed"), identity });
      await seed.fetch();
      await run(["git", "-C", join(w.root, "seed"), "reset", "-q", "--hard", "origin/main"]);
      writeFileSync(join(w.root, "seed", file), content);
      await seed.commitAll(`main changes ${file}`);
      await seed.push("main");
    };
    const wt = join(w.root, "wt", task.id);
    const gitIn = (dir: string, args: string[]) =>
      run(["git", "-C", dir, ...args], { allowFailure: true }).then((r) => r.stdout.trim());
    return { w, task, newTask, exec, ctx, hostBranches, onHost, mainChanges, wt, workspace, gitIn };
  }

  it("a pause is a work-in-progress commit on the task's own branch with its to-do list; nothing is pushed by default", async () => {
    const s = await setup();
    const res = await s
      .exec(
        agent(
          (dir) => writeFileSync(join(dir, "guide.md"), "# Guide\n\n## Part 1\n"),
          pausedResult(["write part 2", "check the guide against the criteria"]),
        ),
      )
      .execute(await s.ctx());
    expect(res.outcome).toBe("paused");
    // The files it changed, for the next brief and the drawer.
    expect(res.changedFiles).toEqual(["guide.md"]);
    // One commit on the task's branch, clean worktree, its message says why and what is left.
    expect(await s.gitIn(s.wt, ["status", "--porcelain"])).toBe("");
    expect(await s.gitIn(s.wt, ["log", "-1", "--format=%s"])).toBe(
      "Work in progress: Write the guide (paused at its budget)",
    );
    const body = await s.gitIn(s.wt, ["log", "-1", "--format=%b"]);
    expect(body).toContain("Where I stopped: guide.md has part 1.");
    expect(body).toContain("Left to do:\n- write part 2\n- check the guide against the criteria");
    expect(await s.gitIn(s.wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(res.branch);
    // Nothing pushed (the setting is off), and no pull request while it is paused.
    expect(await s.hostBranches()).toEqual(["main"]);
    expect(await s.w.host.listPullRequests({ owner: "o", name: "sample" })).toHaveLength(0);
    await s.w.store.close();
  });

  it("the next run continues from the work in progress, with main merged in after main changed: no git refusal, then its pull request", async () => {
    const s = await setup();
    await s
      .exec(
        agent(
          (dir) => writeFileSync(join(dir, "guide.md"), "# Guide\n\n## Part 1\n"),
          pausedResult(["write part 2"]),
        ),
      )
      .execute(await s.ctx());
    // Someone changes main meanwhile.
    await s.mainChanges("README.md", "# sample\nchanged on main\n");
    let sawPart1 = "";
    const res = await s
      .exec(
        agent((dir) => {
          sawPart1 = readFileSync(join(dir, "guide.md"), "utf8");
          writeFileSync(join(dir, "guide.md"), `${sawPart1}\n## Part 2\n`);
        }),
      )
      .execute(await s.ctx());
    expect(sawPart1).toBe("# Guide\n\n## Part 1\n");
    expect(res.outcome, res.summary).toBe("in_review");
    expect(res.changedFiles).toEqual(["guide.md"]);
    const files = await s.onHost(res.branch ?? "");
    expect(files).toEqual(expect.arrayContaining(["README.md", "guide.md"]));
    const readme = await run(["git", "--git-dir", s.w.bare, "show", `${res.branch}:README.md`]);
    expect(readme.stdout).toContain("changed on main");
    // It continued on the commit of its work in progress (main merged in, never rebased).
    const history = await run([
      "git",
      "--git-dir",
      s.w.bare,
      "log",
      "--format=%s",
      res.branch ?? "",
    ]);
    expect(history.stdout).toContain("Work in progress: Write the guide (paused at its budget)");
    expect(history.stdout).toContain("Bring in main");
    // The pull request carries the whole work; nothing marks it as in progress any more.
    expect(await s.w.host.listPullRequests({ owner: "o", name: "sample" })).toHaveLength(1);
    expect(await s.gitIn(s.wt, ["for-each-ref", "refs/forerunner/wip/"])).toBe("");
    await s.w.store.close();
  });

  it("main changed the same lines meanwhile: the next run asks the person through the conflict card, never a generic failure", async () => {
    const s = await setup();
    await s
      .exec(
        agent(
          (dir) => writeFileSync(join(dir, "guide.md"), "# Guide by the agent\n"),
          pausedResult(["write part 2"]),
        ),
      )
      .execute(await s.ctx());
    await s.mainChanges("guide.md", "# Guide by someone else\n");
    let ran = false;
    const res = await s
      .exec(
        agent(() => {
          ran = true;
        }),
      )
      .execute(await s.ctx());
    expect(res.outcome, res.summary).toBe("needs_human");
    expect(res.summary).toContain("guide.md");
    expect(ran).toBe(false);
    const cards = await s.w.store.humanRequest.open({ humanId: s.w.human });
    expect(cards).toHaveLength(1);
    expect((cards[0]?.change_card as { key?: string } | null)?.key).toBe("githost:rebase_conflict");
    await s.w.store.close();
  });

  it("with 'Push unfinished work to GitHub' on, the work in progress is pushed without the Local only folder; Cancel sets it aside and deletes the branch there; Undo brings it back", async () => {
    const s = await setup({ push: true, localOnly: true });
    const res = await s
      .exec(
        agent(
          (dir) => writeFileSync(join(dir, "guide.md"), "# Guide\n\n## Part 1\n"),
          pausedResult(["write part 2"]),
        ),
      )
      .execute(await s.ctx());
    expect(res.outcome).toBe("paused");
    const branch = res.branch ?? "";
    expect(await s.hostBranches()).toEqual(expect.arrayContaining(["main", branch]));
    expect(await s.onHost(branch)).toEqual(["README.md", "guide.md"]);
    expect(await s.w.host.listPullRequests({ owner: "o", name: "sample" })).toHaveLength(0);
    // Cancel: the work is set aside (Undo brings it back) and the branch leaves the host.
    const exec = s.exec(agent(() => undefined));
    const aside = await exec.setAsideWork(await s.w.store.task.mustGet(s.task.id));
    expect(aside).toEqual({ files: ["guide.md"], kept: null });
    expect(existsSync(join(s.wt, "guide.md"))).toBe(false);
    expect(await s.hostBranches()).toEqual(["main"]);
    const back = await exec.bringBack(await s.w.store.task.mustGet(s.task.id));
    expect(back).toEqual({ result: "restored", files: ["guide.md"] });
    expect(readFileSync(join(s.wt, "guide.md"), "utf8")).toBe("# Guide\n\n## Part 1\n");
    // ... as work in progress again: the next run continues from it.
    let saw = "";
    const next = await s
      .exec(
        agent((dir) => {
          saw = readFileSync(join(dir, "guide.md"), "utf8");
          writeFileSync(join(dir, "guide.md"), `${saw}\n## Part 2\n`);
        }),
      )
      .execute(await s.ctx());
    expect(saw).toBe("# Guide\n\n## Part 1\n");
    expect(next.outcome, next.summary).toBe("in_review");
    await s.w.store.close();
  });

  it("a failed run's leftovers are set aside before the next attempt, which starts clean (W6-24)", async () => {
    const s = await setup();
    const failed = await s
      .exec(
        agent((dir) => writeFileSync(join(dir, "half.md"), "half\n"), {
          outcome: "failed",
          summary: "The run failed: Claude did not answer (model call failed).",
        }),
      )
      .execute(await s.ctx());
    expect(failed.outcome).toBe("failed");
    expect(existsSync(join(s.wt, "half.md"))).toBe(false);
    expect(await s.gitIn(s.wt, ["status", "--porcelain"])).toBe("");
    expect(
      await s.gitIn(s.wt, ["for-each-ref", "--format=%(refname)", "refs/forerunner/failed/"]),
    ).toBe(`refs/forerunner/failed/${s.task.id}`);
    // main changes the same file meanwhile: the next attempt is not refused by git.
    await s.mainChanges("half.md", "from main\n");
    let saw = "";
    const next = await s
      .exec(
        agent((dir) => {
          saw = readFileSync(join(dir, "half.md"), "utf8");
          writeFileSync(join(dir, "guide.md"), "# Guide\n");
        }),
      )
      .execute(await s.ctx());
    expect(saw).toBe("from main\n");
    expect(next.outcome, next.summary).toBe("in_review");
    await s.w.store.close();
  });

  it("in a project's folder a pause is its own commit, and the task's next run reviews its whole work", async () => {
    const s = await setup({ folder: true });
    const paused = await s
      .exec(
        agent(
          (dir) => writeFileSync(join(dir, "guide.md"), "# Guide\n\n## Part 1\n"),
          pausedResult(["write part 2"]),
        ),
      )
      .execute(await s.ctx());
    expect(paused.outcome).toBe("paused");
    expect(paused.changedFiles).toEqual(["guide.md"]);
    expect(await s.gitIn(s.workspace, ["log", "-1", "--format=%s"])).toBe(
      "Work in progress: Write the guide (paused at its budget)",
    );
    expect(await s.gitIn(s.workspace, ["status", "--porcelain"])).toBe("");
    // The session's own commit at its end changes the status only (statusInFolder).
    writeFileSync(join(s.workspace, "status.md"), "# Status\n");
    await run(["git", "-C", s.workspace, "add", "-A"]);
    await run([
      "git",
      "-C",
      s.workspace,
      "-c",
      "user.name=Forerunner",
      "-c",
      "user.email=forerunner@localhost",
      "commit",
      "-q",
      "-m",
      "Work of the session",
    ]);
    // The task's next run: its change set (what the critic reads) is the whole work.
    const resumed = await s
      .exec(
        agent((dir) => {
          writeFileSync(
            join(dir, "guide.md"),
            `${readFileSync(join(dir, "guide.md"), "utf8")}\n## Part 2\n`,
          );
        }),
      )
      .execute(await s.ctx());
    expect(resumed.outcome).toBe("done");
    expect(resumed.changedFiles).toEqual(["guide.md"]);
    const diff = await s.gitIn(s.workspace, ["diff", "--cached", "HEAD", "--", "guide.md"]);
    expect(diff).toContain("+## Part 1");
    expect(diff).toContain("+## Part 2");
    await s.w.store.close();
  });

  it("in a project's folder, another task's run after a pause starts from a snapshot without the paused work; Cancel of the paused task then keeps its files and says why", async () => {
    const s = await setup({ folder: true });
    await s
      .exec(
        agent(
          (dir) => writeFileSync(join(dir, "guide.md"), "# Guide\n\n## Part 1\n"),
          pausedResult(["write part 2"]),
        ),
      )
      .execute(await s.ctx());
    const other = await s.newTask("Write the notes");
    const notes = await s
      .exec(agent((dir) => writeFileSync(join(dir, "notes.md"), "# Notes\n")))
      .execute(await s.ctx(other.id));
    expect(notes.changedFiles).toEqual(["notes.md"]);
    // Its snapshot ("Workspace before ...") took nothing of the paused task's work.
    const snapshot = await s.gitIn(s.workspace, ["show", "--name-only", "--format=%s", "HEAD"]);
    expect(snapshot.split("\n")[0]).toBe(`Workspace before "Write the notes" (task ${other.id})`);
    expect(snapshot).not.toContain("guide.md");
    const exec = s.exec(agent(() => undefined));
    const aside = await exec.setAsideWork(await s.w.store.task.mustGet(s.task.id));
    expect(aside.files).toEqual([]);
    expect(aside.kept).toBe('"Write the notes" built on it');
    expect(existsSync(join(s.workspace, "guide.md"))).toBe(true);
    await s.w.store.close();
  });

  it("in a project's folder, Cancel of a paused task nothing built on sets its work aside, and Undo brings it back as work in progress", async () => {
    const s = await setup({ folder: true });
    await s
      .exec(
        agent(
          (dir) => writeFileSync(join(dir, "guide.md"), "# Guide\n\n## Part 1\n"),
          pausedResult(["write part 2"]),
        ),
      )
      .execute(await s.ctx());
    const exec = s.exec(agent(() => undefined));
    const aside = await exec.setAsideWork(await s.w.store.task.mustGet(s.task.id));
    expect(aside).toEqual({ files: ["guide.md"], kept: null });
    expect(existsSync(join(s.workspace, "guide.md"))).toBe(false);
    expect(await s.gitIn(s.workspace, ["status", "--porcelain"])).toBe("");
    const back = await exec.bringBack(await s.w.store.task.mustGet(s.task.id));
    expect(back).toEqual({ result: "restored", files: ["guide.md"] });
    expect(readFileSync(join(s.workspace, "guide.md"), "utf8")).toBe("# Guide\n\n## Part 1\n");
    expect(await s.gitIn(s.workspace, ["log", "-1", "--format=%s"])).toBe(
      "Work in progress: Write the guide (brought back)",
    );
    await s.w.store.close();
  });
});

describe("leftovers of wave 7, merge side (leftovers7-merge)", { timeout: 120_000 }, () => {
  type Inner = TaskExecutor & { withWorktree: (dir: string) => TaskExecutor };
  /** A run that does `work` in its folder and ends done (or as `result` says). */
  function agent(
    work: (dir: string) => Promise<void> | void,
    result: Partial<Awaited<ReturnType<TaskExecutor["execute"]>>> = {},
  ): Inner {
    return {
      async execute() {
        return { outcome: "done", summary: "no worktree", costUsdMicro: 0 };
      },
      withWorktree(dir) {
        return {
          async execute() {
            await work(dir);
            return {
              outcome: "done",
              summary: "Wrote it.",
              costUsdMicro: 1000,
              checksPassed: true,
              ...result,
            };
          },
        };
      },
    };
  }

  async function setup() {
    const w = await world();
    const newTask = (title: string) =>
      w.store.task.insert({
        project_id: w.project,
        title,
        outcome: "the file is written",
        acceptance_criteria: ["the file exists"],
        risk_tier: 1,
        status: "in_progress",
        priority: 5,
        depends_on: [],
        budget_usd_micro: 100_000,
        est_cost_usd_micro: 1,
        actual_cost_usd_micro: 0,
        attempt: 0,
        reason: "seed",
      });
    const exec = (inner: Inner) =>
      new PrTaskExecutor({
        store: w.store,
        clock: w.clock,
        host: w.host,
        inner,
        repoFor: async () => ({
          clone: w.bare,
          repo: { owner: "o", name: "sample" },
          base: "main",
        }),
        worktreeRoot: join(w.root, "wt"),
        identity,
      });
    const ctx = async (id: string) => {
      const t = await w.store.task.mustGet(id);
      return {
        task: t,
        session: w.session,
        token: w.token,
        budget: w.budget,
        item: { taskId: t.id, title: t.title, specialist: "coder", estimateUsdMicro: 1 },
        signal: new AbortController().signal,
      };
    };
    const lines = async (args: string[]) =>
      (await run(["git", "--git-dir", w.bare, ...args], { allowFailure: true })).stdout
        .split(/\r?\n/)
        .filter(Boolean);
    const onHost = (branch: string) => lines(["ls-tree", "-r", "--name-only", branch]);
    const subjects = (range: string) => lines(["log", "--format=%s", range]);
    const gitIn = (dir: string, args: string[]) =>
      run(["git", "-C", dir, ...args], { allowFailure: true }).then((r) => r.stdout.trim());
    return { w, newTask, exec, ctx, onHost, subjects, gitIn };
  }

  it("two tasks titled 'Write the guide' created a second apart get two branches and two pull requests; the second carries none of the first's commits (R-branch)", async () => {
    const s = await setup();
    const first = await s.newTask("Write the guide");
    await s.w.clock.advance(1000);
    const second = await s.newTask("Write the guide");
    // The cause: a UUIDv7's first 8 characters are its time, the same for 65 s.
    expect(second.id.slice(0, 8)).toBe(first.id.slice(0, 8));
    const a = await s
      .exec(agent((dir) => writeFileSync(join(dir, "guide.md"), "# Guide\n")))
      .execute(await s.ctx(first.id));
    const b = await s
      .exec(agent((dir) => writeFileSync(join(dir, "notes.md"), "# Notes\n")))
      .execute(await s.ctx(second.id));
    expect(a.outcome, a.summary).toBe("in_review");
    expect(b.outcome, b.summary).toBe("in_review");
    expect(b.branch).not.toBe(a.branch);
    expect(b.prUrl).not.toBe(a.prUrl);
    // No id on a person's screen is polish's (C-59); the name still reads as the task's.
    expect(b.branch).toMatch(/^fr\/[0-9a-f]{8}-write-the-guide$/);
    const prs = await s.w.host.listPullRequests({ owner: "o", name: "sample" });
    expect(prs.map((p) => p.head.ref).sort()).toEqual([a.branch, b.branch].sort());
    expect(await s.onHost(b.branch ?? "")).toEqual(["README.md", "notes.md"]);
    expect(await s.subjects(`main..${b.branch}`)).toEqual(["Write the guide"]);
    // The first task's pull request got nothing of the second's.
    expect(await s.onHost(a.branch ?? "")).toEqual(["README.md", "guide.md"]);
    expect(await s.w.host.listPullRequestComments({ owner: "o", name: "sample" }, 1)).toEqual([]);
    await s.w.store.close();
  });

  it("a task whose stored branch is another task's (made before the fix) does not take over that task's pull request (R-branch)", async () => {
    const s = await setup();
    const first = await s.newTask("Write the guide");
    const second = await s.newTask("Write the guide");
    const a = await s
      .exec(agent((dir) => writeFileSync(join(dir, "guide.md"), "# Guide\n")))
      .execute(await s.ctx(first.id));
    expect(a.outcome, a.summary).toBe("in_review");
    // As an older version left it: the second task stored the first one's branch name.
    await s.w.store.task.patch(second.id, { branch: a.branch ?? "" });
    const b = await s
      .exec(agent((dir) => writeFileSync(join(dir, "notes.md"), "# Notes\n")))
      .execute(await s.ctx(second.id));
    expect(b.outcome, b.summary).toBe("in_review");
    expect(b.branch).not.toBe(a.branch);
    expect(b.prUrl).not.toBe(a.prUrl);
    expect((await s.w.store.task.mustGet(second.id)).branch).toBe(b.branch);
    expect(await s.onHost(a.branch ?? "")).toEqual(["README.md", "guide.md"]);
    expect(await s.onHost(b.branch ?? "")).toEqual(["README.md", "notes.md"]);
    expect(await s.w.host.listPullRequestComments({ owner: "o", name: "sample" }, 1)).toEqual([]);
    await s.w.store.close();
  });

  it("a run the app's close or a crash cut short leaves files with no marker; the next run is not refused by git, starts clean and keeps them under the failed ref (R-dirtyworktree, W6-24)", async () => {
    const s = await setup();
    const task = await s.newTask("Write the guide");
    const wt = join(s.w.root, "wt", task.id);
    // The first run writes an untracked file and changes a tracked one, then the app goes away
    // before anything after the run (no work-in-progress commit, no leftovers set aside).
    await expect(
      s
        .exec(
          agent(() => {
            writeFileSync(join(wt, "guide.md"), "half a guide\n");
            writeFileSync(join(wt, "README.md"), "# sample, half edited\n");
            throw new Error("the app was closed");
          }),
        )
        .execute(await s.ctx(task.id)),
    ).rejects.toThrow("the app was closed");
    expect(await s.gitIn(wt, ["status", "--porcelain"])).not.toBe("");
    // Meanwhile main gets a guide.md of its own (someone else's merge).
    const seed = new GitOps({ cwd: join(s.w.root, "seed"), identity });
    writeFileSync(join(s.w.root, "seed", "guide.md"), "main's guide\n");
    await seed.commitAll("main adds guide.md");
    await seed.push("main");
    let saw: { guide: string; readme: string } | null = null;
    const next = await s
      .exec(
        agent((dir) => {
          saw = {
            guide: readFileSync(join(dir, "guide.md"), "utf8"),
            readme: readFileSync(join(dir, "README.md"), "utf8"),
          };
          writeFileSync(join(dir, "notes.md"), "# Notes\n");
        }),
      )
      .execute(await s.ctx(task.id));
    expect(next.outcome, next.summary).toBe("in_review");
    // It started from main as it is now, without the cut-short run's files.
    expect(saw).toEqual({ guide: "main's guide\n", readme: "# sample\n" });
    expect(await s.onHost(next.branch ?? "")).toEqual(["README.md", "guide.md", "notes.md"]);
    expect(next.changedFiles).toEqual(["notes.md"]);
    // The leftovers are kept, not lost: the failed ref holds both files as they were left.
    const failed = `refs/forerunner/failed/${task.id}`;
    expect(await s.gitIn(wt, ["show", `${failed}:guide.md`])).toBe("half a guide");
    expect(await s.gitIn(wt, ["show", `${failed}:README.md`])).toBe("# sample, half edited");
    await s.w.store.close();
  });

  it("a rebase a crash left half done in the task's worktree is ended before the next run, which updates its pull request (R-dirtyworktree)", async () => {
    const s = await setup();
    const task = await s.newTask("Write the guide");
    const wt = join(s.w.root, "wt", task.id);
    const first = await s
      .exec(agent((dir) => writeFileSync(join(dir, "README.md"), "# sample by the task\n")))
      .execute(await s.ctx(task.id));
    expect(first.outcome, first.summary).toBe("in_review");
    // main changes the same line; the app went away in the middle of the rebase onto it.
    const seed = new GitOps({ cwd: join(s.w.root, "seed"), identity });
    writeFileSync(join(s.w.root, "seed", "README.md"), "# sample by main\n");
    await seed.commitAll("main changes README.md");
    await seed.push("main");
    await s.gitIn(wt, ["fetch", "-q", "origin"]);
    await s.gitIn(wt, ["rebase", "origin/main"]);
    expect(await s.gitIn(wt, ["status"])).toContain("rebase in progress");
    const next = await s
      .exec(agent((dir) => writeFileSync(join(dir, "notes.md"), "# Notes\n")))
      .execute(await s.ctx(task.id));
    // The rebase was ended first, so the run's own rebase onto main names its conflict, in
    // README.md, on the person's conflict card (before: "rebase conflict in " with no file,
    // and the task's commit was lost with the half-done rebase).
    expect(next.outcome).toBe("needs_human");
    expect(next.summary).toBe("rebase conflict in README.md");
    expect(await s.gitIn(wt, ["status"])).not.toContain("rebase in progress");
    const card = (await s.w.store.humanRequest.list({ status: "open" } as never)).find(
      (r) => r.task_id === task.id,
    );
    expect(card?.why).toContain("conflicts in README.md");
    await s.w.store.close();
  });

  it("after the repository starts tracking 'Local only/', a reused worktree commits a new file there (R-exclude)", async () => {
    const s = await setup();
    const task = await s.newTask("Write the page");
    const wt = join(s.w.root, "wt", task.id);
    const first = await s
      .exec(agent((dir) => writeFileSync(join(dir, "page.html"), "<h1>page</h1>\n")))
      .execute(await s.ctx(task.id));
    expect(first.outcome, first.summary).toBe("in_review");
    expect(readFileSync(join(wt, ".git", "info", "exclude"), "utf8")).toContain("/Local only/");
    // The repository then tracks a folder of that name: it is the repository's own.
    const seed = new GitOps({ cwd: join(s.w.root, "seed"), identity });
    mkdirSync(join(s.w.root, "seed", "Local only"), { recursive: true });
    writeFileSync(join(s.w.root, "seed", "Local only", "a.txt"), "the repository's\n");
    await seed.commitAll("a folder named Local only");
    await seed.push("main");
    const next = await s
      .exec(
        agent((dir) => {
          mkdirSync(join(dir, "Local only"), { recursive: true });
          writeFileSync(join(dir, "Local only", "b.txt"), "the task's\n");
        }),
      )
      .execute(await s.ctx(task.id));
    expect(next.outcome, next.summary).toBe("in_review");
    expect(await s.onHost(next.branch ?? "")).toContain("Local only/b.txt");
    expect(next.changedFiles).toContain("Local only/b.txt");
    // Forerunner's own line for it is gone; the try folder's stays.
    const exclude = readFileSync(join(wt, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain("/Local only/");
    expect(exclude).toContain("/.forerunner-try/");
    await s.w.store.close();
  });
});
