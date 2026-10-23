/**
 * The monthly handover test (spec P.15: "Monthly, a fresh agent with only the repo and docs
 * makes a small seeded change. Where it gets stuck becomes a docs task."; ADR 0060).
 *
 * On a project whose `settings.handover.enabled` is true, once per month (`Schedule` kind
 * "monthly", off until a project is flagged), the job:
 *
 * 1. creates a NEW principal agent row for the human (`Handover <date>`): no lesson row names
 *    it, so its private memory is empty, and the session runs without a memory port at all
 *    (nothing recalled from the shared scopes either: the docs alone must carry it);
 * 2. files the seeded change as a task (`settings.handover.seed`, else `defaultHandoverSeed`)
 *    and runs ONE session of the fresh agent on the project through `runSession`, whose
 *    planner is `SeedOnlyPlanner` so the session touches no other ready task;
 * 3. reads the fresh agent's audit rows of that session and turns every stuck place into
 *    a line (`stuckPlaces`): a file read more than once, a tool call that failed, a call the
 *    hooks refused, the task ending needs_human or failed, the session ending failed;
 * 4. files ONE docs task on the project with the file names in its description
 *    (`docsTaskFor`), when there was any stuck place;
 * 5. writes the report under `<data dir>/handover/<project>/handover-<date>.json`, sends it
 *    to the human's inbox as a message from the fresh agent, raises a `handover_report`
 *    notification, writes a `handover.run` audit row, cancels the seeded task if the session
 *    left it active (it never becomes regular work) and retires the fresh agent.
 *
 * The month's report file is the dedupe across restarts (the scheduler's fired keys are the
 * first line); `force` runs again. A project below autonomy 2 is skipped with the reason
 * (a level 0 or 1 session only files its plan and runs nothing).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  join,
  log,
  safeSegment,
} from "@forerunner/platform";
import {
  ACTIVE_TASK_STATUSES,
  type AuditLogRow,
  type JsonObject,
  type ProjectRow,
  type SessionStatus,
  type StateStore,
  type TaskStatus,
} from "@forerunner/state";
import type { NotifierLike } from "../notifications/producers.ts";
import { handoverReport as handoverReportNotification } from "../notifications/producers.ts";
import type { Planner, PlannerContext, SessionPlan, SessionResult } from "../session/runner.ts";
import type { Schedule, Scheduler, StartRequest } from "../session/triggers.ts";
import { defaultHandoverSeed, type HandoverSeed, handoverSeedOf } from "./handover-seed.ts";

/** The scheduler entry's sentinel agent id, like the model watch's. */
export const HANDOVER_AGENT_ID = "handover-test";
export const HANDOVER_SETTINGS_KEY = "handover";
export const HANDOVER_AUDIT_TOOL = "handover.run";
export const DEFAULT_HANDOVER_DAY = 1;
export const DEFAULT_HANDOVER_TIME = "07:00";
export const DEFAULT_HANDOVER_BUDGET_USD_MICRO = 5_000_000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STUCK_KINDS = [
  "reread",
  "failed",
  "refused",
  "task_needs_human",
  "task_failed",
  "session_failed",
] as const;

export function handoverScheduleId(projectId: string): string {
  return `handover:${projectId}`;
}

export interface HandoverSettings {
  enabled: true;
  day: number;
  time: string;
  budgetUsdMicro: number;
  /** The seed the project names; null means `defaultHandoverSeed(date)`. */
  seed: HandoverSeed | null;
}

/** `settings.handover` of a project; null unless `enabled` is exactly true (off by default). */
export function handoverSettingsOf(
  settings: JsonObject | null | undefined,
): HandoverSettings | null {
  const raw = settings?.[HANDOVER_SETTINGS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.enabled !== true) return null;
  const day =
    typeof s.day === "number" && Number.isFinite(s.day)
      ? Math.min(31, Math.max(1, Math.trunc(s.day)))
      : DEFAULT_HANDOVER_DAY;
  const time = typeof s.time === "string" && HHMM.test(s.time) ? s.time : DEFAULT_HANDOVER_TIME;
  const budgetUsdMicro =
    typeof s.budget_usd === "number" && Number.isFinite(s.budget_usd) && s.budget_usd > 0
      ? Math.round(s.budget_usd * 1_000_000)
      : DEFAULT_HANDOVER_BUDGET_USD_MICRO;
  return { enabled: true, day, time, budgetUsdMicro, seed: handoverSeedOf(s.seed) };
}

