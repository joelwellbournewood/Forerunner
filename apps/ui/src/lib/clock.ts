import { useEffect, useState } from "react";

/**
 * The UI's clock (the browser side of the `Clock` rule in AGENTS.md): screens that count down
 * or say "3 min ago" read the time through a `UiClock` so tests inject a fixed or stepped one
 * instead of patching timers. `systemClock` is the only place the UI reads the wall clock for
 * such displays.
 */
export interface UiClock {
  /** Epoch milliseconds. */
  now(): number;
}

export const systemClock: UiClock = { now: () => Date.now() };

/** The clock's time, re-read every `tickMs` (1 s by default) while `active` is true. */
export function useNow(clock: UiClock, tickMs = 1000, active = true): number {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    setNow(clock.now());
    if (!active) return;
    const id = setInterval(() => setNow(clock.now()), tickMs);
    return () => clearInterval(id);
  }, [clock, tickMs, active]);
  return now;
}

/** "9:59" for the time left until `expiresAt`; "0:00" once it passed. */
export function formatCountdown(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
