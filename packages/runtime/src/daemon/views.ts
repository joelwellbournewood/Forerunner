import { CostLedger, DEFAULT_CHF_PER_USD, FixedRateSource } from "@forerunner/billing";
import type { CommandDef } from "@forerunner/commands";
import { spokenProjectSummary, staticRisk } from "@forerunner/commands";
import { ForerunnerError } from "@forerunner/platform";
import type {
  AgentRow,
  ChangeLogRow,
  EventRow,
  FindingRow,
  HumanRequestRow,
  LessonRow,
  MessageRow,
  MilestoneRow,
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
import { countsList } from "../session/counts.ts";
import { runCapOf } from "../session/executor.ts";
import { defaultRiskTier } from "../session/project-plan.ts";
import { StateLedgerStore } from "../wiring/billing-ports.ts";
import { optionLabel } from "../wiring/request-answers.ts";
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
  TaskView,
} from "./api-types.ts";
import { PERFORMANCE_DEFAULT_DAYS, PERFORMANCE_MAX_DAYS } from "./api-types.ts";
import {
  autonomyWords,
  chfOf,
  decisionWords,
  fallbackLine,
  moreEventLines,
  retryWords,
  reviewLevel,
  skipReason,
  verdictWords,
} from "./event-lines.ts";
import { projectHealth } from "./project-health.ts";

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

export async function projectCard(
  store: StateStore,
  projectId: string,
  chfPerUsd: number,
  humanId: string,
): Promise<ProjectCard> {
  const p = await store.project.mustGet(projectId);
  const spend = await store.costLedger.sum({ projectId: p.id });
  const milestones = await store.milestone.forProject(p.id, { limit: 50 });
  const next = openMilestone(milestones);
  const waiting = await store.humanRequest.count({
    status: "open",
    project_id: p.id,
    human_id: humanId,
  } as never);
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

export async function projectSummary(
  store: StateStore,
  projectId: string,
  chfPerUsd: number,
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
  return {
    goal: p.goal,
    stage: p.stage,
    lastSession: s.last_session
      ? {
          id: s.last_session.id,
          endedAt: s.last_session.ended_at,
          summary: s.last_session.summary,
          stopReason: s.last_session.stop_reason,
        }
      : null,
    nextSteps: next,
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
    cap: money(cap?.usdMicro ?? 0, chfPerUsd),
    capSource: cap?.source ?? "unknown",
    specialist: t.specialist,
    attempt: t.attempt,
    prUrl: t.pr_url,
    branch: t.branch,
    reason: t.reason,
    updatedAt: t.updated_at,
    version: t.version,
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

export function sessionView(
  s: SessionRow,
  agentName: string,
  chfPerUsd: number,
  current: SessionView["currentTask"] = null,
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
  };
}

export function eventView(e: EventRow, chfPerUsd: number): EventView {
  const payload = (e.payload ?? {}) as Record<string, unknown>;
  const level: EventView["level"] = /error|failed/.test(e.type)
    ? "error"
    : /escalat/.test(e.type) || payload.escalation
      ? "escalation"
      : /warning|skipped|paused|killed|budget|plan_filed/.test(e.type) ||
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
  };
}

/**
 * The session log's sentence for an event (spec K.3): plain words, money in CHF at
 * `chfPerUsd` (U-074). Types without a line here are worded by `moreEventLines`
 * (`event-lines.ts`), and an unknown type by `fallbackLine`: never raw JSON.
 */
export function describeEvent(
  type: string,
  p: Record<string, unknown>,
  chfPerUsd: number = DEFAULT_CHF_PER_USD,
): string {
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : 0);
  const chf = (k: string) => chfOf(n(k), chfPerUsd);
  switch (type) {
    case "session.started":
      return `Session started (${s("trigger")}), budget ${chf("budgetCapUsdMicro")}, ${n("stepCap")} steps, autonomy ${autonomyWords(n("autonomy"))}.`;
    case "session.brief":
      return `State brief ready: ${n("unread")} unread, ${n("ready")} ready task(s)${Array.isArray(p.warnings) && p.warnings.length ? `, warnings: ${(p.warnings as string[]).join("; ")}` : ""}.`;
    case "session.planned":
      return `Plan: ${n("items")} item(s), estimate ${chf("estimateUsdMicro")}. ${s("summary")}`;
    case "session.paused":
      return `Paused: ${s("reason")}.`;
    case "session.plan_filed":
      return `Plan filed for your approval in the Inbox (${n("items")} item(s))${p.changed ? "; it changed since the plan you approved, nothing ran" : ""}.`;
    case "session.plan_approved":
      return `Running the plan you approved (${n("items")} item(s)).`;
    case "task.started":
      return `Started "${s("title")}" with ${s("specialist")} (estimate ${chf("estimateUsdMicro")}).`;
    case "task.finished":
      return `Finished task: ${s("outcome").replace(/_/g, " ")} (${chf("costUsdMicro")}). ${s("summary").slice(0, 200)}`;
    case "task.claims_released":
      return `Put ${n("count")} task(s) back to ready: their claim had lapsed or no agent held it.`;
    case "task.skipped":
      return `Skipped a task: ${skipReason(s("reason"))}.`;
    case "task.notes":
      return `Gave ${n("count")} item(s) from the next-session queue to "${s("title")}".`;
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
      return `Critic: ${verdictWords(s("verdict"))} (grade ${n("grade")}, ${n("findings")} finding(s), ${n("openFindings")} open): ${criticNext(s("decision"), s("retry"), s("nextTier"))}. ${s("summary")}`;
    case "critic.review_failed":
      return `Critic review failed: ${s("warning")}`;
    case "critic.session_review_metrics": {
      const m = (p.metrics ?? {}) as Record<string, unknown>;
      const k = (key: string) => (typeof m[key] === "number" ? (m[key] as number) : 0);
      return `Session review measured: ${k("plannedDoneTasks")} of ${k("plannedTasks")} planned task(s) done, ${chfOf(k("actualUsdMicro"), chfPerUsd)} spent of a ${chfOf(k("estimateUsdMicro"), chfPerUsd)} estimate.`;
    }
    case "critic.session_review":
      return `Session review: ${verdictWords(s("verdict"))} (grade ${n("grade")}, ${n("findings")} finding(s)). ${s("summary")}`;
    case "task.blocked_by_findings":
      return `Cannot close the task: ${s("warning")}`;
    case "memory.loaded":
      return `Memory: ${n("lessons")} lesson(s), ${n("tokens")} of ${n("budget")} tokens.`;
    case "memory.over_budget":
    case "memory.load_failed":
    case "memory.record_failed":
      return `Memory: ${s("warning")}`;
    case "memory.recorded":
      return `Memory: recorded ${n("recorded")} lesson(s) (${n("merged")} merged, ${n("rejected")} rejected).`;
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

export function requestView(r: HumanRequestRow, projectName: string | null): HumanRequestView {
  return {
    id: r.id,
    projectId: r.project_id,
    projectName,
    taskId: r.task_id,
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
  };
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
        accepted: null,
      }),
    );
  };
  const [byModel, bySpecialist, byTask, byProject] = await Promise.all([
    bucket("model"),
    bucket("specialist"),
    bucket("task_id"),
    bucket("project_id"),
  ]);
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
    from: filter.from ?? "",
    to: filter.to ?? "",
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
    description: f.description,
    requiredAction: f.required_action,
    status: f.status,
    resolvedByRun: f.resolved_by_run,
    fingerprint: f.fingerprint,
    createdAt: f.created_at,
    version: f.version,
  };
}

