/**
 * Who merges a repository project's accepted work (merge-in-app, the owner's decision of
 * 2026-11-02; ADR 0111 amended): `you`, the default, worded "You press Merge" (each accepted
 * task's pull request waits for the person's Merge in the app); `after_review`, worded "Merge
 * automatically after review" (Forerunner merges it once the critic accepted it). The mode, not
 * the autonomy level, frees a merge: level 3 Trusted alone no longer merges. Kept in
 * `project.settings.merge_mode` and changed with `settings.set merge_mode`; the merge gate
 * (`mayMerge`) reads it again at every call.
 *
 * This module imports nothing, so the command registry (`@forerunner/commands`) can read the
 * words without importing the merge step.
 */
export const MERGE_MODE_SETTING = "merge_mode";
export const MERGE_MODES = ["you", "after_review"] as const;
export type MergeMode = (typeof MERGE_MODES)[number];

/** The mode a project's settings hold: `after_review` only when set so, else `you`. */
export function mergeModeOf(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): MergeMode {
  return settings?.[MERGE_MODE_SETTING] === "after_review" ? "after_review" : "you";
}

/** Each mode as the person reads it (Settings, the Overview's line, the change card). */
export const MERGE_MODE_WORDS: Record<MergeMode, string> = {
  you: "You press Merge",
  after_review: "Merge automatically after review",
};

/**
 * What switching to the mode changes, for the change card and the change log sentence. Turning
 * automatic merging on says what it means (owner-answers.md section 1): merges show under the
 * person's own GitHub name, a comment on a merged pull request starts nothing, and on a
 * repository whose main goes online by itself every accepted task goes live.
 */
export function mergeModeEffect(mode: MergeMode): string {
  return mode === "after_review"
    ? "Forerunner merges each task's pull request once the critic accepts it. Merges show under your GitHub name, a comment on a merged pull request starts nothing, and if this repository's main goes online by itself, every accepted task goes live"
    : "each accepted task's pull request waits for you to press Merge on the Overview";
}

/**
 * The key of a merge card (`MERGE_LEFT_OPEN_KEY` in `loop/merge.ts`) and the field its Redo sets
 * (`REDO_FROM_BASE_FIELD` in `@forerunner/capabilities`), spelled here so the command registry
 * can answer a card without importing the merge step (a test keeps them equal).
 */
export const MERGE_CARD_KEY = "merge:left_open";
export const REDO_FROM_BASE = "redo_from_base";

/**
 * A merge card answered with a redo from main (its own Redo in `session/pr-answers.ts`, or
 * W15-04 the Tasks tab's Redo of its done task in `task.reopen`): applied as "redone", with
 * `REDO_FROM_BASE`, which the task's next run reads as "Drop the branch and retry from
 * scratch" (the branch starts again from main, the open pull request gets the new work, and the
 * old branch's conflict never comes back as a rebase-conflict card).
 */
export function redoneMergeCard(card: unknown, nowIso: string): Record<string, unknown> {
  const was = card && typeof card === "object" && !Array.isArray(card) ? card : {};
  return {
    ...(was as Record<string, unknown>),
    key: MERGE_CARD_KEY,
    applied_at: nowIso,
    outcome: "redone",
    [REDO_FROM_BASE]: true,
  };
}

/** The fields `redoneMergeCard` sets on a card. */
const REDO_MARK_FIELDS = ["applied_at", "outcome", REDO_FROM_BASE] as const;

/**
 * W15-04 fix-up: what a card held in the fields `redoneMergeCard` sets, before it set them
 * (null where it had none), kept on the Redo's change so its Undo can put the card back.
 */
export function redoMarkOf(card: unknown): Record<string, unknown> {
  const was =
    card && typeof card === "object" && !Array.isArray(card)
      ? (card as Record<string, unknown>)
      : {};
  return Object.fromEntries(REDO_MARK_FIELDS.map((f) => [f, was[f] ?? null]));
}

/**
 * W15-04 fix-up: the card as it was before the Tasks tab's Redo answered it (`was` from
 * `redoMarkOf`): the Redo's mark taken off, so the card is open again as the person left it and
 * the task's next run does not start from main because of it.
 */
export function notRedoneMergeCard(card: unknown, was: unknown): Record<string, unknown> {
  const now =
    card && typeof card === "object" && !Array.isArray(card)
      ? { ...(card as Record<string, unknown>) }
      : {};
  const before =
    was && typeof was === "object" && !Array.isArray(was) ? (was as Record<string, unknown>) : {};
  for (const f of REDO_MARK_FIELDS) {
    const v = before[f];
    if (v === null || v === undefined) delete now[f];
    else now[f] = v;
  }
  return now;
}

