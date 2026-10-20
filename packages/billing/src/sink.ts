/**
 * The minimal ledger storage interface this package needs. The wiring adapts the state
 * package's CostLedgerRepo (record / sum / list) to these two interfaces; tests use the
 * in-memory implementation. Field names match the cost_ledger table so the adapter is a
 * pass-through.
 */
import type { Clock } from "@forerunner/platform";
import { ForerunnerError, newId } from "@forerunner/platform";
import { assertMicro } from "./money.ts";
import type { CostKind } from "./sources.ts";

export interface LedgerEntry {
  id?: string;
  human_id: string;
  agent_id?: string | null;
  project_id?: string | null;
  session_id?: string | null;
  task_id?: string | null;
  run_id?: string | null;
  billing_source_id: string | null;
  kind: CostKind;
  /** Charge in micro-USD. For kind "subscription" this is the estimated API-equivalent. */
  usd_micro: number;
  chf_micro: number;
  rate_chf_per_usd: number;
  /** Share of the plan limit consumed (subscriptions), 0..1. */
  plan_usage_share?: number | null;
  model: string;
  specialist?: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Context tokens before and after compression for this run, when the runtime measured it. */
  tokens_before_compression?: number | null;
  tokens_after_compression?: number | null;
  occurred_at: string;
}

export type StoredLedgerEntry = LedgerEntry & { id: string };

export interface LedgerFilter {
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

export interface LedgerSum {
  usd_micro: number;
  chf_micro: number;
  /** Highest plan share seen (a share is a level, not a sum). */
  plan_usage_share: number | null;
  entries: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface LedgerSink {
  record(entry: LedgerEntry): Promise<StoredLedgerEntry>;
}

export interface LedgerQuery {
  sum(filter: LedgerFilter): Promise<LedgerSum>;
  list(filter: LedgerFilter): Promise<StoredLedgerEntry[]>;
}

export function emptySum(): LedgerSum {
  return {
    usd_micro: 0,
    chf_micro: 0,
    plan_usage_share: null,
    entries: 0,
    tokens_in: 0,
    tokens_out: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
}

/** Fold entries into a LedgerSum; shared by the in-memory ledger and the reports. */
export function sumEntries(entries: Iterable<LedgerEntry>): LedgerSum {
  const s = emptySum();
  for (const e of entries) {
    s.usd_micro += e.usd_micro;
    s.chf_micro += e.chf_micro;
    s.entries += 1;
    s.tokens_in += e.tokens_in;
    s.tokens_out += e.tokens_out;
    s.cache_read_tokens += e.cache_read_tokens;
    s.cache_write_tokens += e.cache_write_tokens;
    if (typeof e.plan_usage_share === "number") {
      s.plan_usage_share = Math.max(s.plan_usage_share ?? 0, e.plan_usage_share);
    }
  }
  return s;
}

export function matchesFilter(e: LedgerEntry, f: LedgerFilter): boolean {
  if (f.humanId !== undefined && e.human_id !== f.humanId) return false;
  if (f.agentId !== undefined && (e.agent_id ?? null) !== f.agentId) return false;
  if (f.projectId !== undefined && (e.project_id ?? null) !== f.projectId) return false;
  if (f.sessionId !== undefined && (e.session_id ?? null) !== f.sessionId) return false;
  if (f.taskId !== undefined && (e.task_id ?? null) !== f.taskId) return false;
  if (f.runId !== undefined && (e.run_id ?? null) !== f.runId) return false;
  if (f.billingSourceId !== undefined && e.billing_source_id !== f.billingSourceId) return false;
  if (f.kind !== undefined && e.kind !== f.kind) return false;
  if (f.from !== undefined && e.occurred_at < f.from) return false;
  if (f.to !== undefined && e.occurred_at >= f.to) return false;
  return true;
}

/** In-memory ledger for tests and the fake provider. Deterministic given a Clock. */
export class InMemoryLedger implements LedgerSink, LedgerQuery {
  readonly entries: StoredLedgerEntry[] = [];

  constructor(private readonly clock: Clock) {}

  async record(entry: LedgerEntry): Promise<StoredLedgerEntry> {
    assertMicro(entry.usd_micro, "usd_micro");
    assertMicro(entry.chf_micro, "chf_micro");
    if (!entry.human_id) {
      throw new ForerunnerError("validation", "ledger entry needs a human_id");
    }
    const stored: StoredLedgerEntry = {
      ...entry,
      id: entry.id ?? newId(this.clock.now()),
      occurred_at: entry.occurred_at || this.clock.nowIso(),
    };
    this.entries.push(stored);
    return stored;
  }

  async sum(filter: LedgerFilter = {}): Promise<LedgerSum> {
    return sumEntries(this.entries.filter((e) => matchesFilter(e, filter)));
  }

  async list(filter: LedgerFilter = {}): Promise<StoredLedgerEntry[]> {
    return this.entries
      .filter((e) => matchesFilter(e, filter))
      .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0));
  }
}
