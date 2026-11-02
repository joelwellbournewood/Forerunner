import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, run, SimulatedClock } from "@forerunner/platform";
import { FakeGitHost } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { holdsMergedWork, ownChangeId } from "../src/githost/branch-rules.ts";
import { GitOps } from "../src/githost/git.ts";
import { GitHubHost } from "../src/githost/github.ts";
import { MemoryGitHost } from "../src/githost/memory.ts";
import { DEPS_BASE_REF } from "../src/githost/pr-executor.ts";

/**
 * ADR 0111: Forerunner merges with merge commits only, reads the branch's rules before a merge,
 * and never goes around them. Before: `mergePullRequest` sent `merge_method: "squash"` unless
 * told otherwise and the merge step never said; nothing read `allow_merge_commit` or a branch's
 * rules; the in-memory host ignored the method. Everything here runs on the fake git host over
 * its REST API and git smart HTTP.
 */
const identity = { name: "Alice", email: "alice@example.test" };
const REPO = { owner: "alice", name: "app" };

describe("merge commits and the branch's rules on the git host (ADR 0111)", {
  timeout: 60_000,
}, () => {
  let host: FakeGitHost;
  let gh: GitHubHost;
  let root: string;
  let token: string;
  const clock = new SimulatedClock("2026-11-02T09:00:00Z");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fr-merge-commits-"));
    host = await FakeGitHost.start({ rootDir: join(root, "host"), clock });
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    host.createUser({ login: "bob", name: "Bob", email: "bob@example.test" });
    token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    gh = new GitHubHost({ token, baseUrl: host.baseUrl, clock });
    await host.createRepo({
      ...REPO,
      private: true,
      initialFiles: { "README.md": "# app\n" },
    });
  });
  afterAll(async () => {
    await host?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const openPr = async (branch: string, file: string) => {
    await host.seedCommit(REPO, { [file]: `${file}\n` }, `add ${file}`, branch);
    return gh.createPullRequest(REPO, { title: file, body: "", head: branch, base: "main" });
  };
  const parents = async (sha: string) =>
    (
      await run([
        "git",
        "--git-dir",
        host.repo(REPO)?.dir ?? "",
        "rev-list",
        "--parents",
        "-n",
        "1",
        sha,
      ])
    ).stdout
      .trim()
      .split(/\s+/)
      .slice(1);

  it("merges with a merge commit by default: two parents, the merge commit on the PR, the method on the wire", async () => {
    const pr = await openPr("feat-default", "a.txt");
    const merged = await gh.mergePullRequest(REPO, pr.number, { sha: pr.head.sha });
    expect(merged.merged).toBe(true);
    const put = host
      .requests()
      .filter((r) => r.method === "PUT" && r.path.endsWith(`/pulls/${pr.number}/merge`));
    expect(put).toHaveLength(1);
    expect(await parents(merged.sha ?? "")).toEqual([expect.any(String), pr.head.sha]);
    const after = await gh.getPullRequest(REPO, pr.number);
    expect(after).toMatchObject({ merged: true, mergeCommitSha: merged.sha });
    // An open pull request's merge_commit_sha (GitHub's test merge) is never taken for a merge.
    const open = await openPr("feat-open", "b.txt");
    expect((await gh.getPullRequest(REPO, open.number)).mergeCommitSha).toBeNull();
  });

  it("reads allow_merge_commit; a repository without merge commits refuses one", async () => {
    expect((await gh.getRepo(REPO)).allowMergeCommit).toBe(true);
    host.setMergeSettings(REPO, { allowMergeCommit: false });
    try {
      expect((await gh.getRepo(REPO)).allowMergeCommit).toBe(false);
      const pr = await openPr("feat-no-merges", "c.txt");
      const refused = await gh.mergePullRequest(REPO, pr.number, { sha: pr.head.sha });
      expect(refused).toMatchObject({ merged: false });
      expect(refused.message).toContain("Merge commits are not allowed");
    } finally {
      host.setMergeSettings(REPO, { allowMergeCommit: true });
    }
  });

  it("a pull request whose commits reached main inside another one is marked merged, as GitHub does", async () => {
    const dep = await openPr("feat-dep", "dep.txt");
    // The dependent branch carries the dependency's commit, then its own.
    const dir = join(root, "wt-dependent");
    const git = new GitOps({ cwd: dir, identity });
    await git.clone(host.cloneUrl(REPO, token));
    await git.createBranch("feat-dependent", dep.head.sha);
    writeFileSync(join(dir, "own.txt"), "own\n");
    await git.commitAll("own change");
    const ownSha = await git.headSha();
    await git.push("feat-dependent");
    const dependent = await gh.createPullRequest(REPO, {
      title: "dependent",
      body: "",
      head: "feat-dependent",
      base: "main",
    });
    expect(dependent.head.sha).toBe(ownSha);
    await gh.mergePullRequest(REPO, dependent.number, { sha: ownSha });
    expect(await gh.getPullRequest(REPO, dep.number)).toMatchObject({
      merged: true,
      state: "closed",
    });
  });

  it("reads a ruleset's rules: approvals, code owners, required checks, up to date, linear history, signatures", async () => {
    host.setBranchRules(REPO, "main", [
      {
        type: "pull_request",
        parameters: { required_approving_review_count: 1, require_code_owner_review: true },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "ci/test" }],
        },
      },
      { type: "required_linear_history" },
      { type: "required_signatures" },
    ]);
    try {
      const rules = await gh.getBranchRules(REPO, "main");
      expect(rules).toMatchObject({
        requiredApprovals: 1,
        codeOwnerReview: true,
        upToDate: true,
        requiredChecks: ["ci/test"],
        allowedMethods: ["squash", "rebase"],
        blockers: ["signed commits"],
        unreadable: false,
      });
      // The fake host applies a ruleset to everyone, its owner included.
      const pr = await openPr("feat-ruled", "d.txt");
      const refused = await gh.mergePullRequest(REPO, pr.number, { sha: pr.head.sha });
      expect(refused.merged).toBe(false);
    } finally {
      host.setBranchRules(REPO, "main", []);
    }
    expect(await gh.getBranchRules(REPO, "main")).toMatchObject({
      requiredApprovals: 0,
      requiredChecks: [],
      allowedMethods: null,
      blockers: [],
    });
  });

  it("reads classic protection as an admin; an admin's merge goes around it on the host, which is why Forerunner reads it first", async () => {
    host.setBranchProtection(REPO, "main", {
      required_pull_request_reviews: { required_approving_review_count: 1 },
      required_status_checks: { strict: false, contexts: ["ci/build"] },
      enforce_admins: { enabled: false },
      restrictions: null,
    });
    try {
      expect(await gh.getBranchRules(REPO, "main")).toMatchObject({
        requiredApprovals: 1,
        requiredChecks: ["ci/build"],
        unreadable: false,
      });
      // GitHub lets an admin merge around classic protection without enforce_admins.
      const pr = await openPr("feat-protected", "e.txt");
      expect((await gh.mergePullRequest(REPO, pr.number, { sha: pr.head.sha })).merged).toBe(true);
    } finally {
      host.setBranchProtection(REPO, "main", null);
    }
  });

  it("a collaborator who cannot read the protection still sees the branch is protected and its required checks", async () => {
    host.addCollaborator("alice/app", "bob");
    host.setBranchProtection(REPO, "main", {
      required_pull_request_reviews: { required_approving_review_count: 2 },
      required_status_checks: { strict: true, contexts: ["ci/build"] },
      enforce_admins: { enabled: false },
    });
    try {
      // A fine-grained token that may write code and pull requests but not administer.
      const bobToken = host.createToken({
        owner: "bob",
        kind: "fine_grained",
        permissions: { metadata: "read", contents: "write", pull_requests: "write" },
        repos: ["alice/app"],
      }).token;
      const bob = new GitHubHost({ token: bobToken, baseUrl: host.baseUrl, clock });
      const rules = await bob.getBranchRules(REPO, "main");
      // Not an admin: GitHub applies the protection to this token, so it is not "unreadable".
      expect(rules).toMatchObject({ requiredChecks: ["ci/build"], unreadable: false });
      const pr = await openPr("feat-bob", "f.txt");
      const refused = await bob.mergePullRequest(REPO, pr.number, { sha: pr.head.sha });
      expect(refused.merged).toBe(false);
      expect(refused.message).toMatch(/approving review/);
    } finally {
      host.setBranchProtection(REPO, "main", null);
    }
  });
});

