/**
 * The cost ledger: records every charge with USD, CHF at the day's rate and what it was for,
 * and answers the questions the caps, the allocation view and the savings view ask.
 *
 * Subscription usage has no per-token price. Its entries carry the estimated API-equivalent
 * in usd_micro with kind "subscription" so the UI can label them "plan usage, est.
 * API-equivalent"; the plan share itself is in plan_usage_share.
 */
import type { Clock } from "@forerunner/platform";
import { ForerunnerError } from "@forerunner/platform";
import { assertMicro, roundHalfUp, usdToChfMicro } from "./money.ts";
import {
  BUILTIN_PRICING,
  cacheSavingsUsdMicro,
  compressionSavingsUsdMicro,
  costOf,
  type PricingTable,
  priceFor,
  type TokenUsage,
} from "./pricing.ts";
import type { RateQuote, RateSource } from "./rates.ts";
import {
  type LedgerEntry,
  type LedgerFilter,
  type LedgerQuery,
  type LedgerSink,
  type LedgerSum,
  type StoredLedgerEntry,
  sumEntries,
} from "./sink.ts";
import { type BillingSource, type CostKind, isEstimatedKind, ledgerKindFor } from "./sources.ts";

export interface CostScope {
  humanId: string;
  agentId?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
}

export interface RecordInput {
  usage: TokenUsage;
  model: string;
  source: BillingSource;
  scope: CostScope;
  specialist?: string;
  /** Plan usage share after this call (subscriptions), 0..1. */
  planUsageShare?: number;
  /** Defaults to the clock. */
  occurredAt?: string;
  tokensBeforeCompression?: number;
  tokensAfterCompression?: number;
  /** When the provider reports an exact charge it wins over the pricing table. */
  usdMicroActual?: number;
}

export interface RecordedCost {
  entry: StoredLedgerEntry;
  rate: RateQuote;
  /** True for subscription entries: usd_micro is an API-equivalent estimate. */
  estimated: boolean;
}

export interface KindTotals {
  usd_micro: number;
  chf_micro: number;
  entries: number;
}

export interface CostTotals extends LedgerSum {
  byKind: Record<CostKind, KindTotals>;
}

export type TaskOutcome = "accepted" | "rejected" | "open";
export type TaskOutcomeLookup = (
  taskId: string,
) => TaskOutcome | undefined | Promise<TaskOutcome | undefined>;

export interface AllocationBucket {
  key: string;
  usd_micro: number;
  chf_micro: number;
  runs: number;
  tokens_in: number;
  tokens_out: number;
  tasks: number;
  acceptedTasks: number;
  rejectedTasks: number;
  openTasks: number;
  /** accepted / (accepted + rejected); null until a task is decided. */
  successRate: number | null;
  /** usd_micro / acceptedTasks; null without an accepted task. */
  costPerAcceptedTaskUsdMicro: number | null;
}

export interface AllocationReport {
  projectId: string;
  from?: string;
  to?: string;
  total: LedgerSum;
  bySpecialist: AllocationBucket[];
  byModel: AllocationBucket[];
  byTask: AllocationBucket[];
}

/** Which runs and sessions a savings report covers; the same keys as the ledger filter. */
export type SavingsFilter = Pick<
  LedgerFilter,
  "humanId" | "agentId" | "projectId" | "sessionId" | "taskId" | "runId" | "from" | "to"
>;

/**
 * One Run as the savings view reads it (the state package's `run` table, ADR 0003 section 3).
 * Savings are fields on the Run, never ledger rows; the ledger only supplies the day's rate.
 */
export interface SavingsRun {
  run_id: string;
  session_id?: string | null;
  project_id?: string | null;
  task_id?: string | null;
  specialist?: string | null;
  model: string;
  /** Request size with no transforms (estimated) and as sent, counted the same way. */
  tokens_before_compression: number;
  tokens_after_compression: number;
  cache_read_tokens: number;
  cache_write_tokens?: number;
  context_transforms?: string[];
  headroom_used?: boolean;
  /** The run's own CHF rate when the source knows it; else the run's ledger entry supplies it. */
  rate_chf_per_usd?: number | null;
  /** When the run happened; runs with neither a rate nor a ledger entry are quoted for this day. */
  occurred_at?: string | null;
}

