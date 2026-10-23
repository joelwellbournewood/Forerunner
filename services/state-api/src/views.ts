import type {
  CostView as CostViewType,
  EventView as EventViewType,
  HumanRequestView as HumanRequestViewType,
  MessageView as MessageViewType,
  Money as MoneyType,
  ProjectCard as ProjectCardType,
  SessionView as SessionViewType,
  TaskView as TaskViewType,
} from "@forerunner/runtime/daemon/api-types";
import type {
  CostBucket,
  CostFilter,
  DataAssetRow,
  DecisionRow,
  DeviceRow,
  EventRow,
  FindingRow,
  HumanRequestRow,
  MessageRow,
  ProjectRow,
  QueueItemRow,
  RemoteCommandRow,
  ReviewRow,
  SessionRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";

/**
 * Row -> view mapping. The phone and the approvals web page reuse the daemon API shapes
 * (ADR 0011) so one UI renders data from either source. Money crosses as USD micro-units
 * plus CHF micro-units; the ledger carries exact CHF per entry, and figures that only exist
 * in USD (budgets, estimates) are converted at the rate `chfPerUsd` the caller supplies
 * (the latest ledger rate when nothing better is configured).
 */
export type Money = MoneyType;

export function money(usdMicro: number, chfPerUsd: number): Money {
  return { usdMicro: Math.round(usdMicro), chfMicro: Math.round(usdMicro * chfPerUsd) };
}

/** Rate from the most recent ledger entry, else the configured fallback, else 0. */
export async function currentChfRate(
  store: StateStore,
  fallback: number | undefined,
): Promise<number> {
  const [latest] = await store.costLedger.list(undefined, {
    orderBy: "occurred_at desc",
    limit: 1,
  });
  if (latest && latest.rate_chf_per_usd > 0) return latest.rate_chf_per_usd;
  return fallback ?? 0;
}

export function taskView(t: TaskRow, rate: number): TaskViewType {
  return {
    id: t.id,
    projectId: t.project_id,
    milestoneId: t.milestone_id,
    title: t.title,
    outcome: t.outcome,
    acceptanceCriteria: t.acceptance_criteria,
    riskTier: t.risk_tier,
    status: t.status,
    priority: t.priority,
    claimedBy: t.claimed_by,
    claimExpires: t.claim_expires,
    dependsOn: t.depends_on,
    budget: money(t.budget_usd_micro, rate),
    estimate: money(t.est_cost_usd_micro, rate),
    actual: money(t.actual_cost_usd_micro, rate),
    specialist: t.specialist,
    attempt: t.attempt,
    prUrl: t.pr_url,
    branch: t.branch,
    reason: t.reason,
    updatedAt: t.updated_at,
    version: t.version,
  };
}

export function messageView(m: MessageRow, fromAgentName: string): MessageViewType {
  return {
    id: m.id,
    fromAgentId: m.from_agent_id,
    fromAgentName,
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

export function humanRequestView(
  r: HumanRequestRow,
  projectName: string | null,
): HumanRequestViewType {
  return {
    id: r.id,
    projectId: r.project_id,
    projectName,
    taskId: r.task_id,
    sessionId: r.session_id,
    kind: r.kind,
    why: r.why,
    steps: r.steps,
    options: r.options.map((o) => (typeof o === "string" ? o : JSON.stringify(o))),
    blocking: r.blocking,
    risk: r.risk,
    changeCard: r.change_card,
    status: r.status,
    answer: r.answer,
    createdAt: r.created_at,
    version: r.version,
  };
}

export function sessionView(
  s: SessionRow,
  agentName: string,
  rate: number,
  currentTask: { id: string; title: string; specialist: string } | null,
): SessionViewType {
  return {
    id: s.id,
    agentId: s.agent_id,
    agentName,
    projectId: s.project_id,
    trigger: s.trigger,
    status: s.status,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    budgetCap: money(s.budget_cap_usd_micro, rate),
    spent: money(s.spent_usd_micro, rate),
    stepCap: s.step_cap,
    steps: s.steps,
    currentTask,
    summary: s.summary,
    handoff: s.handoff,
    runner: s.runner,
  };
}

function eventLevel(type: string): EventViewType["level"] {
  if (/error|fail/i.test(type)) return "error";
  if (/escalat|needs_human|approval/i.test(type)) return "escalation";
  if (/warn|budget|cap/i.test(type)) return "warning";
  return "info";
}

function eventText(e: EventRow): string {
  if (e.redacted) return `${e.type} (redacted)`;
  const p = e.payload;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const text = (p as { text?: unknown; message?: unknown; summary?: unknown }).text;
    const message = (p as { message?: unknown }).message;
    const summary = (p as { summary?: unknown }).summary;
    const line = [text, message, summary].find((v) => typeof v === "string");
    if (typeof line === "string") return `${e.type}: ${line.slice(0, 500)}`;
  }
  return e.type;
}

export function eventView(e: EventRow, rate: number): EventViewType {
  return {
    id: e.id,
    sessionId: e.session_id,
    seq: e.seq,
    type: e.type,
    text: eventText(e),
    payload: e.redacted ? null : e.payload,
    cost: money(e.cost_usd_micro, rate),
    at: e.created_at,
    level: eventLevel(e.type),
  };
}

export interface DeviceView {
  id: string;
  ownerHumanId: string;
  name: string;
  platform: string;
  kind: string;
  publicKey: string;
  lastSeen: string | null;
  revoked: boolean;
  revokedAt: string | null;
  pairedAt: string;
  /** True when the device holds an FCM registration token (the token itself is never served). */
  pushRegistered: boolean;
  version: number;
}

export function deviceView(d: DeviceRow): DeviceView {
  return {
    id: d.id,
    ownerHumanId: d.owner_human_id,
    name: d.name,
    platform: d.platform,
    kind: d.kind,
    publicKey: d.public_key,
    lastSeen: d.last_seen,
    revoked: d.revoked,
    revokedAt: d.revoked_at,
    pairedAt: d.paired_at,
    pushRegistered: typeof d.push_token === "string" && d.push_token !== "",
    version: d.version,
  };
}

export interface RemoteCommandView {
  id: string;
  deviceId: string;
  target: string;
  targetDeviceId: string | null;
  command: string;
  params: Record<string, unknown>;
  status: string;
  pickedUpAt: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export function remoteCommandView(r: RemoteCommandRow): RemoteCommandView {
  return {
    id: r.id,
    deviceId: r.device_id,
    target: r.target,
    targetDeviceId: r.target_device_id,
    command: r.command,
    params: r.params,
    status: r.status,
    pickedUpAt: r.picked_up_at,
    result: r.result,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

export interface QueueItemView {
  id: string;
  projectId: string;
  humanId: string;
  kind: string;
  text: string;
  priority: number;
  status: string;
  createdAt: string;
  version: number;
}

export function queueItemView(q: QueueItemRow): QueueItemView {
  return {
    id: q.id,
    projectId: q.project_id,
    humanId: q.human_id,
    kind: q.kind,
    text: q.text,
    priority: q.priority,
    status: q.status,
    createdAt: q.created_at,
    version: q.version,
  };
}

export interface DecisionView {
  id: string;
  projectId: string;
  question: string;
  options: unknown[];
  chosen: string;
  decidedBy: string;
  rationale: string;
  supersedes: string | null;
  supersededBy: string | null;
  createdAt: string;
  version: number;
}

export function decisionView(d: DecisionRow): DecisionView {
  return {
    id: d.id,
    projectId: d.project_id,
    question: d.question,
    options: d.options,
    chosen: d.chosen,
    decidedBy: d.decided_by,
    rationale: d.rationale,
    supersedes: d.supersedes,
    supersededBy: d.superseded_by,
    createdAt: d.created_at,
    version: d.version,
  };
}

export interface FindingView {
  id: string;
  reviewId: string;
  taskId: string | null;
  severity: string;
  description: string;
  requiredAction: string;
  status: string;
  resolvedByRun: string | null;
  version: number;
}

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
    version: f.version,
  };
}

export interface ReviewView {
  id: string;
  taskId: string | null;
  taskTitle: string | null;
  prUrl: string | null;
  sessionId: string | null;
  criticModel: string;
  tier: number;
  grade: number;
  confidence: number;
  verdict: string;
  evidence: unknown[];
  summary: string;
  findings: FindingView[];
  createdAt: string;
  version: number;
}

export function reviewView(
  r: ReviewRow,
  task: TaskRow | undefined,
  findings: FindingRow[],
): ReviewView {
  return {
    id: r.id,
    taskId: r.task_id,
    taskTitle: task?.title ?? null,
    prUrl: task?.pr_url ?? null,
    sessionId: r.session_id,
    criticModel: r.critic_model,
    tier: r.tier,
    grade: r.grade,
    confidence: r.confidence,
    verdict: r.verdict,
    evidence: r.evidence,
    summary: r.summary,
    findings: findings.map(findingView),
    createdAt: r.created_at,
    version: r.version,
  };
}

export interface DataAssetView {
  id: string;
  projectIds: string[];
  /** File name only; the storage path never leaves the service. */
  name: string;
  sizeBytes: number;
  kind: string;
  registeredBy: string;
  createdAt: string;
}

export function dataAssetView(a: DataAssetRow): DataAssetView {
  const name = a.locator.split(/[\\/]/).pop() ?? a.locator;
  return {
    id: a.id,
    projectIds: a.project_ids,
    name: name.replace(/^[0-9a-f-]{36}-/, ""),
    sizeBytes: a.size_bytes,
    kind: a.kind,
    registeredBy: a.registered_by,
    createdAt: a.created_at,
  };
}

function bucket(b: CostBucket, label: string, rate: number): CostViewType["byModel"][number] {
  return {
    key: b.key ?? "",
    label,
    cost: { usdMicro: b.usd_micro, chfMicro: b.chf_micro || Math.round(b.usd_micro * rate) },
    runs: b.entries,
    accepted: null,
  };
}

export async function costView(
  store: StateStore,
  filter: CostFilter,
  rate: number,
  range: { from: string; to: string },
): Promise<CostViewType> {
  const totals = await store.costLedger.sum(filter);
  const [byModel, bySpecialist, byTask, byProject] = await Promise.all([
    store.costLedger.byModel(filter),
    store.costLedger.bySpecialist(filter),
    store.costLedger.breakdown("task_id", filter),
    store.costLedger.byProject(filter),
  ]);
  const projectNames = new Map<string, string>();
  for (const b of byProject) {
    if (!b.key) continue;
    const p = await store.project.get(b.key);
    if (p) projectNames.set(b.key, p.name);
  }
  const taskTitles = new Map<string, string>();
  for (const b of byTask) {
    if (!b.key) continue;
    const t = await store.task.get(b.key);
    if (t) taskTitles.set(b.key, t.title);
  }
  return {
    totals: { usdMicro: totals.usd_micro, chfMicro: totals.chf_micro },
    planUsageShare: totals.plan_usage_share,
    byModel: byModel.map((b) => bucket(b, b.key ?? "unknown", rate)),
    bySpecialist: bySpecialist.map((b) => bucket(b, b.key ?? "(none)", rate)),
    byTask: byTask.map((b) => bucket(b, taskTitles.get(b.key ?? "") ?? b.key ?? "(none)", rate)),
    byProject: byProject.map((b) =>
      bucket(b, projectNames.get(b.key ?? "") ?? b.key ?? "(none)", rate),
    ),
    savings: {
      compressionTokens: 0,
      cacheTokens: totals.cache_read_tokens,
      compression: { usdMicro: 0, chfMicro: 0 },
      cache: { usdMicro: 0, chfMicro: 0 },
    },
    from: range.from,
    to: range.to,
  };
}

/** ProjectCard with the derived fields the dashboard needs (health, spend, waiting count). */
export async function projectCard(
  store: StateStore,
  p: ProjectRow,
  rate: number,
  now: string,
): Promise<ProjectCardType> {
  const [spend, openRequests, milestones, sessions, gradeRows] = await Promise.all([
    store.costLedger.sum({ projectId: p.id }),
    store.humanRequest.open({ projectId: p.id }),
    store.milestone.forProject(p.id),
    store.session.forProject(p.id, { limit: 1 }),
    store.db.query<{ grade: unknown }>(
      `SELECT r."grade" AS grade FROM "review" r JOIN "task" t ON t."id" = r."task_id"
        WHERE t."project_id" = ? ORDER BY r."created_at" DESC, r."id" DESC LIMIT 1`,
      [p.id],
    ),
  ]);
  const next = milestones.find((m) => m.status === "planned" || m.status === "active") ?? null;
  const lastSession = sessions[0];
  const lastSessionAt = lastSession?.ended_at ?? lastSession?.started_at ?? null;
  const blocking = openRequests.some((r) => r.blocking);
  const overBudget = p.budget_usd_micro > 0 && spend.usd_micro >= p.budget_usd_micro * 0.8;
  const idleMs = lastSessionAt
    ? Date.parse(now) - Date.parse(lastSessionAt)
    : Number.POSITIVE_INFINITY;
  const health: ProjectCardType["health"] = blocking
    ? "blocked"
    : openRequests.length > 0 || overBudget
      ? "attention"
      : idleMs > 7 * 24 * 3600 * 1000
        ? "idle"
        : "good";
  const grade = gradeRows[0]?.grade;
  return {
    id: p.id,
    name: p.name,
    goal: p.goal,
    stage: p.stage,
    status: p.status,
    autonomyLevel: Math.max(0, Math.min(4, p.autonomy_level)),
    nextMilestone: next ? { id: next.id, name: next.name, targetDate: next.target_date } : null,
    health,
    spend: { usdMicro: spend.usd_micro, chfMicro: spend.chf_micro },
    budget: money(p.budget_usd_micro, rate),
    waitingOnYou: openRequests.length,
    latestCriticGrade: grade === undefined || grade === null ? null : Number(grade),
    lastSessionAt,
    active: p.active,
  };
}