describe("what a task branch holds: holdsMergedWork and ownChangeId (ADR 0111)", {
  timeout: 60_000,
}, () => {
  let root: string;
  let bare: string;
  let seed: GitOps;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fr-own-change-"));
    bare = join(root, "r.git");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    seed = new GitOps({ cwd: join(root, "seed"), identity });
    await seed.clone(bare);
    writeFileSync(join(root, "seed", "README.md"), "# r\n\nline 2\nline 3\nline 4\n");
    await seed.commitAll("seed");
    await seed.push("main");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const worktree = async (name: string) => {
    const git = new GitOps({ cwd: join(root, name), identity });
    await git.clone(bare);
    return git;
  };
  const moveMain = async (file: string, content: string) => {
    await run(["git", "-C", join(root, "seed"), "pull", "-q", "origin", "main"]);
    writeFileSync(join(root, "seed", file), content);
    await seed.commitAll(`main: ${file}`);
    await seed.push("main");
  };

  it("a plain branch holds no merged work; its own change keeps its id when main is merged in, and changes with a pushed commit", async () => {
    const git = await worktree("plain");
    await git.createBranch("feat", "origin/main");
    writeFileSync(join(root, "plain", "feature.ts"), "export const f = 1;\n");
    await git.commitAll("feature");
    expect(await holdsMergedWork(git, "origin/main")).toBe(false);
    const reviewed = await ownChangeId(git, "origin/main");
    expect(reviewed).toMatch(/^[0-9a-f]{40}$/);
    // Main moves next to the change (README's line 2): merging it in keeps the own change.
    await moveMain("README.md", "# r\n\nline two\nline 3\nline 4\n");
    await git.fetch();
    expect((await git.mergeFrom("origin/main", "Merge main")).ok).toBe(true);
    expect(await holdsMergedWork(git, "origin/main")).toBe(true);
    expect(await ownChangeId(git, "origin/main")).toBe(reviewed);
    // A commit on top that changes anything is a different change.
    writeFileSync(join(root, "plain", "feature.ts"), "export const f = 2;\n");
    await git.commitAll("pushed after the review");
    expect(await ownChangeId(git, "origin/main")).not.toBe(reviewed);
  });

  it("a branch built on a dependency's branch is measured from the marker, also after main was merged in", async () => {
    const dep = await worktree("dep");
    await dep.createBranch("fr/dep", "origin/main");
    writeFileSync(join(root, "dep", "index.html"), "<h1>dep</h1>\n");
    await dep.commitAll("dependency");
    await dep.push("fr/dep");
    const git = await worktree("dependent");
    await git.fetch();
    await git.createBranch("fr/dependent", "origin/main");
    expect((await git.mergeFrom("origin/fr/dep", "Build on fr/dep")).ok).toBe(true);
    await git.setRef(DEPS_BASE_REF, await git.headSha());
    writeFileSync(join(root, "dependent", "check.sh"), "grep -q dep index.html\n");
    await git.commitAll("own check");
    expect(await holdsMergedWork(git, "origin/main")).toBe(true);
    const reviewed = await ownChangeId(git, "origin/main");
    const plain = new GitOps({ cwd: join(root, "dependent"), identity });
    expect(await plain.patchId(DEPS_BASE_REF)).toBe(reviewed);
    await moveMain("notes.md", "notes\n");
    await git.fetch();
    expect((await git.mergeFrom("origin/main", "Merge main")).ok).toBe(true);
    // From the marker alone the diff would now hold main's notes.md: measured from the merge
    // of the marker and main, the own change is the same.
    expect(await git.patchId(DEPS_BASE_REF)).not.toBe(reviewed);
    expect(await ownChangeId(git, "origin/main")).toBe(reviewed);
  });
});

