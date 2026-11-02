import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { ensureBaseBranch } from "./base-branch.ts";
import { GitOps, type GitTokenSource, gitAuthFor, resolveGitToken } from "./git.ts";
import { pushFailedWords } from "./push-words.ts";
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
  /** The person's token, or a function that reads it for each task (U-082). */
  token?: GitTokenSource;
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

/**
 * The commit a task's own work starts from when it builds on unmerged work (C-49, ADR 0106):
 * the default branch with the branches of the done tasks it waits for whose pull requests are
 * not merged yet. Kept in the task's worktree; the critic's diff and the task's changed files
 * are measured from it, so the dependencies' work is never taken for the task's. Absent when
 * the task builds on the default branch alone (the diff is then the branch's own).
 */
export const DEPS_BASE_REF = "refs/forerunner/deps-base";

/** A done task this task waits for whose pull request is still open on the host. */
export interface UnmergedDependency {
  taskId: string;
  title: string;
  branch: string;
  number: number;
  url: string;
}

/** '#1 ("A") and #2 ("B")': the pull requests a task's own builds on, for its PR's words. */
export function pullRequestsText(deps: readonly UnmergedDependency[]): string {
  const each = deps.map((d) => `#${d.number} ("${d.title.replace(/\s+/g, " ").trim()}")`);
  return each.length <= 1
    ? (each[0] ?? "")
    : `${each.slice(0, -1).join(", ")} and ${each[each.length - 1]}`;
}

/**
 * What a pull request that carries unmerged work says about it (C-49): which pull requests it
 * builds on, and that merging it merges their changes too, so the person can merge in any order.
 */
export function buildsOnText(deps: readonly UnmergedDependency[]): string {
  if (!deps.length) return "";
  const one = deps.length === 1;
  return `Builds on ${pullRequestsText(deps)}, not merged yet: this pull request includes ${one ? "its" : "their"} changes, so merging it merges ${one ? "them" : "theirs"} too. Merge in any order.`;
}

/** A model's report as plain text for a commit message: no markdown marks, no lesson lines. */
export function plainReport(text: string): string {
  return withoutLessons(text)
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\*\*/g, ""),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A report without the specialist's "Lesson: ..." lines: they are notes for Forerunner's memory
 * (recorded at session end), not part of what a pull request or a commit says (L-19).
 */