/** "#5", "#5 and #6", "#5, #6 and #7". */
function prsWords(numbers: readonly number[]): string {
  const names = numbers.map((n) => `#${n}`);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A pull request the person's Merge approved that waits its turn behind pull requests it builds
 * on whose checks still run (merge-in-app review, 2026-11-08: it said "Merging…" and "Accepted ·
 * merging" for as long as those checks ran, up to a day, and the Overview read the list every
 * 1.5 s all that time). `after`: every open pull request it merges after, in order; `waitingOn`:
 * those whose checks run. The Overview's row and the Tasks row's detail say it in these words.
 */
export function mergesAfterSentence(
  pr: number,
  after: readonly number[],
  waitingOn: readonly number[],
): string {
  const once =
    waitingOn.length === 1
      ? `once #${waitingOn[0]}'s checks pass`
      : `once the checks of ${prsWords(waitingOn)} pass`;
  return `#${pr} merges after ${prsWords(after)}, ${once}.`;
}

/** The Tasks row's label for it (with `mergesAfterSentence` as the line under it). */
export function mergesAfterLabel(after: readonly number[]): string {
  return `Accepted · merges after ${prsWords(after)}`;
}

/**
 * TM-4 (leftovers7-tailmerge): a merge record's `last_outcome` while the merge (the person's
 * Merge, or the automatic mode's) waits for a rebuild its branch owes (`rebuild_owed_for`) and
 * the rebuild cannot run because the task's folder holds changes nobody committed. Written by
 * the merge step when it finds the folder so (`ReviewedPrMerge.sayOwedWait`), taken back once
 * the folder is clean or the rebuild ran.
 */
export const OWED_FOLDER_CHANGES = "owed_folder_changes";

/**
 * TM-4: the one sentence of that wait, with the ways out the code keeps: the changes taken out
 * of the folder (the next check rebuilds the branch), or a redo (its run sets them aside and
 * does the task again without them). Never "commit them": the rebuild starts from the branch as
 * GitHub has it, so a commit made in the folder would be on no branch afterwards (the review of
 * wave 13). Polish owns the words.
 */
export function owedFolderSentence(pr: number): string {
  return `#${pr} waits for changes left in its task's folder: take them out or redo the task.`;
}

/**
 * W15-02: the record's `last_outcome` while the rebuild its branch owes waits for a commit the
 * person made in the task's folder that GitHub's branch does not have (the rebuild starts from
 * GitHub's branch, so it never runs over it).
 */
export const OWED_FOLDER_COMMITS = "owed_folder_commits";

/**
 * W15-02: the one sentence of that wait, with the ways out the code keeps: the commit pushed to
 * GitHub (the next check rebuilds the branch with it, and the record waits for the person's look,
 * since the pull request then holds work the review did not read), or undone in the folder (the
 * next check rebuilds the branch as GitHub has it). Never "redo the task": a redo starts from
 * GitHub's branch or from main, and the commit would be left on no branch.
 */
export function owedCommitSentence(pr: number): string {
  return `#${pr} waits for a commit made in its task's folder: push it to GitHub or undo it.`;
}

/** The record outcomes of a rebuild that waits for what the person left in the task's folder. */
export const OWED_FOLDER_OUTCOMES: ReadonlySet<string> = new Set([
  OWED_FOLDER_CHANGES,
  OWED_FOLDER_COMMITS,
]);

/** The folder wait's outcome and sentence for what holds the folder (W15-02, W15-05). */
export function owedFolderWait(
  pr: number,
  held: "changes" | "commits",
): { last_outcome: string; sentence: string } {
  return held === "changes"
    ? { last_outcome: OWED_FOLDER_CHANGES, sentence: owedFolderSentence(pr) }
    : { last_outcome: OWED_FOLDER_COMMITS, sentence: owedCommitSentence(pr) };
}

/** The plain wait for the person's Merge ("You press Merge"), as the merge gate words it. */
export function waitsForYourMergeSentence(pr: number): string {
  return `#${pr} waits for you to merge it: press Merge on the Overview.`;
}

/**
 * W15-05: whether a record that waits for the person says nothing more than that (no rebuild's
 * warning, no conflict, no head that moved, no other reason it is left open): the folder's wait
 * may take its words, and gives them back once the folder is clean.
 */
export function plainWaitForYou(record: {
  last_outcome?: string | null;
  sentence: string;
}): boolean {
  const outcome = record.last_outcome ?? "";
  if (outcome === "" || outcome === "rebuild_owed" || outcome === "conflict_resolved") return true;
  return (
    outcome === "not_allowed" && /press Merge on the Overview\.?$/.test(record.sentence.trim())
  );
}

/**
 * What a record says once the folder's wait is over: a record that waits for the person's
 * Merge says that again (`waitsForYourMergeSentence`); one the person's Merge queued says
 * nothing more, and the merge goes on at the next retry (TM-4).
 */
export function folderWaitOver(record: { state: string; pr_number: number }): {
  last_outcome: string;
  sentence: string;
} {
  return record.state === "left_to_you"
    ? { last_outcome: "not_allowed", sentence: waitsForYourMergeSentence(record.pr_number) }
    : { last_outcome: "rebuild_owed", sentence: "" };
}

/** TM-4: the Tasks row's label for that wait (with `owedFolderSentence` as the line under it). */
export const OWED_FOLDER_LABEL = "Accepted · merge waits for you";

/**
 * TM-4, W15-02, W15-05: what a merge that waits for what is left in its task's folder says (the
 * Overview's row and the Tasks row read it), or null when the record does not wait so. Before,
 * such a merge read "Merging…" and "Accepted · merging" with no reason until the folder was
 * cleaned, and before the press the row offered a bare Merge (live check 2, F4): the wait is
 * now written at the poll that finds it, also on a record that waits for the person's Merge.
 */
export function owedMergeWait(record: {
  state: string;
  rebuild_owed_for?: string | null;
  last_outcome?: string | null;
  sentence: string;
}): string | null {
  if (
    record.state !== "queued" &&
    record.state !== "waiting_checks" &&
    record.state !== "left_to_you"
  )
    return null;
  if (!record.rebuild_owed_for || !OWED_FOLDER_OUTCOMES.has(record.last_outcome ?? "")) return null;
  return record.sentence.trim() || null;
}
