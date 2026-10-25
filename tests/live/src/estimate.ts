import { BUILTIN_PRICING, type PricingTable, priceFor } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { BudgetDecision, LiveBudget } from "./budget.ts";
import { microFromUsd, usdFromMicro } from "./ledger.ts";

/**
 * The pre-run estimate of a live file: what its planned calls should cost, priced from the
 * billing table the ledger uses, and the ceiling the hooks enforce on it (the session caps
 * and review budgets the file sets). The ceiling, not the expectation, is checked against what
 * the ledger has left before the first call: a file whose worst case does not fit under the
 * live budget and the per-run cap refuses to start (`preflight`), so a run never begins work
 * it may not be allowed to finish. The per-call gate in `MeteredProvider` still applies to
 * every call after that.
 *
 * The expectation prices each planned call the way `LiveBudget.estimateFor` prices a request
 * (every input token at the model's dearest input rate, the cache-write price, and the output
 * at the output price), with the planned output instead of `max_tokens`.
 */
export interface PlannedCalls {
  label: string;
  model: string;
  calls: number;
  /** Input tokens per call (system, messages, tools). */
  inputTokens: number;
  /** Expected output tokens per call (thinking included). */
  outputTokens: number;
}

export interface SpendEstimate {
  label: string;
  /** What the planned calls should cost, USD. */
  expectedUsd: number;
  /** The most the hooks let the file spend, USD (session caps, review budgets). */
  ceilingUsd: number;
  planned: (PlannedCalls & { usd: number })[];
}

/** Micro-USD of one planned call shape (all its calls). Unknown model: throws. */
export function plannedMicro(p: PlannedCalls, pricing: PricingTable = BUILTIN_PRICING): number {
  const price = priceFor(p.model, pricing);
  const inputRate = Math.max(price.input_per_mtok_usd, price.cache_write_per_mtok_usd);
  // tokens x USD per MTok is micro-USD exactly
  return Math.round(
    p.calls * (p.inputTokens * inputRate + p.outputTokens * price.output_per_mtok_usd),
  );
}

export function estimateSpend(
  label: string,
  planned: readonly PlannedCalls[],
  ceilingUsd: number,
  pricing: PricingTable = BUILTIN_PRICING,
): SpendEstimate {
  const rows = planned.map((p) => ({ ...p, usd: usdFromMicro(plannedMicro(p, pricing)) }));
  const expectedMicro = rows.reduce((s, r) => s + microFromUsd(r.usd), 0);
  return {
    label,
    expectedUsd: usdFromMicro(expectedMicro),
    ceilingUsd: Math.max(ceilingUsd, usdFromMicro(expectedMicro)),
    planned: rows,
  };
}

const fmt = (usd: number): string => `USD ${usd.toFixed(4)}`;

/** One line for the test output: the expectation, the ceiling and what each planned shape costs. */
export function estimateLine(e: SpendEstimate): string {
  const parts = e.planned.map(
    (p) =>
      `${p.label}: ${p.calls} x ${p.model} (${p.inputTokens} in, ${p.outputTokens} out) ${fmt(p.usd)}`,
  );
  return (
    `cost estimate (${e.label}): expected ${fmt(e.expectedUsd)}, ceiling ${fmt(e.ceilingUsd)} ` +
    `[${parts.join("; ")}]`
  );
}

export interface PreflightResult {
  estimate: SpendEstimate;
  decision: BudgetDecision;
  line: string;
}

/**
 * Check the estimate's ceiling against the ledger and the run before any call: refused (a
 * `budget_exceeded` error naming both totals) when the ceiling would take the ledger over the
 * live budget or this run over its cap. No reservation is taken and nothing is recorded as a
 * refusal of a call; the file simply does not start.
 */
export function preflight(budget: LiveBudget, estimate: SpendEstimate): PreflightResult {
  const decision = budget.decide(microFromUsd(estimate.ceilingUsd), `preflight:${estimate.label}`);
  const s = decision.snapshot;
  const left = Math.min(s.remainingUsd, s.remainingRunUsd);
  const line =
    `${estimateLine(estimate)}; left: ${fmt(s.remainingUsd)} of the live budget, ` +
    `${fmt(s.remainingRunUsd)} of the per-run cap`;
  if (!decision.allowed) {
    throw new ForerunnerError(
      "budget_exceeded",
      `${estimate.label} refused to start: its ceiling of ${fmt(estimate.ceilingUsd)} exceeds what is left ` +
        `(${fmt(left)}; ledger ${fmt(s.ledgerUsd)} of ${fmt(s.capUsd)}, this run ${fmt(s.runUsd)} of ${fmt(s.runCapUsd)})`,
      {
        retryable: false,
        details: {
          label: estimate.label,
          expectedUsd: estimate.expectedUsd,
          ceilingUsd: estimate.ceilingUsd,
          remainingUsd: s.remainingUsd,
          remainingRunUsd: s.remainingRunUsd,
        },
      },
    );
  }
  return { estimate, decision, line };
}