export function withoutLessons(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*(?:[-*]\s+)?(?:\*\*)?lessons?:/i.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The message of the merge that brings what moved into a branch that builds on unmerged work. */
function mergeMessage(unmerged: readonly UnmergedDependency[], base: string): string {
  return unmerged.length
    ? `Bring in ${base} and the work it builds on (${unmerged.map((d) => `#${d.number}`).join(", ")})`
    : `Bring in ${base}`;
}

/** Up to three file names, then "and N more" (design §5 rule 5). */
function filesText(files: readonly string[]): string {
  if (!files.length) return "the same files";
  const shown = files.slice(0, 3);
  const more = files.length - shown.length;
  const list =
    shown.length === 1
      ? (shown[0] ?? "")
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return more > 0 ? `${list} and ${more} more` : list;
}

/**
 * Why a task that builds on unmerged work cannot start (C-49), for its card: which pull
 * requests conflict, where, and what the person does. Two sentences (design §5).
 */
export function dependencyConflictWords(
  dep: Pick<UnmergedDependency, "title" | "number">,
  before: readonly Pick<UnmergedDependency, "title" | "number">[],
  conflicts: readonly string[],
  base: string,
): string {
  const name = (d: Pick<UnmergedDependency, "title" | "number">) =>
    `"${d.title.replace(/\s+/g, " ").trim()}" (pull request #${d.number})`;
  if (!before.length)
    return `The work it builds on, ${name(dep)}, conflicts with ${base} in ${filesText(conflicts)}. Resolve that pull request on GitHub, then press Try again.`;
  const names = [dep, ...before.slice(-2)].map(name);
  const who =
    names.length === 2
      ? `${names[0]} and ${names[1]} both change`
      : `${names[0]}, ${names[1]} and ${names[2]} all change`;
  return `The work it builds on conflicts: ${who} ${filesText(conflicts)}. Merge them on GitHub, resolving the conflict, then press Try again.`;
}

/** The identity of a workspace's baseline commits when the executor is given none (U-037). */
export const WORKSPACE_IDENTITY = { name: "Forerunner", email: "forerunner@localhost" } as const;

/** Where a cancelled task's changes are kept until Undo brings them back (`setAside`). */
export function setAsideRef(taskId: string): string {
  return `refs/forerunner/set-aside/${safeSegment(taskId)}`;
}

/**
 * What a project's folder never takes into its history: caches and installs a specialist's
 * command leaves behind (live, 2026-11-02: `__pycache__/*.pyc` was staged into the project).
 */
export const WORKSPACE_GITIGNORE = [
  "# Written by Forerunner: files a command leaves behind, kept out of the folder's history.",
  "__pycache__/",
  "*.pyc",
  "node_modules/",
  ".venv/",
  ".pytest_cache/",
  ".DS_Store",
  "Thumbs.db",
  "",
].join("\n");

/** A `.gitignore` in a project's folder when it has none; one it has is never changed. */
export function ensureWorkspaceGitignore(dir: string): boolean {
  const file = join(dir, ".gitignore");
  if (existsSync(file)) return false;
  writeFileSync(file, WORKSPACE_GITIGNORE, "utf8");
  return true;
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
    const auth = gitAuthFor(await resolveGitToken(this.deps.token), target.clone);
    const git = new GitOps({
      cwd: dir,
      // Scoped to the clone URL's origin; a local path or SSH remote gets no header.
      auth,
      identity: this.deps.identity,
    });
    if (existsSync(join(dir, ".git"))) await git.fetch();
    else await git.clone(target.clone);
    // An empty repository (just created on GitHub) gets its first commit, a README with the
    // project's name and goal, so the task has a branch to start from (ADR 0106).
    await ensureBaseBranch({
      git,
      cloneUrl: target.clone,
      base: target.base,
      repoName: `${target.repo.owner}/${target.repo.name}`,
      scratchDir: join(this.deps.worktreeRoot, "first-commit", safeSegment(task.id)),
      ...(auth ? { auth } : {}),
      ...(this.deps.identity ? { identity: this.deps.identity } : {}),
      first: async (scratch) => {
        const project = await this.deps.store.project.get(task.project_id);
        writeFileSync(
          join(scratch, "README.md"),
          `# ${project?.name ?? target.repo.name}\n\n${project?.goal ?? ""}\n`,
          "utf8",
        );
        return "Start the repository with a README\n\nThe repository was empty; Forerunner made this first commit so its tasks have a branch to start from.";
      },
    });
    if (!task.branch) await this.deps.store.task.patch(task.id, { branch });
    const answered = await this.conflictAnswer(task);
    if (answered?.outcome === "resolved")
      return this.continueResolved(ctx, { git, dir, branch, target, answered });
    const dropped = answered?.outcome === "dropped";
    const existingPr = (
      await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch })
    )[0];
    const resume = !!existingPr && !dropped;
    // C-49 (ADR 0106): the done tasks this one waits for whose pull requests are not merged
    // yet. Their branches are merged into this task's before it runs, so it sees their work;
    // its own pull request still targets the default branch.
    const unmerged = await this.unmergedDependencies(task, target);
    // A branch that brought earlier work in by merging is kept up to date by merging too (a
    // rebase would copy that work into the branch as new commits).
    const merging =
      unmerged.length > 0 ||
      (resume &&
        (await git.hasRef(`origin/${branch}`)) &&
        (await git.hasMergesSince(`origin/${target.base}`, `origin/${branch}`)));
    let depsBase: string | null = null;
    if (merging) {
      // A later run of the task keeps the base its work started from while nothing under it
      // moved (a new merge commit each run would only add noise to its pull request).
      if (resume && (await this.baseStillHolds(git, target, unmerged))) depsBase = DEPS_BASE_REF;
      else {
        const built = await this.dependencyBase(git, target, unmerged);
        if (!built.ok)
          return { outcome: "needs_human", summary: built.words, costUsdMicro: 0, branch };
        depsBase = built.sha;
      }
    }
    await git.setRef(DEPS_BASE_REF, depsBase);
    // "Drop the branch and retry from scratch": the branch starts again from the base (with the
    // work it builds on), even when a pull request already carries it (the PR then gets the new
    // work).
    await git.createBranch(
      branch,
      resume ? `origin/${branch}` : (depsBase ?? `origin/${target.base}`),
    );
    if (resume && depsBase) {
      const merged = await git.mergeFrom(depsBase, mergeMessage(unmerged, target.base));
      if (!merged.ok)
        return this.conflict(ctx, {
          git,
          dir,
          branch,
          target,
          conflicts: merged.conflicts,
          costUsdMicro: 0,
          force: false,
          superseded: answered?.row ?? null,
          merging: true,
        });
    }

    const inner = this.deps.inner.withWorktree
      ? this.deps.inner.withWorktree(dir)
      : this.deps.inner;
    const result = await inner.execute({ ...ctx, task: { ...task, branch } });
    if (result.outcome !== "done" && result.outcome !== "in_review") return result;

    // A commit message is plain text: no markdown marks, no lesson lines (L-19).
    const commit = await git.commitAll(
      `${task.title}\n\n${plainReport(result.summary).slice(0, 500)}\n\nTask ${task.id}.`,
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
    const synced = depsBase
      ? await this.mergeMoved(git, target, unmerged)
      : await git.rebaseOnto(`origin/${target.base}`);
    if (!synced.ok) {
      return this.conflict(ctx, {
        git,
        dir,
        branch,
        target,
        conflicts: synced.conflicts,
        costUsdMicro: result.costUsdMicro,
        force: replace,
        superseded: answered?.row ?? null,
        merging: !!depsBase,
      });
    }
    let changedFiles: string[] = [];
    try {
      // The task's own work: from the base it started on (the default branch with the work it
      // builds on), never the dependencies' files.
      changedFiles = depsBase
        ? await git.filesBetween(DEPS_BASE_REF)
        : await git.changedFiles(`origin/${target.base}`);
    } catch {
      // the diff is informational (peer overlap detection); never fail the PR for it
    }
    try {
      await git.push(branch, { force: !!existingPr || replace, defaultBranch: target.base });
    } catch (e) {
      return {
        outcome: "failed",
        summary: pushFailedWords(`${target.repo.owner}/${target.repo.name}`, branch, e),
        costUsdMicro: result.costUsdMicro,
        branch,
      };
    }
    const prUrl = await this.openOrUpdatePr(
      ctx,
      target,
      branch,
      existingPr,
      result.summary,
      unmerged,
    );
    if (answered) await this.consume(answered.row);
    this.logger.info("pull request ready", {
      taskId: task.id,
      branch,
      prUrl,
      buildsOn: unmerged.map((d) => d.number),
    });
    return { ...result, outcome: "in_review", prUrl, branch, changedFiles };
  }

  /**
   * The done tasks `task` waits for (and those they wait for) whose pull requests are still
   * open on the host, deepest first: the work its branch must hold. A dependency whose pull
   * request was merged is on the default branch already; one closed without a merge was
   * dropped by the person; a task not done (cancelled) is not built on.
   */
  private async unmergedDependencies(task: TaskRow, target: Target): Promise<UnmergedDependency[]> {
    const out: UnmergedDependency[] = [];
    const seen = new Set<string>([task.id]);
    const visit = async (ids: readonly string[]): Promise<void> => {
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const dep = await this.deps.store.task.get(id);
        if (!dep || dep.project_id !== task.project_id) continue;
        await visit(dep.depends_on ?? []);
        if (dep.status !== "done" || !dep.branch) continue;
        const pr = (
          await this.deps.host.listPullRequests(target.repo, { state: "open", head: dep.branch })
        )[0];
        if (!pr) continue;
        out.push({
          taskId: dep.id,
          title: dep.title,
          branch: dep.branch,
          number: pr.number,
          url: pr.htmlUrl,
        });
      }
    };
    await visit(task.depends_on ?? []);
    return out;
  }

  /**
   * The default branch with the dependencies' branches merged in, in order, as a commit of its
   * own (detached; `DEPS_BASE_REF` keeps it): what the task's work starts from. A dependency
   * whose work conflicts with the base or with another one stops here, in words for the
   * person's card: nothing is dropped silently.
   */
  private async dependencyBase(
    git: GitOps,
    target: Target,
    unmerged: readonly UnmergedDependency[],
  ): Promise<{ ok: true; sha: string } | { ok: false; words: string; conflicts: string[] }> {
    await git.checkout(`origin/${target.base}`);
    const merged: UnmergedDependency[] = [];
    for (const dep of unmerged) {
      const ref = `origin/${dep.branch}`;
      if (!(await git.hasRef(ref))) {
        this.logger.warn("a dependency's branch is gone from the host", { branch: dep.branch });
        continue;
      }
      const r = await git.mergeFrom(ref, `Build on "${dep.title}" (pull request #${dep.number})`);
      // A merge that failed with no conflicting file is no conflict between the pull requests
      // (git refused for another reason): git's words, as any other git failure.
      if (!r.ok && r.conflicts.length === 0)
        throw new ForerunnerError(
          "provider_error",
          `git could not bring in the work of "${dep.title}" (pull request #${dep.number}): ${r.detail.split(/\r?\n/)[0] ?? ""}`,
        );
      if (!r.ok)
        return {
          ok: false,
          words: dependencyConflictWords(dep, merged, r.conflicts, target.base),
          conflicts: r.conflicts,
        };
      merged.push(dep);
    }
    return { ok: true, sha: await git.headSha() };
  }

  /** Whether the worktree's `DEPS_BASE_REF` already holds the base and every dependency's tip. */
  private async baseStillHolds(
    git: GitOps,
    target: Target,
    unmerged: readonly UnmergedDependency[],
  ): Promise<boolean> {
    if (!(await git.hasRef(DEPS_BASE_REF))) return false;
    for (const ref of [`origin/${target.base}`, ...unmerged.map((d) => `origin/${d.branch}`)])
      if ((await git.hasRef(ref)) && !(await git.isAncestor(ref, DEPS_BASE_REF))) return false;
    return true;
  }

  /**
   * After the run, on a branch that builds on unmerged work: what moved on the host meanwhile
   * (the default branch, a dependency's branch) is merged in, and `DEPS_BASE_REF` moves with
   * it, so the task's changes stay its own. Nothing moved: nothing to do.
   */
  private async mergeMoved(
    git: GitOps,
    target: Target,
    unmerged: readonly UnmergedDependency[],
  ): Promise<{ ok: boolean; conflicts: string[] }> {
    const refs = [`origin/${target.base}`, ...unmerged.map((d) => `origin/${d.branch}`)];
    let moved = false;
    for (const ref of refs)
      if ((await git.hasRef(ref)) && !(await git.isAncestor(ref))) moved = true;
    if (!moved) return { ok: true, conflicts: [] };
    const branch = await git.currentBranch();
    const built = await this.dependencyBase(git, target, unmerged);
    await git.checkout(branch);
    if (!built.ok) return { ok: false, conflicts: built.conflicts };
    const r = await git.mergeFrom(built.sha, mergeMessage(unmerged, target.base));
    if (!r.ok) return r;
    await git.setRef(DEPS_BASE_REF, built.sha);
    return { ok: true, conflicts: [] };
  }

  /**
   * The folder a task's run changes: the project's workspace (a project without a repository),
   * else the task's own worktree of the repository. Null when neither is a git checkout yet (a
   * project linked to the person's own folder has neither: a run never writes there unasked).
   */
  private async changedFolderOf(task: TaskRow): Promise<GitOps | null> {
    const dir =
      (await this.deps.workspaceFor?.(task)) ?? join(this.deps.worktreeRoot, safeSegment(task.id));
    if (!existsSync(join(dir, ".git"))) return null;
    const git = new GitOps({ cwd: dir, identity: this.deps.identity ?? WORKSPACE_IDENTITY });
    return (await git.hasCommits()) ? git : null;
  }

  /**
   * A task cancelled while it ran or was reviewed (phase C, live walk 2 C1): what its run
   * changed since its baseline ("Workspace before …", or the branch's last commit) is taken out
   * of the folder and kept under `setAsideRef(task)`, so the next task never builds on it and
   * Undo of the cancel brings it back (`bringBack`). Returns the files taken out.
   */
  async setAside(task: TaskRow): Promise<string[]> {
    const git = await this.changedFolderOf(task);
    if (!git) return [];
    return git.setAside(
      setAsideRef(task.id),
      `Set aside: "${task.title}" was cancelled (task ${task.id})`,
    );
  }

  /** Undo of a cancel: what `setAside` took out goes back into the folder, uncommitted. */
  async bringBack(
    task: TaskRow,
  ): Promise<{ result: "restored"; files: string[] } | { result: "missing" | "conflict" }> {
    const git = await this.changedFolderOf(task);
    if (!git) return { result: "missing" };
    return git.bringBack(setAsideRef(task.id));
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
    // The workspace's own commits (a baseline per run) never depend on the person's git
    // setup: many machines have no user.name / user.email, and git refuses to commit without
    // them (found by Windows CI).
    const git = new GitOps({ cwd: dir, identity: this.deps.identity ?? WORKSPACE_IDENTITY });
    if (!existsSync(join(dir, ".git"))) await git.init("main");
    ensureWorkspaceGitignore(dir);
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
    let brought = false;
    // A branch that builds on unmerged work (C-49) is brought up to date by merging; any other
    // by a rebase onto the base, as before.
    const unmerged = await this.unmergedDependencies(ctx.task, target);
    const merging =
      unmerged.length > 0 || (await git.hasMergesSince(`origin/${target.base}`, branch));
    let depsBase: string | null = null;
    if (merging) {
      const built = await this.dependencyBase(git, target, unmerged);
      await git.checkout(branch);
      brought = built.ok && !(await git.isAncestor(built.sha));
      const merged = !built.ok
        ? { ok: false, conflicts: built.conflicts }
        : brought
          ? await git.mergeFrom(built.sha, mergeMessage(unmerged, target.base))
          : { ok: true, conflicts: [] };
      if (!merged.ok || !built.ok)
        return this.conflict(ctx, {
          git,
          dir,
          branch,
          target,
          conflicts: merged.conflicts,
          costUsdMicro: 0,
          force: false,
          superseded: answered.row,
          again: true,
          merging: true,
        });
      depsBase = built.sha;
    } else if (!(await git.isAncestor(`origin/${target.base}`))) {
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
    await git.setRef(DEPS_BASE_REF, depsBase);
    let changedFiles: string[] = [];
    try {
      changedFiles = depsBase
        ? await git.filesBetween(depsBase)
        : await git.changedFiles(`origin/${target.base}`);
    } catch {
      // informational, as above
    }
    if (rebased || brought || !remote) {
      try {
        await git.push(branch, { force: rebased && remote, defaultBranch: target.base });
      } catch (e) {
        return {
          outcome: "failed",
          summary: pushFailedWords(`${target.repo.owner}/${target.repo.name}`, branch, e),
          costUsdMicro: 0,
          branch,
        };
      }
    }
    const existingPr = (
      await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch })
    )[0];
    const summary = `You resolved the conflict of ${branch}; the branch was checked against ${target.base}${rebased ? " (rebased onto it)" : brought ? ` (${target.base} brought into it)` : ""} and goes to review.`;
    const prUrl = await this.openOrUpdatePr(ctx, target, branch, existingPr, summary, unmerged);
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
      /** The branch builds on unmerged work and is brought up to date by a merge (C-49). */
      merging?: boolean;
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
      why: `${c.again ? `The branch ${branch} still conflicts with ${target.base}` : c.merging ? `Bringing ${target.base} and the work it builds on into ${branch} conflicts` : `Rebase of ${branch} onto ${target.base} conflicts`} in ${files}; the agent could not resolve it. Resolve it yourself, let the agent redo the task from ${target.base}, or cancel the task.`,
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
      summary: `${c.merging ? "merge" : "rebase"} conflict in ${conflicts.join(", ")}`,
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
    unmerged: readonly UnmergedDependency[] = [],
  ): Promise<string> {
    const { task } = ctx;
    // The report without the specialist's lesson lines (notes for Forerunner's memory), and the
    // pull requests whose unmerged work this one carries (C-49, L-19).
    const report = withoutLessons(summary);
    const buildsOn = buildsOnText(unmerged);
    if (existingPr) {
      await this.deps.host.commentOnPullRequest(
        target.repo,
        existingPr.number,
        [`Updated by session ${ctx.session.id}: ${report.slice(0, 500)}`, buildsOn]
          .filter(Boolean)
          .join("\n\n"),
      );
      return existingPr.htmlUrl;
    }
    const criteria = task.acceptance_criteria.filter((c: string) => c.trim());
    const pr = await this.deps.host.createPullRequest(target.repo, {
      title: task.title,
      body: [
        task.outcome.trim(),
        buildsOn,
        criteria.length
          ? `Acceptance criteria:\n${criteria.map((c: string) => `- ${c}`).join("\n")}`
          : "",
        report.slice(0, 2000),
        `Task ${task.id}, session ${ctx.session.id}. Opened by Forerunner.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      head: branch,
      base: target.base,
    });
    return pr.htmlUrl;
  }
}

export function requireRepo(e: unknown): never {
  throw new ForerunnerError("validation", `project has no repository: ${errorMessage(e)}`);
}
