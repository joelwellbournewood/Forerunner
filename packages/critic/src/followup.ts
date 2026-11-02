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
/**
 * The critic's sign-off (a tier 3 review, a `human` verdict), in the person's words (design
 * §3.8): each option says what it does; `signoffAnswer` reads them as accept, revise, cancel,
 * and still reads the words of cards filed before ("accept", "revise", "cancel").
 */
export const SIGNOFF_OPTIONS = ["Accept the work", "Send it back", "Cancel task"] as const;
/**
 * A task that failed after its retries (the retry ladder's last rung, or a run that failed),
 * design §3.8 "Failed task": Try again (a session tries again), Mark done anyway (closed although
 * nothing passed review), Cancel task. Read as revise, accept, cancel.
 */
export const RETRY_CARD_OPTIONS = ["Try again", "Mark done anyway", "Cancel task"] as const;
/** What an answer does, whatever words the card used. */
export type SignoffAnswer = "accept" | "revise" | "cancel";
/**
 * Why the card was filed: the verdict itself (tier 3, `human`), an exhausted ladder, or a run
 * that failed (the session's failed-task card, the task in `failed`).
 */
export type SignoffReason = "verdict" | "retry_ladder_exhausted" | "failed";

/** The options a card of this reason offers. */
export function signoffOptionsFor(reason: SignoffReason): readonly string[] {
  return reason === "verdict" ? SIGNOFF_OPTIONS : RETRY_CARD_OPTIONS;
}

/**
 * The reason an accepted retry card records on the task: the Tasks tab then reads "Done:
 * accepted without review" (design §2, ADR 0102 decision 2).
 */
export const ACCEPTED_WITHOUT_REVIEW = "accepted without review: you marked it done in the Inbox";

export interface SignoffCardInput {
  taskId: string;
  reviewId: string | null;
  /** The run that produced the work; an accepted sign-off resolves the findings against it. */
  runId: string | null;
  /** The findings of the review the sign-off is about (open until the answer). */
  findingIds: readonly string[];
  reason: SignoffReason;
  /** The card's title, naming the task: '"Style the page" failed 4 times'. */
  title?: string;
  /** The specialist's (or the critic's) own words about it, one or two sentences. */
  said?: string | null;
  /** Who said it: the specialist's name ("designer"), or "critic". */
  saidBy?: string | null;
}

export function signoffCard(input: SignoffCardInput): JsonObject {
  return {
    key: SIGNOFF_KEY,
    task_id: input.taskId,
    review_id: input.reviewId,
    run_id: input.runId,
    finding_ids: [...input.findingIds],
    reason: input.reason,
    ...(input.title ? { title: input.title } : {}),
    ...(input.said ? { said: input.said } : {}),
    ...(input.saidBy ? { said_by: input.saidBy } : {}),
    applied_at: null,
  };
}

/**
 * One or two sentences of a report or a summary as the card quotes them (design §3.8, §5): no
 * markdown, no stand-in tag, no heading words, at most `max` characters, cut at a word.
 */
