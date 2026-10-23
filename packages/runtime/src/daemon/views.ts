import { CostLedger, FixedRateSource } from "@forerunner/billing";
import type { CommandDef } from "@forerunner/commands";
import { staticRisk } from "@forerunner/commands";
import type {
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
import { defaultRiskTier } from "../session/project-plan.ts";
import { StateLedgerStore } from "../wiring/billing-ports.ts";
import type {
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
  ProjectCard,
  ProjectSummary,
  ReviewsView,
  ReviewView,
  RunView,
  SessionView,
  TaskView,
} from "./api-types.ts";

export function money(usdMicro: number, chfPerUsd: number): Money {
  return { usdMicro, chfMicro: Math.round(usdMicro * chfPerUsd) };
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
  const next = milestones.find((m) => m.status !== "done");
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
  const blocked = tasks.filter((t) => t.status === "needs_human").length;
  const health: ProjectCard["health"] =
    waiting > 0 || blocked > 0
      ? "blocked"
      : failed > 0
        ? "attention"
        : tasks.length === 0
          ? "idle"
          : "good";
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
  const spoken = [
    `${p.name}.`,
    `Goal: ${p.goal}.`,
    `Stage: ${p.stage}.`,
    s.last_session ? `Last session: ${s.last_session.summary}` : "No session yet.",
    next.length ? `Next: ${next.slice(0, 3).join("; ")}.` : "",
    `${s.open_questions ?? 0} open question${(s.open_questions ?? 0) === 1 ? "" : "s"}.`,
    `Spent ${(Math.round(spend.usd_micro * chfPerUsd) / 1e6).toFixed(2)} francs.`,
  ]
    .filter(Boolean)
    .join(" ");
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

export function taskView(t: TaskRow, chfPerUsd: number): TaskView {
  return {
    id: t.id,
    projectId: t.project_id,
    milestoneId: t.milestone_id,
    title: t.title,
    outcome: t.outcome,
    acceptanceCriteria: t.acceptance_criteria,
    riskTier: t.risk_tier as 0 | 1 | 2 | 3,
    status: t.status,
    priority: t.priority,
    claimedBy: t.claimed_by,
    claimExpires: t.claim_expires,
    dependsOn: t.depends_on,
    budget: money(t.budget_usd_micro, chfPerUsd),
    estimate: money(t.est_cost_usd_micro, chfPerUsd),
    actual: money(t.actual_cost_usd_micro, chfPerUsd),
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
      : /warning|skipped|paused|killed|budget/.test(e.type) || typeof payload.warning === "string"
        ? "warning"
        : "info";
  return {
    id: e.id,
    sessionId: e.session_id,
    seq: e.seq,
    type: e.type,
    text: describeEvent(e.type, payload),
    payload: e.payload,
    cost: money(e.cost_usd_micro, chfPerUsd),
    at: e.created_at,
    level,
  };
}

export function describeEvent(type: string, p: Record<string, unknown>): string {
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : 0);
  switch (type) {
    case "session.started":
      return `Session started (${s("trigger")}), budget ${(n("budgetCapUsdMicro") / 1e6).toFixed(2)} USD, ${n("stepCap")} steps, autonomy ${n("autonomy")}.`;
    case "session.brief":
      return `State brief ready: ${n("unread")} unread, ${n("ready")} ready task(s)${Array.isArray(p.warnings) && p.warnings.length ? `, warnings: ${(p.warnings as string[]).join("; ")}` : ""}.`;
    case "session.planned":
      return `Plan: ${n("items")} item(s), estimate ${(n("estimateUsdMicro") / 1e6).toFixed(2)} USD. ${s("summary")}`;
    case "session.paused":
      return `Paused: ${s("reason")}.`;
    case "task.started":
      return `Started "${s("title")}" with ${s("specialist")} (estimate ${(n("estimateUsdMicro") / 1e6).toFixed(2)} USD).`;
    case "task.finished":
      return `Finished task: ${s("outcome")} (${(n("costUsdMicro") / 1e6).toFixed(2)} USD). ${s("summary").slice(0, 200)}`;
    case "task.skipped":
      return `Skipped task: ${s("reason")}${s("holder") ? ` (held by ${s("holder")})` : ""}.`;
    case "inbox.message":
      return `Inbox: ${s("type")} message from ${s("from")}.`;
    case "session.error":
      return `Error: ${s("code")} ${s("message")}`;
    case "session.ended":
      return `Session ended: ${s("status")} (${s("stopReason")}), spent ${(n("spentUsdMicro") / 1e6).toFixed(2)} USD, done ${n("completed")}, in review ${n("inReview")}, failed ${n("failed")}, not started ${n("skipped")}.`;
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
      return `Critic review started at tier ${n("tier")} (attempt ${n("attempt") + 1}).`;
    case "critic.verdict":
      return `Critic verdict: ${s("verdict")} (grade ${n("grade")}, confidence ${n("confidence").toFixed(2)}, ${n("findings")} finding(s), ${n("openFindings")} open) -> ${s("decision")}${s("retry") ? ` (${s("retry")})` : ""}${s("nextTier") ? ` on ${s("nextTier")}` : ""}. ${s("summary")}`;
    case "critic.review_failed":
      return `Critic review failed: ${s("warning")}`;
    case "critic.session_review":
      return `Session review: ${s("verdict")} (grade ${n("grade")}, ${n("findings")} finding(s)). ${s("summary")}`;
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
      return `${type} ${JSON.stringify(p).slice(0, 200)}`;
  }
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
    options: r.options.map(String),
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
