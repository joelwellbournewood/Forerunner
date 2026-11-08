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

/** TM-4: the one sentence of that wait, with the way out. Polish owns the words. */
export function owedFolderSentence(pr: number): string {
  return `#${pr} waits for the changes left in its task's folder: commit or remove them, or redo the task.`;
}

/** TM-4: the Tasks row's label for that wait (with `owedFolderSentence` as the line under it). */
export const OWED_FOLDER_LABEL = "Accepted · merge waits for you";

/**
 * TM-4: what a merge that waits for its task folder's changes says (the Overview's row and the
 * Tasks row read it), or null when the record does not wait so. Before, such a merge read
 * "Merging…" and "Accepted · merging" with no reason until the folder was cleaned.
 */
export function owedMergeWait(record: {
  state: string;
  rebuild_owed_for?: string | null;
  last_outcome?: string | null;
  sentence: string;
}): string | null {
  if (record.state !== "queued" && record.state !== "waiting_checks") return null;
  if (!record.rebuild_owed_for || record.last_outcome !== OWED_FOLDER_CHANGES) return null;
  return record.sentence.trim() || null;
}
