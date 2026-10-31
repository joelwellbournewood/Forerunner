import { ForerunnerError } from "@forerunner/platform";
import {
  DEFAULT_CEILING,
  type ModelTier,
  nextRung,
  type RetryAction,
  retryAction,
} from "@forerunner/runtime";
import type { FindingRow, JsonObject, StateStore, TaskRow } from "@forerunner/state";
import { criticSettingsOf, stricterCeiling } from "./model.ts";
import type { ReviewOutput } from "./types.ts";

/**
 * The sign-off request's card (`human_request.change_card`). A tier 3 review, a `human`
 * verdict and the retry ladder's last rung all end with one blocking request whose options
 * are `SIGNOFF_OPTIONS`; the runtime's `syncSignoffAnswers` (`packages/runtime`,
 * `session/findings.ts`) finds the answered ones by `SIGNOFF_KEY`, applies the answer to the
 * task named here (accept closes it with the findings resolved against `run_id`, revise sends
 * it down the retry ladder, cancel cancels it) and writes `applied_at` and `outcome` back, so
 * every answer is applied once.
 */
export const SIGNOFF_KEY = "critic:signoff";
export const SIGNOFF_OPTIONS = ["accept", "revise", "cancel"] as const;
export type SignoffAnswer = (typeof SIGNOFF_OPTIONS)[number];
/** Why the sign-off was filed: the verdict itself (tier 3, `human`) or an exhausted ladder. */
export type SignoffReason = "verdict" | "retry_ladder_exhausted";

export interface SignoffCardInput {
  taskId: string;
  reviewId: string | null;
  /** The run that produced the work; an accepted sign-off resolves the findings against it. */
  runId: string | null;
  /** The findings of the review the sign-off is about (open until the answer). */
  findingIds: readonly string[];
  reason: SignoffReason;
}

export function signoffCard(input: SignoffCardInput): JsonObject {
  return {
    key: SIGNOFF_KEY,
    task_id: input.taskId,
    review_id: input.reviewId,
    run_id: input.runId,
    finding_ids: [...input.findingIds],
    reason: input.reason,
    applied_at: null,
  };
}

/**
 * What happens to a task after its review (spec B.4, D.2, H). The verdict is applied through
 * the state repositories, so every rule they enforce holds here too: a task cannot close with
 * open findings (`findings_open`), and only legal workflow moves happen.
 *
 * - accept: the findings of this review are resolved (`resolved_by_run` points at the run that
 *   produced the work) and the task moves in_review -> done; any other open finding makes the
 *   store refuse the close and the error propagates;
 * - revise: in_review -> failed -> ready, which counts an attempt, plus a message to the owner
 *   agent listing the required actions;
 * - escalate: the runtime's retry policy decides from the attempt count: improve the brief,
 *   split or change specialist, escalate one rung under the ceiling, or human. The task goes
 *   back to ready (attempt + 1) for the first three; the session runner applies the decision;
 * - human: in_review -> needs_human with a sign-off request (the one the review created, or a
 *   new one).
 */
export interface FollowupContext {
  store: StateStore;
  /** The critic AgentRow id: author of the transitions, sender of the messages. */
  criticAgentId: string;
  /** Rung the failed attempt ran on. Default sonnet (the coding specialist's default). */
  currentTier?: ModelTier;
  /**
   * A ceiling for this escalation. The task's project row (`settings.critic_ceiling`) is always
   * read; the stricter of the two applies, and the ladder's default when neither is set (D.3).
   */
  ceiling?: ModelTier;
  /** Human to address a sign-off request to. */
  humanId?: string | null;
  /** Agent to message on revise; default the task's owner agent. */
  ownerAgentId?: string | null;
  /** Run that produced the work under review; recorded on resolved findings. */
  runId?: string | null;
  sessionId?: string | null;
}

