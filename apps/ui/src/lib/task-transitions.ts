/**
 * Mirror of `TASK_TRANSITIONS` in `packages/state/src/workflow.ts` (the UI cannot import
 * `@forerunner/state`, which needs Node). The daemon validates every transition; this list
 * only decides which buttons to offer. `test/tasks.test.tsx` checks the two agree.
 */
export const TASK_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ["ready", "cancelled"],
  ready: ["claimed", "needs_human", "failed", "cancelled"],
  claimed: ["in_progress", "ready", "needs_human", "failed", "cancelled"],
  in_progress: ["in_review", "needs_human", "failed", "cancelled"],
  in_review: ["done", "in_progress", "needs_human", "failed", "cancelled"],
  needs_human: ["ready", "cancelled"],
  failed: ["ready", "cancelled"],
  done: [],
  cancelled: [],
};

export const TASK_STATUSES = Object.keys(TASK_TRANSITIONS);

export function allowedTransitions(status: string): readonly string[] {
  return TASK_TRANSITIONS[status] ?? [];
}

/**
 * Mirror of `AGENT_ONLY_STATUSES` in `packages/state/src/repos/task.ts`: only an agent's claim
 * puts a task there (U-013). A person's Claim left the task held by nobody, and no session
 * planned it; the daemon now refuses the move, and the app does not offer it.
 */
export const AGENT_ONLY_STATUSES: readonly string[] = ["claimed", "in_progress"];

/** The moves a person may make: the graph's, without the agent-only ones. */
export function humanTransitions(status: string): readonly string[] {
  return allowedTransitions(status).filter((to) => !AGENT_ONLY_STATUSES.includes(to));
}

/** Button labels for the common moves; others show the raw status. */
export const TRANSITION_LABELS: Readonly<Record<string, string>> = {
  ready: "Mark ready",
  claimed: "Claim",
  in_progress: "Start",
  in_review: "Send to review",
  done: "Mark done",
  needs_human: "Needs me",
  failed: "Mark failed",
  cancelled: "Cancel",
};

export function transitionLabel(to: string): string {
  return TRANSITION_LABELS[to] ?? to;
}

/** What a move was, for the reason the app records when the human gives none (U-010). */
const DONE_LABELS: Readonly<Record<string, string>> = {
  ready: "Marked ready",
  claimed: "Claimed",
  in_progress: "Started",
  in_review: "Sent to review",
  done: "Marked done",
  needs_human: "Marked as needing you",
  failed: "Marked failed",
  cancelled: "Cancelled",
};

/**
 * The reason sent with a move whose reason field was left empty (U-010): spec B.5 keeps a
 * reason and an author on every change, and the daemon refuses an empty one, so the app
 * records what changed and where.
 */
export function defaultTransitionReason(to: string): string {
  return `${DONE_LABELS[to] ?? `Moved to ${to}`} in the app`;
}
