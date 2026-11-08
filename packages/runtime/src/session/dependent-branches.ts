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
  fileLeftOpenRequest,
  MERGE_LEFT_OPEN_KEY,
  type MergedEvent,
  REBUILD_CARD_OPTIONS,
  type ReviewedPrMerge,
} from "../loop/merge.ts";
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
 *   could not run (the worktree was busy) and catches a dependency redone or cancelled;
 * - right before an accepted task's merge (`mergePort`), a branch that holds work which went
 *   away while it was reviewed is rebuilt first, and its review is void when that work is gone.
 */
export interface DependentBranchesDeps {
  store: StateStore;
  clock: Clock;
  merge: Pick<ReviewedPrMerge, "merged">;
  executor: Pick<PrTaskExecutor, "rebuildDependents" | "rebuildTask" | "mergeMethodOf">;
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
 * waits for you: look at it before you merge it, or send it back."
 */
export function rebuiltWithoutSentence(
  pr: number | null,
  dropped: readonly Pick<HeldDependency, "number" | "title" | "state">[],
): string {
  const gone = dropped.filter((d) => d.state !== "copied");
  const theirs = gone.length === 1 ? `${prName(gone[0]?.number)}'s changes` : "their changes";
  return `${prName(pr)} was rebuilt without ${andList(gone.map(droppedWords))}. It was reviewed with ${theirs}, so it waits for you: look at it before you merge it, or send it back.`;
}

/** A rebuild onto main (a dependency merged by squash or rebase) that changed the task's own change. */
export function rebuiltChangedSentence(
  pr: number | null,
  dropped: readonly Pick<HeldDependency, "number" | "title" | "state">[],
): string {
  return `${prName(pr)} was rebuilt onto main once ${andList(dropped.map((d) => prName(d.number)))} ${dropped.length === 1 ? "was" : "were"} merged, and its own change is no longer the one reviewed, so it waits for you: look at it before you merge it, or send it back.`;
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

export class DependentBranches {
  private readonly logger = log("dependent-branches");
  /** Rebuilds that could not run (the worktree was busy, a step failed): tried at the next sweep. */
  private readonly owed = new Map<string, { projectId: string; dependencyId: string }>();

  constructor(private readonly deps: DependentBranchesDeps) {}

  /**
   * The git host watcher's report of one task PR (`onPullRequestState`). Open: nothing here.
   * Merged: the record is marked merged (with the merge commit and how it was merged) and the
   * merge is heard like any other (`ReviewedPrMerge.merged`), which rebuilds what built on it.
   * Closed without a merge: the record is left to the person, and the dependents are rebuilt
   * without it. Throws when it could not finish, so the watcher reads the PR again.
   */
  async pullRequestState(pr: WatchedPullRequest, info: PullRequestInfo): Promise<void> {
    if (info.state === "open") return;
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
      return;
    }
    // No record (accepted before ADR 0111): what built on it is rebuilt all the same.
    await this.rebuildFor(task.project_id, task.id);
  }

  private async closedOnHost(task: TaskRow, info: PullRequestInfo): Promise<void> {
    const { store } = this.deps;
    const record = await store.mergeRecord.forTask(task.id);
    if (record && record.state !== "merged" && record.pr_number === info.number)
      await store.mergeRecord.move(record.id, "left_to_you", {
        sentence: `${prName(info.number)} was closed without merging.`,
        last_outcome: "closed",
      });
    this.logger.info("pull request closed on the host", { taskId: task.id, pr: info.number });
    await this.rebuildFor(task.project_id, task.id);
  }

  /** `ReviewedPrMerge.onMerged`: every merge, Forerunner's own and those seen on GitHub. */
  async dependencyMerged(e: MergedEvent): Promise<void> {
    await this.rebuildFor(e.task.project_id, e.task.id);
  }

  /**
   * Once per poll and repository project (`onDefaultBranchHead`): the rebuilds that could not
   * run are tried again, and a done task that waits for one that is no longer done (redone,
   * cancelled) has that one taken out of its branch.
   */
  async sweep(projectId: string): Promise<void> {
    const todo = new Map<string, string>();
    for (const [taskId, o] of this.owed)
      if (o.projectId === projectId) todo.set(o.dependencyId, taskId);
    const tasks = await this.deps.store.task.list({ project_id: projectId } as never, {
      limit: 2000,
    });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      if (t.status !== "done" || !t.branch) continue;
      for (const id of t.depends_on ?? []) {
        const dep = byId.get(id);
        if (dep && dep.status !== "done") todo.set(dep.id, t.id);
      }
    }
    for (const dependencyId of todo.keys()) await this.rebuildFor(projectId, dependencyId);
  }

  /** The dependents of `dependencyId` rebuilt; the busy ones kept for the next sweep. */
  async rebuildFor(projectId: string | null, dependencyId: string): Promise<DependentOutcome[]> {
    if (!projectId) return [];
    const outcomes = await this.deps.executor.rebuildDependents(projectId, dependencyId, {
      beforePush: (r, pr) => this.settleRecord(r, pr),
    });
    for (const o of outcomes) {
      if (o.result === "busy" || o.result === "held" || o.result === "failed")
        this.owed.set(o.taskId, { projectId, dependencyId });
      else this.owed.delete(o.taskId);
    }
    return outcomes;
  }

  /**
   * Between a dependent's rebuild and its push (ADR 0111): its merge record says what the
   * person needs to know, before any merge could follow the new head. Returns true: the push
   * goes on (a merge already under way then finds its head moved, and the record's new word
   * stands: `ReviewedPrMerge` does not follow a head when the record was moved meanwhile).
   */
  private async settleRecord(
    r: DependentRebuild,
    pr: { number: number; url: string },
  ): Promise<boolean> {
    const { store } = this.deps;
    const record = await store.mergeRecord.forTask(r.taskId);
    if (record?.state === "merged") return true;
    const task = await store.task.get(r.taskId);
    if (!r.after) {
      const sentence = rebuildConflictSentence(pr.number, r.dropped, r.conflicts);
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
      // Only what main already has was dropped: the same reviewed change on the new head.
      await store.mergeRecord.move(record.id, record.state, {
        reviewed_head_sha: r.after,
        own_change_id: r.ownAfter,
      });
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
    const { store } = this.deps;
    try {
      const open = (
        await store.humanRequest.list({ task_id: task.id, status: "open" } as never, { limit: 50 })
      ).find((row) => (row.change_card as JsonObject | null)?.key === MERGE_LEFT_OPEN_KEY);
      if (open) {
        await store.humanRequest.patch(open.id, {
          why: `The critic accepted "${task.title}", but pull request #${pr.number} was not merged. ${sentence}`,
          options,
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
