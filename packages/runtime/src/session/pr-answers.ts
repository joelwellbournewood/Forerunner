import {
  isRebaseConflictRequest,
  REBASE_CONFLICT_KEY,
  REDO_FROM_BASE_FIELD,
  rebaseConflictAnswer,
} from "@forerunner/capabilities";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type {
  HumanRequestRow,
  JsonObject,
  JsonValue,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import {
  MERGE_LEFT_OPEN_KEY,
  MERGE_LEFT_OPEN_OPTIONS,
  type ReviewedPrMerge,
} from "../loop/merge.ts";
import { resumeWork, type StartPort } from "./resume-work.ts";

/**
 * The answers of the pull-request cards (U-028), applied from `RuntimeApp.syncApprovals` (the
 * daemon's answer route, `request.answer`, the approvals poll, compose):
 *
 * - a rebase conflict (`PrTaskExecutor`, `@forerunner/capabilities`; the task is
 *   `needs_human`): "I resolved it" and "Drop the branch and retry from scratch" put the task
 *   back to `ready` (the next session plans it; its run reads the outcome on the card and
 *   continues from the person's branch, or starts the branch again from the base), "Cancel the
 *   task" cancels it. A task that is no longer `needs_human` is left alone (`task_moved_on`).
 * - a reviewed PR the merge step left open (`ReviewedPrMerge`; the task is `done`): "I merged
 *   it" records the merge on the task (`reason`), "Leave it open" records the choice.
 * - the card a dependent branch's rebuild filed (R-rebuildcard, leftovers7-merge; its pull
 *   request is still open, so no "I merged it"): "Merge" approves the merge as the Overview's
 *   Merge does (the person's approval, through the merge step: merged now, or by the watcher's
 *   retry once it can), "Redo" makes the done task ready again and starts a session for it, as
 *   every answer that makes a task runnable does (design 3.8), and its next run starts the
 *   branch again from main (`REDO_FROM_BASE_FIELD`, as "Drop the branch and retry from scratch"
 *   does; the open pull request gets the new work); "Leave it open" as above.
 *
 * Each answer is applied once: the card records `applied_at` and the `outcome`, in the same
 * transaction as the task's move. A card filed before it had a key (the same options on a
 * `decision` request with a task) is read the same way. An answer outside the options is
 * recorded as `unrecognized_answer` and changes nothing.
 */
export interface PrAnswersResult {
  resolved: number;
  dropped: number;
  cancelled: number;
  merged: number;
  leftOpen: number;
  /** A rebuild card's Merge (R-rebuildcard). */
  merging: number;
  /** A rebuild card's Redo (R-rebuildcard). */
  redone: number;
  /** Answers that changed nothing: the task moved on, or the answer was not an option. */
  skipped: number;
}

export interface PrAnswersDeps {
  store: StateStore;
  clock: Clock;
  humanId: string;
  /** The principal agent: the actor of the task moves, with the human's id. */
  agentId: string;
  /**
   * The merge step (a rebuild card's Merge): the person's approval, then the merge in order.
   * Absent: the record is approved and queued, and the watcher's retry pass merges it.
   */
  merge?: Pick<ReviewedPrMerge, "approveInOrder" | "mergeApproved">;
  /** Starts (or queues) a session: a rebuild card's Redo resumes work (`resumeWork`). */
  start?: StartPort;
}

const PAGE = 200;

export async function syncPrAnswers(deps: PrAnswersDeps): Promise<PrAnswersResult> {
  const logger = log("pr-answers");
  const out: PrAnswersResult = {
    resolved: 0,
    dropped: 0,
    cancelled: 0,
    merged: 0,
    leftOpen: 0,
    merging: 0,
    redone: 0,
    skipped: 0,
  };
  for (const row of await unappliedPrAnswers(deps.store, deps.humanId)) {
    try {
      const outcome = isRebaseConflictRequest(row)
        ? await applyRebaseAnswer(deps, row)
        : await applyMergeAnswer(deps, row);
      if (outcome === "resolved") out.resolved++;
      else if (outcome === "dropped") out.dropped++;
      else if (outcome === "cancelled") out.cancelled++;
      else if (outcome === "merged") out.merged++;
      else if (outcome === "left_open") out.leftOpen++;
      else if (outcome === "merging") out.merging++;
      else if (outcome === "redone") out.redone++;
      else out.skipped++;
    } catch (e) {
      logger.warn("pull request answer not applied", { requestId: row.id, error: errorMessage(e) });
    }
  }
  return out;
}

/** Whether a request is a merge-left-open request (its card key, or the options of one filed before the key). */
export function isLeftOpenRequest(
  row: Pick<HumanRequestRow, "kind" | "task_id" | "options" | "change_card">,
): boolean {
  if (row.kind !== "decision" || !row.task_id) return false;
  const key = (row.change_card as JsonObject | null)?.key;
  if (typeof key === "string") return key === MERGE_LEFT_OPEN_KEY;
  return (
    row.options.length === MERGE_LEFT_OPEN_OPTIONS.length &&
    MERGE_LEFT_OPEN_OPTIONS.every((o, i) => row.options[i] === o)
  );
}

/** The answer of a merge-left-open request as one of its options, or null. */
export function leftOpenAnswer(
  answer: JsonValue | null,
): "merged" | "left_open" | "merge" | "redo" | null {
  const raw =
    typeof answer === "string"
      ? answer
      : answer && typeof answer === "object" && !Array.isArray(answer)
        ? ((answer as JsonObject).choice ?? (answer as JsonObject).answer)
        : null;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (v === "i merged it" || /^(merged|i merged|merged it)$/.test(v)) return "merged";
  if (v === "leave it open" || /^(leave|leave open|keep it open|left open)$/.test(v))
    return "left_open";
  // A rebuild's card (R-rebuildcard).
  if (/^(merge|merge it)$/.test(v)) return "merge";
  if (/^(redo|redo it|redo the task)$/.test(v)) return "redo";
  return null;
}

/** The human's answered `decision` requests of these two kinds whose answer is not applied yet. */
async function unappliedPrAnswers(store: StateStore, humanId: string): Promise<HumanRequestRow[]> {
  const found: HumanRequestRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await store.humanRequest.list(
      { kind: "decision", human_id: humanId, status: "answered" } as never,
      {
        orderBy: [
          { column: "created_at", direction: "asc" },
          { column: "id", direction: "asc" },
        ],
        limit: PAGE,
        offset,
      },
    );
    for (const row of page) {
      if (!isRebaseConflictRequest(row) && !isLeftOpenRequest(row)) continue;
      if ((row.change_card as JsonObject | null)?.applied_at) continue;
      found.push(row);
    }
    if (page.length < PAGE) return found;
  }
}

