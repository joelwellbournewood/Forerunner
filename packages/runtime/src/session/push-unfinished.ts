/**
 * The project setting "Push unfinished work to GitHub" (budget-resume, the owner's decision of
 * 2026-11-02, ADR 0112 amended). Off (the default), a paused task's work in progress is a commit
 * on its branch on this computer only: a push starts the repository's automatic checks and
 * co-workers see the branch. On, it is pushed to that branch too (never a Local only file: the
 * push guard refuses one), and a Cancel then deletes the branch there.
 */
export const PUSH_UNFINISHED_SETTING = "push_unfinished_work";

/** The setting as a project's settings hold it: on only when set to true. */
export function pushUnfinishedOf(settings: Record<string, unknown> | null | undefined): boolean {
  return settings?.[PUSH_UNFINISHED_SETTING] === true;
}
