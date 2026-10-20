import { errorMessage, ForerunnerError, type Logger, log } from "@forerunner/platform";
import { type CapabilityClaims, domainCovered } from "@forerunner/runtime";
import type { APIResponse, BrowserContext, Page, Request, Route } from "playwright";

/**
 * Site policy: which hosts a browser session may touch. Patterns are exactly those of
 * `domainCovered` in the runtime's token module (`example.com` that host only, `*.example.com`
 * the host and every subdomain), hostnames without scheme, port or path, so a token domain, the
 * hooks' `domainFields` check and this policy agree on every URL. The block list wins over the
 * allow list; an empty allow list allows nothing.
 *
 * It is enforced at these points in code, all before any byte leaves the machine:
 * 1. `assert()` before every navigation and download the session starts;
 * 2. a context-wide route over every HTTP(S) request (documents, frames, subresources, XHR,
 *    fetch) that aborts requests to hosts outside the policy and, because Chromium follows
 *    redirects outside request interception, answers each request itself with redirects
 *    disabled so every hop of a redirect chain is checked too (`installPolicyRoutes`);
 * 3. a per-page WebSocket route that refuses sockets to hosts outside the policy
 *    (`installWebSocketPolicy`).
 * Service workers are blocked at launch so nothing bypasses the routes.
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
}

/**
 * A pattern as the token carries it: a lowercase hostname (`example.com`, `127.0.0.1`,
 * `[::1]`) or a wildcard (`*.example.com`). A scheme, a path or a `:port` is a `validation`
 * error rather than a silent narrowing the hooks would not apply: the runtime compares
 * hostnames only, so a port-qualified token domain could never pass `browser_navigate`.
 */
export function normaliseHostPattern(pattern: string): string {
  const p = pattern.trim().toLowerCase();
  if (!p) throw new ForerunnerError("validation", "empty host pattern");
  if (/^\[[0-9a-f:.]+\]$/.test(p)) return p;
  if (/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(p)) return p;
  throw new ForerunnerError(
    "validation",
    `invalid host pattern: ${pattern} (a hostname or *.hostname, no scheme, port or path)`,
    { details: { pattern } },
  );
}

export function urlHost(url: string): { scheme: string; host: string } | null {
  try {
    const u = new URL(url);
    return { scheme: u.protocol, host: u.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

/** True when a pattern covers the host: `domainCovered` of the runtime, nothing more. */
export function hostCovered(host: string, patterns: readonly string[]): boolean {
  return domainCovered(host.toLowerCase(), patterns);
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
    const allow = this.allow.filter((p) => domainCovered(p, other.allow));
    return new SitePolicy({ allow, block: [...this.block, ...other.block] });
  }

  check(url: string): PolicyDecision {
    const parts = urlHost(url);
    if (!parts) return { allowed: false, reason: "invalid", url, host: "" };
    const { scheme, host } = parts;
    if (!NAVIGABLE_SCHEMES.has(scheme) && scheme !== "ws:" && scheme !== "wss:")
      return { allowed: false, reason: "scheme", url, host };
    if (!host) return { allowed: false, reason: "invalid", url, host: "" };
    if (hostCovered(host, this.block)) return { allowed: false, reason: "blocked", url, host };
    if (!hostCovered(host, this.allow)) return { allowed: false, reason: "not_allowed", url, host };
    return { allowed: true, reason: "allowed", url, host };
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
        ? `cannot ${action}: ${d.host} is on the block list`
        : `cannot ${action}: ${d.host} is not in the site allowlist`,
      { details: { url, host: d.host, reason: d.reason, action } },
    );
  }

  toJSON(): { allow: string[]; block: string[] } {
    return { allow: [...this.allow], block: [...this.block] };
  }
}

function normalise(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map(normaliseHostPattern))].sort();
}

// ---------------------------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------------------------

export interface BlockedRequest {
  url: string;
  host: string;
  reason: PolicyReason;
  resourceType: string;
  pageUrl: string;
  /** The request whose redirect pointed at `url`; absent when the request itself was refused. */
  redirectedFrom?: string;
}

export type PolicyResolver = (page: Page | null) => SitePolicy | undefined;

