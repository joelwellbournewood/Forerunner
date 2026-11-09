import { CostLedger, DEFAULT_CHF_PER_USD, FixedRateSource } from "@forerunner/billing";
import type { CommandDef } from "@forerunner/commands";
import { spokenProjectSummary, staticRisk } from "@forerunner/commands";
import { NO_ACTION_GIVEN, saidByName } from "@forerunner/critic";
import { ForerunnerError, isAbsolute } from "@forerunner/platform";
import type {
  AgentRow,
  ChangeLogRow,
  EventRow,
  FindingRow,
  HumanRequestRow,
  LessonRow,
  MessageRow,
  MilestoneRow,
  ProjectRow,
  ReviewRow,
  RunRow,
  SessionRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import { ENTITIES, type EntityDef, Repository } from "@forerunner/state";
import {
  capEffort,
  DEFAULT_LADDER,
  effortForTask,
  INTAKE_RUN_SPECIALIST,
  type LadderRung,
  MODE_DEFAULTS,
  type Mode,
  type ModeDefault,
  modeEffort,
  speedQualityOffsetOf,
  tierOfModel,
} from "../models/ladder.ts";
import { type AgentModelConfig, modeOverride, specialistOverride } from "../models/run-settings.ts";
import { priorityLevel } from "../priority.ts";
import type { EffortLevel } from "../provider/types.ts";
import type { Registry } from "../registry/types.ts";
import { MID_SESSION_LIMIT_SETTING, midSessionLimitOf } from "../session/billing.ts";
import { countsList } from "../session/counts.ts";
import { CREDENTIAL_REFUSED_KEY } from "../session/credential-wait.ts";
import { runCapOf } from "../session/executor.ts";
import { aboutWords, moneyWords } from "../session/money-words.ts";
import { TASK_FILES_EVENT } from "../session/peers.ts";
import { defaultRiskTier } from "../session/project-plan.ts";
import {
  blockedOfHandoff,
  type EndedWaits,
  endedStatusText,
  stopReasonOfHandoff,
} from "../session/stop-words.ts";
import { StateLedgerStore } from "../wiring/billing-ports.ts";
import { ANSWER_CARD_KEYS, isChatOnlyCard, optionLabel } from "../wiring/request-answers.ts";
import { researchReadsLine, webAccessOf } from "../wiring/web-access.ts";
import type {
  AgentView,
  ChangeLogView,
  CommandDefView,
  CostView,
  EventView,
  FindingView,
  HumanRequestView,
  LessonView,
  MessageView,
  MilestoneView,
  Money,
  PerformanceModeView,
  PerformanceSampleView,
  PerformanceView,
  ProjectCard,
  ProjectSummary,
  ReviewsView,
  ReviewView,
  RunView,
  SessionView,
  TaskCheck,
  TaskDisplay,
  TaskView,
} from "./api-types.ts";
import { PERFORMANCE_DEFAULT_DAYS, PERFORMANCE_MAX_DAYS } from "./api-types.ts";
import {
  autonomyWords,
  chfOf,
  cutAtWord,
  decisionWords,
  eventAudience,
  fallbackLine,
  moreEventLines,
  personLine,
  plainLine,
  retryWords,
  reviewLevel,
  skipReason,
  verdictWords,
} from "./event-lines.ts";
import { projectHealth } from "./project-health.ts";
import {
  blockedTaskIds,
  overviewNext,
  type PlanState,
  progressOf,
  projectStatusLine,
  sinceLines,
  workingOn,
} from "./project-status.ts";
import { type RequestWordsContext, requestWords } from "./request-words.ts";
import { loadTaskDisplayContext, runOrder, taskDisplay, taskHeldWork } from "./task-display.ts";
import { plainPlurals, withoutIds } from "./task-words.ts";

/** An agent as `GET /agents` lists it and `POST /agents/:id/rename` answers it. */
export function agentView(a: AgentRow): AgentView {
  return {
    id: a.id,
    name: a.name,
    ownerHumanId: a.owner_human_id,
    kind: a.kind,
    status: a.status,
  };
}

export function money(usdMicro: number, chfPerUsd: number): Money {
  return { usdMicro, chfMicro: Math.round(usdMicro * chfPerUsd) };
}

/**
 * The open milestone of a project: the first `planned` or `active` row by order, the one the
 * plan writer joins in small-project mode. `done` and `cancelled` rows are closed, so a
 * milestone cancelled before the mode never shows as the card's next milestone.
 */
export function openMilestone<M extends Pick<MilestoneRow, "status">>(
  rows: readonly M[],
): M | undefined {
  return rows.find((m) => m.status === "planned" || m.status === "active");
}

/**
 * What the project card's status sentence needs beyond the store (design §2): whether the
 * Docker sandbox is ready, the plan from the brief, and where the project's files are.
 */
export interface ProjectCardFacts {
  sandboxReady: boolean | null;
  plan?: (projectId: string) => Promise<{
    state: PlanState;
    error: string | null;
    /** `waiting` (U-078): the status sentence's words and where a refused key is replaced. */
    wait?: { short: string; save: { label: string; to: string } | null } | null;
  }>;
  folder?: (project: ProjectRow) => string | null;
  /** The repository the project is linked to, with its page (`projectRepository`). */
  repository?: (project: ProjectRow) => { fullName: string; url: string } | null;
  /** Whether a Claude credential is in force (a failed plan's button: Try again or Connect). */
  hasModel?: boolean | null;
  /** Stop all is on: a ready project offers no Continue the Start dialog would refuse. */
  stopped?: boolean | null;
  /**
   * W15-67: why no ready task of the project can run now, when its credential rests or was
   * refused (`RuntimeApp.billing.waits.now`, read only; the Start check's words), recorded or
   * not; null when one would run. Asked only while a task is ready.
   */
  credentialWaitNow?: (projectId: string) => Promise<{
    text: string;
    save: { label: string; to: string } | null;
    startable?: boolean;
  } | null>;
}

export async function projectCard(
  store: StateStore,
  projectId: string,
  chfPerUsd: number,
  humanId: string,
  facts?: ProjectCardFacts,
): Promise<ProjectCard> {
  const p = await store.project.mustGet(projectId);
  const spend = await store.costLedger.sum({ projectId: p.id });
  const milestones = await store.milestone.forProject(p.id, { limit: 50 });
  const next = openMilestone(milestones);
  const tasks = await store.task.list({ project_id: p.id } as never, { limit: 1000 });
  const reviews = await store.review.list({} as never, {
    orderBy: [{ column: "created_at", direction: "desc" }],
    limit: 50,
  });
  const taskIds = new Set(tasks.map((t) => t.id));
  const latest = reviews.find((r) => r.task_id && taskIds.has(r.task_id));
  const failed = tasks.filter((t) => t.status === "failed").length;
  const { health, needsYou } = await projectHealth(store, p.id, humanId, tasks, failed);
  const last = (p.summary_cache as { last_session?: { ended_at?: string } }).last_session;
  // The status sentence (design §2), from the tasks, cards, plan and session as they are now.
  const ctx = await loadTaskDisplayContext(store, tasks, facts?.sandboxReady ?? null);
  const displays = new Map(tasks.map((t) => [t.id, taskDisplay(t, ctx)]));
  // The open cards as the Inbox shows them: the chat's read-back of an answer to a card is the
  // conversation's, never a second card (phase E, `isChatOnlyCard`), so the status sentence,
  // `waitingOnYou` and the Inbox's count say the same (design §5.4).
  const cards = (
    await store.humanRequest.list(
      { status: "open", project_id: p.id, human_id: humanId } as never,
      { orderBy: [{ column: "created_at" }, { column: "id" }], limit: 1000 },
    )
  ).filter((r) => !isChatOnlyCard(r));
  const waiting = cards.length;
  const plan = facts?.plan ? await facts.plan(p.id) : { state: null, error: null };
  // A repository project's work is on the repository and in its pull requests (ADR 0106): this
  // install's docs clone holds the default branch only, so it is not "your files".
  const repository = facts?.repository ? facts.repository(p) : null;
  const folder = !repository && facts?.folder ? facts.folder(p) : null;
  const working = await workingOn(store, p.id);
  // W15-67: the wait now, whether a Start kept it or not, only while a task is ready.
  const waitNow =
    facts?.credentialWaitNow && tasks.some((t) => displays.get(t.id)?.key === "ready")
      ? await facts.credentialWaitNow(p.id).catch(() => null)
      : null;
  const statusLine = projectStatusLine({
    projectId: p.id,
    tasks,
    displays,
    cards,
    plan: plan.state,
    planError: plan.error,
    planWait: "wait" in plan ? (plan.wait ?? null) : null,
    credentialWait: ctx.credentialWait ?? null,
    credentialWaitNow: waitNow,
    hasModel: facts?.hasModel ?? null,
    stopped: facts?.stopped ?? null,
    working,
    folder,
  });
  return {
    id: p.id,
    name: p.name,
    goal: p.goal,
    stage: p.stage,
    status: p.status,
    autonomyLevel: p.autonomy_level as 0 | 1 | 2 | 3 | 4,
    nextMilestone: next
      ? {
          id: next.id,
          name: next.name,
          targetDate: (next as { target_date?: string | null }).target_date ?? null,
        }
      : null,
    health,
    needsYou,
    spend: money(spend.usd_micro, chfPerUsd),
    budget: money(p.budget_usd_micro, chfPerUsd),
    waitingOnYou: waiting,
    latestCriticGrade: latest?.grade ?? null,
    lastSessionAt: last?.ended_at ?? null,
    active: p.active,
    smallProjectMode: p.small_project_mode,
    defaultRiskTier: defaultRiskTier(p),
    repos: p.repos,
    statusLine,
    progress: progressOf(tasks),
    working,
    folder,
    repository,
    // 'sites': "Research reads: any public website" (the Overview's line).
    researchReads: researchReadsLine(webAccessOf(p.settings)),
  };
}

export function milestoneView(m: MilestoneRow): MilestoneView {
  return {
    id: m.id,
    projectId: m.project_id,
    name: m.name,
    successCriteria: m.success_criteria,
    targetDate: m.target_date,
    status: m.status,
    orderIndex: m.order_index,
    reason: m.reason,
    authorAgent: m.author_agent,
    authorHuman: m.author_human,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    version: m.version,
  };
}

/**
 * "Since then: merged #2, #3 and #4." (merge-in-app, design §5 rule 4): the pull requests a
 * session left open (its handoff's merges) whose merge record says merged now, so the Overview
 * does not keep "Left 3 reviewed pull requests for you to merge" as if nothing happened since.
 */
async function mergedSinceLine(store: StateStore, handoff: unknown): Promise<string[]> {
  const merges = (handoff as { merges?: unknown } | null)?.merges;
  if (!Array.isArray(merges)) return [];
  const numbers: number[] = [];
  for (const m of merges as { task_id?: unknown; status?: unknown }[]) {
    if (typeof m?.task_id !== "string" || m.status === "merged") continue;
    const record = await store.mergeRecord.forTask(m.task_id).catch(() => undefined);
    if (record?.state === "merged" && record.pr_number) numbers.push(record.pr_number);
  }
  if (!numbers.length) return [];
  const names = [...new Set(numbers)].sort((a, b) => a - b).map((n) => `#${n}`);
  const list =
    names.length <= 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return [`Since then: merged ${list}.`];
}

export async function projectSummary(
  store: StateStore,
  projectId: string,
  chfPerUsd: number,
  facts?: Pick<ProjectCardFacts, "sandboxReady">,
): Promise<ProjectSummary> {
  const p = await store.project.mustGet(projectId);
  const s = p.summary_cache as {
    last_session?: { id: string; ended_at: string | null; summary: string; stop_reason: string };
    next_steps?: string[];
    open_questions?: number;
  };
  const spend = await store.costLedger.sum({ projectId: p.id });
  const next = s.next_steps ?? [];
  // One text for the screen's "Read aloud" and for the `summary.speak` command (spec A.6).
  const spoken = spokenProjectSummary(p, spend.usd_micro, chfPerUsd);
  // Design §3.4 "Next", computed when shown (§5 rule 4): the open tasks in run order, each
  // with its status in words, at most three, then "and N more".
  const tasks = await store.task.list({ project_id: p.id } as never, { limit: 2000 });
  const ctx = await loadTaskDisplayContext(store, tasks, facts?.sandboxReady ?? null);
  const nextLines = overviewNext(
    runOrder(tasks).map((task) => ({ task, display: taskDisplay(task, ctx) })),
  );
  // Design §3.4 "Your files": the files the last session changed.
  const changedFiles: string[] = [];
  if (s.last_session?.id) {
    for (const e of await store.event.list(s.last_session.id, 0, 10_000)) {
      if (e.type !== TASK_FILES_EVENT) continue;
      const files = (e.payload as { files?: unknown }).files;
      if (Array.isArray(files))
        for (const f of files)
          if (typeof f === "string" && !changedFiles.includes(f)) changedFiles.push(f);
    }
  }
  // What became of the tasks the session left waiting for the person (C-54, design §5 rule 4):
  // the summary is the record of the end ("… needs your decision (Inbox)"); once such a task
  // moved on (its card answered, Mark done anyway, a cancel), one line says what it is now.
  const lastRow = s.last_session?.id ? await store.session.get(s.last_session.id) : undefined;
  const since = lastRow
    ? [
        ...sinceLines(blockedTaskIds(lastRow.handoff), new Map(tasks.map((t) => [t.id, t])), (t) =>
          taskDisplay(t, ctx),
        ),
        // merge-in-app: the pull requests the session left open that are merged now (by the
        // person's Merge, the retry, or on GitHub); the result still says it left them.
        ...(await mergedSinceLine(store, lastRow.handoff)),
      ]
    : [];
  return {
    goal: p.goal,
    stage: p.stage,
    lastSession: s.last_session
      ? {
          id: s.last_session.id,
          endedAt: s.last_session.ended_at,
          summary: s.last_session.summary,
          stopReason: s.last_session.stop_reason,
          changedFiles,
          ...(since.length ? { since } : {}),
        }
      : null,
    nextSteps: next,
    next: nextLines,
    openQuestions: s.open_questions ?? 0,
    spend: money(spend.usd_micro, chfPerUsd),
    spoken,
  };
}

/**
 * A task as the UI shows it. `cap` is what a run of the task stops at (U-042): what is left of
 * the task's own budget, else the per-run limit of its specialist (`specialistLimit`: the
 * registry's `max_budget_usd` in micro-USD; the planner's default "coder" when the task names
 * none). Without a budget and without a known specialist, `capSource` is "unknown".
 */
export function taskView(
  t: TaskRow,
  chfPerUsd: number,
  specialistLimit?: (name: string) => number | undefined,
  /**
   * The status in words (`taskDisplay`) and the place in the run order, when known; `spentUsdMicro`:
   * what the cost ledger holds for the task, reviews included (W15-20), else its `actual`.
   */
  extra: {
    display?: TaskDisplay;
    runOrder?: number;
    check?: TaskCheck | null;
    spentUsdMicro?: number;
  } = {},
): TaskView {
  const limit = specialistLimit?.(t.specialist ?? "coder");
  const cap = t.budget_usd_micro > 0 || limit !== undefined ? runCapOf(t, limit ?? 0) : null;
  return {
    id: t.id,
    projectId: t.project_id,
    milestoneId: t.milestone_id,
    title: t.title,
    outcome: t.outcome,
    acceptanceCriteria: t.acceptance_criteria,
    riskTier: t.risk_tier as 0 | 1 | 2 | 3,
    status: t.status,
    // The level, never the stored number (U-041); old rows read as theirs.
    priority: priorityLevel(t.priority),
    claimedBy: t.claimed_by,
    claimExpires: t.claim_expires,
    dependsOn: t.depends_on,
    budget: money(t.budget_usd_micro, chfPerUsd),
    estimate: money(t.est_cost_usd_micro, chfPerUsd),
    actual: money(t.actual_cost_usd_micro, chfPerUsd),
    spent: money(extra.spentUsdMicro ?? t.actual_cost_usd_micro, chfPerUsd),
    cap: money(cap?.usdMicro ?? 0, chfPerUsd),
    capSource: cap?.source ?? "unknown",
    specialist: t.specialist,
    attempt: t.attempt,
    prUrl: t.pr_url,
    branch: t.branch,
    reason: t.reason,
    updatedAt: t.updated_at,
    version: t.version,
    ...(extra.display ? { display: extra.display } : {}),
    ...(extra.runOrder !== undefined ? { runOrder: extra.runOrder } : {}),
    ...(extra.check !== undefined ? { check: extra.check } : {}),
  };
}

export function runView(
  r: RunRow,
  chfPerUsd: number,
  task?: TaskRow,
  verdict?: { id: string; verdict: string } | null,
): RunView {
  return {
    id: r.id,
    taskId: r.task_id,
    taskTitle: task?.title ?? null,
    sessionId: r.session_id,
    specialist: r.specialist,
    model: r.model,
    provider: r.provider,
    effort: r.effort,
    promptVersion: r.prompt_version,
    billingSourceId: r.billing_source_id,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    cost: money(r.cost_usd_micro, chfPerUsd),
    ttftMs: r.ttft_ms,
    durationMs: r.duration_ms,
    outcome: r.outcome,
    verdict: verdict?.verdict ?? null,
    reviewId: verdict?.id ?? null,
    prUrl: task?.pr_url ?? null,
    createdAt: r.created_at,
  };
}

/**
 * How many of the tasks a session left waiting for the person (`handoff.blocked`) still wait
 * now (L-21): a task the person answered, retried or merged since does not ("Ended: 1 task
 * needs you" stayed on the page after the retry and the merge).
 */
export async function stillBlocked(store: StateStore, handoff: unknown): Promise<EndedWaits> {
  const ids = blockedTaskIds(handoff);
  // W15B-10: a task the session left paused at a budget is said as paused (the log's end line
  // "Session over: 2 paused."), not as needing the person, while it still waits on its card.
  const pausedIds = new Set(
    Array.isArray((handoff as { paused?: unknown } | null)?.paused)
      ? ((handoff as { paused: unknown[] }).paused.filter((x) => typeof x === "string") as string[])
      : [],
  );
  const out: EndedWaits = { needYou: 0, paused: 0 };
  for (const id of new Set(ids)) {
    const t = await store.task.get(id);
    if (!t || (t.status !== "needs_human" && t.status !== "failed")) continue;
    if (pausedIds.has(id) && t.status === "needs_human") out.paused += 1;
    else out.needYou += 1;
  }
  return out;
}

export function sessionView(
  s: SessionRow,
  agentName: string,
  chfPerUsd: number,
  current: SessionView["currentTask"] = null,
  /** The tasks it left waiting that still wait now (`stillBlocked`); absent: as it left them. */
  blockedNow?: number | EndedWaits,
): SessionView {
  return {
    id: s.id,
    agentId: s.agent_id,
    agentName,
    projectId: s.project_id,
    trigger: s.trigger,
    status: s.status,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    budgetCap: money(s.budget_cap_usd_micro, chfPerUsd),
    spent: money(s.spent_usd_micro, chfPerUsd),
    stepCap: s.step_cap,
    steps: s.steps,
    currentTask: current,
    summary: s.summary,
    handoff: s.handoff,
    runner: s.runner,
    // How it ended, in words (session-engine, design §3.7).
    stopReason: stopReasonOfHandoff(s.handoff),
    // "Ended: 1 task needs you" when it finished with tasks waiting for the person.
    statusText: endedStatusText(
      s.status,
      stopReasonOfHandoff(s.handoff),
      blockedNow ?? blockedOfHandoff(s.handoff),
    ),
  };
}

/**
 * The views of a session's events, in order. A line about a task names it (design §5 rule 3):
 * events written before they carried the task's title and specialist (`task.finished`,
 * `critic.verdict` from before the core-experience round) take them from the task's
 * `task.started` line in the same log.
 */
export function eventViews(rows: readonly EventRow[], chfPerUsd: number): EventView[] {
  const named = new Map<string, { title: string; specialist: string }>();
  return rows.map((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const taskId = typeof p.taskId === "string" ? p.taskId : null;
    if (e.type === "task.started" && taskId && typeof p.title === "string")
      named.set(taskId, {
        title: p.title,
        specialist: typeof p.specialist === "string" ? p.specialist : "",
      });
    const known = taskId ? named.get(taskId) : undefined;
    if (!known || (typeof p.title === "string" && (p.specialist || e.type !== "task.finished")))
      return eventView(e, chfPerUsd);
    const filled = {
      ...p,
      title: typeof p.title === "string" ? p.title : known.title,
      ...(e.type === "task.finished" && !p.specialist && known.specialist
        ? { specialist: known.specialist }
        : {}),
    };
    return { ...eventView(e, chfPerUsd), text: describeEvent(e.type, filled, chfPerUsd) };
  });
}

export function eventView(e: EventRow, chfPerUsd: number): EventView {
  const payload = (e.payload ?? {}) as Record<string, unknown>;
  const level: EventView["level"] = /error|failed/.test(e.type)
    ? "error"
    : /escalat/.test(e.type) || payload.escalation
      ? "escalation"
      : /warning|skipped|paused|killed|budget|plan_filed|fallback/.test(e.type) ||
          typeof payload.warning === "string"
        ? "warning"
        : "info";
  return {
    id: e.id,
    sessionId: e.session_id,
    seq: e.seq,
    type: e.type,
    text: describeEvent(e.type, payload, chfPerUsd),
    payload: e.payload,
    cost: money(e.cost_usd_micro, chfPerUsd),
    at: e.created_at,
    level,
    audience: eventAudience(e.type, payload),
  };
}

/**
 * The session log's sentence for an event (spec K.3; design §3.7, §5): plain words, money in
 * CHF at `chfPerUsd` (U-074). A person-level event (`eventAudience`) reads the way a person
 * follows a session (`personLine`); the rest are worded here or by `moreEventLines`
 * (`event-lines.ts`) for Details, and an unknown type by `fallbackLine`: never raw JSON, never
 * "(s)", never a notification channel that was not set up.
 */
export function describeEvent(
  type: string,
  p: Record<string, unknown>,
  chfPerUsd: number = DEFAULT_CHF_PER_USD,
): string {
  // Whatever a line quotes (a warning, a reason the runner wrote) is read without ids and
  // with plurals as the number says.
  return plainPlurals(withoutIds(lineOf(type, p, chfPerUsd)));
}

/** A clause as a sentence of its own: a capital first, a full stop last (W15-60). */
function sentenceOf(text: string): string {
  const t = text.trim().replace(/[.\s]+$/, "");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : "";
}

function lineOf(type: string, p: Record<string, unknown>, chfPerUsd: number): string {
  if (eventAudience(type, p) === "person") {
    const line = personLine(type, p, chfPerUsd);
    if (line) return line;
  }
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : 0);
  const chf = (k: string) => chfOf(n(k), chfPerUsd);
  const count = (k: string, one: string, many = `${one}s`) => `${n(k)} ${n(k) === 1 ? one : many}`;
  switch (type) {
    case "session.started":
      return `Session started (${s("trigger")}), budget ${chf("budgetCapUsdMicro")}, ${n("stepCap")} steps, autonomy ${autonomyWords(n("autonomy"))}.`;
    case "session.brief":
      return `State brief ready: ${n("unread")} unread, ${count("ready", "ready task")}${Array.isArray(p.warnings) && p.warnings.length ? `, warnings: ${(p.warnings as string[]).join("; ")}` : ""}.`;
    case "session.planned":
      // W15-60: the plan's summary is a sentence of its own, with a capital (before: "Plan: 1
      // task, about CHF 0.02. the first session you approved...").
      return `Plan: ${count("items", "task")}, ${aboutWords(chf("estimateUsdMicro"), n("estimateUsdMicro"))}.${s("summary") ? ` ${sentenceOf(cutAtWord(plainLine(s("summary")), 120))}` : ""}`;
    case "session.paused":
      return `Paused: ${s("reason")}.`;
    case "session.plan_filed":
      return `Plan filed for your approval in the Inbox (${count("items", "task")})${p.changed ? "; it changed since the plan you approved, nothing ran" : ""}.`;
    case "session.plan_approved":
      return `Running the plan you approved (${count("items", "task")}).`;
    case "task.started":
      // W15-60: a retry's start (a detail) reads as a first attempt's does: "The coder started
      // "X" (about CHF 0.02)." (before: 'Started "X" with coder (about ...)', the registry key).
      return (
        personLine(type, { ...p, again: false }, chfPerUsd) ??
        `Started "${s("title")}" (${aboutWords(chf("estimateUsdMicro"), n("estimateUsdMicro"))}).`
      );
    case "task.finished":
      // W15-60: a run the person's stop ended (a detail: their stop's own line says it) reads
      // "Stopped by you during ...", never "killed ... run stopped by its caller"; every other
      // outcome as the person's line, never the report's text ("Summary: ...").
      if (s("outcome") === "killed")
        return `Stopped by you during "${s("title") || "the task"}"${n("costUsdMicro") > 0 ? ` (${moneyWords(chf("costUsdMicro"), n("costUsdMicro"))})` : ""}.`;
      return (
        personLine(type, p, chfPerUsd) ??
        `Finished "${s("title") || "the task"}" (${moneyWords(chf("costUsdMicro"), n("costUsdMicro"))}).`
      );
    case "task.claims_released":
      return `Put ${count("count", "task")} back to ready: their claim had lapsed or no agent held it.`;
    case "task.skipped":
      return `Skipped a task: ${skipReason(s("reason"))}.`;
    case "task.notes":
      return `Gave ${count("count", "note")} for the next session to "${s("title")}".`;
    case "inbox.message":
      // A name, never an id (U-074): the runner adds `fromName`; older rows say "another agent".
      return `Read a ${s("type") || "new"} message from ${s("fromName") || "another agent"}.`;
    case "session.error":
      return `Error: ${s("code")} ${s("message")}`;
    case "session.ended":
      // The summary's six categories (U-072); `needsHuman` is absent on events before it.
      return `Session ended: ${s("status")} (${s("stopReason").replace(/_/g, " ")}), spent ${chf("spentUsdMicro")}: ${countsList(
        {
          done: n("completed"),
          failed: n("failed"),
          needsYou: n("needsHuman"),
          sentBack: n("retried"),
          inReview: n("inReview"),
          notStarted: n("skipped"),
        },
      )}.`;
    case "chat.human":
      return `You: ${s("text")}`;
    case "chat.reply":
      return `Agent: ${s("text")}`;
    case "chat.confirmed":
      return `Confirmed "${s("words")}": ${Array.isArray(p.commands) ? (p.commands as string[]).join(", ") : ""} (${s("status")}).`;
    case "chat.cancelled":
      return `Cancelled "${s("words")}".`;
    case "change":
      return s("sentence");
    case "critic.review_started":
      return `The critic started ${reviewLevel(n("tier"))} (attempt ${n("attempt") + 1}).`;
    case "critic.verdict":
      return `Critic: ${verdictWords(s("verdict"))} (grade ${n("grade")}, ${count("findings", "finding")}, ${n("openFindings")} open): ${criticNext(s("decision"), s("retry"), s("nextTier"))}. ${cutAtWord(plainLine(s("summary")), 200)}`;
    case "critic.review_failed":
      return `Critic review failed: ${s("warning")}`;
    case "critic.session_review_metrics": {
      const m = (p.metrics ?? {}) as Record<string, unknown>;
      const k = (key: string) => (typeof m[key] === "number" ? (m[key] as number) : 0);
      const done = `${k("plannedDoneTasks")} of ${k("plannedTasks")} planned ${k("plannedTasks") === 1 ? "task" : "tasks"} done`;
      const money = (key: string) => moneyWords(chfOf(k(key), chfPerUsd), k(key));
      // W15B-19: the work against the estimate, the reviews named apart (the estimate is the
      // work's: W15-18). Before: "CHF 0.10 spent of a CHF 0.23 estimate", reviews included.
      if (typeof m.workUsdMicro === "number")
        return `Session review measured: ${done}; the work cost ${money("workUsdMicro")} against an estimate of ${money("estimateUsdMicro")}${k("reviewsUsdMicro") > 0 ? `, and the reviews ${money("reviewsUsdMicro")}` : ""}.`;
      return `Session review measured: ${done}, ${money("actualUsdMicro")} spent of a ${money("estimateUsdMicro")} estimate.`;
    }
    case "critic.session_review":
      return `Session review: ${verdictWords(s("verdict"))} (grade ${n("grade")}, ${count("findings", "finding")}).`;
    case "task.blocked_by_findings":
      return `Cannot close the task: ${s("warning")}`;
    case "memory.loaded":
      return `Memory: ${count("lessons", "lesson")}, ${n("tokens")} of ${n("budget")} tokens.`;
    case "memory.over_budget":
    case "memory.load_failed":
    case "memory.record_failed":
      return `Memory: ${s("warning")}`;
    case "memory.recorded":
      return `Memory: recorded ${count("recorded", "lesson")} (${n("merged")} merged, ${n("rejected")} rejected).`;
    default:
      return moreEventLines(type, p, chfPerUsd) ?? fallbackLine(type, p);
  }
}

