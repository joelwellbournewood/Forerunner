/**
 * HTTP routes for the UI (Settings -> Capabilities -> Email): settings per agent, the sent log,
 * pause/resume, marker rotation and the command audit. The routes are described as a table and
 * mounted on any Hono-compatible app through a minimal structural interface, so this package
 * needs no dependency on hono; the daemon iterates `emailRouteTable(deps)` and adapts each
 * handler to Hono's context (`createEmailRoutes(deps, app)` mounts the same table on a
 * structural app). Every mutation is recorded as an audit row, and so is every refusal of the
 * owner check and of a mode change sent to the raw route (an `email.settings` row with
 * `allowed = false`), the way the policy records a blocked send; a refusal stands whether or
 * not its row could be written. The sending mode itself is the command registry's
 * (`modeChangeCommand`): a high-risk change with a card and a device confirmation.
 */
import { type Clock, ForerunnerError, log } from "@forerunner/platform";
import type { AuditLogRepo, JsonObject } from "@forerunner/state";
import { EMAIL_SETTINGS_TOOL, type SentLog } from "./sent-log.ts";
import {
  type AgentEmailConfigPatch,
  EMAIL_MODES,
  type EmailSettingsStore,
  type IdentityPort,
} from "./types.ts";

const logger = log("capabilities:email:routes");

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
  /**
   * Human id behind a request (from the daemon's auth), recorded as the author. A mount that
   * passes it identifies humans and must pass `identity` too; see there.
   */
  humanFor?: (c: EmailRouteContext) => string | undefined;
  /**
   * Who owns an agent (`lookup(agentId).humanId`). With `humanFor` set, every route under
   * `/agents/:agentId` refuses (403, `tool_not_allowed`, `reason: "not_owner"`) a request
   * whose signed-in human is not the agent's owner, so on a shared state one human cannot
   * point another human's agent at their own address. A daemon that identifies humans must
   * pass it: a mount with `humanFor` and no `identity` cannot tell the humans apart, so it
   * fails closed and refuses (403, `reason: "identity_port_missing"`) every request under
   * `/agents/:agentId`, logging the misconfiguration once at construction. Only a mount that
   * identifies nobody (no `humanFor`: a single-user daemon) applies no owner check.
   */
  identity?: Pick<IdentityPort, "lookup">;
  /**
   * The registry command a sending-mode change goes through (the daemon passes
   * `"email.mode.set"`). A mode change is a high-risk permission change (spec Q, "Confirmation
   * by risk": a change card, then a confirmation on a paired device, one change log row with
   * undo), which this route cannot provide. With the option set, a `PUT` whose `settings.mode`
   * is a valid mode other than the stored one is refused (403 `tool_not_allowed`,
   * `details.reason: "mode_change_needs_command"`, the command named) as an audited refusal,
   * and nothing in the body is written; the stored mode in the body is no change. A host
   * without a registry leaves it unset and the table serves the mode as before.
   */
  modeChangeCommand?: string;
}

/** Why the owner check refused a request; `denied_reason` of the audit row and `details.reason`. */
export type EmailOwnerRefusal = "identity_port_missing" | "not_owner";
/** Every refusal the routes audit: the owner check's, and a mode change sent to the raw route. */
export type EmailRouteRefusal = EmailOwnerRefusal | "mode_change_needs_command";

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

