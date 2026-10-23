import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost, MemoryGitHost, PrTaskExecutor } from "@forerunner/capabilities";
import { join, SimulatedClock } from "@forerunner/platform";
import { FakeGitHost, type ScriptedReply } from "@forerunner/testenv";
import { afterEach, describe, expect, it } from "vitest";
import { EnforcementHooks } from "../src/enforcement/hooks.ts";
import {
  AllowAllCaps,
  AutoApprove,
  MemoryAudit,
  MemoryLedger,
  NoSecrets,
} from "../src/enforcement/ports.ts";
import {
  MERGE_PR_TOOL,
  type MergePrArtifacts,
  mergePrTool,
  ReviewedPrMerge,
} from "../src/loop/merge.ts";
import type { SessionResult, TaskExecutor } from "../src/session/runner.ts";
import {
  closingReply,
  doneExecutor,
  grant,
  type LoopWorld,
  loopWorld,
  submitReply,
} from "./loop-helpers.ts";

/**
 * Level 3 Trusted merges reviewed PRs (spec J.9, ADR 0062). After an accepting review the
 * session merges the task's pull request through the `merge_pr` tool behind the hooks: at
 * level 2 the hooks refuse it (autonomy_insufficient, audit row, the PR stays open for the
 * human); at level 3 the merge waits for the host's checks and is pinned to the reviewed
 * commit; a red check, a conflict or a head pushed after the review goes to the human as a
 * request and is never merged. A base that moved is rebased onto first. Everything runs on
 * the fake git host over its REST API and git smart HTTP.
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

interface OpenPr {
  number: number;
  headSha: string;
  branch: string;
}

interface MergeWorld {
  w: LoopWorld;
  host: FakeGitHost;
  github: GitHubHost;
  audit: MemoryAudit;
  approvals: AutoApprove;
  /** One task through a session: executor (branch, PR), critic, merge step. */
  run(): Promise<{ taskId: string; result: SessionResult }>;
  /** The session's single pull request, as the host has it now. */
  pr(): ReturnType<GitHubHost["getPullRequest"]>;
  /** A check run on a commit, as the host's CI reports it. */
  check(
    sha: string,
    name: string,
    status: "in_progress" | "completed",
    conclusion?: string,
  ): Promise<void>;
}

async function mergeWorld(opts: {
  autonomy: 2 | 3;
  replies?: ScriptedReply[];
  /** Runs once the PR is open, before the review: the host's CI, a peer's push. */
  afterPr?: (m: MergeWorld, pr: OpenPr) => Promise<void>;
}): Promise<MergeWorld> {
  const w = await loopWorld({
    replies: opts.replies ?? [submitReply({ grade: 91 }), closingReply()],
  });
  worlds.push(w);
  const root = mkdtempSync(join(tmpdir(), "fr-loop-merge-"));
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
  await w.store.project.patch(w.project, { repos: [FULL], autonomy_level: opts.autonomy });
  const worktreeRoot = join(root, "worktrees");
  await mkdir(worktreeRoot, { recursive: true });
  const audit = new MemoryAudit();
  // A port that would approve anything: a refusal below is the hooks' own, never an answer.
  const approvals = new AutoApprove("approved");
  const hooks = new EnforcementHooks({
    tokens: w.tokens,
    caps: new AllowAllCaps(),
    secrets: new NoSecrets(),
    kill: w.kill,
    clock: w.clock,
    ledger: new MemoryLedger(),
    audit,
    approvals,
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
          writeFileSync(join(dir, "src", "feature.ts"), "export const feature = 1;\n");
          return done.execute(ctx);
        },
      }),
    },
    repoFor: async () => ({
      clone: host.gitHttpAvailable ? host.cloneUrl(FULL) : repo.dir,
      repo: REPO,
      base: "main",
    }),
    worktreeRoot,
    token,
    identity,
  });
  const merge = new ReviewedPrMerge({
    store: w.store,
    clock: w.clock,
    tokens: w.tokens,
    hooks,
    host: github,
    worktreeRoot,
    token,
    identity,
    checksWaitMs: 0,
  });
  const m: MergeWorld = {
    w,
    host,
    github,
    audit,
    approvals,
    run: async () => {
      const task = await w.addTask("Add feature", { risk_tier: 1 });
      const executor: TaskExecutor = {
        async execute(ctx) {
          const result = await prExecutor.execute(ctx);
          if (result.prUrl && result.branch && opts.afterPr) {
            const pr = await m.pr();
            await opts.afterPr(m, {
              number: pr.number,
              headSha: pr.head.sha,
              branch: result.branch,
            });
          }
          return result;
        },
      };
      const result = await w.start(w.runner(executor, { merge }), {
        grant: {
          allowedTools: [...grant.allowedTools, MERGE_PR_TOOL],
          allowedPaths: [worktreeRoot],
          allowedDomains: ["127.0.0.1"],
          grantedSecrets: [],
        },
      });
      return { taskId: task.id, result };
    },
    pr: async () => {
      const [only] = await github.listPullRequests(REPO, { state: "all" });
      if (!only) throw new Error("no pull request");
      return github.getPullRequest(REPO, only.number);
    },
    check: async (sha, name, status, conclusion) => {
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
  };
  return m;
}

