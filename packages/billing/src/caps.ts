/**
 * Hard caps (spec module I). Pure given the ledger: the same ledger, caps and clock always
 * give the same decision. The runtime calls check() before every model call; the decision
 * is enforced there, never by a prompt.
 *
 * Rules:
 *   - a level at or above 100% of its cap after adding the estimate -> "stop" (stop and ask);
 *   - a level at or above 80% -> "finish_current" (finish the current task, start no new work);
 *   - the work phase may not eat into the review reserve of the session cap
 *     (session spend + estimate > cap * (1 - reserveShare) -> "finish_current"); the review
 *     phase may use it;
 *   - subscription plan usage share at or above planShareCap -> "stop", at 80% of it ->
 *     "finish_current".
 */
import type { Clock } from "@forerunner/platform";
import { ForerunnerError } from "@forerunner/platform";
import { monthWindow } from "./ledger.ts";
import { assertMicro, formatUsd, roundHalfUp } from "./money.ts";
import { DEFAULT_PLAN_SHARE_CAP } from "./router.ts";
import type { LedgerFilter, LedgerQuery } from "./sink.ts";
import type { BillingSourceKind } from "./sources.ts";

export interface CapScope {
  humanId: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
}

export interface Caps {
  monthUsdMicro: number;
  projectUsdMicro?: number;
  sessionUsdMicro: number;
  taskUsdMicro?: number;
  runUsdMicro?: number;
  /** Share of the session cap kept for review and fixes, 0.15..0.25. Default 0.2. */
  reserveShare?: number;
  /** Plan usage share at which subscription work stops. Default 0.95. */
  planShareCap?: number;
}

export type CapLevel = "month" | "project" | "session" | "task" | "run" | "plan";
export type CapDecision = "allow" | "finish_current" | "stop";
export type Phase = "work" | "review";

export interface CapLevelStatus {
  level: CapLevel;
  /** usd_micro, except level "plan" where spent and cap are plan shares (0..1). */
  spent: number;
  cap: number;
  estimate: number;
  projected: number;
  ratio: number;
  remaining: number;
  decision: CapDecision;
  note?: string;
}

export interface CapCheck {
  decision: CapDecision;
  /** The level that decided; null only when nothing was measurable. */
  level: CapLevel | null;
  spent: number;
  cap: number;
  remaining: number;
  ratio: number;
  message: string;
  levels: CapLevelStatus[];
}

export const FINISH_CURRENT_AT = 0.8;
export const STOP_AT = 1.0;
export const DEFAULT_RESERVE_SHARE = 0.2;
export const RESERVE_SHARE_MIN = 0.15;
export const RESERVE_SHARE_MAX = 0.25;

const LEVEL_ORDER: readonly CapLevel[] = ["month", "project", "session", "task", "run", "plan"];
const SEVERITY: Record<CapDecision, number> = { allow: 0, finish_current: 1, stop: 2 };

type NormalizedCaps = Caps & { reserveShare: number; planShareCap: number };

function assertCap(value: number | undefined, what: string): void {
  if (value === undefined) return;
  assertMicro(value, what);
  if (value <= 0) {
    throw new ForerunnerError("validation", `${what} must be a positive amount`, {
      details: { what, value },
    });
  }
}

/** Validate caps and fill defaults. */
export function normalizeCaps(caps: Caps): NormalizedCaps {
  assertCap(caps.monthUsdMicro, "monthUsdMicro");
  assertCap(caps.sessionUsdMicro, "sessionUsdMicro");
  assertCap(caps.projectUsdMicro, "projectUsdMicro");
  assertCap(caps.taskUsdMicro, "taskUsdMicro");
  assertCap(caps.runUsdMicro, "runUsdMicro");
  const reserveShare = caps.reserveShare ?? DEFAULT_RESERVE_SHARE;
  if (
    !Number.isFinite(reserveShare) ||
    reserveShare < RESERVE_SHARE_MIN ||
    reserveShare > RESERVE_SHARE_MAX
  ) {
    throw new ForerunnerError(
      "validation",
      `reserveShare must be between ${RESERVE_SHARE_MIN} and ${RESERVE_SHARE_MAX}`,
      { details: { reserveShare } },
    );
  }
  const planShareCap = caps.planShareCap ?? DEFAULT_PLAN_SHARE_CAP;
  if (!Number.isFinite(planShareCap) || planShareCap <= 0 || planShareCap > 1) {
    throw new ForerunnerError("validation", "planShareCap must be in (0, 1]", {
      details: { planShareCap },
    });
  }
  return { ...caps, reserveShare, planShareCap };
}

export interface CapCheckOptions {
  phase: Phase;
  /** Per-call caps (e.g. a project's own caps); default the checker's caps. */
  caps?: Caps;
  /** Current plan usage share for a subscription source, 0..1. */
  planUsageShare?: number;
  sourceKind?: BillingSourceKind;
}

export interface CapCheckerOptions {
  query: LedgerQuery;
  clock: Clock;
  caps: Caps;
  thresholds?: { finishCurrentAt?: number; stopAt?: number };
}

export class CapChecker {
  private readonly query: LedgerQuery;
  private readonly clock: Clock;
  private readonly caps: NormalizedCaps;
  private readonly finishCurrentAt: number;
  private readonly stopAt: number;

