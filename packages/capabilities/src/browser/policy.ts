import { ForerunnerError, log } from "@forerunner/platform";
import { type CapabilityClaims, domainCovered } from "@forerunner/runtime";
import type { BrowserContext, Page, Route } from "playwright";

/**
 * Site policy: which hosts a browser session may touch. Patterns follow `domainCovered` in
 * the runtime's token module (`example.com` exact, `*.example.com` the host and every
 * subdomain) with an optional `:port` suffix that narrows a pattern to one port. The block
 * list wins over the allow list; an empty allow list allows nothing.
 *
 * It is enforced at two points in code: `assert()` before every navigation and download, and
 * a context-wide route that aborts every request (subresources, redirects, frames, XHR) whose
 * host is not covered. Service workers are blocked at launch so nothing bypasses the route.
 */
export interface SitePolicyPatterns {
  allow: readonly string[];
  block?: readonly string[];
}

export type PolicyReason = "allowed" | "blocked" | "not_allowed" | "scheme" | "invalid";

export interface PolicyDecision {
  allowed: boolean;
  reason: PolicyReason;
  url: string;
  host: string;
  port?: string;
}

export interface HostPattern {
  host: string;
  port?: string;
}

/** `*.example.com:8443` -> { host: "*.example.com", port: "8443" }; IPv6 in brackets. */
export function splitHostPattern(pattern: string): HostPattern {
  const p = pattern.trim().toLowerCase();
  if (!p) throw new ForerunnerError("validation", "empty host pattern");
  const v6 = /^(\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/.exec(p);
  if (v6) return v6[2] ? { host: v6[1] ?? p, port: v6[2] } : { host: v6[1] ?? p };
  const m = /^([^:/?#]+)(?::(\d{1,5}))?$/.exec(p);
  if (!m?.[1]) throw new ForerunnerError("validation", `invalid host pattern: ${pattern}`);
  return m[2] ? { host: m[1], port: m[2] } : { host: m[1] };
}

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443",
};

export function urlHost(url: string): { scheme: string; host: string; port: string } | null {
  try {
    const u = new URL(url);
    const port = u.port || DEFAULT_PORTS[u.protocol] || "";
    return { scheme: u.protocol, host: u.hostname.toLowerCase(), port };
  } catch {
    return null;
  }
}

/** True when a pattern covers host (and port, when the pattern names one). */
export function hostCovered(
  host: string,
  port: string | undefined,
  patterns: readonly string[],
): boolean {
  const h = host.toLowerCase();
  for (const raw of patterns) {
    let p: HostPattern;
    try {
      p = splitHostPattern(raw);
    } catch {
      continue;
    }
    if (p.port !== undefined && p.port !== port) continue;
    if (domainCovered(h, [p.host])) return true;
  }
  return false;
}

export const NAVIGABLE_SCHEMES = new Set(["http:", "https:"]);

export class SitePolicy {
  readonly allow: readonly string[];
  readonly block: readonly string[];

  constructor(patterns: SitePolicyPatterns) {
    this.allow = normalise(patterns.allow);
    this.block = normalise(patterns.block ?? []);
  }

  /** The run's token domains as the allow list; a per-agent or per-project block list on top. */
  static fromClaims(
    claims: Pick<CapabilityClaims, "allowedDomains">,
    block: readonly string[] = [],
  ): SitePolicy {
    return new SitePolicy({ allow: claims.allowedDomains, block });
  }

  /** Never widens: the result allows only what both allow and blocks what either blocks. */
  narrowedBy(other: SitePolicy): SitePolicy {
    const allow = this.allow.filter((p) => {
      const h = splitHostPattern(p);
      return (
        hostCovered(h.host, h.port, other.allow) ||
        (h.port === undefined &&
          other.allow.some((o) => {
            const oh = splitHostPattern(o);
            return oh.port !== undefined && domainCovered(oh.host, [h.host]);
          }))
      );
    });
    return new SitePolicy({ allow, block: [...this.block, ...other.block] });
  }

  check(url: string): PolicyDecision {
    const parts = urlHost(url);
    if (!parts) return { allowed: false, reason: "invalid", url, host: "" };
    const { scheme, host, port } = parts;
    if (!NAVIGABLE_SCHEMES.has(scheme) && scheme !== "ws:" && scheme !== "wss:")
      return { allowed: false, reason: "scheme", url, host, port };
    if (!host) return { allowed: false, reason: "invalid", url, host: "", port };
    if (hostCovered(host, port, this.block))
      return { allowed: false, reason: "blocked", url, host, port };
    if (!hostCovered(host, port, this.allow))
      return { allowed: false, reason: "not_allowed", url, host, port };
    return { allowed: true, reason: "allowed", url, host, port };
  }

  isAllowed(url: string): boolean {
    return this.check(url).allowed;
  }

  /** Throws `domain_not_allowed` (or `validation` for a bad URL or scheme) before the action. */
  assert(url: string, action = "navigate"): PolicyDecision {
    const d = this.check(url);
    if (d.allowed) return d;
    if (d.reason === "invalid") {
      throw new ForerunnerError(
        "validation",
        `cannot ${action}: invalid URL ${JSON.stringify(url)}`,
      );
    }
    if (d.reason === "scheme") {
      throw new ForerunnerError(
        "validation",
        `cannot ${action}: only http and https URLs are allowed`,
        {
          details: { url },
        },
      );
    }
    throw new ForerunnerError(
      "domain_not_allowed",
      d.reason === "blocked"
        ? `cannot ${action}: ${d.host}${d.port ? `:${d.port}` : ""} is on the block list`
        : `cannot ${action}: ${d.host}${d.port ? `:${d.port}` : ""} is not in the site allowlist`,
      { details: { url, host: d.host, port: d.port, reason: d.reason, action } },
    );
  }

  toJSON(): { allow: string[]; block: string[] } {
    return { allow: [...this.allow], block: [...this.block] };
  }
}

function normalise(patterns: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    const { host, port } = splitHostPattern(p);
    out.add(port ? `${host}:${port}` : host);
  }
  return [...out].sort();
}

export interface BlockedRequest {
  url: string;
  host: string;
  reason: PolicyReason;
  resourceType: string;
  pageUrl: string;
}

export type PolicyResolver = (page: Page | null) => SitePolicy | undefined;

/**
 * Context-wide route: every request from every page goes through the policy of the session
 * that owns the page; a page nobody owns, or a request that no policy covers, is aborted.
 * Installed once per agent browser; policies are looked up per page so runs can differ.
 */
export async function installPolicyRoutes(
  context: BrowserContext,
  resolve: PolicyResolver,
  onBlocked?: (info: BlockedRequest, page: Page | null) => void,
): Promise<() => Promise<void>> {
  const logger = log("browser:policy");
  const handler = async (route: Route) => {
    const req = route.request();
    const url = req.url();
    let page: Page | null = null;
    try {
      page = req.frame().page();
    } catch {
      page = null;
    }
    const policy = resolve(page);
    const decision = policy
      ? policy.check(url)
      : ({
          allowed: false,
          reason: "not_allowed",
          url,
          host: urlHost(url)?.host ?? "",
        } satisfies PolicyDecision);
    if (decision.allowed) {
      await route.continue().catch(() => undefined);
      return;
    }
    let pageUrl = "";
    try {
      pageUrl = page?.url() ?? "";
    } catch {
      pageUrl = "";
    }
    const info: BlockedRequest = {
      url,
      host: decision.host,
      reason: policy ? decision.reason : "not_allowed",
      resourceType: req.resourceType(),
      pageUrl,
    };
    logger.debug("blocked request", { ...info });
    onBlocked?.(info, page);
    await route.abort("blockedbyclient").catch(() => undefined);
  };
  await context.route("**/*", handler);
  return () => context.unroute("**/*", handler);
}