/** What happens after a verdict: the decision and, for a retry, how (U-074: no ladder words). */
function criticNext(decision: string, retry: string, nextTier: string): string {
  const how = retry && retry !== "human" ? `, ${retryWords(retry)}` : "";
  return `${decisionWords(decision)}${how}${nextTier ? ` (${nextTier})` : ""}`;
}

export function messageView(m: MessageRow, fromName: string): MessageView {
  return {
    id: m.id,
    fromAgentId: m.from_agent_id,
    fromAgentName: fromName,
    toAgentId: m.to_agent_id,
    toHumanId: m.to_human_id,
    projectId: m.project_id,
    taskId: m.task_id,
    type: m.type,
    body: m.body,
    requiresAck: m.requires_ack,
    deliveredAt: m.delivered_at,
    readAt: m.read_at,
    actedAt: m.acted_at,
    createdAt: m.created_at,
  };
}

/** What a request's option says on its button (`optionLabel`, `wiring/request-answers.ts`). */
export { optionLabel };

export function requestView(
  r: HumanRequestRow,
  projectName: string | null,
  taskTitle: string | null = null,
  ctx: Omit<RequestWordsContext, "projectName" | "taskTitle"> = {},
): HumanRequestView {
  // Design §3.8: the card in the person's words, read when it is shown.
  const words = requestWords(r, { ...ctx, projectName, taskTitle });
  return {
    id: r.id,
    projectId: r.project_id,
    projectName,
    taskId: r.task_id,
    taskTitle,
    sessionId: r.session_id,
    kind: r.kind,
    why: r.why,
    steps: r.steps,
    options: r.options.map(optionLabel),
    blocking: r.blocking,
    risk: r.risk,
    changeCard: r.change_card,
    status: r.status,
    answer: r.answer,
    createdAt: r.created_at,
    version: r.version,
    title: words.title,
    body: words.body,
    choices: words.choices,
    links: words.links,
    reply: words.reply,
    details: words.details,
    outcome: words.outcome,
    answeredAt: r.answered_at ?? null,
    followUp: words.followUp ?? null,
  };
}