function markOf(row: HumanRequestRow, key: string, clock: Clock, outcome: string): JsonObject {
  return {
    ...((row.change_card ?? {}) as JsonObject),
    key,
    applied_at: clock.nowIso(),
    outcome,
  };
}

async function applyRebaseAnswer(deps: PrAnswersDeps, row: HumanRequestRow): Promise<string> {
  const { store, clock } = deps;
  const actor = { agentId: deps.agentId, humanId: deps.humanId };
  const answer = rebaseConflictAnswer(row.answer);
  const task = row.task_id ? await store.task.get(row.task_id) : undefined;
  const skip = async (outcome: string) => {
    await store.humanRequest.patch(row.id, {
      change_card: markOf(row, REBASE_CONFLICT_KEY, clock, outcome),
    });
    return outcome;
  };
  if (!answer) return skip("unrecognized_answer");
  if (task?.status !== "needs_human") return skip("task_moved_on");
  const branch = task.branch ?? "the task branch";
  return store.transaction(async (tx) => {
    let outcome: string;
    if (answer === "cancel") {
      await tx.task.transition(
        task.id,
        task.version,
        "cancelled",
        `you cancelled the task over the rebase conflict of ${branch} (request ${row.id})`,
        actor,
      );
      outcome = "cancelled";
    } else if (answer === "resolved") {
      await tx.task.transition(
        task.id,
        task.version,
        "ready",
        `you resolved the rebase conflict of ${branch} (request ${row.id}); the next run checks the branch and opens its pull request`,
        actor,
      );
      outcome = "resolved";
    } else {
      await tx.task.transition(
        task.id,
        task.version,
        "ready",
        `you dropped ${branch} (request ${row.id}); the next run starts the branch again from the base and redoes the task`,
        actor,
      );
      outcome = "dropped";
    }
    await tx.humanRequest.patch(row.id, {
      change_card: markOf(row, REBASE_CONFLICT_KEY, clock, outcome),
    });
    return outcome;
  });
}

