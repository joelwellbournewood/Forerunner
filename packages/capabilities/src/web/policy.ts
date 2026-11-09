import { BlockList, isIP } from "node:net";

/**
 * Where a research run may read (ADR 0107, amended by the owner's decision of 2026-11-02,
 * 'sites'). The rules, all checked in code before a byte leaves the machine:
 *
 * - only `http:` and `https:` addresses, at most `WEB_MAX_URL_CHARS` long, without a user name
 *   or password in them (a page is read without credentials);
 * - never this computer or the home or office network, whatever any list says: a name without a
 *   dot or a local name (`localhost`, `*.local`, `*.internal`, ...), and every address that is
 *   not public (this computer, private and shared networks, link-local and cloud metadata,
 *   carrier-grade NAT, multicast, reserved; IPv4 inside IPv6, NAT64 and 6to4 judged as the IPv4
 *   address they carry). The address check runs on the addresses the connection actually uses
 *   (`fetch.ts` resolves through this policy at connect time), so a name that resolves to a
 *   private address, or changes its answer between two lookups, is refused too;
 * - the project's rule, "Web pages research may read" (`project.settings.web_access`, read by
 *   `@forerunner/runtime`'s `webAccessOf`): any public website (the default) except the "never"
 *   list, or "only" the websites on its list, still minus the "never" list. Each entry covers the
 *   site and all its subdomains, in this reader's own matcher (`siteCovers`); the capability
 *   token's `domainCovered`, which the hooks, the agent browser and the token use, is unchanged.
 *
 * `loopback` is a development seam no person can reach: only the composition of the scripted
 * development modes (`fr daemon --provider bench` and `bench-api`) and tests set it, so their
 * stand-in pages on 127.0.0.1 can be read. It opens this computer's loopback only, never the
 * local network, and no list, setting or environment variable sets it.
 */
export const WEB_MAX_URL_CHARS = 2_000;

/** The project's rule as the reader applies it (`webAccessOf` in the runtime). */
export interface WebReadRules {
  mode: "any" | "only";
  /** Mode `only`: the sites research may read, each with its subdomains. */
  only: readonly string[];
  /** Sites research never reads, in either mode, each with its subdomains. */
  never: readonly string[];
}

export const ANY_PUBLIC_WEBSITE: WebReadRules = Object.freeze({
  mode: "any",
  only: [],
  never: [],
}) as WebReadRules;

export interface WebReadPolicyOptions {
  /** The development seam: this computer's loopback may be read (bench and tests only). */
  loopback?: boolean;
}

export type WebRefusalReason =
  | "invalid"
  | "scheme"
  | "credentials"
  | "too_long"
  | "local"
  | "never"
  | "not_only";

export type UrlDecision =
  | { ok: true; url: URL; host: string }
  | { ok: false; reason: WebRefusalReason; host: string; message: string };

/**
 * Address ranges a research run never reaches: this computer, private and shared networks,
 * link-local (cloud metadata at 169.254.169.254), multicast, documentation, benchmarking and
 * reserved ranges, for IPv4 and IPv6. IPv4 addresses mapped into IPv6 (`::ffff:10.0.0.1`), the
 * NAT64 prefix and 6to4 (`2002:0a00:0001::`) are checked as the IPv4 address they carry.
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

/** The eight 16-bit groups of an IPv6 literal without an IPv4 tail, or null. */
function ipv6Groups(address: string): number[] | null {
  const lower = address.toLowerCase();
  if (lower.includes(".")) return null;
  const halves = lower.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string | undefined) =>
    s
      ? s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN))
      : [];
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

