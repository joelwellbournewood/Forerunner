import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import {
  copyLocalOnlyBack,
  copyLocalOnlyIn,
  excludeNeverPushed,
  hasLocalOnlyCopy,
  isNeverPushed,
  keptBesideSentence,
  LOCAL_ONLY_DIR,
  NEVER_PUSHED,
  recoverLocalOnlyCopies,
  TRY_DIR,
  underNeverPushed,
} from "./local-only.ts";
import { pushFailedWords } from "./push-words.ts";
import type { GitHost, MergeMethod, PullRequestInfo, RepoRef } from "./types.ts";
// A worktree a step works in now: a rebuild never touches one that a run, a resolved conflict,
// another rebuild or the merge step is using (`inWorktree` waits for it, `tryWorktree` skips).
import { inWorktree, tryWorktree } from "./worktree-lock.ts";

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

/**
 * A change-card field the runtime sets on a task's answered card when the answer redoes the task
 * from the base (a rebuild card's Redo, `syncPrAnswers`; the fix-up of R-rebuildcard): the
 * task's next run starts its branch again from the base, as "Drop the branch and retry from
 * scratch" does, and the open pull request gets the new work. Before, the redo resumed the open
 * pull request's branch, rebuilt it again and stopped at the same conflict. Used once, as a
 * conflict answer is (`consumed_at`, once a run reached review or filed a new conflict card).
 */
export const REDO_FROM_BASE_FIELD = "redo_from_base";

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
  /**
   * The project's Local only folder on this computer (merged-copy, ADR 0113: `ProjectDocs
   * .localOnlyFolder`, in the project's copy): copied into the task's worktree before each run
   * and back after it (`local-only.ts`), so the agent (and the Docker sandbox, which mounts only
   * the worktree) can use it. Null (or absent): the project has none.
   */
  localOnlyFor?: (task: TaskRow) => Promise<string | null>;
  /**
   * The project's setting "Push unfinished work to GitHub" (budget-resume, default off): a
   * paused task's work in progress is pushed to its branch on the host too. Off, it stays on
   * this computer (a push starts the repository's automatic checks and co-workers see it).
   */
  pushUnfinishedFor?: (task: TaskRow) => Promise<boolean>;
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

/**
 * W15-02: a rebuild made in a task's folder whose push has not gone through yet names its head
 * here, and keeps what to put back under `REBUILD_BEFORE_PREFIX` (the marker and the held refs
 * as they were). Cleared once the push went through or the rebuild was put back; one left by a
 * stop of the app is undone at the next rebuild of the folder (`undoUnpushedRebuild`).
 */
export const REBUILD_PENDING_REF = "refs/forerunner/rebuild-pending";
export const REBUILD_BEFORE_PREFIX = "refs/forerunner/rebuild-before/";

async function markUnpushedRebuild(
  git: GitOps,
  after: string,
  marker: string | null,
  heldRefs: readonly { ref: string; sha: string }[],
): Promise<void> {
  await clearUnpushedRebuild(git);
  if (marker) await git.setRef(`${REBUILD_BEFORE_PREFIX}deps-base`, marker);
  for (const h of heldRefs)
    await git.setRef(`${REBUILD_BEFORE_PREFIX}${h.ref.slice("refs/forerunner/".length)}`, h.sha);
  await git.setRef(REBUILD_PENDING_REF, after);
}

async function clearUnpushedRebuild(git: GitOps): Promise<void> {
  for (const r of await git.refsUnder(REBUILD_BEFORE_PREFIX)) await git.setRef(r.ref, null);
  await git.setRef(REBUILD_PENDING_REF, null);
}

/**
 * W15-02: what holds a done task's folder from a rebuild, which starts the branch again from
 * GitHub's: `changes`, files nobody committed; `commits`, a commit on the task's branch (or the
 * folder's HEAD) that GitHub's branch does not have and that is not Forerunner's own unpushed
 * step. Forerunner's own: a merge of the base onto GitHub's head (the merge step's update cut
 * short before its push, `merge.ts` `unpushedBaseMerge`) and work-in-progress commits
 * (`WIP_SUBJECT`, kept under `wipRef` too); its own rebuild cut short is put back before this
 * is asked (`REBUILD_PENDING_REF`). Anything else is the person's and is never reset away; a
 * commit nobody can tell is held, not dropped (fails closed). Null: nothing holds it.
 */
export async function folderHold(
  git: GitOps,
  branch: string,
  base: string,
): Promise<"changes" | "commits" | null> {
  if ((await git.status()).dirty) return "changes";
  const host = `origin/${branch}`;
  const hostHead = await git.resolveRef(host);
  if (!hostHead) return null;
  const tips = new Set<string>();
  for (const ref of [`refs/heads/${branch}`, "HEAD"]) {
    const sha = await git.resolveRef(ref);
    if (sha) tips.add(sha);
  }
  for (const tip of tips) {
    if (await git.isAncestor(tip, hostHead)) continue;
    const parents = await git.parentsOf(tip);
    if (
      parents.length === 2 &&
      parents[0] === hostHead &&
      (await git.isAncestor(parents[1] as string, `origin/${base}`))
    )
      continue;
    const subjects = await git.subjectsBetween(hostHead, tip);
    if (subjects.length && subjects.every((s) => s.startsWith(WIP_SUBJECT))) continue;
    return "commits";
  }
  return null;
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
  /**
   * R-chain (leftovers7-merge2): open, but its branch carries the work held only as a rebuild of
   * it (`rebuiltTo`: the same change on a new head). The dependent still builds on the old
   * head, which may hold work its own rebuild dropped, so it is brought onto the new head.
   */
  rebuilt?: boolean;
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
  /**
   * `busy` because of what the person left in the task's folder (W15-02, W15-05, `folderHold`):
   * changes nobody committed, or a commit GitHub does not have. The rebuild waits for them.
   */
  held?: "changes" | "commits";
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

/** "#4, which was closed" for the words of a rebuild (ADR 0111). */
export function droppedWords(d: Pick<HeldDependency, "number" | "title" | "state">): string {
  const name = d.number ? `#${d.number}` : `"${d.title.replace(/\s+/g, " ").trim()}"`;
  switch (d.state) {
    case "closed":
      return `${name}, which was closed`;
    case "redone":
      // P7-7: true whenever read; "which is being redone" stayed on the card after the redo.
      return `${name}, whose task was reopened`;
    case "cancelled":
      return `${name}, whose task was cancelled`;
    case "copied":
      return `${name}, which was merged`;
    default:
      return name;
  }
}

/**
 * A task's branch name: `fr/<8 characters of its id>-<its title>` (R-branch, leftovers7-merge).
 * The 8 characters are the id's random end, never its start: a UUIDv7 starts with its creation
 * time, which is the same for 65 s, so two tasks titled alike created within a minute got one
 * branch and the second pushed its work onto the first's pull request. An id that is not a UUID
 * (tests, imports) gives its own first characters.
 */
export function taskBranchName(task: Pick<TaskRow, "id" | "title">): string {
  const hex = task.id.toLowerCase().replace(/[^0-9a-f]/g, "");
  const own =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(task.id) &&
    hex.length === 32
      ? hex.slice(-8)
      : safeSegment(task.id.toLowerCase(), "task").slice(0, 8);
  return `fr/${own}-${safeSegment(task.title.toLowerCase(), "task").slice(0, 40)}`;
}

/**
 * What Forerunner's hidden mark in a pull request body names (W15-01, W15-08): the project whose
 * pull request it is, and for a task's the task and the session that opened it. Code reads it;
 * the person never sees it (design §5 rule 3: no ids in what a person reads).
 */
export interface ForerunnerMark {
  project?: string;
  task?: string;
  session?: string;
}

const MARK_START = "<!-- forerunner:pr ";
const MARK_KEYS = ["project", "task", "session"] as const;

/**
 * The hidden mark of a pull request Forerunner opens (an HTML comment, as `AGENT_TEXT_MARKER`:
 * GitHub does not render it): `<!-- forerunner:pr project=<id> task=<id> session=<id> -->`.
 * Values are URI-encoded, so no id can end the comment early.
 */
export function forerunnerMarker(mark: ForerunnerMark): string {
  const fields = MARK_KEYS.flatMap((k) => {
    const v = mark[k]?.trim();
    return v ? [`${k}=${encodeURIComponent(v)}`] : [];
  });
  return `${MARK_START}${fields.join(" ")} -->`;
}

/** The mark a body carries (the first), or null when it has none. */
export function readForerunnerMarker(body: string | null | undefined): ForerunnerMark | null {
  const text = body ?? "";
  const at = text.indexOf(MARK_START);
  if (at < 0) return null;
  const end = text.indexOf("-->", at);
  if (end < 0) return null;
  const out: ForerunnerMark = {};
  for (const part of text
    .slice(at + MARK_START.length, end)
    .trim()
    .split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq) as (typeof MARK_KEYS)[number];
    if (!MARK_KEYS.includes(key)) continue;
    try {
      const value = decodeURIComponent(part.slice(eq + 1));
      if (value) out[key] = value;
    } catch {
      // A value that is not URI text names nothing.
    }
  }
  return out;
}

