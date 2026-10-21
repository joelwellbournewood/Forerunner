import { errorMessage, ForerunnerError, isForerunnerError, log } from "@forerunner/platform";
import type { AgentRow, AuditFilter, AuditLogRow, ListOptions } from "@forerunner/state";
import { type Context, Hono } from "hono";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

/**
 * Audit log export (spec S.9 "exportable"; ADR 0050). One module serves the daemon route
 * (`GET /audit/export`), the state service's route of the same shape and `fr audit export`:
 *
 * - the log is read in pages through `store.auditLog.list` (limit and offset over the
 *   repository's stable `occurred_at, id` order); nothing ever loads the whole table;
 * - a row is written exactly as stored: the input and result summaries were redacted and
 *   capped by the hooks at write time, and no raw parameter exists anywhere to add;
 * - the rows a caller gets are their own: those naming the human, those of the human's
 *   agents and, where the caller owns the install (the daemon, the CLI), the install-level
 *   rows that name nobody (update health checks, the sync gate); a request for another
 *   human's agent is "not found", so the id is not acknowledged either;
 * - two formats, JSON lines and RFC 4180 CSV; CSV cells a spreadsheet would evaluate
 *   (`=`, `+`, `-`, `@`, tab, CR first) get a leading apostrophe.
 */
export const AUDIT_EXPORT_ROUTE = "GET /audit/export";
export const AUDIT_EXPORT_FORMATS = ["jsonl", "csv"] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];
/** Rows per `list` call. Memory per page is bounded by this, whatever the log's size. */
export const AUDIT_EXPORT_PAGE_SIZE = 500;
/** Longest id or timestamp accepted in a query; longer values are refused before any read. */
export const AUDIT_EXPORT_MAX_PARAM_LENGTH = 200;

/** The exported record: one line of JSON lines, one row of CSV, in this column order. */
export const AUDIT_EXPORT_COLUMNS = [
  "id",
  "occurredAt",
  "agentId",
  "humanId",
  "sessionId",
  "runId",
  "tokenId",
  "tool",
  "allowed",
  "deniedReason",
  "costUsdMicro",
  "inputSummary",
  "resultSummary",
  "recordedAt",
] as const;
export type AuditExportColumn = (typeof AUDIT_EXPORT_COLUMNS)[number];

export interface AuditExportRecord {
  id: string;
  /** When the call happened (ISO-8601 UTC). */
  occurredAt: string;
  agentId: string | null;
  humanId: string | null;
  sessionId: string | null;
  runId: string | null;
  /** The capability token the call ran under. */
  tokenId: string | null;
  tool: string;
  allowed: boolean;
  deniedReason: string | null;
  costUsdMicro: number;
  /** As stored: redacted and capped at write time. */
  inputSummary: string;
  resultSummary: string;
  /** When the store recorded the row (`created_at`), for forensic ordering. */
  recordedAt: string;
}

export function auditExportRecord(row: AuditLogRow): AuditExportRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    agentId: row.agent_id,
    humanId: row.human_id,
    sessionId: row.session_id,
    runId: row.run_id,
    tokenId: row.token_id,
    tool: row.tool,
    allowed: Boolean(row.allowed),
    deniedReason: row.denied_reason,
    costUsdMicro: Number(row.cost_usd_micro),
    inputSummary: row.input_summary,
    resultSummary: row.result_summary,
    recordedAt: row.created_at,
  };
}

// --- query ---------------------------------------------------------------------------------

const Param = z.string().trim().min(1).max(AUDIT_EXPORT_MAX_PARAM_LENGTH);
const Timestamp = Param.refine((v) => Number.isFinite(Date.parse(v)), {
  message: "must be an ISO-8601 timestamp",
}).transform((v) => new Date(Date.parse(v)).toISOString());

export const AuditExportQuery = z
  .object({
    agentId: Param.optional(),
    sessionId: Param.optional(),
    /** Only the state service reads it (admins may export another human's rows). */
    humanId: Param.optional(),
    /** Inclusive lower bound on `occurredAt`. */
    from: Timestamp.optional(),
    /** Exclusive upper bound on `occurredAt`. */
    to: Timestamp.optional(),
    format: z.enum(AUDIT_EXPORT_FORMATS).default("jsonl"),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: "from must not be after to",
    path: ["from"],
  });
