import type { Clock } from "@forerunner/platform";

/**
 * Replay guard for signed mutations (ADR 0009, amendment). A signature covers the method,
 * path, body hash, timestamp and biometric flag, so a captured request replayed inside the
 * five-minute window would carry the same signature. The guard remembers every accepted
 * mutation signature until its timestamp window has passed and refuses a second use. Signed
 * reads are not recorded: they change nothing and clients may poll with one signature.
 *
 * Bounded: at most `maxEntries` signatures (expired ones are dropped first, then the oldest).
 * Per process, like the SSE buffer; a second instance behind a load balancer needs sticky
 * sessions for this to be airtight, which 1.0 requires anyway.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly windowMs: number,
    private readonly maxEntries = 100_000,
  ) {}

  /** True when `signature` is new (and now remembered); false when it was used before. */
  accept(signature: string): boolean {
    const now = this.clock.now();
    const expiresAt = this.seen.get(signature);
    if (expiresAt !== undefined && expiresAt > now) return false;
    if (this.seen.size >= this.maxEntries) {
      this.sweep();
      while (this.seen.size >= this.maxEntries) {
        const oldest = this.seen.keys().next();
        if (oldest.done) break;
        this.seen.delete(oldest.value);
      }
    }
    this.seen.delete(signature);
    this.seen.set(signature, now + this.windowMs);
    return true;
  }

  /** Drop signatures whose window has passed (called from the poller tick). */
  sweep(): void {
    const now = this.clock.now();
    for (const [sig, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(sig);
  }

  size(): number {
    return this.seen.size;
  }
}
