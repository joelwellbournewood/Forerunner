import { existsSync } from "node:fs";
import {
  type BranchRules,
  type CheckRunInfo,
  type CommitStatusInfo,
  type GitHost,
  type GitIdentity,
  GitOps,
  type GitTokenSource,
  gitAuthFor,
  inWorktree,
  type MergeMethod,
  NEVER_PUSHED,
  ownChangeId,
  type RepoRef,
  resolveGitToken,
  tryWorktree,
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
import type {
  HumanRequestRow,
  JsonObject,
  MergeRecordRow,
  MergeRecordState,
  ProjectRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import { z } from "zod";
import type { ToolExecutionContext, ToolResult, ToolSpec } from "../agent/tools.ts";
import { SessionBudget } from "../enforcement/budget.ts";
import { approvalKeyFor, type EnforcementHooks, type RunContext } from "../enforcement/hooks.ts";
import type { AuditPort } from "../enforcement/ports.ts";
import type { SignedToken, TokenIssuer } from "../enforcement/token.ts";
import {
  MERGE_MODE_WORDS,
  mergeModeOf,
  OWED_FOLDER_CHANGES,
  owedFolderSentence,
} from "./merge-mode.ts";
import type { MergeOutcome, MergePort, MergeRequest, MergeStatus } from "./ports.ts";

/**
 * The merge of a reviewed pull request (spec J.9; ADR 0062, amended by ADR 0111). After an
 * accepting review the session runner hands the task to `ReviewedPrMerge.mergeReviewed`, which
 * first pins the reviewed commit in the task's merge record (`merge_record`: the task worktree's
 * HEAD at the accept, the patch id of the task's own change), then goes through
 * `mergeRecorded`, the one way anything merges a task's pull request: the session's accept, the
 * git host watcher's retry (`retryWaiting`), the daemon's start (`resumeAtStart`), and the
 * person's Merge in the app. `mergeRecorded` asks one gate first (`mayMerge`: unattended only in
 * the project's mode "Merge automatically after review", the mode read again at every call;
 * otherwise the person's Merge; merge-in-app), then makes one `merge_pr` tool call through the
 * enforcement hooks, with the gate's approval for exactly that call, and its audit row: on a token derived from the session's in a session, on its own narrow token
 * (`merge_pr` only, that worktree, budget 0, a short expiry) outside one. The tool carries the
 * rules that hold for every caller:
 *
 *   - the PR head must be the record's reviewed commit: a head pushed after the review is never
 *     merged (the record moves to a head only when the task's own change on it is unchanged);
 *   - merge commits only (`merge_method: "merge"`, pinned to the head that was checked): a
 *     repository or a branch rule that allows none is never merged by Forerunner;
 *   - the branch's rules are read first and never gone around: an approving review, a code
 *     owner's review or anything else Forerunner cannot give leaves the PR to the person with
 *     one sentence; required checks are waited for as checks;
 *   - the merge step never rebases and never force-pushes: a base that moved is merged as it
 *     is (GitHub combines the two), unless an update is needed (a rule that the branch be up to
 *     date, or the caller's mode); then the base is merged into the branch (a merge commit, a
 *     normal push) when that merges cleanly, and every check the reviewed head had must pass
 *     again on the new head;
 *   - the host's check runs and commit statuses on the head decide: a failed one refuses, a
 *     running one is waited for (bounded in a session, one look in a retry); none on the head
 *     while the base reports some is pending.
 *
 * A merge that waits keeps its record, so a sleep, a crash or the app closing loses nothing;
 * a merge left to the person always carries one sentence on the record.
 */
export const MERGE_PR_TOOL = "merge_pr";
/** How long the merge in a session waits for running checks; the retry finishes it later. */
export const DEFAULT_CHECKS_WAIT_MS = 10 * 60_000;
export const DEFAULT_CHECKS_POLL_MS = 30_000;
/** A retry's own token lives this long (one look at the PR, the merge, the audit row). */
const RETRY_TOKEN_MS = 10 * 60_000;
/** Retries of one record before its checks count as stuck (about a day at a minute's poll). */
export const MAX_MERGE_ATTEMPTS = 1440;

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
 * The host's check runs on one commit (the latest run per name) and its commit statuses (the
 * latest per context: `failure` and `error` refuse, `pending` waits). `required` are names
 * that must be present and pass (the branch rule's checks, and those the reviewed head had
 * when the base was merged in since); a missing one is pending, since the host may not have
 * started it yet.
 */
export function judgeChecks(
  runs: readonly CheckRunInfo[],
  required: readonly string[] = [],
  statuses: readonly CommitStatusInfo[] = [],
): ChecksVerdict {
  const latest = new Map<string, CheckRunInfo>();
  for (const r of runs) {
    const seen = latest.get(r.name);
    if (!seen || r.id > seen.id) latest.set(r.name, r);
  }
  const latestStatus = new Map<string, CommitStatusInfo>();
  for (const st of statuses) {
    const seen = latestStatus.get(st.context);
    if (!seen || st.id > seen.id) latestStatus.set(st.context, st);
  }
  const failed = new Set<string>();
  const pending = new Set<string>();
  for (const r of latest.values()) {
    if (r.status !== "completed") pending.add(r.name);
    else if (r.conclusion === null || FAILED_CONCLUSIONS.has(r.conclusion)) failed.add(r.name);
  }
  for (const st of latestStatus.values()) {
    if (st.state === "failure" || st.state === "error") failed.add(st.context);
    else if (st.state === "pending") pending.add(st.context);
  }
  for (const name of required) if (!latest.has(name) && !latestStatus.has(name)) pending.add(name);
  for (const name of failed) pending.delete(name);
  const state = failed.size
    ? "failed"
    : pending.size
      ? "pending"
      : latest.size || latestStatus.size
        ? "green"
        : "none";
  return { state, failed: [...failed].sort(), pending: [...pending].sort() };
}

/** What the host reports on one commit: its check runs and its commit statuses. */
async function ciOf(
  host: GitHost,
  repo: RepoRef,
  sha: string,
): Promise<{ runs: CheckRunInfo[]; statuses: CommitStatusInfo[] }> {
  const [runs, statuses] = await Promise.all([
    host.listCheckRuns(repo, sha),
    host.listCommitStatuses(repo, sha),
  ]);
  return { runs, statuses };
}

const MergePrInput = z.object({
  /**
   * What approved this merge (merge-in-app): the project's merge mode, or the person who pressed
   * Merge. The tool does not read it; it is in the call so the audit row says where the
   * approval came from (first, so the row's cut summary keeps it).
   */
  approved_by: z.string().min(1).max(300).optional(),
  /** The pull request's web URL (its host must be in the run's domain allowlist). */
  pr_url: z.string().min(1).max(2000),
  /** The reviewed commit (the merge record's); the PR head must be this one. */
  head_sha: z.string().min(1).max(200),
  /** The task worktree on the PR branch, for bringing the base in when that is needed. */
  worktree: z.string().min(1).optional(),
  /** Bring a base that moved into the branch first, even without a rule that says so. */
  update: z.boolean().optional(),
  /** The patch id of the reviewed change: a head made by bringing the base in must keep it. */
  own_change_id: z.string().min(1).max(200).optional(),
});
export type MergePrInput = z.infer<typeof MergePrInput>;

/** What the tool reports in its result's artifacts. */
export interface MergePrArtifacts {
  status: Exclude<MergeStatus, "not_allowed" | "unverified">;
  message: string;
  /** One sentence for the person (the merge record's) when it did not merge. */
  sentence?: string;
  headSha?: string;
  mergeSha?: string;
  method?: MergeMethod;
  /** The PR was already merged on the host (by the person, or inside another merge). */
  alreadyMerged?: boolean;
  /** The base was merged into the branch before the merge (never a rebase). */
  updated: boolean;
  failedChecks?: string[];
  pendingChecks?: string[];
  conflicts?: string[];
  /**
   * R-lock (leftovers7-merge2): not merged because the record moved meanwhile or its branch owes
   * a rebuild (`stillMayMerge`, `onNewHead`): the caller keeps what the record says now.
   */
  superseded?: boolean;
}

/** One call's answer: the tool's, or the hooks' refusal of the call. */
type CallResult = Omit<MergePrArtifacts, "status"> & {
  status: Exclude<MergeStatus, "unverified">;
};

export interface MergePrToolDeps {
  host: GitHost;
  clock: Clock;
  /** Git over HTTPS for the push of a merged-in base (the PR executor's token, read when it runs; U-082). */
  token?: GitTokenSource;
  identity?: GitIdentity;
  checksWaitMs?: number;
  checksPollMs?: number;
  /**
   * The branch got a new head (the base merged in, pushed): the record moves to it. False: the
   * record moved meanwhile (a rebuild voided it) or its branch owes a rebuild, so nothing is
   * merged (R-lock).
   */
  onNewHead?: (sha: string) => Promise<boolean>;
  /**
   * Asked right before GitHub is asked to merge `head` (R-lock): false when the record moved
   * meanwhile or its branch owes a rebuild. GitHub merges only `head` (the call names it), so a
   * rebuild pushed after this answer makes GitHub refuse the merge.
   */
  stillMayMerge?: (head: string) => Promise<boolean>;
}

/** The tool's answer when the merge stopped for the record's sake (R-lock). */
function superseded(head: string, updated: boolean): MergePrArtifacts {
  return {
    status: "checks_pending",
    message:
      "not merged now: the record moved meanwhile, or the branch is rebuilt first (what it builds on changed)",
    headSha: head,
    updated,
    superseded: true,
  };
}

/** The `merge_pr` tool: class `merge_pr`, the rules above in code. */
export function mergePrTool(deps: MergePrToolDeps): ToolSpec<MergePrInput> {
  return {
    name: MERGE_PR_TOOL,
    description:
      "Merge a reviewed pull request with a merge commit: only at the reviewed head, only where the branch's rules allow it, never with a failed or running check or a conflict, never rebased or force-pushed.",
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

/** "#4" for the pull request in a sentence. */
function prName(n: number): string {
  return `#${n}`;
}

/**
 * The rules Forerunner cannot meet, as the record's sentence (ADR 0111). Nothing here is ever
 * gone around, on an unattended merge or on the person's click.
 */
export function rulesBlock(
  rules: BranchRules,
  n: number,
  base: string,
): { status: "blocked_by_rules" | "merge_commits_off"; message: string; sentence: string } | null {
  const pr = prName(n);
  if (rules.unreadable)
    return {
      status: "blocked_by_rules",
      message: `the protection of ${base} could not be read and the token is an admin's`,
      sentence: `Forerunner cannot read the rules of ${base}, and your token could go around them: merge ${pr} on GitHub.`,
    };
  if (rules.requiredApprovals > 0)
    return {
      status: "blocked_by_rules",
      message: `${base} needs ${rules.requiredApprovals === 1 ? "an approving review" : `${rules.requiredApprovals} approving reviews`}`,
      sentence:
        "This repository needs an approving review before merging, and GitHub does not let you approve your own pull request: merge it on GitHub once someone else approved it.",
    };
  if (rules.codeOwnerReview)
    return {
      status: "blocked_by_rules",
      message: `${base} needs a code owner's review`,
      sentence:
        "This repository needs a code owner's review before merging: merge it on GitHub once a code owner approved it.",
    };
  if (rules.allowedMethods && !rules.allowedMethods.includes("merge"))
    return {
      status: "merge_commits_off",
      message: `the rules of ${base} allow no merge commit`,
      sentence: `The rules of ${base} allow no merge commits, and Forerunner merges only with one: merge ${pr} on GitHub.`,
    };
  if (rules.blockers.length) {
    const what = listWords(rules.blockers);
    return {
      status: "blocked_by_rules",
      message: `the rules of ${base} need ${what}`,
      sentence: `The rules of ${base} need ${what}, which Forerunner cannot give: merge ${pr} on GitHub.`,
    };
  }
  return null;
}

function listWords(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

async function mergeChecked(
  deps: MergePrToolDeps,
  input: MergePrInput,
  ctx: ToolExecutionContext,
): Promise<MergePrArtifacts> {
  const { host, clock } = deps;
  const ref = parsePullUrl(input.pr_url);
  if (!ref)
    return {
      status: "failed",
      message: `not a pull request URL: ${input.pr_url}`,
      sentence: "Forerunner could not read which pull request to merge: merge it on GitHub.",
      updated: false,
    };
  const name = prName(ref.number);
  let pr = await host.getPullRequest(ref.repo, ref.number);
  if (pr.merged)
    return {
      status: "closed",
      message: "already merged",
      alreadyMerged: true,
      ...(pr.mergeCommitSha ? { mergeSha: pr.mergeCommitSha } : {}),
      updated: false,
    };
  if (pr.state !== "open")
    return {
      status: "closed",
      message: "the pull request is closed",
      sentence: `${name} was closed without merging.`,
      updated: false,
    };
  if (pr.head.sha !== input.head_sha) return headMoved(name, pr.head.sha, input.head_sha);
  // Merge commits only: a repository that allows none is never merged by Forerunner.
  if ((await host.getRepo(ref.repo)).allowMergeCommit === false)
    return {
      status: "merge_commits_off",
      message: "the repository does not allow merge commits",
      sentence: `This repository does not allow merge commits, and Forerunner merges only with one: merge ${name} on GitHub, or allow merge commits in its settings.`,
      updated: false,
    };
  // The branch's rules, read before anything else: never gone around.
  const rules = await host.getBranchRules(ref.repo, pr.base.ref);
  const blocked = rulesBlock(rules, ref.number, pr.base.ref);
  if (blocked) return { ...blocked, updated: false };

  let head = pr.head.sha;
  let updated = false;
  let required = [...rules.requiredChecks];
  if (rules.upToDate || input.update === true) {
    // The branch must be up to date: the base is merged in (a merge commit and a normal push),
    // never rebased onto, so work the branch merged in stays as it is.
    const worktree = input.worktree;
    if (!worktree)
      return {
        status: "failed",
        message: "the branch must be brought up to date and the task folder is gone",
        sentence: `${name} must be brought up to date with ${pr.base.ref} first, and its task folder is gone: update it on GitHub, then merge it.`,
        updated: false,
      };
    // R-lock (leftovers7-merge2): the task folder's git is this step's alone from the fetch to
    // the record's move to the pushed head; a rebuild of the same folder waits or is owed.
    const brought = await inWorktree(worktree, async () => {
      // What GitHub has now: a rebuild that held the folder before may have moved the branch.
      const now = await host.getPullRequest(ref.repo, ref.number);
      if (now.head.sha !== input.head_sha) return headMoved(name, now.head.sha, input.head_sha);
      const token = await resolveGitToken(deps.token);
      const auth = token ? gitAuthFor(token, (await host.getRepo(ref.repo)).cloneUrl) : undefined;
      const git = new GitOps({
        cwd: worktree,
        ...(auth ? { auth } : {}),
        ...(deps.identity ? { identity: deps.identity } : {}),
        // merged-copy (ADR 0113): bringing the base in never uploads Local only or a try folder.
        neverPush: NEVER_PUSHED,
      });
      await git.fetch();
      const base = `origin/${pr.base.ref}`;
      const local = await git.headSha();
      if (local !== head) {
        // An earlier try merged the base in here and stopped before its push (a crash, the app
        // closing): that merge is set aside and made again below. Anything else in the task
        // folder is not the reviewed version.
        if (!(await unpushedBaseMerge(git, local, head, base)))
          return {
            ...headMoved(name, head, input.head_sha),
            message: `the task folder is at ${short(local)}, the PR head at ${short(head)}`,
          };
        await git.createBranch(pr.head.ref, head);
      }
      if (await git.isAncestor(base, "HEAD")) return null;
      const beforeCi = await ciOf(host, ref.repo, head);
      const before = judgeChecks(beforeCi.runs, [], beforeCi.statuses);
      if (before.state === "failed") return checksFailed(before, head, false, name);
      const merged = await git.mergeFrom(base, `Merge ${pr.base.ref} into ${pr.head.ref}`);
      if (!merged.ok)
        return {
          status: "conflict",
          message: `bringing ${pr.base.ref} into ${pr.head.ref} conflicts in ${merged.conflicts.join(", ") || "the tree"}`,
          sentence: `${name} conflicts with ${pr.base.ref}${merged.conflicts.length ? ` in ${listWords(merged.conflicts.slice(0, 3))}` : ""}: resolve it on the branch, then merge it.`,
          conflicts: merged.conflicts,
          headSha: head,
          updated: false,
        } satisfies MergePrArtifacts;
      if (input.own_change_id && (await ownChangeId(git, base)) !== input.own_change_id) {
        // Bringing the base in changed the reviewed change itself: back to the reviewed head.
        await git.createBranch(pr.head.ref, head);
        return {
          status: "head_moved",
          message: `bringing ${pr.base.ref} in changed the reviewed change`,
          sentence: `${name} changed when ${pr.base.ref} was merged into it, so it waits for you: look at it, then merge it.`,
          headSha: head,
          updated: false,
        } satisfies MergePrArtifacts;
      }
      await git.push(pr.head.ref, { defaultBranch: pr.base.ref });
      const pushed = await git.headSha();
      // A record a rebuild moved or marked owed meanwhile is never moved to the pushed head.
      if ((await deps.onNewHead?.(pushed)) === false) return superseded(pushed, true);
      return { pushed, beforeCi };
    });
    if (brought && "status" in brought) return brought;
    if (brought) {
      head = brought.pushed;
      updated = true;
      required = [
        ...new Set([
          ...required,
          ...brought.beforeCi.runs.map((r) => r.name),
          ...brought.beforeCi.statuses.map((st) => st.context),
        ]),
      ];
    }
  }
  const waitMs = deps.checksWaitMs ?? DEFAULT_CHECKS_WAIT_MS;
  const pollMs = Math.max(1, deps.checksPollMs ?? DEFAULT_CHECKS_POLL_MS);
  const deadline = clock.now() + waitMs;
  for (;;) {
    pr = await host.getPullRequest(ref.repo, ref.number);
    if (pr.merged || pr.state !== "open")
      return {
        status: "closed",
        message: pr.merged ? "merged meanwhile" : "the pull request was closed meanwhile",
        ...(pr.merged
          ? { alreadyMerged: true, ...(pr.mergeCommitSha ? { mergeSha: pr.mergeCommitSha } : {}) }
          : { sentence: `${name} was closed without merging.` }),
        updated,
      };
    // The host has not seen the push of the merged-in base yet: like a running check.
    const stale = updated && pr.head.sha === input.head_sha;
    if (!stale && pr.head.sha !== head) return { ...headMoved(name, pr.head.sha, head), updated };
    if (!stale && pr.mergeable === false) {
      // The files, when the task folder can tell (the host only says "not mergeable").
      const files = input.worktree
        ? await conflictsIn(deps, ref.repo, input.worktree, pr.base.ref)
        : [];
      return {
        status: "conflict",
        message: `the host reports ${pr.head.ref} conflicts with ${pr.base.ref}${files.length ? ` in ${files.join(", ")}` : ""}`,
        sentence: `${name} conflicts with ${pr.base.ref}${files.length ? ` in ${listWords(files.slice(0, 3))}` : ""}: resolve the conflict on GitHub, then merge it.`,
        ...(files.length ? { conflicts: files } : {}),
        headSha: head,
        updated,
      };
    }
    let verdict: ChecksVerdict = {
      state: "pending",
      failed: [],
      pending: ["the host to show the updated head"],
    };
    if (!stale) {
      const ci = await ciOf(host, ref.repo, head);
      verdict = judgeChecks(ci.runs, required, ci.statuses);
      if (verdict.state === "none" && pr.base.sha) {
        // Nothing on the head is only "no CI" when the base branch reports nothing either; a
        // base with checks means the host has CI that has not reported on this head yet.
        const baseCi = await ciOf(host, ref.repo, pr.base.sha);
        if (baseCi.runs.length || baseCi.statuses.length)
          verdict = {
            state: "pending",
            failed: [],
            pending: [`a check on the head (${pr.base.ref} reports CI, the head none yet)`],
          };
      }
    }
    if (verdict.state === "failed") return checksFailed(verdict, head, updated, name);
    if (verdict.state !== "pending") break;
    if (clock.now() + pollMs > deadline)
      return {
        status: "checks_pending",
        message: `${verdict.pending.length === 1 ? "a check is" : "checks are"} still running${waitMs > 0 ? ` after ${Math.round(waitMs / 1000)} s` : ""}: ${verdict.pending.join(", ")}`,
        sentence: `${name} merges when its checks pass.`,
        pendingChecks: verdict.pending,
        headSha: head,
        updated,
      };
    await clock.sleep(pollMs, ctx.signal);
  }
  // R-lock: the last look before GitHub merges `head`. A rebuild that voided or moved the record
  // (or still owes it) stops the merge here; one that pushes after this look makes GitHub refuse
  // `head`, which the call names.
  if (deps.stillMayMerge && !(await deps.stillMayMerge(head))) return superseded(head, updated);
  const merged = await host.mergePullRequest(ref.repo, ref.number, { sha: head, method: "merge" });
  if (merged.merged)
    return {
      status: "merged",
      message: merged.message || "merged",
      headSha: head,
      method: "merge",
      ...(merged.sha ? { mergeSha: merged.sha } : {}),
      updated,
    };
  return { ...hostRefused(name, merged.message), headSha: head, updated };
}

/**
 * Whether `local` is a merge of the base onto the PR's head that was never pushed: two parents,
 * the first the PR head, the second already in `base`. Only this step makes such a commit after
 * the review, so setting it aside loses nothing.
 */
async function unpushedBaseMerge(
  git: GitOps,
  local: string,
  head: string,
  base: string,
): Promise<boolean> {
  try {
    const parents = await git.parentsOf(local);
    return (
      parents.length === 2 &&
      parents[0] === head &&
      (await git.isAncestor(parents[1] as string, base))
    );
  } catch {
    return false;
  }
}

/** The files the task folder's head conflicts in with the base as the host has it now. */
async function conflictsIn(
  deps: MergePrToolDeps,
  repo: RepoRef,
  worktree: string,
  base: string,
): Promise<string[]> {
  try {
    const token = await resolveGitToken(deps.token);
    const auth = token ? gitAuthFor(token, (await deps.host.getRepo(repo)).cloneUrl) : undefined;
    const git = new GitOps({ cwd: worktree, ...(auth ? { auth } : {}) });
    // R-lock: never in the middle of a rebuild of the same folder.
    return await inWorktree(worktree, async () => {
      await git.fetch();
      return git.conflictFiles("HEAD", `origin/${base}`);
    });
  } catch {
    return [];
  }
}

/** The host's own refusal of the merge, in the record's words. */
function hostRefused(name: string, message: string): Omit<MergePrArtifacts, "updated"> {
  const said = message.replace(/^PUT \S+ -> \d+:\s*/, "").trim();
  if (/merge commits are not allowed/i.test(said))
    return {
      status: "merge_commits_off",
      message: `the host refused the merge: ${said}`,
      sentence: `This repository does not allow merge commits, and Forerunner merges only with one: merge ${name} on GitHub, or allow merge commits in its settings.`,
    };
  if (/approving review|code owner|protected branch|rule/i.test(said))
    return {
      status: "blocked_by_rules",
      message: `the host refused the merge: ${said}`,
      sentence: `GitHub's rules for this branch refused the merge of ${name}: merge it on GitHub once its rules are met.`,
    };
  if (/not mergeable/i.test(said))
    return {
      status: "conflict",
      message: `the host refused the merge: ${said}`,
      sentence: `${name} conflicts with its base: resolve the conflict on GitHub, then merge it.`,
    };
  if (/modified|head/i.test(said))
    return {
      status: "head_moved",
      message: `the host refused the merge: ${said}`,
      sentence: `${name} changed after the review: look at the new commits, then merge it yourself or send it back.`,
    };
  return {
    status: "failed",
    message: `the host refused the merge: ${said}`,
    sentence: `GitHub refused to merge ${name}: open it on GitHub and merge it yourself.`,
  };
}

/**
 * The record's sentence for a pull request whose head is not the reviewed commit (ADR 0111):
 * "#8 changed after the review: look at the new commits, then merge it yourself or send it
 * back." The Overview offers no Merge for it (`head_moved`). Also the conflict notice's, once
 * the person resolved the conflict on GitHub with a commit of their own (dependent-branches).
 */
export function headMovedSentence(pr: number): string {
  return `${prName(pr)} changed after the review: look at the new commits, then merge it yourself or send it back.`;
}

function headMoved(name: string, now: string, reviewed: string): MergePrArtifacts {
  return {
    status: "head_moved",
    message: `the PR head ${short(now)} is not the reviewed commit ${short(reviewed)}`,
    sentence: `${name} changed after the review: look at the new commits, then merge it yourself or send it back.`,
    headSha: now,
    updated: false,
  };
}

function checksFailed(
  v: ChecksVerdict,
  head: string,
  updated: boolean,
  name: string,
): MergePrArtifacts {
  return {
    status: "checks_failed",
    message: `${v.failed.length === 1 ? "a check" : "checks"} failed on ${short(head)}: ${v.failed.join(", ")}`,
    sentence: `A check failed on ${name} (${listWords(v.failed.slice(0, 3))}): fix it, or merge it on GitHub.`,
    failedChecks: v.failed,
    headSha: head,
    updated,
  };
}

function short(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

// ---------------------------------------------------------------------------------------
// The one gated entry (ADR 0111)
// ---------------------------------------------------------------------------------------

/** Who asks for a merge: the session's accept, the watcher's retry, the daemon's start, a click. */
export interface MergeAuthority {
  kind: "session" | "retry" | "resume" | "person";
  /** The person who pressed Merge (`kind: "person"`). */
  humanId?: string;
}

export type MergeGate =
  | {
      allowed: true;
      /** What approves it: the project's setting (`mode`) or the person's click. */
      approval: "mode" | "person";
      /** The setting that freed it, or the person's id: the record's `approved_by`. */
      by: string;
      /** Bring a base that moved into the branch first (the caller's mode needs its checks on the combined result). */
      update?: boolean;
    }
  | {
      allowed: false;
      /** The audit row's code. */
      code: "autonomy_insufficient";
      /** The task row's reason (after "PR left open for you: "). */
      reason: string;
      /** The record's sentence for the person. */
      sentence: string;
      /**
       * Not now, and not a refusal (merge-in-app): the person's Merge waits for the pull
       * requests its task builds on to merge first. The record is kept as it is (no audit row,
       * no card), and the next retry asks again.
       */
      wait?: boolean;
    };

/**
 * What the gate may look at beyond the project and the record (merge-in-app): `ReviewedPrMerge`
 * builds it for each call from the host and the task's folder. Absent (a test's own call): the
 * base counts as unmoved and nothing is waited for.
 */
export interface MergeLook {
  /**
   * What merging the base now would bring into what the review read: `none` when the base is
   * where it was at the review, or moved only by work the reviewed head already holds (a
   * dependency merged with a merge commit); `conflicts` when the two conflict (the tool then
   * names the files to the person); `adds` otherwise, and when it cannot tell.
   */
  baseChange(): Promise<"none" | "adds" | "conflicts">;
  /** Whether the repository runs automatic checks (on the reviewed head or on the base). */
  hasChecks(): Promise<boolean>;
  /**
   * The open pull requests the task builds on that are not merged yet, by number; `merging`
   * when that one's own merge is under way or waits (queued, merging, waiting for its checks).
   */
  openDependencies(): Promise<{ number: number; merging: boolean }[]>;
}

/** The record's `approved_by` for a merge the project's mode freed (the audit row says it too). */
export const MERGE_MODE_APPROVAL = `the project's merge mode (${MERGE_MODE_WORDS.after_review})`;

function prList(numbers: readonly number[]): string {
  return listWords(numbers.map(prName));
}

/**
 * The one gate every merge of a task's pull request asks (ADR 0111, amended by merge-in-app),
 * with the project as it is now: its body is read at every call, so a retry, the resume at the
 * daemon's start and a record made before a change all obey the setting of the moment.
 *
 * - The person's Merge in the app always approves (`authority.kind === "person"`), and so does
 *   a record their click approved that then waited (its checks, a restart): the retry merges it
 *   once the pull requests its task builds on are merged (in order; until then it waits).
 * - Unattended, only the project's merge mode "Merge automatically after review" merges; "You
 *   press Merge", the default, leaves every pull request for the person's Merge. No autonomy
 *   level frees a merge (the owner's decision of 2026-11-02: merging is its own per-project
 *   setting, separate from level 3, which also allows much more).
 * - In the automatic mode, when the base moved since the review with work the reviewed head
 *   does not hold, the base is merged in first and the repository's checks must pass on that
 *   head (`update`); a repository with no automatic checks has nothing that tests the two
 *   together, so that pull request waits for the person's Merge, with one sentence.
 */
export async function mayMerge(
  project:
    | (Pick<ProjectRow, "autonomy_level"> & Partial<Pick<ProjectRow, "settings">>)
    | null
    | undefined,
  record: Pick<MergeRecordRow, "pr_number"> &
    Partial<Pick<MergeRecordRow, "approval" | "approved_by">>,
  authority: MergeAuthority,
  look?: MergeLook,
): Promise<MergeGate> {
  const pr = prName(record.pr_number);
  if (authority.kind === "person")
    return { allowed: true, approval: "person", by: authority.humanId ?? "the person" };
  if (record.approval === "person") {
    const first = (await look?.openDependencies()) ?? [];
    const stuck = first.filter((d) => !d.merging).map((d) => d.number);
    if (stuck.length)
      // What it builds on waits for the person: waiting here would wait for ever.
      return {
        allowed: false,
        code: "autonomy_insufficient",
        reason: `${pr} builds on ${prList(stuck)}, which ${stuck.length === 1 ? "is" : "are"} not merged`,
        sentence: `${pr} builds on ${prList(stuck)}, which ${stuck.length === 1 ? "is" : "are"} not merged: merge ${stuck.length === 1 ? "it" : "them"} first.`,
      };
    if (first.length)
      return {
        allowed: false,
        wait: true,
        code: "autonomy_insufficient",
        reason: `${pr} merges after ${prList(first.map((d) => d.number))}`,
        sentence: `${pr} merges after ${prList(first.map((d) => d.number))}.`,
      };
    return { allowed: true, approval: "person", by: record.approved_by ?? "the person" };
  }
  if (mergeModeOf(project?.settings) !== "after_review")
    return {
      allowed: false,
      code: "autonomy_insufficient",
      reason: `the project's merge mode is "${MERGE_MODE_WORDS.you}"`,
      sentence: `${pr} waits for you to merge it: press Merge on the Overview.`,
    };
  // A conflict is the tool's to find and say (with the files, on a card): it merges nothing.
  const change = look ? await look.baseChange() : "none";
  if (change !== "adds") return { allowed: true, approval: "mode", by: MERGE_MODE_APPROVAL };
  if (await look?.hasChecks())
    return { allowed: true, approval: "mode", by: MERGE_MODE_APPROVAL, update: true };
  return {
    allowed: false,
    code: "autonomy_insufficient",
    reason:
      "main changed since the review, and the repository has no automatic checks to test the two together",
    sentence: `${pr} waits for you: main changed since the review, and this repository has no automatic checks to test the two together. Press Merge if it should go in.`,
  };
}

/** One merge this area made (or the watcher saw): what later areas subscribe to. */
export interface MergedEvent {
  task: TaskRow;
  record: MergeRecordRow;
  mergeSha: string | null;
  method: MergeMethod | null;
}

export interface ReviewedPrMergeDeps extends MergePrToolDeps {
  store: StateStore;
  tokens: TokenIssuer;
  hooks: Pick<EnforcementHooks, "beforeToolCall" | "afterToolCall">;
  /** The hooks' audit port: the gate's refusal is one row there, as the hooks' would be. */
  audit: AuditPort;
  /** Where `PrTaskExecutor` keeps worktrees (`<worktreeRoot>/<task id>`): the reviewed commit. */
  worktreeRoot?: string;
  /** The install's agents: their records are retried and resumed here, no other's. */
  agentIds?: readonly string[];
  /**
   * The hosts a retry's own token may reach (the git host's): a PR URL on any other host gets a
   * token with no domain, and the hooks refuse it.
   */
  allowedDomains?: readonly string[];
  /** The gate (`mayMerge` by default; tests and 'merge-in-app' pass their own). */
  gate?: typeof mayMerge;
  /** True while the kill switch holds this agent's work (Stop all): the retry pass waits. */
  stopped?: (agentId: string) => boolean;
}

/** What a merge in a session brings: its token, budget and stop. */
interface SessionContext {
  token: SignedToken;
  budget: SessionBudget;
  signal: AbortSignal;
  sessionId: string;
}

export class ReviewedPrMerge implements MergePort {
  private readonly logger = log("merge");
  readonly tool: ToolSpec<MergePrInput>;
  /** Tasks whose merge runs now in this process: a retry never starts a second one. */
  private readonly inFlight = new Set<string>();
  private readonly mergedListeners = new Set<(e: MergedEvent) => void | Promise<void>>();
  private readonly mergedLaterListeners = new Set<
    (e: { task: TaskRow; record: MergeRecordRow }) => void | Promise<void>
  >();

  constructor(private readonly deps: ReviewedPrMergeDeps) {
    this.tool = mergePrTool(deps);
  }

  /**
   * leftovers7-merge2: called once for each merge the app made by itself (the retry pass, the
   * resume at the daemon's start), after its Update was filed: the daemon raises one
   * notification for it (compose), as a session's merge has its session's and the person's own
   * click is answered where it was pressed.
   */
  onMergedLater(
    listener: (e: { task: TaskRow; record: MergeRecordRow }) => void | Promise<void>,
  ): () => void {
    this.mergedLaterListeners.add(listener);
    return () => this.mergedLaterListeners.delete(listener);
  }

  /** Called for every merge of a task's PR (session, retry, resume, and what `merged` is told). */
  onMerged(listener: (e: MergedEvent) => void | Promise<void>): () => void {
    this.mergedListeners.add(listener);
    return () => this.mergedListeners.delete(listener);
  }

  /** Tell the listeners a task's PR was merged ('dependent-branches' calls it for merges seen on GitHub). */
  async merged(e: MergedEvent): Promise<void> {
    for (const fn of this.mergedListeners) {
      try {
        await fn(e);
      } catch (err) {
        this.logger.warn("merged listener failed", { taskId: e.task.id, error: errorMessage(err) });
      }
    }
  }

  /**
   * After an accepting review: pin the reviewed commit in the task's merge record (the
   * worktree's HEAD now, before anything moves it, in every mode and at every level), then
   * merge through `mergeRecorded`. Null without a PR.
   */
  async mergeReviewed(req: MergeRequest): Promise<MergeOutcome | null> {
    const { task } = req;
    if (!task.pr_url) return null;
    const prUrl = task.pr_url;
    const parsed = parsePullUrl(prUrl);
    if (this.inFlight.has(task.id)) {
      const current = await this.deps.store.mergeRecord.forTask(task.id);
      return current ? this.outcomeOf(current, "checks_pending") : null;
    }
    this.inFlight.add(task.id);
    try {
      const worktree = this.worktreeOf(task);
      let reviewed: string | null = null;
      let reviewedBase: string | null = null;
      let ownChange: string | null = null;
      if (worktree) {
        const git = new GitOps({ cwd: worktree });
        try {
          // R-lock: read between steps in the folder, never in the middle of a rebuild there.
          await inWorktree(worktree, async () => {
            reviewed = await git.headSha();
            const base = await this.baseRefOf(git, prUrl);
            if (base) {
              reviewedBase = await git.resolveRef(base);
              ownChange = await ownChangeId(git, base).catch(() => null);
            }
          });
        } catch (e) {
          this.logger.warn("worktree head unreadable", { taskId: task.id, error: errorMessage(e) });
        }
      }
      const record = await this.deps.store.mergeRecord.pin({
        task_id: task.id,
        project_id: task.project_id,
        agent_id: req.agentId,
        pr_number: parsed?.number ?? 0,
        pr_url: prUrl,
        reviewed_head_sha: reviewed ?? "",
        reviewed_base_sha: reviewedBase,
        own_change_id: ownChange,
        author_agent: req.agentId,
      });
      return await this.run(
        record,
        { kind: "session" },
        {
          token: req.token,
          budget: req.budget,
          signal: req.signal,
          sessionId: req.session.id,
        },
      );
    } finally {
      this.inFlight.delete(task.id);
    }
  }

  /**
   * The only way anything merges a task's pull request (ADR 0111): the gate first, then one
   * `merge_pr` call through the hooks pinned to the record's reviewed commit. Outside a session
   * (a retry, the resume, the person's click) the call runs on its own narrow token.
   */
  async mergeRecorded(record: MergeRecordRow, authority: MergeAuthority): Promise<MergeOutcome> {
    if (this.inFlight.has(record.task_id)) return this.outcomeOf(record, "checks_pending");
    this.inFlight.add(record.task_id);
    try {
      return await this.run(record, authority, null);
    } finally {
      this.inFlight.delete(record.task_id);
    }
  }

  /**
   * The watcher's retry pass (called from its poll): every record of this install's agents that
   * waits (its checks were still running, or a crash left it queued) is tried once, without
   * waiting: merged when its checks are green on the record's commit.
   */
  async retryWaiting(): Promise<MergeOutcome[]> {
    const out: MergeOutcome[] = [];
    for (const agentId of this.deps.agentIds ?? []) {
      // Stop all holds the merges too: nothing is tried (or audited) until work may run again.
      if (this.deps.stopped?.(agentId)) continue;
      const waiting = await this.deps.store.mergeRecord.forAgent(agentId, [
        "waiting_checks",
        "queued",
      ]);
      for (const record of waiting) {
        if (this.inFlight.has(record.task_id)) continue;
        try {
          // TM-5 (leftovers7-tailmerge): only a done task's pull request is merged by the pass.
          // One redone (or cancelled, failed) while its record waited is being done again: its
          // old head is not what it will be, and its run holds the task's folder, so the gate's
          // look at a base that moved would wait for that run and hold the watcher's poll (no
          // pull request events, copy refreshes or conflict notices) until it ended. The record
          // stays as it is; the task's next accept moves it to the new head.
          const task = await this.deps.store.task.get(record.task_id);
          if (task?.status !== "done") continue;
          const still = await this.stillWaiting(record);
          if (still) {
            out.push(this.outcomeOf(still, "checks_pending"));
            continue;
          }
          out.push(await this.mergeRecorded(record, { kind: "retry" }));
        } catch (e) {
          this.logger.warn("merge retry failed", {
            taskId: record.task_id,
            error: errorMessage(e),
          });
        }
      }
    }
    return out;
  }

  /**
   * R-mergeretry (leftovers7-merge): a record that waits for its checks is looked at before a
   * gated call is made. While the checks on its reviewed commit still run (and the pull request
   * is open, on that commit and not in conflict), the pass counts the attempt and moves on: no
   * token, no audit row, two reads of GitHub instead of a full `merge_pr` call every minute.
   * Anything else (green, failed, no checks, another head, closed, GitHub silent, the day's last
   * attempt) goes through the gated call as before. Returns the record when it still waits.
   */
  private async stillWaiting(record: MergeRecordRow): Promise<MergeRecordRow | null> {
    if (record.state !== "waiting_checks" || record.last_outcome !== "checks_pending") return null;
    if (!record.reviewed_head_sha || record.attempts + 1 >= MAX_MERGE_ATTEMPTS) return null;
    const ref = parsePullUrl(record.pr_url);
    if (!ref) return null;
    try {
      const pr = await this.deps.host.getPullRequest(ref.repo, ref.number);
      if (pr.merged || pr.state !== "open" || pr.mergeable === false) return null;
      if (pr.head.sha !== record.reviewed_head_sha) return null;
      const ci = await ciOf(this.deps.host, ref.repo, pr.head.sha);
      if (judgeChecks(ci.runs, [], ci.statuses).state !== "pending") return null;
    } catch {
      return null;
    }
    return this.deps.store.mergeRecord.move(record.id, "waiting_checks", {
      attempts: record.attempts + 1,
    });
  }

  /**
   * R-mergeretry: a merge the app made by itself (the retry pass, the resume at the daemon's
   * start) is one Update in the Inbox (design 3.8); a session's merge is in its result and the
   * person's own click is answered where they pressed it, so neither adds one.
   */
  private async tellMerged(task: TaskRow, record: MergeRecordRow): Promise<void> {
    try {
      const owner = await this.ownerOf(record.agent_id);
      if (!owner) return;
      await this.deps.store.message.send({
        from_agent_id: record.agent_id,
        to_human_id: owner,
        project_id: record.project_id ?? task.project_id,
        task_id: task.id,
        type: "info",
        body: mergedUpdateWords(record.pr_number, task.title),
        requires_ack: false,
        author_agent: record.agent_id,
      });
    } catch (e) {
      this.logger.warn("merge update not sent", { taskId: task.id, error: errorMessage(e) });
    }
    for (const fn of this.mergedLaterListeners) {
      try {
        await fn({ task, record });
      } catch (e) {
        this.logger.warn("merged-later listener failed", {
          taskId: task.id,
          error: errorMessage(e),
        });
      }
    }
  }

  /**
   * At the daemon's start: a record a dead process left `merging` is settled by what the host
   * says. Merged there: marked merged. Closed: left to the person. Open: back to waiting, and
   * the retry pass merges it.
   */
  async resumeAtStart(): Promise<void> {
    for (const agentId of this.deps.agentIds ?? []) {
      for (const record of await this.deps.store.mergeRecord.forAgent(agentId, ["merging"])) {
        try {
          const ref = parsePullUrl(record.pr_url);
          const pr = ref ? await this.deps.host.getPullRequest(ref.repo, ref.number) : null;
          if (pr?.merged) {
            const done = await this.deps.store.mergeRecord.move(record.id, "merged", {
              merge_sha: pr.mergeCommitSha ?? null,
              method: "merge",
              sentence: "",
              last_outcome: "merged",
            });
            this.logger.info("merge record resumed", { taskId: record.task_id, state: "merged" });
            const task = await this.deps.store.task.get(record.task_id);
            if (task) {
              await this.merged({ task, record: done, mergeSha: done.merge_sha, method: "merge" });
              await this.tellMerged(task, done);
            }
          } else if (pr && pr.state !== "open") {
            await this.deps.store.mergeRecord.move(record.id, "left_to_you", {
              sentence: `${prName(record.pr_number)} was closed without merging.`,
              last_outcome: "closed",
            });
            this.logger.info("merge record resumed", {
              taskId: record.task_id,
              state: "left_to_you",
            });
          } else {
            await this.deps.store.mergeRecord.move(record.id, "waiting_checks", {
              sentence: `${prName(record.pr_number)} merges when its checks pass.`,
            });
            this.logger.info("merge record resumed", {
              taskId: record.task_id,
              state: "waiting_checks",
            });
          }
        } catch (e) {
          this.logger.warn("merge record not resumed", {
            taskId: record.task_id,
            error: errorMessage(e),
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // The person's Merge in the app (merge-in-app)
  // -------------------------------------------------------------------------------------

  /**
   * The person pressed Merge on a task's pull request (merge-in-app): `chain` is that task last,
   * after the done tasks whose open pull requests it builds on, in the order they merge. Each
   * record is approved by the person and queued, at once and persisted, before anything merges:
   * the merges then run in that order (`mergeApproved`), and a merge that waits (its checks, a
   * restart) is finished by the watcher's retry pass, which keeps the order (`mayMerge`). A task
   * with no record (accepted before ADR 0111) gets one with no reviewed commit: the click merges
   * its pull request as it is on GitHub now. Returns the records in order, the merged ones left
   * out; nothing for a record already merging in this process.
   */
  async approveInOrder(chain: readonly TaskRow[], humanId: string): Promise<MergeRecordRow[]> {
    const { store } = this.deps;
    const out: MergeRecordRow[] = [];
    for (const task of chain) {
      if (!task.pr_url) continue;
      let record = await store.mergeRecord.forTask(task.id);
      if (record?.state === "merged" && record.pr_url === task.pr_url) continue;
      if (!record || record.pr_url !== task.pr_url) {
        const agentId =
          record?.agent_id ?? task.owner_agent_id ?? this.deps.agentIds?.[0] ?? task.author_agent;
        record = await store.mergeRecord.pin({
          task_id: task.id,
          project_id: task.project_id,
          agent_id: agentId ?? "",
          pr_number: parsePullUrl(task.pr_url)?.number ?? 0,
          pr_url: task.pr_url,
          reviewed_head_sha: "",
          author_agent: agentId ?? "",
        });
      }
      if (record.state === "merging" || this.inFlight.has(task.id)) {
        out.push(record);
        continue;
      }
      out.push(
        await store.mergeRecord.move(record.id, "queued", {
          approval: "person",
          approved_by: humanId,
          sentence: `${prName(record.pr_number)} merges now: you pressed Merge.`,
        }),
      );
    }
    return out;
  }

  /**
   * The approved records merged one after another (merge-in-app), each through `mergeRecorded`
   * on the person's click: never rebased, a merge commit each. The first that does not merge
   * stops the rest: one that waits for its checks keeps them queued in order for the retry
   * pass; one left to the person leaves them to the person too, with one sentence each.
   */
  async mergeApproved(
    records: readonly MergeRecordRow[],
    humanId: string,
  ): Promise<MergeOutcome[]> {
    const { store } = this.deps;
    const out: MergeOutcome[] = [];
    for (let i = 0; i < records.length; i++) {
      const current = await store.mergeRecord.get((records[i] as MergeRecordRow).id);
      if (!current) continue;
      if (current.state === "merged") continue;
      const outcome = await this.mergeRecorded(current, { kind: "person", humanId });
      out.push(outcome);
      if (outcome.status === "merged") continue;
      const after = await store.mergeRecord.get(current.id);
      if (after?.state === "left_to_you") {
        for (const later of records.slice(i + 1)) {
          const row = await store.mergeRecord.get(later.id);
          if (!row || row.state === "merged" || row.state === "merging") continue;
          await store.mergeRecord.move(row.id, "left_to_you", {
            approval: "none",
            approved_by: null,
            sentence: `${prName(row.pr_number)} builds on ${prName(current.pr_number)}, which was not merged: merge ${prName(current.pr_number)} first.`,
            last_outcome: "not_allowed",
          });
        }
      }
      break;
    }
    return out;
  }

  /**
   * A pull request with no task (Forerunner's docs: the scaffold, the plan's docs, the status)
   * merged on the person's click, as it is on GitHub now (merge-in-app): one `merge_pr` call
   * through the hooks on its own narrow token, with the person's approval, a merge commit, the
   * branch's rules read first. Never unattended, in either mode.
   */
  async mergeAsIs(input: {
    prUrl: string;
    projectId: string | null;
    agentId: string;
    humanId: string;
  }): Promise<{ status: MergeStatus; sentence: string; mergeSha?: string }> {
    const { store, clock, tokens, host } = this.deps;
    const ref = parsePullUrl(input.prUrl);
    if (!ref)
      return {
        status: "failed",
        sentence: "Forerunner could not read which pull request to merge.",
      };
    const pr = await host.getPullRequest(ref.repo, ref.number);
    if (pr.merged) return { status: "merged", sentence: `${prName(ref.number)} is merged.` };
    if (pr.state !== "open")
      return { status: "closed", sentence: `${prName(ref.number)} was closed without merging.` };
    const project = input.projectId ? await store.project.get(input.projectId) : null;
    const now = clock.nowIso();
    const subject = {
      id: `pr-${ref.number}`,
      task_id: "",
      project_id: input.projectId,
      agent_id: input.agentId,
      pr_number: ref.number,
      pr_url: input.prUrl,
      reviewed_head_sha: pr.head.sha,
      reviewed_base_sha: null,
      own_change_id: null,
      state: "queued",
      approval: "person",
      approved_by: input.humanId,
      merge_sha: null,
      method: null,
      attempts: 0,
      sentence: "",
      last_outcome: null,
      created_at: now,
      updated_at: now,
      author_agent: input.agentId,
      author_human: input.humanId,
      version: 1,
    } as unknown as MergeRecordRow;
    const runId = newId(clock.now());
    const token = this.ownToken(subject, input.humanId, project, runId, null);
    try {
      const a = await this.call(
        subject,
        token,
        null,
        null,
        { allowed: true, approval: "person", by: input.humanId },
        project?.autonomy_level ?? 0,
      );
      if (a.status === "merged" || a.alreadyMerged)
        return {
          status: "merged",
          sentence: `Merged ${prName(ref.number)} as it is on GitHub now.`,
          ...(a.mergeSha ? { mergeSha: a.mergeSha } : {}),
        };
      this.logger.info("merge as it is", { prUrl: input.prUrl, status: a.status });
      return {
        status: a.status,
        sentence: a.sentence ?? `${prName(ref.number)} was not merged: open it on GitHub.`,
      };
    } finally {
      tokens.revoke(token.claims.id);
    }
  }

  private async run(
    pinned: MergeRecordRow,
    authority: MergeAuthority,
    session: SessionContext | null,
  ): Promise<MergeOutcome> {
    const { store, clock, tokens } = this.deps;
    // The record as it is now: a caller's row may be older than a write since (the retry pass
    // lists its rows once; a rebuild marks a record owed meanwhile, R-owed), and the claim below
    // takes only the version it read.
    let record = (await store.mergeRecord.get(pinned.id)) ?? pinned;
    const task = await store.task.mustGet(record.task_id);
    if (record.state === "merged") return this.outcomeOf(record, "merged");
    const prUrl = record.pr_url;
    const base = { taskId: task.id, prUrl };
    const project = record.project_id ? await store.project.get(record.project_id) : null;
    const owner = await this.ownerOf(record.agent_id);

    if (!record.reviewed_head_sha) {
      // Nothing proves which version the review read: never merged unattended. The person's
      // click merges the pull request as it is on GitHub now, and the outcome says so.
      const ref = authority.kind === "person" ? parsePullUrl(prUrl) : null;
      const head = ref ? (await this.deps.host.getPullRequest(ref.repo, ref.number)).head.sha : "";
      if (!head)
        return this.settle(record, task, session, owner, {
          ...base,
          status: "unverified",
          reason: `PR left open for you: the reviewed commit is not known (no task worktree), so ${prUrl} is not merged automatically`,
          sentence: `Forerunner does not know which version of ${prName(record.pr_number)} the review read, so it leaves the merge to you.`,
        });
      record = await store.mergeRecord.move(record.id, record.state, { reviewed_head_sha: head });
    }

    const worktree = this.worktreeOf(task);
    const runId = newId(clock.now());
    const token = session
      ? tokens.derive(session.token, {
          runId,
          taskId: task.id,
          allowedTools: [MERGE_PR_TOOL],
          allowedPaths: worktree ? [worktree] : [],
          grantedSecrets: [],
          budgetUsdMicro: 0,
        })
      : this.ownToken(record, owner, project, runId, worktree);
    try {
      const gate = await (this.deps.gate ?? mayMerge)(
        project,
        record,
        authority,
        this.lookFor(record, task, worktree),
      );
      // The person's Merge that waits for the pull requests it builds on (merge-in-app): not
      // a refusal; the record stays as it is and the next retry asks again.
      if (!gate.allowed && gate.wait) return this.outcomeOf(record, "checks_pending");
      if (!gate.allowed) {
        await this.deps.audit.append({
          sessionId: token.claims.sessionId,
          runId,
          agentId: token.claims.agentId,
          humanId: token.claims.ownerHumanId,
          tool: MERGE_PR_TOOL,
          inputSummary: JSON.stringify({ pr_url: prUrl, head_sha: record.reviewed_head_sha }),
          resultSummary: "",
          allowed: false,
          deniedReason: `${gate.code}: ${gate.reason}`,
          costUsdMicro: 0,
          occurredAt: clock.nowIso(),
          tokenId: token.claims.id,
        });
        return this.settle(record, task, session, owner, {
          ...base,
          status: "not_allowed",
          reason: `PR left open for you: ${gate.reason}`,
          sentence: gate.sentence,
        });
      }
      // R-lock (leftovers7-merge2): its branch still owes a rebuild (what it builds on was merged,
      // closed or redone, and the rebuild has not run yet): not now. The record stays as it is
      // (no claim, no call); the watcher's sweep rebuilds it and the retry merges what it may.
      if (record.rebuild_owed_for) {
        // TM-4: when the rebuild cannot run because the task's folder holds changes nobody
        // committed, the record says so (the rows read it); the merge still waits.
        return this.outcomeOf(await this.sayOwedWait(record, worktree), "checks_pending");
      }
      const claimed = await store.mergeRecord.claim(record);
      // Another process took it between the read and now: that one merges it.
      if (!claimed)
        return this.outcomeOf(await store.mergeRecord.mustGet(record.id), "checks_pending");
      record = claimed;
      const level = project?.autonomy_level ?? 0;
      let a = await this.call(record, token, session, worktree, gate, level, true);
      if (!(a.status === "merged" || a.alreadyMerged)) {
        // R-lock: a record moved by someone else while the call ran (a rebuild voided it, or
        // moved it to a rebuilt head) keeps that word, whatever GitHub answered the call (it
        // refuses a head the rebuild pushed over). One whose branch now owes a rebuild waits for
        // it, queued as it was approved.
        const now = await store.mergeRecord.get(record.id);
        if (now && now.state !== "merging") return this.outcomeOf(now, a.status);
        if (now && a.superseded) {
          const back = await store.mergeRecord.move(now.id, "queued", {
            last_outcome: "rebuild_owed",
          });
          return this.outcomeOf(back, "checks_pending");
        }
      }
      if (
        a.status === "head_moved" &&
        a.headSha &&
        worktree &&
        a.headSha !== record.reviewed_head_sha
      ) {
        // A record moved by someone else while this merge waited (a dependent branch rebuilt
        // without work its review read: dependent-branches) keeps that word: never followed.
        const now = await store.mergeRecord.get(record.id);
        if (now && now.state !== "merging") return this.outcomeOf(now, "head_moved");
        // A head that keeps exactly the reviewed change (main merged in, by a crashed earlier
        // attempt or GitHub's Update branch) moves the record; anything else waits for the person.
        if (await this.keepsOwnChange(record, worktree, a.headSha)) {
          record = await store.mergeRecord.move(record.id, "merging", {
            reviewed_head_sha: a.headSha,
          });
          a = await this.call(record, token, session, worktree, gate, level, true);
        }
      }
      const outcome = await this.finish(record, task, session, owner, gate, a);
      // What the app merged by itself (a retry, the resume) is news; a session's merge and the
      // person's own click are not (R-mergeretry).
      if (outcome.status === "merged" && !session && authority.kind !== "person")
        await this.tellMerged(task, record);
      return outcome;
    } catch (e) {
      // A stop is the session's, never the level's refusal; a stop or anything unexpected leaves
      // the record waiting as it was (never `merging` for good), and the retry tries it again
      // once work may run.
      const now = await store.mergeRecord.get(record.id).catch(() => undefined);
      if (now?.state === "merging")
        await store.mergeRecord
          .move(record.id, "waiting_checks", {
            sentence: `${prName(record.pr_number)} merges when its checks pass.`,
          })
          .catch(() => undefined);
      throw e;
    } finally {
      if (!session) tokens.revoke(token.claims.id);
    }
  }

  /** One `merge_pr` call through the hooks. */
  private async call(
    record: MergeRecordRow,
    token: SignedToken,
    session: SessionContext | null,
    worktree: string | null,
    gate: Extract<MergeGate, { allowed: true }>,
    level: number,
    /** The merge of a task's stored record (`run`): the R-lock checks below apply. */
    fenced = false,
  ): Promise<CallResult> {
    const { clock, hooks, store } = this.deps;
    const pollMs = Math.max(1, this.deps.checksPollMs ?? DEFAULT_CHECKS_POLL_MS);
    // In a session the checks wait ends inside the session's wall-clock cap (spec I), one poll
    // before it, so the last look, the merge and its audit row still run on a live token. A
    // retry never waits: it looks once, and the next poll looks again.
    const waitMs = session
      ? Math.min(
          this.deps.checksWaitMs ?? DEFAULT_CHECKS_WAIT_MS,
          Math.max(0, session.budget.limits.deadlineMs - clock.now() - pollMs),
        )
      : 0;
    // R-lock: the record as this call claimed it, at the head it merges. Moved by someone else
    // since (a rebuild voided it, or moved it to the rebuilt head) or marked owed: no merge.
    let expected = record.reviewed_head_sha;
    const ours = async (head: string): Promise<boolean> => {
      // A pull request merged as it is (`mergeAsIs`: a docs or take-out one) has no record.
      if (!fenced) return true;
      const now = await store.mergeRecord.get(record.id);
      return (
        !!now &&
        now.state === "merging" &&
        !now.rebuild_owed_for &&
        now.reviewed_head_sha === expected &&
        head === expected
      );
    };
    const tool = mergePrTool({
      ...this.deps,
      checksWaitMs: waitMs,
      onNewHead: async (sha) => {
        if (!(await ours(expected))) return false;
        await store.mergeRecord.move(record.id, "merging", { reviewed_head_sha: sha });
        expected = sha;
        return true;
      },
      stillMayMerge: (head) => ours(head),
    });
    const input: MergePrInput = {
      // First, so the audit row's summary (cut at a few hundred characters) keeps it.
      approved_by: gate.approval === "person" ? `the person ${gate.by}` : gate.by,
      pr_url: record.pr_url,
      head_sha: record.reviewed_head_sha,
      ...(worktree ? { worktree } : {}),
      ...(gate.update ? { update: true } : {}),
      ...(record.own_change_id ? { own_change_id: record.own_change_id } : {}),
    };
    const signal = session?.signal ?? new AbortController().signal;
    const budget =
      session?.budget ??
      new SessionBudget({
        sessionId: token.claims.sessionId,
        budgetUsdMicro: 0,
        stepCap: 10,
        deadlineMs: clock.now() + RETRY_TOKEN_MS,
        reserveShare: 0,
      });
    const ctx: RunContext = {
      token,
      budget,
      signal,
      runDeadlineMs: Math.min(
        clock.now() + (tool.timeoutMs ?? DEFAULT_CHECKS_WAIT_MS),
        budget.limits.deadlineMs,
      ),
      phase: "work",
      model: "none",
      provider: "none",
      billingSourceId: "",
      cwd: worktree ?? undefined,
      unattended: true,
      // The gate's approval (the project's merge mode, or the person's click) approves exactly
      // this call, so no autonomy level frees a merge by itself (merge-in-app: `merge_pr` is
      // free at no level); the hooks see the approval like any other, and the call's
      // `approved_by` puts where it came from in the audit row.
      approvals: new Set([approvalKeyFor(MERGE_PR_TOOL, input)]),
    };
    let admitted: Awaited<ReturnType<EnforcementHooks["beforeToolCall"]>>;
    try {
      admitted = await hooks.beforeToolCall(ctx, tool as ToolSpec, input);
    } catch (e) {
      if (!(e instanceof ForerunnerError) || e.code === "killed") throw e;
      return {
        status: "not_allowed",
        message:
          e.code === "autonomy_insufficient"
            ? `autonomy level ${level} does not allow the merge`
            : `the merge was refused (${e.code}: ${e.message})`,
        sentence: `Forerunner was not allowed to merge ${prName(record.pr_number)}: merge it on GitHub.`,
        updated: false,
      };
    }
    if (!admitted.allowed)
      return {
        status: "not_allowed",
        message: admitted.reason,
        sentence: `Forerunner was not allowed to merge ${prName(record.pr_number)}: merge it on GitHub.`,
        updated: false,
      };
    let result: ToolResult;
    try {
      result = await tool.execute(admitted.input as MergePrInput, {
        runId: token.claims.runId,
        sessionId: token.claims.sessionId,
        agentId: token.claims.agentId,
        humanId: token.claims.ownerHumanId,
        ...(token.claims.projectId ? { projectId: token.claims.projectId } : {}),
        ...(record.task_id ? { taskId: record.task_id } : {}),
        allowedPaths: admitted.claims.allowedPaths,
        signal,
        ...(worktree ? { cwd: worktree } : {}),
      });
    } catch (e) {
      if (e instanceof ForerunnerError && e.code === "killed") throw e;
      if (signal.aborted)
        throw new ForerunnerError("killed", `session stopped during the merge: ${errorMessage(e)}`);
      const unreachable = e instanceof ForerunnerError && (e.retryable || e.code === "timeout");
      result = {
        content: `not merged: ${errorMessage(e)}`,
        isError: true,
        artifacts: {
          status: unreachable ? "unreachable" : "failed",
          message: errorMessage(e),
          sentence: unreachable
            ? `GitHub did not answer about ${prName(record.pr_number)}: Forerunner tries the merge again.`
            : `The merge of ${prName(record.pr_number)} failed: open it on GitHub and merge it yourself.`,
          updated: false,
        } satisfies MergePrArtifacts,
      };
    }
    await hooks.afterToolCall(ctx, tool as ToolSpec, admitted.input, {
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
    });
    return result.artifacts as unknown as MergePrArtifacts;
  }

  /**
   * What the gate may look at for this record (merge-in-app, `MergeLook`): read only when the
   * gate asks, from the host and the task's folder.
   */
  private lookFor(record: MergeRecordRow, task: TaskRow, worktree: string | null): MergeLook {
    const { host, store } = this.deps;
    const ref = parsePullUrl(record.pr_url);
    return {
      // Each look says "cannot tell" when the host does not answer (moved, has checks): the
      // gate then lets the tool look, which waits on a silent host as on a running check.
      baseChange: async () => {
        if (!ref) return "adds";
        try {
          const pr = await host.getPullRequest(ref.repo, ref.number);
          const baseHead = await host.getBranchHead(ref.repo, pr.base.ref);
          if (baseHead && record.reviewed_base_sha && baseHead === record.reviewed_base_sha)
            return "none";
          if (!worktree || !record.reviewed_head_sha) return "adds";
          // Moved: does merging it change the tree the review read? A base that moved only by
          // work the reviewed head holds (its dependency merged with a merge commit) does not.
          const token = await resolveGitToken(this.deps.token);
          const repo = await host.getRepo(ref.repo);
          const auth = token ? gitAuthFor(token, repo.cloneUrl) : undefined;
          const git = new GitOps({ cwd: worktree, ...(auth ? { auth } : {}) });
          const reviewed = record.reviewed_head_sha;
          // R-lock: never in the middle of a rebuild of the same folder.
          return await inWorktree(worktree, async () => {
            await git.fetch();
            if (!(await git.hasRef(reviewed))) return "adds";
            const base = `origin/${pr.base.ref}`;
            if ((await git.conflictFiles(reviewed, base)).length) return "conflicts";
            const combined = await git.mergeTree(reviewed, base);
            const own = await git.mergeTree(reviewed, reviewed);
            return combined && own && combined === own ? "none" : "adds";
          });
        } catch (e) {
          this.logger.warn("base not compared", { taskId: task.id, error: errorMessage(e) });
          return "adds";
        }
      },
      hasChecks: async () => {
        if (!ref || !record.reviewed_head_sha) return false;
        try {
          const onHead = await ciOf(host, ref.repo, record.reviewed_head_sha);
          if (onHead.runs.length || onHead.statuses.length) return true;
          const pr = await host.getPullRequest(ref.repo, ref.number);
          const baseHead = await host.getBranchHead(ref.repo, pr.base.ref);
          if (baseHead) {
            const onBase = await ciOf(host, ref.repo, baseHead);
            if (onBase.runs.length || onBase.statuses.length) return true;
          }
          return (await host.getBranchRules(ref.repo, pr.base.ref)).requiredChecks.length > 0;
        } catch (e) {
          this.logger.warn("checks not read", { taskId: task.id, error: errorMessage(e) });
          return true;
        }
      },
      openDependencies: async () => {
        const open: { number: number; merging: boolean }[] = [];
        for (const id of task.depends_on ?? []) {
          const dep = await store.task.get(id);
          if (!dep?.pr_url) continue;
          const depRecord = await store.mergeRecord.forTask(dep.id);
          if (depRecord?.state === "merged") continue;
          const depRef = parsePullUrl(dep.pr_url);
          if (!depRef) continue;
          // A silent host: the dependency counts as open, so nothing merges out of order.
          const pr = await host.getPullRequest(depRef.repo, depRef.number).catch(() => null);
          if (pr && (pr.state !== "open" || pr.merged)) continue;
          const merging =
            !!depRecord &&
            (depRecord.state === "queued" ||
              depRecord.state === "merging" ||
              depRecord.state === "waiting_checks");
          open.push({ number: depRef.number, merging });
        }
        return open.sort((a, b) => a.number - b.number);
      },
    };
  }

  /** Whether `head` (on the host) keeps exactly the record's reviewed change. */
  private async keepsOwnChange(
    record: MergeRecordRow,
    worktree: string,
    head: string,
  ): Promise<boolean> {
    if (!record.own_change_id) return false;
    try {
      const token = await resolveGitToken(this.deps.token);
      const ref = parsePullUrl(record.pr_url);
      const repo = ref ? await this.deps.host.getRepo(ref.repo) : null;
      const auth = token && repo ? gitAuthFor(token, repo.cloneUrl) : undefined;
      const git = new GitOps({ cwd: worktree, ...(auth ? { auth } : {}) });
      // R-lock: never in the middle of a rebuild of the same folder.
      return await inWorktree(worktree, async () => {
        await git.fetch();
        const pr = ref ? await this.deps.host.getPullRequest(ref.repo, ref.number) : null;
        if (!pr || !(await git.hasRef(head))) return false;
        return (await ownChangeId(git, `origin/${pr.base.ref}`, head)) === record.own_change_id;
      });
    } catch (e) {
      this.logger.warn("own change not read", { taskId: record.task_id, error: errorMessage(e) });
      return false;
    }
  }

  /** The tool's answer on the record, the task row, a card where the person must act. */
  private async finish(
    record: MergeRecordRow,
    task: TaskRow,
    session: SessionContext | null,
    owner: string,
    gate: Extract<MergeGate, { allowed: true }>,
    a: CallResult,
  ): Promise<MergeOutcome> {
    const { store } = this.deps;
    const prUrl = record.pr_url;
    const detail = {
      ...(a.headSha ? { headSha: a.headSha } : {}),
      ...(a.updated ? { updated: true } : {}),
      ...(a.failedChecks ? { failedChecks: a.failedChecks } : {}),
      ...(a.pendingChecks ? { pendingChecks: a.pendingChecks } : {}),
      ...(a.conflicts ? { conflicts: a.conflicts } : {}),
    };
    const current = await store.mergeRecord.mustGet(record.id);
    if (a.status === "merged" || a.alreadyMerged) {
      const mergeSha = a.mergeSha ?? null;
      const method: MergeMethod | null = a.status === "merged" ? "merge" : null;
      const done = await store.mergeRecord.move(record.id, "merged", {
        merge_sha: mergeSha,
        method,
        approval: gate.approval,
        approved_by: gate.by,
        sentence: "",
        last_outcome: "merged",
      });
      const reason =
        a.status === "merged"
          ? `merged ${prUrl}${mergeSha ? ` as ${short(mergeSha)}` : ""} after an accepting review (${gate.by})${a.updated ? ", with its base merged in first" : ""}`
          : `merged ${prUrl}: it was already merged on the host`;
      await this.writeReason(task, record.agent_id, reason);
      this.logger.info("merge record", { taskId: task.id, prUrl, state: "merged" });
      await this.merged({ task, record: done, mergeSha, method });
      return {
        taskId: task.id,
        prUrl,
        status: "merged",
        ...(mergeSha ? { mergeSha } : {}),
        ...detail,
        reason,
      };
    }
    return this.settle(current, task, session, owner, {
      taskId: task.id,
      prUrl,
      status: a.status,
      ...detail,
      reason: `PR left open for you: ${a.message}`,
      ...(a.sentence ? { sentence: a.sentence } : {}),
    });
  }

  /**
   * A merge that did not happen: the record waits (checks running, the host silent) or is left
   * to the person with its sentence; the task row says why; a card where the person must act.
   */
  private async settle(
    record: MergeRecordRow,
    task: TaskRow,
    session: SessionContext | null,
    owner: string,
    outcome: MergeOutcome,
  ): Promise<MergeOutcome> {
    const { store } = this.deps;
    const waits = outcome.status === "checks_pending" || outcome.status === "unreachable";
    const stuck = waits && record.attempts >= MAX_MERGE_ATTEMPTS;
    const to: MergeRecordState = waits && !stuck ? "waiting_checks" : "left_to_you";
    // A day of waiting says what it waited on: running checks, or GitHub not answering.
    const sentence = !stuck
      ? (outcome.sentence ?? "")
      : outcome.status === "unreachable"
        ? `GitHub has not answered about ${prName(record.pr_number)} for a day: look at it on GitHub, then merge it.`
        : `The checks of ${prName(record.pr_number)} have not finished in a day: look at them on GitHub, then merge it.`;
    const wasLeft = record.state === "left_to_you";
    let out: MergeOutcome = { ...outcome, sentence };
    try {
      await store.mergeRecord.move(record.id, to, { sentence, last_outcome: outcome.status });
    } catch (e) {
      this.logger.warn("merge record not moved", { taskId: task.id, error: errorMessage(e) });
    }
    if ((ASKS_HUMAN.has(outcome.status) || stuck) && !wasLeft) {
      const request = await fileLeftOpenRequest(store, {
        task,
        sessionId: session?.sessionId ?? null,
        humanId: owner,
        agentId: record.agent_id,
        outcome: out,
      });
      out = { ...out, humanRequestId: request.id };
    }
    await this.writeReason(task, record.agent_id, outcome.reason);
    this.logger.info("merge record", {
      taskId: task.id,
      prUrl: outcome.prUrl,
      state: to,
      status: outcome.status,
      ...(sentence ? { sentence } : {}),
    });
    return out;
  }

  private async writeReason(task: TaskRow, agentId: string, reason: string): Promise<void> {
    try {
      await this.deps.store.task.patch(task.id, {
        reason: reason.slice(0, 1000),
        author_agent: agentId,
      });
    } catch (e) {
      this.logger.warn("merge outcome not written on the task", {
        taskId: task.id,
        error: errorMessage(e),
      });
    }
  }

  /** The record as an outcome, for a caller that finds the merge already running or done. */
  private outcomeOf(record: MergeRecordRow, fallback: MergeStatus): MergeOutcome {
    return {
      taskId: record.task_id,
      prUrl: record.pr_url,
      status: record.state === "merged" ? "merged" : fallback,
      reason:
        record.state === "merged"
          ? `merged ${record.pr_url}${record.merge_sha ? ` as ${short(record.merge_sha)}` : ""}`
          : `PR left open for you: ${record.sentence || "the merge is under way"}`,
      ...(record.merge_sha ? { mergeSha: record.merge_sha } : {}),
      ...(record.sentence ? { sentence: record.sentence } : {}),
    };
  }

  /**
   * A retry's own token: `merge_pr` only, that worktree only, no budget, the PR's host only if
   * it is the git host's, a short expiry, the project's level as it is now. Never derived from
   * a session token: there is none.
   */
  private ownToken(
    record: MergeRecordRow,
    owner: string,
    project: ProjectRow | null | undefined,
    runId: string,
    worktree: string | null,
  ): SignedToken {
    const { clock, tokens } = this.deps;
    const host = hostOf(record.pr_url);
    const domains =
      host && (this.deps.allowedDomains ?? []).some((d) => d.toLowerCase() === host) ? [host] : [];
    const level = project?.autonomy_level ?? 0;
    return tokens.issue({
      runId,
      sessionId: `merge-${record.id}`,
      agentId: record.agent_id,
      ownerHumanId: owner,
      ...(record.project_id ? { projectId: record.project_id } : {}),
      // A docs pull request merged as it is (merge-in-app) has no task.
      ...(record.task_id ? { taskId: record.task_id } : {}),
      allowedTools: [MERGE_PR_TOOL],
      allowedPaths: worktree ? [worktree] : [],
      allowedDomains: domains,
      grantedSecrets: [],
      budgetUsdMicro: 0,
      depth: 0,
      maxDepth: 0,
      autonomy: (level >= 0 && level <= 4 ? level : 0) as 0 | 1 | 2 | 3 | 4,
      planApproved: false,
      expiresAt: new Date(clock.now() + RETRY_TOKEN_MS).toISOString(),
    });
  }

  /** The human an agent acts for (the record's owner). */
  private async ownerOf(agentId: string): Promise<string> {
    return (await this.deps.store.agent.get(agentId))?.owner_human_id ?? "";
  }

  /** `origin/<base>` of the PR's base branch, as the worktree's remote has it. */
  private async baseRefOf(git: GitOps, prUrl: string): Promise<string | null> {
    const ref = parsePullUrl(prUrl);
    if (!ref) return null;
    try {
      const pr = await this.deps.host.getPullRequest(ref.repo, ref.number);
      return `origin/${pr.base.ref}`;
    } catch {
      try {
        return `origin/${await git.remoteDefaultBranch()}`;
      } catch {
        return null;
      }
    }
  }

  /**
   * TM-4: a merge that waits for a rebuild its branch owes says why when the task's folder
   * holds changes nobody committed (the rebuild never sweeps them in, so it waits until the
   * person puts them away): `OWED_FOLDER_CHANGES` with `owedFolderSentence`. A folder that is
   * clean again takes the words back; a busy one (a run, a rebuild) leaves them as they are.
   * Nothing here lets the merge go on: the record still owes the rebuild (R-lock).
   */
  private async sayOwedWait(
    record: MergeRecordRow,
    worktree: string | null,
  ): Promise<MergeRecordRow> {
    if (!worktree) return record;
    try {
      const dirty = await tryWorktree(
        worktree,
        async () => (await new GitOps({ cwd: worktree }).status()).dirty,
      );
      if (dirty === null) return record;
      if (dirty && record.last_outcome !== OWED_FOLDER_CHANGES)
        return await this.deps.store.mergeRecord.move(record.id, record.state, {
          last_outcome: OWED_FOLDER_CHANGES,
          sentence: owedFolderSentence(record.pr_number),
        });
      if (!dirty && record.last_outcome === OWED_FOLDER_CHANGES)
        return await this.deps.store.mergeRecord.move(record.id, record.state, {
          last_outcome: "rebuild_owed",
          sentence: "",
        });
    } catch (e) {
      this.logger.warn("task folder not read for an owed rebuild", {
        taskId: record.task_id,
        error: errorMessage(e),
      });
    }
    return record;
  }

  private worktreeOf(task: TaskRow): string | null {
    if (!this.deps.worktreeRoot) return null;
    const dir = join(this.deps.worktreeRoot, safeSegment(task.id));
    return existsSync(join(dir, ".git")) ? dir : null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The Update for a merge the app made by itself (R-mergeretry): one line, the pull request and
 * the task's title (design section 5). Polish owns the wording.
 */
export function mergedUpdateWords(prNumber: number, title: string): string {
  return `Merged ${prName(prNumber)}: "${title.replace(/\s+/g, " ").trim()}".`;
}

export const MERGE_LEFT_OPEN_KEY = "merge:left_open";
export const MERGE_LEFT_OPEN_OPTIONS = ["I merged it", "Leave it open"] as const;
/**
 * The options of the card a dependent branch's rebuild files (R-rebuildcard, leftovers7-merge):
 * the pull request is still open, so "I merged it" would note a merge that did not happen.
 * A rebuild that kept the task's work (rebuilt without what it built on, or onto main) offers
 * Merge (as the Overview's Merge: the person's approval, through the merge step) and Redo (the
 * task is done again from main, in a session); one that conflicted offers Redo and Leave it open.
 */
export const REBUILD_CARD_OPTIONS = {
  rebuilt: ["Merge", "Redo"],
  conflict: ["Redo", "Leave it open"],
} as const;

/**
 * The request for a reviewed PR the merge step left open (U-028). Its card carries
 * `MERGE_LEFT_OPEN_KEY`, so `syncPrAnswers` (`session/pr-answers.ts`, from the daemon's
 * `syncApprovals`) applies the answer: "I merged it" records the merge on the task (its
 * `reason` names the PR and the person; the task stays `done`, which is where an accepted task
 * is), "Leave it open" records that the person keeps it open.
 */
export async function fileLeftOpenRequest(
  store: Pick<StateStore, "humanRequest">,
  input: {
    task: TaskRow;
    sessionId: string | null;
    humanId: string;
    agentId: string;
    outcome: MergeOutcome;
    /** More of the card's fields (dependent-branches: `rebuild`, what a rebuild did). */
    card?: JsonObject;
    /** Its options (a rebuild's card: `REBUILD_CARD_OPTIONS`); else `MERGE_LEFT_OPEN_OPTIONS`. */
    options?: readonly string[];
  },
): Promise<HumanRequestRow> {
  const { task, outcome } = input;
  const number = parsePullUrl(outcome.prUrl)?.number;
  const pr = number ? `pull request #${number}` : "its pull request";
  // What the person reads (ADR 0111): the record's sentence, never the step's own message
  // (commit ids, the host's words); a card filed without one says the message plainly.
  const sentence = outcome.sentence?.trim() || leftOpenFallback(outcome.reason);
  return store.humanRequest.insert({
    human_id: input.humanId,
    project_id: task.project_id,
    task_id: task.id,
    session_id: input.sessionId,
    kind: "decision",
    why: `The critic accepted "${task.title}", but ${pr} was not merged. ${sentence}`.slice(
      0,
      4000,
    ),
    steps: STEPS[outcome.status] ?? [],
    options: [...(input.options ?? MERGE_LEFT_OPEN_OPTIONS)],
    blocking: false,
    risk: "medium",
    change_card: {
      ...(input.card ?? {}),
      key: MERGE_LEFT_OPEN_KEY,
      task_id: task.id,
      pr_url: outcome.prUrl,
      status: outcome.status,
      sentence,
      applied_at: null,
    },
    author_agent: input.agentId,
  });
}

/** "It was left open: check ci/test failed." for an outcome with no sentence of its own. */
function leftOpenFallback(reason: string): string {
  const said = reason
    .replace(/^PR left open for you:\s*/i, "")
    .replace(/https?:\/\/\S+/g, "it")
    .replace(/[.\s]+$/, "")
    .trim();
  return said ? `It was left open: ${said}.` : "It was left open for you to merge.";
}

/**
 * Outcomes the person hears about as a request, once per record: what needs them to act. The
 * level's refusal (`not_allowed`) is the level's normal course and says so on the record only;
 * running checks wait on the record and the retry finishes them.
 */
const ASKS_HUMAN: ReadonlySet<MergeStatus> = new Set<MergeStatus>([
  "checks_failed",
  "conflict",
  "head_moved",
  "blocked_by_rules",
  "merge_commits_off",
  "failed",
]);

const STEPS: Partial<Record<MergeStatus, string[]>> = {
  checks_failed: ["Open the failed check on the pull request", "Fix it or merge it yourself"],
  checks_pending: ["Look at the checks on the pull request", "Merge it once they pass"],
  conflict: ["Resolve the conflict on the PR branch", "Merge the pull request"],
  head_moved: [
    "Look at the commits pushed after the review",
    "Merge it yourself or ask for a new review",
  ],
  blocked_by_rules: ["Open the pull request on GitHub", "Merge it once its rules are met"],
  merge_commits_off: [
    "Merge the pull request on GitHub",
    "Or allow merge commits in the repository's settings",
  ],
  failed: ["Open the pull request", "Merge it yourself or leave it open"],
};

/**
 * The Details of a left-open card for this outcome (`fileLeftOpenRequest`'s steps). A card whose
 * words change later (dependent-branches: a conflict notice, then a head that moved) takes the
 * steps of what it says now.
 */
export function leftOpenSteps(status: MergeStatus): string[] {
  return [...(STEPS[status] ?? [])];
}
