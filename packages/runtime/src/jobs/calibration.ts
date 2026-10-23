/**
 * The monthly critic calibration (spec H.7: "the critic grades the golden eval set monthly so
 * drift is visible"; ADR 0060). Once a month (`Schedule` kind "monthly", on by default, day
 * and time from `human.notify_prefs.calibration`) the job runs `calibrate()` from the critic
 * package over the registry's eval sets (every runnable specialist with tasks, or the ones the
 * settings name) through the composed critic service at the configured tier, under a budget
 * the hooks enforce (a session row and a token carry it: a run cannot spend past it), writes
 * the report as `<data dir>/critic/calibration-<date>.json`, reads the previous report back
 * for the drift (catch rate and pass rate in points), raises a `critic_calibration`
 * notification naming the rates, the gate and the drift, and writes a `critic.calibration`
 * audit row. The month's report file is the dedupe across restarts; `force` runs again. A run
 * the hooks refuse (budget, provider) is reported as failed with the reason, never hidden.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  type CalibrationReport,
  type CriticService,
  calibrate,
  calibrationFileName,
  type EvalsPort,
  formatCalibrationReport,
  loadEvalsPort,
  type ReviewTier,
} from "@forerunner/critic";
import { type Clock, errorMessage, ForerunnerError, join, log } from "@forerunner/platform";
import type { JsonObject, StateStore } from "@forerunner/state";
import { SessionBudget } from "../enforcement/budget.ts";
import type { TokenIssuer } from "../enforcement/token.ts";
import type { NotifierLike } from "../notifications/producers.ts";
import { calibrationDriftLine, criticCalibration } from "../notifications/producers.ts";
import type { Registry } from "../registry/types.ts";
import {
  localParts,
  type Schedule,
  type Scheduler,
  type StartRequest,
} from "../session/triggers.ts";

/** The scheduler entry's sentinel agent id, like the model watch's. */
export const CALIBRATION_AGENT_ID = "critic-calibration";
export const CALIBRATION_SCHEDULE_ID = "critic:calibration";
export const CALIBRATION_SETTINGS_KEY = "calibration";
export const CALIBRATION_AUDIT_TOOL = "critic.calibration";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The eval runs' and reviews' wall-clock bound: the token and the budget expire after it. */
const CALIBRATION_TIMEOUT_MS = 4 * 3_600_000;

export interface CalibrationSettings {
  enabled: boolean;
  day: number;
  time: string;
  budgetUsdMicro: number;
  tier: Exclude<ReviewTier, 0>;
  /** Specialists whose eval sets run; null means every runnable one with tasks. */
  specialists: string[] | null;
}

export const DEFAULT_CALIBRATION_SETTINGS: Readonly<CalibrationSettings> = Object.freeze({
  enabled: true,
  day: 1,
  time: "06:00",
  budgetUsdMicro: 10_000_000,
  tier: 1 as const,
  specialists: null,
});

/** `human.notify_prefs.calibration`; every field has a default and a malformed one falls back. */
export function calibrationSettingsOf(prefs: JsonObject | null | undefined): CalibrationSettings {
  const d = DEFAULT_CALIBRATION_SETTINGS;
  const raw = prefs?.[CALIBRATION_SETTINGS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...d };
  const s = raw as Record<string, unknown>;
  const tier = s.tier === 1 || s.tier === 2 || s.tier === 3 ? s.tier : d.tier;
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : d.enabled,
    day:
      typeof s.day === "number" && Number.isFinite(s.day)
        ? Math.min(31, Math.max(1, Math.trunc(s.day)))
        : d.day,
    time: typeof s.time === "string" && HHMM.test(s.time) ? s.time : d.time,
    budgetUsdMicro:
      typeof s.budget_usd === "number" && Number.isFinite(s.budget_usd) && s.budget_usd > 0
        ? Math.round(s.budget_usd * 1_000_000)
        : d.budgetUsdMicro,
    tier,
    specialists:
      Array.isArray(s.specialists) && s.specialists.every((x) => typeof x === "string")
        ? [...(s.specialists as string[])]
        : d.specialists,
  };
}

