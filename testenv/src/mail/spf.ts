/**
 * SPF stand-in. Production never evaluates SPF itself: the receiving provider (Gmail, the
 * domain's mail host) writes its verdict into the Authentication-Results header and the
 * email-command watcher reads that. This module lets tests craft every verdict from a small
 * in-memory policy instead of DNS: `{ "example.test": { allowedIps: ["192.0.2.25"], all: "fail" } }`.
 */

export type SpfResult = "pass" | "fail" | "softfail" | "neutral" | "none";

export interface SpfDomainPolicy {
  /** Exact IPv4/IPv6 addresses or IPv4 CIDR ranges allowed to send for the domain. */
  allowedIps: string[];
  /** The verdict for every other address, like the "-all" / "~all" / "?all" mechanism. */
  all: "fail" | "softfail" | "neutral";
}

export type SpfPolicy = Record<string, SpfDomainPolicy>;

export interface SpfCheck {
  ip: string;
  /** Domain of the envelope MAIL FROM (or of the From header when the envelope is empty). */
  mailFromDomain: string;
  policy: SpfPolicy | undefined;
}

/** Evaluate `ip` against the policy for `mailFromDomain`. "none" when the domain has no policy. */
export function checkSpf({ ip, mailFromDomain, policy }: SpfCheck): SpfResult {
  const domain = mailFromDomain.trim().toLowerCase();
  if (!domain || !policy) return "none";
  const entry = policy[domain] ?? findCaseInsensitive(policy, domain);
  if (!entry) return "none";
  if (entry.allowedIps.some((spec) => ipMatches(ip, spec))) return "pass";
  return entry.all;
}

function findCaseInsensitive(policy: SpfPolicy, domain: string): SpfDomainPolicy | undefined {
  for (const [key, value] of Object.entries(policy)) {
    if (key.toLowerCase() === domain) return value;
  }
  return undefined;
}

/** Strip the IPv4-mapped IPv6 prefix so "::ffff:127.0.0.1" compares as "127.0.0.1". */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  const mapped = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped?.[1] ?? trimmed;
}

/** True when `ip` equals `spec` or falls inside the IPv4 CIDR range `spec`. */
export function ipMatches(ip: string, spec: string): boolean {
  const a = normalizeIp(ip);
  const s = normalizeIp(spec);
  if (a === s) return true;
  const cidr = s.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
  if (!cidr) return false;
  const network = ipv4ToInt(cidr[1] ?? "");
  const address = ipv4ToInt(a);
  const bits = Number(cidr[2]);
  if (network === null || address === null || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (network & mask) >>> 0 === (address & mask) >>> 0;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = ((out << 8) | n) >>> 0;
  }
  return out;
}
