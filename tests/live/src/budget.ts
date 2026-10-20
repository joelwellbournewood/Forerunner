import { BUILTIN_PRICING, costOf, type PricingTable, priceFor } from "@forerunner/billing";
import { type Clock, ForerunnerError, systemClock } from "@forerunner/platform";
import type { ModelRequest, Usage } from "@forerunner/runtime";
import { microFromUsd, type SpendLedger, type SpendRow, usdFromMicro } from "./ledger.ts";

/**
 * The live budget, enforced in code before every model call (spec I.1, I.5): the ledger total
 * plus the calls in flight plus a conservative estimate of the next call must stay under the
 * overall cap (`FORERUNNER_LIVE_BUDGET_USD`, default 100) and under the per-run cap
 * (`FORERUNNER_LIVE_RUN_CAP_USD`, default 15), so one run can never spend more than its cap
 * however many tests it holds. A warning line is printed once at 80% of either cap. A refused
 * call is a `LiveBudgetError` naming the reason and the ledger total; nothing is sent.
 *
 * The estimate is the hooks' shape made one notch more conservative: the whole input (the
 * adapter's local token count of system, messages and tools) at the dearest input rate the
 * table knows for the model (the cache-write price, 1.25x the input price) plus `max_tokens`
 * at the output price. Actual usage replaces it in the ledger after the call. The bound on an
 * overshoot is therefore one call's under-estimate from the local token count (a heuristic,
 * about four characters per token) against what the provider bills; see testing.md, "Live
 * runs", Known issues.
 */
export const BUDGET_VAR = "FORERUNNER_LIVE_BUDGET_USD";
export const RUN_CAP_VAR = "FORERUNNER_LIVE_RUN_CAP_USD";
export const DEFAULT_BUDGET_USD = 100;
export const DEFAULT_RUN_CAP_USD = 15;
export const WARN_SHARE = 0.8;

export interface LiveBudgetConfig {
  capUsd: number;
  runCapUsd: number;
  /** Share of a cap at which the warning line is printed once. */
  warnShare: number;
}

function positiveNumber(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ForerunnerError(
      "validation",
      `${name} must be a positive number of USD, got "${raw}"`,
    );
  }
  return n;
}

export function budgetConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveBudgetConfig {
  const capUsd = positiveNumber(env[BUDGET_VAR], BUDGET_VAR, DEFAULT_BUDGET_USD);
  const runCapUsd = positiveNumber(env[RUN_CAP_VAR], RUN_CAP_VAR, DEFAULT_RUN_CAP_USD);
  return { capUsd, runCapUsd: Math.min(runCapUsd, capUsd), warnShare: WARN_SHARE };
}

export interface Reservation {
  id: number;
  model: string;
  estimateUsdMicro: number;
  startedAt: string;
}

export interface BudgetSnapshot {
  capUsd: number;
  runCapUsd: number;
  /** Everything in the ledger, every run. */
  ledgerUsd: number;
  /** This run's rows in the ledger. */
  runUsd: number;
  /** Estimates of the calls started and not yet settled. */
  inFlightUsd: number;
  remainingUsd: number;
  remainingRunUsd: number;
  warnedCap: boolean;
  warnedRun: boolean;
}

export interface BudgetDecision {
  allowed: boolean;
  reason: string | null;
  estimateUsd: number;
  snapshot: BudgetSnapshot;
}

export interface Refusal {
  at: string;
  model: string;
  estimateUsd: number;
  reason: string;
  snapshot: BudgetSnapshot;
}

export class LiveBudgetError extends ForerunnerError {
  constructor(
    readonly decision: BudgetDecision,
    readonly model: string,
  ) {
    super("budget_exceeded", `live budget refused a call on ${model}: ${decision.reason}`, {
      retryable: false,
      details: {
        model,
        estimateUsd: decision.estimateUsd,
        ledgerUsd: decision.snapshot.ledgerUsd,
        runUsd: decision.snapshot.runUsd,
        capUsd: decision.snapshot.capUsd,
        runCapUsd: decision.snapshot.runCapUsd,
      },
    });
    this.name = "LiveBudgetError";
  }
}

export interface LiveBudgetOptions {
  ledger: SpendLedger;
  run: string;
  config: LiveBudgetConfig;
  pricing?: PricingTable;
  clock?: Clock;
  /** Receives the 80% warning lines; default `console.warn`. */
  onWarn?: (line: string) => void;
}