/**
 * What a card needs beyond its row, read now (design §5 rule 4): its project's and task's
 * names, the task's status, and the tasks not done that wait on it.
 */
export async function requestContexts(
  store: StateStore,
  rows: readonly HumanRequestRow[],
): Promise<
  Map<
    string,
    { projectName: string | null; taskTitle: string | null } & Omit<
      RequestWordsContext,
      "projectName" | "taskTitle"
    >
  >
> {
  const projects = new Map<string, string>();
  const projectTasks = new Map<string, TaskRow[]>();
  const out = new Map<
    string,
    { projectName: string | null; taskTitle: string | null } & Omit<
      RequestWordsContext,
      "projectName" | "taskTitle"
    >
  >();
  // L-20: which projects work on a repository (the plan card's line while Approve and start
  // writes its docs pull request).
  const onRepository = new Map<string, boolean>();
  for (const r of rows) {
    if (r.project_id && !projects.has(r.project_id)) {
      const p = await store.project.get(r.project_id);
      projects.set(r.project_id, p?.name ?? r.project_id);
      const first = p?.repos[0]?.trim() ?? "";
      onRepository.set(r.project_id, !!first && !isAbsolute(first));
    }
    let tasks: TaskRow[] = [];
    if (r.task_id) {
      const task = await store.task.get(r.task_id);
      if (task && !projectTasks.has(task.project_id))
        projectTasks.set(
          task.project_id,
          await store.task.list({ project_id: task.project_id } as never, { limit: 2000 }),
        );
      tasks = task ? (projectTasks.get(task.project_id) ?? []) : [];
      const waiting = task
        ? tasks
            .filter(
              (t) =>
                t.depends_on.includes(task.id) && t.status !== "done" && t.status !== "cancelled",
            )
            .map((t) => t.title)
        : [];
      // W15-56: an open budget card names a set-aside only when its task's run wrote something.
      const budgetOpen =
        r.status === "open" &&
        (r.change_card as { key?: unknown } | null)?.key === ANSWER_CARD_KEYS.budgetStop;
      out.set(r.id, {
        projectName: r.project_id ? (projects.get(r.project_id) ?? null) : null,
        taskTitle: task?.title ?? null,
        taskStatus: task?.status ?? null,
        waiting,
        movedByYou: !!task?.author_human && !task.author_agent,
        ...(budgetOpen && task ? { heldWork: await taskHeldWork(store, task) } : {}),
      });
      continue;
    }
    out.set(r.id, {
      projectName: r.project_id ? (projects.get(r.project_id) ?? null) : null,
      taskTitle: null,
      ...(r.project_id && onRepository.get(r.project_id) ? { projectRepository: true } : {}),
      ...(r.status === "open"
        ? { credentialGoesOn: await credentialGoesOnFor(store, r).catch(() => null) }
        : {}),
    });
  }
  return out;
}

