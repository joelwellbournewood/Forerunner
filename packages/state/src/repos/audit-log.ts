import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { AuditLogRow, NewAuditLog } from "../types.ts";
import { type ListOptions, Repository } from "./base.ts";

export interface AuditFilter {
  sessionId?: string;
  runId?: string;
  agentId?: string;
  humanId?: string;
  tool?: string;
  allowed?: boolean;
  /** Inclusive ISO lower bound on occurred_at. */
  from?: string;
  /** Exclusive ISO upper bound on occurred_at. */
  to?: string;
}

/** Append-only audit log of tool calls. No update or delete methods exist; triggers back it up. */
export class AuditLogRepo {
  private readonly base: Repository<AuditLogRow>;
  readonly table = "audit_log";

  constructor(
    readonly db: Database,
    readonly clock: Clock,
  ) {
    this.base = new Repository<AuditLogRow>(db, ENTITIES.audit_log as EntityDef, clock);
  }

  append(input: NewAuditLog): Promise<AuditLogRow> {
    return this.base.insert({ occurred_at: this.clock.nowIso(), ...input });
  }

  get(id: string): Promise<AuditLogRow | undefined> {
    return this.base.get(id);
  }

  list(filter: AuditFilter = {}, opts: ListOptions = {}): Promise<AuditLogRow[]> {
    const parts: string[] = [];
    const params: unknown[] = [];
    const eq = (col: string, v: unknown) => {
      if (v === undefined) return;
      parts.push(`"${col}" = ?`);
      params.push(v);
    };
    eq("session_id", filter.sessionId);
    eq("run_id", filter.runId);
    eq("agent_id", filter.agentId);
    eq("human_id", filter.humanId);
    eq("tool", filter.tool);
    if (filter.allowed !== undefined) {
      parts.push('"allowed" = ?');
      params.push(this.db.dialect === "sqlite" ? (filter.allowed ? 1 : 0) : filter.allowed);
    }
    if (filter.from) {
      parts.push('"occurred_at" >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      parts.push('"occurred_at" < ?');
      params.push(filter.to);
    }
    const where = parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
    let tail = ' ORDER BY "occurred_at", "id"';
    if (opts.limit !== undefined) {
      tail += " LIMIT ?";
      params.push(Math.max(0, Math.floor(opts.limit)));
    }
    if (opts.offset !== undefined) {
      if (opts.limit === undefined)
        tail += this.db.dialect === "sqlite" ? " LIMIT -1" : " LIMIT ALL";
      tail += " OFFSET ?";
      params.push(Math.max(0, Math.floor(opts.offset)));
    }
    return this.base.rows(`SELECT * FROM "audit_log"${where}${tail}`, params);
  }

  count(filter: AuditFilter = {}): Promise<number> {
    return this.list(filter).then((rows) => rows.length);
  }
}
