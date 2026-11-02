import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEPS_BASE_REF, GitOps, MemoryGitHost, PrTaskExecutor } from "@forerunner/capabilities";
import { join, run, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
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
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
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