export function reviewView(
  r: ReviewRow,
  findings: FindingRow[],
  taskTitle: string | null,
): ReviewView {
  return {
    id: r.id,
    taskId: r.task_id,
    taskTitle,
    sessionId: r.session_id,
    criticModel: r.critic_model,
    tier: Math.min(3, Math.max(0, r.tier)) as 0 | 1 | 2 | 3,
    grade: Math.min(100, Math.max(0, Math.round(r.grade))),
    confidence: Math.min(1, Math.max(0, r.confidence)),
    verdict: r.verdict,
    evidence: r.evidence,
    summary: r.summary,
    findings: findings.map(findingView),
    openFindings: findings.filter((f) => f.status === "open").length,
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
  if (filter.taskId) {
    rows = await store.review.forTask(filter.taskId, { limit });
    const t = await store.task.get(filter.taskId);
    if (t) titles.set(t.id, t.title);
  } else if (filter.projectId) {
    const tasks = await store.task.list({ project_id: filter.projectId } as never, { limit: 5000 });
    for (const t of tasks) titles.set(t.id, t.title);
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
        if (t) titles.set(t.id, t.title);
      }
    }
  }
  const reviews: ReviewView[] = [];
  const verdicts: Record<string, number> = {};
  let openFindings = 0;
  for (const r of rows) {
    const findings = await store.finding.forReview(r.id);
    const v = reviewView(r, findings, r.task_id ? (titles.get(r.task_id) ?? null) : null);
    reviews.push(v);
    verdicts[v.verdict] = (verdicts[v.verdict] ?? 0) + 1;
    openFindings += v.openFindings;
  }
  const trend = [...reviews]
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
  critic_t1: "Critic tier 1",
  critic_t23: "Critic tier 2 and 3",
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
