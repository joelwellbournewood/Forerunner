import type { Clock } from "@forerunner/platform";

/**
 * The key a signature is remembered under: its bytes (hex), not the header text. Node decodes
 * base64 leniently (padding optional, base64url alphabet accepted, whitespace ignored), so a
 * captured mutation re-sent with the same bytes under another spelling must hit the same
 * entry. Text that decodes to nothing is kept as is.
 */
export function replayKey(signature: string): string {
  const hex = Buffer.from(signature, "base64").toString("hex");
  return hex ? `b:${hex}` : `s:${signature}`;
}

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
    const key = replayKey(signature);
    const now = this.clock.now();
    const expiresAt = this.seen.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    if (this.seen.size >= this.maxEntries) {
      this.sweep();
      while (this.seen.size >= this.maxEntries) {
        const oldest = this.seen.keys().next();
        if (oldest.done) break;
        this.seen.delete(oldest.value);
      }
    }
    this.seen.delete(key);
    this.seen.set(key, now + this.windowMs);
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
