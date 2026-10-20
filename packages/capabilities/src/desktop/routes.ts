/**
 * HTTP routes for the UI (Extensions panel and Settings -> Capabilities -> Desktop): status
 * with what is installed and missing, the per-human allowlist, live revoke and resume. Mounted
 * on any Hono-compatible app through the same minimal structural interface the email routes
 * use, so this package needs no dependency on hono: `createDesktopRoutes(deps, new Hono())`.
 */
import { type Clock, ForerunnerError } from "@forerunner/platform";
import type { AuditPort } from "@forerunner/runtime";
import { z } from "zod";
import type { AdapterDetection } from "./adapters/detect.ts";
import { AllowlistSchema, type DesktopAllowlistStore } from "./allowlist.ts";
import type { DesktopController } from "./controller.ts";

export interface DesktopRouteRequest {
  param(name: string): string | undefined;
  query(name: string): string | undefined;
  json(): Promise<unknown>;
  header?(name: string): string | undefined;
}

export interface DesktopRouteContext {
  req: DesktopRouteRequest;
  json(body: unknown, status?: number): Response;
}

export type DesktopRouteHandler = (c: DesktopRouteContext) => Promise<Response>;

/** The subset of Hono's app surface the routes need. */
export interface DesktopRouteApp {
  get(path: string, handler: DesktopRouteHandler): unknown;
  put(path: string, handler: DesktopRouteHandler): unknown;
  post(path: string, handler: DesktopRouteHandler): unknown;
}

export interface DesktopRoute {
  method: "GET" | "PUT" | "POST";
  path: string;
  handler: DesktopRouteHandler;
}

export interface DesktopRouteDeps {
  controller: DesktopController;
  allowlist: DesktopAllowlistStore;
  clock: Clock;
  /** Adapter detection for the status view (installed tools, what is missing). */
  detect?: () => Promise<AdapterDetection>;
  /** Allowlist changes and revocations are audited when a port is given. */
  audit?: AuditPort;
  /** Human id behind a request (from the daemon's auth); allowlist changes need one when set. */
  humanFor?: (c: DesktopRouteContext) => string | undefined;
}

export function desktopErrorStatus(e: ForerunnerError): number {
  switch (e.code) {
    case "validation":
      return 400;
    case "not_found":
      return 404;
    case "tool_not_allowed":
    case "approval_required":
    case "autonomy_insufficient":
      return 403;
    case "version_conflict":
      return 409;
    default:
      return 500;
  }
}

