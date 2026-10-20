import type { Clock } from "@forerunner/platform";

/**
 * Token bucket per key (device id, or "admin"). `perMinute` tokens refill continuously;
 * a full bucket holds `perMinute` tokens so a burst of a minute's worth is allowed.
 */
export interface RateDecision {
  allowed: boolean;
  remaining: number;
  /** Seconds until one token is available again (0 when allowed). */
  retryAfterSec: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly clock: Clock,
    private readonly perMinute: number,
    private readonly burst: number = perMinute,
  ) {}

  take(key: string, cost = 1): RateDecision {
    if (this.perMinute <= 0)
      return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSec: 0 };
    const now = this.clock.now();
    const refillPerMs = this.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, updatedAt: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + (now - b.updatedAt) * refillPerMs);
      b.updatedAt = now;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
    }
    const deficit = cost - b.tokens;
    const retryAfterSec = Math.max(1, Math.ceil(deficit / refillPerMs / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  /** Forget idle buckets (called occasionally; nothing depends on it). */
  sweep(idleMs = 10 * 60_000): void {
    const cutoff = this.clock.now() - idleMs;
    for (const [k, b] of this.buckets) if (b.updatedAt < cutoff) this.buckets.delete(k);
  }

  size(): number {
    return this.buckets.size;
  }
}
