import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { CostKind, CostLedgerRow, NewCostLedger } from "../types.ts";
import { Repository } from "./base.ts";

export interface CostFilter {
  humanId?: string;
  agentId?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  billingSourceId?: string;
  kind?: CostKind;
  /** Inclusive ISO lower bound on occurred_at. */
  from?: string;
  /** Exclusive ISO upper bound on occurred_at. */
  to?: string;
}

export interface CostSum {
  usd_micro: number;
  chf_micro: number;
  /** Highest plan share seen (subscription usage is a share, not a sum). */
  plan_usage_share: number | null;
  entries: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export type BreakdownKey =
  | "model"
  | "specialist"
  | "project_id"
  | "task_id"
  | "session_id"
  | "agent_id"
  | "billing_source_id"
  | "kind";

export interface CostBucket extends CostSum {
  key: string | null;
}

const COLUMN_FOR: Record<keyof Omit<CostFilter, "from" | "to">, string> = {
  humanId: "human_id",
  agentId: "agent_id",
  projectId: "project_id",
  sessionId: "session_id",
  taskId: "task_id",
  runId: "run_id",
  billingSourceId: "billing_source_id",
  kind: "kind",
};

const SUM_COLUMNS = `CAST(COALESCE(SUM("usd_micro"), 0) AS BIGINT) AS usd_micro,
       CAST(COALESCE(SUM("chf_micro"), 0) AS BIGINT) AS chf_micro,
       MAX("plan_usage_share") AS plan_usage_share,
       COUNT(*) AS entries,
       CAST(COALESCE(SUM("tokens_in"), 0) AS BIGINT) AS tokens_in,
       CAST(COALESCE(SUM("tokens_out"), 0) AS BIGINT) AS tokens_out,
       CAST(COALESCE(SUM("cache_read_tokens"), 0) AS BIGINT) AS cache_read_tokens,
       CAST(COALESCE(SUM("cache_write_tokens"), 0) AS BIGINT) AS cache_write_tokens`;

interface RawSum {
  usd_micro: unknown;
  chf_micro: unknown;
  plan_usage_share: unknown;
  entries: unknown;
  tokens_in: unknown;
  tokens_out: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
}

function toSum(r: RawSum | undefined): CostSum {
  const n = (v: unknown) => Number(v ?? 0);
  return {
    usd_micro: n(r?.usd_micro),
    chf_micro: n(r?.chf_micro),
    plan_usage_share:
      r?.plan_usage_share === null || r?.plan_usage_share === undefined
        ? null
        : Number(r.plan_usage_share),
    entries: n(r?.entries),
    tokens_in: n(r?.tokens_in),
    tokens_out: n(r?.tokens_out),
    cache_read_tokens: n(r?.cache_read_tokens),
    cache_write_tokens: n(r?.cache_write_tokens),
  };
}

/** The cost ledger: every charge, and the sums the caps are checked against. */
export class CostLedgerRepo extends Repository<CostLedgerRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.cost_ledger as EntityDef, clock);
  }

  record(entry: NewCostLedger): Promise<CostLedgerRow> {
    return this.insert({ occurred_at: this.clock.nowIso(), ...entry });
  }

  private filterSql(filter: CostFilter): { sql: string; params: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(COLUMN_FOR) as [keyof typeof COLUMN_FOR, string][]) {
      const v = filter[key];
      if (v === undefined) continue;
      parts.push(`"${column}" = ?`);
      params.push(v);
    }
    if (filter.from) {
      parts.push('"occurred_at" >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      parts.push('"occurred_at" < ?');
      params.push(filter.to);
    }
    return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", params };
  }

  async sum(filter: CostFilter = {}): Promise<CostSum> {
    const w = this.filterSql(filter);
    const [row] = await this.db.query<RawSum>(
      `SELECT ${SUM_COLUMNS} FROM "cost_ledger"${w.sql}`,
      w.params,
    );
    return toSum(row);
  }

  async breakdown(by: BreakdownKey, filter: CostFilter = {}): Promise<CostBucket[]> {
    const w = this.filterSql(filter);
    const rows = await this.db.query<RawSum & { key: string | null }>(
      `SELECT "${by}" AS key, ${SUM_COLUMNS} FROM "cost_ledger"${w.sql} GROUP BY "${by}" ORDER BY usd_micro DESC, key`,
      w.params,
    );
    return rows.map((r) => ({ key: r.key ?? null, ...toSum(r) }));
  }

  byModel(filter: CostFilter = {}): Promise<CostBucket[]> {
    return this.breakdown("model", filter);
  }

  bySpecialist(filter: CostFilter = {}): Promise<CostBucket[]> {
    return this.breakdown("specialist", filter);
  }

  byProject(filter: CostFilter = {}): Promise<CostBucket[]> {
    return this.breakdown("project_id", filter);
  }

  /**
   * What each of these sessions spent, split by the kind of the billing source that paid
   * (`api_key`, `subscription`, `plan_credits`, `fake`; null for a row without a source), in one
   * query per 500 ids (d1109-sessions, ADR 0116): the Sessions list's one figure per row and
   * which credential paid it. Each session's buckets add up to `sum({ sessionId })`.
   */
  async sumsBySessionAndSource(sessionIds: readonly string[]): Promise<SessionSourceSum[]> {
    const ids = [...new Set(sessionIds)];
    const out: SessionSourceSum[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await this.db.query<{
        session_id: string;
        source_kind: string | null;
        usd_micro: unknown;
        chf_micro: unknown;
        entries: unknown;
      }>(
        `SELECT c."session_id" AS session_id, b."kind" AS source_kind,
           CAST(COALESCE(SUM(c."usd_micro"), 0) AS BIGINT) AS usd_micro,
           CAST(COALESCE(SUM(c."chf_micro"), 0) AS BIGINT) AS chf_micro,
           COUNT(*) AS entries
         FROM "cost_ledger" c LEFT JOIN "billing_source" b ON b."id" = c."billing_source_id"
         WHERE c."session_id" IN (${chunk.map(() => "?").join(", ")})
         GROUP BY c."session_id", b."kind"
         ORDER BY c."session_id", b."kind"`,
        chunk,
      );
      for (const r of rows)
        out.push({
          sessionId: r.session_id,
          sourceKind: r.source_kind ?? null,
          usd_micro: Number(r.usd_micro ?? 0),
          chf_micro: Number(r.chf_micro ?? 0),
          entries: Number(r.entries ?? 0),
        });
    }
    return out;
  }

  /**
   * What chat about a project cost (d1109-sessions): the ledger rows of the conversation's
   * session rows (`summary` "conversation") booked to the project. Chat is one conversation, not
   * a session (design §3.9), so the Sessions list says it on one line of its own.
   */
  async chatSpendForProject(projectId: string): Promise<CostSum> {
    const [row] = await this.db.query<RawSum>(
      `SELECT ${SUM_COLUMNS} FROM "cost_ledger"
       WHERE "project_id" = ? AND "session_id" IN (
         SELECT "id" FROM "session" WHERE "summary" = 'conversation')`,
      [projectId],
    );
    return toSum(row);
  }
}

/** One session's spend paid by one kind of billing source (`sumsBySessionAndSource`). */
export interface SessionSourceSum {
  sessionId: string;
  /** The billing source's kind, or null for ledger rows without a source. */
  sourceKind: string | null;
  usd_micro: number;
  chf_micro: number;
  entries: number;
}
