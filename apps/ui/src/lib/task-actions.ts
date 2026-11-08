import {
  TASK_DISPLAY_FILTERS,
  type TaskDisplay,
  type TaskDisplayKey,
} from "@forerunner/runtime/daemon/api-types";
import {
  cancelWorkKind,
  cancelWorkLine as cancelWorkWords,
} from "@forerunner/runtime/daemon/cancel-words";
import type { TaskAction, TaskView } from "../api/client.ts";

/**
 * The person's actions on a task (design §3.5, core-experience.md; ADR 0102), offered per
 * status in the words of the design, each with its one-line explanation. Mark failed, Send to
 * review, Mark done and Needs me are not among them: they led to states nothing processes.
 * The status itself comes from the daemon (`TaskView.display`, design §2).
 */

/** What a button does: an action the daemon applies, or a form or a link the tab opens. */
export type TaskActionKey = TaskAction | "edit" | "dependencies" | "answer" | "take_out";

export const ACTIONS: Readonly<Record<TaskActionKey, { label: string; explain: string }>> = {
  make_ready: { label: "Make ready", explain: "A session will pick it up." },
  edit: {
    label: "Edit",
    explain: "Change the wording, priority, budget, review level or specialist.",
  },
  dependencies: {
    label: "Change what it waits for",
    explain: "Pick the tasks that must finish first.",
  },
  pause: { label: "Pause", explain: "No session runs it until you press Resume." },
  resume: { label: "Resume", explain: "It is ready again; the next session can run it." },
  stop: {
    label: "Stop",
    explain: "Its run stops now and it is paused; the session goes on with the rest.",
  },
  try_again: {
    label: "Try again",
    explain: "Back to ready; your note goes into the next attempt.",
  },
  answer: { label: "Answer", explain: "Opens its card in the Inbox." },
  go_ahead: {
    label: "Go ahead without",
    explain: "Back to ready without your answers: the specialist decides and says what it assumed.",
  },
  redo: {
    label: "Redo",
    explain: "Reopens it; say what is wrong and the next attempt fixes it.",
  },
  reopen: { label: "Reopen", explain: "Brings it back as ready." },
  cancel: { label: "Cancel", explain: "Drops it." },
  // merged-actions, in the owner's words of 2026-11-02: offered on a task whose work is merged.
  take_out: {
    label: "Take this work out",
    explain: "Opens a pull request that takes its changes out of main; you merge it.",
  },
};

/**
 * The actions a status offers, the main one first (design §3.5's table). A task only the
 * person can do ("Me: ask me in the Inbox") has no specialist to go ahead without its answers:
 * it offers Answer and Cancel. A task waiting on its retry card ("Needs your decision: tried 4
 * times", design §2) has no questions to go without: Answer, Try again, Cancel.
 */
export function actionsFor(
  key: TaskDisplayKey,
  task?: Pick<TaskView, "specialist"> & Partial<Pick<TaskView, "display" | "status">>,
): readonly TaskActionKey[] {
  // A task in review whose card waits (its review failed, or a finding is still open): the
  // card's own options move it (Try again there sends it back to work); here Answer opens the
  // card, and Cancel drops it. No review is running, so Cancel stops nothing.
  if (key === "answer" && task?.status === "in_review") return ["answer", "cancel"];
  if (key === "answer" && task?.display?.blocker?.cardKind === "retry")
    return ["answer", "try_again", "cancel"];
  // Stopped at its own budget (live walk 2, B2): its card raises the budget; Edit changes it.
  // Could not run (live walk 4): its card tries again; Edit changes what stopped it (who does
  // it). Neither offers Resume, which only started the same stop again.
  const kind = task?.display?.blocker?.cardKind;
  if (key === "answer" && (kind === "budget" || kind === "cannot_run"))
    return ["answer", "edit", "cancel"];
  if (key === "answer" && task?.specialist === WHO_PERSON) return ["answer", "cancel"];
  // Asked again after the person went ahead without answering (live L-3): its card offers no
  // Go ahead without, which only ran the same ask once more; the row offers what the card does.
  if (key === "answer" && task?.display?.blocker?.goAhead === false) return ["answer", "cancel"];
  switch (key) {
    case "draft":
      return ["make_ready", "edit", "cancel"];
    case "ready":
    case "waiting":
    case "docker":
      return ["pause", "edit", "dependencies", "cancel"];
    case "stuck":
      return ["dependencies", "edit", "cancel"];
    case "running":
      return ["stop", "cancel"];
    case "review":
      return ["cancel"];
    case "answer":
      return ["answer", "go_ahead", "cancel"];
    case "paused":
      return ["resume", "edit", "cancel"];
    case "failed":
      return ["try_again", "edit", "cancel"];
    case "done":
      // merged-actions: a task whose work is in main can be taken out (`display.takeOut`). While
      // its take-out pull request is open, Redo is not offered (R-pin, leftovers7-merge: the
      // redo's new pull request would drop the take-out from the list); the row says it waits.
      if (task?.display?.takeOut?.state === "open") return [];
      return task?.display?.takeOut?.state === "offered" ? ["redo", "take_out"] : ["redo"];
    case "cancelled":
      return ["reopen"];
  }
}

/**
 * What Cancel does to the work of a task (`cancel-words.ts`): a run or review that goes on
 * stops and what it changed is taken out of the folder, Undo restores it unless the files
 * changed since (phase C, L-6); a pull request already opened stays open; a paused task's work
 * so far is set aside (budget-resume); a project linked to the person's own folder keeps what
 * it wrote (C-37, said by the daemon). Null for a task whose Cancel changes no work, and for one
 * whose run or review does not go on in the app (`display.live`, L-7).
 */
