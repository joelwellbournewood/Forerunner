import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost, GitOps, PrTaskExecutor } from "@forerunner/capabilities";
import { type Clock, join, run } from "@forerunner/platform";
import type { MergeRecordRow, TaskRow } from "@forerunner/state";
import { FakeGitHost } from "@forerunner/testenv";
import { afterEach, describe, expect, it } from "vitest";
import { EnforcementHooks } from "../src/enforcement/hooks.ts";
import {
  AllowAllCaps,
  AutoApprove,
  MemoryAudit,
  MemoryLedger,
  NoSecrets,
} from "../src/enforcement/ports.ts";
import type { CapabilityClaims } from "../src/enforcement/token.ts";
import { MERGE_PR_TOOL, ReviewedPrMerge } from "../src/loop/merge.ts";
import type { TaskExecutor } from "../src/session/runner.ts";
import {
  closingReply,
  doneExecutor,
  grant,
  type LoopWorld,
  loopWorld,
  submitReply,
} from "./loop-helpers.ts";

/**
 * ADR 0111: the merge record, the one gated entry, merge commits only, the branch's rules, and
 * a merge step that never replays merged-in work. Real git against the fake git host (its REST
 * API and git smart HTTP), the session runner and the enforcement hooks.
 *
 * Before: the merge step rebased a moved base and force-pushed (a dependent branch's
 * dependency commits were copied: the dependency's PR never merged), merged with a squash,
 * read the reviewed commit from the worktree whenever it ran, kept nothing when the checks
 * outlasted the wait, never read allow_merge_commit or the branch's rules (an admin token
 * merged around classic protection), and left not_allowed and unverified without a word.
 */
const identity = { name: "Alice (Forerunner)", email: "alice@example.test" };
const REPO = { owner: "alice", name: "app" };
const FULL = "alice/app";
const roots: string[] = [];
const hosts: FakeGitHost[] = [];
const worlds: LoopWorld[] = [];

afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  for (const h of hosts.splice(0)) await h.stop();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

interface RecordWorld {
  w: LoopWorld;
  host: FakeGitHost;
  github: GitHubHost;
  audit: MemoryAudit;
  merge: ReviewedPrMerge;
  token: string;
  worktreeRoot: string;
  /** The claims of every token the merge step asked the hooks with, in order. */
  calls: CapabilityClaims[];
  /** One task through one session: the executor (branch, PR), the critic, the merge step. */
  runTask(
    title: string,
    opts?: {
      dependsOn?: string[];
      afterPr?: (pr: { number: number; headSha: string; branch: string }) => Promise<void>;
    },
  ): Promise<TaskRow>;
  pr(taskId: string): ReturnType<GitHubHost["getPullRequest"]>;
  record(taskId: string): Promise<MergeRecordRow>;
  check(
    sha: string,
    name: string,
    status: "in_progress" | "completed",
    conclusion?: string,
  ): Promise<void>;
  /** `git --git-dir <bare>` on the host's repository. */
  hostGit(...args: string[]): Promise<string>;
  setLevel(level: 2 | 3): Promise<void>;
}

