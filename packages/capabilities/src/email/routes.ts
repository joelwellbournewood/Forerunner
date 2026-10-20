/**
 * HTTP routes for the UI (Settings -> Capabilities -> Email): settings per agent, the sent log,
 * pause/resume, marker rotation and the command audit. The routes are described as a table and
 * mounted on any Hono-compatible app through a minimal structural interface, so this package
 * needs no dependency on hono; the orchestrator does `createEmailRoutes(deps, new Hono())` and
 * mounts the result. Every mutation is recorded as an audit row.
 */
import { type Clock, ForerunnerError } from "@forerunner/platform";
import type { AuditLogRepo, JsonObject } from "@forerunner/state";
import { EMAIL_SETTINGS_TOOL, type SentLog } from "./sent-log.ts";
import type { AgentEmailConfigPatch, EmailSettingsStore } from "./types.ts";

export interface EmailRouteRequest {
  param(name: string): string | undefined;
  query(name: string): string | undefined;
  json(): Promise<unknown>;
  header?(name: string): string | undefined;
}

export interface EmailRouteContext {
  req: EmailRouteRequest;
  json(body: unknown, status?: number): Response;
}

export type EmailRouteHandler = (c: EmailRouteContext) => Promise<Response>;

/** The subset of Hono's app surface the routes need. */
export interface EmailRouteApp {
  get(path: string, handler: EmailRouteHandler): unknown;
  put(path: string, handler: EmailRouteHandler): unknown;
  post(path: string, handler: EmailRouteHandler): unknown;
}

export interface EmailRoute {
  method: "GET" | "PUT" | "POST";
  path: string;
  handler: EmailRouteHandler;
}

export interface EmailRouteDeps {
  settings: EmailSettingsStore;
  sentLog: SentLog;
  clock: Clock;
  /** Command audit rows for an agent (EmailCommandHandler.commandAudit). */
  commandAudit?: (agentId: string, opts: { limit?: number }) => Promise<unknown[]>;
  /** Settings changes are audited when a repo is given. */
  audit?: AuditLogRepo;
  /** Human id behind a request (from the daemon's auth), recorded as the author. */
  humanFor?: (c: EmailRouteContext) => string | undefined;
}

export function errorStatus(e: ForerunnerError): number {
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

function fail(c: EmailRouteContext, e: unknown): Response {
  if (e instanceof ForerunnerError) return c.json({ error: e.toJSON() }, errorStatus(e));
  return c.json(
    { error: { code: "internal", message: e instanceof Error ? e.message : String(e) } },
    500,
  );
}

function intQuery(c: EmailRouteContext, name: string, fallback: number, max: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

export function emailRouteTable(deps: EmailRouteDeps): EmailRoute[] {
  const agentOf = (c: EmailRouteContext): string => {
    const id = c.req.param("agentId");
    if (!id) throw new ForerunnerError("validation", "agentId missing");
    return id;
  };
  const recordChange = async (
    c: EmailRouteContext,
    agentId: string,
    action: string,
    detail: JsonObject,
  ) => {
    if (!deps.audit) return;
    await deps.audit.append({
      tool: EMAIL_SETTINGS_TOOL,
      allowed: true,
      agent_id: agentId,
      human_id: deps.humanFor?.(c) ?? null,
      input_summary: JSON.stringify({ action, ...detail }),
      result_summary: "ok",
      cost_usd_micro: 0,
      occurred_at: deps.clock.nowIso(),
      author_human: deps.humanFor?.(c) ?? null,
    });
  };
  const wrap =
    (fn: (c: EmailRouteContext) => Promise<Response>): EmailRouteHandler =>
    async (c) => {
      try {
        return await fn(c);
      } catch (e) {
        return fail(c, e);
      }
    };

  return [
    {
      method: "GET",
      path: "/agents/:agentId/email/settings",
      handler: wrap(async (c) => c.json(await deps.settings.get(agentOf(c)))),
    },
    {
      method: "PUT",
      path: "/agents/:agentId/email/settings",
      handler: wrap(async (c) => {
        const agentId = agentOf(c);
        const body = (await c.req.json()) as AgentEmailConfigPatch | null;
        if (!body || typeof body !== "object")
          throw new ForerunnerError("validation", "body must be an object");
        const patch: AgentEmailConfigPatch = {};
        if (body.settings && typeof body.settings === "object") patch.settings = body.settings;
        if (body.commands && typeof body.commands === "object") patch.commands = body.commands;
        const before = await deps.settings.get(agentId);
        const next = await deps.settings.update(agentId, patch, {
          authorHuman: deps.humanFor?.(c) ?? null,
        });
        await recordChange(c, agentId, "update", {
          settings: Object.keys(patch.settings ?? {}),
          commands: Object.keys(patch.commands ?? {}),
          modeBefore: before.settings.mode,
          modeAfter: next.settings.mode,
        });
        return c.json(next);
      }),
    },
    {
      method: "GET",
      path: "/agents/:agentId/email/sent",
      handler: wrap(async (c) => {
        const agentId = agentOf(c);
        const limit = intQuery(c, "limit", 50, 500);
        const since =
          c.req.query("since") ??
          new Date(deps.clock.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const rows = await deps.sentLog.recent(agentId, since);
        rows.reverse();
        return c.json({ rows: rows.slice(0, limit), since });
      }),
    },
    {
      method: "POST",
      path: "/agents/:agentId/email/pause",
      handler: wrap(async (c) => {
        const agentId = agentOf(c);
        const next = await deps.settings.setPaused(agentId, true, {
          authorHuman: deps.humanFor?.(c) ?? null,
        });
        await recordChange(c, agentId, "pause", {});
        return c.json({ paused: next.settings.paused });
      }),
    },
    {
      method: "POST",
      path: "/agents/:agentId/email/resume",
      handler: wrap(async (c) => {
        const agentId = agentOf(c);
        const next = await deps.settings.setPaused(agentId, false, {
          authorHuman: deps.humanFor?.(c) ?? null,
        });
        await recordChange(c, agentId, "resume", {});
        return c.json({ paused: next.settings.paused });
      }),
    },
    {
      method: "POST",
      path: "/agents/:agentId/email/rotate-marker",
      handler: wrap(async (c) => {
        const agentId = agentOf(c);
        const marker = await deps.settings.rotateMarker(agentId, {
          authorHuman: deps.humanFor?.(c) ?? null,
        });
        await recordChange(c, agentId, "rotate_marker", {});
        return c.json({ marker });
      }),
    },
    {
      method: "GET",
      path: "/agents/:agentId/email/commands",
      handler: wrap(async (c) => {
        const agentId = agentOf(c);
        const limit = intQuery(c, "limit", 50, 500);
        const rows = deps.commandAudit ? await deps.commandAudit(agentId, { limit }) : [];
        return c.json({ rows });
      }),
    },
  ];
}

/** Mount the routes on a Hono-compatible app; returns the app. */
export function mountEmailRoutes<A extends EmailRouteApp>(app: A, deps: EmailRouteDeps): A {
  for (const route of emailRouteTable(deps)) {
    if (route.method === "GET") app.get(route.path, route.handler);
    else if (route.method === "PUT") app.put(route.path, route.handler);
    else app.post(route.path, route.handler);
  }
  return app;
}

/** `createEmailRoutes(deps, new Hono())` gives a sub-app the daemon mounts. */
export function createEmailRoutes<A extends EmailRouteApp>(deps: EmailRouteDeps, app: A): A {
  return mountEmailRoutes(app, deps);
}