/**
 * A redirect the route answered with a stub in a page's main frame. The route records it
 * before fulfilling, the session follows it and clears it. This record, not anything in the
 * page, is what the session trusts: a page can forge the stub's attribute, never this.
 */
export interface PendingRedirect {
  /** URL of the document request that was redirected (what the stub is served at). */
  from: string;
  /** Absolute redirect target, already checked against the policy. */
  target: string;
  status: number;
}

/** Attribute on the root element of a redirect stub naming the target (informational only). */
export const REDIRECT_STUB_ATTR = "data-forerunner-redirect";

/** Redirect chains longer than this fail instead of looping. */
export const MAX_REDIRECT_HOPS = 10;

/** Resource types that stream for the life of the page; proxying them would never finish. */
export const STREAMED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "eventsource",
  "media",
  "websocket",
]);

/** Headers that must not be copied onto a redirect hop the route follows itself. */
const DROPPED_HOP_HEADERS = new Set(["cookie", "host", "content-length"]);

/** Absolute redirect target of a 3xx response with a Location header, else null. */
export function redirectTarget(
  status: number,
  location: string | undefined,
  from: string,
): string | null {
  if (status < 300 || status > 399 || !location) return null;
  try {
    return new URL(location, from).toString();
  } catch {
    return null;
  }
}

/** 307 and 308 keep the method and body; every other redirect becomes a GET. */
export function redirectKeepsMethod(status: number): boolean {
  return status === 307 || status === 308;
}

