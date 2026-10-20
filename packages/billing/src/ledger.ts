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

export interface SavingsReport {
  sessionId: string;
  compression: {
    runsMeasured: number;
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    usd_micro: number;
    chf_micro: number;
  };
  cache: {
    cacheReadTokens: number;
    usdMicroAtFullPrice: number;
    usdMicroPaid: number;
    usd_micro: number;
    chf_micro: number;
  };
  total: { usd_micro: number; chf_micro: number };
  /** Runs whose model has no price row; their tokens are counted, their money is not. */
  unpricedRuns: number;
}

export const NO_SPECIALIST = "(none)";
export const NO_TASK = "(no task)";

export interface CostLedgerOptions {
  sink: LedgerSink;
  query: LedgerQuery;
  rates: RateSource;
  clock: Clock;
  pricing?: PricingTable;
}

export class CostLedger {
  private readonly sink: LedgerSink;
  private readonly query: LedgerQuery;
  private readonly rates: RateSource;
  private readonly clock: Clock;
  readonly pricing: PricingTable;

  constructor(opts: CostLedgerOptions) {
    this.sink = opts.sink;
    this.query = opts.query;
    this.rates = opts.rates;
    this.clock = opts.clock;
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

  /** Token savings from compression and prompt caching, shown separately from spend. */
  async savings(sessionId: string): Promise<SavingsReport> {
    const entries = await this.query.list({ sessionId });
    const report: SavingsReport = {
      sessionId,
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
      total: { usd_micro: 0, chf_micro: 0 },
      unpricedRuns: 0,
    };
    for (const e of entries) {
      let inputPrice: number | null = null;
      let cacheReadPrice = 0;
      try {
        const p = priceFor(e.model, this.pricing);
        inputPrice = p.input_per_mtok_usd;
        cacheReadPrice = p.cache_read_per_mtok_usd;
      } catch {
        report.unpricedRuns += 1;
      }
      const before = e.tokens_before_compression;
      const after = e.tokens_after_compression;
      if (typeof before === "number" && typeof after === "number") {
        const saved = Math.max(before - after, 0);
        report.compression.runsMeasured += 1;
        report.compression.tokensBefore += before;
        report.compression.tokensAfter += after;
        report.compression.tokensSaved += saved;
        if (inputPrice !== null) {
          const usd = roundHalfUp(saved * inputPrice);
          report.compression.usd_micro += usd;
          report.compression.chf_micro += usdToChfMicro(usd, e.rate_chf_per_usd);
        }
      }
      report.cache.cacheReadTokens += e.cache_read_tokens;
      if (inputPrice !== null && e.cache_read_tokens > 0) {
        const usage: TokenUsage = {
          tokens_in: 0,
          tokens_out: 0,
          cache_read_tokens: e.cache_read_tokens,
        };
        const saved = cacheSavingsUsdMicro(usage, e.model, this.pricing);
        report.cache.usdMicroAtFullPrice += roundHalfUp(e.cache_read_tokens * inputPrice);
        report.cache.usdMicroPaid += roundHalfUp(e.cache_read_tokens * cacheReadPrice);
        report.cache.usd_micro += saved;
        report.cache.chf_micro += usdToChfMicro(saved, e.rate_chf_per_usd);
      }
    }
    report.total.usd_micro = report.compression.usd_micro + report.cache.usd_micro;
    report.total.chf_micro = report.compression.chf_micro + report.cache.chf_micro;
    return report;
  }
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