async function recordWorld(opts: { level: 2 | 3; checksWaitMs?: number }): Promise<RecordWorld> {
  const w = await loopWorld({
    replies: [submitReply({ grade: 91 }, { times: Number.POSITIVE_INFINITY }), closingReply()],
  });
  worlds.push(w);
  const root = mkdtempSync(join(tmpdir(), "fr-merge-record-"));
  roots.push(root);
  const host = await FakeGitHost.start({ rootDir: join(root, "host"), clock: w.clock });
  hosts.push(host);
  host.createUser({ login: "alice", name: "Alice", email: identity.email });
  const repo = await host.createRepo({
    owner: "alice",
    name: "app",
    private: true,
    defaultBranch: "main",
    initialFiles: { "README.md": "# app\n", "src/index.ts": "export const app = 1;\n" },
  });
  const token = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
  const github = new GitHubHost({ token, baseUrl: host.baseUrl, clock: w.clock });
  await w.store.project.patch(w.project, { repos: [FULL], autonomy_level: opts.level });
  const worktreeRoot = join(root, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });
  const audit = new MemoryAudit();
  const hooks = new EnforcementHooks({
    tokens: w.tokens,
    caps: new AllowAllCaps(),
    secrets: new NoSecrets(),
    kill: w.kill,
    clock: w.clock,
    ledger: new MemoryLedger(),
    audit,
    approvals: new AutoApprove("approved"),
  });
  const done = doneExecutor(w);
  const prExecutor = new PrTaskExecutor({
    store: w.store,
    clock: w.clock,
    host: github,
    inner: {
      execute: (ctx) => done.execute(ctx),
      withWorktree: (dir) => ({
        async execute(ctx) {
          await mkdir(join(dir, "src"), { recursive: true });
          const name = ctx.task.title.toLowerCase().replace(/[^a-z]+/g, "-");
          writeFileSync(join(dir, "src", `${name}.ts`), `export const v = "${name}";\n`);
          return done.execute(ctx);
        },
      }),
    },
    repoFor: async () => ({ clone: host.cloneUrl(FULL), repo: REPO, base: "main" }),
    worktreeRoot,
    token,
    identity,
  });
  const calls: CapabilityClaims[] = [];
  const clock: Clock = w.clock;
  const merge = new ReviewedPrMerge({
    store: w.store,
    clock,
    tokens: w.tokens,
    hooks: {
      beforeToolCall: (ctx, tool, input) => {
        calls.push(ctx.token.claims);
        return hooks.beforeToolCall(ctx, tool, input);
      },
      afterToolCall: (ctx, tool, input, result) => hooks.afterToolCall(ctx, tool, input, result),
    },
    audit,
    host: github,
    worktreeRoot,
    token,
    identity,
    agentIds: [w.alice],
    allowedDomains: ["127.0.0.1"],
    checksWaitMs: opts.checksWaitMs ?? 0,
  });
  const m: RecordWorld = {
    w,
    host,
    github,
    audit,
    merge,
    token,
    worktreeRoot,
    calls,
    async runTask(title, o = {}) {
      const task = await w.addTask(title, { depends_on: o.dependsOn ?? [] });
      const executor: TaskExecutor = {
        async execute(ctx) {
          const result = await prExecutor.execute(ctx);
          if (result.prUrl && result.branch && o.afterPr) {
            const n = Number(/\/pull\/(\d+)/.exec(result.prUrl)?.[1]);
            const pr = await github.getPullRequest(REPO, n);
            await o.afterPr({ number: pr.number, headSha: pr.head.sha, branch: result.branch });
          }
          return result;
        },
      };
      await w.start(w.runner(executor, { merge }), {
        grant: {
          allowedTools: [...grant.allowedTools, MERGE_PR_TOOL],
          allowedPaths: [worktreeRoot],
          allowedDomains: ["127.0.0.1"],
          grantedSecrets: [],
        },
      });
      return w.store.task.mustGet(task.id);
    },
    async pr(taskId) {
      const t = await w.store.task.mustGet(taskId);
      const n = Number(/\/pull\/(\d+)/.exec(t.pr_url ?? "")?.[1]);
      if (!n) throw new Error(`no pull request for ${t.title}`);
      return github.getPullRequest(REPO, n);
    },
    async record(taskId) {
      const r = await w.store.mergeRecord.forTask(taskId);
      if (!r) throw new Error("no merge record");
      return r;
    },
    async check(sha, name, status, conclusion) {
      const res = await fetch(`${host.baseUrl}/repos/${FULL}/check-runs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          head_sha: sha,
          status,
          ...(conclusion ? { conclusion } : {}),
        }),
      });
      if (res.status !== 201) throw new Error(`check run: ${res.status} ${await res.text()}`);
    },
    async hostGit(...args) {
      return (await run(["git", "--git-dir", repo.dir, ...args])).stdout.trim();
    },
    async setLevel(level) {
      await w.store.project.patch(w.project, { autonomy_level: level });
    },
  };
  return m;
}

const forcedPushes = (host: FakeGitHost, branch: string) =>
  host
    .events()
    .filter(
      (e) =>
        e.event === "push" && e.payload.ref === `refs/heads/${branch}` && e.payload.forced === true,
    );

const mergeRows = (audit: MemoryAudit) => audit.entries.filter((e) => e.tool === MERGE_PR_TOOL);

describe("the merge record and the merge step (ADR 0111)", { timeout: 180_000 }, () => {
  it("(a) a dependent branch whose base moved is merged as it is, with a merge commit: nothing replayed or forced, the dependency's commit reaches main once and both PRs are merged", async () => {
    const m = await recordWorld({ level: 2 });
    // The first task's PR waits for the person (level 2): the second builds on it.
    const a = await m.runTask("Add page");
    const prA = await m.pr(a.id);
    expect(prA.merged).toBe(false);
    await m.setLevel(3);
    const b = await m.runTask("Add footer", {
      dependsOn: [a.id],
      afterPr: async () => {
        // Main moves between the accept and the merge.
        await m.host.seedCommit(FULL, { "docs/notes.md": "notes\n" }, "main moved", "main");
      },
    });
    const prB = await m.pr(b.id);
    expect(prB).toMatchObject({ merged: true, state: "closed" });
    // GitHub marks the dependency merged: its commit reached main as it is.
    expect(await m.pr(a.id)).toMatchObject({ merged: true });
    expect(
      await m.hostGit("merge-base", "--is-ancestor", prA.head.sha, "main").then(() => "yes"),
    ).toBe("yes");
    // One commit adds the dependency's file on main: nothing was copied.
    expect(
      (await m.hostGit("log", "--format=%H", "main", "--", "src/add-page.ts")).split("\n"),
    ).toHaveLength(1);
    // A merge commit with two parents, the second the reviewed head; no force-push anywhere.
    const record = await m.record(b.id);
    expect(record).toMatchObject({ state: "merged", method: "merge", approval: "mode" });
    const parents = (await m.hostGit("rev-list", "--parents", "-n", "1", record.merge_sha ?? ""))
      .split(" ")
      .slice(1);
    expect(parents).toHaveLength(2);
    expect(parents[1]).toBe(record.reviewed_head_sha);
    expect(forcedPushes(m.host, prB.head.ref)).toEqual([]);
    expect(forcedPushes(m.host, prA.head.ref)).toEqual([]);
  });

  it("(a) a rule that the branch be up to date brings main in by merging (a normal push), the record moves to the new head, and the retry merges it once its checks pass", async () => {
    const m = await recordWorld({ level: 3 });
    m.host.setBranchRules(FULL, "main", [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "ci/test" }],
        },
      },
    ]);
    let reviewed = "";
    const t = await m.runTask("Add feature", {
      afterPr: async (pr) => {
        reviewed = pr.headSha;
        await m.check(pr.headSha, "ci/test", "completed", "success");
        await m.host.seedCommit(FULL, { "docs/notes.md": "notes\n" }, "main moved", "main");
      },
    });
    const pr = await m.pr(t.id);
    // Brought up to date by a merge commit of main, pushed without force; its checks now run.
    expect(pr.merged).toBe(false);
    expect(pr.head.sha).not.toBe(reviewed);
    const head = (await m.hostGit("rev-list", "--parents", "-n", "1", pr.head.sha)).split(" ");
    expect(head.slice(1)).toEqual([reviewed, await m.hostGit("rev-parse", "main")]);
    expect(forcedPushes(m.host, pr.head.ref)).toEqual([]);
    const waiting = await m.record(t.id);
    expect(waiting).toMatchObject({ state: "waiting_checks", reviewed_head_sha: pr.head.sha });
    expect(waiting.sentence).toMatch(/checks pass/);
    await m.check(pr.head.sha, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    expect(await m.pr(t.id)).toMatchObject({ merged: true });
    expect(await m.record(t.id)).toMatchObject({ state: "merged", method: "merge" });
  });

  it("(c) a merge whose checks still run is kept, no card is filed, and the retry merges it with no session on its own narrow token, one audit row each; another agent's record is not touched", async () => {
    const m = await recordWorld({ level: 3 });
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const pr = await m.pr(t.id);
    expect(pr.merged).toBe(false);
    const waiting = await m.record(t.id);
    expect(waiting).toMatchObject({
      state: "waiting_checks",
      agent_id: m.w.alice,
      reviewed_head_sha: pr.head.sha,
      last_outcome: "checks_pending",
    });
    expect(waiting.own_change_id).toMatch(/^[0-9a-f]{40}$/);
    expect(await m.w.store.humanRequest.list({ task_id: t.id } as never)).toEqual([]);
    // Another install's agent's record on the same store waits too: only its own daemon retries it.
    const other = await m.w.addTask("Other install's task", { status: "done" });
    const theirs = await m.w.store.mergeRecord.insert({
      task_id: other.id,
      project_id: m.w.project,
      agent_id: m.w.bob,
      pr_number: 99,
      pr_url: `${m.host.baseUrl}/${FULL}/pull/99`,
      reviewed_head_sha: "f".repeat(40),
      state: "waiting_checks",
    });
    // Still running: one look, no wait, no merge.
    await m.merge.retryWaiting();
    expect((await m.pr(t.id)).merged).toBe(false);
    await m.check(pr.head.sha, "ci/test", "completed", "success");
    const sessionCalls = m.calls.length;
    await m.merge.retryWaiting();
    expect(await m.pr(t.id)).toMatchObject({ merged: true });
    expect(await m.record(t.id)).toMatchObject({ state: "merged", method: "merge" });
    // The retries' tokens are their own: merge_pr only, no budget, not the session's.
    const retry = m.calls.slice(sessionCalls);
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({
      allowedTools: [MERGE_PR_TOOL],
      budgetUsdMicro: 0,
      grantedSecrets: [],
      agentId: m.w.alice,
      taskId: t.id,
    });
    expect(retry[0]?.sessionId).not.toBe(m.calls[0]?.sessionId);
    const rows = mergeRows(m.audit);
    expect(rows.map((r) => r.allowed)).toEqual([true, true, true]);
    expect(rows.at(-1)?.tokenId).toBe(retry[0]?.id);
    expect(await m.w.store.mergeRecord.mustGet(theirs.id)).toMatchObject({
      state: "waiting_checks",
      attempts: 0,
    });
  });

  it("(d) the gate reads the level at every call: a record made at level 3, the level then lowered to 2, is not merged by the retry", async () => {
    const m = await recordWorld({ level: 3 });
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const pr = await m.pr(t.id);
    await m.setLevel(2);
    await m.check(pr.head.sha, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    expect((await m.pr(t.id)).merged).toBe(false);
    const record = await m.record(t.id);
    expect(record.state).toBe("left_to_you");
    expect(record.sentence).toMatch(/Trusted/);
    expect(mergeRows(m.audit).at(-1)).toMatchObject({ allowed: false });
    expect(mergeRows(m.audit).at(-1)?.deniedReason).toMatch(
      /^autonomy_insufficient: autonomy level 2/,
    );
  });

  it("(b) the reviewed version holds: a commit pushed after the accept is never merged by the retry", async () => {
    const m = await recordWorld({ level: 3 });
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const pr = await m.pr(t.id);
    const reviewed = (await m.record(t.id)).reviewed_head_sha;
    const pushed = await m.host.seedCommit(
      FULL,
      { "src/add-feature.ts": "export const v = 2;\n" },
      "pushed after the review",
      pr.head.ref,
    );
    await m.check(pushed.sha, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    expect((await m.pr(t.id)).merged).toBe(false);
    const record = await m.record(t.id);
    expect(record).toMatchObject({
      state: "left_to_you",
      reviewed_head_sha: reviewed,
      last_outcome: "head_moved",
    });
    expect(record.sentence).toMatch(/changed after the review/);
    expect((await m.w.store.humanRequest.list({ task_id: t.id } as never)).length).toBe(1);
  });

  it("(b) a crash after main was merged in: the head keeps the task's own change, so the record moves to it and the retry merges it", async () => {
    const m = await recordWorld({ level: 3 });
    const t = await m.runTask("Add feature", {
      afterPr: (pr) => m.check(pr.headSha, "ci/test", "in_progress"),
    });
    const pr = await m.pr(t.id);
    const before = await m.record(t.id);
    // Main moved; the merge step brought it in and pushed, then the daemon died before the
    // record moved.
    await m.host.seedCommit(FULL, { "docs/notes.md": "notes\n" }, "main moved", "main");
    const git = new GitOps({
      cwd: join(m.worktreeRoot, t.id),
      identity,
      auth: { token: m.token },
    });
    await git.fetch();
    expect((await git.mergeFrom("origin/main", "Merge main into the branch")).ok).toBe(true);
    await git.push(pr.head.ref);
    const merged = await git.headSha();
    await m.check(merged, "ci/test", "completed", "success");
    await m.merge.retryWaiting();
    expect(await m.pr(t.id)).toMatchObject({ merged: true });
    const record = await m.record(t.id);
    expect(record).toMatchObject({ state: "merged", reviewed_head_sha: merged });
    expect(record.own_change_id).toBe(before.own_change_id);
  });

  it("(e) a rule that needs an approving review: nothing merges, even on an admin token that GitHub would let around classic protection; one sentence and one card", async () => {
    const m = await recordWorld({ level: 3 });
    m.host.setBranchProtection(FULL, "main", {
      required_pull_request_reviews: { required_approving_review_count: 1 },
      enforce_admins: { enabled: false },
    });
    const t = await m.runTask("Add feature");
    expect((await m.pr(t.id)).merged).toBe(false);
    const record = await m.record(t.id);
    expect(record.state).toBe("left_to_you");
    expect(record.sentence).toBe(
      "This repository needs an approving review before merging, and GitHub does not let you approve your own pull request: merge it on GitHub once someone else approved it.",
    );
    expect((await m.w.store.humanRequest.list({ task_id: t.id } as never)).length).toBe(1);
    // A ruleset says the same.
    m.host.setBranchProtection(FULL, "main", null);
    m.host.setBranchRules(FULL, "main", [
      { type: "pull_request", parameters: { required_approving_review_count: 2 } },
    ]);
    const u = await m.runTask("Add footer");
    expect((await m.pr(u.id)).merged).toBe(false);
    expect((await m.record(u.id)).sentence).toMatch(/approving review/);
  });

  it("(f) a repository that does not allow merge commits is never merged by Forerunner: one sentence", async () => {
    const m = await recordWorld({ level: 3 });
    m.host.setMergeSettings(FULL, { allowMergeCommit: false });
    const t = await m.runTask("Add feature");
    expect((await m.pr(t.id)).merged).toBe(false);
    const record = await m.record(t.id);
    expect(record).toMatchObject({ state: "left_to_you", last_outcome: "merge_commits_off" });
    expect(record.sentence).toMatch(/does not allow merge commits/);
  });

  it("(h) a merge left to the person always says why: the level's refusal and an unknown reviewed version", async () => {
    const m = await recordWorld({ level: 2 });
    const t = await m.runTask("Add feature");
    const record = await m.record(t.id);
    expect(record).toMatchObject({ state: "left_to_you", last_outcome: "not_allowed" });
    expect(record.sentence).toMatch(/^#\d+ waits for you to merge it/);
    // No worktree: the reviewed version is unknown, nothing is merged, and the record says so.
    await m.setLevel(3);
    await rm(join(m.worktreeRoot, t.id), { recursive: true, force: true });
    const outcome = await m.merge.mergeReviewed({
      task: await m.w.store.task.mustGet(t.id),
      session: { id: "s-x" } as never,
      token: m.w.tokens.issue({
        runId: "r",
        sessionId: "s-x",
        agentId: m.w.alice,
        ownerHumanId: m.w.human,
        projectId: m.w.project,
        allowedTools: [MERGE_PR_TOOL],
        allowedPaths: [m.worktreeRoot],
        allowedDomains: ["127.0.0.1"],
        grantedSecrets: [],
        budgetUsdMicro: 0,
        depth: 0,
        maxDepth: 2,
        autonomy: 3,
        planApproved: false,
        expiresAt: new Date(m.w.clock.now() + 3_600_000).toISOString(),
      }),
      budget: undefined as never,
      signal: new AbortController().signal,
      agentId: m.w.alice,
    });
    expect(outcome?.status).toBe("unverified");
    const unknown = await m.record(t.id);
    expect(unknown.state).toBe("left_to_you");
    expect(unknown.sentence).toMatch(/does not know which version/);
    expect((await m.pr(t.id)).merged).toBe(false);
  });
});