export function scheduleCalibration(
  scheduler: Scheduler,
  opts: { timezone: string; day?: number; time?: string; enabled?: boolean },
): Schedule {
  const schedule: Schedule = {
    id: CALIBRATION_SCHEDULE_ID,
    agentId: CALIBRATION_AGENT_ID,
    kind: "monthly",
    dayOfMonth: opts.day ?? DEFAULT_CALIBRATION_SETTINGS.day,
    time: opts.time ?? DEFAULT_CALIBRATION_SETTINGS.time,
    timezone: opts.timezone,
    enabled: opts.enabled ?? DEFAULT_CALIBRATION_SETTINGS.enabled,
  };
  scheduler.add(schedule);
  return schedule;
}

export function isCalibrationRequest(req: StartRequest): boolean {
  return req.agentId === CALIBRATION_AGENT_ID;
}

/** The eval functions the job needs: `calibrate`'s port plus the set loader. */
export interface CalibrationEvalsPort extends EvalsPort {
  loadEvalSet: NonNullable<EvalsPort["loadEvalSet"]>;
}

export interface CalibrationReportSummary {
  date: string;
  startedAt: string;
  file: string;
  tier: ReviewTier;
  model: string;
  catchRate: number;
  passRate: number;
  gateOk: boolean;
  costUsdMicro: number;
}

export interface CalibrationDrift {
  /** The previous report's date; null when this run is the baseline. */
  since: string | null;
  /** Percentage points against the previous report (positive: better). */
  catchRatePoints: number | null;
  passRatePoints: number | null;
}

export interface CalibrationRunResult {
  status: "ran" | "skipped" | "failed";
  reason?: string;
  monthKey: string;
  report: CalibrationReport | null;
  previous: CalibrationReportSummary | null;
  drift: CalibrationDrift | null;
  sessionId: string | null;
  notificationId: string | null;
}

export interface CalibrationJobDeps {
  store: StateStore;
  clock: Clock;
  tokens: TokenIssuer;
  /** The composed critic service (the same prompt, tiers, rules and ladder a task review gets). */
  critic: CriticService;
  registry: Registry;
  /** `<data dir>/critic`. */
  outDir: string;
  notifier?: NotifierLike;
  humanId: string;
  /** The principal agent: the session row and token the reviews run under. */
  agentId: string;
  /** The critic agent: author of the audit row. */
  criticAgentId: string;
  /** Default: the dynamic import of @forerunner/evals (tests inject the port). */
  evals?: CalibrationEvalsPort;
  /** Budget, tier and specialists at run time; default: the built-in defaults. */
  settings?: () => Promise<CalibrationSettings>;
  /**
   * The human's time zone, read at every run: the once-a-month check is the local month of
   * the run against the local month the previous report started in, the same key the
   * scheduler's monthly kind fires on. Default UTC.
   */
  timezone?: () => Promise<string> | string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const points = (x: number) => Math.round(x * 100);

export class CalibrationJob {
  private readonly logger = log("calibration-job");

  constructor(private readonly deps: CalibrationJobDeps) {}

  /**
   * The reports on disk, newest first by when the run started (`startedAt`; a same-day
   * second run's file name sorts BEFORE the first's, so the name is only the tie-break).
   */
  reports(): CalibrationReportSummary[] {
    if (!existsSync(this.deps.outDir)) return [];
    const out: CalibrationReportSummary[] = [];
    for (const f of readdirSync(this.deps.outDir).filter(
      (f) => f.startsWith("calibration-") && f.endsWith(".json"),
    )) {
      const file = join(this.deps.outDir, f);
      try {
        const r = JSON.parse(readFileSync(file, "utf8")) as CalibrationReport;
        out.push({
          date: r.date,
          startedAt: r.startedAt,
          file,
          tier: r.tier,
          model: r.model,
          catchRate: r.catchRate,
          passRate: r.passRate,
          gateOk: r.gate.ok,
          costUsdMicro: r.cost.usdMicro,
        });
      } catch (e) {
        this.logger.warn("unreadable calibration report", { file: f, error: errorMessage(e) });
      }
    }
    return out.sort((a, b) =>
      a.startedAt === b.startedAt
        ? b.file.localeCompare(a.file)
        : b.startedAt.localeCompare(a.startedAt),
    );
  }

  private latest(): CalibrationReportSummary | null {
    return this.reports()[0] ?? null;
  }