describe("the in-memory host's merges (ADR 0111)", () => {
  it("records the method, refuses a merge commit where the repository allows none, and keeps the rules a test sets", async () => {
    const host = new MemoryGitHost("alice");
    const repo = { owner: "o", name: "r" };
    await host.createRepo({ ...repo, private: true });
    const pr = await host.createPullRequest(repo, {
      title: "t",
      body: "",
      head: "f",
      base: "main",
    });
    host.setAllowMergeCommit(repo, false);
    expect((await host.getRepo(repo)).allowMergeCommit).toBe(false);
    expect(await host.mergePullRequest(repo, pr.number, { sha: pr.head.sha })).toMatchObject({
      merged: false,
      message: "Merge commits are not allowed on this repository.",
    });
    host.setAllowMergeCommit(repo, true);
    const ok = await host.mergePullRequest(repo, pr.number, { sha: pr.head.sha });
    expect(ok).toMatchObject({ merged: true, sha: "merge-1" });
    expect(host.merges).toEqual([{ repo: "o/r", number: 1, method: "merge", sha: pr.head.sha }]);
    expect((await host.getPullRequest(repo, pr.number)).mergeCommitSha).toBe("merge-1");
    host.setBranchRules(repo, "main", { requiredApprovals: 1 });
    expect(await host.getBranchRules(repo, "main")).toMatchObject({
      requiredApprovals: 1,
      blockers: [],
    });
  });
});
