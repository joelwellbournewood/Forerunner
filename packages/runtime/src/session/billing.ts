import type { BillingSource, RouteSkip } from "@forerunner/billing";
import type { SpecialistDriver } from "../registry/tools.ts";

/**
 * Per-task billing (ADR 0044): which of the human's sources pays for one specialist run and,
 * from that, which driver runs it. The executor asks the port once per task, before the Run
 * row is written; the pick is recorded on the row (`billing_source_id`) and as an audit row
 * (`billing.pick`) with the router's reason. The wiring (`src/wiring/billing-pick.ts`)
 * implements the port over `BillingRouter.pick` from `@forerunner/billing`.
 */
export const BILLING_PICK_AUDIT_TOOL = "billing.pick";

export interface TaskBillingRequest {
  agentId: string;
  /** The agent's owner: a subscription is only ever used for its owner's agent (spec, Security). */
  agentOwnerHumanId: string;
  /** Where the session runs; the daemon's sessions run on the PC. */
  runner: "pc" | "cloud";
  /** The ladder tier the run starts on (a `kindsForTier` policy may exclude kinds). */
  modelTier: string;
  purpose?: "session" | "batch" | "critic";
}

/** Plan usage of a subscription source as the pick saw it, and what moves it. */
export interface PlanUsage {
  /** Share of the plan limit (0..1) consumed this month; null when nothing reports one. */
  share: number | null;
  /** This month's "subscription" rows for the source, API-equivalent usd_micro. */
  monthUsdMicro: number;
  /** The plan's allowance (`limits.planUsdMicro`); null when the source does not say. */
  allowanceUsdMicro: number | null;
  /** The share at which the caps stop subscription work (`limits.planShareCap` or the policy's). */
  cap: number;
}

export interface TaskBillingPick {
  source: BillingSource;
  /** "sdk" for a subscription (the Agent SDK with the OAuth token), "loop" for everything else. */
  driver: SpecialistDriver;
  reason: string;
  skipped: RouteSkip[];
  /** Set for a subscription source; null for API-style sources. */
  plan: PlanUsage | null;
}

export interface TaskBillingPort {
  pick(req: TaskBillingRequest): Promise<TaskBillingPick>;
}

/**
 * The plan share after `extraUsdMicro` more API-equivalent spend on the source: computed from
 * the allowance when the source has one, else the share the pick saw (a run cannot move a
 * share nobody can compute; the ledger's MAX keeps the last known value).
 */
export function planShareAfter(plan: PlanUsage, extraUsdMicro: number): number | null {
  if (plan.allowanceUsdMicro && plan.allowanceUsdMicro > 0) {
    const share = (plan.monthUsdMicro + Math.max(0, extraUsdMicro)) / plan.allowanceUsdMicro;
    // Six decimals: one millionth of the plan, so a small run still moves the share.
    return Math.round(share * 1_000_000) / 1_000_000;
  }
  return plan.share;
}
