/**
 * Every component that cares about time receives a Clock. Production uses the
 * system clock; tests and the "4 weeks of use" simulations use SimulatedClock.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch, UTC. */
  now(): number;
  /** ISO-8601 UTC timestamp for storage. */
  nowIso(): string;
  /** Resolves after `ms` (simulated clocks resolve when advanced past the deadline). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Schedule `fn` after `ms`; returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
  /** Monotonic high-resolution timer for latency measurement, in ms. */
  monotonic(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolveSleep, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolveSleep();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  setTimeout(fn: () => void, ms: number): () => void {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  }
  monotonic(): number {
    return performance.now();
  }
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/**
 * Deterministic clock. Time moves only when advance() or set() is called.
 * Timers fire in deadline order while advancing, and sleeps resolve when passed.
 */
export class SimulatedClock implements Clock {
  private current: number;
  private mono = 0;
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(start: number | string | Date = "2026-01-05T08:00:00.000Z") {
    this.current = typeof start === "number" ? start : new Date(start).getTime();
  }

  now(): number {
    return this.current;
  }
  nowIso(): string {
    return new Date(this.current).toISOString();
  }
  monotonic(): number {
    return this.mono;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolveSleep, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const cancel = this.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolveSleep();
      }, ms);
      const onAbort = () => {
        cancel();
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.push({ id, at: this.current + Math.max(0, ms), fn });
    this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }

  /** Advance by `ms`, firing due timers in order. Returns a promise so awaiting callers settle. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    // Fire timers one at a time so a timer that schedules another timer is honoured.
    for (;;) {
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.mono += next.at - this.current;
      this.current = next.at;
      next.fn();
      // Let every promise continuation triggered by the timer settle before the next timer
      // (a macrotask turn drains the whole microtask queue).
      await new Promise<void>((r) => setImmediate(r));
    }
    this.mono += target - this.current;
    this.current = target;
    await new Promise<void>((r) => setImmediate(r));
  }

  /** Jump to an absolute time (never backwards). */
  async set(to: number | string | Date): Promise<void> {
    const t = typeof to === "number" ? to : new Date(to).getTime();
    if (t < this.current) throw new Error("SimulatedClock cannot move backwards");
    await this.advance(t - this.current);
  }

  /** Advance monotonic time only; used to simulate latency without moving wall time. */
  tickMonotonic(ms: number): void {
    this.mono += ms;
  }

  pendingTimers(): number {
    return this.timers.length;
  }

  /** Milliseconds until the next pending timer is due, or null when none is pending. */
  nextTimerIn(): number | null {
    const next = this.timers[0];
    return next ? Math.max(0, next.at - this.current) : null;
  }
}

export const systemClock: Clock = new SystemClock();
