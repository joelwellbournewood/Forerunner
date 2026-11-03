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
// branch-rules.ts reads DEPS_BASE_REF from this module; both are used only inside functions.
import { holdsMergedWork, ownChangeId } from "./branch-rules.ts";
import { GitOps, type GitTokenSource, gitAuthFor, resolveGitToken } from "./git.ts";
import { pushFailedWords } from "./push-words.ts";
import type { GitHost, MergeMethod, RepoRef } from "./types.ts";

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

/** "a", "a and b", "a, b and c". */
function andList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What a pull request that carries unmerged work says about it (C-49, ADR 0111): which pull
 * requests it builds on, that it includes their changes, and how to merge it so nothing is
 * copied or conflicts: those first (GitHub's Squash on either one first conflicts when this one
 * changed their files), or Merge in Forerunner, which merges them in order with merge commits.
 * Never "Merge in any order": that held only for GitHub's "Create a merge commit".
 */
export function buildsOnText(deps: readonly Pick<UnmergedDependency, "number">[]): string {
  if (!deps.length) return "";
  const numbers = andList(deps.map((d) => `#${d.number}`));
  return `Builds on ${numbers} (not merged yet): this pull request includes ${deps.length === 1 ? "its" : "their"} changes. Merge ${numbers} first, or use Merge in Forerunner, which merges them in order.`;
}

/**
 * A pull request body with its "Builds on" paragraph replaced by `line` (removed when `line` is
 * empty, added after the first paragraph when it has none): what a dependent pull request says
 * once what it builds on changed (merged, closed, redone; ADR 0111).
 */
export function withBuildsOn(body: string, line: string): string {
  const paras = body.split(/\n{2,}/);
  const at = paras.findIndex((p) => /^Builds on #\d/.test(p.trim()));
  if (at >= 0) {
    if (line) paras[at] = line;
    else paras.splice(at, 1);
  } else if (line) paras.splice(Math.min(1, paras.length), 0, line);
  return paras.join("\n\n");
}

/**
 * Where a dependent branch's worktree records each dependency its marker (`DEPS_BASE_REF`)
 * holds: one ref per dependency task, naming the commit of that task's branch merged in. A
 * rebuild reads them when a dependency's pull request is merged, closed or redone.
 */
export const DEPS_HELD_PREFIX = "refs/forerunner/deps/";
/**
 * Where a task's worktree records that its branch was rebuilt with the same own change:
 * `refs/forerunner/rebuilt/<old head>` names the new head. A task that built on the old head
 * follows it (in a chain, the next one is rebuilt onto it), not voided as redone.
 */
export const REBUILT_PREFIX = "refs/forerunner/rebuilt/";
export function depsHeldRef(taskId: string): string {
  return `${DEPS_HELD_PREFIX}${safeSegment(taskId)}`;
}

/** What became of a dependency a dependent branch holds (ADR 0111). */
export type HeldState =
  /** Its pull request is open and still carries the work held: it stays in the base. */
  | "open"
  /** Merged with a merge commit: its commits are in the default branch as they are. */
  | "in_main"
  /** Merged by squash or rebase: its changes are in the default branch as other commits. */
  | "copied"
  /** Its pull request was closed without merging. */
  | "closed"
  /** Its task is being redone, or its pull request no longer carries the work held. */
  | "redone"
  /** Its task was cancelled. */
  | "cancelled";

export interface HeldDependency {
  taskId: string;
  title: string;
  /** The commit of its branch the marker holds. */
  sha: string;
  /** Its pull request's number, when one is known. */
  number: number | null;
  branch: string | null;
  state: HeldState;
}

/** Dropped from the base without being in the default branch: the review read work that is gone. */
export const VOIDING_STATES: ReadonlySet<HeldState> = new Set(["closed", "redone", "cancelled"]);

/**
 * A dependent branch checked against what it builds on (ADR 0111): what it holds, what a
 * rebuild dropped and kept, its head and own change before and after. `rebuilt` false: nothing
 * it holds went away (the branch is as it was). `after` null: the rebuild conflicted in
 * `conflicts` and was aborted (the branch is as it was).
 */
export interface DependentRebuild {
  taskId: string;
  branch: string;
  held: HeldDependency[];
  dropped: HeldDependency[];
  kept: HeldDependency[];
  rebuilt: boolean;
  before: string;
  after: string | null;
  conflicts: string[];
  /** `ownChangeId` before and after; null when it could not be told. */
  ownBefore: string | null;
  ownAfter: string | null;
  /** A dependency was dropped whose work is not in the default branch (closed, redone, cancelled). */
  voids: boolean;
}

/** What `rebuildDependents` did for one dependent task. */
export interface DependentOutcome {
  taskId: string;
  /** Its pull request (open), when it has one. */
  prNumber: number | null;
  prUrl: string | null;
  result: "unchanged" | "rebuilt" | "conflict" | "held" | "busy" | "failed";
  rebuild?: DependentRebuild;
  error?: string;
}

/** What the caller of `rebuildDependents` decides between the rebuild and its push. */
export interface RebuildHooks {
  /**
   * Called once a dependent branch was rebuilt (or its rebuild conflicted), before anything is
   * pushed: the runtime voids or moves the task's merge record here, so no merge can follow the
   * new head first. False holds the push (a merge of that pull request is under way): the
   * rebuild is tried again later.
   */
  beforePush?: (r: DependentRebuild, pr: { number: number; url: string }) => Promise<boolean>;
}

/**
 * Worktrees a step works in now, in this process: a rebuild never touches one that a run, a
 * resolved conflict or another rebuild is using (`inWorktree` waits for it, `tryWorktree` skips).
 */
const worktreesInUse = new Map<string, Promise<unknown>>();

async function inWorktree<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  for (let held = worktreesInUse.get(dir); held; held = worktreesInUse.get(dir))
    await held.catch(() => undefined);
  const p = fn();
  worktreesInUse.set(dir, p);
  try {
    return await p;
  } finally {
    if (worktreesInUse.get(dir) === p) worktreesInUse.delete(dir);
  }
}