const mergeRows = (audit: MemoryAudit) => audit.entries.filter((e) => e.tool === MERGE_PR_TOOL);

async function requestsFor(w: LoopWorld, taskId: string) {
  return w.store.humanRequest.list({ task_id: taskId } as never, { limit: 50 });
}

// Git subprocesses and a local HTTP host per test: give Windows runners room.
describe("merge of a reviewed PR after an accepting review (spec J.9)", {
  timeout: 120_000,
}, () => {
  it("level 3: the PR is merged on the host at the reviewed head, the audit row allows merge_pr, the task row and the summary record it", async () => {
    const m = await mergeWorld({
      autonomy: 3,
      afterPr: (mw, pr) => mw.check(pr.headSha, "ci/test", "completed", "success"),
    });
    const { taskId, result } = await m.run();
    expect(result.completed).toEqual([taskId]);
    const pr = await m.pr();
    expect(pr).toMatchObject({ merged: true, state: "closed" });
    expect(await m.github.getFile(REPO, "src/feature.ts", "main")).not.toBeNull();
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0]).toMatchObject({ taskId, status: "merged", rebased: false });
    expect(result.merges[0]?.mergeSha).toBeTruthy();
    // One allowed merge_pr row, on a token of its own (derived from the session's).
    const rows = mergeRows(m.audit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ allowed: true, sessionId: result.sessionId });
    expect(rows[0]?.inputSummary).toContain("/pull/");
    expect(m.approvals.requests).toEqual([]);
    const task = await m.w.store.task.mustGet(taskId);
    expect(task.status).toBe("done");
    expect(task.reason).toContain("merged");
    expect(task.reason).toContain(pr.htmlUrl);
    expect(result.summary).toContain("Merged 1 reviewed pull request");
    expect(result.handoff.merges).toEqual([
      expect.objectContaining({ task_id: taskId, status: "merged" }),
    ]);
    expect(m.w.events.some((e) => e.type === "pr.merged" && e.payload.taskId === taskId)).toBe(
      true,
    );
    expect(await requestsFor(m.w, taskId)).toEqual([]);
  });

  it("level 2: the hooks refuse merge_pr as autonomy_insufficient with the audit row, no approval is asked, the PR stays open", async () => {
    const m = await mergeWorld({ autonomy: 2 });
    const { taskId, result } = await m.run();
    expect(result.completed).toEqual([taskId]);
    const pr = await m.pr();
    expect(pr).toMatchObject({ merged: false, state: "open" });
    const rows = mergeRows(m.audit);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.allowed).toBe(false);
    expect(rows[0]?.deniedReason).toMatch(/^autonomy_insufficient: autonomy level 2/);
    expect(m.approvals.requests).toEqual([]);
    expect(result.merges[0]).toMatchObject({ taskId, status: "not_allowed" });
    expect(result.summary).toContain("left open for you: 1");
    expect((await m.w.store.task.mustGet(taskId)).reason).toContain("left open");
    expect(await requestsFor(m.w, taskId)).toEqual([]);
  });

  it("a red check is never merged: the human gets a request naming the check, the PR stays open", async () => {
    const m = await mergeWorld({
      autonomy: 3,
      afterPr: async (mw, pr) => {
        await mw.check(pr.headSha, "ci/lint", "completed", "success");
        await mw.check(pr.headSha, "ci/test", "completed", "failure");
      },
    });
    const { taskId, result } = await m.run();
    expect((await m.pr()).merged).toBe(false);
    expect(result.merges[0]).toMatchObject({
      status: "checks_failed",
      failedChecks: ["ci/test"],
    });
    const [request] = await requestsFor(m.w, taskId);
    expect(request).toMatchObject({ kind: "decision", status: "open", blocking: false });
    expect(request?.why).toContain("ci/test");
    expect(request?.id).toBe(result.merges[0]?.humanRequestId);
    // The hooks admitted the call; the tool refused the merge (the checks rule is code).
    expect(mergeRows(m.audit).map((r) => r.allowed)).toEqual([true]);
  });

  it("a check still running when the wait ends is never merged: the human is asked, the PR stays open", async () => {
    const m = await mergeWorld({
      autonomy: 3,
      afterPr: (mw, pr) => mw.check(pr.headSha, "ci/test", "in_progress"),
    });
    const { taskId, result } = await m.run();
    expect((await m.pr()).merged).toBe(false);
    expect(result.merges[0]).toMatchObject({
      status: "checks_pending",
      pendingChecks: ["ci/test"],
    });
    expect((await requestsFor(m.w, taskId))[0]?.why).toContain("ci/test");
  });

  it("a base that moved in the same file conflicts on the rebase: the human gets a request naming the file, the PR stays open", async () => {
    const m = await mergeWorld({
      autonomy: 3,
      afterPr: async (mw) => {
        await mw.host.seedCommit(
          FULL,
          { "src/feature.ts": "export const feature = 2;\n" },
          "main side",
          "main",
        );
      },
    });
    const { taskId, result } = await m.run();
    expect((await m.pr()).merged).toBe(false);
    expect(result.merges[0]).toMatchObject({ status: "conflict", conflicts: ["src/feature.ts"] });
    const [request] = await requestsFor(m.w, taskId);
    expect(request?.why).toContain("src/feature.ts");
  });

  it("a base that moved elsewhere is rebased onto first: the rebased head is pushed and merged", async () => {
    let reviewedHead = "";
    const m = await mergeWorld({
      autonomy: 3,
      afterPr: async (mw, pr) => {
        reviewedHead = pr.headSha;
        await mw.host.seedCommit(FULL, { "docs/notes.md": "notes\n" }, "main moved", "main");
      },
    });
    const { result } = await m.run();
    const pr = await m.pr();
    expect(pr.merged).toBe(true);
    expect(result.merges[0]).toMatchObject({ status: "merged", rebased: true });
    expect(result.merges[0]?.headSha).not.toBe(reviewedHead);
    expect(await m.github.getFile(REPO, "src/feature.ts", "main")).not.toBeNull();
    expect(await m.github.getFile(REPO, "docs/notes.md", "main")).not.toBeNull();
  });

  it("a head pushed after the review is not the reviewed commit: never merged, the human is asked", async () => {
    const m = await mergeWorld({
      autonomy: 3,
      afterPr: async (mw, pr) => {
        await mw.host.seedCommit(
          FULL,
          { "src/extra.ts": "export const extra = 1;\n" },
          "peer push",
          pr.branch,
        );
      },
    });
    const { taskId, result } = await m.run();
    expect((await m.pr()).merged).toBe(false);
    expect(result.merges[0]).toMatchObject({ status: "head_moved" });
    expect((await requestsFor(m.w, taskId)).length).toBe(1);
  });

  it("a rejecting review never merges: no merge_pr call is made and the PR stays open", async () => {
    const m = await mergeWorld({
      autonomy: 3,
      replies: [
        submitReply({
          grade: 40,
          verdict: "revise",
          summary: "The feature has no test.",
          findings: [
            { severity: "major", what: "No test covers feature", required_action: "Add a test" },
          ],
        }),
        closingReply(),
      ],
    });
    const { taskId, result } = await m.run();
    expect(result.retried).toEqual([taskId]);
    expect(result.merges).toEqual([]);
    expect(mergeRows(m.audit)).toEqual([]);
    expect(await m.pr()).toMatchObject({ merged: false, state: "open" });
  });
});

