import {
  type DependentOutcome,
  type DependentRebuild,
  droppedWords,
  type HeldDependency,
  type PrTaskExecutor,
  type PullRequestInfo,
} from "@forerunner/capabilities";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { JsonObject, MergeRecordRow, StateStore, TaskRow } from "@forerunner/state";
import {
  type BranchCheckOptions,
  type BranchVerdict,
  fileLeftOpenRequest,
  headMovedSentence,
  leftOpenSteps,
  MERGE_LEFT_OPEN_KEY,
  MERGE_LEFT_OPEN_OPTIONS,
  type MergedEvent,
  REBUILD_CARD_OPTIONS,
  type ReviewedPrMerge,
  rebuildSteps,
} from "../loop/merge.ts";
import {
  folderWaitOver,
  MERGED_THROUGH,
  mergedThroughSentence,
  OWED_FOLDER_OUTCOMES,
  owedFolderWait,
  plainWaitForYou,
  throughNumberOf,
} from "../loop/merge-mode.ts";
import type { MergeOutcome, MergePort, MergeRequest } from "../loop/ports.ts";
import type { WatchedPullRequest } from "./githost-watcher.ts";

/**
 * Dependent branches stay true (ADR 0111, 'dependent-branches'). A task that waits for a done
 * task whose pull request is not merged yet builds on that work (its branch holds the
 * dependency's commits, ADR 0106). When the dependency is merged, closed or redone, what the
 * dependent's branch holds must follow, and a review that read work which is gone must not let
 * the pull request merge unseen:
 *
 * - the git host watcher reports each PR it reads (`pullRequestState`): a task PR merged on
 *   GitHub marks its merge record merged, with the merge commit and the method read from git
 *   (a merge commit's parents, the PR's commits), and goes through `ReviewedPrMerge.merged`
 *   (so `onMerged` hears merges on GitHub too); a PR closed without a merge leaves its record to
 *   the person ("#4 was closed without merging.");
 * - every merge (`onMerged`) and every close rebuilds the dependents that hold that work
 *   (`PrTaskExecutor.rebuildDependents`): one merged with a merge commit needs nothing; one
 *   merged by squash or rebase is dropped from the branch (main has its changes as other
 *   commits); one closed, redone or cancelled is dropped too, and that voids the review;
 * - between the rebuild and its push the dependent's merge record is settled (`beforePush`):
 *   a rebuild that dropped work which is not in main moves the record to the person with one
 *   sentence and one card, so nothing merges it unattended in any mode; a rebuild that only
 *   dropped what main already has keeps the record, moved to the new head, when the task's own
 *   change (`ownChangeId`) is unchanged; a rebuild that conflicts leaves the branch as it was
 *   and the record and its card name the pull requests;
 * - the default branch's head, once per poll and project (`sweep`), retries a rebuild that
 *   could not run (the worktree was busy) and catches a dependency redone or cancelled; a
 *   rebuild owed is kept on the dependent's merge record (`rebuild_owed_for`, R-owed), so a
 *   restart keeps it, and it is set before the rebuild starts, so no merge of that pull request
 *   goes ahead while its branch may still hold work that went away (`ReviewedPrMerge`, R-lock);
 * - right before an accepted task's merge (`mergePort`), a branch that holds work which went
 *   away while it was reviewed is rebuilt first, and its review is void when that work is gone.
 */
export interface DependentBranchesDeps {
  store: StateStore;
  clock: Clock;
  merge: Pick<ReviewedPrMerge, "merged">;
  executor: Pick<PrTaskExecutor, "rebuildDependents" | "rebuildTask" | "mergeMethodOf"> &
    Partial<Pick<PrTaskExecutor, "conflictsWithBase" | "reachedBase">>;
  /** L3-github-2: merge cards were closed (compose tells the Inbox, `inbox.changed`). */
  cardsClosed?: () => void;
}

/**
 * R-conflict (leftovers7-merge2): an open task pull request that no longer merges cleanly into
 * main (another merge changed the same lines): "#8 conflicts with main in index.html: resolve
 * the conflict on GitHub, or redo the task." Polish owns the words.
 */
export function conflictNoticeSentence(
  pr: number | null,
  base: string,
  files: readonly string[],
): string {
  const where =
    files.length === 0
      ? ""
      : ` in ${files.length <= 3 ? andList(files) : `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`}`;
  return `${prName(pr)} conflicts with ${base}${where}: resolve the conflict on GitHub, or redo the task.`;
}

/** "#8" for a pull request number, "its pull request" without one. */
function prName(n: number | null | undefined): string {
  return n ? `#${n}` : "its pull request";
}

function andList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The record's sentence when a rebuild dropped work that is not in the default branch (ADR
 * 0111): "#8 was rebuilt without #4, which was closed. It was reviewed with #4's changes, so it
 * waits for you: look at it, then merge it or redo the task." (W14-3: the card offers Merge and
 * Redo; before, "or send it back", which no button did.)
 */
export function rebuiltWithoutSentence(
  pr: number | null,
  dropped: readonly Pick<HeldDependency, "number" | "title" | "state">[],
): string {
  const gone = dropped.filter((d) => d.state !== "copied");
  const theirs = gone.length === 1 ? `${prName(gone[0]?.number)}'s changes` : "their changes";
  return `${prName(pr)} was rebuilt without ${andList(gone.map(droppedWords))}. It was reviewed with ${theirs}, so it waits for you: look at it, then merge it or redo the task.`;
}

/** A rebuild onto main (a dependency merged by squash or rebase) that changed the task's own change. */
export function rebuiltChangedSentence(
  pr: number | null,
  dropped: readonly Pick<HeldDependency, "number" | "title" | "state">[],
): string {
  return `${prName(pr)} was rebuilt onto main once ${andList(dropped.map((d) => prName(d.number)))} ${dropped.length === 1 ? "was" : "were"} merged, and its own change is no longer the one reviewed, so it waits for you: look at it, then merge it or redo the task.`;
}

/** A rebuild that conflicted: the pull request still holds the work it built on. */
export function rebuildConflictSentence(
  pr: number | null,
  dropped: readonly Pick<HeldDependency, "number" | "title" | "state">[],
  conflicts: readonly string[],
): string {
  const files =
    conflicts.length === 0
      ? "the same files"
      : conflicts.length <= 3
        ? andList(conflicts)
        : `${conflicts.slice(0, 3).join(", ")} and ${conflicts.length - 3} more`;
  const gone = dropped.filter((d) => d.state !== "copied");
  const merge = gone.length
    ? `merge it on GitHub only if you want ${gone.length === 1 ? `${prName(gone[0]?.number)}'s` : "their"} changes too`
    : "resolve it on GitHub";
  return `${prName(pr)} could not be rebuilt without ${andList(dropped.map(droppedWords))}: both change ${files}. It waits for you: redo the task, or ${merge}.`;
}

/**
 * W15-02 fix-up: whether the branch, as GitHub had it before a rebuild, held the change the
 * record's review read. The task's own change (`own_change_id`, which a dependency merged by
 * squash, main merged in or an earlier rebuild keeps) is compared when the record has it, as
 * the merge step does (`keepsOwnChange`); else the head itself. A commit pushed on top that
 * changes anything (the person's, as the folder's wait offers, or anyone's on GitHub) is not
 * the reviewed change. An earlier rebuild whose push failed moved the record to its own head
 * and the same own change, so it is read as reviewed and rebuilt again.
 */
