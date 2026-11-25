import { formatChf } from "@forerunner/billing";
import { type StopBy, stopByOf } from "../enforcement/killswitch.ts";
import type { BudgetStopSource } from "./budget-pause.ts";
import { CREDENTIAL_WAIT_STOP } from "./credential-wait.ts";
import { moneyWords } from "./money-words.ts";

/**
 * How a session ended, in the person's words (core-experience design §3.7, §4.9). Stop now,
 * Stop all and Quit all end the runs through the kill switch; before, every one of them read
 * "killed", "Kill switch: one session stopped" and left the task with the reason "kill switch",
 * so a person could not tell their own Stop from a crash or a quit. The place that asks for
 * the stop names whose it is (`KillSwitch.stop`'s `by`: the session page's Stop now, the
 * header's and the tray's Stop all, Quit, the chat's and the phone's stops); the runner and
 * the claim release read it from the abort and turn it into a stop reason, the task's reason
 * and the session's status line here. The reason's own words are never matched: the header
 * sends "stop all from the UI", the chat "human <id> via chat", the phone "remote stop from
 * device <id>", and each of them read as an error while only fixed strings were recognised.
 */

/** The kill switch reason of the session page's Stop now (`POST /sessions/:id/stop`). */
export const STOP_NOW_REASON = "stopped by you";
/** The kill switch reason of Stop all (`POST /kill` without a reason of its own). */
export const STOP_ALL_REASON = "kill switch from the app";
/** The kill switch reason of Quit (`POST /shutdown`). */
export const QUIT_REASON = "Forerunner quit";

/** Who ended a session from outside its run: the kill switch's `by`. */
export type PersonStop = StopBy;

/** The person's stop an abort names (the kill switch's `by`), or null for any other abort. */
export function personStopOf(reason: unknown): PersonStop | null {
  return stopByOf(reason);
}

/** The reason a task gets when its run is stopped this way (it goes back to ready). */
export function taskReasonForStop(stop: PersonStop): string {
  switch (stop) {
    case "you":
      return "Stopped by you";
    case "quit":
      return "Forerunner was closed";
    default:
      return "Stopped: Stop all";
  }
}

/** The stop reason a session that stopped after its current task carries. */
export const STOPPED_AFTER_TASK = "stopped_after_task";

/**
 * The stop reasons of a session ended by a task's pause at an outer limit (ADR 0112, review of
 * budget-stop): this month's cap, the project's budget, the subscription's share. Before, the
 * session took `budget_exceeded` and said "Stopped: the budget is used" and "The session's
 * budget is used." while its own budget was 1% spent, and the notification advised a larger
 * session budget, which the month's cap refuses. A stop at the session's own budget keeps
 * `budget_exceeded`.
 */
export const MONTH_CAP_STOP = "budget_month";
export const PROJECT_BUDGET_STOP = "budget_project";
export const PLAN_SHARE_STOP = "budget_plan";
const OUTER_LIMIT_STOPS: ReadonlySet<string> = new Set([
  MONTH_CAP_STOP,
  PROJECT_BUDGET_STOP,
  PLAN_SHARE_STOP,
]);

/** The session's stop reason for a pause at this limit (`BudgetStop.source`). */
export function budgetStopReasonOf(source: BudgetStopSource): string {
  switch (source) {
    case "month":
      return MONTH_CAP_STOP;
    case "project":
      return PROJECT_BUDGET_STOP;
    case "plan":
      return PLAN_SHARE_STOP;
    default:
      return "budget_exceeded";
  }
}

/** Whether a session ended at a budget: its own (`budget_exceeded`) or an outer limit's. */
export function isBudgetStopReason(stopReason: string | null | undefined): boolean {
  return stopReason === "budget_exceeded" || (!!stopReason && OUTER_LIMIT_STOPS.has(stopReason));
}

/**
 * The outer limit a session's stop names, short ("this month's cap of CHF 0.23", "your Claude
 * subscription's share"), or null for any other stop. `capChfMicro`: the limit's amount, when
 * known (the subscription's share has none in CHF).
 */
export function stopLimitWords(
  stopReason: string | null | undefined,
  capChfMicro?: number,
): string | null {
  const of =
    typeof capChfMicro === "number" && capChfMicro > 0
      ? ` of ${moneyWords(formatChf(capChfMicro), capChfMicro)}`
      : "";
  switch (stopReason) {
    case MONTH_CAP_STOP:
      return `this month's cap${of}`;
    case PROJECT_BUDGET_STOP:
      return `the project's budget${of}`;
    case PLAN_SHARE_STOP:
      return "your Claude subscription's share";
    default:
      return null;
  }
}