/**
 * A refused credential's card (U-078): the credential its task work goes on with now, read when
 * the card is shown. Under "When my first choice runs out mid-session: use the other one", an
 * enabled credential of the person that is not refused; under 'Wait' (the default) none, since
 * the task work waits for a new one (the session lead's default of 2026-11-03).
 */
async function credentialGoesOnFor(store: StateStore, r: HumanRequestRow): Promise<string | null> {
  const card = r.change_card as { key?: unknown; source_id?: unknown } | null;
  if (card?.key !== CREDENTIAL_REFUSED_KEY || !r.human_id) return null;
  const human = await store.human.get(r.human_id);
  if (midSessionLimitOf(human?.notify_prefs?.[MID_SESSION_LIMIT_SETTING]) !== "use_other")
    return null;
  const rows = await store.billingSource.list({ human_id: r.human_id }, { limit: 100 });
  const other = rows.find(
    (s) =>
      s.enabled &&
      s.kind !== "fake" &&
      s.id !== card.source_id &&
      typeof (s.limits as { refusedAt?: unknown }).refusedAt !== "string",
  );
  return other?.kind ?? null;
}

/** `requestView` of each row with what it needs read now (`requestContexts`). */
export async function requestViews(
  store: StateStore,
  rows: readonly HumanRequestRow[],
): Promise<HumanRequestView[]> {
  const ctx = await requestContexts(store, rows);
  return rows.map((r) => {
    const c = ctx.get(r.id) ?? { projectName: null, taskTitle: null };
    const { projectName, taskTitle, ...rest } = c;
    return requestView(r, projectName, taskTitle, rest);
  });
}

