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
 * The session's status in words (the session page's badge, the header chip): "Working",
 * "Done", "Stopped by you", "Interrupted: Forerunner closed", ...
 */
export function sessionStatusText(status: string, stopReason: string | null | undefined): string {
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
    case MONTH_CAP_STOP:
    case PROJECT_BUDGET_STOP:
    case PLAN_SHARE_STOP:
      return `Stopped at ${stopLimitWords(stopReason)}`;
    case "timeout":
      return "Stopped: the time limit was reached";
    case "plan_awaiting_approval":
      return "Waiting for you: approve the plan";
    case "nothing_runnable":
      return "Ended: nothing could run";
    // U-078: no Claude credential may serve its work now; it starts by itself (the result says when).
    case CREDENTIAL_WAIT_STOP:
      return "Waiting for a Claude credential";
    default:
      break;
  }
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  return "Stopped";
}

/**
 * How many tasks a finished session left waiting for the person (`handoff.blocked`: the tasks
 * that need an answer or failed, each with its card). A session that "completed" with those is
 * not simply "Done" (wave 1 handoff).
 */
export function blockedOfHandoff(handoff: unknown): number {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return 0;
  const b = (handoff as { blocked?: unknown }).blocked;
  return Array.isArray(b) ? b.length : 0;
}

/** "Ended: 1 task needs you" for a session that finished with tasks waiting for the person. */
export function endedStatusText(
  status: string,
  stopReason: string | null,
  blocked: number,
): string {
  const text = sessionStatusText(status, stopReason);
  if (status !== "completed" || blocked === 0 || text !== "Done") return text;
  return `Ended: ${blocked} ${blocked === 1 ? "task needs" : "tasks need"} you`;
}

/** `handoff.stop_reason` of a session row, or null. */
export function stopReasonOfHandoff(handoff: unknown): string | null {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return null;
  const r = (handoff as { stop_reason?: unknown }).stop_reason;
  return typeof r === "string" ? r : null;
}
