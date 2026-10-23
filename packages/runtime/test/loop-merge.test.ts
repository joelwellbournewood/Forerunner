import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost, GitOps, MemoryGitHost, PrTaskExecutor } from "@forerunner/capabilities";
import { appDirs, type Clock, join, run, SimulatedClock } from "@forerunner/platform";
import type { SessionRow } from "@forerunner/state";
import { FakeGitHost, FakeProvider, type ScriptedReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { composeRuntime } from "../src/daemon/compose.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
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
import { SECRET_NAMES } from "../src/setup/wizard.ts";
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
  /** True while the merge step sleeps on the clock (between two looks at the checks). */
  mergeSleeping: boolean;
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
  /** A commit status on a commit (the older status API external CIs report through). */
  status(
    sha: string,
    context: string,
    state: "pending" | "success" | "failure" | "error",
  ): Promise<void>;
}

async function mergeWorld(opts: {
  autonomy: 2 | 3;
  replies?: ScriptedReply[];
  /** Runs once the PR is open, before the review: the host's CI, a peer's push. */
  afterPr?: (m: MergeWorld, pr: OpenPr) => Promise<void>;
  /** The merge's checks wait (0: look once). */
  checksWaitMs?: number;
  checksPollMs?: number;
  /** The session's wall-clock cap. */
  wallClockMs?: number;
  riskTier?: number;
  /** Runs as the merge step asks the hooks (the kill switch pressed at that moment). */
  beforeMerge?: (m: MergeWorld) => Promise<void>;
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
  // The world's clock, with the merge step's sleeps visible to the test.
  const mergeClock: Clock = {
    now: () => w.clock.now(),
    nowIso: () => w.clock.nowIso(),
    setTimeout: (fn, ms) => w.clock.setTimeout(fn, ms),
    monotonic: () => w.clock.monotonic(),
    sleep: async (ms, signal) => {
      m.mergeSleeping = true;
      try {
        await w.clock.sleep(ms, signal);
      } finally {
        m.mergeSleeping = false;
      }
    },
  };
  const merge = new ReviewedPrMerge({
    store: w.store,
    clock: mergeClock,
    tokens: w.tokens,
    hooks: {
      beforeToolCall: async (ctx, tool, input) => {
        await opts.beforeMerge?.(m);
        return hooks.beforeToolCall(ctx, tool, input);
      },
      afterToolCall: (ctx, tool, input, result) => hooks.afterToolCall(ctx, tool, input, result),
    },
    host: github,
    worktreeRoot,
    token,
    identity,
    checksWaitMs: opts.checksWaitMs ?? 0,
    ...(opts.checksPollMs ? { checksPollMs: opts.checksPollMs } : {}),
  });
  const m: MergeWorld = {
    w,
    host,
    github,
    audit,
    approvals,
    mergeSleeping: false,
    run: async () => {
      const task = await w.addTask("Add feature", { risk_tier: opts.riskTier ?? 1 });
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
        ...(opts.wallClockMs ? { wallClockMs: opts.wallClockMs } : {}),
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
    status: async (sha, context, state) => {
      const res = await fetch(`${host.baseUrl}/repos/${FULL}/statuses/${sha}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ context, state }),
      });
      if (res.status !== 201) throw new Error(`status: ${res.status} ${await res.text()}`);
    },
  };
  return m;
}

const mergeRows = (audit: MemoryAudit) => audit.entries.filter((e) => e.tool === MERGE_PR_TOOL);

/**
 * Real time passes (git, the local HTTP host) until the merge sleeps on the simulated clock
 * between two looks at the checks, or `done` says the session ended.
 */
async function untilSleeping(m: MergeWorld, done: () => boolean): Promise<void> {
  for (let i = 0; i < 1500 && !done() && !m.mergeSleeping; i++)
    await new Promise((r) => setTimeout(r, 10));
}

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

  it("a failing commit status (the status API external CIs report through) is never merged: the human gets a request naming it", async () => {
    const m = await mergeWorld({
      autonomy: 3,
      afterPr: async (mw, pr) => {
        await mw.check(pr.headSha, "ci/lint", "completed", "success");
        await mw.status(pr.headSha, "ci/jenkins", "failure");
      },
    });
    const { taskId, result } = await m.run();
    expect((await m.pr()).merged).toBe(false);
    expect(result.merges[0]).toMatchObject({
      status: "checks_failed",
      failedChecks: ["ci/jenkins"],
    });
    expect((await requestsFor(m.w, taskId))[0]?.why).toContain("ci/jenkins");
  });

  it("a pending commit status is waited for like a running check, a green one merges", async () => {
    const pending = await mergeWorld({
      autonomy: 3,
      afterPr: (mw, pr) => mw.status(pr.headSha, "ci/jenkins", "pending"),
    });
    const left = await pending.run();
    expect((await pending.pr()).merged).toBe(false);
    expect(left.result.merges[0]).toMatchObject({
      status: "checks_pending",
      pendingChecks: ["ci/jenkins"],
    });
    const green = await mergeWorld({
      autonomy: 3,
      afterPr: (mw, pr) => mw.status(pr.headSha, "ci/jenkins", "success"),
    });
    const ok = await green.run();
    expect((await green.pr()).merged).toBe(true);
    expect(ok.result.merges[0]).toMatchObject({ status: "merged" });
  });

  it("no check on the head yet while the base branch reports CI is pending, never read as a repository without CI", async () => {
    const m = await mergeWorld({
      autonomy: 3,
      afterPr: async (mw) => {
        const base = (await mw.pr()).base.sha;
        await mw.check(base, "ci/test", "completed", "success");
      },
    });
    const { taskId, result } = await m.run();
    expect((await m.pr()).merged).toBe(false);
    expect(result.merges[0]).toMatchObject({ status: "checks_pending" });
    expect((await requestsFor(m.w, taskId)).length).toBe(1);
  });

  it("the checks wait ends with the session's wall-clock cap, not after the full wait", async () => {
    const m = await mergeWorld({
      autonomy: 3,
      checksWaitMs: 10 * 60_000,
      checksPollMs: 10_000,
      wallClockMs: 2 * 60_000,
      afterPr: (mw, pr) => mw.check(pr.headSha, "ci/test", "in_progress"),
    });
    const started = m.w.clock.now();
    let settled = false;
    const running = m.run().finally(() => {
      settled = true;
    });
    // Three simulated minutes: past the session's two, far short of the wait's ten.
    for (let elapsed = 0; elapsed < 3 * 60_000 && !settled; elapsed += 10_000) {
      await untilSleeping(m, () => settled);
      if (!settled) await m.w.clock.advance(10_000);
    }
    await untilSleeping(m, () => settled);
    expect(settled).toBe(true);
    const { result } = await running;
    expect(m.w.clock.now() - started).toBeLessThan(2 * 60_000);
    expect((await m.pr()).merged).toBe(false);
    expect(result.merges[0]).toMatchObject({ status: "checks_pending" });
  });

  it("the kill switch during the checks wait stops the session: no merge, no request, the session is killed", async () => {
    const m = await mergeWorld({
      autonomy: 3,
      checksWaitMs: 10 * 60_000,
      checksPollMs: 10_000,
      afterPr: (mw, pr) => mw.check(pr.headSha, "ci/test", "in_progress"),
    });
    let settled = false;
    const running = m.run().finally(() => {
      settled = true;
    });
    await untilSleeping(m, () => settled);
    expect(settled).toBe(false);
    await m.w.kill.stop("all", "kill switch");
    const { taskId, result } = await running;
    expect(result.status).toBe("killed");
    expect(result.merges).toEqual([]);
    expect(await requestsFor(m.w, taskId)).toEqual([]);
    expect((await m.pr()).merged).toBe(false);
    expect((await m.w.store.task.mustGet(taskId)).reason).not.toContain("left open");
  });

  it("the kill switch pressed as the merge step starts stops the session: the refusal is not taken for the level's, nothing is written on the task", async () => {
    const m = await mergeWorld({
      autonomy: 3,
      beforeMerge: async (mw) => {
        await mw.w.kill.stop("all", "kill switch");
      },
    });
    const { taskId, result } = await m.run();
    expect(result.status).toBe("killed");
    expect(result.merges).toEqual([]);
    expect((await m.pr()).merged).toBe(false);
    expect((await m.w.store.task.mustGet(taskId)).reason).not.toContain("left open");
  });

  it("a tier 3 task's accepting review goes to the human sign-off: no merge_pr call, the PR stays open", async () => {
    const m = await mergeWorld({ autonomy: 3, riskTier: 3 });
    const { taskId, result } = await m.run();
    expect(result.completed).toEqual([]);
    expect(result.needsHuman).toEqual([taskId]);
    expect(result.merges).toEqual([]);
    expect(mergeRows(m.audit)).toEqual([]);
    expect(await m.pr()).toMatchObject({ merged: false, state: "open" });
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

  it("a commit status in error refuses the merge; a base with CI and a head with none is pending", async () => {
    const clock = new SimulatedClock("2026-10-23T09:00:00Z");
    const { host, pr } = await memoryPr();
    host.setCommitStatuses(PR_REPO, pr.head.sha, [
      { id: 1, context: "deploy/preview", state: "error", targetUrl: null },
    ]);
    const tool = mergePrTool({ host, clock, checksWaitMs: 0 });
    const red = await tool.execute({ pr_url: pr.htmlUrl, head_sha: pr.head.sha }, ctx());
    expect(red.artifacts).toMatchObject({
      status: "checks_failed",
      failedChecks: ["deploy/preview"],
    });
    host.setCommitStatuses(PR_REPO, pr.head.sha, []);
    host.setCheckRuns(PR_REPO, pr.base.sha, [
      { id: 2, name: "ci", status: "completed", conclusion: "success", detailsUrl: null },
    ]);
    const unseen = await tool.execute({ pr_url: pr.htmlUrl, head_sha: pr.head.sha }, ctx());
    expect(unseen.artifacts).toMatchObject({ status: "checks_pending" });
    expect((await host.getPullRequest(PR_REPO, pr.number)).merged).toBe(false);
    // A host without CI on either side merges (nothing reported is no CI).
    host.setCheckRuns(PR_REPO, pr.base.sha, []);
    const none = await tool.execute({ pr_url: pr.htmlUrl, head_sha: pr.head.sha }, ctx());
    expect(none.artifacts).toMatchObject({ status: "merged" });
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

  it("after the rebase push a host that still shows the old head is waited for, not taken for a moved head", {
    timeout: 60_000,
  }, async () => {
    const clock = new SimulatedClock("2026-10-23T09:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "fr-merge-stale-"));
    roots.push(root);
    const bare = join(root, "r.git");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    await seed.clone(bare);
    writeFileSync(join(root, "seed", "README.md"), "# r\n");
    await seed.commitAll("seed");
    await seed.push("main");
    const wt = join(root, "wt");
    const git = new GitOps({ cwd: wt, identity });
    await git.clone(bare);
    await git.createBranch("feat", "origin/main");
    writeFileSync(join(wt, "feature.ts"), "export const f = 1;\n");
    await git.commitAll("feature");
    await git.push("feat");
    const reviewed = await git.headSha();
    writeFileSync(join(root, "seed", "notes.md"), "notes\n");
    await seed.commitAll("main moved");
    await seed.push("main");
    // A host whose PR head is the branch in the bare repo, except that the first look after
    // the rebase push still shows the reviewed head (GitHub's lag after a push).
    const branchSha = async () =>
      (await run(["git", "--git-dir", bare, "rev-parse", "refs/heads/feat"])).stdout.trim();
    let staleOnce = true;
    let merged: string | null = null;
    const host = {
      async getPullRequest() {
        let sha = await branchSha();
        if (sha !== reviewed && staleOnce) {
          staleOnce = false;
          sha = reviewed;
        }
        return {
          number: 1,
          title: "t",
          body: "",
          state: merged ? "closed" : "open",
          merged: merged !== null,
          mergeable: true,
          head: { ref: "feat", sha },
          base: { ref: "main", sha: "" },
          htmlUrl: "https://git.example/o/r/pull/1",
          draft: false,
        };
      },
      async listCheckRuns() {
        return [];
      },
      async listCommitStatuses() {
        return [];
      },
      async mergePullRequest(_repo: unknown, _n: number, opts: { sha?: string } = {}) {
        merged = opts.sha ?? null;
        return { merged: true, sha: "merge-1", message: "merged" };
      },
    } as unknown as MemoryGitHost;
    const tool = mergePrTool({ host, clock, identity, checksWaitMs: 60_000, checksPollMs: 10_000 });
    const pending = tool.execute(
      { pr_url: "https://git.example/o/r/pull/1", head_sha: reviewed, worktree: wt },
      ctx(),
    );
    // Let the rebase and push run, then move the clock past one poll.
    for (let i = 0; i < 200 && staleOnce; i++) await new Promise((r) => setTimeout(r, 20));
    await clock.advance(10_000);
    const res = await pending;
    expect(res.artifacts).toMatchObject({ status: "merged", rebased: true });
    expect(merged).toBe(await branchSha());
    expect(merged).not.toBe(reviewed);
  });
});

describe("the daemon's merge step (spec J.9)", { timeout: 120_000 }, () => {
  /**
   * `composeRuntime` on the fake git host (its API base in the config, as for a GitHub
   * Enterprise install), a task whose worktree holds the reviewed commit of an open PR, and the
   * merge called on a token issued from the daemon's own session grant (`rt.sessionGrant`):
   * what a session of the daemon would hold, tools and domains included.
   */
  async function daemonMerge(autonomy: 2 | 3) {
    const clock = new SimulatedClock("2026-10-23T09:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-merge-daemon-"));
    roots.push(home);
    const host = await FakeGitHost.start({ rootDir: join(home, "host"), clock });
    hosts.push(host);
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    await host.createRepo({
      owner: "alice",
      name: "app",
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# app\n" },
    });
    const ghToken = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    const github = new GitHubHost({ token: ghToken, baseUrl: host.baseUrl, clock });
    const env = { FORERUNNER_HOME: home };
    const dirs = appDirs({ env });
    // The token by reference in the vault, as `fr setup` stores it: the daemon builds its own
    // GitHub adapter on the configured API base and pushes the rebase with it.
    const vault = new MemoryVault();
    await vault.set(SECRET_NAMES.github, ghToken);
    const rt = await composeRuntime({
      env,
      dirs,
      config: {
        version: 1,
        profile: "default",
        timezone: "UTC",
        githubApiBase: host.baseUrl,
        anthropicApiBase: "http://an.test",
        repos: [],
        credentials: { github: false, anthropic: false, anthropicSubscription: false },
        stateUrl: "sqlite::memory:",
      },
      clock,
      stateUrl: "sqlite::memory:",
      vault,
      provider: new FakeProvider({ replies: [], clock, latency: "none" }),
      registryDir: join(process.cwd(), "evals", "registry"),
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
    });
    const project = await rt.store.project.insert({
      name: "App",
      goal: "Ship the app",
      repos: [FULL],
      stage: "build",
      status: "active",
      budget_usd_micro: 10_000_000,
      autonomy_level: autonomy,
      summary_cache: {},
      data_assets: [],
      settings: { members: [rt.agent.id] },
      small_project_mode: false,
      active: true,
    });
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Add feature",
      outcome: "feature exists",
      acceptance_criteria: ["works"],
      risk_tier: 1,
      status: "done",
      priority: 1,
      depends_on: [],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "critic accepted",
      author_agent: rt.agent.id,
    });
    // The task worktree the PR executor would have left: the reviewed commit is its HEAD.
    const wt = join(dirs.worktrees, task.id);
    const git = new GitOps({ cwd: wt, identity, auth: { token: ghToken } });
    await git.clone(host.cloneUrl(FULL));
    await git.createBranch("fr/feature", "origin/main");
    writeFileSync(join(wt, "feature.ts"), "export const f = 1;\n");
    await git.commitAll("feature");
    await git.push("fr/feature");
    const pr = await github.createPullRequest(REPO, {
      title: "Add feature",
      body: "",
      head: "fr/feature",
      base: "main",
    });
    await rt.store.task.patch(task.id, { pr_url: pr.htmlUrl });
    const grant = await rt.sessionGrant(project.id);
    const token = rt.tokens.issue({
      runId: "run-session",
      sessionId: "s-merge",
      agentId: rt.agent.id,
      ownerHumanId: rt.human.id,
      projectId: project.id,
      allowedTools: grant.allowedTools,
      allowedPaths: grant.allowedPaths,
      allowedDomains: grant.allowedDomains,
      grantedSecrets: grant.grantedSecrets,
      budgetUsdMicro: 1_000_000,
      depth: 0,
      maxDepth: 2,
      autonomy,
      planApproved: false,
      expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
    });
    try {
      const outcome = await rt.merge.mergeReviewed({
        task: await rt.store.task.mustGet(task.id),
        session: { id: "s-merge" } as SessionRow,
        token,
        budget: new SessionBudget({
          sessionId: "s-merge",
          budgetUsdMicro: 1_000_000,
          stepCap: 10,
          deadlineMs: clock.now() + 3_600_000,
          reserveShare: 0.1,
        }),
        signal: new AbortController().signal,
        agentId: rt.agent.id,
      });
      const rows = (await rt.store.auditLog.list({ sessionId: "s-merge" })).filter(
        (r) => r.tool === MERGE_PR_TOOL,
      );
      return {
        outcome,
        rows,
        grant,
        pr: await github.getPullRequest(REPO, pr.number),
        task: await rt.store.task.mustGet(task.id),
      };
    } finally {
      await rt.close();
    }
  }

  it("level 3 on the daemon's session grant and hooks: the PR is merged on the host, an allowed audit_log row", async () => {
    const d = await daemonMerge(3);
    expect(d.grant.allowedTools).toContain(MERGE_PR_TOOL);
    expect(d.outcome).toMatchObject({ status: "merged" });
    expect(d.pr).toMatchObject({ merged: true, state: "closed" });
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]?.allowed).toBe(true);
    expect(d.task.reason).toContain("merged");
  });

  it("level 2 on the daemon's session grant and hooks: the refusal is an autonomy_insufficient audit_log row and the PR stays open", async () => {
    const d = await daemonMerge(2);
    expect(d.outcome).toMatchObject({ status: "not_allowed" });
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]?.allowed).toBe(false);
    expect(d.rows[0]?.denied_reason).toMatch(/^autonomy_insufficient: /);
    expect(d.pr).toMatchObject({ merged: false, state: "open" });
  });
});