export function scheduleHandover(
  scheduler: Scheduler,
  opts: { projectId: string; timezone: string; day?: number; time?: string; enabled?: boolean },
): Schedule {
  const schedule: Schedule = {
    id: handoverScheduleId(opts.projectId),
    agentId: HANDOVER_AGENT_ID,
    projectId: opts.projectId,
    kind: "monthly",
    dayOfMonth: opts.day ?? DEFAULT_HANDOVER_DAY,
    time: opts.time ?? DEFAULT_HANDOVER_TIME,
    timezone: opts.timezone,
    enabled: opts.enabled ?? true,
  };
  scheduler.add(schedule);
  return schedule;
}

/**
 * One monthly schedule per project whose settings enable the handover, none for the rest:
 * entries of projects that disabled it or are gone are removed. Returns the scheduled ids.
 */
export function syncHandoverSchedules(
  scheduler: Scheduler,
  projects: readonly Pick<ProjectRow, "id" | "settings">[],
  timezone: string,
): string[] {
  const wanted = new Map<string, HandoverSettings>();
  for (const p of projects) {
    const s = handoverSettingsOf(p.settings);
    if (s) wanted.set(p.id, s);
  }
  for (const s of scheduler.list()) {
    if (!s.id.startsWith("handover:")) continue;
    if (!s.projectId || !wanted.has(s.projectId)) scheduler.remove(s.id);
  }
  for (const [projectId, s] of wanted)
    scheduleHandover(scheduler, { projectId, timezone, day: s.day, time: s.time });
  return [...wanted.keys()];
}

export function isHandoverRequest(req: StartRequest): boolean {
  return req.agentId === HANDOVER_AGENT_ID && !!req.projectId;
}

/** The planner of a handover session: the seeded task alone, nothing else the project holds. */
export class SeedOnlyPlanner implements Planner {
  constructor(
    private readonly taskId: string,
    private readonly inner: Planner,
  ) {}
  plan(ctx: PlannerContext): Promise<SessionPlan> {
    return this.inner.plan({
      ...ctx,
      readyTasks: ctx.readyTasks.filter((t) => t.id === this.taskId),
    });
  }
}

export type StuckKind = (typeof STUCK_KINDS)[number];

export interface StuckPlace {
  kind: StuckKind;
  /** The files involved (the path of the call, or the seed's files for a task or session end). */
  files: string[];
  tool?: string;
  /** For `reread`: how many times the file was read. */
  count?: number;
  /** For `failed` and `refused`: the error or the hooks' reason, cut short. */
  detail?: string;
}

/** The `path` of an audit row's input summary, which may be cut short (`…(N chars)`). */
function pathOf(inputSummary: string): string | null {
  try {
    const parsed = JSON.parse(inputSummary) as { path?: unknown };
    return typeof parsed.path === "string" ? parsed.path : null;
  } catch {
    const m = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(inputSummary);
    return m?.[1] ? JSON.parse(`"${m[1]}"`) : null;
  }
}