/**
 * When a session started, as the text Forerunner writes on GitHub names it (W15-08: a session is
 * named by its start time, never its id): "2026-11-09 04:12 UTC". Null when it is not known.
 */
export function sessionWhen(startedAt: string | null | undefined): string | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return null;
  const iso = new Date(t).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "the session started 2026-11-09 04:12 UTC", or "a session" when its start is not known. */
export function sessionWords(startedAt: string | null | undefined): string {
  const when = sessionWhen(startedAt);
  return when ? `the session started ${when}` : "a session";
}

/**
 * Whether a pull request Forerunner opened names another task than `taskId`: its hidden mark
 * (W15-08), or the visible line earlier versions ended its body with ("Task <id>, session <id>.
 * Opened by Forerunner."). That pull request is never this task's.
 */
export function openedForAnotherTask(pr: Pick<PullRequestInfo, "body">, taskId: string): boolean {
  const named =
    readForerunnerMarker(pr.body)?.task ??
    /\bTask ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}), session /i.exec(
      pr.body ?? "",
    )?.[1];
  return !!named && named.toLowerCase() !== taskId.toLowerCase();
}

/**
 * A run that changed no file (L-18, polish-words): "The run changed no file." first, then its own
 * report, plain (no markdown) and on one line, which the reason and the failed-task card cut at
 * a word.
 */
export function emptyChangeSummary(report: string): string {
  const said = plainReport(report).replace(/\s+/g, " ").trim();
  return said ? `The run changed no file. It reported: ${said}` : "The run changed no file.";
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
 * budget-resume (ADR 0112 amended): the commit of a task's work in progress, in the folder it
 * runs in (its own worktree of a repository, or the project's folder). Its next run starts from
 * it: in a repository from the task's own local branch, never `checkout -B` from the host (which
 * carried the files over, or git refused when main had changed them). Removed once the work goes
 * to review, when the branch starts again from the base, and when a cancel sets the work aside.
 */
export function wipRef(taskId: string): string {
  return `refs/forerunner/wip/${safeSegment(taskId)}`;
}
/**
 * TM-3 (leftovers7-tailmerge): set beside `wipRef` when the work in progress was made by a run
 * that started from the base after the person dropped the branch ("Drop the branch and retry
 * from scratch", a card's Redo): the next run continues it, never the dropped branch, and its
 * push replaces the host's branch. Removed with `wipRef` once the work goes to review.
 */
export function wipFromBaseRef(taskId: string): string {
  return `refs/forerunner/wip-from-base/${safeSegment(taskId)}`;
}
/** A cancelled task's work in progress (its commits), kept until Undo brings it back. */
export function setAsideWipRef(taskId: string): string {
  return `refs/forerunner/set-aside-wip/${safeSegment(taskId)}`;
}
/** What a failed run left uncommitted in the task's worktree (W6-24), kept but out of the way. */
export function failedRef(taskId: string): string {
  return `refs/forerunner/failed/${safeSegment(taskId)}`;
}

/**
 * Why a task's branch holds no change of its own (TM-1, leftovers7-tailmerge): `redone`, a redo
 * from the base whose run changed nothing; `empty`, a run that changed nothing on a branch that
 * held nothing either; `up_to_date` (the fix-up), a branch that held a change until it was
 * brought up to date with the base, which already has the same change (or the person's
 * resolution kept the base's side only).
 */
export type EmptiedWhy = "redone" | "empty" | "up_to_date";

/**
 * TM-1 (leftovers7-tailmerge): the failed task's one sentence when its branch holds no change of
 * its own and the pull request open on it was closed (`closeEmptied`): after a redo from the
 * base ("Redone from main, it changed nothing, so #4 was closed."), a pull request that held no
 * change either, or one that no longer changes anything once brought up to date. `prNumber` is
 * null when no pull request was closed: only `up_to_date` has its own words then ("main already
 * has this change."). Polish owns the words.
 */
export function emptiedSentence(prNumber: number | null, why: EmptiedWhy, base = "main"): string {
  if (why === "up_to_date")
    return prNumber === null
      ? `${base} already has this change.`
      : `#${prNumber} no longer changes anything on ${base}, so it was closed.`;
  return why === "redone"
    ? `Redone from ${base}, it changed nothing, so #${prNumber} was closed.`
    : `It changed nothing and #${prNumber} held no change, so #${prNumber} was closed.`;
}

/** The first words of a work-in-progress commit's subject. */
export const WIP_SUBJECT = "Work in progress: ";

/** The limit a pause names in its commit ("its budget", "this month's cap"). */
export function pausedAtWords(stop: TaskExecutionResult["budgetStop"]): string {
  switch (stop?.source) {
    case "specialist_limit":
      return `the ${stop.specialist}'s limit per run`;
    case "session":
      return "the session's budget";
    case "project":
      return "the project's budget";
    case "month":
      return "this month's cap";
    case "plan":
      return "the subscription's share";
    default:
      return "its budget";
  }
}

/**
 * The outcomes whose run stopped before its work was done and whose work is kept as work in
 * progress in a repository's worktree: a pause (ADR 0112), a question for the person, a Claude
 * credential's limit, a stop. Before, each left its files uncommitted for the next run's
 * `checkout -B` to carry over or refuse.
 */
const WIP_OUTCOMES: ReadonlySet<TaskExecutionResult["outcome"]> = new Set([
  "paused",
  "needs_human",
  "usage_limit",
  "killed",
]);

/**
 * A work-in-progress commit's message: why it stopped in the subject, then the run's own
 * "Where I stopped:" and "Left to do:" (data, kept plain), then the task.
 */
export function workInProgressMessage(
  task: Pick<TaskRow, "id" | "title">,
  result: Pick<TaskExecutionResult, "outcome" | "budgetStop" | "handoff">,
): string {
  const title = task.title.replace(/\s+/g, " ").trim();
  const why =
    result.outcome === "paused"
      ? `paused at ${pausedAtWords(result.budgetStop)}`
      : result.outcome === "needs_human"
        ? "waiting for your answer"
        : result.outcome === "usage_limit"
          ? "stopped at a Claude credential's limit"
          : "stopped";
  const h = result.handoff;
  const plain = (s: string) => s.replace(/\s+/g, " ").trim();
  return [
    `${WIP_SUBJECT}${title} (${why})`,
    ...(h
      ? [
          `Where I stopped: ${plain(h.stopped) || "it wrote no note (it stopped at its budget)."}`,
          h.leftToDo.length
            ? `Left to do:\n${h.leftToDo.map((t) => `- ${plain(t)}`).join("\n")}`
            : "Left to do: not listed.",
        ]
      : []),
    `Task ${task.id}.`,
  ].join("\n\n");
}

/** The task whose run built on a work-in-progress commit, from the subjects after it. */
function builtOnBy(subjects: readonly string[]): string | null {
  for (const s of [...subjects].reverse()) {
    const before = /^Workspace before "(.*)" \(task [^)]*\)$/.exec(s);
    if (before) return before[1] ?? "another task";
    if (s.startsWith(WIP_SUBJECT))
      return s.slice(WIP_SUBJECT.length).replace(/ \([^)]*\)$/, "") || "another task";
  }
  return null;
}