export async function costView(
  store: StateStore,
  filter: { projectId?: string; from?: string; to?: string; humanId?: string },
  chfPerUsd: number,
  ledger?: Pick<CostLedger, "savings">,
): Promise<CostView> {
  const f = {
    projectId: filter.projectId,
    from: filter.from,
    to: filter.to,
    humanId: filter.projectId ? undefined : filter.humanId,
  };
  const totals = await store.costLedger.sum(f);
  const bucket = async (by: "model" | "specialist" | "task_id" | "project_id") => {
    const rows = await store.costLedger.breakdown(by as never, f);
    return rows.map(
      (b: { key: string | null; usd_micro: number; entries?: number; count?: number }) => ({
        key: b.key ?? "(none)",
        label: b.key ?? "(none)",
        cost: money(b.usd_micro, chfPerUsd),
        runs: b.entries ?? b.count ?? 0,
        accepted: null as number | null,
      }),
    );
  };
  const [byModel, ledgerBySpecialist, byTask, byProject] = await Promise.all([
    bucket("model"),
    bucket("specialist"),
    bucket("task_id"),
    bucket("project_id"),
  ]);
  // Design §5 rule 3 (names, not ids): the tasks by their titles and the work by the
  // specialist that ran it, with the runs the critic accepted. The ledger's entries name a run;
  // the run names its specialist (the ledger's own column is not filled), and a task's accepted
  // run is its last work run before an accepting review.
  const facts = await costFacts(store, f);
  const bySpecialist = facts.bySpecialist.length
    ? facts.bySpecialist.map((s) => ({
        key: s.key,
        label: s.label,
        cost: money(s.usdMicro, chfPerUsd),
        runs: s.runs,
        accepted: s.accepted,
      }))
    : ledgerBySpecialist;
  // "Runs" counts runs, not ledger entries (one per model call): "1 / 3 accepted" compares
  // like with like.
  for (const b of byTask) {
    const t = facts.tasks.get(b.key);
    if (t) {
      b.label = t.title;
      b.runs = facts.runsByTask.get(b.key) ?? b.runs;
      b.accepted = facts.acceptedRunsByTask.get(b.key) ?? 0;
    } else if (b.key === "(none)") b.label = "Planning and chat";
  }
  // later #91: a model's accepted runs are compared with its work runs (before, the critic's
  // reviews and the planning call counted too: "Accepted 3 / 16"); a model only the critic or
  // the planner used shows its runs and no accepted figure.
  for (const b of byModel) {
    const work = facts.runsByModel.get(b.key);
    if (work) {
      b.runs = work;
      b.accepted = facts.acceptedRunsByModel.get(b.key) ?? 0;
    } else {
      b.runs = facts.allRunsByModel.get(b.key) ?? b.runs;
      b.accepted = null;
    }
  }
  for (const b of byProject) {
    const name = b.key === "(none)" ? null : (await store.project.get(b.key))?.name;
    if (name) b.label = name;
  }
  // Savings (ADR 0003 section 3): read from the Run rows and priced at read time by the billing
  // ledger; "estimated" for compression, "measured" for cache reads, never netted against spend.
  const savings = await (ledger ?? savingsLedger(store, chfPerUsd)).savings({
    ...(f.projectId ? { projectId: f.projectId } : {}),
    ...(f.humanId ? { humanId: f.humanId } : {}),
    ...(f.from ? { from: f.from } : {}),
    ...(f.to ? { to: f.to } : {}),
  });
  return {
    totals: money(totals.usd_micro, chfPerUsd),
    planUsageShare: (totals as { plan_usage_share?: number | null }).plan_usage_share ?? null,
    byModel,
    bySpecialist,
    byTask,
    byProject,
    savings: {
      compressionTokens: savings.compression.tokensSaved,
      cacheTokens: savings.cache.cacheReadTokens,
      compression: {
        usdMicro: savings.compression.usd_micro,
        chfMicro: savings.compression.chf_micro,
      },
      cache: { usdMicro: savings.cache.usd_micro, chfMicro: savings.cache.chf_micro },
    },
    // The period the figures cover: the filter's, else the first and the last entry's.
    from: filter.from ?? facts.first ?? "",
    to: filter.to ?? facts.last ?? "",
  };
}

/** What the cost view adds to the ledger's sums: names, specialists, accepted runs, period. */
async function costFacts(
  store: StateStore,
  f: { projectId?: string; from?: string; to?: string; humanId?: string },
): Promise<{
  tasks: Map<string, TaskRow>;
  bySpecialist: {
    key: string;
    label: string;
    usdMicro: number;
    runs: number;
    accepted: number | null;
  }[];
  acceptedRunsByTask: Map<string, number>;
  acceptedRunsByModel: Map<string, number>;
  runsByTask: Map<string, number>;
  /** Work runs per model: not the critic's reviews, not the planning call. */
  runsByModel: Map<string, number>;
  allRunsByModel: Map<string, number>;
  first: string | null;
  last: string | null;
}> {
  const where: Record<string, unknown> = {};
  if (f.projectId) where.project_id = f.projectId;
  if (f.humanId) where.human_id = f.humanId;
  const entries = (await store.costLedger.list(where as never, { limit: 20_000 })).filter(
    (e) => (!f.from || e.occurred_at >= f.from) && (!f.to || e.occurred_at < f.to),
  );
  const runIds = [...new Set(entries.map((e) => e.run_id).filter((x): x is string => !!x))];
  const runs = new Map<string, RunRow>();
  for (const id of runIds) {
    const r = await store.run.get(id);
    if (r) runs.set(id, r);
  }
  const taskIds = [...new Set(entries.map((e) => e.task_id).filter((x): x is string => !!x))];
  const tasks = new Map<string, TaskRow>();
  for (const id of taskIds) {
    const t = await store.task.get(id);
    if (t) tasks.set(id, t);
  }
  // A task's accepted run: its last work run before each accepting review.
  const accepted = new Set<string>();
  for (const id of taskIds) {
    const reviews = (await store.review.forTask(id, { limit: 200 })).filter(
      (r) => r.verdict === "accept",
    );
    if (!reviews.length) continue;
    const work = (await store.run.forTask(id))
      .filter((r) => r.specialist !== "critic")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const rv of reviews) {
      const before = work.filter((r) => r.created_at <= rv.created_at).at(-1);
      if (before) accepted.add(before.id);
    }
  }
  const acceptedRunsByTask = new Map<string, number>();
  const acceptedRunsByModel = new Map<string, number>();
  for (const id of accepted) {
    const r = runs.get(id) ?? (await store.run.get(id));
    if (!r) continue;
    if (r.task_id) acceptedRunsByTask.set(r.task_id, (acceptedRunsByTask.get(r.task_id) ?? 0) + 1);
    acceptedRunsByModel.set(r.model, (acceptedRunsByModel.get(r.model) ?? 0) + 1);
  }
  const specialists = new Map<
    string,
    { usdMicro: number; runs: Set<string>; entries: number; accepted: number }
  >();
  for (const e of entries) {
    const run = e.run_id ? runs.get(e.run_id) : undefined;
    const key = e.specialist ?? run?.specialist ?? "(none)";
    const s = specialists.get(key) ?? { usdMicro: 0, runs: new Set(), entries: 0, accepted: 0 };
    s.usdMicro += e.usd_micro;
    s.entries += 1;
    if (e.run_id && !s.runs.has(e.run_id)) {
      s.runs.add(e.run_id);
      if (accepted.has(e.run_id)) s.accepted += 1;
    }
    specialists.set(key, s);
  }
  // The planning run and the critic's reviews are no work for the critic to accept.
  const notWork = (key: string) =>
    key === "critic" || key === "(none)" || key === INTAKE_RUN_SPECIALIST;
  const runsByTask = new Map<string, number>();
  const runsByModel = new Map<string, number>();
  const allRunsByModel = new Map<string, number>();
  for (const r of runs.values()) {
    // A task's runs are its work runs; the critic's reviews of it are not attempts.
    if (r.task_id && r.specialist !== "critic")
      runsByTask.set(r.task_id, (runsByTask.get(r.task_id) ?? 0) + 1);
    allRunsByModel.set(r.model, (allRunsByModel.get(r.model) ?? 0) + 1);
    if (!notWork(r.specialist ?? "(none)"))
      runsByModel.set(r.model, (runsByModel.get(r.model) ?? 0) + 1);
  }
  const bySpecialist = [...specialists.entries()]
    .map(([key, s]) => ({
      key,
      // later #91: the specialist as the session log names it ("the writer", not the registry's
      // "writer-marketing").
      label:
        key === "(none)"
          ? "Planning and chat"
          : key === "critic"
            ? "the critic"
            : key === INTAKE_RUN_SPECIALIST
              ? "planning"
              : `the ${saidByName(key) ?? key}`,
      usdMicro: s.usdMicro,
      runs: s.runs.size || s.entries,
      accepted: notWork(key) ? null : s.accepted,
    }))
    .sort((a, b) => b.usdMicro - a.usdMicro || a.key.localeCompare(b.key));
  const times = entries.map((e) => e.occurred_at).sort();
  return {
    tasks,
    bySpecialist,
    acceptedRunsByTask,
    acceptedRunsByModel,
    runsByTask,
    runsByModel,
    allRunsByModel,
    first: times[0] ?? null,
    last: times.at(-1) ?? null,
  };
}

