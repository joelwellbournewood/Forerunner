/**
 * What Cancel does to a task's work, in the person's words (budget-resume; W6-7, C-37), one
 * place for the Tasks tab's dialog, the line after the action, the chat's read-back and the fake
 * daemon. Each dialog line follows "Drops it." within design §5.1's 100 characters.
 *
 * - `run` / `review`: a run or review that goes on here stops, and what it changed is taken out
 *   of the folder it ran in (ADR 0105); Undo restores it unless the same files changed since
 *   (L-6). Before: 139 and 142 characters (W6-7).
 * - `pull_request`: a pull request already opened stays open; nothing is taken out.
 * - `own_folder`: a project linked to the person's own folder: nothing is set aside there, so
 *   what the run wrote stays (C-37: before, the dialog promised a removal that never came).
 * - `paused`: a task paused at a budget: its work in progress (a commit of its own) is set aside,
 *   and Undo brings it back; in a project's folder only while no later task built on it.
 */
export type CancelWorkKind =
  | "run"
  | "review"
  | "pull_request"
  | "review_pull_request"
  | "own_folder"
  | "paused";

/** The dialog's line after "Drops it." (and the chat read-back's). */
export function cancelWorkLine(kind: CancelWorkKind): string {
  switch (kind) {
    case "run":
      return "Its run stops and its changes are removed; Undo restores them unless the files changed.";
    case "review":
      return "Its review stops and its changes are removed; Undo restores them unless the files changed.";
    case "pull_request":
      return "Its run stops now; its pull request stays open.";
    case "review_pull_request":
      return "Its review stops now; its pull request stays open.";
    case "own_folder":
      return "Its run stops now; what it wrote stays in your folder.";
    case "paused":
      return "Its work so far is set aside unless a later task built on it; Undo brings it back.";
  }
}

/**
 * The line after the action, after 'Cancelled "X": ' (lower case first): what became of the
 * work. `kept` (a paused task's work another task built on): why its files stay.
 */
export function cancelledWorkWords(kind: CancelWorkKind, kept?: string | null): string {
  switch (kind) {
    case "run":
      return "its run stopped and its changes are removed; Undo restores them unless the files changed.";
    case "review":
      return "its review stopped and its changes are removed; Undo restores them unless the files changed.";
    case "pull_request":
      return "its run stopped; its pull request stays open.";
    case "review_pull_request":
      return "its review stopped; its pull request stays open.";
    case "own_folder":
      return "its run stopped; what it wrote stays in your folder.";
    case "paused":
      return kept
        ? `its files stay in the folder: ${kept}.`
        : "its work so far is set aside; Undo brings it back.";
  }
}

/**
 * Which of them a Cancel means for a task now: `running` (a run goes on, wherever), `liveReview`
 * (a review goes on in this app), `paused` (it waits on its budget card), whether it has a pull
 * request, and whether the project is linked to the person's own folder. Null: nothing happens
 * to any work (a ready task, a review no one runs).
 */
export function cancelWorkKind(t: {
  running: boolean;
  liveReview: boolean;
  paused: boolean;
  pullRequest: boolean;
  ownFolder: boolean;
}): CancelWorkKind | null {
  if (t.running) return t.pullRequest ? "pull_request" : t.ownFolder ? "own_folder" : "run";
  if (t.liveReview)
    return t.pullRequest ? "review_pull_request" : t.ownFolder ? "own_folder" : "review";
  if (t.paused) return t.ownFolder ? null : "paused";
  return null;
}