/** What `setAsideWork` did: the files taken out, or why the work stays (`kept`). */
export interface SetAsideResult {
  files: string[];
  /** Why a paused task's work stays in the folder ('"Y" built on it'); null when set aside. */
  kept: string | null;
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
  /** The sentence a task's run left about Local only (the person's changes kept), by task. */
  private readonly localOnlyWords = new Map<string, string>();
  /**
   * TM-4: the tasks whose rebuild was last held by changes nobody committed in their folder:
   * the warning is logged once per such state, not at every poll.
   */
  private readonly heldByChanges = new Set<string>();

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
    return inWorktree(dir, async () => {
      try {
        const result = await this.executeIn(ctx, target, dir);
        // merged-copy: the person changed a Local only file during the run; the task's result
        // says so first, never the pull request or the commit (they name no Local only file).
        const kept = this.localOnlyWords.get(task.id);
        return kept ? { ...result, summary: `${kept}\n\n${result.summary}` } : result;
      } finally {
        this.localOnlyWords.delete(task.id);
      }
    });
  }

  /**
   * At the daemon's start (merged-copy): a run's Local only copy that was never copied back (the
   * app closed or crashed during the run) is copied back now, by the same rules. Returns how many.
   */
  recoverLocalOnly(): number {
    return recoverLocalOnlyCopies(this.deps.worktreeRoot);
  }

  /**
   * The inner executor with the project's Local only folder in the worktree for its run
   * (merged-copy, ADR 0113): a copy an earlier run left is recovered first, the folder is
   * copied in, and back after the run whatever it returned or threw; the sentence for a file
   * the person changed meanwhile is kept for the task's result. A task branch that tracks a
   * folder named Local only (the repository started tracking one before the copy's next
   * refresh said so) gets none: its folder is the repository's, which the copy in would have
   * replaced and the pull request then deleted (review of merged-copy).
   */
  private withLocalOnly(
    task: TaskRow,
    dir: string,
    inner: TaskExecutor,
    git: GitOps,
  ): TaskExecutor {
    const folderFor = this.deps.localOnlyFor;
    if (!folderFor) return inner;
    const back = () => {
      try {
        const words = keptBesideSentence(copyLocalOnlyBack(dir));
        if (words) this.localOnlyWords.set(task.id, words);
      } catch (e) {
        // The marker stays: the next run or the next start copies back by the same rules.
        this.logger.warn("Local only not copied back", { taskId: task.id, error: errorMessage(e) });
      }
    };
    return {
      execute: async (c) => {
        if (hasLocalOnlyCopy(dir)) back();
        const source = await folderFor(task);
        if (!source) return inner.execute(c);
        if ((await git.trackedUnder("HEAD", [LOCAL_ONLY_DIR]))?.length) {
          const why = "Local only: the task's branch has a folder of that name; none copied in";
          this.logger.info(why, { taskId: task.id });
          return inner.execute(c);
        }
        try {
          copyLocalOnlyIn({
            source,
            worktree: dir,
            taskTitle: task.title,
            now: this.deps.clock.nowIso(),
          });
        } catch (e) {
          // The run goes on without the folder; nothing of the person's was moved.
          this.logger.warn("Local only not copied into the run", {
            taskId: task.id,
            error: errorMessage(e),
          });
          back();
          return inner.execute(c);
        }
        try {
          return await inner.execute(c);
        } finally {
          back();
        }
      },
    };
  }

  /** The git of a task's worktree, with the person's token scoped to the clone URL's origin. */
  private async gitFor(target: Target, dir: string): Promise<GitOps> {
    const auth = gitAuthFor(await resolveGitToken(this.deps.token), target.clone);
    return new GitOps({
      cwd: dir,
      // Scoped to the clone URL's origin; a local path or SSH remote gets no header.
      auth,
      identity: this.deps.identity,
      // merged-copy: no push of a task branch carries Local only or a review's try folder.
      neverPush: NEVER_PUSHED,
      // TM-6: a refused push is told apart by git's words (`pushFailedWords`), in any language.
      untranslated: true,
    });
  }

  private async executeIn(
    ctx: ExecuteCtx,
    target: Target,
    dir: string,
  ): Promise<TaskExecutionResult> {
    const { task } = ctx;
    let branch = task.branch || this.deps.branchFor?.(task) || taskBranchName(task);
    mkdirSync(this.deps.worktreeRoot, { recursive: true });
    const auth = gitAuthFor(await resolveGitToken(this.deps.token), target.clone);
    const git = await this.gitFor(target, dir);
    // The person's answer to the task's last conflict card, read first (TM-2): after "I resolved
    // it", a rebase or merge under way in the folder is the person's resolution, which the run
    // finishes (`continueResolved`), never a crash's leftover to end.
    const answered = await this.conflictAnswer(task);
    if (existsSync(join(dir, ".git"))) {
      await git.fetch();
      if (answered?.outcome !== "resolved") await this.cleanAfterCutShortRun(git, task);
    } else await git.clone(target.clone);
    // merged-copy, W6-26: Local only and a review's try folder are never staged, whatever
    // .gitignore the project has (the push checks it again: a forced add gets past this). A
    // repository that tracks a folder named Local only keeps it as its own: only the try's.
    const excluded = await this.excludedFolders(git, target);
    excludeNeverPushed(dir, excluded, { dropOthers: true });
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
    if (answered?.outcome === "resolved") {
      if (!task.branch) await this.deps.store.task.patch(task.id, { branch });
      return this.continueResolved(ctx, { git, dir, branch, target, answered });
    }
    const dropped = answered?.outcome === "dropped";
    let existingPr: PullRequestInfo | undefined = (
      await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch })
    )[0];
    // R-branch (leftovers7-merge): a pull request on this branch that another task opened is
    // never this task's to resume or push onto. A name made before branch names were unique
    // per task (two tasks titled alike within 65 s shared one) moves to the task's own name.
    const another = !!existingPr && openedForAnotherTask(existingPr, task.id);
    if (another) {
      branch = await this.unusedBranch(git, target, taskBranchName(task));
      existingPr = undefined;
    }
    // A redo of a task whose pull request was merged or closed starts again on a fresh branch
    // (the old name with a short suffix): a branch GitHub keeps after a merge (delete-on-merge
    // off) never makes its push fail, and the old pull request stays as it was.
    if (task.branch && !existingPr && !another)
      branch = await this.freshBranch(git, target, task.branch);
    if (branch !== task.branch) await this.deps.store.task.patch(task.id, { branch });
    // budget-resume: the task's own work in progress (a pause, a question, a stop) on its local
    // branch: this run continues from it. "Drop the branch and retry from scratch" drops it.
    // TM-3 (leftovers7-tailmerge): after the drop, work in progress a run made from the base
    // (`wipFromBaseRef`, a redo that paused before review) is continued, never dropped again;
    // the host's branch, which holds the work the person dropped, is never brought into it, and
    // the push replaces it. Before, the drop stayed in force until a run reached review, so each
    // run after a pause started from the base again and lost the work since the redo.
    const restarted = dropped ? await this.workInProgressFromBase(git, task, branch) : null;
    const wip = dropped ? restarted : await this.workInProgress(git, task, branch);
    if (!wip) await git.setRef(wipRef(task.id), null);
    if (!restarted) await git.setRef(wipFromBaseRef(task.id), null);
    const resume = (!!existingPr && !dropped) || !!wip;
    // C-49 (ADR 0106): the done tasks this one waits for whose pull requests are not merged
    // yet. Their branches are merged into this task's before it runs, so it sees their work;
    // its own pull request still targets the default branch.
    let unmerged = await this.unmergedDependencies(task, target);
    if (resume) {
      if (wip) {
        // The local branch as the last run left it (never `checkout -B` from the host); what a
        // person pushed to the host's copy meanwhile is brought in by a merge.
        await git.checkout(wip);
        if (
          !restarted &&
          (await git.hasRef(`origin/${branch}`)) &&
          !(await git.isAncestor(`origin/${branch}`))
        ) {
          const merged = await git.mergeFrom(`origin/${branch}`, `Bring in ${branch}`);
          if (!merged.ok)
            return this.conflict(ctx, {
              git,
              dir,
              branch,
              target,
              conflicts: merged.conflicts,
              costUsdMicro: 0,
              force: !!restarted,
              superseded: answered?.row ?? null,
              merging: true,
            });
        }
      } else await git.createBranch(branch, `origin/${branch}`);
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
          force: !!restarted,
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
              force: !!restarted,
              superseded: answered?.row ?? null,
              merging: true,
            });
          await this.setDepsBase(git, built.sha, built.held);
        }
      } else if (wip && !(await git.isAncestor(`origin/${target.base}`))) {
        // budget-resume: work in progress is brought up to date by merging the base in, never
        // rebased (ADR 0111's no-replay rule: it may be on the host already). A conflict goes
        // to the person's conflict card, never a git error.
        const merged = await git.mergeFrom(`origin/${target.base}`, mergeMessage([], target.base));
        if (!merged.ok)
          return this.conflict(ctx, {
            git,
            dir,
            branch,
            target,
            conflicts: merged.conflicts,
            costUsdMicro: 0,
            force: !!restarted,
            superseded: answered?.row ?? null,
            merging: true,
          });
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

    const inner = this.withLocalOnly(
      task,
      dir,
      this.deps.inner.withWorktree ? this.deps.inner.withWorktree(dir) : this.deps.inner,
      git,
    );
    const result = await inner.execute({ ...ctx, task: { ...task, branch } });
    // budget-resume: a run that stopped before its work was done keeps it as a commit on the
    // task's own branch (its next run continues from it); a failed run's leftovers are set
    // aside, so the next attempt starts clean (W6-24).
    if (WIP_OUTCOMES.has(result.outcome))
      return this.saveWorkInProgress(ctx, { git, dir, branch, target, result, fromBase: dropped });
    if (result.outcome === "failed" || result.outcome === "timeout") {
      await this.setLeftoversAside(git, task);
      return result;
    }
    if (result.outcome !== "done" && result.outcome !== "in_review") return result;

    // A commit message is plain text: no markdown marks, no lesson lines (L-19).
    const commit = await git.commitAll(
      `${task.title}\n\n${plainReport(result.summary).slice(0, 500)}\n\nTask ${task.id}.`,
    );
    // TM-1 (leftovers7-tailmerge): whether the branch holds any change of the task's own, from
    // where its work starts (the base, with the work it builds on), not whether this run
    // committed: a redo from the base ("Drop the branch and retry from scratch", a card's Redo)
    // that commits nothing holds nothing, although a pull request is open (before, main's head
    // was force-pushed to it and the empty pull request went to review and then to Merge); a run
    // that continues a paused task's work and adds nothing more still holds that work.
    if (!(await this.holdsOwnChange(git, target, excluded, commit.committed || !!existingPr))) {
      const why = dropped ? "redone" : "empty";
      const closed = existingPr ? await this.closeEmptied(target, existingPr, task, why) : false;
      return {
        ...result,
        outcome: "failed",
        // L-18 (polish-words): what went wrong first, in plain words; the run's own report
        // after it without markdown (it read "failed: **Result: …** `README.md` …").
        summary:
          closed && existingPr
            ? emptiedSentence(existingPr.number, why, target.base)
            : emptyChangeSummary(result.summary),
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
    // TM-1's sibling (leftovers7-tailmerge fix-up): brought up to date, the branch may hold no
    // change of its own any more: the base already has the same change (the rebase drops a
    // commit the base has; merging the base in leaves nothing). Read again before the push.
    // Before, the base's head was force-pushed to the open pull request, which went to review
    // empty and was offered for Merge (a Tasks-tab Redo or a rework of a task whose change had
    // reached main), and a fresh task's push opened an empty pull request.
    if (!(await this.holdsOwnChange(git, target, excluded, true)))
      return this.endUpToDate(task, target, existingPr, {
        ...result,
        outcome: "failed",
        checksPassed: false,
      });
    let changedFiles: string[] = [];
    try {
      // The task's own work: from the base it started on (the default branch with the work it
      // builds on), never the dependencies' files.
      changedFiles = (await git.hasRef(DEPS_BASE_REF))
        ? await git.filesBetween(DEPS_BASE_REF)
        : await git.changedFiles(`origin/${target.base}`);
      // Never the work's: Local only and a review's try folder (merged-copy); a Local only the
      // repository tracks is its own, and a file the task wrote there is its work (R-exclude).
      changedFiles = changedFiles.filter((f) => underNeverPushed([f], excluded).length === 0);
    } catch {
      // the diff is informational (peer overlap detection); never fail the PR for it
    }
    // budget-resume: work in progress pushed earlier ("Push unfinished work to GitHub") is
    // Forerunner's own branch with no pull request yet: a rebase onto the base replaces it.
    const pushedWip = !!wip && !existingPr && (await git.hasRef(`origin/${branch}`));
    try {
      await git.push(branch, {
        force: !!existingPr || replace || pushedWip,
        defaultBranch: target.base,
      });
    } catch (e) {
      return {
        outcome: "failed",
        // merged-copy: the push guard's own sentence (a forced add of a Local only file).
        summary: isNeverPushed(e)
          ? errorMessage(e)
          : pushFailedWords(`${target.repo.owner}/${target.repo.name}`, branch, e),
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
    // The work went to review: nothing of it is in progress any more.
    await git.setRef(wipRef(task.id), null);
    await git.setRef(wipFromBaseRef(task.id), null);
    this.logger.info("pull request ready", {
      taskId: task.id,
      branch,
      prUrl,
      buildsOn: unmerged.map((d) => d.number),
    });
    return { ...result, outcome: "in_review", prUrl, branch, changedFiles };
  }

  /**
   * The task's local branch when it holds the task's work in progress (`wipRef` is in it), else
   * null; a marker the branch no longer holds is stale and removed.
   */
  private async workInProgress(git: GitOps, task: TaskRow, branch: string): Promise<string | null> {
    const marker = await git.resolveRef(wipRef(task.id));
    if (!marker) return null;
    const local = await git.resolveRef(`refs/heads/${branch}`);
    if (local && (await git.isAncestor(marker, local))) return branch;
    await git.setRef(wipRef(task.id), null);
    return null;
  }

  /**
   * TM-3: the task's work in progress when a run made it from the base after the person's drop
   * (`wipFromBaseRef` marks the same commit as `wipRef`, on the task's local branch), else null.
   * Work in progress from before the drop is never this: the first run after the drop removes
   * its marker before anything else.
   */
  private async workInProgressFromBase(
    git: GitOps,
    task: TaskRow,
    branch: string,
  ): Promise<string | null> {
    const fromBase = await git.resolveRef(wipFromBaseRef(task.id));
    if (!fromBase || fromBase !== (await git.resolveRef(wipRef(task.id)))) return null;
    return this.workInProgress(git, task, branch);
  }

  /**
   * The folders a task branch of this repository never stages (merged-copy, W6-26): Local only
   * and a review's try folder, or only the try's when the base tracks a folder named Local only
   * (the repository's own, R-exclude).
   */
  private async excludedFolders(git: GitOps, target: Target): Promise<readonly string[]> {
    const tracked = await git.trackedUnder(`origin/${target.base}`, [LOCAL_ONLY_DIR]);
    return tracked?.length ? [TRY_DIR] : NEVER_PUSHED;
  }

  /**
   * TM-1: whether the checked-out branch holds a change of the task's own (a file it changes
   * from where its work started: `DEPS_BASE_REF`, else the base), never counting Local only or a
   * review's try folder. A git failure answers `fallback` (the old rule: this run committed, or a
   * pull request is open), so an unreadable diff never fails a run that did work.
   */
  private async holdsOwnChange(
    git: GitOps,
    target: Target,
    excluded: readonly string[],
    fallback: boolean,
  ): Promise<boolean> {
    try {
      const files = (await git.hasRef(DEPS_BASE_REF))
        ? await git.filesBetween(DEPS_BASE_REF)
        : await git.changedFiles(`origin/${target.base}`);
      return files.some((f) => underNeverPushed([f], excluded).length === 0);
    } catch (e) {
      this.logger.warn("the task's own change was not read", { error: errorMessage(e) });
      return fallback;
    }
  }

  /**
   * TM-1 (ADR 0111, leftovers7-tailmerge): a run that left its branch with no change of its own
   * while a pull request is open on it closes that pull request, with one comment saying why,
   * instead of pushing the base's head to it (an empty pull request the app would offer for
   * Merge). Its branch on the host is kept as it was. After a redo from the base, the pull
   * request holds only the work the person dropped; otherwise it holds no change either, or
   * (`up_to_date`) what it changes is in the base already. False when the host refused (the pull
   * request then stays as it was, and so does the branch).
   */
  private async closeEmptied(
    target: Target,
    pr: PullRequestInfo,
    task: TaskRow,
    why: EmptiedWhy,
  ): Promise<boolean> {
    const said =
      why === "redone"
        ? `Forerunner did this task again from ${target.base} and it changed nothing, so this pull request is closed. Its branch is kept.`
        : why === "up_to_date"
          ? `Brought up to date with ${target.base}, this task's work no longer changes anything, so this pull request is closed. Its branch is kept.`
          : "Forerunner's last run of this task changed nothing and this pull request holds no change, so it is closed. Its branch is kept.";
    try {
      await this.deps.host.commentOnPullRequest(target.repo, pr.number, said);
    } catch (e) {
      this.logger.warn("emptied pull request not commented", {
        taskId: task.id,
        pr: pr.number,
        error: errorMessage(e),
      });
    }
    try {
      await this.deps.host.updatePullRequest(target.repo, pr.number, { state: "closed" });
      this.logger.info("pull request closed: the run changed nothing", {
        taskId: task.id,
        pr: pr.number,
        why,
      });
      return true;
    } catch (e) {
      this.logger.warn("emptied pull request not closed", {
        taskId: task.id,
        pr: pr.number,
        error: errorMessage(e),
      });
      return false;
    }
  }

  /**
   * TM-1's sibling (leftovers7-tailmerge fix-up): a branch brought up to date with the base that
   * no longer holds any change of its own is not pushed. The pull request open on it is closed
   * (`closeEmptied`, `up_to_date`), its branch on the host kept as it was, and the task fails in
   * one sentence, as a task with no change does ("#4 no longer changes anything on main, so it
   * was closed.", or "main already has this change." when no pull request was closed).
   */
  private async endUpToDate(
    task: TaskRow,
    target: Target,
    pr: PullRequestInfo | undefined,
    result: TaskExecutionResult,
  ): Promise<TaskExecutionResult> {
    const closed = pr ? await this.closeEmptied(target, pr, task, "up_to_date") : false;
    this.logger.info("not pushed: the branch holds no change of its own once up to date", {
      taskId: task.id,
      pr: pr?.number ?? null,
    });
    return {
      ...result,
      summary: emptiedSentence(closed && pr ? pr.number : null, "up_to_date", target.base),
    };
  }

  /** The task's own files on its branch: from the base its work started on, never Local only. */
  private async ownFiles(git: GitOps, target: Target): Promise<string[]> {
    try {
      const files = (await git.hasRef(DEPS_BASE_REF))
        ? await git.filesBetween(DEPS_BASE_REF)
        : await git.changedFiles(`origin/${target.base}`);
      const excluded = await this.excludedFolders(git, target);
      return files.filter((f) => underNeverPushed([f], excluded).length === 0);
    } catch {
      return [];
    }
  }

  /**
   * budget-resume (ADR 0112 amended): a run that stopped before its work was done (a pause, a
   * question for the person, a credential's limit, a stop) leaves it as one commit on the task's
   * own branch, "Work in progress: <title> (paused at its budget)" with its "Where I stopped" and
   * "Left to do", and `wipRef` marks it: the next run continues from it. Pushed to the host only
   * with the project's "Push unfinished work to GitHub" on (through the same guard as every
   * push: no Local only file leaves this computer). A git failure here is logged; the run's
   * result stands, and the files stay where they are.
   */
  private async saveWorkInProgress(
    ctx: ExecuteCtx,
    s: {
      git: GitOps;
      dir: string;
      branch: string;
      target: Target;
      result: TaskExecutionResult;
      /** The run started from the base after a drop (TM-3): its work is marked as such. */
      fromBase?: boolean;
    },
  ): Promise<TaskExecutionResult> {
    const { task } = ctx;
    const { git, dir, branch, target, result } = s;
    let committed = false;
    try {
      committed = (await git.commitAll(workInProgressMessage(task, result))).committed;
      if (committed || (await git.hasRef(wipRef(task.id)))) {
        const head = await git.headSha();
        await git.setRef(wipRef(task.id), head);
        if (s.fromBase) await git.setRef(wipFromBaseRef(task.id), head);
      }
    } catch (e) {
      this.logger.warn("work in progress not committed", {
        taskId: task.id,
        error: errorMessage(e),
      });
      return result;
    }
    const changedFiles = (await git.hasRef(wipRef(task.id)))
      ? await this.ownFiles(git, target)
      : [];
    let summary = result.summary;
    if (committed && (await this.deps.pushUnfinishedFor?.(task))) {
      try {
        await git.push(branch, { force: true, defaultBranch: target.base });
      } catch (e) {
        this.logger.warn("work in progress not pushed", {
          taskId: task.id,
          error: errorMessage(e),
        });
        summary = `${summary} ${
          isNeverPushed(e)
            ? errorMessage(e)
            : `Its work in progress stays on this computer: ${pushFailedWords(`${target.repo.owner}/${target.repo.name}`, branch, e)}`
        }`;
      }
    }
    this.logger.info("work in progress kept", {
      taskId: task.id,
      outcome: result.outcome,
      committed,
      files: changedFiles.length,
    });
    return {
      ...result,
      summary,
      branch,
      worktree: dir,
      ...(changedFiles.length ? { changedFiles } : {}),
    };
  }

  /**
   * R-dirtyworktree (W6-24 for a crash): a run the app's close or a crash cut short leaves its
   * files uncommitted in the task's worktree, with no work-in-progress commit (that and the
   * leftovers set aside happen only after the inner executor returns). Before, the next run
   * carried them into its work, or git refused its checkout ("untracked working tree files
   * would be overwritten"). Now a step left half done (a rebase, a merge) is ended and the
   * leftovers are set aside under the failed ref, as a failed run's are, so the run starts clean
   * and nothing is lost. A work-in-progress commit is untouched: it is committed, not leftovers.
   */
  private async cleanAfterCutShortRun(git: GitOps, task: TaskRow): Promise<void> {
    try {
      const ended = await git.abortUnfinished();
      if (ended.length)
        this.logger.info("a cut-short run's unfinished git step was ended", {
          taskId: task.id,
          ended,
        });
      if ((await git.status()).dirty) await this.setLeftoversAside(git, task);
    } catch (e) {
      this.logger.warn("a cut-short run's leftovers were not set aside", {
        taskId: task.id,
        error: errorMessage(e),
      });
    }
  }

  /**
   * W6-24: what a failed run left uncommitted in the task's worktree goes out of the way (kept
   * under `failedRef`), so the next attempt starts from the branch's last commit: before, the
   * next run's checkout carried the files over, or git refused when main had changed them.
   */
  private async setLeftoversAside(git: GitOps, task: TaskRow): Promise<void> {
    try {
      const files = await git.setAside(
        failedRef(task.id),
        `Left by a failed run of "${task.title.replace(/\s+/g, " ").trim()}" (task ${task.id})`,
      );
      if (files.length)
        this.logger.info("a failed run's leftovers were set aside", {
          taskId: task.id,
          files: files.slice(0, 20),
        });
    } catch (e) {
      this.logger.warn("a failed run's leftovers were not set aside", {
        taskId: task.id,
        error: errorMessage(e),
      });
    }
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
    return this.unusedBranch(git, target, current.replace(/-r\d+$/, ""), 2);
  }

  /**
   * `stem` when neither the host nor a pull request has used it, else `<stem>-r<n>` for the
   * first unused n (from `from`).
   */
  private async unusedBranch(git: GitOps, target: Target, stem: string, from = 1): Promise<string> {
    for (let n = from; n < 100; n++) {
      const name = n === 1 ? stem : `${stem}-r${n}`;
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
      const carries = !!tip && (await git.isAncestor(e.sha, tip));
      if (carries || !tip)
        return { ...base, number: open.number, state: carries ? "open" : "redone" };
      const rebuilt = await this.rebuiltTo(dep.id, e.sha);
      const follows =
        !!rebuilt && (await git.hasRef(rebuilt)) && (await git.isAncestor(rebuilt, tip));
      // R-chain: the same change on a new head: kept, and the dependent is brought onto it.
      return follows
        ? { ...base, number: open.number, state: "open", rebuilt: true }
        : { ...base, number: open.number, state: "redone" };
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
    // R-chain: a dependency kept that was itself rebuilt since is followed onto its new head
    // (in a chain whose middle could not be rebuilt at first, the third still held the old one).
    if (!dropped.length && !kept.some((k) => k.rebuilt)) return out;
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
    // R-chain: a task rebuilt here is a change for the tasks after it too (they hold its old
    // head), so a later one is looked at when it holds any of them.
    const changed = [changedDependencyTaskId];
    for (const { task } of todo) {
      const o = await this.rebuildTask(task, hooks, changed);
      if (o.result === "rebuilt") changed.push(task.id);
      out.push(o);
    }
    return out;
  }

  /**
   * One done task's branch against what it builds on (`rebuildDependents`; the runtime also
   * asks it right before an accepted task's merge). `onlyIfHolding`: skip the task (no host
   * call) when its worktree holds none of those dependencies.
   */
  async rebuildTask(
    task: TaskRow,
    hooks: RebuildHooks = {},
    onlyIfHolding?: string | readonly string[],
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

  /**
   * W15-02: a rebuild this folder made whose push never went through (the app stopped between
   * the two) is put back: the branch as GitHub has it, the marker and the held refs as they were.
   * Only while the branch is still exactly that rebuild and nothing is left uncommitted: a commit
   * the person made on top of it stays, and `folderHold` holds the rebuild for it.
   */
  private async undoUnpushedRebuild(git: GitOps, branch: string): Promise<void> {
    const pending = await git.resolveRef(REBUILD_PENDING_REF);
    if (!pending) return;
    if ((await git.resolveRef(`refs/heads/${branch}`)) !== pending) return;
    if (!(await git.hasRef(`origin/${branch}`)) || (await git.status()).dirty) return;
    await git.createBranch(branch, `origin/${branch}`);
    const before = await git.refsUnder(REBUILD_BEFORE_PREFIX);
    const marker = before.find((r) => r.ref === `${REBUILD_BEFORE_PREFIX}deps-base`)?.sha ?? null;
    await git.setRef(DEPS_BASE_REF, marker);
    for (const h of await git.refsUnder(DEPS_HELD_PREFIX)) await git.setRef(h.ref, null);
    for (const r of before)
      if (r.ref !== `${REBUILD_BEFORE_PREFIX}deps-base`)
        await git.setRef(`refs/forerunner/${r.ref.slice(REBUILD_BEFORE_PREFIX.length)}`, r.sha);
    await clearUnpushedRebuild(git);
    this.logger.info("an unpushed rebuild was put back", { branch });
  }

  private async rebuildIn(
    task: TaskRow,
    dir: string,
    hooks: RebuildHooks,
    onlyIfHolding?: string | readonly string[],
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
    // W15-02: a rebuild of this folder that never reached GitHub (the app stopped between the
    // rebuild and its push) is put back first, markers included, so it is made again below.
    await this.undoUnpushedRebuild(git, branch);
    // Cheap first: a worktree without the marker, or one whose held refs name none of the
    // dependencies that changed, has nothing to rebuild (a marker made before the held refs is
    // read in full).
    if (!(await git.hasRef(DEPS_BASE_REF))) return none;
    if (onlyIfHolding) {
      const ids = typeof onlyIfHolding === "string" ? [onlyIfHolding] : onlyIfHolding;
      const held = await git.refsUnder(DEPS_HELD_PREFIX);
      const holds = held.some((h) => ids.some((id) => h.ref === depsHeldRef(id)));
      if (held.length && !holds) return none;
    }
    const pr = (
      await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch })
    )[0];
    if (!pr) return none;
    const found = { ...none, prNumber: pr.number, prUrl: pr.htmlUrl };
    await git.fetch();
    const hostHead = await git.resolveRef(`origin/${branch}`);
    if (!hostHead) return found;
    // Read first, without touching the worktree: nothing it holds went away is the usual case
    // (only the "Builds on" line may need to follow a dependency merged with a merge commit).
    const held0 = await git.resolveRef(DEPS_BASE_REF);
    if (held0 && (await git.isAncestor(held0, hostHead))) {
      const held = await this.heldDependencies(git, task, target, held0);
      if (!held.some((h) => (h.state !== "open" && h.state !== "in_main") || h.rebuilt)) {
        await this.syncBuildsOn(
          target,
          pr.number,
          held.filter((h) => h.state === "open"),
        );
        return found;
      }
    }
    // Work nobody committed (a person's change after the run) is never swept into a rebuild,
    // and a commit of the person's that GitHub does not have is never reset away (W15-02: the
    // rebuild starts from GitHub's branch, so before it ended on no branch, without a word).
    // TM-4: said once while the folder stays so (before, a WARN at every poll); the rows say it
    // (`held`, persisted on the record by the runtime at this poll, W15-05).
    const held = await folderHold(git, branch, target.base);
    if (held) {
      const key = `${task.id}:${held}`;
      if (!this.heldByChanges.has(key)) {
        this.heldByChanges.add(key);
        this.logger.warn(
          held === "changes"
            ? "dependent branch not rebuilt: its worktree has uncommitted changes"
            : "dependent branch not rebuilt: its worktree has a commit GitHub does not have",
          { taskId: task.id },
        );
      }
      return { ...found, result: "busy", held };
    }
    this.heldByChanges.delete(`${task.id}:changes`);
    this.heldByChanges.delete(`${task.id}:commits`);
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
    /** The branch and its markers back to what the host has: the next try rebuilds again. */
    const putBack = async () => {
      await git.createBranch(branch, `origin/${branch}`);
      await git.setRef(DEPS_BASE_REF, marker);
      for (const h of await git.refsUnder(DEPS_HELD_PREFIX)) await git.setRef(h.ref, null);
      for (const h of heldRefs) await git.setRef(h.ref, h.sha);
      await clearUnpushedRebuild(git);
    };
    // W15-02: until its push went through, the rebuild is Forerunner's own unpushed state, with
    // what to put back (a stop of the app between the two is undone at the next try).
    if (r.after) await markUnpushedRebuild(git, r.after, marker, heldRefs);
    try {
      const push = (await hooks.beforePush?.(r, { number: pr.number, url: pr.htmlUrl })) ?? true;
      if (!r.after) return { ...found, result: "conflict", rebuild: r };
      if (!push) {
        // Held: the branch and its marker go back to what the host has; the next try rebuilds.
        await putBack();
        return { ...found, result: "held", rebuild: r };
      }
      await git.push(branch, { force: true, defaultBranch: target.base });
    } catch (e) {
      // A push refused or cut short (or the record's step before it): nothing of the rebuild
      // stays in the folder, so the next try rebuilds from GitHub's branch with its markers.
      if (r.after) await putBack().catch(() => undefined);
      throw e;
    }
    await clearUnpushedRebuild(git);
    await this.syncBuildsOn(target, pr.number, r.kept);
    this.logger.info("dependent pull request rebuilt", {
      taskId: task.id,
      pr: pr.number,
      dropped: r.dropped.map((d) => d.number),
    });
    return { ...found, result: "rebuilt", rebuild: r };
  }

  /**
   * R-conflict (leftovers7-merge2): the files the task's branch, as the host has it, conflicts
   * in with the base branch now, read in its worktree (fetched first). Null when the folder is
   * gone or busy, or git could not tell: the caller says it without the files.
   */
  async conflictsWithBase(task: TaskRow): Promise<string[] | null> {
    const dir = join(this.deps.worktreeRoot, safeSegment(task.id));
    const branch = task.branch;
    if (!branch || !existsSync(join(dir, ".git"))) return null;
    try {
      return await tryWorktree(dir, async () => {
        const target = await this.deps.repoFor(task);
        if (!target) return null;
        const git = await this.gitFor(target, dir);
        await git.fetch();
        return git.conflictFiles(`origin/${branch}`, `origin/${target.base}`);
      });
    } catch (e) {
      this.logger.warn("conflicting files not read", { taskId: task.id, error: errorMessage(e) });
      return null;
    }
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

  /**
   * "Take this work out" (merged-actions, the owner's decision of 2026-11-02): a branch from the
   * default branch as the host has it, with commits that take the task's merged pull request back
   * by the way it was merged (`takeOutPlan`), pushed under `branch` (forced with a lease, so an
   * earlier take-out branch of the same task is replaced; never the default branch, and through
   * the `neverPush` guard). Works in a clone of its own (`<worktreeRoot>/<task>-take-out`), never
   * the task's worktree, so a Redo is not disturbed. Nothing is pushed when the revert conflicts
   * with later work (the files are named) or when the merge's shape cannot be undone safely.
   */
  async takeOut(req: {
    task: TaskRow;
    number: number;
    mergeSha: string;
    headSha: string | null;
    branch: string;
  }): Promise<TakeOutGitResult> {
    const target = await this.deps.repoFor(req.task);
    if (!target) return { kind: "no_repository" };
    const dir = join(this.deps.worktreeRoot, `${safeSegment(req.task.id)}-take-out`);
    return inWorktree(dir, () =>
      this.takeOutIn(dir, target, req).finally(() => {
        // The clone is not kept once the branch is pushed or the conflict named (review of
        // merged-actions: a full clone per taken-out task stayed on disk). A failure to remove
        // it is logged; the next take-out of the task fetches into what is left.
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        } catch (e) {
          this.logger.warn("take-out clone not removed", { dir, error: errorMessage(e) });
        }
      }),
    );
  }

  /** `takeOut`'s git, in its clone `dir` (under `inWorktree`). */
  private async takeOutIn(
    dir: string,
    target: Target,
    req: {
      task: TaskRow;
      number: number;
      mergeSha: string;
      headSha: string | null;
      branch: string;
    },
  ): Promise<TakeOutGitResult> {
    const git = await this.gitFor(target, dir);
    if (existsSync(join(dir, ".git"))) await git.fetch();
    else {
      mkdirSync(this.deps.worktreeRoot, { recursive: true });
      await git.clone(target.clone);
    }
    const base = `origin/${target.base}`;
    if (!(await git.hasRef(req.mergeSha)) || !(await git.isAncestor(req.mergeSha, base)))
      return { kind: "not_in_main" };
    let head = req.headSha;
    if (head && !(await git.hasRef(head))) await git.fetchRef(`refs/pull/${req.number}/head`);
    if (head && !(await git.hasRef(head))) head = null;
    const plan = await takeOutPlan(git, req.mergeSha, head);
    if (!plan) return { kind: "unknown_shape" };
    // R-takeoutdep (leftovers7-merge): a merge commit whose merged side carries work of a task
    // this one built on (a dependency merged by GitHub through it, out of dependency order) is
    // not reverted whole with -m 1, which took the dependency's work out of main too.
    if (plan.mainline && (await this.carriesDependencyWork(git, req.task, req.mergeSha)))
      return { kind: "unknown_shape" };
    await git.createBranch(req.branch, base);
    const reverted = await git.revert(plan.commits, plan.mainline ? { mainline: 1 } : {});
    if (!reverted.ok) {
      await git.resetHard(base);
      return { kind: "conflict", files: reverted.conflicts };
    }
    await git.push(req.branch, { force: true, defaultBranch: target.base });
    this.logger.info("work taken out", {
      taskId: req.task.id,
      how: plan.how,
      commits: plan.commits.length,
    });
    return {
      kind: "pushed",
      branch: req.branch,
      base: target.base,
      repo: target.repo,
      how: plan.how,
      sure: plan.sure,
      commits: plan.commits,
    };
  }

  /**
   * Whether the merge commit `mergeSha` brought in, on its merged side, a commit of a task
   * `task` waits for (directly or through others) that main did not have before it: the
   * dependency's branch on the host, or the commit its merge record reviewed.
   */
  private async carriesDependencyWork(
    git: GitOps,
    task: TaskRow,
    mergeSha: string,
  ): Promise<boolean> {
    const [before, merged] = await git.parentsOf(mergeSha);
    if (!before || !merged) return false;
    const seen = new Set<string>([task.id]);
    const queue = [...(task.depends_on ?? [])];
    while (queue.length) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const dep = await this.deps.store.task.get(id);
      if (!dep) continue;
      queue.push(...(dep.depends_on ?? []));
      const heads = new Set<string>();
      const record = await this.deps.store.mergeRecord.forTask(dep.id).catch(() => undefined);
      if (record?.reviewed_head_sha) heads.add(record.reviewed_head_sha);
      if (dep.branch) {
        const onHost = await git.resolveRef(`origin/${dep.branch}`);
        if (onHost) heads.add(onHost);
      }
      for (const sha of heads) {
        if (!(await git.hasRef(sha))) continue;
        if ((await git.isAncestor(sha, merged)) && !(await git.isAncestor(sha, before)))
          return true;
      }
    }
    return false;
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
    return (await this.setAsideWork(task, { running: true })).files;
  }

  /**
   * budget-resume: a cancelled task's work set aside, Undo bringing it back (`bringBack`). Its
   * work in progress (`wipRef`: a pause's commit) and, for a run the cancel stopped
   * (`running`), what the run changed since. In its own worktree of a repository: the branch
   * goes back to where its work started, and a branch pushed with "Push unfinished work to
   * GitHub" leaves the host (no pull request is open on it). In the project's folder, which
   * every task shares: only while no later task built on it; else its files stay and `kept`
   * says why ('"Y" built on it'). A paused task's cancel never touches what is uncommitted in
   * the shared folder: that is no work of its.
   */
  async setAsideWork(task: TaskRow, opts: { running?: boolean } = {}): Promise<SetAsideResult> {
    const workspace = (await this.deps.workspaceFor?.(task)) ?? null;
    if (workspace) {
      if (!existsSync(join(workspace, ".git"))) return { files: [], kept: null };
      return this.setAsideInFolder(task, workspace, !!opts.running);
    }
    const dir = join(this.deps.worktreeRoot, safeSegment(task.id));
    if (!existsSync(join(dir, ".git"))) return { files: [], kept: null };
    return inWorktree(dir, () => this.setAsideInWorktree(task, dir));
  }

  private async setAsideInWorktree(task: TaskRow, dir: string): Promise<SetAsideResult> {
    const target = await this.deps.repoFor(task);
    const git = target
      ? await this.gitFor(target, dir)
      : new GitOps({ cwd: dir, identity: this.deps.identity ?? WORKSPACE_IDENTITY });
    if (!(await git.hasCommits())) return { files: [], kept: null };
    const message = `Set aside: "${task.title}" was cancelled (task ${task.id})`;
    const files = new Set(await git.setAside(setAsideRef(task.id), message));
    const marker = await git.resolveRef(wipRef(task.id));
    if (marker && target) {
      const start = (await git.hasRef(DEPS_BASE_REF)) ? DEPS_BASE_REF : `origin/${target.base}`;
      for (const f of await this.ownFiles(git, target)) files.add(f);
      await git.setRef(setAsideWipRef(task.id), await git.headSha());
      await git.setRef(wipRef(task.id), null);
      await git.resetHard(start);
      const branch = task.branch;
      if (branch && branch !== target.base && (await git.hasRef(`origin/${branch}`))) {
        const open = await this.deps.host
          .listPullRequests(target.repo, { state: "open", head: branch })
          .catch(() => [{ number: 0 }]);
        if (!open.length) {
          const gone = await git
            .deleteRemoteBranch(branch, { defaultBranch: target.base })
            .catch(() => false);
          if (!gone)
            this.logger.warn("a cancelled task's pushed work stays on the host", {
              taskId: task.id,
              branch,
            });
        }
      }
    }
    return { files: [...files].sort(), kept: null };
  }

  private async setAsideInFolder(
    task: TaskRow,
    dir: string,
    running: boolean,
  ): Promise<SetAsideResult> {
    const git = new GitOps({ cwd: dir, identity: this.deps.identity ?? WORKSPACE_IDENTITY });
    if (!(await git.hasCommits())) return { files: [], kept: null };
    const title = task.title.replace(/\s+/g, " ").trim();
    const files = new Set(
      running
        ? await git.setAside(
            setAsideRef(task.id),
            `Set aside: "${task.title}" was cancelled (task ${task.id})`,
          )
        : [],
    );
    const marker = await git.resolveRef(wipRef(task.id));
    if (!marker) return { files: [...files].sort(), kept: null };
    const later = (await git.isAncestor(marker)) ? await git.subjectsBetween(marker) : null;
    const builtOn = later === null ? "another task" : builtOnBy(later);
    if (builtOn) return { files: [...files].sort(), kept: `"${builtOn}" built on it` };
    const taken = await git.applyCommitted(
      marker,
      `Set aside: "${title}" was cancelled (task ${task.id})`,
      { reverse: true },
    );
    if (!taken.ok) return { files: [...files].sort(), kept: "its files changed since" };
    await git.setRef(setAsideWipRef(task.id), marker);
    await git.setRef(wipRef(task.id), null);
    for (const f of taken.files) files.add(f);
    return { files: [...files].sort(), kept: null };
  }

  /**
   * Undo of a cancel: what `setAsideWork` took out goes back. Its work in progress comes back as
   * work in progress (in a repository, the branch as it was; in the project's folder, one commit
   * "Work in progress: <title> (brought back)"), so its next run continues from it; what a
   * stopped run changed comes back uncommitted on top. `conflict`: the folder changed since in
   * the same places, and nothing is put back.
   */
  async bringBack(
    task: TaskRow,
  ): Promise<{ result: "restored"; files: string[] } | { result: "missing" | "conflict" }> {
    const workspace = (await this.deps.workspaceFor?.(task)) ?? null;
    const dir = workspace ?? join(this.deps.worktreeRoot, safeSegment(task.id));
    if (!existsSync(join(dir, ".git"))) return { result: "missing" };
    const target = workspace ? null : await this.deps.repoFor(task);
    const git = target
      ? await this.gitFor(target, dir)
      : new GitOps({ cwd: dir, identity: this.deps.identity ?? WORKSPACE_IDENTITY });
    if (!(await git.hasCommits())) return { result: "missing" };
    const back = new Set<string>();
    const aside = await git.resolveRef(setAsideWipRef(task.id));
    if (aside) {
      if (workspace) {
        const title = task.title.replace(/\s+/g, " ").trim();
        const r = await git.applyCommitted(
          `${aside}`,
          `${WIP_SUBJECT}${title} (brought back)\n\nTask ${task.id}.`,
        );
        if (!r.ok) return { result: "conflict" };
        for (const f of r.files) back.add(f);
      } else {
        if ((await git.status()).dirty) return { result: "conflict" };
        await git.resetHard(aside);
        for (const f of target ? await this.ownFiles(git, target) : []) back.add(f);
        if (target && task.branch && (await this.deps.pushUnfinishedFor?.(task)))
          await git
            .push(task.branch, { force: true, defaultBranch: target.base })
            .catch((e: unknown) =>
              this.logger.warn("brought-back work in progress not pushed", {
                taskId: task.id,
                error: errorMessage(e),
              }),
            );
      }
      await git.setRef(wipRef(task.id), await git.headSha());
      await git.setRef(setAsideWipRef(task.id), null);
    }
    const loose = await git.bringBack(setAsideRef(task.id));
    if (loose.result === "conflict")
      return back.size ? { result: "restored", files: [...back] } : loose;
    if (loose.result === "restored") for (const f of loose.files) back.add(f);
    return back.size ? { result: "restored", files: [...back].sort() } : { result: "missing" };
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
    // W6-26: a review's try folder a daemon that died mid-review left is never committed.
    excludeNeverPushed(dir, [TRY_DIR]);
    // R-copystuck: the person's own git in their project's folder (Git for Windows: CRLF) puts a
    // file back as ours reads it; `init` says so in a new folder, this in one made before.
    await git.pinLineEndings().catch((e: unknown) =>
      this.logger.warn("the folder's line endings were not set in its git config", {
        error: errorMessage(e),
      }),
    );
    const before = `Workspace before "${task.title}" (task ${task.id})`;
    // budget-resume: the task's own work in progress (its pause's commit), while no later task
    // built on it, stays out of this snapshot: its files go back into this run's change set, so
    // the critic reviews the whole work. Otherwise the snapshot takes everything, as before.
    const keepOut = await this.ownWorkInProgress(git, task);
    await git.setRef(wipRef(task.id), null);
    // Another task's work in progress in the folder: this run's snapshot is made even when
    // nothing changed, so a cancel of that task knows this one built on it.
    const othersPaused = (await git.hasCommits())
      ? (await git.refsUnder("refs/forerunner/wip/")).length > 0
      : false;
    if (keepOut)
      await git.commitAllExcept(
        `${before}\n\nIts work in progress (${keepOut.files.slice(0, 5).join(", ")}${keepOut.files.length > 5 ? ", ..." : ""}) is kept out of this snapshot: its review reads the whole work.`,
        keepOut,
      );
    else await git.commitAll(before, { allowEmpty: othersPaused || !(await git.hasCommits()) });
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
    // budget-resume: a pause leaves the run's work as its own commit in the folder, so the next
    // task's snapshot (or the session's commit at its end) does not take it in as everyone's
    // starting point, and a cancel can set it aside while nothing built on it.
    if (result.outcome === "paused" && changedFiles.length) {
      try {
        await git.commitAll(workInProgressMessage(task, result));
        await git.setRef(wipRef(task.id), await git.headSha());
      } catch (e) {
        this.logger.warn("work in progress not committed in the folder", {
          taskId: task.id,
          error: errorMessage(e),
        });
      }
    }
    return { ...result, worktree: dir, ...(changedFiles.length ? { changedFiles } : {}) };
  }

  /**
   * A folder's work in progress of `task` (`wipRef`) that no later task built on: the commit's
   * parent and its files, for `commitAllExcept`. Null when it has none, or something built on it.
   */
  private async ownWorkInProgress(
    git: GitOps,
    task: TaskRow,
  ): Promise<{ rev: string; files: string[] } | null> {
    if (!(await git.hasCommits())) return null;
    const marker = await git.resolveRef(wipRef(task.id));
    if (!marker || !(await git.isAncestor(marker))) return null;
    if (builtOnBy(await git.subjectsBetween(marker))) return null;
    const files = await git.filesBetween(`${marker}~1`, marker);
    return files.length ? { rev: `${marker}~1`, files } : null;
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
    // TM-2: a rebase or merge the person left under way in this folder (the card's steps, the
    // answer given before its last command) is their resolution: finished here, never aborted.
    // A file that still holds conflict markers asks again, with the step left under way.
    const finished = await git.finishUnfinished();
    if (!finished.ok)
      return this.conflict(ctx, {
        git,
        dir,
        branch,
        target,
        conflicts: finished.conflicts,
        costUsdMicro: 0,
        force: false,
        superseded: answered.row,
        again: true,
        merging: finished.step === "merge",
      });
    // Anything else a process left half done (a revert, a cherry-pick) is ended, and changes
    // nobody committed go out of the way, as after a run cut short.
    await this.cleanAfterCutShortRun(git, ctx.task);
    const remote = await git.hasRef(`origin/${branch}`);
    const local = await git.hasRef(`refs/heads/${branch}`);
    // The person's branch: the host's, unless they resolved it here (a step just finished, or
    // the base is in the folder's branch and not in the host's: committed, not pushed). Before,
    // a resolution only in the folder was replaced by the host's branch and conflicted again.
    const here =
      local &&
      (finished.step !== null ||
        (remote &&
          (await git.isAncestor(`origin/${target.base}`, `refs/heads/${branch}`)) &&
          !(await git.isAncestor(`origin/${target.base}`, `origin/${branch}`))));
    if (here) await git.checkout(branch);
    else if (remote) await git.createBranch(branch, `origin/${branch}`);
    else if (local) await git.checkout(branch);
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
    // TM-1's sibling (leftovers7-tailmerge fix-up): a resolution that kept the base's side only
    // leaves the branch with no change of its own: it is not pushed and its pull request does
    // not go to review empty (before, the base's head was force-pushed to it and offered for
    // Merge once accepted). The answer is used.
    if (!(await this.holdsOwnChange(git, target, await this.excludedFolders(git, target), true))) {
      const open = (
        await this.deps.host.listPullRequests(target.repo, { state: "open", head: branch })
      )[0];
      await this.consume(answered.row);
      return this.endUpToDate(ctx.task, target, open, {
        outcome: "failed",
        summary: "",
        costUsdMicro: 0,
        branch,
      });
    }
    let changedFiles: string[] = [];
    try {
      changedFiles = (await git.hasRef(DEPS_BASE_REF))
        ? await git.filesBetween(DEPS_BASE_REF)
        : await git.changedFiles(`origin/${target.base}`);
    } catch {
      // informational, as above
    }
    // A branch resolved here by a rebase replaces the host's (with a lease); one resolved by a
    // merge, or taken from the host, is pushed as it is.
    const replaces = remote && !(await git.isAncestor(`origin/${branch}`));
    if (rebased || brought || !remote || replaces) {
      try {
        await git.push(branch, { force: replaces, defaultBranch: target.base });
      } catch (e) {
        return {
          outcome: "failed",
          // merged-copy: a branch that carries Local only files is refused in its own words.
          summary: isNeverPushed(e)
            ? errorMessage(e)
            : pushFailedWords(`${target.repo.owner}/${target.repo.name}`, branch, e),
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
    // W14-5 (polish-words): the card's first sentence (its title in the Inbox) names the task,
    // never its branch ("Rebase of fr/e34de89b-… onto main conflicts"); the steps below still
    // name the branch, where the person fetches it.
    const named = `"${task.title.replace(/\s+/g, " ").trim()}"`;
    const what = c.again
      ? `${named} still conflicts with ${target.base}`
      : c.rebuild
        ? `Rebuilding ${named} without ${andList(c.rebuild.dropped.map(droppedWords))} conflicts`
        : c.merging
          ? `Bringing ${target.base} and the work ${named} builds on into it conflicts`
          : `${named} conflicts with ${target.base}`;
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

  /**
   * The task's last rebase conflict request, when its answer was applied and no run used it; or
   * a later card answered with a redo from the base (`REDO_FROM_BASE_FIELD`), read as "dropped".
   */
  private async conflictAnswer(task: TaskRow): Promise<ConflictAnswer | null> {
    const rows = await this.deps.store.humanRequest.list({ task_id: task.id } as never, {
      orderBy: [
        { column: "created_at", direction: "desc" },
        { column: "id", direction: "desc" },
      ],
      limit: 50,
    });
    const redoFromBase = (r: HumanRequestRow) =>
      (r.change_card as JsonObject | null)?.[REDO_FROM_BASE_FIELD] === true;
    const last = rows.find((r) => isRebaseConflictRequest(r) || redoFromBase(r));
    const card = (last?.change_card ?? null) as JsonObject | null;
    if (!last || !card || card.consumed_at) return null;
    if (redoFromBase(last)) return { row: last, outcome: "dropped" };
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

/** What `PrTaskExecutor.takeOut` did in git (merged-actions). */
export type TakeOutGitResult =
  | {
      kind: "pushed";
      branch: string;
      base: string;
      repo: RepoRef;
      /** How the pull request had been merged, as read from git. */
      how: MergeMethod;
      /**
       * False when git cannot tell the way apart: a pull request of one commit squash-merged and
       * one rebase-merged leave the same shape (one commit on top of main with its change), so
       * the words say "merged" (review of merged-actions: a rebase read "squash-merged").
       * Absent: true.
       */
      sure?: boolean;
      /** The commits taken back, in the order reverted. */
      commits: string[];
    }
  | { kind: "conflict"; files: string[] }
  | { kind: "unknown_shape" }
  | { kind: "not_in_main" }
  | { kind: "no_repository" };

/**
 * How to take a merged pull request back, by the way it was merged (merged-actions), or null
 * when that cannot be done safely:
 * - a merge commit (two parents): `git revert -m 1 <merge>`, everything it brought in against
 *   the default branch as it was;
 * - one parent, and the pull request's own commits (`headSha`'s commits main lacks) were copied
 *   onto the default branch one by one ending at the merge commit (a rebase merge): those copies,
 *   each matched to the pull request's commit by patch id, reverted newest first;
 * - one parent whose change is the pull request's whole change (a squash): `git revert <sha>`;
 * - anything else (no head to compare with, a fast-forward, an octopus, a change that matches
 *   neither): null.
 * A pull request of one commit squash-merged or rebase-merged leaves the same shape: its one
 * commit is taken back either way, with `sure` false (the words say "merged", not which).
 */
export async function takeOutPlan(
  git: GitOps,
  mergeSha: string,
  headSha: string | null,
): Promise<{ how: MergeMethod; commits: string[]; mainline: boolean; sure: boolean } | null> {
  const parents = await git.parentsOf(mergeSha);
  if (parents.length === 2)
    return { how: "merge", commits: [mergeSha], mainline: true, sure: true };
  const parent = parents[0];
  if (parents.length !== 1 || !parent || !headSha) return null;
  const own = await git.commitsNotIn(mergeSha, headSha);
  if (!own.length) return null;
  const patchOf = async (sha: string) => {
    const first = (await git.parentsOf(sha))[0];
    return first ? git.patchId(first, sha) : null;
  };
  // A rebase: main's first-parent chain ending at the merge commit holds a copy of each.
  const chain: string[] = [];
  for (let at: string | undefined = mergeSha; at && chain.length < own.length; ) {
    chain.push(at);
    const ps: string[] = await git.parentsOf(at);
    if (ps.length !== 1) break;
    at = ps[0];
  }
  if (chain.length === own.length) {
    let same = true;
    for (let i = 0; i < own.length && same; i++) {
      const copy = chain[i] as string;
      const original = own[own.length - 1 - i] as string;
      same = (await patchOf(copy)) === (await patchOf(original));
    }
    if (same)
      return own.length > 1
        ? { how: "rebase", commits: chain, mainline: false, sure: true }
        : { how: "squash", commits: chain, mainline: false, sure: false };
  }
  // A squash: one commit whose change is the pull request's own change as a whole.
  const forked = await git.mergeBase(headSha, parent);
  if (forked && (await git.patchId(parent, mergeSha)) === (await git.patchId(forked, headSha)))
    return { how: "squash", commits: [mergeSha], mainline: false, sure: true };
  return null;
}

export function requireRepo(e: unknown): never {
  throw new ForerunnerError("validation", `project has no repository: ${errorMessage(e)}`);
}
