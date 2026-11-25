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

/**
 * W15B-14: the review-only pass (W15-27) goes on in this session ("The critic reviews "X": its
 * work was done in an earlier session."). Its own type, never a `task.started`: no run follows
 * and no `task.finished` ends it, and the readers of the task in flight (the session view, the
 * project's header, the chat's "# Working now", the UI's `currentFromLog`) take the last
 * `task.started` for one.
 */
export const REVIEW_RESUMED_EVENT = "critic.review_resumed";

/**
 * D4 (d1109-oversize-start): the session took the task larger than its work budget after the
 * work that fits, with what was left ('Took "Build the shop", larger than this session's work
 * budget, with about CHF 2.80 left.'). Once, when taken.
 */
export const TOOK_LARGER_EVENT = "session.took_larger";

/**
 * d1109-oversize-pause (OP-5): a task paused at its specialist's limit per run goes on in the
 * same session from where it stopped ('The coder goes on with "Build the shop" from where it
 * stopped.'). Once per run again.
 */
export const TASK_CONTINUES_EVENT = "session.task_continues";

/**
 * d1109-starts-engine (S-7, S-10; ADR 0118): work made ready while the session ran joined it
 * ('Took "Fix the footer", made ready while it ran (about CHF 0.30).'); work that asked and did
 * not fit, at the end ('Left for your next Start: "D" (about CHF 0.50).'); and a session that
 * goes on with the person's earlier one ('Goes on with your session of 14:05.'). The promise
 * at the start (`session.promised`) is a detail line.
 */
export const JOINED_EVENT_TYPE = "session.joined";
export const LEFT_FOR_NEXT_START_EVENT_TYPE = "session.left_for_next_start";
export const CONTINUES_EVENT_TYPE = "session.continues";
export const PROMISED_EVENT_TYPE = "session.promised";

/**
 * d1109-selftasks-run (ADR 0119): one task check at a boundary ('Checked the task list after
 * "Create the page": no change (CHF 0.01).'). l4-selftasks-108 (ADR 0119 point 9, dated note of
 * 2026-11-22; live check 4: the person-level lines added up to less than the session's spend):
 * a person line with its cost on its row; a check that made no call (`called: false`, every
 * line read like an instruction) stays a detail.
 */
export const TASK_CHECKED_EVENT = "session.task_checked";
/**
 * l4-selftasks-104: what a check left out, in words ('Left out (and 1 more): adding "X":
 * …'), a Details line beside the check's own.
 */
export const TASK_CHECK_LEFT_OUT_EVENT = "session.task_check_left_out";

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
  TOOK_LARGER_EVENT,
  TASK_CONTINUES_EVENT,
  JOINED_EVENT_TYPE,
  LEFT_FOR_NEXT_START_EVENT_TYPE,
  CONTINUES_EVENT_TYPE,
  TASK_CHECKED_EVENT,
  "task.started",
  "task.files",
  "task.finished",
  "task.retrying",
  "task.sandbox_waiting",
  "task.moved_while_running",
  "task.blocked_by_findings",
  REVIEW_RESUMED_EVENT,
  "critic.verdict",
  "critic.review_failed",
  "critic.review_paused",
  "pr.merged",
  "pr.left_open",
  "pr.merge_failed",
  "budget.warning",
  "billing.fallback",
  "billing.switch",
  "billing.back",
  "peer.overlap",
  "change",
  "chat.human",
  "chat.reply",
]);

/**
 * Who the line of an event is for (the session page shows `person` lines, Details the rest).
 * The runner marks what a line depends on in the payload, so the live stream and a reload split
 * the log the same way: `again` (the task already started in this session), `handedFrom` (the
 * specialist before, when another one takes over), `review` (the critic reviews the run next)
 * and `couldNot` (the run said it could not do the work; the critic's line quotes it).
 */
export function eventAudience(type: string, p: Record<string, unknown> = {}): EventAudience {
  if (!PERSON_EVENT_TYPES.has(type)) return "detail";
  // A run the person's own stop ended is told once, by the stop's line ("Stopped by you
  // during ..."), not again as a finished task.
  if (type === "task.finished" && p.outcome === "killed") return "detail";
  // A credential stopped the run (U-078): its `billing.fallback` line says what happened and
  // what comes next ("... waits until 15:40 ... and starts by itself."), once.
  if (type === "task.finished" && p.outcome === "usage_limit") return "detail";
  // A second task waiting for the same credential (the leftovers of wave 7): the first one's
  // line and the session's end say the wait; the rest are details.
  if (type === "billing.fallback" && p.repeat === true) return "detail";
  // C5-left-1 (CE-11): a stop's switch is told once per session; a later task's is a detail.
  if (type === "billing.switch" && p.repeat === true) return "detail";
  // l4-selftasks-108: a task check that made no call (nothing to pay, nothing changed).
  if (type === TASK_CHECKED_EVENT && p.called === false) return "detail";
  // A retry in the same session is told by what came of it (design §3.7: about eight lines per
  // task; the walk's failing task had twelve): the same specialist starting again is a detail,
  // another one taking over is not.
  if (type === "task.started" && p.again === true && typeof p.handedFrom !== "string")
    return "detail";
  // The critic's line says how a reviewed run ended: for a run that could not do the work it is
  // the design's one line ('The designer could not …: "…". Trying again.'), and for a retry it
  // says what came of it. The run's own line is then a detail.
  // w8-l4-leftovers (L4i-left-58, L4-money-110): a run that went on in the session after its
  // pause (`continued`) is no retry the critic sent back: its own line carries its spend, which
  // the critic's line does not (before, the person's lines showed no CHF for it).
  if (
    type === "task.finished" &&
    p.review === true &&
    (typeof p.couldNot === "string" || (p.again === true && p.continued !== true))
  )
    return "detail";
  return "person";
}
