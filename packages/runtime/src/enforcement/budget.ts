import { ForerunnerError } from "@forerunner/platform";

/**
 * `details.source` of a `budget_exceeded` refusal raised by `SessionBudget` itself (its run cap
 * or its session cap), as opposed to an outer cap (project, month: `CapsPort`), whose `level`
 * may also read "run" or "session". The conversation agent tells the two apart by it.
 */
export const LOCAL_BUDGET_SOURCE = "session_budget";

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

/** The share of a run's cap kept to wrap up (ADR 0112): about a fifth. */
export const WRAP_UP_SHARE = 0.2;
/** ...or the worst case of this many calls, when that is more (ADR 0112). */
export const WRAP_UP_CALLS = 2;

/**
 * A run's wrap-up line (ADR 0112, the owner's decision of 2026-11-02), fixed at its first call.
 * The reserve is the larger of a fifth of the run's cap and the worst case of two calls (the
 * first call's estimate, from the shared estimate function, twice); the line is the cap less
 * the reserve. The call that would take the run past the line brings the wrap-up message, once.
 * `saveOnly`: the line is at or below the first call's worst case (a tiny budget: the reserve
 * is at least the cap, or leaves no room for one call), so no wrap-up is sent and the run
 * pauses at its budget with the code-side save only. `firstCallUsdMicro`: that first call's
 * worst case; above the cap, the run is refused before its first call (a save-only line too).
 */
export interface RunWrapUpLine {
  capUsdMicro: number;
  reserveUsdMicro: number;
  lineUsdMicro: number;
  firstCallUsdMicro: number;
  saveOnly: boolean;
}

/** The wrap-up line of a run with this cap whose first call's worst case is `firstCallUsdMicro`. */
export function wrapUpLineOf(capUsdMicro: number, firstCallUsdMicro: number): RunWrapUpLine {
  const first = Math.max(0, firstCallUsdMicro);
  const reserve = Math.max(Math.ceil(capUsdMicro * WRAP_UP_SHARE), WRAP_UP_CALLS * first);
  const line = Math.max(0, capUsdMicro - reserve);
  return {
    capUsdMicro,
    reserveUsdMicro: reserve,
    lineUsdMicro: line,
    firstCallUsdMicro: first,
    saveOnly: line <= first,
  };
}

/**
 * The run's line a refusal of its first call carries (`details.line`, review of budget-stop):
 * a budget below that call's worst case is refused before the call, and the drivers still say
 * the line ("save only") from it. Undefined when the details hold none.
 */
export function wrapUpLineIn(
  details: Record<string, unknown> | undefined,
): RunWrapUpLine | undefined {
  const l = details?.line;
  if (!l || typeof l !== "object" || Array.isArray(l)) return undefined;
  const o = l as Record<string, unknown>;
  const n = (k: string) =>
    typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null;
  const cap = n("capUsdMicro");
  const reserve = n("reserveUsdMicro");
  const line = n("lineUsdMicro");
  const first = n("firstCallUsdMicro");
  if (cap === null || reserve === null || line === null || first === null) return undefined;
  return {
    capUsdMicro: cap,
    reserveUsdMicro: reserve,
    lineUsdMicro: line,
    firstCallUsdMicro: first,
    saveOnly: o.saveOnly === true,
  };
}

/** What `precheck` decided for one call. `line`: the run's wrap-up line, on its first call only. */
export interface PrecheckDecision {
  decision: "allow" | "finish_current" | "wrap_up";
  line?: RunWrapUpLine;
}

export class SessionBudget {
  private spentBySession = 0;
  private spentByRun = new Map<string, number>();
  private stepCount = 0;
  private _noNewWork = false;
  private _warned80 = false;
  /** Each work run's wrap-up line and whether its wrap-up was given (ADR 0112). */
  private readonly runLines = new Map<string, RunWrapUpLine & { wrapped: boolean }>();