export function quotedWords(text: string | null | undefined, max = 160): string | null {
  if (!text) return null;
  let t = text
    .replace(/\*\*(?:summary|criteria|report)\*\*/gi, " ")
    .split(/\n\s*(?:\*\*criteria\*\*|#+\s|criteria:)/i)[0] as string;
  t = t
    .replace(/\[stand-in model\]\s*/gi, "")
    .replace(/[*`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  // A sentence ends at ".", "!" or "?" before a space or the end; a dot inside a word (a file
  // name such as "data/members.csv") does not end it (before, the quote began at "csv ...").
  const sentences = t.match(/(?:[^.!?]|[.!?](?=\S))+[.!?]+(?=\s|$)|(?:[^.!?]|[.!?](?=\S))+$/g) ?? [
    t,
  ];
  let out = "";
  for (const s of sentences.slice(0, 2)) {
    const next = `${out}${out ? " " : ""}${s.trim()}`;
    if (out && next.length > max) break;
    out = next;
  }
  if (out.length <= max) return out;
  const cut = out.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The registry's specialists whose id is not how a person names them. */
const SPECIALIST_WORDS: Readonly<Record<string, string>> = {
  "writer-marketing": "writer",
  "migration-specialist": "migration specialist",
  "data-analyst": "data analyst",
  "ops-deploy": "deployment specialist",
  "science-evaluator": "evaluator",
};

/**
 * A specialist as a card and the session log name it: "writer-marketing" is "the writer",
 * "migration-specialist" "the migration specialist" (before, the id's first half: "The
 * migration could not do …"); another id in words ("some_new-kind": "some new kind").
 */
export function saidByName(specialist: string | null | undefined): string | null {
  const id = specialist?.trim().toLowerCase();
  if (!id) return null;
  return SPECIALIST_WORDS[id] ?? (id.replace(/[-_\s]+/g, " ").trim() || null);
}

/** A task title as a card's title names it: whole when short, else cut at a word. */
function titleOf(title: string, max = 60): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The words of a retry card (design §3.8, "Retry card" before and after): the title names the
 * task and how often it failed; the body is what the specialist said, in its own words. What
 * waits on the task is said by the Inbox when it shows the card (true now, not when filed).
 */
export function retryCardWords(input: {
  title: string;
  attempts: number;
  said: string | null;
  saidBy: string | null;
}): { title: string; why: string } {
  const title = `"${titleOf(input.title)}" failed ${
    input.attempts <= 1 ? "" : input.attempts === 2 ? "twice" : `${input.attempts} times`
  }`.trimEnd();
  const who = input.saidBy ? `The ${input.saidBy}` : "The specialist";
  const why = input.said
    ? `${title}. ${who} said: "${input.said.replace(/"/g, "'")}"`
    : `${title}. Nothing it tried passed review.`;
  return { title, why };
}

/**
 * How often a task was tried, for a retry card's "failed N times" (design §1, true now): the
 * specialists' own runs of the task (not the critic's reviews, not sub-runs), as the Tasks tab
 * lists them. The task's retry counter (`attempt`) also moves on the way back from a card ("Try
 * again" goes needs_human -> ready, and a failed task -> ready again), so it overstates the
 * tries. `fallback` when the task has no run rows (a card filed without one).
 */
export async function triedTimes(
  store: Pick<StateStore, "run">,
  taskId: string,
  fallback: number,
): Promise<number> {
  const runs = await store.run.forTask(taskId, { limit: 1000 });
  const work = runs.filter((r) => r.specialist !== "critic" && !r.parent_run_id).length;
  return work > 0 ? work : fallback;
}

/** The words of the critic's sign-off card: the title names the task, the body the critic. */
export function signoffCardWords(input: { title: string; summary: string | null }): {
  title: string;
  why: string;
} {
  const title = `"${titleOf(input.title)}" needs your sign-off`;
  const said = quotedWords(input.summary);
  return {
    title,
    why: said ? `${title}. The critic said: "${said.replace(/"/g, "'")}"` : `${title}.`,
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
  /**
   * What the specialist reported about the work (its final report): the retry card quotes it
   * in its own words (design §3.8), not the critic's summary.
   */
  workReport?: string | null;
  /** The specialist that did the work ("designer"), for "The designer said: …". */
  specialist?: string | null;
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
  reason: SignoffReason,
  attempts: number,
): Promise<string> {
  if (review.humanRequestId) {
    const existing = await ctx.store.humanRequest.get(review.humanRequestId);
    if (existing && existing.status === "open") return existing.id;
  }
  const findingIds = review.reviewId
    ? (await ctx.store.finding.forReview(review.reviewId)).map((f) => f.id)
    : [];
  // Design §3.8: the title names the task; the body is the specialist's own words about its
  // work (a retry card) or the critic's (a sign-off), never the ladder's jargon.
  const said =
    reason === "verdict"
      ? quotedWords(review.summary)
      : (quotedWords(ctx.workReport) ?? quotedWords(review.summary));
  const saidBy =
    reason === "verdict" || !quotedWords(ctx.workReport) ? "critic" : saidByName(ctx.specialist);
  const words =
    reason === "verdict"
      ? signoffCardWords({ title: task.title, summary: review.summary })
      : retryCardWords({ title: task.title, attempts, said, saidBy });
  const req = await ctx.store.humanRequest.insert({
    human_id: ctx.humanId ?? null,
    project_id: task.project_id,
    task_id: task.id,
    session_id: ctx.sessionId ?? null,
    kind: "approval",
    // U-073: the card names its task; the Inbox shows the project beside it.
    why: words.why.slice(0, 4000),
    steps: requiredActionsOf(review),
    options: [...signoffOptionsFor(reason)],
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
      title: words.title,
      said,
      saidBy,
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
          "retry_ladder_exhausted",
          await triedTimes(store, task.id, task.attempt + 1),
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
      const humanRequestId = await signoffRequest(ctx, needs, review, "verdict", task.attempt);
      return { action: "human", task: needs, humanRequestId, reason: "verdict" };
    }
    default: {
      const v: never = review.verdict;
      throw new ForerunnerError("validation", `unknown verdict ${String(v)}`);
    }
  }
}
