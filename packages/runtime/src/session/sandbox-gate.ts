import type { TaskRow } from "@forerunner/state";
import { SANDBOX_SETTINGS_PLACE, type SandboxState } from "../sandbox/readiness-types.ts";

/**
 * U-079 (ADR 0101): tasks at risk tier 2 and above run in the container sandbox, and while it
 * is not ready they wait. The session runner asks the gate before it plans: the waiting tasks
 * are left out of the plan (not failed, no retry used), named in the summary with the step to
 * take, and the gate hears about them once per session (the one Inbox notice, the download).
 */
export interface SandboxGateAnswer {
  ready: boolean;
  state: SandboxState;
  /** The one step that unblocks it, in the person's words ("start Docker Desktop, then ..."). */
  step: string;
  /** What is wrong, in one sentence. */
  headline: string;
}

export interface SandboxGate {
  /** Re-checks now (before every plan). */
  check(): Promise<SandboxGateAnswer>;
  /** The session left these tasks out; the gate files or keeps its notice, may start a download. */
  waiting?(w: {
    sessionId: string;
    projectId: string | null;
    tasks: { id: string; title: string }[];
    answer: SandboxGateAnswer;
  }): Promise<void>;
}

/** Full review: the tier at and above which a task runs only in the container sandbox. */
export const FULL_REVIEW_TIER = 2;

export function needsContainerSandbox(task: Pick<TaskRow, "risk_tier">): boolean {
  return task.risk_tier >= FULL_REVIEW_TIER;
}

/** A ready task the session did not run because the sandbox is not ready. */
export interface SandboxWaitingTask {
  id: string;
  title: string;
}

/** The summary's line for them: which tasks, what is wrong, the step to take. */
export function summarizeSandboxWaiting(
  tasks: readonly SandboxWaitingTask[],
  answer: SandboxGateAnswer | null,
): string[] {
  if (tasks.length === 0 || !answer) return [];
  const shown = tasks.slice(0, 10);
  const named = shown.map((t) => `"${t.title}"`).join(", ");
  const more = tasks.length > shown.length ? ` and ${tasks.length - shown.length} more` : "";
  return [
    `Waiting for Docker: ${named}${more} ${tasks.length === 1 ? "needs" : "need"} a full review, which runs in the Docker sandbox, and it is not ready (${answer.headline.replace(/\.$/, "")}). Next: ${answer.step}. ${tasks.length === 1 ? "It runs" : "They run"} in the next session once ${SANDBOX_SETTINGS_PLACE} says Ready; nothing failed and no retry was used.`,
  ];
}