export type FollowupDecision =
  | { action: "accepted"; task: TaskRow; resolvedFindingIds: string[] }
  | {
      action: "revise";
      task: TaskRow;
      attempt: number;
      messageId: string | null;
      requiredActions: string[];
    }
  | {
      action: "retry";
      retry: Exclude<RetryAction, "human">;
      task: TaskRow;
      attempt: number;
      /** The rung to run next when `retry` is "escalate"; never above the ceiling. */
      nextTier: ModelTier | null;
      messageId: string | null;
      requiredActions: string[];
    }
  | {
      action: "human";
      task: TaskRow;
      humanRequestId: string;
      reason: "verdict" | "retry_ladder_exhausted";
    };

export const DEFAULT_WORK_TIER: ModelTier = "sonnet";

export function requiredActionsOf(review: Pick<ReviewOutput, "findings">): string[] {
  return review.findings.map((f) => `[${f.severity}] ${f.description}: ${f.requiredAction}`);
}

async function ensureInReview(store: StateStore, task: TaskRow, agentId: string): Promise<TaskRow> {
  if (task.status === "in_review") return task;
  if (task.status === "in_progress") {
    return store.task.transition(task.id, task.version, "in_review", "critic review", {
      agentId,
    });
  }
  throw new ForerunnerError(
    "validation",
    `task ${task.id} is ${task.status}; a verdict applies to a task in review`,
    { details: { taskId: task.id, status: task.status } },
  );
}

/** in_review -> failed -> ready; the second move counts the attempt. */
async function backToReady(
  store: StateStore,
  task: TaskRow,
  why: string,
  agentId: string,
): Promise<TaskRow> {
  const failed = await store.task.transition(task.id, task.version, "failed", why, { agentId });
  return store.task.transition(failed.id, failed.version, "ready", `retry after ${why}`, {
    agentId,
  });
}