  async run(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<CalibrationRunResult> {
    const { store, clock, tokens } = this.deps;
    const now = clock.nowIso();
    const timezone = (await this.deps.timezone?.()) ?? "UTC";
    const monthKey = localParts(clock.now(), timezone).monthKey;
    const previous = this.latest();
    if (
      !opts.force &&
      previous &&
      localParts(Date.parse(previous.startedAt), timezone).monthKey === monthKey
    ) {
      this.logger.info("calibration skipped: already ran this month", { previous: previous.file });
      return {
        status: "skipped",
        reason: "already_ran",
        monthKey,
        report: null,
        previous,
        drift: null,
        sessionId: null,
        notificationId: null,
      };
    }
    const settings = (await this.deps.settings?.()) ?? { ...DEFAULT_CALIBRATION_SETTINGS };
    const evals = this.deps.evals ?? (await loadCalibrationEvals());
    const specialists = this.deps.registry
      .runnableSpecialists()
      .filter((d) => (settings.specialists ? settings.specialists.includes(d.name) : true))
      .filter((d) => settings.specialists !== null || d.evalTaskCount > 0);
    const evalSet = specialists.flatMap((d) => evals.loadEvalSet(d.evalSetDir));
    if (evalSet.length === 0)
      throw new ForerunnerError("not_found", "no eval tasks to calibrate on", {
        details: { specialists: specialists.map((d) => d.name) },
      });

    // The run's session row and token: the budget the hooks enforce before every review.
    const session = await store.session.insert({
      agent_id: this.deps.agentId,
      project_id: null,
      trigger: "schedule",
      plan: {
        items: [],
        estimateUsdMicro: 0,
        summary: `critic calibration over ${evalSet.length} eval task(s)`,
      },
      budget_cap_usd_micro: settings.budgetUsdMicro,
      step_cap: 100_000,
      spent_usd_micro: 0,
      steps: 0,
      started_at: now,
      status: "running",
      summary: "",
      handoff: {},
      runner: "pc",
      author_agent: this.deps.agentId,
    });
    const sessionToken = tokens.issue({
      runId: `calibration-${session.id}`,
      sessionId: session.id,
      agentId: this.deps.agentId,
      ownerHumanId: this.deps.humanId,
      allowedTools: [],
      allowedPaths: [],
      allowedDomains: [],
      grantedSecrets: [],
      budgetUsdMicro: settings.budgetUsdMicro,
      depth: 0,
      maxDepth: 1,
      autonomy: 4,
      planApproved: true,
      expiresAt: new Date(clock.now() + CALIBRATION_TIMEOUT_MS).toISOString(),
    });
    const budget = new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: settings.budgetUsdMicro,
      stepCap: 100_000,
      deadlineMs: clock.now() + CALIBRATION_TIMEOUT_MS,
      reserveShare: 0,
    });
    const names = specialists.map((d) => d.name);
    const input = JSON.stringify({
      specialists: names,
      tasks: evalSet.length,
      tier: settings.tier,
      budgetUsdMicro: settings.budgetUsdMicro,
    });
    const failed = async (reason: string): Promise<CalibrationRunResult> => {
      this.logger.error("calibration failed", { sessionId: session.id, error: reason });
      await this.close(session.id, "failed", reason, budget.snapshot().sessionSpentUsdMicro);
      await store.auditLog.append({
        session_id: session.id,
        run_id: null,
        agent_id: this.deps.criticAgentId,
        human_id: this.deps.humanId,
        tool: CALIBRATION_AUDIT_TOOL,
        input_summary: input,
        result_summary: "",
        allowed: false,
        denied_reason: reason,
        cost_usd_micro: budget.snapshot().sessionSpentUsdMicro,
        occurred_at: clock.nowIso(),
        token_id: sessionToken.claims.id,
        author_agent: this.deps.criticAgentId,
      });
      const notificationId = await this.notify(
        criticCalibration(this.deps.humanId, {
          date: now.slice(0, 10),
          sessionId: session.id,
          error: reason,
        }),
      );
      return {
        status: "failed",
        reason,
        monthKey,
        report: null,
        previous,
        drift: null,
        sessionId: session.id,
        notificationId,
      };
    };
    // The report is written here, on success only, so a failed month leaves no file behind
    // and the next run (or `force`) is not deduped away by a report that never counted.
    let report: CalibrationReport;
    try {
      report = await calibrate({
        evalSet,
        tier: settings.tier,
        critic: this.deps.critic,
        ctx: { sessionToken, budget, projectSettings: null, persist: false },
        evals,
        clock,
        write: false,
        signal: opts.signal,
      });
    } catch (e) {
      const code = e instanceof ForerunnerError ? e.code : "internal";
      return failed(`${code}: ${errorMessage(e)}`);
    }
    // A review that did not complete (the budget or the provider refused, a timeout) got a
    // conservative verdict, which would count as a catch or a miss: the month is reported as
    // failed with the outcomes, never as a rate.
    const outcomes = report.tasks
      .flatMap((t) => [t.clean.outcome, t.seeded?.outcome ?? "completed"])
      .filter((o) => o !== "completed");
    if (outcomes.length > 0) {
      const kinds = [...new Set(outcomes)].sort().join(", ");
      return failed(
        `review_errors: ${outcomes.length} of ${report.cost.reviews} reviews did not complete (${kinds})`,
      );
    }
    report.file = this.write(report);
    const drift: CalibrationDrift = previous
      ? {
          since: previous.date,
          catchRatePoints: points(report.catchRate) - points(previous.catchRate),
          passRatePoints: points(report.passRate) - points(previous.passRate),
        }
      : { since: null, catchRatePoints: null, passRatePoints: null };
    const summary = formatCalibrationReport(report).split("\n")[0] ?? "";
    await this.close(session.id, "completed", summary, report.cost.usdMicro);
    await store.auditLog.append({
      session_id: session.id,
      run_id: null,
      agent_id: this.deps.criticAgentId,
      human_id: this.deps.humanId,
      tool: CALIBRATION_AUDIT_TOOL,
      input_summary: input,
      result_summary: JSON.stringify({
        ...report.counts,
        catchRate: report.catchRate,
        passRate: report.passRate,
        gateOk: report.gate.ok,
        file: report.file,
        drift,
      }),
      allowed: true,
      denied_reason: null,
      cost_usd_micro: report.cost.usdMicro,
      occurred_at: clock.nowIso(),
      token_id: sessionToken.claims.id,
      author_agent: this.deps.criticAgentId,
    });
    const notificationId = await this.notify(
      criticCalibration(this.deps.humanId, {
        date: report.date,
        sessionId: session.id,
        catchRate: report.catchRate,
        passRate: report.passRate,
        counts: report.counts,
        gateOk: report.gate.ok,
        thresholds: report.thresholds,
        drift,
        model: report.model,
        tier: report.tier,
        reviews: report.cost.reviews,
        costUsdMicro: report.cost.usdMicro,
        file: report.file,
      }),
    );
    this.logger.info("calibration finished", {
      sessionId: session.id,
      catchRate: pct(report.catchRate),
      passRate: pct(report.passRate),
      ok: report.gate.ok,
      drift: calibrationDriftLine(drift),
      file: report.file,
    });
    return {
      status: "ran",
      monthKey,
      report,
      previous,
      drift,
      sessionId: session.id,
      notificationId,
    };
  }