/**
 * The IPv4 address an IPv6 address carries (mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4
 * `2002::/16`), if any.
 */
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
  // 6to4: 2002:AABB:CCDD::/48 carries AA.BB.CC.DD ('sites': "the 6to4 range checked").
  const groups = ipv6Groups(lower);
  if (groups && groups[0] === 0x2002) {
    const hi = groups[1] ?? 0;
    const lo = groups[2] ?? 0;
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

/** True when `address` is this computer's loopback (127.0.0.0/8, ::1, or IPv4 loopback inside IPv6). */
export function isLoopbackAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const family = isIP(bare);
  if (family === 4) return bare.startsWith("127.");
  if (family === 6) {
    const v4 = embeddedIpv4(bare);
    if (v4) return isLoopbackAddress(v4);
    const g = ipv6Groups(bare);
    return !!g && g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
  }
  return false;
}

/** A URL's host without IPv6 brackets or one trailing dot, lowercase (C-70: `example.com.` is `example.com`). */
export function hostOfUrl(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
}

/** A list entry as the matcher reads it: lowercase, without `*.`, a trailing dot or a leading `www.`. */
function normaliseSite(entry: string): string {
  return entry
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

/** Whether `site` covers `host`: the site itself or one of its subdomains (the reader's own matcher). */
export function siteCovers(site: string, host: string): boolean {
  const s = normaliseSite(site);
  const h = host.toLowerCase().replace(/\.$/, "");
  return !!s && (h === s || h.endsWith(`.${s}`));
}

/** Local names: this computer and the home or office network, never a website. */
const LOCAL_NAME =
  /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa|localdomain)$/;

/** Whether `host` (not an IP literal) is a name on this computer or the local network. */
export function isLocalName(host: string): boolean {
  return !host.includes(".") || LOCAL_NAME.test(host);
}

function names(sites: readonly string[]): string {
  return sites.length <= 5
    ? sites.join(", ")
    : `${sites.slice(0, 5).join(", ")} and ${sites.length - 5} more`;
}

export class WebReadPolicy {
  readonly mode: "any" | "only";
  readonly only: readonly string[];
  readonly never: readonly string[];
  readonly loopback: boolean;

  constructor(rules: WebReadRules = ANY_PUBLIC_WEBSITE, opts: WebReadPolicyOptions = {}) {
    const clean = (l: readonly string[]) => [...new Set(l.map(normaliseSite).filter(Boolean))];
    this.only = clean(rules.only);
    // R-failopen: "only" with nothing usable on its list reads no website, never any public one.
    this.mode = rules.mode === "only" ? "only" : "any";
    this.never = clean(rules.never);
    this.loopback = opts.loopback === true;
  }

  /**
   * The checks that need no lookup: the address's form, local names and the project's rule. An
   * IP literal is judged by `addressAllowed` too, because a connection to it resolves nothing.
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
    if (!isIP(host) && isLocalName(host) && !(this.loopback && host === "localhost"))
      return {
        ok: false,
        reason: "local",
        host,
        message: `${host} is a name on this computer or the local network; research reads public web pages only`,
      };
    if (this.never.some((s) => siteCovers(s, host)))
      return {
        ok: false,
        reason: "never",
        host,
        message: `${host} is on this project's "never these websites" list`,
      };
    if (this.mode === "only" && !this.only.some((s) => siteCovers(s, host)))
      return {
        ok: false,
        reason: "not_only",
        host,
        message: this.only.length
          ? `${host} is not on this project's "only these websites" list (${names(this.only)})`
          : `${host} was not read: this project's "only these websites" list is empty`,
      };
    return { ok: true, url, host };
  }

  /** Whether a connection may use `address`: a public one, or the loopback under the seam. */
  addressAllowed(_host: string, address: string, isPublic = isPublicAddress): boolean {
    return isPublic(address) || (this.loopback && isLoopbackAddress(address));
  }
}

/** The words for a host that resolves to an address a research run may not reach. */
export function privateAddressWords(host: string, address: string): string {
  return host === address
    ? `${host} is a private or local network address; research reads public web pages only`
    : `${host} resolves to ${address}, a private or local network address; research reads public web pages only`;
}
