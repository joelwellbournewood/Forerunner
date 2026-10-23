import { existsSync } from "node:fs";
import {
  type CheckRunInfo,
  type GitHost,
  type GitIdentity,
  GitOps,
  type RepoRef,
} from "@forerunner/capabilities";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  join,
  log,
  newId,
  safeSegment,
} from "@forerunner/platform";
import type { StateStore, TaskRow } from "@forerunner/state";
import { z } from "zod";
import type { ToolExecutionContext, ToolResult, ToolSpec } from "../agent/tools.ts";
import type { EnforcementHooks, RunContext } from "../enforcement/hooks.ts";
import type { TokenIssuer } from "../enforcement/token.ts";
import type { MergeOutcome, MergePort, MergeRequest, MergeStatus } from "./ports.ts";

/**
 * Level 3 Trusted merges reviewed PRs (spec J.9, ADR 0062). After an accepting review the
 * session runner hands the task to `ReviewedPrMerge`, which makes one `merge_pr` tool call
 * through the enforcement hooks on a token derived from the session's (that tool only, the
 * task worktree only). The hooks decide by the autonomy table: `merge_pr` is free at level 3;
 * below it the unattended call is refused as `autonomy_insufficient` with its audit row and
 * the PR stays open for the human. The tool itself carries the checks rule, so it holds for
 * every caller:
 *
 *   - the PR head must be the reviewed commit (the task worktree's HEAD): a head pushed after
 *     the review is never merged;
 *   - a base that moved is rebased onto in the worktree (as the executor does before the PR)
 *     and the branch pushed with a lease; a conflict is never merged;
 *   - the host's check runs on the head decide: any failed one refuses, a running one is
 *     waited for (bounded), none reported means the host has no CI and the merge goes on;
 *     after a rebase every check the reviewed head had must pass again on the new head;
 *   - the merge is pinned to the head that was checked (`sha`), so a push in between fails it.
 *
 * Every refusal other than the hooks' files one request for the human; the outcome is written
 * on the task row (`reason`) and reaches the session summary and handoff.
 */
export const MERGE_PR_TOOL = "merge_pr";
/** How long the merge waits for running checks before it leaves the PR to the human. */
export const DEFAULT_CHECKS_WAIT_MS = 10 * 60_000;
export const DEFAULT_CHECKS_POLL_MS = 30_000;

/** Conclusions that refuse a merge; success, neutral and skipped pass. */
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
]);

