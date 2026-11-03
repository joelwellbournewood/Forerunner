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