/** Request headers for a redirect hop the route follows itself: no cookies (the context's jar decides per host), no host or length, no body type when the body is dropped. */
export function redirectHopHeaders(
  headers: Record<string, string>,
  keepBody: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase();
    if (DROPPED_HOP_HEADERS.has(n)) continue;
    if (!keepBody && n === "content-type") continue;
    if (n.startsWith(":")) continue;
    out[n] = value;
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Served in place of a 3xx document response. The browser follows redirects outside request
 * interception, so the policy would never see the next hop; instead the target is handed back
 * as a fresh, routed navigation: in the main frame the session follows the target the route
 * recorded (`PendingRedirect`, after checking it again); inside a sub-frame the stub follows
 * it itself with `location.replace`, which is a routed request the policy sees. The attribute
 * on the root element only documents the target; nothing reads it back.
 */
export function redirectStub(target: string): string {
  const attr = escapeHtml(target);
  const js = JSON.stringify(target).replace(/</g, "\\u003c");
  return `<!doctype html><html ${REDIRECT_STUB_ATTR}="${attr}"><head><meta charset="utf-8"><title>Redirecting</title></head><body><p>Redirecting to <a href="${attr}">${attr}</a></p><script>if (window.top !== window) location.replace(${js});</script></body></html>`;
}

export interface PolicyRouteOptions {
  /** Per-request fetch timeout in ms (default 120 s). */
  fetchTimeoutMs?: number;
  logger?: Logger;
}

function pageOf(req: Request): Page | null {
  try {
    return req.frame().page();
  } catch {
    return null;
  }
}

function isMainFrameRequest(req: Request, page: Page): boolean {
  try {
    return req.frame() === page.mainFrame();
  } catch {
    return false;
  }
}

function urlOf(page: Page | null): string {
  try {
    return page?.url() ?? "";
  } catch {
    return "";
  }
}

function notAllowed(url: string): PolicyDecision {
  return { allowed: false, reason: "not_allowed", url, host: urlHost(url)?.host ?? "" };
}

/**
 * Context-wide route: every HTTP(S) request from every page goes through the policy of the
 * session that owns the page; a page nobody owns, or a request that no policy covers, is
 * aborted before it is sent. Allowed requests are answered by the route itself with redirects
 * disabled (`route.fetch({ maxRedirects: 0 })`): a redirect to a host outside the policy is
 * aborted; an allowed one becomes a redirect stub for documents and is followed hop by hop,
 * each hop checked, for subresources. Streams (event sources, media) go to the network
 * directly once their host passed. Installed once per agent browser; policies are looked up
 * per page so runs can differ.
 */
export async function installPolicyRoutes(
  context: BrowserContext,
  resolve: PolicyResolver,
  onBlocked?: (info: BlockedRequest, page: Page | null) => void,
  opts: PolicyRouteOptions = {},
  onRedirectStub?: (info: PendingRedirect, page: Page) => void,
): Promise<() => Promise<void>> {
  const logger = opts.logger ?? log("browser:policy");
  const timeout = opts.fetchTimeoutMs ?? 120_000;
  const noop = () => undefined;

  const handler = async (route: Route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();
    const page = pageOf(req);
    const policy = resolve(page);
    const block = async (info: BlockedRequest) => {
      logger.debug("blocked request", { ...info });
      onBlocked?.(info, page);
      await route.abort("blockedbyclient").catch(noop);
    };
    const decision = policy ? policy.check(url) : notAllowed(url);
    if (!policy || !decision.allowed) {
      await block({
        url,
        host: decision.host,
        reason: decision.reason,
        resourceType: type,
        pageUrl: urlOf(page),
      });
      return;
    }
    if (STREAMED_RESOURCE_TYPES.has(type)) {
      await route.continue().catch(noop);
      return;
    }

    let resp: APIResponse;
    try {
      resp = await route.fetch({ maxRedirects: 0, timeout });
    } catch (e) {
      logger.debug("fetch failed", { url, error: errorMessage(e).split("\n")[0] });
      await route.abort("failed").catch(noop);
      return;
    }
    let current = url;
    let method = req.method();
    for (let hop = 1; ; hop++) {
      const status = resp.status();
      const target = redirectTarget(status, resp.headers().location, current);
      if (!target) {
        await route.fulfill({ response: resp }).catch(noop);
        return;
      }
      await resp.dispose().catch(noop);
      const next = policy.check(target);
      if (!next.allowed) {
        await block({
          url: target,
          host: next.host,
          reason: next.reason,
          resourceType: type,
          pageUrl: urlOf(page),
          redirectedFrom: current,
        });
        return;
      }
      if (type === "document") {
        if (page && isMainFrameRequest(req, page)) {
          onRedirectStub?.({ from: current, target, status }, page);
        }
        await route
          .fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            headers: { "cache-control": "no-store" },
            body: redirectStub(target),
          })
          .catch(noop);
        return;
      }
      if (hop >= MAX_REDIRECT_HOPS) {
        logger.debug("too many redirects", { url, last: target });
        await route.abort("failed").catch(noop);
        return;
      }
      const keep = redirectKeepsMethod(status);
      if (!keep) method = "GET";
      try {
        resp = await context.request.fetch(target, {
          method,
          headers: redirectHopHeaders(req.headers(), keep),
          data: keep ? (req.postDataBuffer() ?? undefined) : undefined,
          maxRedirects: 0,
          timeout,
        });
      } catch (e) {
        logger.debug("redirect hop failed", { url: target, error: errorMessage(e).split("\n")[0] });
        await route.abort("failed").catch(noop);
        return;
      }
      current = target;
    }
  };
  await context.route("**/*", handler);
  return () => context.unroute("**/*", handler);
}

/**
 * Per-page WebSocket route: a socket to a host outside the policy is closed with 1008 (policy
 * violation) before any handshake; an allowed one is connected and forwarded unchanged.
 */
export async function installWebSocketPolicy(
  page: Page,
  resolve: () => SitePolicy | undefined,
  onBlocked?: (info: BlockedRequest) => void,
  logger: Logger = log("browser:policy"),
): Promise<void> {
  await page.routeWebSocket("**/*", (ws) => {
    const url = ws.url();
    const policy = resolve();
    const decision = policy ? policy.check(url) : notAllowed(url);
    if (!decision.allowed) {
      const info: BlockedRequest = {
        url,
        host: decision.host,
        reason: decision.reason,
        resourceType: "websocket",
        pageUrl: urlOf(page),
      };
      logger.debug("blocked websocket", { ...info });
      onBlocked?.(info);
      ws.close({ code: 1008, reason: "blocked by site policy" });
      return;
    }
    ws.connectToServer();
  });
}