/** An ISO-8601 date-time query value, normalised; anything else (or none) is undefined. */
function isoInstantQuery(c: EmailRouteContext, name: string): string | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function intQuery(c: EmailRouteContext, name: string, fallback: number, max: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

export function emailRouteTable(deps: EmailRouteDeps): EmailRoute[] {
  if (deps.humanFor && !deps.identity) {
    logger.error(
      "email routes identify the human but have no identity port: a signed-in human cannot be checked against the agent's owner, so every request under /agents/:agentId is refused until the mount passes `identity`",
    );
  }
  /**
   * An owner-check refusal is an audit row with allowed = false, like a blocked send, with the
   * same JSON result shape (`{ status, reason }`) so a reader that parses `result_summary`
   * never throws on it. The refusal stands whatever the audit store does: a row that cannot
   * be written must not turn the 403 into a 500 carrying the store's message, so the failure
   * is one warn line naming the agent, the action and the reason instead.
   */
  const recordRefusal = async (
    c: EmailRouteContext,
    agentId: string,
    action: string,
    reason: EmailRouteRefusal,
  ): Promise<void> => {
    if (!deps.audit) return;
    const human = deps.humanFor?.(c) ?? null;
    try {
      await deps.audit.append({
        tool: EMAIL_SETTINGS_TOOL,
        allowed: false,
        denied_reason: reason,
        agent_id: agentId,
        human_id: human,
        input_summary: JSON.stringify({ action, refused: reason }),
        result_summary: JSON.stringify({ status: "refused", reason }),
        cost_usd_micro: 0,
        occurred_at: deps.clock.nowIso(),
        author_human: human,
      });
    } catch (e) {
      logger.warn("owner-check refusal not audited", {
        agentId,
        action,
        reason,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
  /** Audits the refusal and returns the error to throw (`throw await refusal(...)`). */
  const refusal = async (
    c: EmailRouteContext,
    agentId: string,
    action: string,
    reason: EmailRouteRefusal,
    message: string,
    extra: JsonObject = {},
  ): Promise<ForerunnerError> => {
    await recordRefusal(c, agentId, action, reason);
    return new ForerunnerError("tool_not_allowed", message, {
      details: { agentId, reason, ...extra },
    });
  };
  /**
   * The signed-in human must own the agent. A mount that identifies humans (`humanFor`) but
   * cannot resolve owners (no `identity`) fails closed; only a mount that identifies nobody
   * skips the check.
   */
  const assertOwner = async (
    c: EmailRouteContext,
    agentId: string,
    action: string,
  ): Promise<void> => {
    if (!deps.humanFor) return;
    if (!deps.identity) {
      throw await refusal(
        c,
        agentId,
        action,
        "identity_port_missing",
        "the email routes identify the signed-in human but were mounted without an identity port, so the agent's owner cannot be checked; the request is refused",
      );
    }
    const human = deps.humanFor(c);
    const owner = await deps.identity.lookup(agentId).then(
      (i) => i.humanId,
      () => undefined,
    );
    if (human === undefined || owner === undefined || owner !== human) {
      throw await refusal(
        c,
        agentId,
        action,
        "not_owner",
        "the signed-in human does not own this agent; its email settings are not theirs to read or change",
      );
    }
  };
  const agentOf = async (c: EmailRouteContext, action: string): Promise<string> => {
    const id = c.req.param("agentId");
    if (!id) throw new ForerunnerError("validation", "agentId missing");
    await assertOwner(c, id, action);
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
      handler: wrap(async (c) =>
        c.json(await deps.settings.get(await agentOf(c, "read_settings"))),
      ),
    },
    {
      method: "PUT",
      path: "/agents/:agentId/email/settings",
      handler: wrap(async (c) => {
        const agentId = await agentOf(c, "update");
        const body = (await c.req.json()) as AgentEmailConfigPatch | null;
        if (!body || typeof body !== "object")
          throw new ForerunnerError("validation", "body must be an object");
        const patch: AgentEmailConfigPatch = {};
        if (body.settings && typeof body.settings === "object") patch.settings = body.settings;
        if (body.commands && typeof body.commands === "object") patch.commands = body.commands;
        const before = await deps.settings.get(agentId);
        // The mode is the registry's to change (spec Q: high risk, a card and a device
        // confirmation): a valid mode other than the stored one is refused here, so no client
        // skips the card through the raw route. An invalid value falls through to the
        // schema's 400; the stored mode in the body is no change.
        const requested = patch.settings?.mode;
        if (
          deps.modeChangeCommand &&
          typeof requested === "string" &&
          (EMAIL_MODES as readonly string[]).includes(requested) &&
          requested !== before.settings.mode
        ) {
          throw await refusal(
            c,
            agentId,
            "update",
            "mode_change_needs_command",
            `the email mode is a high-risk change: it is set with the ${deps.modeChangeCommand} command (a change card, then a confirmation on a paired device), not through this route; nothing was changed`,
            {
              command: deps.modeChangeCommand,
              modeBefore: before.settings.mode,
              modeRequested: requested,
            },
          );
        }
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
        const agentId = await agentOf(c, "read_sent");
        const limit = intQuery(c, "limit", 50, 500);
        // `since` is an ISO-8601 instant or nothing: the store compares it as text with
        // `occurred_at`, so a mistyped value is not passed through (it would list every copy
        // ever written, or nothing, with the typo echoed back) but replaced by the default.
        const since =
          isoInstantQuery(c, "since") ??
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
        const agentId = await agentOf(c, "pause");
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
        const agentId = await agentOf(c, "resume");
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
        const agentId = await agentOf(c, "rotate_marker");
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
        const agentId = await agentOf(c, "read_commands");
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