export interface SavingsSession {
  session_id: string;
  project_id?: string | null;
  /** Headroom proxy `/stats` tokens_saved delta over the session (0 when it was not used). */
  headroom_saved_tokens: number;
}

/** Where the Run rows come from. The runtime adapts the state store; tests use the ledger entries. */
export interface RunSource {
  listRuns(filter: SavingsFilter): Promise<SavingsRun[]>;
}

export interface SessionSource {
  listSessions(filter: SavingsFilter): Promise<SavingsSession[]>;
}

export interface SavingsMoney {
  usd_micro: number;
  chf_micro: number;
}

/** Savings allocated to one project, specialist or model (ADR 0003: the same Run fields, summed). */
export interface SavingsBucket {
  key: string;
  runs: number;
  compressionTokens: number;
  cacheReadTokens: number;
  compression: SavingsMoney;
  cache: SavingsMoney;
  total: SavingsMoney;
}

export interface SavingsReport {
  filter: SavingsFilter;
  /** "Saved by compression (estimated)": tokens_before - tokens_after at the input price. */
  compression: {
    runsMeasured: number;
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    usd_micro: number;
    chf_micro: number;
  };
  /** "Saved by caching (measured)": cache reads at input price minus cache read price. */
  cache: {
    cacheReadTokens: number;
    usdMicroAtFullPrice: number;
    usdMicroPaid: number;
    usd_micro: number;
    chf_micro: number;
  };
  /** Cache writes cost 1.25x the input price; shown beside the reads, never netted. */
  cacheWriteTokens: number;
  /** "Saved by Headroom": the proxy's own count per session, in tokens (a session spans models). */
  headroom: { runs: number; sessions: number; tokensSaved: number };
  total: SavingsMoney;
  /** Runs whose model has no price row; their tokens are counted, their money is not. */
  unpricedRuns: number;
  /** How often each context transform was applied across the measured runs. */
  transforms: Record<string, number>;
  byProject: SavingsBucket[];
  bySpecialist: SavingsBucket[];
  byModel: SavingsBucket[];
}

export const NO_SPECIALIST = "(none)";
export const NO_TASK = "(no task)";
export const NO_PROJECT = "(no project)";

export interface CostLedgerOptions {
  sink: LedgerSink;
  query: LedgerQuery;
  rates: RateSource;
  clock: Clock;
  pricing?: PricingTable;
  /** Run rows for savings(); without it the ledger entries stand in (tests, in-memory). */
  runs?: RunSource;
  /** Session rows for the Headroom line of savings(); optional. */
  sessions?: SessionSource;
}

export class CostLedger {
  private readonly sink: LedgerSink;
  private readonly query: LedgerQuery;
  private readonly rates: RateSource;
  private readonly clock: Clock;
  private readonly runs: RunSource | undefined;
  private readonly sessions: SessionSource | undefined;
  readonly pricing: PricingTable;

  constructor(opts: CostLedgerOptions) {
    this.sink = opts.sink;
    this.query = opts.query;
    this.rates = opts.rates;
    this.clock = opts.clock;
    this.runs = opts.runs;
    this.sessions = opts.sessions;
    this.pricing = opts.pricing ?? BUILTIN_PRICING;
  }

  async record(input: RecordInput): Promise<RecordedCost> {
    if (input.source.humanId !== input.scope.humanId) {
      throw new ForerunnerError("validation", "billing source belongs to a different human", {
        details: { sourceId: input.source.id },
      });
    }
    const occurredAt = input.occurredAt ?? this.clock.nowIso();
    const usd =
      input.usdMicroActual !== undefined
        ? assertMicro(input.usdMicroActual, "usdMicroActual")
        : costOf(input.usage, input.model, this.pricing);
    const rate = await this.rates.quote(occurredAt);
    const chf = usdToChfMicro(usd, rate.chfPerUsd);
    const entry: LedgerEntry = {
      human_id: input.scope.humanId,
      agent_id: input.scope.agentId ?? null,
      project_id: input.scope.projectId ?? null,
      session_id: input.scope.sessionId ?? null,
      task_id: input.scope.taskId ?? null,
      run_id: input.scope.runId ?? null,
      billing_source_id: input.source.id,
      kind: ledgerKindFor(input.source.kind),
      usd_micro: usd,
      chf_micro: chf,
      rate_chf_per_usd: rate.chfPerUsd,
      plan_usage_share: input.planUsageShare ?? null,
      model: input.model,
      specialist: input.specialist ?? null,
      tokens_in: input.usage.tokens_in,
      tokens_out: input.usage.tokens_out,
      cache_read_tokens: input.usage.cache_read_tokens ?? 0,
      cache_write_tokens: input.usage.cache_write_tokens ?? 0,
      tokens_before_compression: input.tokensBeforeCompression ?? null,
      tokens_after_compression: input.tokensAfterCompression ?? null,
      occurred_at: occurredAt,
    };
    const stored = await this.sink.record(entry);
    return { entry: stored, rate, estimated: isEstimatedKind(input.source.kind) };
  }

