import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  DEPS_BASE_REF,
  GitHubHost,
  GitOps,
  MemoryGitHost,
  PrTaskExecutor,
} from "@forerunner/capabilities";
import { join, run, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { FakeGitHost } from "@forerunner/testenv";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { GitDiffPort } from "../src/loop/critic.ts";
import type { TaskExecutor } from "../src/session/runner.ts";

/**
 * C-49 / L-14 (ADR 0106): a task that waits for a done task whose pull request is not merged yet
 * now starts from that work (`PrTaskExecutor` merges the dependencies' branches in), and the
 * critic reviews only the task's own change. Before, the critic's diff was the branch against
 * the default branch (`origin/HEAD...HEAD`), which would hold the dependency's files too: the
 * critic would have reviewed (and the project's checks measured) work that is not the task's.
 */
const identity = { name: "Forerunner", email: "agent@example.test" };
const repo = { owner: "o", name: "sample" };

const roots: string[] = [];
const stores: StateStore[] = [];
const fakeHosts: FakeGitHost[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const h of fakeHosts.splice(0)) await h.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function world() {
  const clock = new SimulatedClock("2026-11-02T08:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  stores.push(store);
  const human = (await store.human.insert({ name: "J", email: "j@x.test" })).id;
  const agent = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
  const project = (await store.project.insert({ name: "Sample", repos: ["o/sample"] })).id;
  const session = await store.session.insert({
    agent_id: agent,
    project_id: project,
    trigger: "manual",
    status: "running",
    runner: "pc",
  });
  const root = mkdtempSync(join(tmpdir(), "fr-c49 "));
  roots.push(root);
  const bare = join(root, "sample.git");
  await run(["git", "init", "--bare", "-b", "main", bare]);
  const seed = new GitOps({ cwd: join(root, "seed"), identity });
  await seed.clone(bare);
  writeFileSync(join(root, "seed", "README.md"), "# sample\n");
  await seed.commitAll("seed");
  await seed.push("main");
  const host = new MemoryGitHost("alice");
  await host.createRepo({ ...repo, private: true, cloneUrl: bare });
  const token = new TokenIssuer({ now: () => clock.now() }).issue({
    runId: "r",
    sessionId: session.id,
    agentId: agent,
    ownerHumanId: human,
    projectId: project,
    allowedTools: [],
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
  const worktreeRoot = join(root, "worktrees");
  const executor = (files: Record<string, string>) =>
    new PrTaskExecutor({
      store,
      clock,
      host,
      inner: {
        execute: async () => ({ outcome: "failed", summary: "no worktree", costUsdMicro: 0 }),
        withWorktree: (dir): TaskExecutor => ({
          execute: async () => {
            for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
            return { outcome: "done", summary: "Wrote it.", costUsdMicro: 1000 };
          },
        }),
      },
      repoFor: async () => ({ clone: bare, repo, base: "main" }),
      worktreeRoot,
      identity,
    });
  const runTask = async (task: TaskRow, files: Record<string, string>) => {
    const res = await executor(files).execute({
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
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
    });
    await store.task.patch(task.id, { branch: res.branch ?? null, pr_url: res.prUrl ?? null });
    return res;
  };
  const taskOf = (title: string, dependsOn: string[] = [], status: TaskRow["status"] = "done") =>
    store.task.insert({
      project_id: project,
      title,
      outcome: `${title} is done`,
      risk_tier: 1,
      status,
      depends_on: dependsOn,
      budget_usd_micro: 1_000_000,
    });
  return { store, worktreeRoot, runTask, taskOf };
}

describe("the critic reviews a dependent task's own change (C-49)", { timeout: 120_000 }, () => {
  it("the diff of a task built on an unmerged dependency holds its file only; a task without one keeps the branch's diff", async () => {
    const w = await world();
    const a = await w.taskOf("Add index.html");
    const ra = await w.runTask(a, { "index.html": "<h1>hello page</h1>\n" });
    expect(ra.outcome).toBe("in_review");
    const b = await w.taskOf("Check the page", [a.id], "in_progress");
    const rb = await w.runTask(b, { "check.sh": "grep -q hello index.html\n" });
    expect(rb.outcome).toBe("in_review");
    const diffPort = new GitDiffPort(run, w.worktreeRoot);
    const diffB = await diffPort.diffFor(b, undefined);
    expect(diffB?.changedFiles).toEqual(["check.sh"]);
    expect(diffB?.diff).toContain("+grep -q hello index.html");
    expect(diffB?.diff).not.toContain("hello page");
    // A's own review is unchanged: its branch against the default branch.
    const diffA = await diffPort.diffFor(a, undefined);
    expect(diffA?.changedFiles).toEqual(["index.html"]);
    expect(diffA?.diff).toContain("+<h1>hello page</h1>");
    const wtB = new GitOps({ cwd: join(w.worktreeRoot, b.id), identity });
    expect(await wtB.hasRef(DEPS_BASE_REF)).toBe(true);
  });

  it("what the person changes in the worktree after the run is still in the diff (uncommitted work)", async () => {
    const w = await world();
    const a = await w.taskOf("Add index.html");
    await w.runTask(a, { "index.html": "<h1>hello page</h1>\n" });
    const b = await w.taskOf("Check the page", [a.id], "in_progress");
    await w.runTask(b, { "check.sh": "true\n" });
    writeFileSync(join(w.worktreeRoot, b.id, "extra.txt"), "pending\n");
    const diff = await new GitDiffPort(run, w.worktreeRoot).diffFor(b, undefined);
    expect([...(diff?.changedFiles ?? [])].sort()).toEqual(["check.sh", "extra.txt"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Dependent branches stay true (ADR 0111, 'dependent-branches'): real git against the testenv
// fake GitHub (its REST API and git smart HTTP), the PR executor as a session runs it.
// ---------------------------------------------------------------------------------------------
const OWNER = "alice";
const HOST_REPO = { owner: OWNER, name: "app" };
const FULL = `${OWNER}/app`;

async function hostWorld() {
  const clock = new SimulatedClock("2026-11-03T08:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  stores.push(store);
  const human = (await store.human.insert({ name: "J", email: "j@x.test" })).id;
  const agent = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
  const project = (await store.project.insert({ name: "App", repos: [FULL] })).id;
  const session = await store.session.insert({
    agent_id: agent,
    project_id: project,
    trigger: "manual",
    status: "running",
    runner: "pc",
  });
  const root = mkdtempSync(join(tmpdir(), "fr-dep-branches-"));
  roots.push(root);
  const host = await FakeGitHost.start({ rootDir: join(root, "host"), clock });
  fakeHosts.push(host);
  host.createUser({ login: OWNER, name: "Alice", email: identity.email });
  const hostRepo = await host.createRepo({
    owner: OWNER,
    name: "app",
    private: true,
    defaultBranch: "main",
    initialFiles: { "README.md": "# app\n" },
  });
  const ghToken = host.createToken({ owner: OWNER, kind: "classic", scopes: ["repo"] }).token;
  const github = new GitHubHost({ token: ghToken, baseUrl: host.baseUrl, clock });
  const token = new TokenIssuer({ now: () => clock.now() }).issue({
    runId: "r",
    sessionId: session.id,
    agentId: agent,
    ownerHumanId: human,
    projectId: project,
    allowedTools: [],
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
  const worktreeRoot = join(root, "worktrees");
  const executor = (files: Record<string, string>) =>
    new PrTaskExecutor({
      store,
      clock,
      host: github,
      inner: {
        execute: async () => ({ outcome: "failed", summary: "no worktree", costUsdMicro: 0 }),
        withWorktree: (dir): TaskExecutor => ({
          execute: async () => {
            for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
            return { outcome: "done", summary: "Wrote it.", costUsdMicro: 1000 };
          },
        }),
      },
      repoFor: async () => ({ clone: host.cloneUrl(FULL), repo: HOST_REPO, base: "main" }),
      worktreeRoot,
      token: ghToken,
      identity,
    });
  /** One run of the task as a session (or the retry ladder) runs it. */
  const runTask = async (taskId: string, files: Record<string, string>) => {
    const task = await store.task.mustGet(taskId);
    const res = await executor(files).execute({
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
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
    });
    // The host takes in a push after answering it (as GitHub does): wait for it.
    await host.settle();
    await store.task.patch(task.id, {
      ...(res.branch ? { branch: res.branch } : {}),
      ...(res.prUrl ? { pr_url: res.prUrl } : {}),
    });
    return res;
  };
  const taskOf = (title: string, dependsOn: string[] = []) =>
    store.task.insert({
      project_id: project,
      title,
      outcome: `${title} is done`,
      risk_tier: 1,
      status: "in_progress",
      depends_on: dependsOn,
      budget_usd_micro: 1_000_000,
    });
  /** The critic accepts it. */
  const accept = async (taskId: string) => {
    let t = await store.task.mustGet(taskId);
    t = await store.task.transition(t.id, t.version, "in_review", "review", { agentId: agent });
    await store.task.transition(t.id, t.version, "done", "critic accepted", { agentId: agent });
  };
  const api = async (path: string) => {
    const res = await fetch(`${host.baseUrl}/repos/${FULL}${path}`, {
      headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, unknown>[];
  };
  /** The commit subjects GitHub lists on the pull request (its "Commits" tab). */
  const prCommits = async (n: number) =>
    (await api(`/pulls/${n}/commits`)).map(
      (c) => String((c.commit as { message: string }).message).split("\n")[0] ?? "",
    );
  /** The files GitHub lists on the pull request (its "Files changed" tab). */
  const prFiles = async (n: number) =>
    (await api(`/pulls/${n}/files`)).map((f) => String(f.filename)).sort();
  const prNumber = async (taskId: string) =>
    Number(/\/pull\/(\d+)/.exec((await store.task.mustGet(taskId)).pr_url ?? "")?.[1]);
  const hostGit = async (...args: string[]) =>
    (await run(["git", "--git-dir", hostRepo.dir, ...args])).stdout.trim();
  return {
    clock,
    store,
    host,
    github,
    worktreeRoot,
    runTask,
    taskOf,
    accept,
    prCommits,
    prFiles,
    prNumber,
    hostGit,
  };
}

describe("dependent branches stay true (ADR 0111, dependent-branches)", {
  timeout: 180_000,
}, () => {
  it("(a) a dependency squash-merged on GitHub: the dependent's next run replays none of its commits and its pull request holds only its own commits and files", async () => {
    const w = await hostWorld();
    // The dependency took two runs (the ladder sent it back once): two commits on its branch.
    const a = await w.taskOf("Add page");
    expect((await w.runTask(a.id, { "page.html": "<h1>draft</h1>\n" })).outcome).toBe("in_review");
    expect((await w.runTask(a.id, { "page.html": "<h1>hello</h1>\n" })).outcome).toBe("in_review");
    await w.accept(a.id);
    const prA = await w.prNumber(a.id);
    expect(await w.prCommits(prA)).toEqual(["Add page", "Add page"]);
    // The dependent builds on it (one dependency: before, a fast-forward with no merge commit).
    const b = await w.taskOf("Add footer", [a.id]);
    expect((await w.runTask(b.id, { "footer.html": "<footer>v1</footer>\n" })).outcome).toBe(
      "in_review",
    );
    const prB = await w.prNumber(b.id);
    // The person squash-merges the dependency on GitHub.
    expect((await w.github.mergePullRequest(HOST_REPO, prA, { method: "squash" })).merged).toBe(
      true,
    );
    // The ladder runs the dependent again.
    const again = await w.runTask(b.id, { "footer.html": "<footer>v2</footer>\n" });
    expect(again.outcome).toBe("in_review");
    expect(again.changedFiles).toEqual(["footer.html"]);
    // Nothing of the dependency was replayed: the pull request holds the task's own commits.
    expect(await w.prCommits(prB)).toEqual(["Add footer", "Add footer"]);
    expect(await w.prFiles(prB)).toEqual(["footer.html"]);
    // The dependency's change reached main once, as its squash.
    expect((await w.hostGit("log", "--format=%s", "main", "--", "page.html")).split("\n")).toEqual([
      `Add page (#${prA})`,
    ]);
    // The worktree no longer builds on the dependency: the branch was rebuilt onto main.
    const wt = new GitOps({ cwd: join(w.worktreeRoot, b.id), identity });
    expect(await wt.hasRef(DEPS_BASE_REF)).toBe(false);
  });

  it("(a) a branch built on one dependency shows it brought that work in: a merge commit, and a marker the next run keeps", async () => {
    const w = await hostWorld();
    const a = await w.taskOf("Add page");
    await w.runTask(a.id, { "page.html": "<h1>hello</h1>\n" });
    await w.accept(a.id);
    const b = await w.taskOf("Add footer", [a.id]);
    const first = await w.runTask(b.id, { "footer.html": "<footer>v1</footer>\n" });
    const wt = new GitOps({ cwd: join(w.worktreeRoot, b.id), identity });
    const marker = await wt.resolveRef(DEPS_BASE_REF);
    expect(marker).toBeTruthy();
    expect(await wt.parentsOf(marker ?? "")).toHaveLength(2);
    expect(await wt.hasMergesSince("origin/main", `origin/${first.branch}`)).toBe(true);
    // The dependency is merged on GitHub with a merge commit: its commits are on main as they
    // are, so the next run keeps the branch's history and its marker (nothing to rebuild).
    await w.github.mergePullRequest(HOST_REPO, await w.prNumber(a.id), { method: "merge" });
    const again = await w.runTask(b.id, { "footer.html": "<footer>v2</footer>\n" });
    expect(again.outcome).toBe("in_review");
    expect(await wt.hasRef(DEPS_BASE_REF)).toBe(true);
    expect(again.changedFiles).toEqual(["footer.html"]);
    expect(await w.prFiles(await w.prNumber(b.id))).toEqual(["footer.html"]);
  });

  it("(e) a redo of a task whose pull request was squash-merged, or closed, opens a new pull request from a fresh branch; the old branch stays on GitHub", async () => {
    const w = await hostWorld();
    for (const end of ["squash", "closed"] as const) {
      const t = await w.taskOf(`Add ${end} page`);
      const first = await w.runTask(t.id, { [`${end}.html`]: "<h1>one</h1>\n" });
      await w.accept(t.id);
      const n = await w.prNumber(t.id);
      if (end === "squash") await w.github.mergePullRequest(HOST_REPO, n, { method: "squash" });
      else await w.github.updatePullRequest(HOST_REPO, n, { state: "closed" });
      // Redo: the task is reopened and runs again.
      const done = await w.store.task.mustGet(t.id);
      await w.store.task.reopen(t.id, done.version, "ready", "Redo asked by you");
      const redo = await w.runTask(t.id, { [`${end}.html`]: "<h1>two</h1>\n" });
      expect(redo.outcome).toBe("in_review");
      expect(redo.branch).not.toBe(first.branch);
      expect(redo.branch?.startsWith(first.branch ?? "?")).toBe(true);
      expect(redo.prUrl).not.toBe(first.prUrl);
      const pr = await w.github.getPullRequest(HOST_REPO, await w.prNumber(t.id));
      expect(pr).toMatchObject({ state: "open", head: { ref: redo.branch } });
      expect(await w.prFiles(pr.number)).toEqual([`${end}.html`]);
      // The old branch is still on GitHub (delete-on-merge is off), untouched.
      expect(await w.hostGit("rev-parse", "--verify", `refs/heads/${first.branch}`)).toMatch(
        /^[0-9a-f]{40}$/,
      );
    }
  });

  it("(f) a dependent pull request says how to merge it: never 'Merge in any order'", async () => {
    const w = await hostWorld();
    const a = await w.taskOf("Add page");
    await w.runTask(a.id, { "page.html": "<h1>hello</h1>\n" });
    await w.accept(a.id);
    const b = await w.taskOf("Add styles", [a.id]);
    await w.runTask(b.id, { "styles.css": "h1 {}\n" });
    await w.accept(b.id);
    const c = await w.taskOf("Add footer", [b.id]);
    await w.runTask(c.id, { "footer.html": "<footer></footer>\n" });
    const [na, nb, nc] = [await w.prNumber(a.id), await w.prNumber(b.id), await w.prNumber(c.id)];
    const body = async (n: number) => (await w.github.getPullRequest(HOST_REPO, n)).body;
    expect(await body(nb)).toContain(
      `Builds on #${na} (not merged yet): this pull request includes its changes. Merge #${na} first, or use Merge in Forerunner, which merges them in order.`,
    );
    expect(await body(nc)).toContain(
      `Builds on #${na} and #${nb} (not merged yet): this pull request includes their changes. Merge #${na} and #${nb} first, or use Merge in Forerunner, which merges them in order.`,
    );
    for (const n of [na, nb, nc]) expect(await body(n)).not.toMatch(/any order/i);
  });
});
