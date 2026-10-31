import { existsSync, mkdirSync } from "node:fs";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  join,
  log,
  safeSegment,
} from "@forerunner/platform";
import type { TaskExecutionResult, TaskExecutor } from "@forerunner/runtime";
import type {
  HumanRequestRow,
  JsonObject,
  JsonValue,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import { GitOps, gitAuthFor } from "./git.ts";
import type { GitHost, RepoRef } from "./types.ts";

/**
 * Branch-and-PR flow around a task executor (spec F: code changes only via branches and PRs,
 * rebase before PR, conflicts the agent cannot resolve become a human request).
 *
 * 1. Clone the project repository into a per-task worktree (or reuse it).
 * 2. Create the task branch, run the inner executor with `worktree` pointing at it.
 * 3. Commit everything, fetch, rebase onto the base branch; on conflict the branch is pushed
 *    as it is (so the person can resolve it) and a blocking request asks the person (U-028).
 * 4. Push and open (or update) a pull request; record its URL on the task.
 *
 * The conflict request's options each lead somewhere (the runtime's `syncPrAnswers` applies
 * the answer, the next run of the task reads it from the request's card):
 *
 *   "I resolved it" -> the task goes back to `ready`; its next run takes the branch the person
 *       pushed (else the worktree's), checks it against the base (rebasing when the base is not
 *       in it yet; a conflict that is still there files a new request), pushes it and opens the
 *       pull request. The inner executor is not run again: the work is done.
 *   "Drop the branch and retry from scratch" -> the task goes back to `ready`; its next run
 *       starts the branch again from the current base, runs the inner executor and replaces
 *       the old branch on the host.
 *   "Cancel the task" -> the task is cancelled.
 */
export const REBASE_CONFLICT_KEY = "githost:rebase_conflict";
export const REBASE_CONFLICT_OPTIONS = [
  "I resolved it",
  "Drop the branch and retry from scratch",
  "Cancel the task",
] as const;
export type RebaseConflictAnswer = "resolved" | "drop" | "cancel";
/** The card's `outcome` once the runtime applied the answer; the next run reads the first two. */
export type RebaseConflictOutcome = "resolved" | "dropped" | "cancelled";

/** The answer of a rebase conflict request as one of its options, or null. */
export function rebaseConflictAnswer(answer: JsonValue | null): RebaseConflictAnswer | null {
  const v = answerText(answer);
  if (v === null) return null;
  const [resolved, drop, cancel] = REBASE_CONFLICT_OPTIONS.map((o) => o.toLowerCase());
  if (v === resolved || /^(resolved|i resolved|fixed|i fixed it)$/.test(v)) return "resolved";
  if (v === drop || /^(drop|drop the branch|retry|retry from scratch)$/.test(v)) return "drop";
  if (v === cancel || /^(cancel|cancelled|canceled)$/.test(v)) return "cancel";
  return null;
}

/** Whether a request is a rebase conflict request (its card key, or the options of one filed before the key). */
export function isRebaseConflictRequest(
  row: Pick<HumanRequestRow, "kind" | "task_id" | "options" | "change_card">,
): boolean {
  if (row.kind !== "decision" || !row.task_id) return false;
  const key = (row.change_card as JsonObject | null)?.key;
  if (typeof key === "string") return key === REBASE_CONFLICT_KEY;
  return (
    row.options.length === REBASE_CONFLICT_OPTIONS.length &&
    REBASE_CONFLICT_OPTIONS.every((o, i) => row.options[i] === o)
  );
}

/** The string of an inbox answer (the text itself, or an object's `choice` / `answer`), normalised. */
function answerText(answer: JsonValue | null): string | null {
  const raw =
    typeof answer === "string"
      ? answer
      : answer && typeof answer === "object" && !Array.isArray(answer)
        ? ((answer as JsonObject).choice ?? (answer as JsonObject).answer)
        : null;
  if (typeof raw !== "string") return null;
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface PrTaskExecutorDeps {
  store: StateStore;
  clock: Clock;
  host: GitHost;
  /** Inner executor that does the work inside the worktree. */
  inner: TaskExecutor & { withWorktree?: (dir: string) => TaskExecutor };
  /** Resolves a project's repository: clone URL, owner/name, base branch. */
  repoFor: (task: TaskRow) => Promise<{ clone: string; repo: RepoRef; base: string } | null>;
  /**
   * The folder a task of a project without a repository works in (U-037): the project's
   * workspace, `<data>/projects/<id>/workspace`, where the intake writes its docs. Null (or
   * absent) runs the inner executor with no folder, as before.
   */
  workspaceFor?: (task: TaskRow) => Promise<string | null>;
  worktreeRoot: string;
  token?: string;
  identity?: { name: string; email: string };
  /** Branch naming; default fr/<task-id-prefix>-<slug>. */
  branchFor?: (task: TaskRow) => string;
}

type ExecuteCtx = Parameters<TaskExecutor["execute"]>[0];
type Target = { clone: string; repo: RepoRef; base: string };

/** The person's answer to the task's last rebase conflict, not yet used by a run. */
interface ConflictAnswer {
  row: HumanRequestRow;
  outcome: "resolved" | "dropped";
}

export class PrTaskExecutor implements TaskExecutor {
  private readonly logger = log("pr-executor");

  constructor(private readonly deps: PrTaskExecutorDeps) {}

  async execute(ctx: ExecuteCtx): Promise<TaskExecutionResult> {
    const { task } = ctx;
    const target = await this.deps.repoFor(task);
    if (!target) {
      const workspace = (await this.deps.workspaceFor?.(task)) ?? null;
      if (workspace) return this.inWorkspace(ctx, workspace);
      // Tasks without a repository or a workspace run the inner executor as is.
      return this.deps.inner.execute(ctx);
    }
    const branch =
      task.branch ||
      this.deps.branchFor?.(task) ||
      `fr/${task.id.slice(0, 8)}-${safeSegment(task.title.toLowerCase(), "task").slice(0, 40)}`;
    const dir = join(this.deps.worktreeRoot, safeSegment(task.id));
    mkdirSync(this.deps.worktreeRoot, { recursive: true });
    const git = new GitOps({
      cwd: dir,
      // Scoped to the clone URL's origin; a local path or SSH remote gets no header.
      auth: gitAuthFor(this.deps.token, target.clone),
      identity: this.deps.identity,
    });
    if (existsSync(join(dir, ".git"))) await git.fetch();
    else await git.clone(target.clone);
    if (!task.branch) await this.deps.store.task.patch(task.id, { branch });
    const answered = await this.conflictAnswer(task);
    if (answered?.outcome === "resolved")
      return this.continueResolved(ctx, { git, dir, branch, target, answered });
    const dropped = answered?.outcome === "dropped";
    const existingPr = (
      await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch })
    )[0];
    // "Drop the branch and retry from scratch": the branch starts again from the base, even
    // when a pull request already carries it (the PR then gets the new work).
    await git.createBranch(
      branch,
      existingPr && !dropped ? `origin/${branch}` : `origin/${target.base}`,
    );

    const inner = this.deps.inner.withWorktree
      ? this.deps.inner.withWorktree(dir)
      : this.deps.inner;
    const result = await inner.execute({ ...ctx, task: { ...task, branch } });
    if (result.outcome !== "done" && result.outcome !== "in_review") return result;

    const commit = await git.commitAll(
      `${task.title}\n\nTask ${task.id}. ${result.summary.slice(0, 500)}`,
    );
    if (!commit.committed && !existingPr) {
      return {
        ...result,
        outcome: "failed",
        summary: `${result.summary}\n(no changes were made in the worktree)`,
        checksPassed: false,
      };
    }
    await git.fetch();
    // A branch the host still has from before the drop is replaced, never built on.
    const replace = dropped && (await git.hasRef(`origin/${branch}`));
    const rebase = await git.rebaseOnto(`origin/${target.base}`);
    if (!rebase.ok) {
      return this.conflict(ctx, {
        git,
        dir,
        branch,
        target,
        conflicts: rebase.conflicts,
        costUsdMicro: result.costUsdMicro,
        force: replace,
        superseded: answered?.row ?? null,
      });
    }
    let changedFiles: string[] = [];
    try {
      changedFiles = await git.changedFiles(`origin/${target.base}`);
    } catch {
      // the diff is informational (peer overlap detection); never fail the PR for it
    }
    try {
      await git.push(branch, { force: !!existingPr || replace, defaultBranch: target.base });
    } catch (e) {
      return {
        outcome: "failed",
        summary: `push failed: ${errorMessage(e)}`,
        costUsdMicro: result.costUsdMicro,
        branch,
      };
    }
    const prUrl = await this.openOrUpdatePr(ctx, target, branch, existingPr, result.summary);
    if (answered) await this.consume(answered.row);
    this.logger.info("pull request ready", { taskId: task.id, branch, prUrl });
    return { ...result, outcome: "in_review", prUrl, branch, changedFiles };
  }

  /**
   * A task of a project without a repository (U-037): the specialist works in the project's
   * workspace folder, which the run's token allows to read and write. The folder is kept as a
   * local git repository so the critic can review the change set: what was there before the
   * run is committed as the baseline ("Workspace before ..."), and what the run changed is staged
   * afterwards, so the critic's diff (`git diff HEAD` in the worktree it is given) shows exactly
   * this run's change, new files included, and the result names the changed files. Before
   * U-037 such a run had no folder: every read and write was refused on the loop driver, and on
   * the Agent SDK driver it worked in an empty folder of its own that nothing read afterwards.
   */
  private async inWorkspace(ctx: ExecuteCtx, dir: string): Promise<TaskExecutionResult> {
    const { task } = ctx;
    mkdirSync(dir, { recursive: true });
    const git = new GitOps({ cwd: dir, identity: this.deps.identity });
    if (!existsSync(join(dir, ".git"))) await git.init("main");
    const before = `Workspace before "${task.title}" (task ${task.id})`;
    await git.commitAll(before, { allowEmpty: !(await git.hasCommits()) });
    const inner = this.deps.inner.withWorktree
      ? this.deps.inner.withWorktree(dir)
      : this.deps.inner;
    const result = await inner.execute(ctx);
    let changedFiles: string[] = [];
    try {
      await git.stageAll();
      changedFiles = await git.stagedFiles();
    } catch (e) {
      // The change set is evidence for the critic; a git failure here never fails the work.
      this.logger.warn("workspace change set not read", {
        taskId: task.id,
        error: errorMessage(e),
      });
    }
    return { ...result, worktree: dir, ...(changedFiles.length ? { changedFiles } : {}) };
  }

  /**
   * "I resolved it": the branch the person pushed (else the worktree's) is checked against
   * the base and goes on to its pull request, without running the inner executor again. A
   * base that is not in the branch yet is rebased onto; a conflict that is still there files
   * a new request. A branch that is gone everywhere fails the task with what to do.
   */
  private async continueResolved(
    ctx: ExecuteCtx,
    s: { git: GitOps; dir: string; branch: string; target: Target; answered: ConflictAnswer },
  ): Promise<TaskExecutionResult> {
    const { git, dir, branch, target, answered } = s;
    const remote = await git.hasRef(`origin/${branch}`);
    if (remote) await git.createBranch(branch, `origin/${branch}`);
    else if (await git.hasRef(`refs/heads/${branch}`)) await git.checkout(branch);
    else {
      await this.consume(answered.row);
      return {
        outcome: "failed",
        summary: `the branch ${branch} you resolved is neither on ${target.repo.owner}/${target.repo.name} nor in the task worktree; push it and set the task back to ready, or let the agent redo the task from ${target.base}`,
        costUsdMicro: 0,
        branch,
      };
    }
    let rebased = false;
    if (!(await git.isAncestor(`origin/${target.base}`))) {
      const rebase = await git.rebaseOnto(`origin/${target.base}`);
      if (!rebase.ok) {
        return this.conflict(ctx, {
          git,
          dir,
          branch,
          target,
          conflicts: rebase.conflicts,
          costUsdMicro: 0,
          force: false,
          superseded: answered.row,
          again: true,
        });
      }
      rebased = true;
    }
    let changedFiles: string[] = [];
    try {
      changedFiles = await git.changedFiles(`origin/${target.base}`);
    } catch {
      // informational, as above
    }
    if (rebased || !remote) {
      try {
        await git.push(branch, { force: rebased && remote, defaultBranch: target.base });
      } catch (e) {
        return {
          outcome: "failed",
          summary: `push failed: ${errorMessage(e)}`,
          costUsdMicro: 0,
          branch,
        };
      }
    }
    const existingPr = (
      await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch })
    )[0];
    const summary = `You resolved the rebase conflict of ${branch}; the branch was checked against ${target.base}${rebased ? " (rebased onto it)" : ""} and goes to review.`;
    const prUrl = await this.openOrUpdatePr(ctx, target, branch, existingPr, summary);
    await this.consume(answered.row);
    this.logger.info("pull request ready after the person resolved the conflict", {
      taskId: ctx.task.id,
      branch,
      prUrl,
    });
    return {
      outcome: "in_review",
      summary,
      costUsdMicro: 0,
      prUrl,
      branch,
      changedFiles,
      worktree: dir,
    };
  }

  /**
   * A conflict the agent cannot resolve: the branch is pushed as it is, so the person can
   * fetch and resolve it (the worktree is named when the push fails), and one blocking request
   * asks them. A request this run answered (an earlier conflict) is marked used.
   */
  private async conflict(
    ctx: ExecuteCtx,
    c: {
      git: GitOps;
      dir: string;
      branch: string;
      target: Target;
      conflicts: string[];
      costUsdMicro: number;
      force: boolean;
      superseded: HumanRequestRow | null;
      again?: boolean;
    },
  ): Promise<TaskExecutionResult> {
    const { task } = ctx;
    const { branch, target, conflicts } = c;
    const repoName = `${target.repo.owner}/${target.repo.name}`;
    let pushed = true;
    try {
      await c.git.push(branch, { force: c.force, defaultBranch: target.base });
    } catch (e) {
      pushed = false;
      this.logger.warn("conflicting branch not pushed", {
        taskId: task.id,
        error: errorMessage(e),
      });
    }
    if (c.superseded) await this.consume(c.superseded);
    const files = conflicts.length ? conflicts.join(", ") : "the conflicting files";
    await this.deps.store.humanRequest.insert({
      human_id: ctx.token.claims.ownerHumanId,
      project_id: task.project_id,
      task_id: task.id,
      session_id: ctx.session.id,
      kind: "decision",
      why: `${c.again ? `The branch ${branch} still conflicts with ${target.base}` : `Rebase of ${branch} onto ${target.base} conflicts`} in ${files}; the agent could not resolve it. Resolve it yourself, let the agent redo the task from ${target.base}, or cancel the task.`,
      steps: pushed
        ? [
            `Fetch ${branch} from ${repoName} and bring ${target.base} into it (rebase onto ${target.base} or merge ${target.base}), resolving ${files}`,
            `Push ${branch} to ${repoName}`,
            `Answer "I resolved it": the agent checks the branch against ${target.base} and opens the pull request`,
          ]
        : [
            `The branch ${branch} is only on this computer, in ${c.dir}: resolve ${files} there (rebase onto origin/${target.base} or merge it) and commit`,
            `Push ${branch} to ${repoName} if you can`,
            `Answer "I resolved it": the agent checks the branch against ${target.base} and opens the pull request`,
          ],
      options: [...REBASE_CONFLICT_OPTIONS],
      blocking: true,
      risk: "medium",
      change_card: {
        key: REBASE_CONFLICT_KEY,
        task_id: task.id,
        branch,
        base: target.base,
        repo: repoName,
        conflicts,
        pushed,
        applied_at: null,
      },
      author_agent: ctx.session.agent_id,
    });
    return {
      outcome: "needs_human",
      summary: `rebase conflict in ${conflicts.join(", ")}`,
      costUsdMicro: c.costUsdMicro,
      branch,
    };
  }

  /** The task's last rebase conflict request, when its answer was applied and no run used it. */
  private async conflictAnswer(task: TaskRow): Promise<ConflictAnswer | null> {
    const rows = await this.deps.store.humanRequest.list({ task_id: task.id } as never, {
      orderBy: [
        { column: "created_at", direction: "desc" },
        { column: "id", direction: "desc" },
      ],
      limit: 50,
    });
    const last = rows.find((r) => isRebaseConflictRequest(r));
    const card = (last?.change_card ?? null) as JsonObject | null;
    if (!last || !card || card.consumed_at) return null;
    return card.outcome === "resolved" || card.outcome === "dropped"
      ? { row: last, outcome: card.outcome }
      : null;
  }

  /** Marks the answer used by a run, so the run after it starts normally. */
  private async consume(row: HumanRequestRow): Promise<void> {
    const fresh = (await this.deps.store.humanRequest.get(row.id)) ?? row;
    await this.deps.store.humanRequest.patch(fresh.id, {
      change_card: {
        ...((fresh.change_card ?? {}) as JsonObject),
        consumed_at: this.deps.clock.nowIso(),
      },
    });
  }

  private async openOrUpdatePr(
    ctx: ExecuteCtx,
    target: Target,
    branch: string,
    existingPr: { number: number; htmlUrl: string } | undefined,
    summary: string,
  ): Promise<string> {
    const { task } = ctx;
    if (existingPr) {
      await this.deps.host.commentOnPullRequest(
        target.repo,
        existingPr.number,
        `Updated by session ${ctx.session.id}: ${summary.slice(0, 500)}`,
      );
      return existingPr.htmlUrl;
    }
    const pr = await this.deps.host.createPullRequest(target.repo, {
      title: task.title,
      body: `${task.outcome}\n\nAcceptance criteria:\n${task.acceptance_criteria.map((c: string) => `- ${c}`).join("\n")}\n\n${summary.slice(0, 2000)}\n\nTask ${task.id}, session ${ctx.session.id}. Opened by Forerunner.`,
      head: branch,
      base: target.base,
    });
    return pr.htmlUrl;
  }
}

export function requireRepo(e: unknown): never {
  throw new ForerunnerError("validation", `project has no repository: ${errorMessage(e)}`);
}
