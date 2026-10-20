import { existsSync, mkdirSync } from "node:fs";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  join,
  log,
  safeSegment,
} from "@forerunner/platform";
import type {
  PlanItem,
  SessionBudget,
  SignedToken,
  TaskExecutionResult,
  TaskExecutor,
} from "@forerunner/runtime";
import type { SessionRow, StateStore, TaskRow } from "@forerunner/state";
import { GitOps } from "./git.ts";
import type { GitHost, RepoRef } from "./types.ts";

/**
 * Branch-and-PR flow around a task executor (spec F: code changes only via branches and PRs,
 * rebase before PR, conflicts the agent cannot resolve become a human request).
 *
 * 1. Clone the project repository into a per-task worktree (or reuse it).
 * 2. Create the task branch, run the inner executor with `worktree` pointing at it.
 * 3. Commit everything, fetch, rebase onto the base branch; on conflict: needs_human.
 * 4. Push and open (or update) a pull request; record its URL on the task.
 */
export interface PrTaskExecutorDeps {
  store: StateStore;
  clock: Clock;
  host: GitHost;
  /** Inner executor that does the work inside the worktree. */
  inner: TaskExecutor & { withWorktree?: (dir: string) => TaskExecutor };
  /** Resolves a project's repository: clone URL, owner/name, base branch. */
  repoFor: (task: TaskRow) => Promise<{ clone: string; repo: RepoRef; base: string } | null>;
  worktreeRoot: string;
  token?: string;
  identity?: { name: string; email: string };
  /** Branch naming; default fr/<task-id-prefix>-<slug>. */
  branchFor?: (task: TaskRow) => string;
}

export class PrTaskExecutor implements TaskExecutor {
  private readonly logger = log("pr-executor");

  constructor(private readonly deps: PrTaskExecutorDeps) {}

  async execute(ctx: {
    task: TaskRow;
    session: SessionRow;
    token: SignedToken;
    budget: SessionBudget;
    item: PlanItem;
    signal: AbortSignal;
  }): Promise<TaskExecutionResult> {
    const { task } = ctx;
    const target = await this.deps.repoFor(task);
    if (!target) {
      // Tasks without a repository (research, docs elsewhere) run the inner executor as is.
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
      auth: this.deps.token ? { token: this.deps.token } : undefined,
      identity: this.deps.identity,
    });
    if (existsSync(join(dir, ".git"))) await git.fetch();
    else await git.clone(target.clone);
    const existingPr = (
      await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch })
    )[0];
    await git.createBranch(branch, existingPr ? `origin/${branch}` : `origin/${target.base}`);
    if (!task.branch) await this.deps.store.task.patch(task.id, { branch });

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
    const rebase = await git.rebaseOnto(`origin/${target.base}`);
    if (!rebase.ok) {
      await this.deps.store.humanRequest.insert({
        human_id: ctx.token.claims.ownerHumanId,
        project_id: task.project_id,
        task_id: task.id,
        session_id: ctx.session.id,
        kind: "decision",
        why: `Rebase of ${branch} onto ${target.base} conflicts in ${rebase.conflicts.join(", ")}; the agent could not resolve it.`,
        steps: [
          `Resolve the conflict in ${branch}`,
          "Push the branch",
          "Set the task back to ready",
        ],
        options: ["I resolved it", "Drop the branch and retry from scratch", "Cancel the task"],
        blocking: true,
        risk: "medium",
        author_agent: ctx.session.agent_id,
      });
      return {
        outcome: "needs_human",
        summary: `rebase conflict in ${rebase.conflicts.join(", ")}`,
        costUsdMicro: result.costUsdMicro,
        branch,
      };
    }
    let changedFiles: string[] = [];
    try {
      changedFiles = await git.changedFiles(`origin/${target.base}`);
    } catch {
      // the diff is informational (peer overlap detection); never fail the PR for it
    }
    try {
      await git.push(branch, { force: !!existingPr, defaultBranch: target.base });
    } catch (e) {
      return {
        outcome: "failed",
        summary: `push failed: ${errorMessage(e)}`,
        costUsdMicro: result.costUsdMicro,
        branch,
      };
    }
    let prUrl = existingPr?.htmlUrl;
    if (!existingPr) {
      const pr = await this.deps.host.createPullRequest(target.repo, {
        title: task.title,
        body: `${task.outcome}\n\nAcceptance criteria:\n${task.acceptance_criteria.map((c: string) => `- ${c}`).join("\n")}\n\n${result.summary.slice(0, 2000)}\n\nTask ${task.id}, session ${ctx.session.id}. Opened by Forerunner.`,
        head: branch,
        base: target.base,
      });
      prUrl = pr.htmlUrl;
    } else {
      await this.deps.host.commentOnPullRequest(
        target.repo,
        existingPr.number,
        `Updated by session ${ctx.session.id}: ${result.summary.slice(0, 500)}`,
      );
    }
    this.logger.info("pull request ready", { taskId: task.id, branch, prUrl });
    return { ...result, outcome: "in_review", prUrl, branch, changedFiles };
  }
}

export function requireRepo(e: unknown): never {
  throw new ForerunnerError("validation", `project has no repository: ${errorMessage(e)}`);
}