const fmt = (usd: number): string => `USD ${usd.toFixed(4)}`;

export class LiveBudget {
  readonly refusals: Refusal[] = [];
  private readonly inFlight = new Map<number, Reservation>();
  private nextId = 1;
  private warnedCap = false;
  private warnedRun = false;
  private readonly clock: Clock;
  private readonly pricing: PricingTable;
  private readonly onWarn: (line: string) => void;

  constructor(private readonly opts: LiveBudgetOptions) {
    this.clock = opts.clock ?? systemClock;
    this.pricing = opts.pricing ?? BUILTIN_PRICING;
    this.onWarn = opts.onWarn ?? ((line) => console.warn(line));
  }

  get run(): string {
    return this.opts.run;
  }

  get config(): LiveBudgetConfig {
    return this.opts.config;
  }

  get ledger(): SpendLedger {
    return this.opts.ledger;
  }

  private inFlightMicro(): number {
    let sum = 0;
    for (const r of this.inFlight.values()) sum += r.estimateUsdMicro;
    return sum;
  }

  snapshot(): BudgetSnapshot {
    const rows = this.opts.ledger.rows();
    const ledgerMicro = rows.reduce((s, r) => s + microFromUsd(r.usd), 0);
    const runMicro = rows
      .filter((r) => r.run === this.opts.run)
      .reduce((s, r) => s + microFromUsd(r.usd), 0);
    const inFlightMicro = this.inFlightMicro();
    const { capUsd, runCapUsd } = this.opts.config;
    return {
      capUsd,
      runCapUsd,
      ledgerUsd: usdFromMicro(ledgerMicro),
      runUsd: usdFromMicro(runMicro),
      inFlightUsd: usdFromMicro(inFlightMicro),
      remainingUsd: usdFromMicro(microFromUsd(capUsd) - ledgerMicro - inFlightMicro),
      remainingRunUsd: usdFromMicro(microFromUsd(runCapUsd) - runMicro - inFlightMicro),
      warnedCap: this.warnedCap,
      warnedRun: this.warnedRun,
    };
  }

  /**
   * The conservative pre-call estimate of a request, in micro-USD (unknown model: throws):
   * every input token at the model's cache-write price (its dearest input rate; a cached
   * prefix is billed at that rate the first time it is written) plus `max_tokens` at the
   * output price.
   */
  estimateFor(req: ModelRequest, countTokens: (text: string) => number): number {
    const inputTokens = countTokens(
      `${req.system ?? ""}${JSON.stringify(req.messages)}${JSON.stringify(req.tools ?? [])}`,
    );
    const p = priceFor(req.model, this.pricing);
    const inputRate = Math.max(p.input_per_mtok_usd, p.cache_write_per_mtok_usd);
    // tokens x USD per MTok is micro-USD exactly (1e6 micro per USD over 1e6 tokens per MTok)
    return Math.round(inputTokens * inputRate + req.max_tokens * p.output_per_mtok_usd);
  }

  /** The decision for a call of this estimate, without taking a reservation. */
  decide(estimateMicro: number, model: string): BudgetDecision {
    const snapshot = this.snapshot();
    const estimateUsd = usdFromMicro(estimateMicro);
    const afterCap = usdFromMicro(
      microFromUsd(snapshot.ledgerUsd) + microFromUsd(snapshot.inFlightUsd) + estimateMicro,
    );
    const afterRun = usdFromMicro(
      microFromUsd(snapshot.runUsd) + microFromUsd(snapshot.inFlightUsd) + estimateMicro,
    );
    let reason: string | null = null;
    if (afterCap > snapshot.capUsd) {
      reason =
        `a call on ${model} estimated at ${fmt(estimateUsd)} would take the ledger to ${fmt(afterCap)}, ` +
        `over the live budget of ${fmt(snapshot.capUsd)} (ledger total ${fmt(snapshot.ledgerUsd)}, ` +
        `in flight ${fmt(snapshot.inFlightUsd)}, this run ${fmt(snapshot.runUsd)})`;
    } else if (afterRun > snapshot.runCapUsd) {
      reason =
        `a call on ${model} estimated at ${fmt(estimateUsd)} would take this run to ${fmt(afterRun)}, ` +
        `over the per-run cap of ${fmt(snapshot.runCapUsd)} (this run ${fmt(snapshot.runUsd)}, ` +
        `in flight ${fmt(snapshot.inFlightUsd)}, ledger total ${fmt(snapshot.ledgerUsd)})`;
    }
    return { allowed: reason === null, reason, estimateUsd, snapshot };
  }

