/**
 * l4-money-pause, run L4 (L4-money-111): the words of a review that waits for room, in a module
 * with no imports, so the UI's fake daemon can read the task words without the runtime's store.
 */
/**
 * Where a waiting review needs room, by the limit that refused it (L4-money-111): "room in its
 * budget", "room in this session's budget", "room in the project's budget", "room under this
 * month's cap", "room in your Claude subscription's share".
 */
export function reviewRoomWords(source: unknown): string {
  switch (source) {
    case "session":
    case "session_budget":
      return "room in this session's budget";
    case "project":
      return "room in the project's budget";
    case "month":
      return "room under this month's cap";
    case "plan":
      return "room in your Claude subscription's share";
    default:
      return "room in its budget";
  }
}

/**
 * fixup-w8-l4-leftovers (L4i-left-28): what a task paused at an outer limit says after its name,
 * the one wording for its card's title, its reason, its row and the Start dialog (wrap-up or hard
 * stop alike: L4-money-103 capped a run under an outer limit at what is left of it, less its
 * review's reserve, so the limit is never passed). Null for a limit Continue lifts.
 */
export function outerLimitPausedWords(source: unknown): string | null {
  switch (source) {
    case "project":
      return "paused before the project's budget ran out";
    case "month":
      return "paused before this month's cap ran out";
    case "plan":
      // The plan level's cap is a share of the subscription, never an amount (budget-stop).
      return "paused before your Claude subscription's share ran out";
    default:
      return null;
  }
}

/**
 * fixup-w8-l4-leftovers (L4i-left-28): whether some of the limit a run stopped at was left (what
 * the task spent is below it), as the run's own log line tells it ("its next step would have gone
 * over" against "after spending CHF 0.07"). A stop that carries no spend says nothing was left.
 */
export function limitLeftAtStop(stop: { capUsdMicro: number; spentUsdMicro?: number }): boolean {
  return typeof stop.spentUsdMicro === "number" && stop.spentUsdMicro < stop.capUsdMicro;
}

/**
 * fixup-w8-l4-leftovers (L4i-left-28): whether a paused task's card says it paused before its limit
 * ran out: its run heard the wrap-up (L3-research-2), or it stopped under an outer limit (the
 * project's budget, this month's cap, the subscription's share) with some of it left. The
 * outcome's `before` (the result, the session's task rows, the Sessions row) and the task's row
 * (`budgetPauseLabelOf`) read this one rule; a done task whose review waits is said apart.
 */
export function pausedBeforeLimit(card: Record<string, unknown>): boolean {
  if (card.review_waits === true) return false;
  if (card.stopped_by === "wrap_up") return true;
  if (!outerLimitPausedWords(card.source)) return false;
  return limitLeftAtStop({
    capUsdMicro: typeof card.cap_usd_micro === "number" ? card.cap_usd_micro : 0,
    ...(typeof card.spent_usd_micro === "number" ? { spentUsdMicro: card.spent_usd_micro } : {}),
  });
}