async function notifyOwner(
  ctx: FollowupContext,
  task: TaskRow,
  review: ReviewOutput,
  heading: string,
  requiredActions: string[],
): Promise<string | null> {
  const toAgent = ctx.ownerAgentId ?? task.owner_agent_id;
  const toHuman = toAgent ? null : (ctx.humanId ?? null);
  if (!toAgent && !toHuman) return null;
  const body = [
    `${heading} for task "${task.title}" (grade ${review.grade}, confidence ${review.confidence.toFixed(2)}).`,
    review.summary,
    requiredActions.length ? "Required actions:" : "No specific finding was recorded.",
    ...requiredActions.map((a) => `- ${a}`),
    review.reviewId ? `Review: ${review.reviewId}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const msg = await ctx.store.message.send({
    from_agent_id: ctx.criticAgentId,
    to_agent_id: toAgent,
    to_human_id: toHuman,
    project_id: task.project_id,
    task_id: task.id,
    type: "request",
    body,
    requires_ack: true,
    author_agent: ctx.criticAgentId,
  });
  return msg.id;
}

async function signoffRequest(
  ctx: FollowupContext,
  task: TaskRow,
  review: ReviewOutput,
  why: string,
  reason: SignoffReason,
): Promise<string> {
  if (review.humanRequestId) {
    const existing = await ctx.store.humanRequest.get(review.humanRequestId);
    if (existing && existing.status === "open") return existing.id;
  }
  const findingIds = review.reviewId
    ? (await ctx.store.finding.forReview(review.reviewId)).map((f) => f.id)
    : [];
  const req = await ctx.store.humanRequest.insert({
    human_id: ctx.humanId ?? null,
    project_id: task.project_id,
    task_id: task.id,
    session_id: ctx.sessionId ?? null,
    kind: "approval",
    // U-073: the card names its task; the Inbox shows the project beside it.
    why: `${why} for "${task.title}": ${review.summary}`.slice(0, 4000),
    steps: requiredActionsOf(review),
    options: [...SIGNOFF_OPTIONS],
    blocking: true,
    risk: review.findings.some((f) => f.severity === "critical" || f.severity === "high")
      ? "high"
      : "medium",
    change_card: signoffCard({
      taskId: task.id,
      reviewId: review.reviewId ?? null,
      runId: ctx.runId ?? review.runId ?? null,
      findingIds,
      reason,
    }),
    author_agent: ctx.criticAgentId,
  });
  return req.id;
}

/** The stricter of the caller's ceiling and the task's project `critic_ceiling`, if any. */
export async function escalationCeiling(
  store: StateStore,
  task: Pick<TaskRow, "project_id">,
  ceiling?: ModelTier,
): Promise<ModelTier | undefined> {
  const project = task.project_id ? await store.project.get(task.project_id) : undefined;
  return stricterCeiling(ceiling, criticSettingsOf(project?.settings).ceiling);
}

export async function applyVerdict(
  taskId: string,
  review: ReviewOutput,
  ctx: FollowupContext,
): Promise<FollowupDecision> {
  const { store, criticAgentId } = ctx;
  const task = await ensureInReview(store, await store.task.mustGet(taskId), criticAgentId);
  const requiredActions = requiredActionsOf(review);

  switch (review.verdict) {
    case "accept": {
      const open: FindingRow[] = await store.finding.openFor(task.id);
      const resolvedFindingIds: string[] = [];
      for (const f of open) {
        const ours =
          (review.reviewId !== undefined && f.review_id === review.reviewId) ||
          (review.resolvedFindingIds ?? []).includes(f.id);
        if (!ours) continue;
        await store.finding.resolve(f.id, f.version, ctx.runId ?? review.runId ?? null);
        resolvedFindingIds.push(f.id);
      }
      // Throws findings_open when a finding from another review is still open (B.4).
      const done = await store.task.transition(
        task.id,
        task.version,
        "done",
        `critic accepted (grade ${review.grade}, confidence ${review.confidence.toFixed(2)})`,
        { agentId: criticAgentId },
      );
      return { action: "accepted", task: done, resolvedFindingIds };
    }
    case "revise": {
      const ready = await backToReady(
        store,
        task,
        `critic revise: ${review.findings.length} finding(s)`,
        criticAgentId,
      );
      const messageId = await notifyOwner(
        ctx,
        ready,
        review,
        "Revision requested",
        requiredActions,
      );
      return { action: "revise", task: ready, attempt: ready.attempt, messageId, requiredActions };
    }
    case "escalate": {
      const current = ctx.currentTier ?? DEFAULT_WORK_TIER;
      const ceiling = (await escalationCeiling(store, task, ctx.ceiling)) ?? DEFAULT_CEILING;
      const retry = retryAction(task.attempt + 1, current, ceiling);
      if (retry === "human") {
        const needs = await store.task.transition(
          task.id,
          task.version,
          "needs_human",
          "retry ladder exhausted: human decides",
          { agentId: criticAgentId },
        );
        const humanRequestId = await signoffRequest(
          ctx,
          needs,
          review,
          `Retry ladder exhausted after ${task.attempt + 1} failed attempt(s) at ${current} (ceiling ${ceiling})`,
          "retry_ladder_exhausted",
        );
        return { action: "human", task: needs, humanRequestId, reason: "retry_ladder_exhausted" };
      }
      const ready = await backToReady(store, task, `critic escalate: ${retry}`, criticAgentId);
      const nextTier = retry === "escalate" ? nextRung(current, ceiling) : null;
      const heading =
        retry === "improve_brief"
          ? "Retry with an improved brief"
          : retry === "split_or_change_specialist"
            ? "Split the task or change the specialist"
            : `Escalate to ${nextTier ?? current}`;
      const messageId = await notifyOwner(ctx, ready, review, heading, requiredActions);
      return {
        action: "retry",
        retry,
        task: ready,
        attempt: ready.attempt,
        nextTier,
        messageId,
        requiredActions,
      };
    }
    case "human": {
      const needs = await store.task.transition(
        task.id,
        task.version,
        "needs_human",
        "critic: human sign-off required",
        { agentId: criticAgentId },
      );
      const humanRequestId = await signoffRequest(
        ctx,
        needs,
        review,
        "Critic sign-off needed",
        "verdict",
      );
      return { action: "human", task: needs, humanRequestId, reason: "verdict" };
    }
    default: {
      const v: never = review.verdict;
      throw new ForerunnerError("validation", `unknown verdict ${String(v)}`);
    }
  }
}
