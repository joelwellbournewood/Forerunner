/**
 * L4-github-130 (the owner's decision of 2026-11-18, ADR 0105 point 4 amended 2026-11-24): the
 * words of Close on the Overview's "Cancelled, still open on GitHub" row, in a leaf module so
 * the UI's fake daemon says exactly what the daemon says (design §5: one sentence, what went
 * wrong and what to do, a sentence promises only what the app does).
 *
 * The owner, verbatim: "A cancelled task whose pull request is still open on GitHub: add a
 * Close button. One press closes that pull request on GitHub (it can be reopened there); the
 * Overview's 'Cancelled, still open on GitHub' list offers it beside Open."
 */

/** The button's one-line consequence (design §3: every action says what it does, ≤ 100). */
export const CLOSE_PULL_REQUEST_EXPLAIN =
  "Closes this pull request on GitHub; you can reopen it there.";

/** The answer once GitHub closed it. */
export function pullRequestClosedSentence(n: number): string {
  return `Closed #${n} on GitHub; you can reopen it there.`;
}

/** A press on a pull request that is not open on GitHub any more (closed or merged there). */
export function closeNotOpenSentence(n: number): string {
  return `#${n} is not open on GitHub any more, so there is nothing to close.`;
}

/**
 * A press on a pull request that is not a cancelled task's (Forerunner never closes a pull
 * request by itself, ADR 0105; only the cancelled row offers Close).
 */
export function closeNotCancelledSentence(n: number): string {
  return `#${n} is not a cancelled task's pull request, so Forerunner does not close it: close it on GitHub if you do not want it.`;
}

/** GitHub refused or did not answer the close: nothing changed, and what to do. */
export function closeFailedSentence(
  n: number,
  why: "refused_token" | "no_access" | "unreachable",
): string {
  switch (why) {
    case "refused_token":
      return `GitHub refused the saved token, so #${n} was not closed: save a new one in Settings.`;
    case "no_access":
      return `The saved GitHub token cannot close #${n}: give it write access to the repository, or close #${n} on GitHub.`;
    default:
      return `GitHub did not answer, so #${n} was not closed. Try again later.`;
  }
}
