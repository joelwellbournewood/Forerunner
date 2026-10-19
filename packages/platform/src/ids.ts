import { randomBytes, randomUUID } from "node:crypto";

/** UUIDv7-style time-ordered ids: sortable by creation, globally unique, URL safe. */
export function newId(now: number = Date.now()): string {
  const ts = BigInt(now);
  const b = randomBytes(10);
  const hex = (n: bigint, len: number) => n.toString(16).padStart(len, "0");
  const timeHex = hex(ts, 12);
  const rand = b.toString("hex");
  // Set version 7 and RFC variant bits.
  const ver = `7${rand.slice(0, 3)}`;
  const variantNibble = ((Number.parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  const tail = `${variantNibble}${rand.slice(4, 7)}`;
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-${ver}-${tail}-${rand.slice(7, 19)}`;
}

export function randomUuid(): string {
  return randomUUID();
}

/** Short human-friendly token, e.g. for email command markers: FR-7k2q */
export function shortToken(len = 4, prefix = "FR-"): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  return `${prefix}${out}`;
}