/**
 * The session's status in words (the session page's badge, the header chip, the Sessions list's
 * row): "Working", "Done", "Stopped by you", "Interrupted: Forerunner closed", ... One map for
 * every place (d1109-sessions, ADR 0116): a stop reason past the three live statuses is an
 * ended session's, so it is said in words that stay true later (design §5 rule 4): "Stopped to
 * wait for a Claude credential" (it read "Waiting for a Claude credential" after the credential
 * was back), "Ended with a plan for you to approve" (it read "Waiting for you: approve the plan"
 * after the plan was approved).
 */
export function sessionStatusText(
  status: string,
  stopReason: string | null | undefined,
  /**
   * fixup-w8-l4-leftovers (L4i-left-28): the session's own spend reached the outer limit it ended
   * at (`outerLimitPassed`): only then "Stopped at the project's budget" (a call billed more than
   * it was checked for); else it ended before the limit ran out.
   */
  limitPassed = false,
): string {
  if (status === "running") return "Working";
  if (status === "paused") return "Stopping after this task";
  if (status === "planned") return "Starting";
  switch (stopReason) {
    case "interrupted":
      return "Interrupted: Forerunner closed";
    case "you":
      return "Stopped by you";
    case STOPPED_AFTER_TASK:
    case "stopped_by_message":
      return "Stopped after the task, as asked";
    case "stop_all":
      return "Stopped: Stop all";
    case "quit":
      return "Stopped: Forerunner was closed";
    case "budget_exceeded":
    case "budget_finish_current":
      return "Stopped: the budget is used";
    // w8-l4-leftovers (L4i-left-28): the task paused before the limit, which is never passed
    // (its room was too small for what came next): before, "Stopped at the project's budget"
    // read as all of it spent while part of it was left.
    case MONTH_CAP_STOP:
    case PROJECT_BUDGET_STOP:
    case PLAN_SHARE_STOP:
      return limitPassed
        ? `Stopped at ${stopLimitWords(stopReason)}`
        : `Ended before ${stopLimitWords(stopReason)} ran out`;
    case "timeout":
      return "Stopped: the time limit was reached";
    case "plan_awaiting_approval":
      return "Ended with a plan for you to approve";
    case "nothing_runnable":
      return "Ended: nothing could run";
    // U-078: no Claude credential could serve its work then; the result says when it goes on.
    case CREDENTIAL_WAIT_STOP:
      return "Stopped to wait for a Claude credential";
    default:
      break;
  }
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  return "Stopped";
}

/**
 * A planning call's status in words (the plan from a brief, ADR 0055; d1109-sessions): its row
 * is a session of its own, and before it read "Done" or "Failed" beside "intake: Quote page
 * (completed)". "Drafting the plan" while the call runs, "Plan drafted" once the plan was
 * filed, "Planning failed" when it ended without one, as the project's status says it.
 */
export function planningStatusText(status: string): string {
  if (status === "running" || status === "planned" || status === "paused")
    return "Drafting the plan";
  if (status === "completed") return "Plan drafted";
  return "Planning failed";
}

/**
 * How many tasks a finished session left waiting for the person (`handoff.blocked`: the tasks
 * that need an answer or failed, each with its card). A session that "completed" with those is
 * not simply "Done" (wave 1 handoff).
 */
export function blockedOfHandoff(handoff: unknown): EndedWaits {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff))
    return { needYou: 0, paused: 0 };
  const ids = (k: "blocked" | "paused") => {
    const v = (handoff as Record<string, unknown>)[k];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  };
  const paused = new Set(ids("paused"));
  const reviews = reviewWaitIds(handoff);
  const blocked = ids("blocked");
  const waiting = blocked.filter((id) => paused.has(id));
  const reviewWaits = waiting.filter((id) => reviews.has(id)).length;
  return {
    needYou: blocked.filter((id) => !paused.has(id)).length,
    paused: waiting.length - reviewWaits,
    ...(reviewWaits ? { reviewWaits } : {}),
  };
}

/**
 * fixup-w8-l4-leftovers (L4i-left-31): the paused tasks of a session whose work is done and only
 * whose review waits for room: `handoff.review_waits` (written since w8-l4-leftovers) and, for a
 * row written before it, the outcome's paused tasks marked `reviewWaits` (L4-money-111), so an
 * older session's badge says it the same way.
 */