export function cancelWorkLine(
  task: Pick<TaskView, "status" | "prUrl" | "display" | "reason">,
): string | null {
  // budget-resume: the daemon says it (`display.cancelWork`: a paused task's work set aside, a
  // project linked to the person's own folder that keeps it, C-37), in the line the read-back
  // and the line after the action use (W6-7: at most 100 characters after "Drops it.").
  if (task.display?.cancelWork) return task.display.cancelWork;
  const display = displayOf(task);
  const key = display.key;
  if (task.display?.live === false) return null;
  const kind = cancelWorkKind({
    running: key === "running",
    liveReview: key === "review",
    paused: key === "answer" && display.blocker?.cardKind === "budget",
    pullRequest: !!task.prUrl,
    ownFolder: false,
  });
  return kind ? cancelWorkWords(kind) : null;
}

/** The actions that open a form or a page instead of the confirm dialog. */
export const FORM_ACTIONS: readonly TaskActionKey[] = [
  "edit",
  "dependencies",
  "answer",
  "take_out",
];

/**
 * The status in words. The daemon sends it; a view without it (an older daemon, the state
 * service) is worded from the stored status, never shown raw.
 */
export function displayOf(task: Pick<TaskView, "status" | "display" | "reason">): TaskDisplay {
  if (task.display) return task.display;
  const base = { detail: null, agentName: null, since: null, blocker: null };
  switch (task.status) {
    case "draft":
      return { ...base, key: "draft", label: "Draft", tone: "neutral" };
    case "claimed":
    case "in_progress":
      return { ...base, key: "running", label: "Running", tone: "info" };
    case "in_review":
      return { ...base, key: "review", label: "Being reviewed", tone: "info" };
    case "needs_human":
      return { ...base, key: "paused", label: "Paused", tone: "warn" };
    case "failed":
      return { ...base, key: "failed", label: "Failed", tone: "bad" };
    case "done":
      return { ...base, key: "done", label: "Done", tone: "good" };
    case "cancelled":
      return { ...base, key: "cancelled", label: "Cancelled", tone: "neutral" };
    default:
      return { ...base, key: "ready", label: "Ready", tone: "neutral" };
  }
}

/** The Status filter's choices, in the design's words. */
export const STATUS_FILTERS = TASK_DISPLAY_FILTERS;

/** Finished: no cap, no "waits for" edits, no cost limit line. */
export function isFinished(task: Pick<TaskView, "status">): boolean {
  return task.status === "done" || task.status === "cancelled";
}

/**
 * The review levels in words (ADR 0102 point 5); "full" says it needs Docker. Every task is
 * reviewed (ADR 0104): a stored tier 0 is reviewed as the light review and reads as one; the
 * project's own checks are never a level.
 */
export function reviewLevelName(tier: number): string {
  if (tier <= 1) return "Light review";
  if (tier === 2) return "Full review";
  return "Full review and your sign-off";
}

/** The first level that is a full review (the work runs in Docker). */
export const FULL_REVIEW_TIER = 2;

/**
 * Specialists whose work keeps the full review and the person's sign-off (ADR 0104, the owner's
 * decision 4: deploys and data migrations), with what their work is called; the Edit dialog
 * offers them no light review.
 */
export const FULL_REVIEW_SPECIALISTS: ReadonlyMap<string, string> = new Map([
  ["ops-deploy", "A deploy"],
  ["migration-specialist", "A data migration"],
]);

/**
 * The level a select shows for a task: a stored tier 0 is the light review (ADR 0104), and a
 * deploy or a migration is at least the full review.
 */
export function reviewLevelValue(tier: number, specialist?: string | null): number {
  const floor = specialist && FULL_REVIEW_SPECIALISTS.has(specialist) ? FULL_REVIEW_TIER : 1;
  return Math.min(3, Math.max(floor, Math.round(tier)));
}

/** The review level choices with their one-line meaning; Docker's state is said where it matters. */
export function reviewLevelChoices(dockerReady: boolean | null): { tier: number; label: string }[] {
  const docker =
    dockerReady === false
      ? "needs Docker, not running on this computer"
      : "the work runs in Docker, isolated";
  return [
    { tier: 1, label: "Light review: the critic reads the work, nothing runs in isolation" },
    { tier: 2, label: `Full review: ${docker}` },
    { tier: 3, label: `Full review and your sign-off: ${docker}` },
  ];
}

/** "Who does it" choices: the agent's choice, a specialist, or the person. */
export const WHO_AGENT = "";
export const WHO_PERSON = "person";

export function whoName(specialist: string | null | undefined): string {
  if (!specialist) return "Agent's choice";
  if (specialist === WHO_PERSON) return "You";
  return specialist;
}

/** Minutes since an instant, in words: "just now", "2 min", "1 h 5 min". */
export function elapsed(sinceIso: string | null, nowMs: number): string | null {
  if (!sinceIso) return null;
  const ms = nowMs - Date.parse(sinceIso);
  if (!Number.isFinite(ms)) return null;
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** "2 tasks will be stuck: "A" and "B"." for Cancel (design §3.5). */
export function stuckLine(titles: readonly string[]): string | null {
  if (titles.length === 0) return null;
  const named = titles.slice(0, 3).map((t) => `"${t}"`);
  const more = titles.length > 3 ? ` and ${titles.length - 3} more` : "";
  const list =
    named.length === 1
      ? named[0]
      : more
        ? `${named.join(", ")}${more}`
        : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return titles.length === 1
    ? `${list} waits on it and will be stuck.`
    : `${titles.length} tasks will be stuck: ${list}.`;
}
