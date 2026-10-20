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
}