/** A pull request's repository and number from its web URL (`.../owner/name/pull/7`). */
export function parsePullUrl(url: string): { repo: RepoRef; number: number } | null {
  const m = /\/([\w.-]+)\/([\w.-]+)\/pulls?\/(\d+)\/?(?:[?#].*)?$/.exec(url.trim());
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { repo: { owner: m[1], name: m[2].replace(/\.git$/, "") }, number: Number(m[3]) };
}

export interface ChecksVerdict {
  state: "green" | "pending" | "failed" | "none";
  failed: string[];
  pending: string[];
}

/**
 * The host's check runs on one commit, the latest run per name. `required` are names that
 * must be present and pass (the checks the reviewed head had, after a rebase); a missing one
 * is pending, since the host may not have started it yet.
 */
export function judgeChecks(
  runs: readonly CheckRunInfo[],
  required: readonly string[] = [],
): ChecksVerdict {
  const latest = new Map<string, CheckRunInfo>();
  for (const r of runs) {
    const seen = latest.get(r.name);
    if (!seen || r.id > seen.id) latest.set(r.name, r);
  }
  const failed: string[] = [];
  const pending: string[] = [];
  for (const r of latest.values()) {
    if (r.status !== "completed") pending.push(r.name);
    else if (r.conclusion === null || FAILED_CONCLUSIONS.has(r.conclusion)) failed.push(r.name);
  }
  for (const name of required) if (!latest.has(name)) pending.push(name);
  failed.sort();
  pending.sort();
  const state = failed.length
    ? "failed"
    : pending.length
      ? "pending"
      : latest.size
        ? "green"
        : "none";
  return { state, failed, pending };
}

const MergePrInput = z.object({
  /** The pull request's web URL (its host must be in the run's domain allowlist). */
  pr_url: z.string().min(1).max(2000),
  /** The reviewed commit; the PR head must be this one. */
  head_sha: z.string().min(1).max(200),
  /** The task worktree on the PR branch, for the rebase when the base moved. */
  worktree: z.string().min(1).optional(),
  method: z.enum(["merge", "squash", "rebase"]).optional(),
});
export type MergePrInput = z.infer<typeof MergePrInput>;

/** What the tool reports in its result's artifacts. */
export interface MergePrArtifacts {
  status: Exclude<MergeStatus, "not_allowed" | "unverified">;
  message: string;
  headSha?: string;
  mergeSha?: string;
  rebased: boolean;
  failedChecks?: string[];
  pendingChecks?: string[];
  conflicts?: string[];
}

export interface MergePrToolDeps {
  host: GitHost;
  clock: Clock;
  /** Git over HTTPS for the rebase push (the PR executor's token). */
  token?: string;
  identity?: GitIdentity;
  checksWaitMs?: number;
  checksPollMs?: number;
}

/** The `merge_pr` tool: class `merge_pr` (free at autonomy 3), the checks rule in code. */
export function mergePrTool(deps: MergePrToolDeps): ToolSpec<MergePrInput> {
  return {
    name: MERGE_PR_TOOL,
    description:
      "Merge a reviewed pull request: only at the reviewed head, after a rebase when the base moved, never with a failed or running check or a conflict.",
    schema: MergePrInput,
    actionClass: "merge_pr",
    risk: "medium",
    pathFields: ["worktree"],
    domainFields: ["pr_url"],
    timeoutMs: (deps.checksWaitMs ?? DEFAULT_CHECKS_WAIT_MS) + 5 * 60_000,
    async execute(input, ctx): Promise<ToolResult> {
      const a = await mergeChecked(deps, input, ctx);
      return {
        content:
          a.status === "merged" ? `merged at ${a.mergeSha ?? "?"}` : `not merged: ${a.message}`,
        isError: a.status !== "merged",
        artifacts: { ...a },
      };
    },
  };
}

async function mergeChecked(
  deps: MergePrToolDeps,
  input: MergePrInput,
  ctx: ToolExecutionContext,
): Promise<MergePrArtifacts> {
  const { host, clock } = deps;
  const ref = parsePullUrl(input.pr_url);
  if (!ref)
    return { status: "failed", message: `not a pull request URL: ${input.pr_url}`, rebased: false };
  let pr = await host.getPullRequest(ref.repo, ref.number);
  if (pr.merged || pr.state !== "open")
    return {
      status: "closed",
      message: pr.merged ? "already merged" : "the pull request is closed",
      rebased: false,
    };
  if (pr.head.sha !== input.head_sha)
    return {
      status: "head_moved",
      message: `the PR head ${short(pr.head.sha)} is not the reviewed commit ${short(input.head_sha)}`,
      headSha: pr.head.sha,
      rebased: false,
    };
  let head = pr.head.sha;
  let rebased = false;
  let required: string[] = [];
  if (input.worktree) {
    const git = new GitOps({
      cwd: input.worktree,
      ...(deps.token ? { auth: { token: deps.token } } : {}),
      ...(deps.identity ? { identity: deps.identity } : {}),
    });
    const local = await git.headSha();
    if (local !== head)
      return {
        status: "head_moved",
        message: `the worktree is at ${short(local)}, the PR head at ${short(head)}`,
        headSha: head,
        rebased: false,
      };
    await git.fetch();
    const base = `origin/${pr.base.ref}`;
    if (!(await git.isAncestor(base, "HEAD"))) {
      // The base moved since the PR: rebase first (spec F, as the executor does before the
      // PR). The checks of the reviewed head must then pass again on the rebased one.
      const beforeRuns = await host.listCheckRuns(ref.repo, head);
      const before = judgeChecks(beforeRuns);
      if (before.state === "failed") return checksFailed(before, head, false);
      const rb = await git.rebaseOnto(base);
      if (!rb.ok)
        return {
          status: "conflict",
          message: `rebasing ${pr.head.ref} onto ${pr.base.ref} conflicts in ${rb.conflicts.join(", ") || "the tree"}`,
          conflicts: rb.conflicts,
          headSha: head,
          rebased: false,
        };
      await git.push(pr.head.ref, { force: true, defaultBranch: pr.base.ref });
      head = await git.headSha();
      rebased = true;
      required = [...new Set(beforeRuns.map((r) => r.name))];
    }
  }
  const waitMs = deps.checksWaitMs ?? DEFAULT_CHECKS_WAIT_MS;
  const pollMs = Math.max(1, deps.checksPollMs ?? DEFAULT_CHECKS_POLL_MS);
  const deadline = clock.now() + waitMs;
  for (;;) {
    pr = await host.getPullRequest(ref.repo, ref.number);
    if (pr.merged || pr.state !== "open")
      return { status: "closed", message: "the pull request was closed meanwhile", rebased };
    if (pr.head.sha !== head)
      return {
        status: "head_moved",
        message: `the PR head moved to ${short(pr.head.sha)} while the merge waited`,
        headSha: pr.head.sha,
        rebased,
      };
    if (pr.mergeable === false)
      return {
        status: "conflict",
        message: `the host reports ${pr.head.ref} conflicts with ${pr.base.ref}`,
        headSha: head,
        rebased,
      };
    const verdict = judgeChecks(await host.listCheckRuns(ref.repo, head), required);
    if (verdict.state === "failed") return checksFailed(verdict, head, rebased);
    if (verdict.state !== "pending") break;
    if (clock.now() + pollMs > deadline)
      return {
        status: "checks_pending",
        message: `check(s) still running after ${Math.round(waitMs / 1000)} s: ${verdict.pending.join(", ")}`,
        pendingChecks: verdict.pending,
        headSha: head,
        rebased,
      };
    await clock.sleep(pollMs, ctx.signal);
  }
  const merged = await host.mergePullRequest(ref.repo, ref.number, {
    sha: head,
    ...(input.method ? { method: input.method } : {}),
  });
  if (merged.merged)
    return {
      status: "merged",
      message: merged.message || "merged",
      headSha: head,
      ...(merged.sha ? { mergeSha: merged.sha } : {}),
      rebased,
    };
  const status: MergePrArtifacts["status"] = /not mergeable/i.test(merged.message)
    ? "conflict"
    : /modified|head/i.test(merged.message)
      ? "head_moved"
      : "failed";
  return {
    status,
    message: `the host refused the merge: ${merged.message}`,
    headSha: head,
    rebased,
  };
}

function checksFailed(v: ChecksVerdict, head: string, rebased: boolean): MergePrArtifacts {
  return {
    status: "checks_failed",
    message: `check(s) failed on ${short(head)}: ${v.failed.join(", ")}`,
    failedChecks: v.failed,
    headSha: head,
    rebased,
  };
}

function short(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

export interface ReviewedPrMergeDeps extends MergePrToolDeps {
  store: StateStore;
  tokens: TokenIssuer;
  hooks: Pick<EnforcementHooks, "beforeToolCall" | "afterToolCall">;
  /** Where `PrTaskExecutor` keeps worktrees (`<worktreeRoot>/<task id>`): the reviewed commit. */
  worktreeRoot?: string;
}

export class ReviewedPrMerge implements MergePort {
  private readonly logger = log("merge");
  readonly tool: ToolSpec<MergePrInput>;

  constructor(private readonly deps: ReviewedPrMergeDeps) {
    this.tool = mergePrTool(deps);
  }

  async mergeReviewed(req: MergeRequest): Promise<MergeOutcome | null> {
    const { task } = req;
    if (!task.pr_url) return null;
    const prUrl = task.pr_url;
    const base = { taskId: task.id, prUrl };
    const worktree = this.worktreeOf(task);
    let reviewed: string | null = null;
    if (worktree) {
      try {
        reviewed = await new GitOps({ cwd: worktree }).headSha();
      } catch (e) {
        this.logger.warn("worktree head unreadable", { taskId: task.id, error: errorMessage(e) });
      }
    }
    if (!worktree || !reviewed) {
      return this.record(req, {
        ...base,
        status: "unverified",
        reason: `PR left open for you: the reviewed commit is not known (no task worktree), so ${prUrl} is not merged automatically`,
      });
    }

    const { clock, tokens, hooks } = this.deps;
    const claims = tokens.verify(req.token, clock.now());
    const runId = newId(clock.now());
    const token = tokens.derive(req.token, {
      runId,
      taskId: task.id,
      allowedTools: [MERGE_PR_TOOL],
      allowedPaths: [worktree],
      grantedSecrets: [],
      budgetUsdMicro: 0,
    });
    const ctx: RunContext = {
      token,
      budget: req.budget,
      signal: req.signal,
      runDeadlineMs: clock.now() + (this.tool.timeoutMs ?? DEFAULT_CHECKS_WAIT_MS),
      phase: "work",
      model: "none",
      provider: "none",
      billingSourceId: "",
      cwd: worktree,
      unattended: true,
    };
    const input: MergePrInput = { pr_url: prUrl, head_sha: reviewed, worktree };
    let admitted: Awaited<ReturnType<EnforcementHooks["beforeToolCall"]>>;
    try {
      admitted = await hooks.beforeToolCall(ctx, this.tool as ToolSpec, input);
    } catch (e) {
      if (!(e instanceof ForerunnerError)) throw e;
      return this.record(req, {
        ...base,
        status: "not_allowed",
        reason:
          e.code === "autonomy_insufficient"
            ? `PR left open for you: autonomy level ${claims.autonomy} does not merge (level 3 Trusted does)`
            : `PR left open for you: the merge was refused (${e.code}: ${e.message})`,
      });
    }
    if (!admitted.allowed) {
      return this.record(req, {
        ...base,
        status: "not_allowed",
        reason: `PR left open for you: ${admitted.reason}`,
      });
    }
    let result: ToolResult;
    try {
      result = await this.tool.execute(admitted.input as MergePrInput, {
        runId,
        sessionId: claims.sessionId,
        agentId: claims.agentId,
        humanId: claims.ownerHumanId,
        ...(claims.projectId ? { projectId: claims.projectId } : {}),
        taskId: task.id,
        allowedPaths: admitted.claims.allowedPaths,
        signal: req.signal,
        cwd: worktree,
      });
    } catch (e) {
      if (e instanceof ForerunnerError && e.code === "killed") throw e;
      result = {
        content: `not merged: ${errorMessage(e)}`,
        isError: true,
        artifacts: { status: "failed", message: errorMessage(e), rebased: false },
      };
    }
    await hooks.afterToolCall(ctx, this.tool as ToolSpec, admitted.input, {
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
    });
    const a = result.artifacts as unknown as MergePrArtifacts;
    const detail = {
      ...(a.headSha ? { headSha: a.headSha } : {}),
      rebased: a.rebased,
      ...(a.failedChecks ? { failedChecks: a.failedChecks } : {}),
      ...(a.pendingChecks ? { pendingChecks: a.pendingChecks } : {}),
      ...(a.conflicts ? { conflicts: a.conflicts } : {}),
    };
    if (a.status === "merged") {
      return this.record(req, {
        ...base,
        status: "merged",
        ...(a.mergeSha ? { mergeSha: a.mergeSha } : {}),
        ...detail,
        reason: `merged ${prUrl}${a.mergeSha ? ` as ${short(a.mergeSha)}` : ""} after an accepting review (autonomy ${claims.autonomy})${a.rebased ? ", rebased onto the moved base first" : ""}`,
      });
    }
    return this.record(req, {
      ...base,
      status: a.status,
      ...detail,
      reason: `PR left open for you: ${a.message}`,
    });
  }

  private worktreeOf(task: TaskRow): string | null {
    if (!this.deps.worktreeRoot) return null;
    const dir = join(this.deps.worktreeRoot, safeSegment(task.id));
    return existsSync(join(dir, ".git")) ? dir : null;
  }

  /** The outcome on the task row, and a request for the human where the merge was refused. */
  private async record(req: MergeRequest, outcome: MergeOutcome): Promise<MergeOutcome> {
    const { store } = this.deps;
    const { task, session } = req;
    let out = outcome;
    if (ASKS_HUMAN.has(outcome.status)) {
      const request = await store.humanRequest.insert({
        human_id: req.token.claims.ownerHumanId,
        project_id: task.project_id,
        task_id: task.id,
        session_id: session.id,
        kind: "decision",
        why: `The critic accepted "${task.title}", but its pull request ${outcome.prUrl} was not merged: ${outcome.reason.replace(/^PR left open for you: /, "")}.`.slice(
          0,
          4000,
        ),
        steps: STEPS[outcome.status] ?? [],
        options: ["I merged it", "Leave it open"],
        blocking: false,
        risk: "medium",
        author_agent: req.agentId,
      });
      out = { ...outcome, humanRequestId: request.id };
    }
    try {
      await store.task.patch(task.id, {
        reason: outcome.reason.slice(0, 1000),
        author_agent: req.agentId,
      });
    } catch (e) {
      this.logger.warn("merge outcome not written on the task", {
        taskId: task.id,
        error: errorMessage(e),
      });
    }
    this.logger.info("reviewed PR", {
      taskId: task.id,
      prUrl: outcome.prUrl,
      status: outcome.status,
    });
    return out;
  }
}

/** Refusals the human hears about as a request; the hooks' refusal is the level's normal course. */
const ASKS_HUMAN: ReadonlySet<MergeStatus> = new Set<MergeStatus>([
  "checks_failed",
  "checks_pending",
  "conflict",
  "head_moved",
  "failed",
]);

const STEPS: Partial<Record<MergeStatus, string[]>> = {
  checks_failed: ["Open the failed check on the pull request", "Fix it or merge it yourself"],
  checks_pending: ["Wait for the checks to finish", "Merge the pull request once they pass"],
  conflict: ["Resolve the conflict on the PR branch", "Merge the pull request"],
  head_moved: [
    "Look at the commits pushed after the review",
    "Merge it yourself or ask for a new review",
  ],
  failed: ["Open the pull request", "Merge it yourself or leave it open"],
};