  /** Sums for any combination of human, project, session, task, run and time window. */
  async totals(filter: LedgerFilter): Promise<CostTotals> {
    const total = await this.query.sum(filter);
    const byKind = {} as Record<CostKind, KindTotals>;
    for (const kind of ["api", "subscription", "plan_credits"] as const) {
      const s = await this.query.sum({ ...filter, kind });
      byKind[kind] = { usd_micro: s.usd_micro, chf_micro: s.chf_micro, entries: s.entries };
    }
    return { ...total, byKind };
  }

  /** This human's spend in the current UTC calendar month. */
  async monthTotals(humanId: string): Promise<CostTotals> {
    return this.totals({ humanId, ...monthWindow(this.clock.now()) });
  }

  /** Spend by specialist, model and task with success rate and cost per accepted task. */
  async allocation(
    opts: { projectId: string; from?: string; to?: string },
    outcomes: TaskOutcomeLookup,
  ): Promise<AllocationReport> {
    const filter: LedgerFilter = { projectId: opts.projectId };
    if (opts.from) filter.from = opts.from;
    if (opts.to) filter.to = opts.to;
    const entries = await this.query.list(filter);

    const outcomeCache = new Map<string, TaskOutcome>();
    const outcomeOf = async (taskId: string): Promise<TaskOutcome> => {
      const hit = outcomeCache.get(taskId);
      if (hit) return hit;
      const o = (await outcomes(taskId)) ?? "open";
      outcomeCache.set(taskId, o);
      return o;
    };

    const bySpecialist = await buildBuckets(
      entries,
      (e) => e.specialist ?? NO_SPECIALIST,
      outcomeOf,
    );
    const byModel = await buildBuckets(entries, (e) => e.model, outcomeOf);
    const byTask = await buildBuckets(entries, (e) => e.task_id ?? NO_TASK, outcomeOf);
    const report: AllocationReport = {
      projectId: opts.projectId,
      total: sumEntries(entries),
      bySpecialist,
      byModel,
      byTask,
    };
    if (opts.from) report.from = opts.from;
    if (opts.to) report.to = opts.to;
    return report;
  }