function reviewedChangeBefore(record: MergeRecordRow, r: DependentRebuild): boolean {
  if (record.own_change_id) return r.ownBefore === record.own_change_id;
  return !!record.reviewed_head_sha && r.before === record.reviewed_head_sha;
}

/**
 * L4-github-112: the card of a task whose pull request was closed while its change reached main
 * through another's merge (`mergedThroughCard`): take it out of main, or keep it.
 */
export const MERGED_THROUGH_OPTIONS = ["Take this work out", "Keep it"] as const;

/**
 * Why a task's merge cards were closed (`closeMergeCards`, the card's `closed`): its pull request
 * merged; closed on GitHub without a merge (L4-github-117: "Closed: #33 was closed on GitHub.");
 * or closed while its change reached main through another (L4-github-112).
 */
export type MergeCardsClosed = "merged" | "closed" | "merged_through";

/** A rebuild that could not run: the worktree was busy (or dirty), the push was held, a step failed. */
const OWES: ReadonlySet<DependentOutcome["result"]> = new Set(["busy", "held", "failed", "waits"]);

/** What a branch check before a merge leaves to the person (L3-github-1, `settleRecord`). */
const LEFT_BY_CHECK: ReadonlySet<string> = new Set([
  "rebuilt_without",
  "rebuilt_changed",
  "rebuild_conflict",
  "head_moved",
]);

export class DependentBranches {
  private readonly logger = log("dependent-branches");
  /**
   * Rebuilds that could not run for a task with no merge record (one accepted before ADR 0111):
   * tried at the next sweep. A task with a record keeps it there (`rebuild_owed_for`, R-owed).
   */
  private readonly owed = new Map<string, { projectId: string; dependencyId: string }>();
  /**
   * R-conflict: what this poll read of each open task pull request (its `mergeable` above all),
   * by task; the sweep at the end of the poll looks at them once the poll's rebuilds ran. A
   * pull request rebuilt in the poll is dropped (what was read is from before its new head).
   */
  private readonly seen = new Map<
    string,
    { projectId: string; pr: WatchedPullRequest; info: PullRequestInfo }
  >();

  constructor(private readonly deps: DependentBranchesDeps) {}

  /**
   * The git host watcher's report of one task PR (`onPullRequestState`). Open: kept for the
   * sweep's conflict notice (R-conflict; the watcher reads every open PR each poll anyway, so
   * GitHub is asked nothing more). Merged: the record is marked merged (with the merge commit
   * and how it was merged) and the merge is heard like any other (`ReviewedPrMerge.merged`),
   * which rebuilds what built on it. Closed without a merge: the record is left to the person,
   * and the dependents are rebuilt without it. Throws when it could not finish, so the watcher
   * reads the PR again.
   */
  async pullRequestState(pr: WatchedPullRequest, info: PullRequestInfo): Promise<void> {
    if (info.state === "open") {
      if (pr.projectId) this.seen.set(pr.taskId, { projectId: pr.projectId, pr, info });
      return;
    }
    this.seen.delete(pr.taskId);
    const task = await this.deps.store.task.get(pr.taskId);
    if (!task) return;
    if (info.merged) await this.mergedOnHost(task, info);
    else await this.closedOnHost(task, info);
  }

  private async mergedOnHost(task: TaskRow, info: PullRequestInfo): Promise<void> {
    const { store } = this.deps;
    const record = await store.mergeRecord.forTask(task.id);
    // Forerunner merged it itself: `onMerged` was heard then.
    if (record?.state === "merged" && record.pr_number === info.number) return;
    const mergeSha = info.mergeCommitSha ?? null;
    const method = await this.deps.executor.mergeMethodOf(task, mergeSha, info.head.sha);
    if (record && record.pr_number === info.number) {
      const done = await store.mergeRecord.move(record.id, "merged", {
        merge_sha: mergeSha,
        method,
        sentence: "",
        last_outcome: "merged_on_host",
      });
      this.logger.info("pull request merged on the host", {
        taskId: task.id,
        pr: info.number,
        mergeSha,
        method,
      });
      await this.deps.merge.merged({ task, record: done, mergeSha, method });
      // L4-github-112: what it built on and was closed on GitHub may have reached main with it.
      await this.closedReachedThrough(task, { number: info.number, mergeSha });
      return;
    }
    // No record (accepted before ADR 0111): what built on it is rebuilt all the same.
    await this.rebuildFor(task.project_id, task.id);
  }

  /**
   * A task pull request closed on GitHub without a merge. Its record is left to the person
   * ("#4 was closed without merging."), unless its reviewed change reached main all the same
   * through a pull request that built on it (L4-github-112, `mergedThrough`); a cancelled task's
   * pull request without a record gets one that says it was closed (L4-chat-110: chat's facts
   * read "Closed without merging", never "Left open on GitHub"). Every open merge card of the
   * task closes, as on a merge (L4-github-117: "Closed: #4 was closed on GitHub."), and what
   * built on it is rebuilt without it.
   */
  private async closedOnHost(
    task: TaskRow,
    info: PullRequestInfo,
    o: { rebuild?: boolean } = {},
  ): Promise<void> {
    const { store } = this.deps;
    const record = await store.mergeRecord.forTask(task.id);
    // Read again after its change was recorded as merged through another: nothing more to do.
    if (record?.state === "merged" && record.pr_number === info.number) return;
    if (record && record.state !== "merged" && record.pr_number === info.number) {
      if (await this.mergedThrough(task, record)) return;
      await store.mergeRecord.move(record.id, "left_to_you", {
        sentence: `${prName(info.number)} was closed without merging.`,
        last_outcome: "closed",
      });
    } else if (!record && task.status === "cancelled" && task.pr_url)
      await this.recordCancelledClose(task, info);
    this.logger.info("pull request closed on the host", { taskId: task.id, pr: info.number });
    await this.closeMergeCards(task.id, task.pr_url ?? info.htmlUrl, "closed");
    if (o.rebuild !== false) await this.rebuildFor(task.project_id, task.id);
  }

  /**
   * L4-github-124 (a) (fixup-l4-github-merge): the person's Merge found that a pull request its
   * chain builds on is no longer open and read it once (`ProjectPullRequests.merge`): closed on
   * GitHub a moment ago, before the watcher's poll read it. Its record, its Tasks row and its
   * merge cards are settled now as the watcher's report settles them (`closedOnHost`: "#4 was
   * closed without merging.", or merged through another), so the row is true right after the
   * press; before, it read "waiting for you to merge" until the next poll. What built on it is
   * not rebuilt here: the press's own branch check did that for the chain it merges, and the
   * watcher's next poll (which reads the close again) does it for the rest, so the press writes
   * to GitHub only for what the person pressed. A pull request merged on GitHub is left to that
   * poll, whose report starts the merge's listeners once.
   */
  async closedAtPress(task: TaskRow, info: PullRequestInfo): Promise<void> {
    if (info.state === "open" || info.merged) return;
    this.seen.delete(task.id);
    await this.closedOnHost(task, info, { rebuild: false });
  }

  /**
   * L4-chat-110: a cancelled task's pull request closed on GitHub, with no merge record (it was
   * cancelled before an accept): a record that says so, left to the person with no Merge, so
   * the chat's facts and the Overview read it closed. Nothing is written to GitHub.
   */
  private async recordCancelledClose(task: TaskRow, info: PullRequestInfo): Promise<void> {
    const agentId = task.owner_agent_id ?? task.claimed_by ?? task.author_agent ?? "";
    await this.deps.store.transaction(async (tx) => {
      const pinned = await tx.mergeRecord.pin({
        task_id: task.id,
        project_id: task.project_id,
        agent_id: agentId,
        pr_number: info.number,
        pr_url: task.pr_url ?? info.htmlUrl,
        reviewed_head_sha: info.head.sha,
        author_agent: agentId || null,
      });
      await tx.mergeRecord.move(pinned.id, "left_to_you", {
        sentence: `${prName(info.number)} was closed without merging.`,
        last_outcome: "closed",
      });
    });
  }