/** A savings-only ledger over the store when the daemon did not hand one in (tests, CLI). */
function savingsLedger(store: StateStore, chfPerUsd: number): Pick<CostLedger, "savings"> {
  const ledgerStore = new StateLedgerStore(store);
  return new CostLedger({
    sink: ledgerStore,
    query: ledgerStore,
    runs: ledgerStore,
    sessions: ledgerStore,
    rates: new FixedRateSource(chfPerUsd),
    clock: store.clock,
  });
}

// ---------------------------------------------------------------------------------------
// Reviews tab (spec H, K.2)

export function findingView(f: FindingRow): FindingView {
  return {
    id: f.id,
    reviewId: f.review_id,
    taskId: f.task_id,
    severity: f.severity,
    // Read as the review's summary is: plurals as the number says, no ids (design §5 rule 6;
    // phase E #80: the session check's findings read "1 of the 2 task(s)"). The row keeps the
    // critic's own text, which the fingerprints are computed from.
    description: plainPlurals(withoutIds(f.description)),
    // L-13e: a note the critic gave no fix for (an info finding, filled with NO_ACTION_GIVEN)
    // shows no "To fix" line under it.
    requiredAction:
      f.severity === "info" && f.required_action.trim() === NO_ACTION_GIVEN
        ? ""
        : plainPlurals(withoutIds(f.required_action)),
    status: f.status,
    resolvedByRun: f.resolved_by_run,
    fingerprint: f.fingerprint,
    createdAt: f.created_at,
    version: f.version,
  };
}

/**
 * Evidence lines that are records for the critic's own audit, not for a person (design §5 rule
 * 3: no run ids, prompt hashes or internals): the prompt version, the run id, the context
 * compression note, the timing. They stay on the review row; the view leaves them out.
 */
const INTERNAL_EVIDENCE = /^(?:prompt:|run:|context:|timing:)/;

/** A review's evidence as a person reads it under Details: no ids, no "(s)", no internals. */
export function plainEvidence(evidence: readonly unknown[]): string[] {
  return evidence
    .map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
    .filter((e) => !INTERNAL_EVIDENCE.test(e.trim()))
    .map((e) => plainPlurals(withoutIds(e.replace(/\[stand-in model\]\s*/gi, ""))))
    .filter((e) => e.length > 0);
}

/** A task's findings stop being open work when the task is done or cancelled (design §3.5). */
const CLOSED_TASK = new Set(["done", "cancelled"]);

/**
 * The open findings of task reviews counted once per task and finding (design §3.5, "Reviews"):
 * a finding the critic files again on each attempt is one finding, a done or cancelled task has
 * none open, and a session review's findings are the critic's self-check, not work.
 */
export function openFindingKeys(
  findings: readonly Pick<FindingRow, "task_id" | "status" | "fingerprint" | "description">[],
  taskStatus: (taskId: string) => string | null,
): Set<string> {
  const keys = new Set<string>();
  for (const f of findings) {
    if (f.status !== "open" || !f.task_id) continue;
    if (CLOSED_TASK.has(taskStatus(f.task_id) ?? "")) continue;
    keys.add(`${f.task_id}:${f.fingerprint || f.description.trim().toLowerCase()}`);
  }
  return keys;
}

export function reviewView(
  r: ReviewRow,
  findings: FindingRow[],
  taskTitle: string | null,
  taskStatus: string | null = null,
): ReviewView {
  return {
    id: r.id,
    taskId: r.task_id,
    taskTitle,
    taskStatus,
    sessionId: r.session_id,
    criticModel: r.critic_model,
    tier: Math.min(3, Math.max(0, r.tier)) as 0 | 1 | 2 | 3,
    grade: Math.min(100, Math.max(0, Math.round(r.grade))),
    confidence: Math.min(1, Math.max(0, r.confidence)),
    verdict: r.verdict,
    evidence: plainEvidence(r.evidence),
    summary: plainPlurals(withoutIds(r.summary.replace(/\[stand-in model\]\s*/gi, ""))),
    findings: findings.map(findingView),
    openFindings: openFindingKeys(findings, () => taskStatus).size,
    createdAt: r.created_at,
  };
}

/**
 * The Reviews tab data for a project or one task: every review with its findings, the open
 * finding count, the verdict counts and the grade trend (oldest first).
 */
