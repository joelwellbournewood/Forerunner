/**
 * Who a session log line is for (core-experience design §3.7), with no store and nothing that
 * needs Node: the daemon's `eventView`, the shared state service's and the UI's stand-in daemon
 * (`apps/ui/test/fake-daemon.ts`) split the log the same way.
 *
 * `person`: what a person follows a session by (a task started, what it changed, how it ended,
 * what the critic said, what needs them), at most about eight lines per task, shown by default.
 * `detail`: the internals (the brief, memory, peers, the queue, each tool step, the review's
 * measurements, notifications), shown under Details. Before, every event was one line of the
 * same weight: about 80 lines for a session of three tasks, with event type names, markdown cut
 * mid-word and the notification channels that were not set up.
 */
export type EventAudience = "person" | "detail";

/** The types a person reads by default; every other type is a detail. */
export const PERSON_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.started",
  "session.paused",
  "session.plan_filed",
  "session.plan_approved",
  "session.stopped",
  "session.error",
  "session.ended",
  "session.sandbox_waiting",
  "task.started",
  "task.files",
  "task.finished",
  "task.retrying",
  "task.sandbox_waiting",
  "task.moved_while_running",
  "task.blocked_by_findings",
  "critic.verdict",
  "critic.review_failed",
  "pr.merged",
  "pr.left_open",
  "pr.merge_failed",
  "budget.warning",
  "billing.fallback",
  "peer.overlap",
  "change",
  "chat.human",
  "chat.reply",
]);

/** Who the line of an event is for (the session page shows `person` lines, Details the rest). */
export function eventAudience(type: string, p: Record<string, unknown> = {}): EventAudience {
  if (!PERSON_EVENT_TYPES.has(type)) return "detail";
  // A run the person's own stop ended is told once, by the stop's line ("Stopped by you
  // during ..."), not again as a finished task.
  if (type === "task.finished" && p.outcome === "killed") return "detail";
  return "person";
}