  /**
   * L4-github-112 (ADR 0111, amendment of 2026-11-23, replacing point 4 of the 2026-11-15 one):
   * a pull request closed on GitHub whose reviewed commit is on main all the same (a pull request
   * that held it was merged there, before or after the watcher read the close) is recorded as
   * merged through it: state merged, `MERGED_THROUGH`, the merge commit when known, and "#46 was
   * closed, but its change reached main through #48.". Its other merge cards close, and one card
   * offers Take this work out and Keep it; nothing is written to GitHub before the person
   * presses. True when it was (the caller then leaves the record as it is). `via`: the merged
   * pull request it is known to have reached main through (the merge the watcher just read).
   */
  private async mergedThrough(
    task: TaskRow,
    record: MergeRecordRow,
    via?: { number: number; mergeSha: string | null },
  ): Promise<boolean> {
    const { store, executor } = this.deps;
    if (!record.reviewed_head_sha || !executor.reachedBase) return false;
    if ((await executor.reachedBase(task, record.reviewed_head_sha)) !== true) return false;
    const through = via ?? (await this.mergedDependentOf(task));
    const sentence = mergedThroughSentence(record.pr_number, through?.number ?? null);
    const moved = await store.mergeRecord.move(record.id, "merged", {
      merge_sha: through?.mergeSha ?? null,
      method: null,
      sentence,
      last_outcome: MERGED_THROUGH,
      rebuild_owed_for: null,
    });
    this.logger.info("closed pull request's change reached main through another", {
      taskId: task.id,
      pr: record.pr_number,
      through: through?.number ?? null,
    });
    await this.closeMergeCards(task.id, record.pr_url, "merged_through");
    await this.mergedThroughCard(task, moved, sentence, through?.number ?? null);
    // What else built on it holds a change that is on main now: nothing went away.
    await this.rebuildFor(task.project_id, task.id);
    return true;
  }

  /**
   * L4-github-112: after `task`'s pull request was merged on GitHub (`merged`), each task it
   * built on whose pull request was closed: recorded as merged through it when its reviewed
   * change came along; one recorded so before this merge was read gets the merge commit.
   */
  private async closedReachedThrough(
    task: TaskRow,
    merged: { number: number; mergeSha: string | null },
  ): Promise<void> {
    const { store } = this.deps;
    try {
      for (const dep of await this.dependenciesOf(task)) {
        const record = await store.mergeRecord.forTask(dep.id);
        if (!record || record.pr_url !== dep.pr_url) continue;
        if (record.state === "merged") {
          if (
            record.last_outcome === MERGED_THROUGH &&
            !record.merge_sha &&
            merged.mergeSha &&
            throughNumberOf(record) === merged.number
          )
            await store.mergeRecord.patch(record.id, { merge_sha: merged.mergeSha });
          continue;
        }
        if (record.state === "left_to_you" && record.last_outcome === "closed")
          await this.mergedThrough(dep, record, merged);
      }
    } catch (e) {
      this.logger.warn("closed dependencies not checked after a merge", {
        taskId: task.id,
        error: errorMessage(e),
      });
    }
  }