export async function reviewsView(
  store: StateStore,
  filter: { projectId?: string; taskId?: string; limit?: number },
): Promise<ReviewsView> {
  const limit = filter.limit ?? 200;
  let rows: ReviewRow[];
  const titles = new Map<string, string>();
  const statuses = new Map<string, string>();
  if (filter.taskId) {
    rows = await store.review.forTask(filter.taskId, { limit });
    const t = await store.task.get(filter.taskId);
    if (t) {
      titles.set(t.id, t.title);
      statuses.set(t.id, t.status);
    }
  } else if (filter.projectId) {
    const tasks = await store.task.list({ project_id: filter.projectId } as never, { limit: 5000 });
    for (const t of tasks) {
      titles.set(t.id, t.title);
      statuses.set(t.id, t.status);
    }
    const sessions = await store.session.list({ project_id: filter.projectId } as never, {
      limit: 5000,
    });
    const sessionIds = new Set(sessions.map((s) => s.id));
    rows = (
      await store.review.list({} as never, {
        orderBy: [{ column: "created_at", direction: "desc" }],
        limit: 5000,
      })
    )
      .filter(
        (r) =>
          (r.task_id && titles.has(r.task_id)) || (r.session_id && sessionIds.has(r.session_id)),
      )
      .slice(0, limit);
  } else {
    rows = await store.review.list({} as never, {
      orderBy: [{ column: "created_at", direction: "desc" }],
      limit,
    });
    for (const r of rows) {
      if (r.task_id && !titles.has(r.task_id)) {
        const t = await store.task.get(r.task_id);
        if (t) {
          titles.set(t.id, t.title);
          statuses.set(t.id, t.status);
        }
      }
    }
  }
  const reviews: ReviewView[] = [];
  const verdicts: Record<string, number> = {};
  const allFindings: FindingRow[] = [];
  for (const r of rows) {
    const findings = await store.finding.forReview(r.id);
    allFindings.push(...findings);
    const v = reviewView(
      r,
      findings,
      r.task_id ? (titles.get(r.task_id) ?? null) : null,
      r.task_id ? (statuses.get(r.task_id) ?? null) : null,
    );
    reviews.push(v);
    // The verdicts, the trend and the average are the tasks' reviews: the session review is
    // the critic's self-check of the summary, not a grade of the work (design §3.5).
    if (v.taskId) verdicts[v.verdict] = (verdicts[v.verdict] ?? 0) + 1;
  }
  const openFindings = openFindingKeys(allFindings, (id) => statuses.get(id) ?? null).size;
  const trend = reviews
    .filter((r) => r.taskId !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((r) => ({
      at: r.createdAt,
      grade: r.grade,
      reviewId: r.id,
      taskId: r.taskId,
      verdict: r.verdict,
    }));
  return {
    projectId: filter.projectId ?? null,
    taskId: filter.taskId ?? null,
    reviews,
    openFindings,
    gradeTrend: trend,
    averageGrade: trend.length
      ? Math.round((trend.reduce((a, p) => a + p.grade, 0) / trend.length) * 10) / 10
      : null,
    verdicts,
  };
}

// ---------------------------------------------------------------------------------------
// Memory views (spec K.5)

export function lessonView(l: LessonRow): LessonView {
  return {
    id: l.id,
    scope: l.scope,
    ownerAgentId: l.owner_agent_id,
    projectId: l.project_id,
    text: l.text,
    source: l.source,
    tags: [...l.tags],
    confidence: l.confidence,
    lastUsed: l.last_used,
    hitCount: l.hit_count,
    supersededBy: l.superseded_by,
    pinned: l.pinned,
    status: l.status,
    filePath: l.file_path,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    version: l.version,
  };
}

// ---------------------------------------------------------------------------------------
// Commands and the change log (spec Q)

export function changeLogView(row: ChangeLogRow, nowIso: string): ChangeLogView {
  return {
    id: row.id,
    humanId: row.human_id,
    agentId: row.agent_id,
    wordsUsed: row.words_used,
    commands: row.commands,
    before: row.before,
    after: row.after,
    scope: row.scope,
    projectId: row.project_id,
    expiresAt: row.expires_at,
    undoState: row.undo_state,
    undoneAt: row.undone_at,
    source: row.source,
    sentence: row.sentence,
    undoable: row.undo_state === "undoable" && (!row.expires_at || row.expires_at > nowIso),
    createdAt: row.created_at,
    version: row.version,
  };
}

export function commandDefView(def: CommandDef<unknown>, schema: unknown): CommandDefView {
  return {
    name: def.name,
    description: def.description,
    risk: staticRisk(def),
    reversible: def.reversible,
    undoStrategy: def.undoStrategy,
    limit: def.limit === true,
    schema,
  };
}

// ---------------------------------------------------------------------------------------
// Performance (spec D.7, D.19): time to first token and total time per mode against target

/** The labels the Performance page shows, in the spec's table order (D.8 to D.15). */
export const MODE_LABELS: Record<Mode, string> = {
  voice_chat: "Voice chat",
  text_chat: "Text chat",
  routing: "Routing, triage, summaries",
  planning: "Session planning",
  coder: "Coding specialist",
  researcher: "Research specialist",
  critic_t1: "Critic, light review",
  critic_t23: "Critic, full review",
};

/**
 * The modes whose runs read the project's speed-versus-quality slider (spec D.16): the
 * executor per run (coder, researcher), the conversation agent per turn (text and voice chat),
 * the intake per planning session and the critic per review (`criticSettingsOf` in
 * `@forerunner/critic`). Routing is left out: nothing runs a routing call yet, so no code
 * applies the offset there, and the view says so rather than showing an effort no run uses.
 */
export const OFFSET_MODES: readonly Mode[] = [
  "voice_chat",
  "text_chat",
  "planning",
  "coder",
  "researcher",
  "critic_t1",
  "critic_t23",
];

/**
 * The registry `max_effort` each mode's consumer holds the shifted effort at (`capEffort`):
 * the executor at the specialist's (the coder row shows the shipped `coder`'s, the research
 * row the `researcher`'s), the conversation agent at `conversation-agent`'s (text and voice),
 * the intake at `project-manager`'s, the critic at its own. A mode without an entry is uncapped.
 */
export type EffortCaps = Partial<Record<Mode, EffortLevel>>;

/** The caps of `EffortCaps` from the registry in force, the way the composition wires them. */
export function effortCapsOf(
  registry: Pick<Registry, "specialists" | "principals" | "critic">,
): EffortCaps {
  const caps: EffortCaps = {};
  const set = (modes: Mode[], cap: EffortLevel | undefined) => {
    if (cap) for (const m of modes) caps[m] = cap;
  };
  set(["coder"], registry.specialists.get("coder")?.max_effort);
  set(["researcher"], registry.specialists.get("researcher")?.max_effort);
  set(["text_chat", "voice_chat"], registry.principals.get("conversation-agent")?.max_effort);
  set(["planning"], registry.principals.get("project-manager")?.max_effort);
  set(["critic_t1", "critic_t23"], registry.critic.max_effort);
  return caps;
}

/**
 * The principal agent's effort override for a mode (spec D.4, ADR 0072), where a run of the mode
 * reads one: `modes.planning` (the intake), `modes.text_chat` (a typed chat turn; a spoken one
 * keeps the voice mode's table effort), `specialists.coder` and `specialists.researcher` (the
 * executor; the coder row stands for every non-research specialist, as its cap does). The
 * critic, voice and routing modes have no override. Undefined when none is set.
 */
export function agentEffortOverride(
  config: AgentModelConfig | undefined,
  mode: Mode,
): EffortLevel | undefined {
  if (!config) return undefined;
  if (mode === "planning" || mode === "text_chat") return modeOverride(config, mode).effort;
  if (mode === "coder" || mode === "researcher") return specialistOverride(config, mode).effort;
  return undefined;
}

/** Newest measurements the view lists under the table. */
export const PERFORMANCE_RECENT_LIMIT = 20;

/**
 * The p-th percentile by nearest rank: the smallest value with at least p% of the values at or
 * under it (`sorted[ceil(p/100 * n) - 1]`). Null for no values.
 */
export function nearestRank(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

/**
 * A Run row's mode. The run table has no mode column, so it is derived from who wrote the row:
 * the critic writes `specialist: "critic"` (tier 1 is `critic_t1`, tiers 2 and 3 `critic_t23`;
 * the tier comes from the Review row whose evidence names the run, else from the model's rung:
 * opus and above is a tier 2 or 3 review), the intake call writes `specialist: "intake"`
 * (planning), the executor writes the specialist's name: `researcher` is the research mode and
 * every other specialist runs on the coder row of the effort table, as `effortForTask` does.
 */
export function runMode(
  run: Pick<RunRow, "specialist" | "model">,
  reviewTier?: number | null,
  ladder?: LadderRung[],
): Mode {
  if (run.specialist === "critic") {
    if (typeof reviewTier === "number") return reviewTier >= 2 ? "critic_t23" : "critic_t1";
    const rung = tierOfModel(run.model, ladder);
    return rung === "opus" || rung === "fable" ? "critic_t23" : "critic_t1";
  }
  if (run.specialist === INTAKE_RUN_SPECIALIST) return "planning";
  if (run.specialist === "researcher") return "researcher";
  return "coder";
}

interface PerfSample extends PerformanceSampleView {
  mode: Mode;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** A chat or voice turn event as a sample, or null when it carries no measurement. */
export function eventSample(e: EventRow): PerfSample | null {
  const p = obj(e.payload);
  if (e.type === "chat.reply") {
    // Voice turns are measured to first audio by their `voice.turn` row; a reply with neither
    // figure (a yes or no answered without a model call) is not a measurement.
    if (p.source === "voice") return null;
    const ttft = num(p.ttftMs);
    const total = num(p.durationMs);
    // A turn whose model call never produced a first token is a measurement only when it ran
    // into its timeout; one that failed at once would count a few ms as a fast reply.
    if (ttft === null && (p.outcome !== "timeout" || total === null)) return null;
    return {
      runId: e.id,
      source: "chat",
      mode: "text_chat",
      specialist: "conversation",
      model: str(p.model),
      effort: str(p.effort),
      ttftMs: ttft,
      durationMs: total,
      at: e.created_at,
    };
  }
  if (e.type === "voice.turn") {
    // A text reply played nothing: no first audio to sample (its first token is not a
    // voice_chat figure either; text_chat counts the typed chat's replies).
    if (p.replyMode === "text") return null;
    const firstAudio = num(obj(p.latency).totalToFirstAudioMs);
    if (firstAudio === null) return null;
    return {
      runId: e.id,
      source: "voice",
      mode: "voice_chat",
      specialist: "voice",
      model: "",
      effort: "",
      ttftMs: firstAudio,
      durationMs: null,
      at: e.created_at,
    };
  }
  return null;
}

/**
 * Whether a Run row is a response-time measurement: it reached a model and got a first token,
 * or it ran into its wall-clock timeout (a real, over-target response time). A row closed
 * before any model answered (a refused lease or secret, `endRunWithError`; a budget refusal;
 * an intake call that threw before the driver) carries a duration of a few ms and no first
 * token: counting it would pull the medians down and pass the total-time targets.
 */
export function isMeasurement(r: Pick<RunRow, "ttft_ms" | "duration_ms" | "timed_out">): boolean {
  return r.ttft_ms !== null || (r.timed_out && r.duration_ms !== null);
}

/** The figure a mode's target applies to: first token (or audio), or the whole run. */
function measured(kind: ModeDefault["targetKind"], s: PerfSample): number | null {
  if (kind === "first_token" || kind === "first_audio") return s.ttftMs;
  if (kind === "total") return s.durationMs;
  return null;
}

/** The risk tier from which `effortForTask` raises a mode's effort (coder 2, critic tier 2/3 3). */
const RISK_RAISE_FROM: Partial<Record<Mode, 2 | 3>> = { coder: 2, critic_t23: 3 };

/**
 * The effort a risky task runs the mode at (spec D.7: the effort rule as the code applies it),
 * from the same `effortForTask` the executor uses, held at the mode's registry cap as the
 * executor and the critic hold it; null when it equals the mode's effort.
 */
export function riskEffortOf(
  mode: Mode,
  offset: -1 | 0 | 1,
  defaults: Record<Mode, ModeDefault>,
  effort: string,
  cap?: EffortLevel,
): { effort: EffortLevel; from: 2 | 3 } | null {
  const from = RISK_RAISE_FROM[mode];
  if (from === undefined) return null;
  const raised = capEffort(
    effortForTask(mode, from, offset, { ...MODE_DEFAULTS, ...defaults }),
    cap,
  );
  return raised === effort ? null : { effort: raised, from };
}

export interface PerformanceViewOptions {
  /** The install's human: only the rows of their agents' sessions count. */
  humanId: string;
  projectId?: string | null;
  days?: number;
  nowIso: string;
  /** The ladder and effort table in force (`rt.modelConfig()`); the built-ins by default. */
  modelConfig?: { ladder: LadderRung[]; modeDefaults: Record<Mode, ModeDefault> };
  /** The registry caps per mode (`effortCapsOf(rt.registry)`); none by default. */
  effortCaps?: EffortCaps;
  /**
   * The principal agent's D.4 settings (`parseAgentModelConfig(agent.model_config).config`):
   * an effort override there replaces the mode's base effort, as the runs apply it. None by
   * default.
   */
  agentModelConfig?: AgentModelConfig;
  recentLimit?: number;
}

const IN_CHUNK = 500;
async function inChunks<T>(ids: string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK)
    out.push(...(await read(ids.slice(i, i + IN_CHUNK))));
  return out;
}

/**
 * The Performance view (spec D.7, D.19) from the store: every Run row (executor, critic,
 * intake), `chat.reply` and `voice.turn` event created in the window, on a session of one of
 * the human's agents (and of the project, when one is named), grouped by mode with the median
 * and p90 by nearest rank of time to first token and total time, the target, met or not, and
 * the effort in force from the effort table and the project's offset.
 */
export async function performanceView(
  store: StateStore,
  opts: PerformanceViewOptions,
): Promise<PerformanceView> {
  const days = Math.min(PERFORMANCE_MAX_DAYS, Math.max(1, opts.days ?? PERFORMANCE_DEFAULT_DAYS));
  const nowMs = Date.parse(opts.nowIso);
  const from = new Date(nowMs - days * 86_400_000).toISOString();
  const to = opts.nowIso;
  const config = opts.modelConfig ?? { ladder: DEFAULT_LADDER, modeDefaults: MODE_DEFAULTS };
  const projectId = opts.projectId ?? null;
  let offset: -1 | 0 | 1 = 0;
  if (projectId) {
    const project = await store.project.get(projectId);
    if (!project) throw new ForerunnerError("not_found", `project ${projectId} not found`);
    offset = speedQualityOffsetOf(project.settings);
  }

  const runs = (
    await store.run.rows(
      `SELECT * FROM ${store.run.qt} WHERE "created_at" >= ? AND "created_at" <= ? ORDER BY "created_at", "id"`,
      [from, to],
    )
  ).filter(isMeasurement);
  const events = await new Repository<EventRow>(
    store.event.db,
    ENTITIES.event as EntityDef,
    store.event.clock,
  ).rows(
    `SELECT * FROM "event" WHERE "type" IN (?, ?) AND "created_at" >= ? AND "created_at" <= ? ORDER BY "created_at", "id"`,
    ["chat.reply", "voice.turn", from, to],
  );

  // Ownership and project: the sessions the rows sit on, kept when their agent is the human's.
  const agents = new Set(
    (await store.agent.list({ owner_human_id: opts.humanId })).map((a) => a.id),
  );
  const sessionIds = [...new Set([...runs, ...events].map((r) => r.session_id))];
  const sessions = (await inChunks(sessionIds, (ids) => store.session.list({ id: ids }))).filter(
    (s) => agents.has(s.agent_id),
  );
  const owned = new Set(sessions.map((s) => s.id));
  const inScope = new Set(
    sessions.filter((s) => !projectId || s.project_id === projectId).map((s) => s.id),
  );
  // A chat turn sits on the agent's one conversation session, whose `project_id` is the project
  // of the session's first turn (or none, when the daemon opened it for voice or speech): the
  // reply row's own `projectId`, the turn's active project, says which project the turn was in.
  const eventInScope = (e: EventRow): boolean => {
    if (!owned.has(e.session_id)) return false;
    if (!projectId) return true;
    const p = obj(e.payload);
    return e.type === "chat.reply" && "projectId" in p
      ? p.projectId === projectId
      : inScope.has(e.session_id);
  };

  // The critic's tier: the Review row whose evidence names the run (`run:<id>`).
  const criticRuns = runs.filter((r) => r.specialist === "critic" && inScope.has(r.session_id));
  const reviewTier = new Map<string, number>();
  if (criticRuns.length) {
    const reviewSessions = [...new Set(criticRuns.map((r) => r.session_id))];
    const reviews = await inChunks(reviewSessions, (ids) => store.review.list({ session_id: ids }));
    for (const rv of reviews)
      for (const ev of rv.evidence)
        if (typeof ev === "string" && ev.startsWith("run:")) reviewTier.set(ev.slice(4), rv.tier);
  }

  const samples: PerfSample[] = [];
  for (const r of runs) {
    if (!inScope.has(r.session_id)) continue;
    samples.push({
      runId: r.id,
      source: "run",
      mode: runMode(r, reviewTier.get(r.id), config.ladder),
      specialist: r.specialist,
      model: r.model,
      effort: r.effort,
      ttftMs: r.ttft_ms,
      durationMs: r.duration_ms,
      at: r.created_at,
    });
  }
  for (const e of events) {
    if (!eventInScope(e)) continue;
    const s = eventSample(e);
    if (s) samples.push(s);
  }

  const modes: PerformanceModeView[] = (Object.keys(MODE_DEFAULTS) as Mode[]).map((mode) => {
    const d = config.modeDefaults[mode] ?? MODE_DEFAULTS[mode];
    const mine = samples.filter((s) => s.mode === mode);
    const ttfts = mine.map((s) => s.ttftMs).filter((v): v is number => v !== null);
    const totals = mine.map((s) => s.durationMs).filter((v): v is number => v !== null);
    const figures = mine
      .map((s) => measured(d.targetKind, s))
      .filter((v): v is number => v !== null);
    const hasTarget = d.targetKind !== "by_task" && d.targetMs > 0 && figures.length > 0;
    const p90 = nearestRank(figures, 90);
    const offsetApplied = OFFSET_MODES.includes(mode);
    const cap = opts.effortCaps?.[mode];
    const modeOffset = offsetApplied ? offset : 0;
    // As the consumers compute it: the table's effort, or the principal's D.4 override of it
    // (the base the slider shifts, as the executor's `withModeEffort` and the intake's and
    // chat's `resolveRunSettings` take it), shifted by the slider, held at the cap.
    const override = agentEffortOverride(opts.agentModelConfig, mode);
    const table: Record<Mode, ModeDefault> = { ...MODE_DEFAULTS, ...config.modeDefaults };
    if (override) table[mode] = { ...table[mode], effort: override };
    const baseEffort = table[mode].effort;
    const effort = capEffort(modeEffort(mode, modeOffset, table), cap);
    const risk = riskEffortOf(mode, modeOffset, table, effort, cap);
    return {
      mode,
      label: MODE_LABELS[mode],
      targetMs: d.targetMs,
      targetKind: d.targetKind,
      tier: d.tier,
      baseEffort,
      effortSource: override ? ("agent" as const) : ("table" as const),
      effort,
      offsetApplied,
      maxEffort: cap ?? null,
      riskEffort: risk?.effort ?? null,
      riskTierFrom: risk?.from ?? null,
      samples: mine.length,
      ttftP50Ms: nearestRank(ttfts, 50),
      ttftP90Ms: nearestRank(ttfts, 90),
      totalP50Ms: nearestRank(totals, 50),
      totalP90Ms: nearestRank(totals, 90),
      withinTargetShare: hasTarget
        ? figures.filter((v) => v <= d.targetMs).length / figures.length
        : null,
      met: hasTarget && p90 !== null ? p90 <= d.targetMs : null,
      lastAt: mine.reduce<string | null>((a, s) => (a === null || s.at > a ? s.at : a), null),
    };
  });

  const recent = [...samples]
    .sort((a, b) => (a.at === b.at ? b.runId.localeCompare(a.runId) : b.at.localeCompare(a.at)))
    .slice(0, opts.recentLimit ?? PERFORMANCE_RECENT_LIMIT);
  return {
    generatedAt: opts.nowIso,
    projectId,
    days,
    from,
    effortOffset: offset,
    modes,
    recent,
  };
}