  /** Take a reservation for a call, or throw `LiveBudgetError` (and record the refusal). */
  reserve(estimateMicro: number, model: string): Reservation {
    const decision = this.decide(estimateMicro, model);
    if (!decision.allowed) {
      this.refusals.push({
        at: this.clock.nowIso(),
        model,
        estimateUsd: decision.estimateUsd,
        reason: decision.reason ?? "refused",
        snapshot: decision.snapshot,
      });
      throw new LiveBudgetError(decision, model);
    }
    this.warnIfNeeded(decision);
    const reservation: Reservation = {
      id: this.nextId++,
      model,
      estimateUsdMicro: Math.max(0, Math.round(estimateMicro)),
      startedAt: this.clock.nowIso(),
    };
    this.inFlight.set(reservation.id, reservation);
    return reservation;
  }

  private warnIfNeeded(decision: BudgetDecision): void {
    const { snapshot, estimateUsd } = decision;
    const { warnShare } = this.opts.config;
    const afterCap = snapshot.ledgerUsd + snapshot.inFlightUsd + estimateUsd;
    const afterRun = snapshot.runUsd + snapshot.inFlightUsd + estimateUsd;
    if (!this.warnedCap && afterCap >= warnShare * snapshot.capUsd) {
      this.warnedCap = true;
      this.onWarn(
        `live budget warning: ${Math.round(warnShare * 100)}% of the live budget reached ` +
          `(${fmt(afterCap)} of ${fmt(snapshot.capUsd)} with the next call); finish the current work, start nothing new`,
      );
    }
    if (!this.warnedRun && afterRun >= warnShare * snapshot.runCapUsd) {
      this.warnedRun = true;
      this.onWarn(
        `live budget warning: ${Math.round(warnShare * 100)}% of the per-run cap reached ` +
          `(${fmt(afterRun)} of ${fmt(snapshot.runCapUsd)} with the next call)`,
      );
    }
  }

  /**
   * Settle a call: price the usage the provider reported (nothing when it reported none),
   * append the row to the ledger and release the reservation. Called after every call, also
   * after a failure or an abort, so the ledger never misses a billed call that answered.
   */
  settle(
    reservation: Reservation,
    usage: Usage | null,
    opts: { model?: string; requestedModel?: string; note?: string } = {},
  ): SpendRow {
    this.inFlight.delete(reservation.id);
    const model = opts.model ?? reservation.model;
    const u: Usage = usage ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const tokens = {
      tokens_in: u.input_tokens,
      tokens_out: u.output_tokens,
      cache_read_tokens: u.cache_read_input_tokens,
      cache_write_tokens: u.cache_creation_input_tokens,
    };
    // Priced at the id the provider answered with; a snapshot id the table does not know falls
    // back to the id that was requested. An unknown model is an error, never a silent zero.
    let micro: number;
    try {
      micro = costOf(tokens, model, this.pricing);
    } catch (e) {
      const requested = opts.requestedModel ?? reservation.model;
      if (requested === model) throw e;
      micro = costOf(tokens, requested, this.pricing);
    }
    const row: SpendRow = {
      date: this.clock.nowIso().slice(0, 10),
      run: this.opts.run,
      model,
      tokensIn: u.input_tokens,
      tokensOut: u.output_tokens,
      cacheRead: u.cache_read_input_tokens,
      cacheWrite: u.cache_creation_input_tokens,
      usd: usdFromMicro(micro),
    };
    const note = [usage ? null : "no usage reported", opts.note ?? null]
      .filter((s): s is string => !!s)
      .join("; ");
    if (note) row.note = note;
    this.opts.ledger.append(row);
    return row;
  }

  /** Release a reservation without a ledger row (the call never reached the provider). */
  release(reservation: Reservation): void {
    this.inFlight.delete(reservation.id);
  }
}

/** One line for logs and the report: the ledger and run totals against the caps. */
export function budgetLine(b: LiveBudget): string {
  const s = b.snapshot();
  return (
    `live budget: ledger ${fmt(s.ledgerUsd)} of ${fmt(s.capUsd)}, this run ${fmt(s.runUsd)} of ` +
    `${fmt(s.runCapUsd)} (in flight ${fmt(s.inFlightUsd)}, refusals ${b.refusals.length})`
  );
}
