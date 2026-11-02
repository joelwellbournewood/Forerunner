import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
      `Forerunner could not push the branch ${res.branch} to o/sample: GitHub refused it (the token may not write to it, or a rule protects the branch). Check the GitHub token in Settings, then press Try again.`,
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
      "o/empty is empty and GitHub refused Forerunner's first commit (the token may not write to it). Add a README on GitHub or check the token in Settings, then press Try again.";
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
    expect(prB?.body).toContain('Builds on #1 ("Add index.html"), not merged yet');
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
      'Builds on #1 ("Add index.html") and #2 ("Add styles.css"), not merged yet',
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
    expect(prD?.body).toContain('Builds on #2 ("Add styles.css"), not merged yet');
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
    expect(comments.at(-1)?.body).toContain('Builds on #1 ("Add index.html"), not merged yet');
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