  constructor(opts: CapCheckerOptions) {
    this.query = opts.query;
    this.clock = opts.clock;
    this.caps = normalizeCaps(opts.caps);
    this.finishCurrentAt = opts.thresholds?.finishCurrentAt ?? FINISH_CURRENT_AT;
    this.stopAt = opts.thresholds?.stopAt ?? STOP_AT;
    if (!(this.finishCurrentAt > 0 && this.finishCurrentAt <= this.stopAt && this.stopAt <= 1)) {
      throw new ForerunnerError("validation", "thresholds must satisfy 0 < finish <= stop <= 1");
    }
  }

  async check(scope: CapScope, estimateUsdMicro: number, opts: CapCheckOptions): Promise<CapCheck> {
    assertMicro(estimateUsdMicro, "estimateUsdMicro");
    if (estimateUsdMicro < 0) {
      throw new ForerunnerError("validation", "estimate must not be negative");
    }
    const caps = opts.caps ? normalizeCaps(opts.caps) : this.caps;
    const levels: CapLevelStatus[] = [];

    const measure = async (level: CapLevel, cap: number, filter: LedgerFilter): Promise<void> => {
      const spent = (await this.query.sum(filter)).usd_micro;
      const projected = spent + estimateUsdMicro;
      const status = this.decide(level, spent, cap, estimateUsdMicro, projected);
      if (level === "session" && opts.phase === "work" && status.decision === "allow") {
        const workLimit = roundHalfUp(cap * (1 - caps.reserveShare));
        if (projected > workLimit) {
          status.decision = "finish_current";
          status.note = `review reserve ${Math.round(caps.reserveShare * 100)}% of the session cap is kept for review and fixes`;
        }
      }
      levels.push(status);
    };

    await measure("month", caps.monthUsdMicro, {
      humanId: scope.humanId,
      ...monthWindow(this.clock.now()),
    });
    if (caps.projectUsdMicro !== undefined && scope.projectId) {
      await measure("project", caps.projectUsdMicro, { projectId: scope.projectId });
    }
    if (scope.sessionId) {
      await measure("session", caps.sessionUsdMicro, { sessionId: scope.sessionId });
    }
    if (caps.taskUsdMicro !== undefined && scope.taskId) {
      await measure("task", caps.taskUsdMicro, { taskId: scope.taskId });
    }
    if (caps.runUsdMicro !== undefined && scope.runId) {
      await measure("run", caps.runUsdMicro, { runId: scope.runId });
    }
    if (
      typeof opts.planUsageShare === "number" &&
      (opts.sourceKind === undefined || opts.sourceKind === "subscription")
    ) {
      levels.push(this.decidePlan(opts.planUsageShare, caps.planShareCap));
    }

    return summarize(levels, opts.phase);
  }

  private decide(
    level: CapLevel,
    spent: number,
    cap: number,
    estimate: number,
    projected: number,
  ): CapLevelStatus {
    const stopAt = roundHalfUp(cap * this.stopAt);
    const finishAt = roundHalfUp(cap * this.finishCurrentAt);
    const decision: CapDecision =
      projected >= stopAt ? "stop" : projected >= finishAt ? "finish_current" : "allow";
    return {
      level,
      spent,
      cap,
      estimate,
      projected,
      ratio: projected / cap,
      remaining: Math.max(cap - spent, 0),
      decision,
    };
  }

  private decidePlan(share: number, cap: number): CapLevelStatus {
    if (!Number.isFinite(share) || share < 0) {
      throw new ForerunnerError("validation", "planUsageShare must be a non-negative number", {
        details: { share },
      });
    }
    const ratio = share / cap;
    const decision: CapDecision =
      ratio >= this.stopAt - 1e-12
        ? "stop"
        : ratio >= this.finishCurrentAt - 1e-12
          ? "finish_current"
          : "allow";
    return {
      level: "plan",
      spent: share,
      cap,
      estimate: 0,
      projected: share,
      ratio,
      remaining: Math.max(cap - share, 0),
      decision,
      note: "plan usage share of the subscription limit",
    };
  }
}

function summarize(levels: CapLevelStatus[], phase: Phase): CapCheck {
  if (levels.length === 0) {
    return {
      decision: "allow",
      level: null,
      spent: 0,
      cap: 0,
      remaining: 0,
      ratio: 0,
      message: "no cap applies to this scope",
      levels,
    };
  }
  const ordered = [...levels].sort(
    (a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level),
  );
  const worst = ordered.reduce((acc, l) =>
    SEVERITY[l.decision] > SEVERITY[acc.decision] ? l : acc,
  );
  const headline = ordered
    .filter((l) => l.decision === worst.decision)
    .reduce((acc, l) => (l.ratio > acc.ratio ? l : acc));
  return {
    decision: headline.decision,
    level: headline.level,
    spent: headline.spent,
    cap: headline.cap,
    remaining: headline.remaining,
    ratio: headline.ratio,
    message: describe(headline, phase),
    levels: ordered,
  };
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

function describe(l: CapLevelStatus, phase: Phase): string {
  if (l.level === "plan") {
    const amounts = `plan usage ${pct(l.spent)} of the ${pct(l.cap)} cap`;
    if (l.decision === "stop") return `${amounts}: stop and ask`;
    if (l.decision === "finish_current")
      return `${amounts}: finish the current task, start no new work`;
    return `${amounts}: within cap`;
  }
  const amounts = `${l.level} cap ${formatUsd(l.projected)} of ${formatUsd(l.cap)} after this run (${pct(l.ratio)})`;
  if (l.decision === "stop") return `${amounts}: stop and ask`;
  if (l.decision === "finish_current") {
    const why = l.note ? ` (${l.note})` : "";
    return `${amounts}${why}: finish the current task, start no new work`;
  }
  return `${amounts}: within caps for ${phase}`;
}