async function tryWorktree<T>(dir: string, fn: () => Promise<T>): Promise<T | null> {
  if (worktreesInUse.has(dir)) return null;
  return inWorktree(dir, fn);
}

/** "#4, which was closed" for the words of a rebuild (ADR 0111). */
export function droppedWords(d: Pick<HeldDependency, "number" | "title" | "state">): string {
  const name = d.number ? `#${d.number}` : `"${d.title.replace(/\s+/g, " ").trim()}"`;
  switch (d.state) {
    case "closed":
      return `${name}, which was closed`;
    case "redone":
      return `${name}, which is being redone`;
    case "cancelled":
      return `${name}, whose task was cancelled`;
    case "copied":
      return `${name}, which was merged`;
    default:
      return name;
  }
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
    const dir = join(this.deps.worktreeRoot, safeSegment(task.id));
    // A rebuild of this task's branch (a dependency merged, closed or redone) waits for the run.
    return inWorktree(dir, () => this.executeIn(ctx, target, dir));
  }

  /** The git of a task's worktree, with the person's token scoped to the clone URL's origin. */
  private async gitFor(target: Target, dir: string): Promise<GitOps> {
    const auth = gitAuthFor(await resolveGitToken(this.deps.token), target.clone);
    return new GitOps({
      cwd: dir,
      // Scoped to the clone URL's origin; a local path or SSH remote gets no header.
      auth,
      identity: this.deps.identity,
    });
  }

  private async executeIn(
    ctx: ExecuteCtx,
    target: Target,
    dir: string,
  ): Promise<TaskExecutionResult> {
    const { task } = ctx;
    let branch =
      task.branch ||
      this.deps.branchFor?.(task) ||
      `fr/${task.id.slice(0, 8)}-${safeSegment(task.title.toLowerCase(), "task").slice(0, 40)}`;
    mkdirSync(this.deps.worktreeRoot, { recursive: true });
    const auth = gitAuthFor(await resolveGitToken(this.deps.token), target.clone);
    const git = await this.gitFor(target, dir);
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
    const answered = await this.conflictAnswer(task);
    if (answered?.outcome === "resolved") {
      if (!task.branch) await this.deps.store.task.patch(task.id, { branch });
      return this.continueResolved(ctx, { git, dir, branch, target, answered });
    }
    const dropped = answered?.outcome === "dropped";
    const existingPr = (
      await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch })
    )[0];
    // A redo of a task whose pull request was merged or closed starts again on a fresh branch
    // (the old name with a short suffix): a branch GitHub keeps after a merge (delete-on-merge
    // off) never makes its push fail, and the old pull request stays as it was.
    if (task.branch && !existingPr) branch = await this.freshBranch(git, target, task.branch);
    if (branch !== task.branch) await this.deps.store.task.patch(task.id, { branch });
    const resume = !!existingPr && !dropped;
    // C-49 (ADR 0106): the done tasks this one waits for whose pull requests are not merged
    // yet. Their branches are merged into this task's before it runs, so it sees their work;
    // its own pull request still targets the default branch.
    let unmerged = await this.unmergedDependencies(task, target);
    if (resume) {
      await git.createBranch(branch, `origin/${branch}`);
      await this.dropStaleMarker(git);
      // What it builds on went away since (merged by squash or rebase, closed, redone,
      // cancelled): the branch is rebuilt first, so the run works on a true branch (ADR 0111).
      const rebuilt = await this.rebuildBranch(git, ctx.task, target);
      if (rebuilt?.rebuilt && !rebuilt.after)
        return this.conflict(ctx, {
          git,
          dir,
          branch,
          target,
          conflicts: rebuilt.conflicts,
          costUsdMicro: 0,
          force: false,
          superseded: answered?.row ?? null,
          merging: true,
          rebuild: rebuilt,
        });
      // A branch that holds merged-in work (the dependencies' marker, or a merge commit since
      // it left the base) is kept up to date by merging, never rebased (ADR 0111): a rebase
      // would copy that work into the branch as new commits.
      if (unmerged.length > 0 || (await holdsMergedWork(git, `origin/${target.base}`))) {
        // A later run of the task keeps the base its work started from while nothing under it
        // moved (a new merge commit each run would only add noise to its pull request).
        if (!(await this.baseStillHolds(git, target, unmerged))) {
          const built = await this.dependencyBase(git, target, unmerged);
          await git.checkout(branch);
          if (!built.ok)
            return { outcome: "needs_human", summary: built.words, costUsdMicro: 0, branch };
          const merged = await git.mergeFrom(built.sha, mergeMessage(unmerged, target.base));
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
          await this.setDepsBase(git, built.sha, built.held);
        }
      }
    } else {
      let depsBase: string | null = null;
      let held: { taskId: string; sha: string }[] = [];
      if (unmerged.length > 0) {
        const built = await this.dependencyBase(git, target, unmerged);
        if (!built.ok)
          return { outcome: "needs_human", summary: built.words, costUsdMicro: 0, branch };
        depsBase = built.sha;
        held = built.held;
      }
      await this.setDepsBase(git, depsBase, held);
      // "Drop the branch and retry from scratch", or a fresh branch: it starts again from the
      // base (with the work it builds on), even when a pull request already carries it (the PR
      // then gets the new work).
      await git.createBranch(branch, depsBase ?? `origin/${target.base}`);
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
    // What it builds on may have gone away during the run: rebuilt before it is pushed.
    const rebuilt = await this.rebuildBranch(git, ctx.task, target);
    if (rebuilt?.rebuilt && !rebuilt.after)
      return this.conflict(ctx, {
        git,
        dir,
        branch,
        target,
        conflicts: rebuilt.conflicts,
        costUsdMicro: result.costUsdMicro,
        force: replace,
        superseded: answered?.row ?? null,
        merging: true,
        rebuild: rebuilt,
      });
    if (rebuilt?.rebuilt) unmerged = await this.unmergedDependencies(task, target);
    // Brought up to date the way it was built: by merging when it holds merged-in work.
    const merging = await holdsMergedWork(git, `origin/${target.base}`);
    const synced = merging
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
        merging,
      });
    }
    let changedFiles: string[] = [];
    try {
      // The task's own work: from the base it started on (the default branch with the work it
      // builds on), never the dependencies' files.
      changedFiles = (await git.hasRef(DEPS_BASE_REF))
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
   * own (detached; `DEPS_BASE_REF` keeps it): what the task's work starts from. Each one is
   * merged with a merge commit, never a fast-forward (ADR 0111), so a branch that brought a
   * dependency in always shows it, and `held` names the commit of each one merged. A
   * dependency whose work conflicts with the base or with another one stops here, in words for
   * the person's card: nothing is dropped silently.
   */
  private async dependencyBase(
    git: GitOps,
    target: Target,
    unmerged: readonly UnmergedDependency[],
  ): Promise<
    | { ok: true; sha: string; held: { taskId: string; sha: string }[] }
    | { ok: false; words: string; conflicts: string[] }
  > {
    await git.checkout(`origin/${target.base}`);
    const merged: UnmergedDependency[] = [];
    const held: { taskId: string; sha: string }[] = [];
    for (const dep of unmerged) {
      const ref = `origin/${dep.branch}`;
      const tip = await git.resolveRef(ref);
      if (!tip) {
        this.logger.warn("a dependency's branch is gone from the host", { branch: dep.branch });
        continue;
      }
      const r = await git.mergeFrom(ref, `Build on "${dep.title}" (pull request #${dep.number})`, {
        noFastForward: true,
      });
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
      held.push({ taskId: dep.taskId, sha: tip });
    }
    return { ok: true, sha: await git.headSha(), held };
  }

  /**
   * The marker of what the branch builds on (`DEPS_BASE_REF`) and the dependencies it holds
   * (`depsHeldRef`); null removes both (a branch on the default branch alone).
   */
  private async setDepsBase(
    git: GitOps,
    sha: string | null,
    held: readonly { taskId: string; sha: string }[],
  ): Promise<void> {
    await git.setRef(DEPS_BASE_REF, sha);
    for (const r of await git.refsUnder(DEPS_HELD_PREFIX)) await git.setRef(r.ref, null);
    if (sha) for (const h of held) await git.setRef(depsHeldRef(h.taskId), h.sha);
  }

  /**
   * A marker the checked-out branch does not hold (left from a branch that was replaced) says
   * nothing about it: removed, with the dependencies it named.
   */
  private async dropStaleMarker(git: GitOps): Promise<void> {
    const marker = await git.resolveRef(DEPS_BASE_REF);
    if (marker && !(await git.isAncestor(marker))) await this.setDepsBase(git, null, []);
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
   * The name a task's next run pushes to: its branch, unless that branch's pull request was
   * merged or closed and none is open (a redo after the merge, or after the person closed it):
   * then a fresh name, the old one with `-r2`, `-r3`, ..., that neither the host's branches nor
   * any pull request has used.
   */
  private async freshBranch(git: GitOps, target: Target, current: string): Promise<string> {
    const prs = await this.deps.host.listPullRequests(target.repo, {
      state: "all",
      head: current,
    });
    if (prs.some((p) => p.state === "open") || !prs.some((p) => p.state === "closed"))
      return current;
    const stem = current.replace(/-r\d+$/, "");
    for (let n = 2; n < 100; n++) {
      const name = `${stem}-r${n}`;
      if (await git.hasRef(`origin/${name}`)) continue;
      const used = await this.deps.host.listPullRequests(target.repo, { state: "all", head: name });
      if (used.length === 0) return name;
    }
    return `${stem}-r${this.deps.clock.now().toString(36)}`;
  }

  /**
   * The dependencies the checked-out branch's marker holds, each with what became of it
   * (ADR 0111). A marker made before the held refs existed names none: then the task's
   * dependencies whose branch on the host is in the marker are read as held.
   */
  private async heldDependencies(
    git: GitOps,
    task: TaskRow,
    target: Target,
    marker: string,
  ): Promise<HeldDependency[]> {
    let entries = (await git.refsUnder(DEPS_HELD_PREFIX)).map((r) => ({
      taskId: r.ref.slice(DEPS_HELD_PREFIX.length),
      sha: r.sha,
    }));
    if (!entries.length) {
      for (const dep of await this.dependencyTasks(task)) {
        const tip = dep.branch ? await git.resolveRef(`origin/${dep.branch}`) : null;
        if (tip && (await git.isAncestor(tip, marker))) entries.push({ taskId: dep.id, sha: tip });
      }
    }
    entries = entries.filter((e, i) => entries.findIndex((x) => x.taskId === e.taskId) === i);
    const out: HeldDependency[] = [];
    for (const e of entries) out.push(await this.heldState(git, target, e));
    return out;
  }

  /** What became of one dependency a branch holds: its task, then its pull request, then main. */
  private async heldState(
    git: GitOps,
    target: Target,
    e: { taskId: string; sha: string },
  ): Promise<HeldDependency> {
    const dep = await this.deps.store.task.get(e.taskId);
    const base = {
      taskId: e.taskId,
      title: dep?.title ?? e.taskId,
      sha: e.sha,
      branch: dep?.branch ?? null,
    };
    const numberOf = (url: string | null | undefined) => {
      const m = /\/pull\/(\d+)/.exec(url ?? "");
      return m ? Number(m[1]) : null;
    };
    // Its commits are in the default branch as they are (a merge commit): nothing to rebuild.
    if (await git.isAncestor(e.sha, `origin/${target.base}`))
      return { ...base, number: numberOf(dep?.pr_url), state: "in_main" };
    if (!dep) return { ...base, number: null, state: "open" };
    if (dep.status === "cancelled")
      return { ...base, number: numberOf(dep.pr_url), state: "cancelled" };
    if (dep.status !== "done") return { ...base, number: numberOf(dep.pr_url), state: "redone" };
    const prs = dep.branch
      ? await this.deps.host.listPullRequests(target.repo, { state: "all", head: dep.branch })
      : [];
    const open = prs.find((p) => p.state === "open");
    if (open) {
      // The open pull request still carries the work held (it may have moved on since), or the
      // same change rebuilt (the dependency was itself rebuilt onto main: this one follows it).
      const tip = await git.resolveRef(`origin/${dep.branch}`);
      let carries = !!tip && (await git.isAncestor(e.sha, tip));
      if (!carries && tip) {
        const rebuilt = await this.rebuiltTo(dep.id, e.sha);
        carries = !!rebuilt && (await git.hasRef(rebuilt)) && (await git.isAncestor(rebuilt, tip));
      }
      return { ...base, number: open.number, state: carries ? "open" : "redone" };
    }
    const latest = [...prs].sort((a, b) => b.number - a.number);
    const merged = latest.find((p) => p.merged);
    if (merged) return { ...base, number: merged.number, state: "copied" };
    return { ...base, number: latest[0]?.number ?? numberOf(dep.pr_url), state: "closed" };
  }

  /**
   * The head `sha` of a task's branch was rebuilt to with the same own change (following a
   * chain of rebuilds), read in that task's worktree; null when it was not.
   */
  private async rebuiltTo(taskId: string, sha: string): Promise<string | null> {
    const dir = join(this.deps.worktreeRoot, safeSegment(taskId));
    if (!existsSync(join(dir, ".git"))) return null;
    const git = new GitOps({ cwd: dir });
    let at: string | null = null;
    let from = sha;
    for (let hop = 0; hop < 20; hop++) {
      const next = await git.resolveRef(`${REBUILT_PREFIX}${from}`);
      if (!next) break;
      at = next;
      from = next;
    }
    return at;
  }

  /** The tasks `task` waits for, and those they wait for, in the same project. */
  private async dependencyTasks(task: TaskRow): Promise<TaskRow[]> {
    const out: TaskRow[] = [];
    const seen = new Set<string>([task.id]);
    const visit = async (ids: readonly string[]): Promise<void> => {
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const dep = await this.deps.store.task.get(id);
        if (!dep || dep.project_id !== task.project_id) continue;
        await visit(dep.depends_on ?? []);
        out.push(dep);
      }
    };
    await visit(task.depends_on ?? []);
    return out;
  }

  /**
   * The checked-out branch against what it builds on (ADR 0111). Null when it builds on the
   * default branch alone. When a dependency it holds went away (merged by squash or rebase,
   * closed, redone, cancelled) the branch is rebuilt: the base again (the default branch with
   * the dependencies still open, each merged in), then only the task's own commits replayed on
   * it (`git rebase --onto <new base> DEPS_BASE_REF`); the marker then names the new base, or
   * is removed when nothing open is left. A rebuild that conflicts is aborted: the branch is as
   * it was and `after` is null. Nothing is pushed here.
   */
  private async rebuildBranch(
    git: GitOps,
    task: TaskRow,
    target: Target,
  ): Promise<DependentRebuild | null> {
    const marker = await git.resolveRef(DEPS_BASE_REF);
    if (!marker || !(await git.isAncestor(marker))) return null;
    const branch = await git.currentBranch();
    const held = await this.heldDependencies(git, task, target, marker);
    const dropped = held.filter((h) => h.state !== "open" && h.state !== "in_main");
    const kept = held.filter((h) => h.state === "open");
    const before = await git.headSha();
    const base = `origin/${target.base}`;
    const out: DependentRebuild = {
      taskId: task.id,
      branch,
      held,
      dropped,
      kept,
      rebuilt: false,
      before,
      after: before,
      conflicts: [],
      ownBefore: null,
      ownAfter: null,
      voids: dropped.some((d) => VOIDING_STATES.has(d.state)),
    };
    if (!dropped.length) return out;
    out.rebuilt = true;
    out.ownBefore = await ownChangeId(git, base).catch(() => null);
    let newBase: string | null = null;
    let newHeld: { taskId: string; sha: string }[] = [];
    if (kept.length) {
      const keep: UnmergedDependency[] = kept.map((k) => ({
        taskId: k.taskId,
        title: k.title,
        branch: k.branch ?? "",
        number: k.number ?? 0,
        url: "",
      }));
      const built = await this.dependencyBase(git, target, keep);
      await git.checkout(branch);
      if (!built.ok) return { ...out, after: null, conflicts: built.conflicts };
      newBase = built.sha;
      newHeld = built.held;
    }
    const r = await git.rebaseOntoFrom(newBase ?? base, marker, branch);
    if (!r.ok) return { ...out, after: null, conflicts: r.conflicts };
    await this.setDepsBase(git, newBase, newHeld);
    out.after = await git.headSha();
    out.ownAfter = await ownChangeId(git, base).catch(() => null);
    // The same change on a new head: what built on the old head follows it (`rebuiltTo`).
    if (out.ownBefore && out.ownBefore === out.ownAfter)
      await git.setRef(`${REBUILT_PREFIX}${before}`, out.after);
    this.logger.info("dependent branch rebuilt", {
      taskId: task.id,
      branch,
      dropped: dropped.map((d) => `${d.number ?? d.taskId}:${d.state}`),
      kept: kept.map((k) => k.number),
    });
    return out;
  }

  /**
   * After a dependency's pull request was merged (by any method) or closed, or its task was
   * redone or cancelled (ADR 0111): every done task of the project that waits for it (directly
   * or through others) and whose branch holds it is checked, and rebuilt where what it holds
   * went away: force-pushed with a lease (never the default branch), its "Builds on" line
   * updated. `hooks.beforePush` runs before each push (the runtime moves the merge record
   * there). A task whose worktree a run or another rebuild uses now is `busy`: its own run
   * rebuilds it, or the caller tries again.
   */
  async rebuildDependents(
    projectId: string,
    changedDependencyTaskId: string,
    hooks: RebuildHooks = {},
  ): Promise<DependentOutcome[]> {
    const out: DependentOutcome[] = [];
    const done = await this.deps.store.task.list(
      { project_id: projectId, status: "done" } as never,
      {
        limit: 2000,
      },
    );
    // A task before the tasks that build on it: in a chain, each one follows the one before it
    // once that one was rebuilt (`rebuiltTo`).
    const todo: { task: TaskRow; depth: number }[] = [];
    for (const t of done) {
      if (t.id === changedDependencyTaskId || !t.branch || !(t.depends_on ?? []).length) continue;
      const deps = await this.dependencyTasks(t);
      if (!deps.some((d) => d.id === changedDependencyTaskId)) continue;
      todo.push({ task: t, depth: deps.length });
    }
    todo.sort((a, b) => a.depth - b.depth);
    for (const { task } of todo)
      out.push(await this.rebuildTask(task, hooks, changedDependencyTaskId));
    return out;
  }

  /**
   * One done task's branch against what it builds on (`rebuildDependents`; the runtime also
   * asks it right before an accepted task's merge). `onlyIfHolding`: skip the task (no host
   * call) when its worktree does not hold that dependency.
   */
  async rebuildTask(
    task: TaskRow,
    hooks: RebuildHooks = {},
    onlyIfHolding?: string,
  ): Promise<DependentOutcome> {
    const none: DependentOutcome = {
      taskId: task.id,
      prNumber: null,
      prUrl: null,
      result: "unchanged",
    };
    const dir = join(this.deps.worktreeRoot, safeSegment(task.id));
    if (!task.branch || !existsSync(join(dir, ".git"))) return none;
    try {
      const r = await tryWorktree(dir, () => this.rebuildIn(task, dir, hooks, onlyIfHolding));
      return r ?? { ...none, result: "busy" };
    } catch (e) {
      this.logger.warn("dependent branch not rebuilt", { taskId: task.id, error: errorMessage(e) });
      return { ...none, result: "failed", error: errorMessage(e) };
    }
  }

  private async rebuildIn(
    task: TaskRow,
    dir: string,
    hooks: RebuildHooks,
    onlyIfHolding?: string,
  ): Promise<DependentOutcome> {
    const none: DependentOutcome = {
      taskId: task.id,
      prNumber: null,
      prUrl: null,
      result: "unchanged",
    };
    const target = await this.deps.repoFor(task);
    const branch = task.branch;
    if (!target || !branch) return none;
    const git = await this.gitFor(target, dir);
    // Cheap first: a worktree without the marker, or one whose held refs do not name the
    // dependency that changed, has nothing to rebuild (a marker made before the held refs is
    // read in full).
    if (!(await git.hasRef(DEPS_BASE_REF))) return none;
    if (onlyIfHolding) {
      const held = await git.refsUnder(DEPS_HELD_PREFIX);
      if (held.length && !(await git.hasRef(depsHeldRef(onlyIfHolding)))) return none;
    }
    const pr = (
      await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch })
    )[0];
    if (!pr) return none;
    const found = { ...none, prNumber: pr.number, prUrl: pr.htmlUrl };
    await git.fetch();
    if (!(await git.hasRef(`origin/${branch}`))) return found;
    // Work nobody committed (a person's change after the run) is never swept into a rebuild.
    if ((await git.status()).dirty) {
      this.logger.warn("dependent branch not rebuilt: its worktree has uncommitted changes", {
        taskId: task.id,
      });
      return { ...found, result: "busy" };
    }
    // The branch as the host has it (a person may have pushed to it).
    await git.createBranch(branch, `origin/${branch}`);
    await this.dropStaleMarker(git);
    const marker = await git.resolveRef(DEPS_BASE_REF);
    const heldRefs = await git.refsUnder(DEPS_HELD_PREFIX);
    const r = await this.rebuildBranch(git, task, target);
    if (!r) return found;
    if (!r.rebuilt) {
      // Nothing went away; a dependency merged with a merge commit leaves the line naming the
      // ones still open.
      await this.syncBuildsOn(target, pr.number, r.kept);
      return { ...found, rebuild: r };
    }
    const push = (await hooks.beforePush?.(r, { number: pr.number, url: pr.htmlUrl })) ?? true;
    if (!r.after) return { ...found, result: "conflict", rebuild: r };
    if (!push) {
      // Held: the branch and its marker go back to what the host has; the next try rebuilds.
      await git.createBranch(branch, `origin/${branch}`);
      await git.setRef(DEPS_BASE_REF, marker);
      for (const h of await git.refsUnder(DEPS_HELD_PREFIX)) await git.setRef(h.ref, null);
      for (const h of heldRefs) await git.setRef(h.ref, h.sha);
      return { ...found, result: "held", rebuild: r };
    }
    await git.push(branch, { force: true, defaultBranch: target.base });
    await this.syncBuildsOn(target, pr.number, r.kept);
    this.logger.info("dependent pull request rebuilt", {
      taskId: task.id,
      pr: pr.number,
      dropped: r.dropped.map((d) => d.number),
    });
    return { ...found, result: "rebuilt", rebuild: r };
  }

  /**
   * How a task's pull request was merged on the host, read from git in its worktree (ADR 0111):
   * a merge commit with two parents is "merge"; one parent is "rebase" when the pull request
   * had several commits and the merge commit repeats its last one, else "squash". Null when it
   * cannot be told (no worktree, the commit not fetched).
   */
  async mergeMethodOf(
    task: TaskRow,
    mergeSha: string | null,
    headSha?: string | null,
  ): Promise<MergeMethod | null> {
    if (!mergeSha) return null;
    const dir = join(this.deps.worktreeRoot, safeSegment(task.id));
    const target = existsSync(join(dir, ".git")) ? await this.deps.repoFor(task) : null;
    if (!target) return null;
    try {
      const git = await this.gitFor(target, dir);
      await git.fetch();
      if (!(await git.hasRef(mergeSha))) return null;
      const parents = await git.parentsOf(mergeSha);
      if (parents.length >= 2) return "merge";
      const head =
        (headSha && (await git.hasRef(headSha)) ? headSha : null) ??
        (task.branch ? await git.resolveRef(`origin/${task.branch}`) : null);
      const parent = parents[0];
      if (!head || !parent) return "squash";
      const forked = await git.mergeBase(head, parent);
      const own = forked ? await git.commitCount(forked, head) : 0;
      if (own <= 1) return "squash";
      const last = (await git.parentsOf(head))[0];
      const same =
        last && (await git.patchId(last, head)) === (await git.patchId(parent, mergeSha));
      return same ? "rebase" : "squash";
    } catch (e) {
      this.logger.warn("merge method not read", { taskId: task.id, error: errorMessage(e) });
      return null;
    }
  }

  /** The pull request's "Builds on" line as it is now (`withBuildsOn`); a failure is logged. */
  private async syncBuildsOn(
    target: Target,
    number: number,
    deps: readonly { number: number | null }[],
  ): Promise<void> {
    try {
      const pr = await this.deps.host.getPullRequest(target.repo, number);
      const line = buildsOnText(deps.flatMap((d) => (d.number ? [{ number: d.number }] : [])));
      const body = withBuildsOn(pr.body, line);
      if (body !== pr.body) await this.deps.host.updatePullRequest(target.repo, number, { body });
    } catch (e) {
      this.logger.warn("pull request words not updated", { pr: number, error: errorMessage(e) });
    }
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
    await this.setDepsBase(git, built.sha, built.held);
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
   * The specialist the next attempt runs with (U-044): the inner executor decides it (the
   * retry ladder's stand-in), so the runner's log names who runs before the run begins.
   */
  async chooseSpecialist(
    ctx: Parameters<NonNullable<TaskExecutor["chooseSpecialist"]>>[0],
  ): Promise<string | null> {
    return (await this.deps.inner.chooseSpecialist?.(ctx)) ?? null;
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
    await this.dropStaleMarker(git);
    // A branch that builds on unmerged work (C-49), or holds merged-in work (the marker, a
    // merge commit since the base: `holdsMergedWork`), is brought up to date by merging, never
    // rebased (ADR 0111); any other by a rebase onto the base, as before.
    const unmerged = await this.unmergedDependencies(ctx.task, target);
    const merging =
      unmerged.length > 0 || (await holdsMergedWork(git, `origin/${target.base}`, branch));
    if (merging && !(await this.baseStillHolds(git, target, unmerged))) {
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
      await this.setDepsBase(git, built.sha, built.held);
    } else if (!merging && !(await git.isAncestor(`origin/${target.base}`))) {
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
      changedFiles = (await git.hasRef(DEPS_BASE_REF))
        ? await git.filesBetween(DEPS_BASE_REF)
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
      /** A rebuild without a dependency that went away conflicted (ADR 0111). */
      rebuild?: DependentRebuild;
    },
  ): Promise<TaskExecutionResult> {
    const { task } = ctx;
    const { branch, target, conflicts } = c;
    const repoName = `${target.repo.owner}/${target.repo.name}`;
    const what = c.again
      ? `The branch ${branch} still conflicts with ${target.base}`
      : c.rebuild
        ? `Rebuilding ${branch} without ${andList(c.rebuild.dropped.map(droppedWords))} conflicts`
        : c.merging
          ? `Bringing ${target.base} and the work it builds on into ${branch} conflicts`
          : `Rebase of ${branch} onto ${target.base} conflicts`;
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
      why: `${what} in ${files}; the agent could not resolve it. Resolve it yourself, let the agent redo the task from ${target.base}, or cancel the task.`,
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
      // Its body says what it builds on now (a dependency merged or dropped since it opened).
      await this.syncBuildsOn(target, existingPr.number, unmerged);
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