  /**
   * Token savings from compression (estimated), prompt caching (measured) and the Headroom
   * proxy, priced at read time from the Run rows (ADR 0003 section 3): saved tokens x the
   * model's input price in usd_micro, CHF at the rate of the run's own ledger entry, each
   * rounded half-up once (ADR 0008) and summed as integers. Never netted against spend.
   * A plain string is a session id.
   */
  async savings(input: SavingsFilter | string): Promise<SavingsReport> {
    const filter: SavingsFilter = typeof input === "string" ? { sessionId: input } : { ...input };
    const entries = await this.query.list(filter);
    const entryByRun = new Map<string, StoredLedgerEntry>();
    for (const e of entries) {
      if (e.run_id && !entryByRun.has(e.run_id)) entryByRun.set(e.run_id, e);
    }
    const runs = this.runs ? await this.runs.listRuns(filter) : entriesAsRuns(entries);
    const sessions = this.sessions ? await this.sessions.listSessions(filter) : [];

    const report: SavingsReport = {
      filter,
      compression: {
        runsMeasured: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        tokensSaved: 0,
        usd_micro: 0,
        chf_micro: 0,
      },
      cache: {
        cacheReadTokens: 0,
        usdMicroAtFullPrice: 0,
        usdMicroPaid: 0,
        usd_micro: 0,
        chf_micro: 0,
      },
      cacheWriteTokens: 0,
      headroom: { runs: 0, sessions: sessions.length, tokensSaved: 0 },
      total: { usd_micro: 0, chf_micro: 0 },
      unpricedRuns: 0,
      transforms: {},
      byProject: [],
      bySpecialist: [],
      byModel: [],
    };
    const buckets = {
      byProject: new Map<string, SavingsBucket>(),
      bySpecialist: new Map<string, SavingsBucket>(),
      byModel: new Map<string, SavingsBucket>(),
    };
    for (const run of runs) {
      const entry = entryByRun.get(run.run_id);
      const rate =
        run.rate_chf_per_usd ??
        entry?.rate_chf_per_usd ??
        (await this.rates.quote(run.occurred_at ?? entry?.occurred_at ?? this.clock.nowIso()))
          .chfPerUsd;
      let inputPrice: number | null = null;
      let cacheReadPrice = 0;
      try {
        const p = priceFor(run.model, this.pricing);
        inputPrice = p.input_per_mtok_usd;
        cacheReadPrice = p.cache_read_per_mtok_usd;
      } catch {
        report.unpricedRuns += 1;
      }
      const before = Math.max(0, run.tokens_before_compression);
      const after = Math.max(0, run.tokens_after_compression);
      const saved = Math.max(before - after, 0);
      const compression: SavingsMoney = { usd_micro: 0, chf_micro: 0 };
      if (before > 0) {
        report.compression.runsMeasured += 1;
        report.compression.tokensBefore += before;
        report.compression.tokensAfter += after;
        report.compression.tokensSaved += saved;
        if (inputPrice !== null) {
          compression.usd_micro = compressionSavingsUsdMicro(saved, run.model, this.pricing);
          compression.chf_micro = usdToChfMicro(compression.usd_micro, rate);
          report.compression.usd_micro += compression.usd_micro;
          report.compression.chf_micro += compression.chf_micro;
        }
      }
      const reads = Math.max(0, run.cache_read_tokens);
      report.cache.cacheReadTokens += reads;
      report.cacheWriteTokens += Math.max(0, run.cache_write_tokens ?? 0);
      const cache: SavingsMoney = { usd_micro: 0, chf_micro: 0 };
      if (inputPrice !== null && reads > 0) {
        const usage: TokenUsage = { tokens_in: 0, tokens_out: 0, cache_read_tokens: reads };
        cache.usd_micro = cacheSavingsUsdMicro(usage, run.model, this.pricing);
        cache.chf_micro = usdToChfMicro(cache.usd_micro, rate);
        report.cache.usdMicroAtFullPrice += roundHalfUp(reads * inputPrice);
        report.cache.usdMicroPaid += roundHalfUp(reads * cacheReadPrice);
        report.cache.usd_micro += cache.usd_micro;
        report.cache.chf_micro += cache.chf_micro;
      }
      for (const name of run.context_transforms ?? [])
        report.transforms[name] = (report.transforms[name] ?? 0) + 1;
      if (run.headroom_used) report.headroom.runs += 1;
      const contribution = { saved, reads, compression, cache };
      addToBucket(
        buckets.byProject,
        run.project_id ?? entry?.project_id ?? NO_PROJECT,
        contribution,
      );
      addToBucket(
        buckets.bySpecialist,
        run.specialist ?? entry?.specialist ?? NO_SPECIALIST,
        contribution,
      );
      addToBucket(buckets.byModel, run.model, contribution);
    }
    for (const s of sessions) report.headroom.tokensSaved += Math.max(0, s.headroom_saved_tokens);
    report.total.usd_micro = report.compression.usd_micro + report.cache.usd_micro;
    report.total.chf_micro = report.compression.chf_micro + report.cache.chf_micro;
    report.byProject = sortBuckets(buckets.byProject);
    report.bySpecialist = sortBuckets(buckets.bySpecialist);
    report.byModel = sortBuckets(buckets.byModel);
    return report;
  }
}

/**
 * Ledger entries as Run rows, for a ledger without a RunSource (the in-memory sink): entries
 * of one run are folded together, cache tokens summed, the first measured compression kept.
 */