  constructor(readonly limits: SessionLimits) {
    // Negated comparisons so NaN fails each check instead of slipping through every one.
    if (!(limits.budgetUsdMicro >= 0))
      throw new ForerunnerError("validation", "session budget must be >= 0");
    if (!(limits.stepCap > 0)) throw new ForerunnerError("validation", "step cap must be > 0");
    if (!(limits.reserveShare >= 0 && limits.reserveShare <= 0.5)) {
      throw new ForerunnerError("validation", "reserve share must be between 0 and 0.5");
    }
    if (Number.isNaN(limits.deadlineMs))
      throw new ForerunnerError("validation", "session deadline must be a time");
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
   * At 80% of the session cap: finish current task, no new work. At 100%: stop. For a work run,
   * the call that would take it past its wrap-up line (`RunWrapUpLine`, set at its first call)
   * answers `wrap_up`, once; a save-only line never does. The run's first call carries its line,
   * and so does a refusal of that call (`details.line`): a budget below one call's worst case is
   * refused before the call, and its line ("save only") is still said.
   * `lineEstimateUsdMicro`: the call's worst case without its web searches ('web-search', the
   * loop's token estimate; default the whole estimate). It fixes the run's line and decides the
   * wrap-up, so offering search moves neither; the caps get the whole estimate. The loop pays a
   * call's searches only from the money below the line (`lineFor`), so before the wrap-up the
   * whole estimate stays below the line too.
   */
  precheck(
    runId: string,
    runCapUsdMicro: number,
    estimateUsdMicro: number,
    phase: "work" | "review",
    lineEstimateUsdMicro: number = estimateUsdMicro,
  ): PrecheckDecision {
    checkAmount(estimateUsdMicro, "budget estimate");
    checkAmount(lineEstimateUsdMicro, "budget estimate");
    const runSpent = this.spentByRunId(runId);
    let first: RunWrapUpLine | undefined;
    let line = phase === "work" ? this.runLines.get(runId) : undefined;
    // The line is fixed at the run's first call, from that call's estimate, before the caps are
    // checked (review of budget-stop: a first call refused at the run's cap said no line). A run
    // first seen with spend already booked (never in the drivers, which check before every
    // call) has none.
    if (phase === "work" && !line && runSpent === 0) {
      first = wrapUpLineOf(runCapUsdMicro, lineEstimateUsdMicro);
      line = { ...first, wrapped: false };
      this.runLines.set(runId, line);
    }
    let local: { decision: "allow" | "finish_current" };
    try {
      local = this.precheckCaps(runId, runCapUsdMicro, estimateUsdMicro, phase);
    } catch (e) {
      if (first && e instanceof ForerunnerError) e.details.line = first;
      throw e;
    }
    if (phase !== "work") return local;
    const wrap =
      !!line &&
      !line.saveOnly &&
      !line.wrapped &&
      runSpent + lineEstimateUsdMicro > line.lineUsdMicro;
    if (wrap && line) line.wrapped = true;
    return {
      decision: wrap ? "wrap_up" : local.decision,
      ...(first ? { line: first } : {}),
    };
  }

  /** The run's wrap-up line, once its first call set it (ADR 0112). */
  wrapUpLineOf(runId: string): RunWrapUpLine | undefined {
    const line = this.runLines.get(runId);
    if (!line) return undefined;
    const { wrapped: _wrapped, ...rest } = line;
    return rest;
  }

  /**
   * The work run's wrap-up line, or, before its first call, the line that call fixes with this
   * worst case (`wrapUpLineOf`); a read only, `precheck` fixes it. Undefined for a review run
   * and a run first seen with spend booked, which have none. The loop pays a call's web searches
   * only from the money below it ('web-search'), so they never eat the reserve kept to finish.
   */
  lineFor(
    runId: string,
    runCapUsdMicro: number,
    firstCallUsdMicro: number,
    phase: "work" | "review",
  ): RunWrapUpLine | undefined {
    if (phase !== "work") return undefined;
    const line = this.wrapUpLineOf(runId);
    if (line) return line;
    return this.spentByRunId(runId) === 0
      ? wrapUpLineOf(runCapUsdMicro, firstCallUsdMicro)
      : undefined;
  }

  /**
   * What is left of the session's work budget: its cap less the review reserve
   * (`reserveShare`), less what was spent. A task's run is capped at it (ADR 0112), so the
   * share kept for reviews stays for reviews. Never negative.
   */
  workRemainingUsdMicro(): number {
    const work = Math.floor(this.limits.budgetUsdMicro * (1 - this.limits.reserveShare));
    return Math.max(0, work - this.spentBySession);
  }

  /** `precheck` without the run's wrap-up line: the run cap, the session cap and its lines. */
  private precheckCaps(
    runId: string,
    runCapUsdMicro: number,
    estimateUsdMicro: number,
    phase: "work" | "review",
  ): { decision: "allow" | "finish_current" } {
    checkAmount(estimateUsdMicro, "budget estimate");
    const runSpent = this.spentByRunId(runId);
    // At or over the cap nothing more runs, whatever the estimate says.
    if (runSpent >= runCapUsdMicro || runSpent + estimateUsdMicro > runCapUsdMicro) {
      throw new ForerunnerError("budget_exceeded", "run budget would be exceeded", {
        details: {
          level: "run",
          source: LOCAL_BUDGET_SOURCE,
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
          source: LOCAL_BUDGET_SOURCE,
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
    checkAmount(usdMicro, "budget spend");
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

  /**
   * The largest estimate `precheck` admits for this run without changing the session's state:
   * within the run cap and the session cap and, while the session still takes new work, below
   * the line that would set no-new-work for good (80% of the cap; for the work phase also the
   * review reserve). Once no-new-work is set that line no longer bounds anything, so only the
   * caps do. Never negative. Used to size a call's output cap (`RunRequest.maxTokensCeiling`):
   * a larger cap must not flip the session to no-new-work for a call that costs a fraction of it.
   */
  quietRoomUsdMicro(runId: string, runCapUsdMicro: number, phase: "work" | "review"): number {
    const cap = this.limits.budgetUsdMicro;
    let room = Math.min(runCapUsdMicro - this.spentByRunId(runId), cap - this.spentBySession);
    if (!this._noNewWork) {
      // precheck flips at projected >= 80% of the cap: the estimate must stay strictly below.
      room = Math.min(room, Math.ceil(cap * 0.8 - this.spentBySession) - 1);
      // ...and, for work, at projected > the work ceiling: at most up to it.
      if (phase === "work") {
        room = Math.min(
          room,
          Math.floor(cap * (1 - this.limits.reserveShare) - this.spentBySession),
        );
      }
    }
    return Math.max(0, room);
  }
}

/**
 * An amount is a non-negative integer of USD micro-units. NaN passes every comparison and,
 * once added to the session's spend, makes every later cap check false; one unpriced model
 * id or a provider that reports no usage would otherwise switch the hard cap off for good.
 */
function checkAmount(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ForerunnerError(
      "validation",
      `${what} must be a non-negative integer of USD micro-units, got ${String(n)}`,
      { details: { what, value: String(n) } },
    );
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
