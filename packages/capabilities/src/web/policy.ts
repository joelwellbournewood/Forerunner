import { BlockList, isIP } from "node:net";
import { domainCovered } from "@forerunner/runtime";

/**
 * Where a research run may read (ADR 0107, the owner's decision of 2026-11-01: the researcher
 * and the science-evaluator get web access on an API key through Forerunner's own capability,
 * within the network rules). The rules, all checked in code before a byte leaves the machine:
 *
 * - only `http:` and `https:` addresses, at most `WEB_MAX_URL_CHARS` long, without a user name
 *   or password in them (a page is read without credentials);
 * - a host on the project's block list (`settings.browser.blockedDomains`) is refused, whatever
 *   else says;
 * - a host on the project's site list (`settings.browser.allowedDomains`, the same list the
 *   browser capability reads) is allowed wherever it points, the private network included: the
 *   person named it;
 * - any other host is allowed only while every address it resolves to is public: never this
 *   computer, the local network, a link-local or cloud metadata address, a carrier-grade NAT,
 *   multicast or reserved range. The check runs on the addresses the connection actually uses
 *   (`fetch.ts` resolves through this policy at connect time), so a name that resolves to a
 *   private address, or changes its answer between two lookups, is refused too.
 *
 * Host patterns are those of a capability token (`example.com` that host, `*.example.com` the
 * host and its subdomains), compared with the runtime's `domainCovered`.
 */
export const WEB_MAX_URL_CHARS = 2_000;

export interface WebReadSites {
  /** Hosts the person named for this project: allowed even on a private address. */
  allowed: readonly string[];
  /** Hosts no research run of this project may read. Wins over everything. */
  blocked: readonly string[];
}

export type WebRefusalReason = "invalid" | "scheme" | "credentials" | "too_long" | "blocked";

export type UrlDecision =
  | { ok: true; url: URL; host: string; named: boolean }
  | { ok: false; reason: WebRefusalReason; host: string; message: string };

/**
 * Address ranges a research run never reaches unless the person named the host: this computer,
 * private and shared networks, link-local (cloud metadata at 169.254.169.254), multicast,
 * documentation, benchmarking and reserved ranges, for IPv4 and IPv6. IPv4 addresses mapped
 * into IPv6 (`::ffff:10.0.0.1`) and the NAT64 prefix are checked as the IPv4 address they carry.
 */
const NOT_PUBLIC = (() => {
  const b = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    b.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ] as const)
    b.addSubnet(net, prefix, "ipv6");
  return b;
})();

/** The IPv4 address an IPv6 address carries (mapped `::ffff:a.b.c.d` or NAT64 `64:ff9b::/96`), if any. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted?.[1]) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when `address` (an IPv4 or IPv6 literal, no brackets) is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const family = isIP(bare);
  if (family === 4) return !NOT_PUBLIC.check(bare, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(bare);
    if (v4) return isPublicAddress(v4);
    return !NOT_PUBLIC.check(bare, "ipv6");
  }
  return false;
}

function normalisePatterns(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map((p) => p.trim().toLowerCase()).filter(Boolean))];
}

/** A URL's host without IPv6 brackets, lowercase. */
export function hostOfUrl(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export class WebReadPolicy {
  readonly allowed: readonly string[];
  readonly blocked: readonly string[];

  constructor(sites: WebReadSites) {
    this.allowed = normalisePatterns(sites.allowed);
    this.blocked = normalisePatterns(sites.blocked);
  }

  /** Whether the person named this host on the project's site list. */
  named(host: string): boolean {
    return domainCovered(host.toLowerCase(), this.allowed);
  }

  /**
   * The checks that need no lookup: the address's form and the block list. An IP literal is
   * judged here by `addressAllowed` too, because a connection to it resolves nothing.
   */
  checkUrl(raw: string): UrlDecision {
    if (raw.length > WEB_MAX_URL_CHARS)
      return {
        ok: false,
        reason: "too_long",
        host: "",
        message: `the address is longer than ${WEB_MAX_URL_CHARS.toLocaleString("en")} characters`,
      };
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return {
        ok: false,
        reason: "invalid",
        host: "",
        message: `${JSON.stringify(raw.slice(0, 120))} is not a web address`,
      };
    }
    const host = hostOfUrl(url);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return {
        ok: false,
        reason: "scheme",
        host,
        message: `only http and https pages can be read, not ${url.protocol.replace(/:$/, "")}`,
      };
    if (url.username || url.password)
      return {
        ok: false,
        reason: "credentials",
        host,
        message: "the address carries a user name or password; pages are read without credentials",
      };
    if (!host)
      return { ok: false, reason: "invalid", host, message: `${raw.slice(0, 120)} names no host` };
    if (domainCovered(host, this.blocked))
      return {
        ok: false,
        reason: "blocked",
        host,
        message: `${host} is on this project's block list`,
      };
    return { ok: true, url, host, named: this.named(host) };
  }

  /** Whether a connection to `host` may use `address`: a named host anywhere, any other only on a public address. */
  addressAllowed(host: string, address: string, isPublic = isPublicAddress): boolean {
    return this.named(host) || isPublic(address);
  }
}

/** The words for a host that resolves to an address a research run may not reach. */
export function privateAddressWords(host: string, address: string): string {
  return host === address
    ? `${host} is a private or local network address; research reads public web pages only (a host on the project's site list is the exception)`
    : `${host} resolves to ${address}, a private or local network address; research reads public web pages only (a host on the project's site list is the exception)`;
}