async function applyMergeAnswer(deps: PrAnswersDeps, row: HumanRequestRow): Promise<string> {
  const { store, clock } = deps;
  const answer = leftOpenAnswer(row.answer);
  const task = row.task_id ? await store.task.get(row.task_id) : undefined;
  const card = (row.change_card ?? {}) as JsonObject;
  const prUrl =
    typeof card.pr_url === "string" ? card.pr_url : (task?.pr_url ?? "the pull request");
  // A rebuild card's own options only on a card that offers them (an old card's "merge" typed
  // as text is not one of its options).
  const offered = (o: string) =>
    row.options.some((x) => typeof x === "string" && x.toLowerCase() === o);
  if (answer === "merge" || answer === "redo") {
    if (!offered(answer)) return markMerge(deps, row, "unrecognized_answer");
    if (!task) return markMerge(deps, row, "task_moved_on");
    return answer === "merge" ? applyRebuildMerge(deps, row, task) : applyRedo(deps, row, task);
  }
  const outcome = !answer ? "unrecognized_answer" : !task ? "task_moved_on" : answer;
  return store.transaction(async (tx) => {
    if (task && answer === "merged") {
      await tx.task.patch(task.id, {
        reason: `merged by you: ${prUrl} (request ${row.id})`.slice(0, 1000),
        author_human: deps.humanId,
        author_agent: null,
      });
    } else if (task && answer === "left_open") {
      await tx.task.patch(task.id, {
        reason: `left open by you: ${prUrl} (request ${row.id})`.slice(0, 1000),
        author_human: deps.humanId,
        author_agent: null,
      });
    }
    await tx.humanRequest.patch(row.id, {
      change_card: markOf(row, MERGE_LEFT_OPEN_KEY, clock, outcome),
    });
    return outcome;
  });
}

async function markMerge(
  deps: PrAnswersDeps,
  row: HumanRequestRow,
  outcome: string,
  more: JsonObject = {},
): Promise<string> {
  await deps.store.humanRequest.patch(row.id, {
    change_card: { ...markOf(row, MERGE_LEFT_OPEN_KEY, deps.clock, outcome), ...more },
  });
  return outcome;
}

/**
 * A rebuild card's Merge (R-rebuildcard): what the Overview's Merge does for this pull request,
 * the person's approval through the merge step. The card says what came of it: merged now, or
 * merging once it can (its checks, what it builds on), or the record's sentence.
 */
async function applyRebuildMerge(
  deps: PrAnswersDeps,
  row: HumanRequestRow,
  task: TaskRow,
): Promise<string> {
  const { store } = deps;
  if (task.status !== "done") return markMerge(deps, row, "task_moved_on");
  // Marked first: a second sync while the merge runs does not merge it twice.
  await markMerge(deps, row, "merging");
  if (deps.merge) {
    const records = await deps.merge.approveInOrder([task], deps.humanId);
    const outcomes = records.length ? await deps.merge.mergeApproved(records, deps.humanId) : [];
    const last = outcomes.at(-1);
    if (last?.status === "merged")
      return markMerge(deps, row, "merging", { merge_result: "merged" });
    if (last?.sentence) return markMerge(deps, row, "merging", { merge_result: last.sentence });
    return "merging";
  }
  const record = await store.mergeRecord.forTask(task.id);
  if (record && record.state !== "merged" && record.state !== "merging")
    await store.mergeRecord.move(record.id, "queued", {
      approval: "person",
      approved_by: deps.humanId,
      sentence: `#${record.pr_number} merges now: you pressed Merge.`,
    });
  return "merging";
}

/**
 * A rebuild card's Redo (R-rebuildcard): the done task is ready again, with the card's sentence
 * as why, and a session starts (or queues) for it, as every answer that makes a task runnable
 * does (design 3.8). Its next run does the task again from main, as the card's line says: the
 * card carries `REDO_FROM_BASE_FIELD`, which `PrTaskExecutor` reads as "Drop the branch and
 * retry from scratch" (the branch starts again from main, the open pull request gets the new
 * work). Before (the review's fix-up), the run resumed the open pull request's branch and
 * rebuilt it again, so the conflict variant stopped at the same conflict with a second card.
 */
async function applyRedo(
  deps: PrAnswersDeps,
  row: HumanRequestRow,
  task: TaskRow,
): Promise<string> {
  const { store } = deps;
  if (task.status !== "done") return markMerge(deps, row, "task_moved_on");
  const actor = { agentId: deps.agentId, humanId: deps.humanId };
  await store.transaction(async (tx) => {
    await tx.task.reopen(
      task.id,
      task.version,
      "ready",
      `Redo asked by you on its card (request ${row.id})`,
      actor,
    );
    await tx.humanRequest.patch(row.id, {
      change_card: {
        ...markOf(row, MERGE_LEFT_OPEN_KEY, deps.clock, "redone"),
        [REDO_FROM_BASE_FIELD]: true,
      },
    });
  });
  await resumeWork(store, deps.start, {
    agentId: deps.agentId,
    projectId: task.project_id,
    reason: `Redo of "${task.title}" asked on its card`,
  });
  return "redone";
}