export function entriesAsRuns(entries: Iterable<StoredLedgerEntry>): SavingsRun[] {
  const byRun = new Map<string, SavingsRun>();
  for (const e of entries) {
    const id = e.run_id ?? e.id;
    const before = e.tokens_before_compression ?? 0;
    const after = e.tokens_after_compression ?? 0;
    const existing = byRun.get(id);
    if (!existing) {
      byRun.set(id, {
        run_id: id,
        session_id: e.session_id ?? null,
        project_id: e.project_id ?? null,
        task_id: e.task_id ?? null,
        specialist: e.specialist ?? null,
        model: e.model,
        tokens_before_compression: before,
        tokens_after_compression: after,
        cache_read_tokens: e.cache_read_tokens,
        cache_write_tokens: e.cache_write_tokens,
        rate_chf_per_usd: e.rate_chf_per_usd,
        occurred_at: e.occurred_at,
      });
      continue;
    }
    existing.cache_read_tokens += e.cache_read_tokens;
    existing.cache_write_tokens = (existing.cache_write_tokens ?? 0) + e.cache_write_tokens;
    if (existing.tokens_before_compression === 0 && before > 0) {
      existing.tokens_before_compression = before;
      existing.tokens_after_compression = after;
    }
  }
  return [...byRun.values()];
}

function addToBucket(
  map: Map<string, SavingsBucket>,
  key: string,
  c: { saved: number; reads: number; compression: SavingsMoney; cache: SavingsMoney },
): void {
  let b = map.get(key);
  if (!b) {
    b = {
      key,
      runs: 0,
      compressionTokens: 0,
      cacheReadTokens: 0,
      compression: { usd_micro: 0, chf_micro: 0 },
      cache: { usd_micro: 0, chf_micro: 0 },
      total: { usd_micro: 0, chf_micro: 0 },
    };
    map.set(key, b);
  }
  b.runs += 1;
  b.compressionTokens += c.saved;
  b.cacheReadTokens += c.reads;
  b.compression.usd_micro += c.compression.usd_micro;
  b.compression.chf_micro += c.compression.chf_micro;
  b.cache.usd_micro += c.cache.usd_micro;
  b.cache.chf_micro += c.cache.chf_micro;
  b.total.usd_micro = b.compression.usd_micro + b.cache.usd_micro;
  b.total.chf_micro = b.compression.chf_micro + b.cache.chf_micro;
}

function sortBuckets(map: Map<string, SavingsBucket>): SavingsBucket[] {
  return [...map.values()].sort(
    (a, b) => b.total.usd_micro - a.total.usd_micro || (a.key < b.key ? -1 : 1),
  );
}

/** UTC calendar month containing `nowMs`: from inclusive, to exclusive. */
export function monthWindow(nowMs: number): { from: string; to: string } {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    from: new Date(Date.UTC(y, m, 1)).toISOString(),
    to: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
  };
}

async function buildBuckets(
  entries: StoredLedgerEntry[],
  keyOf: (e: StoredLedgerEntry) => string,
  outcomeOf: (taskId: string) => Promise<TaskOutcome>,
): Promise<AllocationBucket[]> {
  const groups = new Map<string, { entries: StoredLedgerEntry[]; tasks: Set<string> }>();
  for (const e of entries) {
    const key = keyOf(e);
    let g = groups.get(key);
    if (!g) {
      g = { entries: [], tasks: new Set() };
      groups.set(key, g);
    }
    g.entries.push(e);
    if (e.task_id) g.tasks.add(e.task_id);
  }
  const buckets: AllocationBucket[] = [];
  for (const [key, g] of groups) {
    const s = sumEntries(g.entries);
    let accepted = 0;
    let rejected = 0;
    let open = 0;
    for (const taskId of g.tasks) {
      const o = await outcomeOf(taskId);
      if (o === "accepted") accepted += 1;
      else if (o === "rejected") rejected += 1;
      else open += 1;
    }
    const decided = accepted + rejected;
    buckets.push({
      key,
      usd_micro: s.usd_micro,
      chf_micro: s.chf_micro,
      runs: s.entries,
      tokens_in: s.tokens_in,
      tokens_out: s.tokens_out,
      tasks: g.tasks.size,
      acceptedTasks: accepted,
      rejectedTasks: rejected,
      openTasks: open,
      successRate: decided > 0 ? accepted / decided : null,
      costPerAcceptedTaskUsdMicro: accepted > 0 ? roundHalfUp(s.usd_micro / accepted) : null,
    });
  }
  return buckets.sort((a, b) => b.usd_micro - a.usd_micro || (a.key < b.key ? -1 : 1));
}
