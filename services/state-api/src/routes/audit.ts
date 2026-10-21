import {
  type AuditExportScope,
  auditFilterFrom,
  auditScopeFor,
  parseAuditExportQuery,
  streamAuditExport,
} from "@forerunner/runtime/daemon/audit-export";
import { requireScope, resolveHumanId } from "../auth/principal.ts";
import { type App, principal, type RouteContext } from "../http.ts";

/**
 * Audit log export (spec S.9, ADR 0050): `GET /audit/export?agentId=&sessionId=&from=&to=
 * &format=jsonl|csv&humanId=`, the daemon's route served from the shared state for devices.
 * A device gets the rows of its own human and that human's agents, streamed in pages with
 * the summaries as stored; install-level rows that name nobody are not a phone's business.
 * Another human's agent is "not found" (the id is not acknowledged), another human's id is
 * forbidden as on every route. The runtime (admin) reads the whole log, or one human's rows
 * when it names a `humanId`. Validation errors keep their status: the headers go out only
 * once the scope is settled.
 */
export function registerAuditRoutes(app: App, ctx: RouteContext): void {
  app.get("/audit/export", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const q = parseAuditExportQuery(c.req.query());
    const humanId = resolveHumanId(p, q.humanId);
    const scope: AuditExportScope | undefined =
      humanId === undefined ? undefined : await auditScopeFor(ctx.store, humanId, q.agentId, false);
    return streamAuditExport(
      c,
      ctx.store.auditLog,
      { format: q.format, filter: auditFilterFrom(q), scope },
      ctx.clock.nowIso(),
    );
  });
}
