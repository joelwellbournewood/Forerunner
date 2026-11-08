import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, run, SimulatedClock, safeSegment } from "@forerunner/platform";
import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { FakeGitHost } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitOps } from "../src/githost/git.ts";
import { GitHubHost } from "../src/githost/github.ts";
import { PrTaskExecutor } from "../src/githost/pr-executor.ts";

/**
 * "Take this work out" (merged-actions, the owner's decision of 2026-11-02): a merged task's
 * work is taken out by a branch from main that reverts its merge by the way the pull request
 * was merged. Before, nothing reverted a merged pull request, and `git revert -m 1` on a squash
 * (one parent) fails while on a rebase it would undo only the last commit. Everything runs on
 * the testenv fake GitHub (its REST API, its own merge, squash and rebase, git smart HTTP).
 */
const identity = { name: "Alice", email: "alice@example.test" };
const REPO = { owner: "alice", name: "shop" };
const FULL = "alice/shop";

describe("taking merged work out by the way it was merged (merged-actions)", {
  timeout: 120_000,
}, () => {
  let host: FakeGitHost;
  let gh: GitHubHost;
  let root: string;
  let token: string;
  let store: StateStore;
  let exec: PrTaskExecutor;
  let projectId = "";
  const clock = new SimulatedClock("2026-11-08T09:00:00Z");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fr-take-out-"));
    host = await FakeGitHost.start({ rootDir: join(root, "host"), clock });
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    gh = new GitHubHost({ token, baseUrl: host.baseUrl, clock });
    await host.createRepo({
      ...REPO,
      private: true,
      initialFiles: { "README.md": "# shop\n", "price.txt": "1\n2\n3\n4\n5\n6\n7\n8\n" },
    });
    store = await openStore({ url: "sqlite::memory:", clock });
    projectId = (await store.project.insert({ name: "Shop", goal: "g", repos: [FULL] })).id;
    exec = new PrTaskExecutor({
      store,
      clock,
      host: gh,
      inner: { execute: async () => ({ outcome: "done", summary: "", costUsdMicro: 0 }) },
      repoFor: async () => ({ clone: host.cloneUrl(FULL), repo: REPO, base: "main" }),
      worktreeRoot: join(root, "wt"),
      token,
      identity,
    });
  });
  afterAll(async () => {
    await host?.stop();
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const hostGit = async (...args: string[]) =>
    (await run(["git", "--git-dir", host.repo(FULL)?.dir ?? "", ...args])).stdout.trim();
  const mainTree = () => hostGit("rev-parse", "main^{tree}");

  /** A pull request of `commits` commits (each a file), opened from main by a clone of its own. */
  async function pullRequest(name: string, commits: Record<string, string>[]) {
    const dir = join(root, `clone-${name}`);
    const git = new GitOps({ cwd: dir, identity, auth: { token } });
    await git.clone(host.cloneUrl(FULL));
    await git.createBranch(`fr/${name}`, "origin/main");
    for (const [i, files] of commits.entries()) {
      for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
      await git.commitAll(`${name} part ${i + 1}`);
    }
    await git.push(`fr/${name}`);
    const pr = await gh.createPullRequest(REPO, {
      title: name,
      body: "",
      head: `fr/${name}`,
      base: "main",
    });
    const task = await store.task.insert({
      project_id: projectId,
      title: name,
      status: "done",
      pr_url: pr.htmlUrl,
      branch: `fr/${name}`,
    });
    return { pr, task };
  }

  /** The take-out branch merged with a merge commit, as the person's Merge would. */
  async function mergeTakeOut(branch: string, title: string) {
    const pr = await gh.createPullRequest(REPO, { title, body: "", head: branch, base: "main" });
    const merged = await gh.mergePullRequest(REPO, pr.number, { sha: pr.head.sha });
    expect(merged.merged).toBe(true);
  }

  const takeOut = (task: TaskRow, number: number, mergeSha: string, headSha: string | null) =>
    exec.takeOut({ task, number, mergeSha, headSha, branch: `fr/take-out-${task.title}` });
  /** Where `takeOut` clones the repository for a task (`<worktreeRoot>/<task>-take-out`). */
  const cloneOf = (task: TaskRow) => join(root, "wt", `${safeSegment(task.id)}-take-out`);

  it.each([
    ["merge", "merged with a merge commit: git revert -m 1"],
    ["squash", "squash-merged on GitHub (one parent): the squash commit reverted, no -m"],
    ["rebase", "rebase-merged on GitHub (copies of its commits): each copy reverted"],
  ] as const)(
    "a pull request %s: main's tree after merging the take-out equals main's before the merge (%s)",
    async (method, _why) => {
      const { pr, task } = await pullRequest(`${method}-cart`, [
        { "cart.ts": "export const cart = [];\n" },
        { "cart.ts": "export const cart = [1];\n", "till.ts": "export const till = 0;\n" },
      ]);
      const before = await mainTree();
      const merged = await gh.mergePullRequest(REPO, pr.number, { method, sha: pr.head.sha });
      expect(merged.merged).toBe(true);
      const mergeSha = merged.sha ?? "";
      expect(await mainTree()).not.toBe(before);
      const mainBefore = await hostGit("rev-parse", "main");
      const out = await takeOut(task, pr.number, mergeSha, pr.head.sha);
      expect(out).toMatchObject({ kind: "pushed", how: method, sure: true, base: "main" });
      if (out.kind !== "pushed") return;
      // main itself is untouched: the take-out is a branch of its own.
      expect(await hostGit("rev-parse", "main")).toBe(mainBefore);
      expect(out.commits).toHaveLength(method === "rebase" ? 2 : 1);
      // Its clone is not kept (review of merged-actions: a full clone per task stayed on disk).
      expect(existsSync(cloneOf(task))).toBe(false);
      await mergeTakeOut(out.branch, `Take out: ${task.title}`);
      expect(await mainTree()).toBe(before);
    },
  );

  it.each([["rebase"], ["squash"]] as const)(
    "a pull request of one commit %s-merged: its one commit is taken back, and git cannot tell the way apart, so it is not named (review of merged-actions: a rebase read 'squash-merged')",
    async (method) => {
      const { pr, task } = await pullRequest(`one-${method}`, [
        { [`one-${method}.ts`]: "export const one = 1;\n" },
      ]);
      const before = await mainTree();
      const merged = await gh.mergePullRequest(REPO, pr.number, { method, sha: pr.head.sha });
      expect(merged.merged).toBe(true);
      const out = await takeOut(task, pr.number, merged.sha ?? "", pr.head.sha);
      expect(out).toMatchObject({ kind: "pushed", sure: false });
      if (out.kind !== "pushed") return;
      expect(out.commits).toEqual([merged.sha]);
      await mergeTakeOut(out.branch, `Take out: ${task.title}`);
      expect(await mainTree()).toBe(before);
    },
  );

  it("a later change to the same lines: the revert conflicts, nothing is pushed, the files are named", async () => {
    const { pr, task } = await pullRequest("prices", [
      { "price.txt": "1\n2\nTHREE\n4\n5\n6\n7\n8\n" },
    ]);
    const merged = await gh.mergePullRequest(REPO, pr.number, { sha: pr.head.sha });
    await host.seedCommit(
      REPO,
      { "price.txt": "1\n2\nTHREE and more\n4\n5\n6\n7\n8\n" },
      "a later change",
      "main",
    );
    const branches = await gh.listBranches(REPO);
    const out = await takeOut(task, pr.number, merged.sha ?? "", pr.head.sha);
    expect(out).toEqual({ kind: "conflict", files: ["price.txt"] });
    expect((await gh.listBranches(REPO)).map((b) => b.name)).toEqual(branches.map((b) => b.name));
    expect(existsSync(cloneOf(task))).toBe(false);
  });

  it("a merge commit that is not the pull request's work in any shape is not taken out", async () => {
    // A pull request still open, and an unrelated commit on main named as its merge.
    const { pr, task } = await pullRequest("unrelated", [{ "u.ts": "export const u = 1;\n" }]);
    const other = await host.seedCommit(REPO, { "other.md": "other\n" }, "other work", "main");
    expect(await takeOut(task, pr.number, other.sha, pr.head.sha)).toEqual({
      kind: "unknown_shape",
    });
    // Without the pull request's commits a one-parent merge cannot be told apart either.
    expect(await takeOut(task, pr.number, other.sha, null)).toEqual({ kind: "unknown_shape" });
    // A commit that is not on main at all.
    expect(await takeOut(task, pr.number, pr.head.sha, pr.head.sha)).toEqual({
      kind: "not_in_main",
    });
  });
  it("a dependent merged on GitHub with a merge commit that carried its dependency's work: Take this work out never takes the dependency's files out of main (R-takeoutdep)", async () => {
    // The dependency's branch, then the dependent's built on it (as `PrTaskExecutor` builds a
    // task that waits for unmerged work); the dependent's pull request is merged first on
    // GitHub, with a merge commit, so the dependency's work reaches main inside it.
    const dep = await pullRequest("dep-menu", [{ "menu.ts": "export const menu = [];\n" }]);
    const dir = join(root, "clone-dep-footer");
    const git = new GitOps({ cwd: dir, identity, auth: { token } });
    await git.clone(host.cloneUrl(FULL));
    await git.createBranch("fr/dep-footer", "origin/fr/dep-menu");
    writeFileSync(join(dir, "footer.ts"), "export const footer = 1;\n");
    await git.commitAll("dep-footer part 1");
    await git.push("fr/dep-footer");
    const pr = await gh.createPullRequest(REPO, {
      title: "dep-footer",
      body: "",
      head: "fr/dep-footer",
      base: "main",
    });
    const task = await store.task.insert({
      project_id: projectId,
      title: "dep-footer",
      status: "done",
      pr_url: pr.htmlUrl,
      branch: "fr/dep-footer",
      depends_on: [dep.task.id],
    });
    const merged = await gh.mergePullRequest(REPO, pr.number, {
      method: "merge",
      sha: pr.head.sha,
    });
    expect(merged.merged).toBe(true);
    const out = await takeOut(task, pr.number, merged.sha ?? "", pr.head.sha);
    // Refused (undo it on GitHub), or a branch that leaves the dependency's file in main.
    if (out.kind === "pushed") {
      await mergeTakeOut(out.branch, `Take out: ${task.title}`);
      const files = await hostGit("ls-tree", "--name-only", "main");
      expect(files).toContain("menu.ts");
      expect(files).not.toContain("footer.ts");
    } else expect(out).toEqual({ kind: "unknown_shape" });
    expect(await hostGit("ls-tree", "--name-only", "main")).toContain("menu.ts");
  });
});