export function reviewWaitIds(handoff: unknown): Set<string> {
  const out = new Set<string>();
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return out;
  const h = handoff as { review_waits?: unknown; outcome?: { paused?: unknown } | null };
  if (Array.isArray(h.review_waits))
    for (const id of h.review_waits) if (typeof id === "string") out.add(id);
  const paused = h.outcome && typeof h.outcome === "object" ? h.outcome.paused : undefined;
  if (Array.isArray(paused))
    for (const t of paused)
      if (t && typeof t === "object" && (t as { reviewWaits?: unknown }).reviewWaits === true) {
        const id = (t as { id?: unknown }).id;
        if (typeof id === "string") out.add(id);
      }
  return out;
}

/** "1 review waits for room", "2 reviews wait for room" (L4i-left-31: one wording). */
export function reviewWaitsWords(n: number): string {
  return `${n} ${n === 1 ? "review waits" : "reviews wait"} for room`;
}

/**
 * What a finished session left waiting (W15B-10): the tasks that need the person (a card that
 * asks, a failed task) and those paused at a budget (`handoff.paused`), said apart as the log's
 * end line says them ("Session over: 2 paused.").
 */
export interface EndedWaits {
  needYou: number;
  paused: number;
  /**
   * w8-l4-leftovers (L4i-left-31): paused tasks whose work is done and only whose review waits
   * for room (`handoff.review_waits`), said as their rows say it, never as "paused".
   */
  reviewWaits?: number;
}

/**
 * "Ended: 1 task needs you" for a session that finished with tasks waiting for the person;
 * "Ended: 2 paused" for tasks paused at a budget, "Ended: 1 task needs you, 2 paused" with both
 * (W15B-10: before, a paused task counted as needing the person, "Ended: 3 tasks need you",
 * beside the log's "Session over: 3 paused."). A bare number counts them all as needing you.
 */
export function endedStatusText(
  status: string,
  stopReason: string | null,
  waits: number | EndedWaits,
  /** fixup-w8-l4-leftovers (L4i-left-28): `sessionStatusText`'s `limitPassed`. */
  limitPassed = false,
): string {
  const text = sessionStatusText(status, stopReason, limitPassed);
  const {
    needYou,
    paused,
    reviewWaits = 0,
  } = typeof waits === "number" ? { needYou: waits, paused: 0 } : waits;
  if (status !== "completed" || needYou + paused + reviewWaits === 0 || text !== "Done")
    return text;
  const parts = [
    needYou ? `${needYou} ${needYou === 1 ? "task needs" : "tasks need"} you` : null,
    paused ? `${paused} paused` : null,
    reviewWaits ? reviewWaitsWords(reviewWaits) : null,
  ].filter(Boolean);
  return `Ended: ${parts.join(", ")}`;
}

/**
 * l4-starts-sessions (L4-money-213): the Sessions row's own end words for a session that ended
 * with tasks that needed the person (its counts say "2 needed you") while some of them still
 * wait now: "1 still needs you", "2 still need you, 1 paused" (before: "Ended: 1 task needs you"
 * beside "2 needed you", two counts for one thing). The session page's badge keeps
 * `endedStatusText` (L-21); null when nothing needs the person now (the row then reads as
 * `endedStatusText` says, "Done" when nothing waits).
 */
export function stillWaitsText(waits: EndedWaits): string | null {
  if (waits.needYou <= 0) return null;
  const still = `${waits.needYou} still ${waits.needYou === 1 ? "needs" : "need"} you`;
  // fixup-w8-l4-leftovers (L4i-left-31): a review that waits is said as its row says it.
  return [
    still,
    waits.paused ? `${waits.paused} paused` : null,
    waits.reviewWaits ? reviewWaitsWords(waits.reviewWaits) : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * fixup-w8-l4-leftovers (L4i-left-28): whether a session that ended at an outer limit spent all of
 * it (its outcome's `spentChfMicro` against `stopCapChfMicro`, the limit's amount): a call billed
 * more than it was checked for can take a run past it. Without both figures: not passed.
 */
export function outerLimitPassed(
  o: { spentChfMicro?: unknown; stopCapChfMicro?: unknown } | null | undefined,
): boolean {
  const spent = o?.spentChfMicro;
  const cap = o?.stopCapChfMicro;
  return typeof spent === "number" && typeof cap === "number" && cap > 0 && spent >= cap;
}

/** `outerLimitPassed` of a session row's handoff (its `outcome`). */
export function outerLimitPassedOfHandoff(handoff: unknown): boolean {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return false;
  const o = (handoff as { outcome?: unknown }).outcome;
  return o && typeof o === "object" ? outerLimitPassed(o as Record<string, unknown>) : false;
}

/** `handoff.stop_reason` of a session row, or null. */
export function stopReasonOfHandoff(handoff: unknown): string | null {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return null;
  const r = (handoff as { stop_reason?: unknown }).stop_reason;
  return typeof r === "string" ? r : null;
}
