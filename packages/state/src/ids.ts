import { randomBytes } from "node:crypto";

/**
 * Monotonic UUIDv7 ids. Same layout as @forerunner/platform's newId, plus a 12-bit counter
 * in rand_a (RFC 9562 method 1) so ids created in the same millisecond by one process sort
 * in creation order. Lists ordered by (created_at, id) are then insertion-ordered even under
 * a simulated clock that does not move. Across processes only the millisecond is ordered.
 */
let lastMs = -1;
let counter = 0;

export function monotonicId(nowMs: number): string {
  let ms = Math.max(0, Math.floor(nowMs));
  if (ms > lastMs) {
    lastMs = ms;
    counter = Math.floor(Math.random() * 0x800); // random start in the lower half, room to grow
  } else {
    ms = lastMs;
    counter += 1;
    if (counter > 0xfff) {
      lastMs += 1;
      ms = lastMs;
      counter = 0;
    }
  }
  const time = ms.toString(16).padStart(12, "0");
  const seq = counter.toString(16).padStart(3, "0");
  const rand = randomBytes(8).toString("hex"); // 16 hex chars; we use 15 after the variant nibble
  const variantNibble = ((Number.parseInt(rand[0] as string, 16) & 0x3) | 0x8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${seq}-${variantNibble}${rand.slice(1, 4)}-${rand.slice(4, 16)}`;
}