function fail(c: DesktopRouteContext, e: unknown): Response {
  if (e instanceof ForerunnerError) return c.json({ error: e.toJSON() }, desktopErrorStatus(e));
  if (e instanceof z.ZodError) {
    const err = new ForerunnerError(
      "validation",
      e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
    return c.json({ error: err.toJSON() }, 400);
  }
  const err = new ForerunnerError("internal", e instanceof Error ? e.message : String(e));
  return c.json({ error: err.toJSON() }, 500);
}

const guard =
  (fn: DesktopRouteHandler): DesktopRouteHandler =>
  async (c) => {
    try {
      return await fn(c);
    } catch (e) {
      return fail(c, e);
    }
  };

const AllowlistBody = z.object({ entries: AllowlistSchema }).strict();
const RevokeBody = z.object({ reason: z.string().trim().min(1).max(200).optional() }).strict();

function humanParam(c: DesktopRouteContext): string {
  const humanId = c.req.param("humanId")?.trim();
  if (!humanId) throw new ForerunnerError("validation", "humanId is required");
  return humanId;
}

export function desktopRouteTable(deps: DesktopRouteDeps): DesktopRoute[] {
  /** When the daemon identifies humans, a request must come from one; returns who. */
  const signedIn = (c: DesktopRouteContext, what: string): string | undefined => {
    if (!deps.humanFor) return undefined;
    const who = deps.humanFor(c);
    if (!who) throw new ForerunnerError("approval_required", `only a signed-in human can ${what}`);
    return who;
  };
  /** The allowlist is the per-human permission boundary: a human reaches only their own. */
  const ownAllowlist = (c: DesktopRouteContext, what: string): string => {
    const humanId = humanParam(c);
    const who = signedIn(c, `${what} the desktop allowlist`);
    if (who !== undefined && who !== humanId) {
      throw new ForerunnerError(
        "tool_not_allowed",
        `a human can ${what} only their own desktop allowlist`,
      );
    }
    return humanId;
  };
  const statusBody = async () => {
    const detection = deps.detect ? await deps.detect() : undefined;
    return {
      ...deps.controller.status(),
      ...(detection
        ? {
            detection: {
              platform: detection.platform,
              displayServer: detection.displayServer,
              available: detection.adapter !== null,
              found: detection.found,
              missing: detection.missing,
              notes: detection.notes,
            },
          }
        : {}),
    };
  };
  const audit = async (
    c: DesktopRouteContext,
    tool: string,
    inputSummary: string,
    resultSummary: string,
    humanId?: string,
  ) => {
    if (!deps.audit) return;
    await deps.audit.append({
      sessionId: "",
      runId: "",
      agentId: "",
      humanId: humanId ?? deps.humanFor?.(c) ?? "",
      tool,
      inputSummary,
      resultSummary,
      allowed: true,
      costUsdMicro: 0,
      occurredAt: deps.clock.nowIso(),
      tokenId: "",
    });
  };
  return [
    {
      method: "GET",
      path: "/desktop/status",
      handler: guard(async (c) => c.json(await statusBody())),
    },
    {
      method: "GET",
      path: "/desktop/allowlist/:humanId",
      handler: guard(async (c) => {
        const humanId = ownAllowlist(c, "read");
        return c.json({ humanId, entries: await deps.allowlist.get(humanId) });
      }),
    },
    {
      method: "PUT",
      path: "/desktop/allowlist/:humanId",
      handler: guard(async (c) => {
        const humanId = ownAllowlist(c, "change");
        const body = AllowlistBody.parse(await c.req.json());
        const entries = await deps.allowlist.set(humanId, body.entries);
        await audit(
          c,
          "desktop_allowlist",
          JSON.stringify(body.entries),
          `${entries.length} entries`,
          humanId,
        );
        return c.json({ humanId, entries });
      }),
    },
    {
      method: "POST",
      path: "/desktop/revoke",
      handler: guard(async (c) => {
        const body = RevokeBody.parse((await c.req.json().catch(() => ({}))) ?? {});
        const report = await deps.controller.revoke(body.reason ?? "revoked from the panel");
        await audit(
          c,
          "desktop_revoke",
          report.reason,
          `interrupted ${report.interrupted}, dropped ${report.dropped}`,
        );
        return c.json({ ...report, status: await statusBody() });
      }),
    },
    {
      // Revoke is fail-safe and stays open to any caller; resume widens, so it needs a human.
      method: "POST",
      path: "/desktop/resume",
      handler: guard(async (c) => {
        const who = signedIn(c, "resume desktop control");
        deps.controller.resume();
        await audit(c, "desktop_resume", "", "resumed", who);
        return c.json(await statusBody());
      }),
    },
  ];
}

/** Mount the routes on a Hono-compatible app; returns the app. */
export function mountDesktopRoutes<A extends DesktopRouteApp>(app: A, deps: DesktopRouteDeps): A {
  for (const route of desktopRouteTable(deps)) {
    if (route.method === "GET") app.get(route.path, route.handler);
    else if (route.method === "PUT") app.put(route.path, route.handler);
    else app.post(route.path, route.handler);
  }
  return app;
}

/** `createDesktopRoutes(deps, new Hono())` gives a sub-app the daemon mounts. */
export function createDesktopRoutes<A extends DesktopRouteApp>(deps: DesktopRouteDeps, app: A): A {
  return mountDesktopRoutes(app, deps);
}
