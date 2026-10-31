import {
  isRebaseConflictRequest,
  REBASE_CONFLICT_KEY,
  rebaseConflictAnswer,
} from "@forerunner/capabilities";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, JsonValue, StateStore } from "@forerunner/state";
import { MERGE_LEFT_OPEN_KEY, MERGE_LEFT_OPEN_OPTIONS } from "../loop/merge.ts";

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
  /** Answers that changed nothing: the task moved on, or the answer was not an option. */
  skipped: number;
}

export interface PrAnswersDeps {
  store: StateStore;
  clock: Clock;
  humanId: string;
  /** The principal agent: the actor of the task moves, with the human's id. */
  agentId: string;
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
export function leftOpenAnswer(answer: JsonValue | null): "merged" | "left_open" | null {
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
