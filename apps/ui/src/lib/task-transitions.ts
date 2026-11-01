/**
 * Mirror of `TASK_TRANSITIONS` in `packages/state/src/workflow.ts` (the UI cannot import
 * `@forerunner/state`, which needs Node). The daemon validates every move; the stand-in daemon
 * of the screen tests reads this graph, and `test/tasks.test.tsx` checks the two agree. The
 * person's buttons are not this graph any more (design §3.5, ADR 0102): see `task-actions.ts`.
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

/**
 * Mirror of `AGENT_ONLY_STATUSES` in `packages/state/src/repos/task.ts`: only an agent's claim
 * puts a task there (U-013); the daemon refuses a person's move to them.
 */
export const AGENT_ONLY_STATUSES: readonly string[] = ["claimed", "in_progress"];