function cut(s: string, max = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * The stuck-place rule (ADR 0060) over the audit rows of one session: only the fresh agent's
 * rows count (the critic's reads are its own business); a `read_file` of the same path more
 * than once is a re-read; an allowed call whose result starts with `ERROR:` failed; a row the
 * hooks refused is `refused` with the reason; then the seeded task's end and the session's end.
 */
export function stuckPlaces(
  rows: readonly AuditLogRow[],
  facts: {
    agentId: string;
    seedFiles: readonly string[];
    taskStatus: TaskStatus;
    sessionStatus: SessionStatus;
  },
): StuckPlace[] {
  const own = rows.filter((r) => r.agent_id === facts.agentId);
  const reads = new Map<string, number>();
  const failed: StuckPlace[] = [];
  const refused: StuckPlace[] = [];
  for (const r of own) {
    const path = pathOf(r.input_summary);
    if (!r.allowed) {
      refused.push({
        kind: "refused",
        tool: r.tool,
        files: path ? [path] : [],
        detail: cut(r.denied_reason ?? "refused"),
      });
      continue;
    }
    if (r.tool === "read_file" && path) reads.set(path, (reads.get(path) ?? 0) + 1);
    if (/^ERROR:/.test(r.result_summary))
      failed.push({
        kind: "failed",
        tool: r.tool,
        files: path ? [path] : [],
        detail: cut(r.result_summary),
      });
  }
  const out: StuckPlace[] = [];
  for (const [file, count] of reads)
    if (count > 1) out.push({ kind: "reread", tool: "read_file", files: [file], count });
  out.push(...failed, ...refused);
  const seedFiles = [...facts.seedFiles];
  if (facts.taskStatus === "needs_human") out.push({ kind: "task_needs_human", files: seedFiles });
  if (facts.taskStatus === "failed") out.push({ kind: "task_failed", files: seedFiles });
  if (facts.sessionStatus === "failed" || facts.sessionStatus === "killed")
    out.push({ kind: "session_failed", files: seedFiles });
  return out;
}

export function describeStuckPlace(p: StuckPlace): string {
  const files = p.files.join(", ");
  switch (p.kind) {
    case "reread":
      return `${files} read ${p.count} times`;
    case "failed":
      return `${p.tool}${files ? ` ${files}` : ""} failed: ${p.detail}`;
    case "refused":
      return `${p.tool}${files ? ` ${files}` : ""} refused: ${p.detail}`;
    case "task_needs_human":
      return `the seeded task ended needs_human (${files})`;
    case "task_failed":
      return `the seeded task ended failed (${files})`;
    case "session_failed":
      return `the session ended failed (${files})`;
  }
}

/** The docs task the stuck places become: the files in the description, one criterion each. */
export function docsTaskFor(
  stuck: readonly StuckPlace[],
  facts: { date: string; seedTitle: string },
): { title: string; outcome: string; acceptance_criteria: string[] } {
  const files = [...new Set(stuck.flatMap((p) => p.files))];
  const lines = stuck.map((p) => `- ${describeStuckPlace(p)}`);
  return {
    title: `Docs: where the handover agent got stuck (${facts.date})`,
    outcome: [
      `A fresh agent with only the repository and its docs ran "${facts.seedTitle}" on ${facts.date} and got stuck at ${stuck.length} place${stuck.length === 1 ? "" : "s"}:`,
      ...lines,
      "README.md or a file under docs/ says what the agent had to find out by trial, so the next one reads it once and does not fail there.",
    ].join("\n"),
    acceptance_criteria: [
      ...files.map(
        (f) => `README.md or a file under docs/ explains ${f} so a new agent reads it once`,
      ),
      "The next handover run has no stuck place at these files",
    ],
  };
}

export interface HandoverReport {
  date: string;
  monthKey: string;
  projectId: string;
  projectName: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  taskId: string;
  seed: { title: string; files: string[]; source: "setting" | "default" };
  session: {
    status: SessionStatus;
    completed: string[];
    needsHuman: string[];
    failed: string[];
    spentUsdMicro: number;
    summary: string;
  };
  task: { status: TaskStatus; prUrl: string | null };
  /** The lessons the session loaded; null when it ran without a memory port (always, ADR 0060). */
  memory: { tokens: number; lessons: number } | null;
  stuck: StuckPlace[];
  docsTaskId: string | null;
  file: string | null;
}

export interface HandoverReportSummary {
  date: string;
  file: string;
  projectId: string;
  stuck: number;
  docsTaskId: string | null;
  sessionStatus: SessionStatus;
}

export interface HandoverRunResult {
  status: "ran" | "skipped" | "failed";
  reason?: string;
  monthKey: string;
  report: HandoverReport | null;
  messageId: string | null;
  notificationId: string | null;
}

export interface HandoverSessionRequest {
  agentId: string;
  projectId: string;
  taskId: string;
  budgetCapUsdMicro: number;
}

export interface HandoverJobDeps {
  store: StateStore;
  clock: Clock;
  humanId: string;
  /** The principal agent: author of the seeded task and the docs task. */
  agentId: string;
  /**
   * One session of the fresh agent on the project, planned over the seeded task alone and
   * without a memory port (`SeedOnlyPlanner`; the composition root builds that runner).
   */
  runSession: (req: HandoverSessionRequest) => Promise<SessionResult>;
  /** `<data dir>/handover`. */
  reportDir: string;
  notifier?: NotifierLike;
}

export function formatHandoverReport(r: HandoverReport): string {
  const lines = [
    `Handover test ${r.date} on ${r.projectName}: "${r.seed.title}" by a fresh agent (${r.agentName}, no memory).`,
    `Session ${r.sessionId} ${r.session.status}: ${r.session.completed.length} done, ${r.session.needsHuman.length} need you, ${r.session.failed.length} failed; task ${r.task.status}${r.task.prUrl ? ` (${r.task.prUrl})` : ""}; USD ${(r.session.spentUsdMicro / 1_000_000).toFixed(4)}.`,
  ];
  if (r.stuck.length === 0)
    lines.push("The agent got stuck nowhere: no stuck place, no docs task.");
  else {
    lines.push(`${r.stuck.length} stuck place${r.stuck.length === 1 ? "" : "s"}:`);
    for (const p of r.stuck) lines.push(`- ${describeStuckPlace(p)}`);
    if (r.docsTaskId) lines.push(`Docs task filed: ${r.docsTaskId}.`);
  }
  if (r.file) lines.push(`Report: ${r.file}`);
  return lines.join("\n");
}

export class HandoverJob {
  private readonly logger = log("handover-job");

  constructor(private readonly deps: HandoverJobDeps) {}

  private projectDir(projectId: string): string {
    return join(this.deps.reportDir, safeSegment(projectId));
  }

  /** This month's report file of the project, if one exists (the dedupe across restarts). */
  private reportThisMonth(projectId: string, monthKey: string): string | null {
    const dir = this.projectDir(projectId);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(`handover-${monthKey}`) && f.endsWith(".json"))
      .sort();
    const last = files.at(-1);
    return last ? join(dir, last) : null;
  }

  /** The project's reports, newest first. */
  reports(projectId: string): HandoverReportSummary[] {
    const dir = this.projectDir(projectId);
    if (!existsSync(dir)) return [];
    const out: HandoverReportSummary[] = [];
    for (const f of readdirSync(dir)
      .filter((f) => f.startsWith("handover-") && f.endsWith(".json"))
      .sort()
      .reverse()) {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as HandoverReport;
        out.push({
          date: r.date,
          file: join(dir, f),
          projectId: r.projectId,
          stuck: r.stuck.length,
          docsTaskId: r.docsTaskId,
          sessionStatus: r.session.status,
        });
      } catch (e) {
        this.logger.warn("unreadable handover report", { file: f, error: errorMessage(e) });
      }
    }
    return out;
  }

  async run(
    projectId: string,
    opts: { force?: boolean; seed?: HandoverSeed } = {},
  ): Promise<HandoverRunResult> {
    const { store, clock } = this.deps;
    const now = clock.nowIso();
    const date = now.slice(0, 10);
    const monthKey = now.slice(0, 7);
    const skip = (reason: string): HandoverRunResult => {
      this.logger.info("handover skipped", { projectId, reason });
      return {
        status: "skipped",
        reason,
        monthKey,
        report: null,
        messageId: null,
        notificationId: null,
      };
    };
    const project = await store.project.mustGet(projectId);
    const settings = handoverSettingsOf(project.settings);
    if (!settings) return skip("not_enabled");
    if (!opts.force && this.reportThisMonth(projectId, monthKey)) return skip("already_ran");
    if (project.autonomy_level < 2) return skip("autonomy_too_low");
    const seedSource = opts.seed ? "setting" : settings.seed ? "setting" : "default";
    const seed = opts.seed ?? settings.seed ?? defaultHandoverSeed(date);

    // 1. The fresh agent: a new row, nothing in memory names it. Agent names are unique per
    // human, so a second run on the same day (forced, or after a run that failed) counts up.
    let name = `Handover ${date}`;
    for (let n = 2; await store.agent.byName(this.deps.humanId, name); n++)
      name = `Handover ${date} (${n})`;
    const fresh = await store.agent.insert({
      name,
      owner_human_id: this.deps.humanId,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
      author_agent: this.deps.agentId,
    });
    const lessons = await store.lesson.search({
      scope: "agent_private",
      ownerAgentId: fresh.id,
    });
    if (lessons.length > 0)
      throw new ForerunnerError("internal", "a new agent row already has lessons", {
        details: { agentId: fresh.id, lessons: lessons.length },
      });

    // 2. The seeded change as the one task of the session. Its budget is half the session
    // cap (the plan is cut to the cap minus the review reserve; a task budgeted at the whole
    // cap would never be planned) and its estimate a quarter.
    const task = await store.task.insert({
      project_id: projectId,
      title: seed.title,
      outcome: seed.outcome,
      acceptance_criteria: [...seed.acceptanceCriteria],
      risk_tier: seed.riskTier,
      status: "ready",
      priority: 10,
      depends_on: [],
      budget_usd_micro: Math.round(settings.budgetUsdMicro / 2),
      est_cost_usd_micro: Math.round(settings.budgetUsdMicro / 4),
      actual_cost_usd_micro: 0,
      attempt: 0,
      specialist: seed.specialist ?? null,
      reason: `handover test ${date}: the seeded change (${seedSource} seed)`,
      author_agent: this.deps.agentId,
    });
    let result: SessionResult;
    try {
      result = await this.deps.runSession({
        agentId: fresh.id,
        projectId,
        taskId: task.id,
        budgetCapUsdMicro: settings.budgetUsdMicro,
      });
    } catch (e) {
      const reason = errorMessage(e);
      this.logger.error("handover session failed to run", { projectId, error: reason });
      await this.cancelSeed(task.id, `handover test ${date}: the session did not run`);
      await this.retire(fresh.id);
      await store.auditLog.append({
        session_id: null,
        run_id: null,
        agent_id: fresh.id,
        human_id: this.deps.humanId,
        tool: HANDOVER_AUDIT_TOOL,
        input_summary: JSON.stringify({ projectId, taskId: task.id, seed: seed.title }),
        result_summary: "",
        allowed: false,
        denied_reason: reason,
        cost_usd_micro: 0,
        occurred_at: clock.nowIso(),
        token_id: null,
        author_agent: fresh.id,
      });
      return {
        status: "failed",
        reason,
        monthKey,
        report: null,
        messageId: null,
        notificationId: null,
      };
    }

    // 3. The stuck places off the audit rows of the fresh agent.
    const taskAfter = await store.task.mustGet(task.id);
    const rows = await store.auditLog.list({ sessionId: result.sessionId }, { limit: 10_000 });
    const stuck = stuckPlaces(rows, {
      agentId: fresh.id,
      seedFiles: seed.files,
      taskStatus: taskAfter.status,
      sessionStatus: result.status,
    });

    // 4. One docs task with the file names, when the agent got stuck anywhere.
    let docsTaskId: string | null = null;
    if (stuck.length > 0) {
      const docs = docsTaskFor(stuck, { date, seedTitle: seed.title });
      const row = await store.task.insert({
        project_id: projectId,
        title: docs.title,
        outcome: docs.outcome,
        acceptance_criteria: docs.acceptance_criteria,
        risk_tier: 1,
        status: "ready",
        priority: 5,
        depends_on: [],
        budget_usd_micro: 0,
        est_cost_usd_micro: 0,
        actual_cost_usd_micro: 0,
        attempt: 0,
        reason: `handover test ${date}: the docs the fresh agent missed`,
        author_agent: this.deps.agentId,
      });
      docsTaskId = row.id;
    }

    // 5. The report: a dated file, the inbox, a notification, an audit row; the agent retired.
    const report: HandoverReport = {
      date,
      monthKey,
      projectId,
      projectName: project.name,
      agentId: fresh.id,
      agentName: fresh.name,
      sessionId: result.sessionId,
      taskId: task.id,
      seed: { title: seed.title, files: [...seed.files], source: seedSource },
      session: {
        status: result.status,
        completed: result.completed,
        needsHuman: result.needsHuman,
        failed: result.failed,
        spentUsdMicro: result.spentUsdMicro,
        summary: result.summary,
      },
      task: { status: taskAfter.status, prUrl: taskAfter.pr_url },
      memory: result.memory
        ? { tokens: result.memory.tokens, lessons: result.memory.lessons }
        : null,
      stuck,
      docsTaskId,
      file: null,
    };
    report.file = this.write(report);
    const body = formatHandoverReport(report);
    const message = await store.message.send({
      from_agent_id: fresh.id,
      to_human_id: this.deps.humanId,
      project_id: projectId,
      type: "info",
      body,
      requires_ack: false,
      author_agent: fresh.id,
    });
    let notificationId: string | null = null;
    if (this.deps.notifier) {
      try {
        const rec = await this.deps.notifier.notify(
          handoverReportNotification(this.deps.humanId, {
            date,
            projectId,
            projectName: project.name,
            sessionId: result.sessionId,
            stuck: stuck.length,
            docsTaskId,
            status: result.status,
            summary: body,
          }),
        );
        notificationId = rec.id;
      } catch (e) {
        this.logger.warn("handover notification failed", { error: errorMessage(e) });
      }
    }
    await store.auditLog.append({
      session_id: result.sessionId,
      run_id: null,
      agent_id: fresh.id,
      human_id: this.deps.humanId,
      tool: HANDOVER_AUDIT_TOOL,
      input_summary: JSON.stringify({ projectId, taskId: task.id, seed: seed.title }),
      result_summary: JSON.stringify({
        session: result.status,
        task: taskAfter.status,
        stuck: stuck.length,
        docsTaskId,
        file: report.file,
      }),
      allowed: true,
      denied_reason: null,
      cost_usd_micro: result.spentUsdMicro,
      occurred_at: clock.nowIso(),
      token_id: null,
      author_agent: fresh.id,
    });
    // A seeded task the session left active (not planned, stopped by the budget) is cancelled:
    // the test is over and the principal's own sessions must not pick the seed up.
    await this.cancelSeed(task.id, `handover test ${date}: over, the seed is not regular work`);
    await this.retire(fresh.id);
    this.logger.info("handover finished", {
      projectId,
      sessionId: result.sessionId,
      stuck: stuck.length,
      docsTaskId,
    });
    return { status: "ran", monthKey, report, messageId: message.id, notificationId };
  }

  private async cancelSeed(taskId: string, reason: string): Promise<void> {
    try {
      const row = await this.deps.store.task.mustGet(taskId);
      if (!ACTIVE_TASK_STATUSES.includes(row.status)) return;
      await this.deps.store.task.update(taskId, row.version, {
        status: "cancelled",
        claimed_by: null,
        claim_expires: null,
        reason,
      });
    } catch (e) {
      this.logger.warn("could not cancel the seeded task", { taskId, error: errorMessage(e) });
    }
  }

  private async retire(agentId: string): Promise<void> {
    try {
      const row = await this.deps.store.agent.mustGet(agentId);
      await this.deps.store.agent.update(agentId, row.version, { status: "retired" });
    } catch (e) {
      this.logger.warn("could not retire the handover agent", { agentId, error: errorMessage(e) });
    }
  }

  private write(report: HandoverReport): string | null {
    const dir = this.projectDir(report.projectId);
    try {
      mkdirSync(dir, { recursive: true });
      let file = join(dir, `handover-${report.date}.json`);
      if (existsSync(file)) {
        const time = this.deps.clock.nowIso().slice(11, 19).replace(/:/g, "");
        file = join(dir, `handover-${report.date}-${time}.json`);
      }
      writeFileSync(file, `${JSON.stringify({ ...report, file }, null, 2)}\n`, "utf8");
      return file;
    } catch (e) {
      this.logger.warn("could not write the handover report", { error: errorMessage(e) });
      return null;
    }
  }
}
