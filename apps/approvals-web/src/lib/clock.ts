/**
 * The one place this page reads the wall clock (AGENTS.md: time goes through a Clock).
 * Everything else takes a `Clock`, so tests pin time.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const browserClock: Clock = { now: () => Date.now() };