export type AuditExportQuery = z.infer<typeof AuditExportQuery>;

/**
 * Parse the query of a route or the flags of the CLI. Blank values count as absent (a form
 * sends empty fields). Throws `ForerunnerError("validation")` naming the parameter.
 */
export function parseAuditExportQuery(
  raw: Record<string, string | undefined | null>,
): AuditExportQuery {
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim() !== "") input[key] = value;
  }
  const r = AuditExportQuery.safeParse(input);
  if (!r.success) {
    throw new ForerunnerError(
      "validation",
      r.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; "),
      {
        details: {
          issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
    );
  }
  return r.data;
}

/** The store filter a parsed query stands for (the scope is applied per row, not here). */
export function auditFilterFrom(q: AuditExportQuery): AuditFilter {
  return {
    ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
    ...(q.sessionId !== undefined ? { sessionId: q.sessionId } : {}),
    ...(q.from !== undefined ? { from: q.from } : {}),
    ...(q.to !== undefined ? { to: q.to } : {}),
  };
}

// --- scope ---------------------------------------------------------------------------------

export interface AuditExportScope {
  humanId: string;
  /** The human's agents. */
  agentIds: ReadonlySet<string>;
  /**
   * Whether rows naming no human and no agent belong in the export: install-level events
   * (update health checks, the schema sync gate). True for the install's own human on the
   * daemon and the CLI; false for a device reading through the state service.
   */
  includeUnowned: boolean;
}

/** Without a scope (the service's admin principal) every row is in. */
export function rowInScope(row: AuditLogRow, scope: AuditExportScope | undefined): boolean {
  if (!scope) return true;
  if (row.human_id === scope.humanId) return true;
  if (row.agent_id !== null && scope.agentIds.has(row.agent_id)) return true;
  return row.human_id === null && row.agent_id === null && scope.includeUnowned;
}

export interface AuditScopeStore {
  agent: {
    forOwner(ownerHumanId: string, opts?: ListOptions): Promise<AgentRow[]>;
  };
}

/**
 * The scope of a human's export. A requested agent that is not one of theirs is refused as
 * `not_found`, whether it belongs to someone else or does not exist: the answer must not
 * tell the two apart.
 */
export async function auditScopeFor(
  store: AuditScopeStore,
  humanId: string,
  requestedAgentId: string | undefined,
  includeUnowned: boolean,
): Promise<AuditExportScope> {
  const agentIds = new Set((await store.agent.forOwner(humanId)).map((a) => a.id));
  if (requestedAgentId !== undefined && !agentIds.has(requestedAgentId)) {
    throw new ForerunnerError("not_found", `agent ${requestedAgentId} not found`, {
      details: { agentId: requestedAgentId },
    });
  }
  return { humanId, agentIds, includeUnowned };
}

// --- paging and serialisation --------------------------------------------------------------

export interface AuditExportSource {
  list(filter: AuditFilter, opts: ListOptions): Promise<AuditLogRow[]>;
}

/**
 * Pages of the log in the repository's order (`occurred_at`, `id`), `pageSize` rows per
 * read, until a short page says the log ended. Offsets are stable because the log is
 * append-only and a late row carries the clock's current time, which sorts after the page
 * being read.
 */
export async function* auditExportPages(
  source: AuditExportSource,
  filter: AuditFilter,
  pageSize: number = AUDIT_EXPORT_PAGE_SIZE,
): AsyncGenerator<AuditLogRow[], void, undefined> {
  const size = Math.max(1, Math.floor(pageSize));
  for (let offset = 0; ; offset += size) {
    const page = await source.list(filter, { limit: size, offset });
    if (page.length > 0) yield page;
    if (page.length < size) return;
  }
}

export function jsonlLine(record: AuditExportRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function csvHeader(): string {
  return `${AUDIT_EXPORT_COLUMNS.join(",")}\r\n`;
}

/** Characters a spreadsheet reads as the start of a formula; the cell gets an apostrophe. */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One CSV cell: RFC 4180 quoting after the formula guard; null is an empty cell. */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return "";
  if (typeof value !== "string") return String(value);
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvLine(record: AuditExportRecord): string {
  return `${AUDIT_EXPORT_COLUMNS.map((c) => csvCell(record[c])).join(",")}\r\n`;
}

export function auditExportContentType(format: AuditExportFormat): string {
  return format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8";
}

/** `forerunner-audit-20261020T080509Z.jsonl`: the clock's time, no local time zone. */
export function auditExportFilename(format: AuditExportFormat, nowIso: string): string {
  const stamp = nowIso.replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  return `forerunner-audit-${stamp}.${format}`;
}

export interface AuditExportSink {
  write(chunk: string): Promise<unknown> | unknown;
}

export interface AuditExportOptions {
  format: AuditExportFormat;
  filter: AuditFilter;
  scope?: AuditExportScope | undefined;
  pageSize?: number | undefined;
}

/**
 * Write the export to a sink page by page: the CSV header first, then one chunk per page
 * holding its in-scope rows. Returns how many rows were written.
 */
export async function writeAuditExport(
  source: AuditExportSource,
  sink: AuditExportSink,
  opts: AuditExportOptions,
): Promise<{ rows: number }> {
  let rows = 0;
  if (opts.format === "csv") await sink.write(csvHeader());
  for await (const page of auditExportPages(source, opts.filter, opts.pageSize)) {
    let chunk = "";
    for (const row of page) {
      if (!rowInScope(row, opts.scope)) continue;
      const record = auditExportRecord(row);
      chunk += opts.format === "csv" ? csvLine(record) : jsonlLine(record);
      rows += 1;
    }
    if (chunk.length > 0) await sink.write(chunk);
  }
  return { rows };
}

// --- HTTP ----------------------------------------------------------------------------------

const logger = log("runtime:audit-export");

/**
 * Stream the export as a file download on a Hono context (the daemon's and the state
 * service's routes both end here). Headers go out before the first page is read, so a
 * failure mid-way truncates the body and is logged; validation and scope errors are thrown
 * by the caller before this point and keep their status codes.
 */
export function streamAuditExport(
  c: Context,
  source: AuditExportSource,
  opts: AuditExportOptions,
  nowIso: string,
): Response {
  c.header("Content-Type", auditExportContentType(opts.format));
  c.header(
    "Content-Disposition",
    `attachment; filename="${auditExportFilename(opts.format, nowIso)}"`,
  );
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  return stream(
    c,
    async (s) => {
      await writeAuditExport(source, { write: (chunk) => s.write(chunk) }, opts);
    },
    async (e, s) => {
      logger.error("audit export failed mid-stream; the file is truncated", {
        error: errorMessage(e),
      });
      s.abort();
    },
  );
}

export interface AuditRoutesDeps {
  store: AuditScopeStore & { auditLog: AuditExportSource };
  clock: { nowIso(): string };
  /** The install's human: the export is theirs and their agents'. */
  humanId: () => string;
  /** Rows per read; the default is `AUDIT_EXPORT_PAGE_SIZE`. */
  pageSize?: number;
}

function statusFor(code: string): ContentfulStatusCode {
  switch (code) {
    case "not_found":
      return 404;
    case "validation":
      return 400;
    default:
      return 500;
  }
}

/**
 * The daemon's sub-app: `GET /audit/export?agentId=&sessionId=&from=&to=&format=jsonl|csv`.
 * Mounted behind the daemon's bearer check (`app.route("/", createAuditRoutes(deps))`); the
 * error mapping is this module's own so the sub-app behaves the same standalone.
 */
export function createAuditRoutes(deps: AuditRoutesDeps): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (isForerunnerError(err)) {
      const status = statusFor(err.code);
      if (status === 500) logger.error("audit export failed", { error: err.message });
      return c.json(
        {
          code: err.code,
          message: status === 500 ? "internal error" : err.message,
          details: status === 500 ? {} : (err.details ?? {}),
        },
        status,
      );
    }
    logger.error("audit export failed", { error: errorMessage(err) });
    return c.json({ code: "internal", message: "internal error", details: {} }, 500);
  });
  app.get("/audit/export", async (c) => {
    const q = parseAuditExportQuery(c.req.query());
    const scope = await auditScopeFor(deps.store, deps.humanId(), q.agentId, true);
    return streamAuditExport(
      c,
      deps.store.auditLog,
      { format: q.format, filter: auditFilterFrom(q), scope, pageSize: deps.pageSize },
      deps.clock.nowIso(),
    );
  });
  return app;
}
