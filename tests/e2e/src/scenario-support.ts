/**
 * Small waits the scenarios share. Nothing here sleeps on the simulated clock's behalf: a
 * scenario advances the clock itself and these helpers only bound the real time a wait may
 * take, so a broken scenario fails instead of hanging.
 */
import type { SimulatedClock } from "@forerunner/platform";

/** Real-time bound on a wait (ms). */
export const DEFAULT_WAIT_MS = 30_000;

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `fn` in real time until it returns a value, or fail after `ms` wall time. */
export async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  label = "value",
  ms = DEFAULT_WAIT_MS,
  stepMs = 20,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`waitFor: no ${label} within ${ms} ms`);
    await tick(stepMs);
  }
}

/**
 * Advance the simulated clock in `stepMs` steps, yielding `realStepMs` of wall time between
 * steps so real I/O (SMTP, SQLite, git) progresses, until `done` holds or `maxMs` of simulated
 * time passed. Returns the simulated milliseconds advanced. A scenario asserts the elapsed
 * simulated time against the spec's bound ("within one minute").
 */
export async function advanceUntil(
  clock: SimulatedClock,
  done: () => boolean | Promise<boolean>,
  opts: { maxMs: number; stepMs?: number; realStepMs?: number },
): Promise<number> {
  const stepMs = opts.stepMs ?? 1_000;
  const realStepMs = opts.realStepMs ?? 25;
  let elapsed = 0;
  while (!(await done())) {
    if (elapsed >= opts.maxMs) break;
    await tick(realStepMs);
    if (await done()) break;
    await clock.advance(stepMs);
    elapsed += stepMs;
  }
  return elapsed;
}

/** ISO-8601 UTC with milliseconds, the form every timestamp is stored in. */
export const iso = (value: string | number): string => new Date(value).toISOString();
