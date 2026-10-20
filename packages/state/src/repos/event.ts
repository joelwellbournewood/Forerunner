import type { Clock } from "@forerunner/platform";
import { isUniqueViolation } from "../db/dialect.ts";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { EventRow, JsonValue } from "../types.ts";
import { Repository } from "./base.ts";

export interface AppendEventOptions {
  redacted?: boolean;
  authorAgent?: string | null;
  authorHuman?: string | null;
}

/** Append-only session log. No update or delete methods exist, and the table has triggers. */
export class EventRepo {
  private readonly base: Repository<EventRow>;
  readonly table = "event";

  constructor(
    readonly db: Database,
    readonly clock: Clock,
  ) {
    this.base = new Repository<EventRow>(db, ENTITIES.event as EntityDef, clock);
  }

  /** Append with the next per-session seq. Concurrent appenders retry on a seq collision. */
  async append(
    sessionId: string,
    type: string,
    payload: JsonValue = {},
    costUsdMicro = 0,
    opts: AppendEventOptions = {},
  ): Promise<EventRow> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          if (tx.dialect === "postgres") {
            // Serialise appenders per session so seqs never collide under real concurrency.
            await tx.query("SELECT pg_advisory_xact_lock(hashtext(?))", [`event:${sessionId}`]);
          }
          const seq = (await this.latestSeq(sessionId)) + 1;
          return this.base.insert({
            session_id: sessionId,
            seq,
            type,
            payload,
            cost_usd_micro: costUsdMicro,
            redacted: opts.redacted ?? false,
            author_agent: opts.authorAgent ?? null,
            author_human: opts.authorHuman ?? null,
          });
        });
      } catch (e) {
        lastError = e;
        if (!isUniqueViolation(e)) throw e;
      }
    }
    throw lastError;
  }

  async latestSeq(sessionId: string): Promise<number> {
    const [row] = await this.db.query<{ seq: unknown }>(
      `SELECT COALESCE(MAX("seq"), 0) AS seq FROM "event" WHERE "session_id" = ?`,
      [sessionId],
    );
    return Number(row?.seq ?? 0);
  }

  /** Events of a session with seq > afterSeq, in order. */
  list(sessionId: string, afterSeq = 0, limit?: number): Promise<EventRow[]> {
    const limitSql = limit === undefined ? "" : " LIMIT ?";
    const params: unknown[] = [sessionId, afterSeq];
    if (limit !== undefined) params.push(Math.max(0, Math.floor(limit)));
    return this.base.rows(
      `SELECT * FROM "event" WHERE "session_id" = ? AND "seq" > ? ORDER BY "seq"${limitSql}`,
      params,
    );
  }

  get(id: string): Promise<EventRow | undefined> {
    return this.base.get(id);
  }

  count(sessionId: string): Promise<number> {
    return this.base.count({ session_id: sessionId });
  }
}