  private write(report: CalibrationReport): string | null {
    try {
      mkdirSync(this.deps.outDir, { recursive: true });
      let file = join(this.deps.outDir, calibrationFileName(report.date));
      if (existsSync(file)) {
        file = join(
          this.deps.outDir,
          calibrationFileName(report.date, report.startedAt.slice(11, 19).replace(/:/g, "")),
        );
      }
      writeFileSync(file, `${JSON.stringify({ ...report, file }, null, 2)}\n`, "utf8");
      return file;
    } catch (e) {
      this.logger.warn("could not write the calibration report", { error: errorMessage(e) });
      return null;
    }
  }

  private async close(
    sessionId: string,
    status: "completed" | "failed",
    summary: string,
    spentUsdMicro: number,
  ): Promise<void> {
    try {
      const row = await this.deps.store.session.mustGet(sessionId);
      await this.deps.store.session.update(sessionId, row.version, {
        status,
        summary,
        spent_usd_micro: spentUsdMicro,
        ended_at: this.deps.clock.nowIso(),
      });
    } catch (e) {
      this.logger.warn("could not close the calibration session", {
        sessionId,
        error: errorMessage(e),
      });
    }
  }

  private async notify(n: ReturnType<typeof criticCalibration>): Promise<string | null> {
    if (!this.deps.notifier) return null;
    try {
      return (await this.deps.notifier.notify(n)).id;
    } catch (e) {
      this.logger.warn("calibration notification failed", { error: errorMessage(e) });
      return null;
    }
  }
}

/** The evals port through the critic package's dynamic import (it has the dev dependency). */
export async function loadCalibrationEvals(): Promise<CalibrationEvalsPort> {
  const port = await loadEvalsPort();
  if (!port.loadEvalSet)
    throw new ForerunnerError("not_supported", "the evals port has no eval set loader");
  return { ...port, loadEvalSet: port.loadEvalSet };
}