describe("the merge_pr tool's checks rule (ADR 0062)", () => {
  const PR_REPO = { owner: "o", name: "r" };

  async function memoryPr() {
    const host = new MemoryGitHost("alice");
    await host.createRepo({ ...PR_REPO, private: true });
    const pr = await host.createPullRequest(PR_REPO, {
      title: "t",
      body: "",
      head: "feat",
      base: "main",
    });
    return { host, pr };
  }

  const ctx = (signal = new AbortController().signal) => ({
    runId: "run-1",
    sessionId: "s-1",
    agentId: "a-1",
    humanId: "h-1",
    allowedPaths: [],
    signal,
  });

  it("waits for a running check and merges once it is green", async () => {
    const clock = new SimulatedClock("2026-10-23T09:00:00Z");
    const { host, pr } = await memoryPr();
    const running = {
      id: 1,
      name: "ci",
      status: "in_progress" as const,
      conclusion: null,
      detailsUrl: null,
    };
    host.setCheckRuns(PR_REPO, pr.head.sha, [running]);
    const tool = mergePrTool({ host, clock, checksWaitMs: 60_000, checksPollMs: 10_000 });
    const pending = tool.execute({ pr_url: pr.htmlUrl, head_sha: pr.head.sha }, ctx());
    await clock.advance(10_000);
    expect((await host.getPullRequest(PR_REPO, pr.number)).merged).toBe(false);
    host.setCheckRuns(PR_REPO, pr.head.sha, [
      { ...running, status: "completed", conclusion: "success" },
    ]);
    await clock.advance(10_000);
    const res = await pending;
    expect((res.artifacts as unknown as MergePrArtifacts).status).toBe("merged");
    expect(res.isError).toBeFalsy();
    expect((await host.getPullRequest(PR_REPO, pr.number)).merged).toBe(true);
  });

  it("a check still running at the end of the wait leaves the PR open", async () => {
    const clock = new SimulatedClock("2026-10-23T09:00:00Z");
    const { host, pr } = await memoryPr();
    host.setCheckRuns(PR_REPO, pr.head.sha, [
      { id: 1, name: "ci", status: "queued", conclusion: null, detailsUrl: null },
    ]);
    const tool = mergePrTool({ host, clock, checksWaitMs: 20_000, checksPollMs: 10_000 });
    const pending = tool.execute({ pr_url: pr.htmlUrl, head_sha: pr.head.sha }, ctx());
    for (let i = 0; i < 3; i++) await clock.advance(10_000);
    const res = await pending;
    expect(res.isError).toBe(true);
    expect(res.artifacts).toMatchObject({ status: "checks_pending", pendingChecks: ["ci"] });
    expect((await host.getPullRequest(PR_REPO, pr.number)).merged).toBe(false);
  });

  it("a conflicting PR on a host without a worktree is refused before the merge call", async () => {
    const clock = new SimulatedClock("2026-10-23T09:00:00Z");
    const host = new MemoryGitHost("alice");
    host.mergeableByDefault = false;
    await host.createRepo({ ...PR_REPO, private: true });
    const pr = await host.createPullRequest(PR_REPO, {
      title: "t",
      body: "",
      head: "f",
      base: "main",
    });
    const res = await mergePrTool({ host, clock }).execute(
      { pr_url: pr.htmlUrl, head_sha: pr.head.sha },
      ctx(),
    );
    expect(res.artifacts).toMatchObject({ status: "conflict" });
    expect((await host.getPullRequest(PR_REPO, pr.number)).merged).toBe(false);
  });
});
