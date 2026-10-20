import type { Clock } from "@forerunner/platform";

/**
 * Token bucket per key (device id, "admin:<install>" or a client address). `perMinute`
 * tokens refill continuously; a full bucket holds `burst` tokens (default `perMinute`) so a
 * burst of a minute's worth is allowed. The map is bounded: `maxKeys` buckets at most, the
 * least recently used one goes first, and `sweep()` forgets idle buckets (the service calls
 * it from the change poller tick), so a client that invents keys cannot grow memory.
 */
export interface RateDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until one token is available again (0 when allowed). */
  retryAfterSec: number;
}

export interface TokenBucketOptions {
  /** Bucket capacity; default `perMinute`. */
  burst?: number;
  /** Upper bound on the number of buckets kept; default 10,000. */
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export const DEFAULT_MAX_KEYS = 10_000;

export class TokenBucketLimiter {
  /** Insertion order doubles as recency: a used bucket is re-inserted at the end. */
  private readonly buckets = new Map<string, Bucket>();
  private readonly burst: number;
  private readonly maxKeys: number;

  constructor(
    private readonly clock: Clock,
    private readonly perMinute: number,
    opts: TokenBucketOptions = {},
  ) {
    this.burst = opts.burst ?? perMinute;
    this.maxKeys = Math.max(1, opts.maxKeys ?? DEFAULT_MAX_KEYS);
  }

  take(key: string, cost = 1): RateDecision {
    if (this.perMinute <= 0)
      return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSec: 0 };
    const now = this.clock.now();
    const refillPerMs = this.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.evict();
      b = { tokens: this.burst, updatedAt: now };
    } else {
      this.buckets.delete(key);
      b.tokens = Math.min(this.burst, b.tokens + (now - b.updatedAt) * refillPerMs);
      b.updatedAt = now;
    }
    this.buckets.set(key, b);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
    }
    const deficit = cost - b.tokens;
    const retryAfterSec = Math.max(1, Math.ceil(deficit / refillPerMs / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  /** Make room for one more bucket: idle ones first, then the least recently used. */
  private evict(): void {
    this.sweep();
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) return;
      this.buckets.delete(oldest.value);
    }
  }

  /** Forget buckets idle for `idleMs` (default ten minutes). */
  sweep(idleMs = 10 * 60_000): void {
    const cutoff = this.clock.now() - idleMs;
    for (const [k, b] of this.buckets) if (b.updatedAt < cutoff) this.buckets.delete(k);
  }

  has(key: string): boolean {
    return this.buckets.has(key);
  }

  size(): number {
    return this.buckets.size;
  }
}
