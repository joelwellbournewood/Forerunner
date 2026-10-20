import { ForerunnerError } from "@forerunner/platform";

/**
 * In-process accounting for one session: spend per run, steps, wall clock. The ledger is the
 * durable truth; this object makes the per-call decision fast and works offline.
 */
export interface SessionLimits {
  sessionId: string;
  budgetUsdMicro: number;
  stepCap: number;
  /** Absolute epoch ms when the session must stop. */
  deadlineMs: number;
  /** Share of the session budget reserved for review and fixes (0.15-0.25). */
  reserveShare: number;
}

export interface SpendSnapshot {
  sessionSpentUsdMicro: number;
  runSpentUsdMicro: Record<string, number>;
  steps: number;
  noNewWork: boolean;
  warnedAt80: boolean;
}

export class SessionBudget {
  private spentBySession = 0;
  private spentByRun = new Map<string, number>();
  private stepCount = 0;
  private _noNewWork = false;
  private _warned80 = false;

  constructor(readonly limits: SessionLimits) {
    if (limits.budgetUsdMicro < 0)
      throw new ForerunnerError("validation", "session budget must be >= 0");
    if (limits.stepCap <= 0) throw new ForerunnerError("validation", "step cap must be > 0");
    if (limits.reserveShare < 0 || limits.reserveShare > 0.5) {
      throw new ForerunnerError("validation", "reserve share must be between 0 and 0.5");
    }
  }

  get noNewWork(): boolean {
    return this._noNewWork;
  }

  snapshot(): SpendSnapshot {
    return {
      sessionSpentUsdMicro: this.spentBySession,
      runSpentUsdMicro: Object.fromEntries(this.spentByRun),
      steps: this.stepCount,
      noNewWork: this._noNewWork,
      warnedAt80: this._warned80,
    };
  }

  spentByRunId(runId: string): number {
    return this.spentByRun.get(runId) ?? 0;
  }

  /** Count one step (a model call or a tool call). Throws at the cap. */
  step(): number {
    if (this.stepCount >= this.limits.stepCap) {
      throw new ForerunnerError(
        "step_cap_exceeded",
        `session step cap ${this.limits.stepCap} reached`,
        {
          details: {
            sessionId: this.limits.sessionId,
            steps: this.stepCount,
            cap: this.limits.stepCap,
          },
        },
      );
    }
    this.stepCount++;
    return this.stepCount;
  }

  checkWallClock(nowMs: number): void {
    if (nowMs >= this.limits.deadlineMs) {
      throw new ForerunnerError("timeout", "session wall-clock cap reached", {
        details: {
          sessionId: this.limits.sessionId,
          deadline: new Date(this.limits.deadlineMs).toISOString(),
        },
      });
    }
  }

  /**
   * Decide whether a call with the given estimate may start. Order: run cap, then session cap.
   * At 80% of the session cap: finish current task, no new work. At 100%: stop.
   */
  precheck(
    runId: string,
    runCapUsdMicro: number,
    estimateUsdMicro: number,
    phase: "work" | "review",
  ): {
    decision: "allow" | "finish_current";
  } {
    const runSpent = this.spentByRunId(runId);
    // At or over the cap nothing more runs, whatever the estimate says.
    if (runSpent >= runCapUsdMicro || runSpent + estimateUsdMicro > runCapUsdMicro) {
      throw new ForerunnerError("budget_exceeded", "run budget would be exceeded", {
        details: {
          level: "run",
          runId,
          spentUsdMicro: runSpent,
          estimateUsdMicro,
          capUsdMicro: runCapUsdMicro,
        },
      });
    }
    const cap = this.limits.budgetUsdMicro;
    const projected = this.spentBySession + estimateUsdMicro;
    if (this.spentBySession >= cap || projected > cap) {
      this._noNewWork = true;
      throw new ForerunnerError("budget_exceeded", "session budget would be exceeded", {
        details: {
          level: "session",
          sessionId: this.limits.sessionId,
          spentUsdMicro: this.spentBySession,
          estimateUsdMicro,
          capUsdMicro: cap,
        },
      });
    }
    const workCeiling = cap * (1 - this.limits.reserveShare);
    if (phase === "work" && projected > workCeiling) {
      // Work may not eat into the review reserve; the current call still runs if within cap,
      // but no new tasks start.
      this._noNewWork = true;
      return { decision: "finish_current" };
    }
    if (projected >= cap * 0.8) {
      this._noNewWork = true;
      this._warned80 = true;
      return { decision: "finish_current" };
    }
    return { decision: "allow" };
  }

  record(runId: string, usdMicro: number): void {
    if (usdMicro < 0) throw new ForerunnerError("validation", "spend cannot be negative");
    this.spentBySession += usdMicro;
    this.spentByRun.set(runId, this.spentByRunId(runId) + usdMicro);
    if (this.spentBySession >= this.limits.budgetUsdMicro * 0.8) {
      this._noNewWork = true;
      this._warned80 = true;
    }
  }

  remainingUsdMicro(): number {
    return Math.max(0, this.limits.budgetUsdMicro - this.spentBySession);
  }
}

/** Conservative pre-call estimate: full input at input price + max_tokens at output price. */
export function estimateCallUsdMicro(
  inputTokens: number,
  maxOutputTokens: number,
  price: { inputPerMtokUsd: number; outputPerMtokUsd: number },
): number {
  const usd =
    (inputTokens / 1_000_000) * price.inputPerMtokUsd +
    (maxOutputTokens / 1_000_000) * price.outputPerMtokUsd;
  return Math.ceil(usd * 1_000_000);
}