  /** The tasks `task` builds on, directly or through others, nearest first. */
  private async dependenciesOf(task: TaskRow): Promise<TaskRow[]> {
    const out: TaskRow[] = [];
    const seen = new Set<string>([task.id]);
    let frontier = [...(task.depends_on ?? [])];
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const dep = await this.deps.store.task.get(id);
        if (!dep) continue;
        out.push(dep);
        next.push(...(dep.depends_on ?? []));
      }
      frontier = next;
    }
    return out;
  }

  /**
   * The nearest done task that builds on `task` and whose pull request was merged (its record
   * says so, or its reviewed commit is on main: merged on GitHub and not read yet), with its
   * merge commit when the record has it; null when none can be named.
   */
  private async mergedDependentOf(
    task: TaskRow,
  ): Promise<{ number: number; mergeSha: string | null } | null> {
    const { store, executor } = this.deps;
    const tasks = await store.task.list({ project_id: task.project_id } as never, { limit: 2000 });
    let frontier = [task.id];
    const seen = new Set<string>(frontier);
    while (frontier.length) {
      const next: string[] = [];
      for (const t of tasks) {
        if (seen.has(t.id) || !(t.depends_on ?? []).some((d) => frontier.includes(d))) continue;
        seen.add(t.id);
        next.push(t.id);
        const record = t.pr_url ? await store.mergeRecord.forTask(t.id) : undefined;
        if (!record || record.pr_url !== t.pr_url || !record.pr_number) continue;
        if (record.state === "merged" && record.last_outcome !== MERGED_THROUGH)
          return { number: record.pr_number, mergeSha: record.merge_sha };
        if (
          record.reviewed_head_sha &&
          (await executor.reachedBase?.(t, record.reviewed_head_sha)) === true
        )
          return { number: record.pr_number, mergeSha: null };
      }
      frontier = next;
    }
    return null;
  }

  /**
   * L4-github-112: one card for a closed pull request whose change reached main through another:
   * Take this work out (a pull request that takes only its own change out of main; nothing
   * changes until the person merges it) or Keep it. Filed once per record.
   */
  private async mergedThroughCard(
    task: TaskRow,
    record: MergeRecordRow,
    sentence: string,
    through: number | null,
  ): Promise<void> {
    const { store } = this.deps;
    try {
      const rows = await store.humanRequest.list({ task_id: task.id } as never, { limit: 50 });
      if (
        rows.some((r) => {
          const card = (r.change_card ?? {}) as JsonObject;
          return (
            card.key === MERGE_LEFT_OPEN_KEY &&
            card.merged_through === true &&
            card.pr_url === record.pr_url
          );
        })
      )
        return;
      const agentId = record.agent_id || task.owner_agent_id || task.author_agent || "";
      const humanId = (await store.agent.get(agentId))?.owner_human_id ?? "";
      if (!humanId) return;
      await fileLeftOpenRequest(store, {
        task,
        sessionId: null,
        humanId,
        agentId,
        outcome: {
          taskId: task.id,
          prUrl: record.pr_url,
          status: "closed",
          reason: `PR closed, its change merged through another: ${sentence}`,
          sentence,
        },
        card: { merged_through: true, through },
        options: [...MERGED_THROUGH_OPTIONS],
        steps: [
          through
            ? `Look at #${through} on GitHub: it brought the change of #${record.pr_number} into main`
            : `Look at main on GitHub: it holds the change of #${record.pr_number}`,
          "Then press Take this work out to undo only that change, or Keep it",
        ],
      });
      this.deps.cardsClosed?.();
    } catch (e) {
      this.logger.warn("merged-through card not filed", {
        taskId: task.id,
        error: errorMessage(e),
      });
    }
  }

  /**
   * `ReviewedPrMerge.onMerged`: every merge, Forerunner's own and those seen on GitHub. The
   * task's merge cards close first (L3-github-2), then what built on it is rebuilt.
   */
  async dependencyMerged(e: MergedEvent): Promise<void> {
    await this.closeMergeCards(e.task.id, e.record.pr_url, "merged");
    await this.rebuildFor(e.task.project_id, e.task.id);
  }

  /**
   * L3-github-2: every open card of a task's merge (its head moved, a rebuild, a rebuild that
   * conflicted, a conflict notice) is closed once that pull request is merged, by Forerunner or
   * seen merged on GitHub, whatever the card offered: it no longer needs the person (design
   * §3.8, "a card whose task has moved on is closed with a line saying so"; its Answered line
   * reads "Closed: #33 was merged.", from `closed: "merged"`). Before (live check 3, G5, G7, G8)
   * nothing closed them: the head-moved card stayed in Needs you for 30 minutes and through a
   * restart, the chat repeated it as "never merged", and a rebuild card's Merge answered
   * "Merging #42." for a pull request merged on GitHub. Returns how many were closed.
   */
  private async closeMergeCards(
    taskId: string,
    prUrl: string,
    why: MergeCardsClosed,
  ): Promise<number> {
    const { store } = this.deps;
    let closed = 0;
    const rows = await store.humanRequest.list({ task_id: taskId, status: "open" } as never, {
      limit: 50,
    });
    for (const row of rows) {
      const card = (row.change_card ?? {}) as JsonObject;
      if (card.key !== MERGE_LEFT_OPEN_KEY) continue;
      // A card about another pull request of the task (an earlier one, before a redo) stays.
      if (typeof card.pr_url === "string" && card.pr_url && card.pr_url !== prUrl) continue;
      // L4-github-112: the merged-through card is about the merge itself; the person answers it.
      if (card.merged_through === true) continue;
      try {
        const marked = await store.humanRequest.patch(row.id, {
          change_card: { ...card, closed: why },
        });
        await store.humanRequest.withdraw(marked.id, marked.version);
        closed++;
      } catch (e) {
        this.logger.warn("merge card not closed", { taskId, error: errorMessage(e) });
      }
    }
    if (closed) {
      this.logger.info(
        why === "closed"
          ? "merge cards closed: the pull request was closed"
          : "merge cards closed: the pull request is merged",
        { taskId, closed },
      );
      this.deps.cardsClosed?.();
    }
    return closed;
  }

  /**
   * L3-github-2: the project's merge cards still open for a pull request whose merge record says
   * merged (an earlier version left them open, or a listener did not run), closed once per poll
   * by the sweep. True when one was.
   */
  private async closeMergedCards(projectId: string, tasks: readonly TaskRow[]): Promise<boolean> {
    const { store } = this.deps;
    let closed = 0;
    const open = await store.humanRequest.list({ project_id: projectId, status: "open" } as never, {
      limit: 500,
    });
    const taskIds = new Set(
      open
        .filter((r) => (r.change_card as JsonObject | null)?.key === MERGE_LEFT_OPEN_KEY)
        .map((r) => r.task_id)
        .filter((id): id is string => !!id),
    );
    for (const taskId of taskIds) {
      if (!tasks.some((t) => t.id === taskId)) continue;
      const record = await store.mergeRecord.forTask(taskId);
      // L4-github-117: also a card left open for a pull request closed on GitHub.
      if (record?.state === "left_to_you" && record.last_outcome === "closed")
        closed += await this.closeMergeCards(taskId, record.pr_url, "closed");
      if (record?.state !== "merged") continue;
      closed += await this.closeMergeCards(
        taskId,
        record.pr_url,
        record.last_outcome === MERGED_THROUGH ? "merged_through" : "merged",
      );
    }
    return closed > 0;
  }

  /**
   * L3-github-1 (R-lock, ADR 0111 amended 2026-11-15): what a task's branch holds, checked right
   * before a merge outside a session and at the person's press (compose wires it into the merge
   * step, `ReviewedPrMerge.checkBranchesWith`), as `mergePort` checks it before the session's
   * merge: `rebuildTask` reads each dependency the branch holds on GitHub and takes out work
   * that went away (a pull request closed, a task redone or cancelled), and the record is
   * settled before the push (`settleRecord`: a review that read that work is void, with one
   * sentence and one card; one that only dropped what main has moves to the rebuilt head). A
   * check that could not run (the folder busy, GitHub silent) leaves the record owing the
   * rebuild, so no merge goes ahead until the sweep ran it. Before (live check 3, G7) only the
   * watcher's next poll looked, and a Merge pressed seconds after a dependency's close merged
   * the closed work into main. `o.pressed` (the person's press asks it before its answer): a
   * branch that holds commits the review did not read files its "changed after the review" card
   * also over a record that waited for the click, as the press's own head check does.
   */
  async checkBeforeMerge(task: TaskRow, o: BranchCheckOptions = {}): Promise<BranchVerdict> {
    const { store } = this.deps;
    const none: BranchVerdict = { left: null, owed: false };
    if (!task.pr_url || !task.branch || !(task.depends_on ?? []).length) return none;
    const before = await store.mergeRecord.forTask(task.id);
    if (!before || before.state === "merged" || before.pr_url !== task.pr_url) return none;
    const rebuilt = await this.deps.executor.rebuildTask(task, {
      beforePush: (r, pr) => this.settleRecord(r, pr, o.pressed === true),
    });
    if (OWES.has(rebuilt.result)) {
      const record = await store.mergeRecord.forTask(task.id);
      if (record && record.state !== "merged" && !record.rebuild_owed_for) {
        await store.mergeRecord.oweRebuild(task.id, await this.owedFor(task));
        await this.sayFolderWait(rebuilt);
      }
      this.logger.warn("branch not checked before its merge: the rebuild is owed", {
        taskId: task.id,
        result: rebuilt.result,
      });
      return { left: null, owed: true };
    }
    // R-conflict: what this poll read of its pull request is from before the rebuild.
    if (rebuilt.result !== "unchanged") this.seen.delete(task.id);
    const now = await store.mergeRecord.forTask(task.id);
    const left =
      !!now &&
      now.state === "left_to_you" &&
      LEFT_BY_CHECK.has(now.last_outcome ?? "") &&
      (now.last_outcome !== before.last_outcome || now.sentence !== before.sentence);
    if (left)
      this.logger.info("branch checked before its merge: left to the person", {
        taskId: task.id,
        outcome: now?.last_outcome,
      });
    return { left: left ? (now ?? null) : null, owed: false };
  }

  /** The dependency a check that could not run owes the rebuild for: the first not merged. */
  private async owedFor(task: TaskRow): Promise<string> {
    const ids = task.depends_on ?? [];
    for (const id of ids)
      if ((await this.deps.store.mergeRecord.forTask(id))?.state !== "merged") return id;
    return ids[0] ?? task.id;
  }

  /**
   * Once per poll and repository project (`onDefaultBranchHead`): the rebuilds that could not
   * run are tried again, and a done task that waits for one that is no longer done (redone,
   * cancelled) has that one taken out of its branch. True when a conflict notice was given or
   * taken back (R-conflict): the project's screens read the pull requests again.
   */
  async sweep(projectId: string): Promise<boolean> {
    const todo = new Map<string, string>();
    for (const [taskId, o] of this.owed)
      if (o.projectId === projectId) todo.set(o.dependencyId, taskId);
    const tasks = await this.deps.store.task.list({ project_id: projectId } as never, {
      limit: 2000,
    });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    // R-owed: the rebuilds kept on the merge records, after a restart too. One whose task is no
    // longer done (redone, cancelled) owes nothing: its next run builds its branch again.
    for (const r of await this.deps.store.mergeRecord.owedRebuilds(projectId)) {
      const t = byId.get(r.task_id);
      if (t?.status === "done" && t.branch && r.rebuild_owed_for)
        todo.set(r.rebuild_owed_for, t.id);
      else await this.deps.store.mergeRecord.oweRebuild(r.task_id, null);
    }
    for (const t of tasks) {
      if (t.status !== "done" || !t.branch) continue;
      for (const id of t.depends_on ?? []) {
        const dep = byId.get(id);
        if (dep && dep.status !== "done") todo.set(dep.id, t.id);
      }
    }
    for (const dependencyId of todo.keys()) await this.rebuildFor(projectId, dependencyId);
    // L3-github-2: a merge card still open for a pull request whose record says merged.
    const closed = await this.closeMergedCards(projectId, tasks).catch((e: unknown) => {
      this.logger.warn("merged pull requests' cards not closed", {
        projectId,
        error: errorMessage(e),
      });
      return false;
    });
    return (await this.conflictNotices(projectId)) || closed;
  }

  /**
   * R-conflict (leftovers7-merge2, ADR 0111): an open task pull request whose `mergeable` turned
   * false (another merge changed the same lines) and that waits for the person is said once:
   * its record is left to the person with the sentence (so the Overview offers no Merge that
   * cannot work) and one card offers Redo and Leave it open. The record's `last_outcome`
   * ("conflict") keeps it from being said again at the next poll or after a restart. Once GitHub
   * says it merges cleanly again (the person resolved it), the record says nothing more, Merge
   * is offered again and a card still open is closed.
   */
  private async conflictNotices(projectId: string): Promise<boolean> {
    let changed = false;
    for (const [taskId, seen] of [...this.seen]) {
      if (seen.projectId !== projectId) continue;
      this.seen.delete(taskId);
      try {
        if (await this.conflictNotice(seen.pr, seen.info)) changed = true;
      } catch (e) {
        this.logger.warn("conflict notice not filed", { taskId, error: errorMessage(e) });
      }
    }
    return changed;
  }

  /** True when the record was moved (a notice given or taken back). */
  private async conflictNotice(pr: WatchedPullRequest, info: PullRequestInfo): Promise<boolean> {
    if (info.mergeable !== true && info.mergeable !== false) return false;
    const { store } = this.deps;
    const task = await store.task.get(pr.taskId);
    if (task?.status !== "done") return false;
    const record = await store.mergeRecord.forTask(task.id);
    if (!record || record.pr_number !== info.number) return false;
    const ref = { number: info.number, url: info.htmlUrl || pr.url };
    if (info.mergeable === true) {
      // W15-04: a notice whose record moved on (the task was redone and accepted again, its
      // record says something new) is closed once the pull request merges cleanly: before, it
      // stayed open for good beside what the record says now (live check 2, F3).
      if (record.state !== "left_to_you" || record.last_outcome !== "conflict")
        return this.closeStaleNotice(task);
      // TM-7 (leftovers7-tailmerge): what the record said before the notice, and the head it
      // was given on (kept on the notice's card, `before_conflict`).
      const before = await this.beforeConflict(task.id);
      const noticed = before?.head ?? record.reviewed_head_sha;
      // Merge is offered again only for the version the review read (main changed back, the
      // conflicting merge taken out). A head that moved since (the person's own resolution on
      // GitHub, as the notice asks) is not that version: the merge step would refuse it, so the
      // record says so as the merge step does (`head_moved`, no Merge on the Overview) and the
      // open conflict card takes those words (the R-conflict review's fix-up). The head is the
      // one the notice was given on: a rebuilt branch's is not the reviewed one, and its record
      // said so already (TM-7: before, it read "changed after the review" once the conflict
      // went away on main).
      if (noticed && info.head.sha !== noticed) {
        const sentence = headMovedSentence(info.number);
        await store.mergeRecord.move(record.id, "left_to_you", {
          sentence,
          last_outcome: "head_moved",
        });
        await this.headMovedCard(task, ref, sentence);
        this.logger.info("pull request merges cleanly again, on a head after the review", {
          taskId: task.id,
          pr: info.number,
        });
        return true;
      }
      // TM-7: the record says again what it said before the notice (a rebuild's warning, "builds
      // on #X, which was not merged: merge #X first"), with the Merge it offered; before, the
      // sentence was emptied. With nothing kept, it says nothing more, as before.
      const said = before?.lastOutcome ? before : null;
      await store.mergeRecord.move(record.id, "left_to_you", {
        sentence: said ? said.sentence : "",
        last_outcome: said ? said.lastOutcome : "conflict_resolved",
      });
      if (!(await this.restoreCard(task, before))) await this.closeConflictCard(task);
      this.logger.info("pull request merges cleanly again", { taskId: task.id, pr: info.number });
      return true;
    }
    // Said once (also the merge step's own conflict, or a rebuild's); a rebuild owed comes first.
    if (record.last_outcome === "conflict" || record.last_outcome === "rebuild_conflict")
      return false;
    if (record.rebuild_owed_for) return false;
    // Only what waits for the person: a merge under way, waiting or queued by the person's click
    // finds the conflict itself and says it.
    const waits =
      record.state === "left_to_you" || (record.state === "queued" && record.approval === "none");
    if (!waits) return false;
    const files = (await this.deps.executor.conflictsWithBase?.(task)) ?? [];
    const sentence = conflictNoticeSentence(info.number, info.base.ref, files);
    const moved = await store.mergeRecord.move(record.id, "left_to_you", {
      sentence,
      last_outcome: "conflict",
    });
    this.logger.info("pull request conflicts with its base", {
      taskId: task.id,
      pr: info.number,
      files,
    });
    await this.conflictCard(task, moved, ref, sentence, info.base.ref, {
      lastOutcome: record.last_outcome,
      sentence: record.sentence,
      head: info.head.sha,
    });
    return true;
  }

  /**
   * One card for the conflict (an open card for the task's merge takes the new words). The card
   * keeps what the record (and an open card) said before (`before_conflict`, TM-7), so they can
   * say it again once the conflict goes away with the same head.
   */
  private async conflictCard(
    task: TaskRow,
    record: MergeRecordRow,
    pr: { number: number; url: string },
    sentence: string,
    base: string,
    before: { lastOutcome: string | null; sentence: string; head: string },
  ): Promise<void> {
    const { store } = this.deps;
    const options = [...REBUILD_CARD_OPTIONS.conflict];
    const open = await this.openMergeCard(task.id);
    const kept: JsonObject = {
      last_outcome: before.lastOutcome,
      sentence: before.sentence,
      head: before.head,
    };
    if (open) {
      const card = (open.change_card ?? {}) as JsonObject;
      // W15-04: an open card that is itself an earlier notice keeps its own words from before
      // that notice (none, when that notice filed it): it is never restored as notice words.
      const earlier =
        card.notice === "conflict"
          ? ((card.before_conflict as JsonObject | undefined)?.card ?? null)
          : {
              why: open.why,
              options: [...open.options],
              steps: [...open.steps],
              status: typeof card.status === "string" ? card.status : null,
              sentence: typeof card.sentence === "string" ? card.sentence : null,
            };
      await store.humanRequest.patch(open.id, {
        why: `The critic accepted "${task.title}", but pull request #${pr.number} was not merged. ${sentence}`,
        options,
        // Its Details follow what it says now (a card that said a head moved, then conflicts).
        steps: leftOpenSteps("conflict"),
        change_card: {
          ...card,
          sentence,
          status: "conflict",
          notice: "conflict",
          base,
          before_conflict: { ...kept, ...(earlier ? { card: earlier } : {}) },
        },
      });
      return;
    }
    const agentId = record.agent_id || task.owner_agent_id || task.author_agent || "";
    const humanId = (await store.agent.get(agentId))?.owner_human_id ?? "";
    if (!humanId) return;
    await fileLeftOpenRequest(store, {
      task,
      sessionId: null,
      humanId,
      agentId,
      outcome: {
        taskId: task.id,
        prUrl: pr.url,
        status: "conflict",
        reason: `PR left open for you: ${sentence}`,
        sentence,
      },
      card: { notice: "conflict", base, before_conflict: kept },
      options,
    });
  }

  /**
   * TM-7: what the record said before the task's last conflict notice and the head it was given
   * on, from the notice's card (open or not, the newest that kept it); null when none kept it.
   */
  private async beforeConflict(taskId: string): Promise<{
    lastOutcome: string | null;
    sentence: string;
    head: string | null;
    card: JsonObject | null;
  } | null> {
    const rows = await this.deps.store.humanRequest.list({ task_id: taskId } as never, {
      orderBy: [
        { column: "updated_at", direction: "desc" },
        { column: "id", direction: "desc" },
      ],
      limit: 50,
    });
    for (const row of rows) {
      const card = (row.change_card ?? {}) as JsonObject;
      const kept = card.before_conflict as JsonObject | undefined;
      if (card.key !== MERGE_LEFT_OPEN_KEY || !kept || typeof kept !== "object") continue;
      return {
        lastOutcome: typeof kept.last_outcome === "string" ? kept.last_outcome : null,
        sentence: typeof kept.sentence === "string" ? kept.sentence : "",
        head: typeof kept.head === "string" ? kept.head : null,
        card: kept.card && typeof kept.card === "object" ? (kept.card as JsonObject) : null,
      };
    }
    return null;
  }

  /**
   * TM-7: the open card the conflict notice took over says again what it said before (its
   * words, Details, options), with no notice. False when there is none to restore (the notice
   * filed its own card, which `closeConflictCard` then closes).
   */
  private async restoreCard(
    task: TaskRow,
    before: Awaited<ReturnType<DependentBranches["beforeConflict"]>>,
  ): Promise<boolean> {
    const earlier = before?.card;
    const open = await this.openMergeCard(task.id);
    const card = (open?.change_card ?? {}) as JsonObject;
    if (!open || !earlier || card.notice !== "conflict") return false;
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const { before_conflict: _kept, ...rest } = card;
    await this.deps.store.humanRequest.patch(open.id, {
      why: typeof earlier.why === "string" ? earlier.why : open.why,
      options: strings(earlier.options),
      steps: strings(earlier.steps),
      change_card: {
        ...rest,
        notice: null,
        base: null,
        status: typeof earlier.status === "string" ? earlier.status : null,
        sentence:
          typeof earlier.sentence === "string" ? earlier.sentence : (before?.sentence ?? ""),
      },
    });
    return true;
  }

  /**
   * The open conflict card, once the conflict was resolved with a commit after the review: it
   * says what the record says now (the merge step's head-moved card), with the same options
   * (Redo does the task again from main; Leave it open). A card already answered stays as it is.
   */
  private async headMovedCard(
    task: TaskRow,
    pr: { number: number; url: string },
    sentence: string,
  ): Promise<void> {
    const open = await this.openMergeCard(task.id);
    const card = (open?.change_card ?? {}) as JsonObject;
    if (!open || card.notice !== "conflict") return;
    await this.deps.store.humanRequest.patch(open.id, {
      why: `The critic accepted "${task.title}", but pull request #${pr.number} was not merged. ${sentence}`,
      steps: leftOpenSteps("head_moved"),
      change_card: { ...card, sentence, status: "head_moved", notice: null, base: null },
    });
  }

  /** W15-03: the open card of a rebuild that conflicted, withdrawn once a clean rebuild ran. */
  private async closeRebuildConflictCard(taskId: string): Promise<void> {
    const open = await this.openMergeCard(taskId);
    const card = (open?.change_card ?? {}) as JsonObject;
    if (open && card.rebuild === "conflict")
      await this.deps.store.humanRequest.withdraw(open.id, open.version);
  }

  /**
   * W15-04: an open conflict notice card whose record no longer says the conflict, withdrawn
   * once the pull request merges cleanly. True when one was.
   */
  private async closeStaleNotice(task: TaskRow): Promise<boolean> {
    const open = await this.openMergeCard(task.id);
    const card = (open?.change_card ?? {}) as JsonObject;
    if (!open || card.notice !== "conflict") return false;
    await this.deps.store.humanRequest.withdraw(open.id, open.version);
    this.logger.info("an earlier conflict notice was closed", { taskId: task.id });
    return true;
  }

  /** The open card of the task's merge that said a conflict, closed: it no longer needs the person. */
  private async closeConflictCard(task: TaskRow): Promise<void> {
    const open = await this.openMergeCard(task.id);
    const card = (open?.change_card ?? {}) as JsonObject;
    if (open && card.status === "conflict" && !card.rebuild)
      await this.deps.store.humanRequest.withdraw(open.id, open.version);
  }

  private async openMergeCard(taskId: string) {
    return (
      await this.deps.store.humanRequest.list({ task_id: taskId, status: "open" } as never, {
        limit: 50,
      })
    ).find((row) => (row.change_card as JsonObject | null)?.key === MERGE_LEFT_OPEN_KEY);
  }

  /**
   * The dependents of `dependencyId` rebuilt; the busy ones kept for the next sweep. Each
   * dependent's record owes the rebuild from before it starts until it ran (R-owed, R-lock): a
   * merge of its pull request that is under way then stops before it calls GitHub, and one that
   * could not run stays owed, after a restart too.
   */
  async rebuildFor(projectId: string | null, dependencyId: string): Promise<DependentOutcome[]> {
    if (!projectId) return [];
    const marked = await this.markOwed(projectId, dependencyId);
    const outcomes = await this.deps.executor.rebuildDependents(projectId, dependencyId, {
      beforePush: (r, pr) => this.settleRecord(r, pr),
    });
    for (const o of outcomes) {
      marked.delete(o.taskId);
      await this.settleOwed(o, projectId, dependencyId);
      // R-conflict: what this poll read of its pull request is from before the rebuild.
      if (o.result !== "unchanged") this.seen.delete(o.taskId);
    }
    // Marked and not looked at (no longer done meanwhile): nothing is owed for it.
    for (const taskId of marked)
      await this.settleOwed(
        { taskId, prNumber: null, prUrl: null, result: "unchanged" },
        projectId,
        dependencyId,
      );
    return outcomes;
  }

  /**
   * The done tasks of the project that build on `dependencyId` (directly or through others) and
   * have a branch: their records owe the rebuild before it starts. Returns those marked now.
   */
  private async markOwed(projectId: string, dependencyId: string): Promise<Set<string>> {
    const { store } = this.deps;
    const marked = new Set<string>();
    try {
      const tasks = await store.task.list({ project_id: projectId } as never, { limit: 2000 });
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const buildsOn = (t: TaskRow): boolean => {
        const seen = new Set<string>([t.id]);
        const stack = [...(t.depends_on ?? [])];
        while (stack.length) {
          const id = stack.pop() as string;
          if (id === dependencyId) return true;
          if (seen.has(id)) continue;
          seen.add(id);
          stack.push(...(byId.get(id)?.depends_on ?? []));
        }
        return false;
      };
      for (const t of tasks) {
        if (t.id === dependencyId || t.status !== "done" || !t.branch || !buildsOn(t)) continue;
        const record = await store.mergeRecord.forTask(t.id);
        if (!record || record.state === "merged" || record.rebuild_owed_for) continue;
        await store.mergeRecord.oweRebuild(t.id, dependencyId);
        marked.add(t.id);
      }
    } catch (e) {
      this.logger.warn("owed rebuilds not marked", { projectId, error: errorMessage(e) });
    }
    return marked;
  }

  /**
   * What a rebuild left owed (R-owed). One that could not run stays owed (in memory for a task
   * without a record); one that rebuilt or conflicted read every dependency the branch holds,
   * so nothing is owed; one that found nothing to do settles only what was owed for this
   * dependency (it may not have read the others).
   */
  private async settleOwed(
    o: DependentOutcome,
    projectId: string,
    dependencyId: string,
  ): Promise<void> {
    const { store } = this.deps;
    try {
      const record = await store.mergeRecord.forTask(o.taskId);
      if (OWES.has(o.result)) {
        if (record && record.state !== "merged") {
          await store.mergeRecord.oweRebuild(o.taskId, dependencyId);
          await this.sayFolderWait(o);
        } else this.owed.set(o.taskId, { projectId, dependencyId });
        return;
      }
      this.owed.delete(o.taskId);
      if (!record?.rebuild_owed_for) return;
      if (o.result !== "unchanged" || record.rebuild_owed_for === dependencyId) {
        await store.mergeRecord.oweRebuild(o.taskId, null);
        // TM-4: the wait for the folder's changes is over with the owed rebuild; a merge that
        // waited goes on at the next retry and says what came of it.
        const now = await store.mergeRecord.forTask(o.taskId);
        if (now && OWED_FOLDER_OUTCOMES.has(now.last_outcome ?? ""))
          await store.mergeRecord.move(now.id, now.state, folderWaitOver(now));
      }
    } catch (e) {
      this.logger.warn("owed rebuild not recorded", { taskId: o.taskId, error: errorMessage(e) });
    }
  }

  /**
   * W15-02, W15-05: a rebuild owed that waits for what the person left in the task's folder
   * (`held`: changes nobody committed, or a commit GitHub does not have) says so on the record
   * at this poll, so the Overview's row and the Tasks row say it before any Merge is pressed
   * (live check 2, F4: the row offered a bare Merge and the click answered "Merging #23."). A
   * record that waits for the person says it only over a plain wait (its own words, a
   * rebuild's warning or a conflict, come first); one the person's Merge queued always says it.
   * A rebuild that could not run for another reason, with the folder clean now, takes it back.
   */
  private async sayFolderWait(o: DependentOutcome): Promise<void> {
    const { store } = this.deps;
    const record = await store.mergeRecord.forTask(o.taskId);
    if (!record?.pr_number || record.state === "merged" || record.state === "merging") return;
    const said = OWED_FOLDER_OUTCOMES.has(record.last_outcome ?? "");
    if (!o.held) {
      if (said && o.result !== "busy")
        await store.mergeRecord.move(record.id, record.state, folderWaitOver(record));
      return;
    }
    const plain = record.state !== "left_to_you" || said || plainWaitForYou(record);
    const wait = owedFolderWait(record.pr_number, o.held);
    if (!plain || (record.last_outcome === wait.last_outcome && record.sentence === wait.sentence))
      return;
    await store.mergeRecord.move(record.id, record.state, wait);
  }

  /**
   * Between a dependent's rebuild and its push (ADR 0111): its merge record says what the
   * person needs to know, before any merge could follow the new head. Returns true: the push
   * goes on (a merge already under way then finds its head moved, and the record's new word
   * stands: `ReviewedPrMerge` does not follow a head when the record was moved meanwhile).
   * `pressed`: the person's press asked the check (`checkBeforeMerge`).
   */
  private async settleRecord(
    r: DependentRebuild,
    pr: { number: number; url: string },
    pressed = false,
  ): Promise<boolean> {
    const { store } = this.deps;
    const record = await store.mergeRecord.forTask(r.taskId);
    if (record?.state === "merged") return true;
    const task = await store.task.get(r.taskId);
    if (!r.after) {
      const sentence = rebuildConflictSentence(pr.number, r.dropped, r.conflicts);
      // Said once (W15-03): a rebuild tried again at a later poll that conflicts the same way
      // files no second card, also once the person answered the first.
      if (record?.last_outcome === "rebuild_conflict" && record.sentence === sentence) return true;
      if (record)
        await store.mergeRecord.move(record.id, "left_to_you", {
          sentence,
          last_outcome: "rebuild_conflict",
        });
      if (task) await this.card(task, record, pr, sentence, "conflict", r.dropped);
      return true;
    }
    if (!record) return true;
    if (r.voids) {
      const sentence = rebuiltWithoutSentence(pr.number, r.dropped);
      await store.mergeRecord.move(record.id, "left_to_you", {
        sentence,
        last_outcome: "rebuilt_without",
      });
      if (task) await this.card(task, record, pr, sentence, "rebuilt_without", r.dropped);
      return true;
    }
    if (r.ownBefore && r.ownAfter && r.ownBefore === r.ownAfter) {
      // W15-02 fix-up: the branch as GitHub had it before the rebuild holds work the review did
      // not read (a commit the person pushed, as the folder's wait offers, or anyone pushed to
      // the branch on GitHub): the rebuild keeps it, but the record never follows it. Before,
      // the record moved its reviewed head onto it, the Overview offered Merge under "Reviewed
      // by the critic", and a Merge the person pressed during the folder's wait merged it.
      if (!reviewedChangeBefore(record, r)) {
        await this.changedAfterReview(task, record, pr, pressed);
        return true;
      }
      // Only what main already has was dropped: the same reviewed change on the new head.
      // W15-03: a rebuild conflict an earlier pass said is over (its sentence, its card): the
      // record waits for the person's Merge again (live check 2: it kept "could not be rebuilt"
      // and no Merge after a clean rebuild, while the Tasks row said "waiting for you to merge").
      const stale = record.last_outcome === "rebuild_conflict";
      await store.mergeRecord.move(record.id, record.state, {
        reviewed_head_sha: r.after,
        own_change_id: r.ownAfter,
        ...(stale && record.pr_number
          ? folderWaitOver({ state: "left_to_you", pr_number: record.pr_number })
          : {}),
      });
      if (stale) await this.closeRebuildConflictCard(r.taskId);
      return true;
    }
    const sentence = rebuiltChangedSentence(pr.number, r.dropped);
    await store.mergeRecord.move(record.id, "left_to_you", {
      sentence,
      last_outcome: "rebuilt_changed",
    });
    if (task) await this.card(task, record, pr, sentence, "rebuilt_changed", r.dropped);
    return true;
  }

  /**
   * W15-02 fix-up: a rebuild whose branch held work the review did not read leaves the record
   * at the reviewed commit and to the person, as the merge step does when it finds the head
   * moved (`head_moved`: no Merge on the Overview, "merge it yourself or redo the task"). A
   * Merge the person pressed before (kept while the folder waited) or the automatic mode's is
   * dropped, and one card says why; a record that already waited for the person's Merge says
   * it on its row only, as the merge step does, unless the person's press asked the check
   * (`pressed`): the press is the attempt, so its card is filed, as `ReviewedPrMerge.
   * headMovedNow` files it for a head the press saw moved (review of fix/l3-merge, sibling).
   * Said once: a later rebuild finds it said.
   */
  private async changedAfterReview(
    task: TaskRow | undefined,
    record: MergeRecordRow,
    pr: { number: number; url: string },
    pressed = false,
  ): Promise<void> {
    const { store } = this.deps;
    const sentence = headMovedSentence(pr.number);
    if (record.last_outcome === "head_moved" && record.sentence === sentence) return;
    const wasLeft = record.state === "left_to_you" && !pressed;
    const moved = await store.mergeRecord.move(record.id, "left_to_you", {
      sentence,
      last_outcome: "head_moved",
      approval: "none",
      approved_by: null,
    });
    this.logger.info("dependent branch rebuilt with work the review did not read", {
      taskId: record.task_id,
      pr: pr.number,
    });
    if (!task) return;
    try {
      const open = await this.openMergeCard(task.id);
      if (open) {
        // The card open for this merge (a notice, a rebuild's card) says it now.
        await store.humanRequest.patch(open.id, {
          why: `The critic accepted "${task.title}", but pull request #${pr.number} was not merged. ${sentence}`,
          options: [...MERGE_LEFT_OPEN_OPTIONS],
          steps: leftOpenSteps("head_moved"),
          change_card: {
            ...((open.change_card ?? {}) as JsonObject),
            sentence,
            status: "head_moved",
            notice: null,
            base: null,
            rebuild: null,
            without: null,
          },
        });
        return;
      }
      if (wasLeft) return;
      const agentId = moved.agent_id || task.owner_agent_id || task.author_agent || "";
      const humanId = (await store.agent.get(agentId))?.owner_human_id ?? "";
      if (!humanId) return;
      await fileLeftOpenRequest(store, {
        task,
        sessionId: null,
        humanId,
        agentId,
        outcome: {
          taskId: task.id,
          prUrl: pr.url,
          status: "head_moved",
          reason: `PR left open for you: ${sentence}`,
          sentence,
        },
      });
    } catch (e) {
      this.logger.warn("head-moved card not filed", { taskId: task.id, error: errorMessage(e) });
    }
  }

  /**
   * One card per record that says the record's sentence (ADR 0111): a card already open for
   * the task's merge takes the new sentence instead of a second card.
   */
  private async card(
    task: TaskRow,
    record: MergeRecordRow | undefined,
    pr: { number: number; url: string },
    sentence: string,
    rebuild: "conflict" | "rebuilt_without" | "rebuilt_changed",
    dropped: readonly Pick<HeldDependency, "number">[],
  ): Promise<void> {
    // The pull requests it was rebuilt without, for the card's title (request-words.ts).
    const without = dropped.flatMap((d) => (d.number ? [d.number] : []));
    // R-rebuildcard: the pull request is open, so the card offers what the person can do now.
    const options = [
      ...(rebuild === "conflict" ? REBUILD_CARD_OPTIONS.conflict : REBUILD_CARD_OPTIONS.rebuilt),
    ];
    // L3-github-7: a rebuild's own Details (before: the head-moved card's steps).
    const steps = rebuildSteps(rebuild, pr.number, without);
    const { store } = this.deps;
    try {
      const open = (
        await store.humanRequest.list({ task_id: task.id, status: "open" } as never, { limit: 50 })
      ).find((row) => (row.change_card as JsonObject | null)?.key === MERGE_LEFT_OPEN_KEY);
      if (open) {
        await store.humanRequest.patch(open.id, {
          why: `The critic accepted "${task.title}", but pull request #${pr.number} was not merged. ${sentence}`,
          options,
          // Its Details follow what it says now (a head-moved card a rebuild takes over).
          steps,
          change_card: {
            ...((open.change_card ?? {}) as JsonObject),
            sentence,
            rebuild,
            without,
          },
        });
        return;
      }
      const agentId = record?.agent_id ?? task.owner_agent_id ?? task.author_agent ?? "";
      const humanId = (await store.agent.get(agentId))?.owner_human_id ?? "";
      if (!humanId) return;
      await fileLeftOpenRequest(store, {
        task,
        sessionId: null,
        humanId,
        agentId,
        outcome: {
          taskId: task.id,
          prUrl: pr.url,
          status: rebuild === "conflict" ? "conflict" : "head_moved",
          reason: `PR left open for you: ${sentence}`,
          sentence,
        },
        card: { rebuild, without },
        options,
        steps,
      });
    } catch (e) {
      this.logger.warn("rebuild card not filed", { taskId: task.id, error: errorMessage(e) });
    }
  }

  /**
   * The merge port the session runner uses (`ReviewedPrMerge` around it): an accepted task
   * whose branch holds work that went away while it ran or was reviewed is rebuilt first. A
   * rebuild that voids the review, changed the task's own change or conflicted pins the
   * record at the reviewed commit and leaves it to the person with its sentence and card;
   * otherwise the merge goes on as before, on the rebuilt head.
   */
  mergePort(inner: MergePort): MergePort {
    return {
      mergeReviewed: async (req: MergeRequest): Promise<MergeOutcome | null> => {
        if (!req.task.pr_url) return inner.mergeReviewed(req);
        let left: MergeOutcome | null = null;
        const o = await this.deps.executor.rebuildTask(req.task, {
          beforePush: async (r, pr) => {
            if (r.after && !r.voids && r.ownBefore && r.ownBefore === r.ownAfter) return true;
            left = await this.leaveToPerson(req, r, pr);
            return true;
          },
        });
        if (o.result === "busy" || o.result === "failed")
          this.logger.warn("accepted task's branch not checked before its merge", {
            taskId: req.task.id,
            result: o.result,
          });
        return left ?? inner.mergeReviewed(req);
      },
    };
  }

  /** The reviewed commit pinned in the record, then left to the person (`mergePort`). */
  private async leaveToPerson(
    req: MergeRequest,
    r: DependentRebuild,
    pr: { number: number; url: string },
  ): Promise<MergeOutcome> {
    const { store } = this.deps;
    const sentence = !r.after
      ? rebuildConflictSentence(pr.number, r.dropped, r.conflicts)
      : r.voids
        ? rebuiltWithoutSentence(pr.number, r.dropped)
        : rebuiltChangedSentence(pr.number, r.dropped);
    const pinned = await store.mergeRecord.pin({
      task_id: req.task.id,
      project_id: req.task.project_id,
      agent_id: req.agentId,
      pr_number: pr.number,
      pr_url: req.task.pr_url ?? pr.url,
      reviewed_head_sha: r.before,
      own_change_id: r.ownBefore,
      author_agent: req.agentId,
    });
    const rebuild = !r.after ? "conflict" : r.voids ? "rebuilt_without" : "rebuilt_changed";
    const record = await store.mergeRecord.move(pinned.id, "left_to_you", {
      sentence,
      last_outcome: rebuild === "conflict" ? "rebuild_conflict" : rebuild,
    });
    await this.card(req.task, record, pr, sentence, rebuild, r.dropped);
    const requests = await store.humanRequest.list(
      { task_id: req.task.id, status: "open" } as never,
      { limit: 50 },
    );
    const card = requests.find(
      (row) => (row.change_card as JsonObject | null)?.key === MERGE_LEFT_OPEN_KEY,
    );
    return {
      taskId: req.task.id,
      prUrl: req.task.pr_url ?? pr.url,
      status: rebuild === "conflict" ? "conflict" : "head_moved",
      reason: `PR left open for you: ${sentence}`,
      sentence,
      ...(card ? { humanRequestId: card.id } : {}),
    };
  }
}
