/**
 * One set of task counts for a session (U-072). The session summary, the session log's
 * `session.ended` line and the notification title used to count different things: the title
 * said "0 done, 0 need you" for a session whose only task the critic sent back, and the log had
 * no "needs you". Every place now counts the same six categories, in this order.
 */
export interface SessionCounts {
  /** Accepted (or closed by checks at tier 0). */
  done: number;
  failed: number;
  /** Waiting on the person (their answer, a card, a budget stop). */
  needsYou: number;
  /** Sent back by the critic for another attempt. */
  sentBack: number;
  /** Waiting for or held at review (open findings included). */
  inReview: number;
  /** Planned and not started (the budget, a stop, a peer holding it). */
  notStarted: number;
}

export const COUNT_ORDER = [
  "done",
  "failed",
  "needsYou",
  "sentBack",
  "inReview",
  "notStarted",
] as const satisfies readonly (keyof SessionCounts)[];

/** "Done: 0. Failed: 0. Needs you: 0. Sent back by the critic: 1. ..." (the summary). */
const SENTENCE_LABELS: Record<keyof SessionCounts, string> = {
  done: "Done",
  failed: "Failed",
  needsYou: "Needs you",
  sentBack: "Sent back by the critic",
  inReview: "In review",
  notStarted: "Not started",
};

/** "0 done, 1 sent back" (titles and log lines). */
const SHORT_LABELS: Record<keyof SessionCounts, (n: number) => string> = {
  done: (n) => `${n} done`,
  failed: (n) => `${n} failed`,
  needsYou: (n) => `${n} need${n === 1 ? "s" : ""} you`,
  sentBack: (n) => `${n} sent back`,
  inReview: (n) => `${n} in review`,
  notStarted: (n) => `${n} not started`,
};

/**
 * The summary's sentence with every category, e.g. "Done: 0. Failed: 0. Needs you: 0. Sent back
 * by the critic: 1. In review: 0. Not started: 0 of 1 planned." The critic's honesty check reads
 * "Done: N" and "Failed: N" from it.
 */
export function countsSentence(c: SessionCounts, planned: number): string {
  return COUNT_ORDER.map((k) =>
    k === "notStarted"
      ? `${SENTENCE_LABELS[k]}: ${c[k]} of ${planned} planned.`
      : `${SENTENCE_LABELS[k]}: ${c[k]}.`,
  ).join(" ");
}

/** Every category, short: "0 done, 0 failed, 0 need you, 1 sent back, 0 in review, 0 not started". */
export function countsList(c: SessionCounts): string {
  return COUNT_ORDER.map((k) => SHORT_LABELS[k](c[k])).join(", ");
}

/**
 * The categories that happened, short, done always first: "0 done, 1 sent back". For a
 * notification title, where six zeros would push out what matters; the categories and their
 * names are the summary's.
 */
export function countsBrief(c: SessionCounts): string {
  return COUNT_ORDER.filter((k) => k === "done" || c[k] > 0)
    .map((k) => SHORT_LABELS[k](c[k]))
    .join(", ");
}

/** The counts of the lists a session run returns (or its notification facts carry). */
export function countsOf(x: {
  completed: readonly unknown[];
  failed?: readonly unknown[];
  needsHuman: readonly unknown[];
  retried?: readonly unknown[];
  inReview?: readonly unknown[];
  skipped?: readonly unknown[];
}): SessionCounts {
  return {
    done: x.completed.length,
    failed: x.failed?.length ?? 0,
    needsYou: x.needsHuman.length,
    sentBack: x.retried?.length ?? 0,
    inReview: x.inReview?.length ?? 0,
    notStarted: x.skipped?.length ?? 0,
  };
}
