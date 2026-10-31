import { type Clock, errorMessage, log } from "@forerunner/platform";
import type {
  FindingStatus,
  HumanRequestRow,
  JsonValue,
  RunRow,
  SessionRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import { fingerprintOf } from "./fingerprint.ts";
import { patternsFor } from "./patterns.ts";
import { applyVerdictRules, isBlocking } from "./rules.ts";
import type { ReviewFinding, ReviewOutput, ReviewTier, Severity, Verdict } from "./types.ts";

/**
 * Session-level review (H.6): plan quality, cost efficiency and honesty of the summary to the
 * human. Every check here is deterministic and runs against the state store, so the grade a
 * model gives a session can only go down from what the facts allow (critic.ts takes the
 * minimum). The checks:
 *
 * - plan quality: the plan's estimate fits the session budget; every item points at a task
 *   that exists and was a real ready task (not a draft); no spend without a plan;
 * - cost efficiency: actual spend (ledger, falling back to the session counter) against the
 *   plan's estimate, and cost per accepted (done) task;
 * - honesty: the claims in the summary ("Done: N", "Cost: USD x") against the task states and
 *   the ledger. Done tasks are counted over every task the session planned or ran (a run can
 *   finish a task the plan did not list); a count that matches neither that nor the planned
 *   subset is a high finding and ends in a human verdict: the human was told something untrue.
 */
export interface SessionPlanItemLike {
  taskId: string;
  title?: string;
  specialist?: string;
  estimateUsdMicro?: number;
}

export interface SessionReviewData {
  session: SessionRow;
  planItems: SessionPlanItemLike[];
  planEstimateUsdMicro: number;
  /** Tasks the plan names or the session ran, by id. */
  tasks: Map<string, TaskRow>;
  runs: RunRow[];
  /** Sum of the cost ledger for the session; null when the ledger has no rows for it. */
  ledgerUsdMicro: number | null;
}

export interface SessionMetrics {
  plannedTasks: number;
  /** Done tasks among the plan items. */
  plannedDoneTasks: number;
  /** Done tasks among everything the session planned or ran. */
  doneTasks: number;
  estimateUsdMicro: number;
  actualUsdMicro: number;
  costPerDoneTaskUsdMicro: number | null;
  claimedDone: number | null;
  claimedCostUsdMicro: number | null;
}

export interface SessionChecks {
  grade: number;
  confidence: number;
  verdict: Verdict;
  findings: ReviewFinding[];
  evidence: string[];
  metrics: SessionMetrics;
}

export interface SummaryClaims {
  done?: number;
  failed?: number;
  costUsdMicro?: number;
}

/** Actual spend more than this share over the estimate is a cost-efficiency finding. */
export const COST_OVERRUN_RATIO = 1.5;
/** Overruns and cost claims below this absolute difference are noise (one US cent). */
export const COST_NOISE_USD_MICRO = 10_000;
/** A cost claim in the summary may differ from the ledger by this share. */
export const COST_CLAIM_TOLERANCE = 0.1;

const PENALTY: Record<Severity, number> = { critical: 50, high: 30, medium: 15, low: 5, info: 0 };

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Plan items from a stored plan: `{ items: [...] }` (the runtime's SessionPlan) or a bare array. */
export function planItemsOf(plan: JsonValue): SessionPlanItemLike[] {
  const raw = Array.isArray(plan)
    ? plan
    : plan && typeof plan === "object" && Array.isArray((plan as { items?: unknown }).items)
      ? ((plan as { items: unknown[] }).items as JsonValue[])
      : [];
  const items: SessionPlanItemLike[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const o = it as Record<string, unknown>;
    if (typeof o.taskId !== "string" || !o.taskId) continue;
    items.push({
      taskId: o.taskId,
      title: typeof o.title === "string" ? o.title : undefined,
      specialist: typeof o.specialist === "string" ? o.specialist : undefined,
      estimateUsdMicro: num(o.estimateUsdMicro),
    });
  }
  return items;
}

export function planEstimateOf(plan: JsonValue, items: SessionPlanItemLike[]): number {
  const total = num((plan as { estimateUsdMicro?: unknown } | null)?.estimateUsdMicro);
  if (total !== undefined) return total;
  return items.reduce((s, i) => s + (i.estimateUsdMicro ?? 0), 0);
}

export async function loadSessionReviewData(
  store: StateStore,
  sessionId: string,
): Promise<SessionReviewData> {
  const session = await store.session.mustGet(sessionId);
  const planItems = planItemsOf(session.plan);
  const runs = await store.run.forSession(sessionId);
  const ids = new Set<string>(planItems.map((i) => i.taskId));
  for (const r of runs) if (r.task_id) ids.add(r.task_id);
  const tasks = new Map<string, TaskRow>();
  for (const id of ids) {
    const t = await store.task.get(id);
    if (t) tasks.set(id, t);
  }
  const ledger = await store.costLedger.sum({ sessionId });
  return {
    session,
    planItems,
    planEstimateUsdMicro: planEstimateOf(session.plan, planItems),
    tasks,
    runs,
    ledgerUsdMicro: ledger.entries > 0 ? ledger.usd_micro : null,
  };
}

const usd = (micro: number): string => `USD ${(micro / 1_000_000).toFixed(4)}`;

/**
 * Claims a summary makes that the store can check. Deliberately narrow: counts introduced by
 * "done", "completed" or "finished" and an amount introduced by "cost", "spent" or "total".
 */
export function parseSummaryClaims(summary: string): SummaryClaims {
  const out: SummaryClaims = {};
  const text = summary.replace(/\s+/g, " ");
  const done =
    /\b(?:done|completed|finished)\s*[:=]\s*(\d+)\b/i.exec(text) ??
    /\b(\d+)\s+(?:tasks?\s+)?(?:done|completed|finished)\b/i.exec(text) ??
    /\b(?:completed|finished)\s+(?:all\s+)?(\d+)\s+tasks?\b/i.exec(text);
  if (done?.[1] !== undefined) out.done = Number(done[1]);
  const failed =
    /\bfailed\s*[:=]\s*(\d+)\b/i.exec(text) ?? /\b(\d+)\s+(?:tasks?\s+)?failed\b/i.exec(text);
  if (failed?.[1] !== undefined) out.failed = Number(failed[1]);
  const cost =
    /\b(?:cost|spent|spend|total)\b[^\d$\n]{0,24}(?:USD|US\$|\$)\s*(\d+(?:\.\d+)?)/i.exec(text);
  if (cost?.[1] !== undefined) out.costUsdMicro = Math.round(Number(cost[1]) * 1_000_000);
  return out;
}

export function sessionChecks(data: SessionReviewData): SessionChecks {
  const { session, planItems } = data;
  const findings: ReviewFinding[] = [];
  const evidence: string[] = [];
  const seen = new Set<string>();
  const add = (severity: Severity, description: string, requiredAction: string, where?: string) => {
    const fingerprint = fingerprintOf(description);
    if (fingerprint && seen.has(fingerprint)) return;
    seen.add(fingerprint);
    findings.push({ severity, description, requiredAction, fingerprint, where });
  };
  let honestyBroken = false;

  // Plan quality.
  const estimate = data.planEstimateUsdMicro;
  const cap = session.budget_cap_usd_micro;
  if (cap > 0 && estimate > cap) {
    add(
      "medium",
      `Plan estimate ${usd(estimate)} exceeded the session budget ${usd(cap)}`,
      "Plan within the budget: cut or defer items until the estimate fits",
      `plan estimate ${estimate} > cap ${cap}`,
    );
  }
  const planned = new Set<string>();
  for (const item of planItems) {
    const label = item.title ?? item.taskId;
    if (planned.has(item.taskId))
      add("low", `Plan lists the same task twice: ${label}`, "Plan each task once");
    planned.add(item.taskId);
    const task = data.tasks.get(item.taskId);
    if (!task) {
      add(
        "high",
        `Plan item references a task that does not exist: ${label}`,
        "Plan only tasks that exist in the project",
        item.taskId,
      );
    } else if (task.status === "draft") {
      add(
        "medium",
        `Plan item was not a ready task: ${task.title} is still a draft`,
        "Plan only ready tasks whose dependencies are done",
        task.id,
      );
    }
  }
  const actual = data.ledgerUsdMicro ?? session.spent_usd_micro;
  if (planItems.length === 0 && actual > 0) {
    add(
      "medium",
      `Session spent ${usd(actual)} without a plan`,
      "Write the plan before spending; the human approves it at autonomy 1",
    );
  }
  evidence.push(
    `plan: ${planItems.length} item(s), estimate ${usd(estimate)}, budget ${usd(cap)}${cap > 0 && estimate > cap ? " (over)" : ""}`,
  );

  // Cost efficiency. Done is counted over every task the session planned or ran.
  const plannedDoneTasks = [...planned].filter(
    (id) => data.tasks.get(id)?.status === "done",
  ).length;
  const doneTasks = [...data.tasks.values()].filter((t) => t.status === "done").length;
  if (
    estimate > 0 &&
    actual > estimate * COST_OVERRUN_RATIO &&
    actual - estimate > COST_NOISE_USD_MICRO
  ) {
    const pct = Math.round(((actual - estimate) / estimate) * 100);
    add(
      "medium",
      `Session cost ${usd(actual)} exceeded its estimate ${usd(estimate)} by ${pct}%`,
      "Record the overrun against the estimate so the next plan is calibrated; split the work that overran",
    );
  }
  if (cap > 0 && actual > cap) {
    add(
      "high",
      `Session cost ${usd(actual)} exceeded its cap ${usd(cap)}`,
      "The runtime caps must have stopped the session; check the ledger and the hooks",
    );
  }
  if (actual > 0 && planItems.length > 0 && doneTasks === 0 && session.status === "completed") {
    add(
      "medium",
      `Session spent ${usd(actual)} and no task reached done`,
      "Say in the summary what the spend bought and what blocks the tasks",
    );
  }
  // U-017: a session whose every task failed at once spends nothing, and graded 100.
  const plannedFailed = [...planned].filter((id) => data.tasks.get(id)?.status === "failed");
  if (plannedDoneTasks === 0 && plannedFailed.length > 0) {
    add(
      "medium",
      `No planned task was done: ${plannedFailed.length} of ${planned.size} failed`,
      "Read each failed task's reason and fix what stopped it before planning it again",
      plannedFailed.join(", "),
    );
  }
  const costPerDone = doneTasks > 0 ? Math.round(actual / doneTasks) : null;
  evidence.push(
    `cost: actual ${usd(actual)} (${data.ledgerUsdMicro === null ? "session counter" : "ledger"}), estimate ${usd(estimate)}, ${doneTasks} done task(s)${costPerDone !== null ? `, ${usd(costPerDone)} per done task` : ""}`,
  );

  // Honesty of the summary.
  const summary = session.summary ?? "";
  const claims = parseSummaryClaims(summary);
  const terminal = ["completed", "stopped", "failed", "killed"].includes(session.status);
  // A done count is honest when it matches what the session planned and ran, or the planned
  // subset of it (a summary may speak of the plan only), either now or as the tasks stood when
  // the session ended (the review runs later, and a task finished after the end by a later
  // session or a critic's accept was not the summary's to count), or the tasks this session's
  // own runs finished (a planned task a peer finished, picked up at the start, is not this
  // session's work). Anything else has no record behind it.
  const endedAt = session.ended_at;
  const ranHere = new Set(data.runs.map((r) => r.task_id).filter((id): id is string => !!id));
  const doneAtEnd = (ids: Iterable<string>) =>
    [...ids].filter((id) => {
      const t = data.tasks.get(id);
      return t?.status === "done" && (!endedAt || t.updated_at <= endedAt);
    }).length;
  const honestCounts = new Set([
    doneTasks,
    plannedDoneTasks,
    doneAtEnd(data.tasks.keys()),
    doneAtEnd(planned),
    doneAtEnd(ranHere),
  ]);
  if (claims.done !== undefined && !honestCounts.has(claims.done)) {
    honestyBroken = true;
    add(
      "high",
      `Summary claims ${claims.done} task(s) done but ${doneTasks} of the ${data.tasks.size} task(s) the session planned or ran are done`,
      "Report counts from the task states; every claim in the summary needs a record behind it",
      `summary says done ${claims.done}; task table says ${doneTasks} (${plannedDoneTasks} among the ${planned.size} planned)`,
    );
  }
  if (
    claims.costUsdMicro !== undefined &&
    Math.abs(claims.costUsdMicro - actual) >
      Math.max(COST_NOISE_USD_MICRO, actual * COST_CLAIM_TOLERANCE)
  ) {
    add(
      "medium",
      `Summary claims a cost of ${usd(claims.costUsdMicro)} but the ledger shows ${usd(actual)}`,
      "Report the cost from the ledger",
      `summary ${claims.costUsdMicro} vs ledger ${actual}`,
    );
  }
  if (terminal && planItems.length > 0 && summary.trim() === "") {
    add(
      "low",
      "Summary to the human is empty",
      "Write a summary: done, in flight, blocked, next, cost",
    );
  }
  const verifiable = claims.done !== undefined || claims.costUsdMicro !== undefined;
  evidence.push(
    `honesty: summary ${summary.trim() === "" ? "empty" : `${summary.trim().length} chars`}, ` +
      `claims ${verifiable ? JSON.stringify(claims) : "none parseable"}; checked against ${data.tasks.size} task(s) and the ledger`,
  );

  const grade = Math.max(0, 100 - findings.reduce((s, f) => s + PENALTY[f.severity], 0));
  // Facts from the store are certain; a summary with no checkable claim leaves honesty unverified.
  const confidence = verifiable || summary.trim() === "" ? 0.95 : 0.7;
  const verdict: Verdict = honestyBroken ? "human" : isBlocking(findings) ? "revise" : "accept";
  return {
    grade,
    confidence,
    verdict,
    findings,
    evidence,
    metrics: {
      plannedTasks: planned.size,
      plannedDoneTasks,
      doneTasks,
      estimateUsdMicro: estimate,
      actualUsdMicro: actual,
      costPerDoneTaskUsdMicro: costPerDone,
      claimedDone: claims.done ?? null,
      claimedCostUsdMicro: claims.costUsdMicro ?? null,
    },
  };
}

export const SESSION_REVIEW_MODEL = "none";

export interface ReviewSessionOptions {
  store: StateStore;
  sessionId: string;
  /** The critic AgentRow id: author of the rows. */
  criticAgentId: string;
  clock?: Clock;
  /** Tier recorded on the review (the rules for that tier apply). Default 0: no model. */
  tier?: ReviewTier;
  /** False skips every write. Default true. */
  persist?: boolean;
  /** The human a review that needs one is filed for. Default: the owner of the session's agent. */
  humanId?: string | null;
}

/**
 * The request a session review files when it needs the human (verdict `human`: the summary
 * the human received says something the records do not, or a model read at tier 1+ asks for
 * them). It is filed for the session's owner, the human who owns the agent (U-033: it was
 * filed for nobody, and both inboxes list by human), and its options each do something; the
 * runtime's `syncSessionReviewAnswers` applies the answer:
 *
 *   "Acknowledge" -> the request closes; the review's open findings are marked `wontfix`
 *       (seen by the human; a past session has nothing left to fix).
 *   "Correct the summary" -> the session's summary gets a correction from the records the
 *       review checked (done tasks, spend), so every screen and the next session's diff read
 *       the true numbers; the summary findings are resolved, the others marked `wontfix`.
 *
 * The options were "acknowledge" and "cancel"; a session review is filed after its session
 * ended, so there was nothing for "cancel" to cancel (it came from the task sign-off, where it
 * cancels the task). A request filed with those options is read the same way, "cancel" as an
 * acknowledgement.
 */
export const SESSION_REVIEW_KEY = "critic:session_review";
export const SESSION_REVIEW_OPTIONS = ["Acknowledge", "Correct the summary"] as const;
export type SessionReviewAnswer = "acknowledge" | "correct";
const LEGACY_SESSION_REVIEW_OPTIONS = ["acknowledge", "cancel"] as const;

/** The answer of a session review request as one of its options, or null. */
export function sessionReviewAnswer(answer: JsonValue | null): SessionReviewAnswer | null {
  const raw =
    typeof answer === "string"
      ? answer
      : answer && typeof answer === "object" && !Array.isArray(answer)
        ? ((answer as Record<string, unknown>).choice ?? (answer as Record<string, unknown>).answer)
        : null;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(acknowledge|acknowledged|ok|seen|cancel)$/.test(v)) return "acknowledge";
  if (/^(correct the summary|correct|correct it|fix the summary)$/.test(v)) return "correct";
  return null;
}

/** Whether a request is a session review request (its card key, or the options it had before). */
export function isSessionReviewRequest(
  row: Pick<HumanRequestRow, "kind" | "task_id" | "session_id" | "options" | "change_card">,
): boolean {
  if (row.kind !== "approval" || row.task_id || !row.session_id) return false;
  const key = (row.change_card as Record<string, unknown> | null)?.key;
  if (typeof key === "string") return key === SESSION_REVIEW_KEY;
  return (
    row.options.length === LEGACY_SESSION_REVIEW_OPTIONS.length &&
    LEGACY_SESSION_REVIEW_OPTIONS.every((o, i) => row.options[i] === o)
  );
}

/** The human who owns the session's agent; null when the agent row is gone. */
export async function sessionOwnerOf(
  store: Pick<StateStore, "agent">,
  session: Pick<SessionRow, "agent_id">,
): Promise<string | null> {
  return (await store.agent.get(session.agent_id))?.owner_human_id ?? null;
}

export interface SessionReviewRequestInput {
  session: SessionRow;
  /** The human to file it for; null or absent: the owner of the session's agent. */
  humanId?: string | null;
  criticAgentId: string;
  reviewId: string;
  grade: number;
  summary: string;
  findings: readonly ReviewFinding[];
  findingIds: readonly string[];
  /** What the deterministic checks measured; the correction states these numbers. */
  metrics?: SessionMetrics;
}

/** File the session review's request for the human (see `SESSION_REVIEW_KEY`). */
export async function fileSessionReviewRequest(
  store: Pick<StateStore, "humanRequest" | "agent">,
  input: SessionReviewRequestInput,
): Promise<HumanRequestRow> {
  const humanId = input.humanId ?? (await sessionOwnerOf(store, input.session));
  const m = input.metrics;
  return store.humanRequest.insert({
    human_id: humanId,
    project_id: input.session.project_id,
    task_id: null,
    session_id: input.session.id,
    kind: "approval",
    why: `Session review needs your eyes (grade ${input.grade}): ${input.summary} Acknowledge it, or have the session's summary corrected from the records.`.slice(
      0,
      4000,
    ),
    steps: input.findings.map((f) => `[${f.severity}] ${f.description}: ${f.requiredAction}`),
    options: [...SESSION_REVIEW_OPTIONS],
    blocking: false,
    risk: "medium",
    change_card: {
      key: SESSION_REVIEW_KEY,
      session_id: input.session.id,
      review_id: input.reviewId,
      finding_ids: [...input.findingIds],
      ...(m
        ? {
            metrics: {
              done_tasks: m.doneTasks,
              planned_done_tasks: m.plannedDoneTasks,
              planned_tasks: m.plannedTasks,
              actual_usd_micro: m.actualUsdMicro,
              claimed_done: m.claimedDone,
              claimed_cost_usd_micro: m.claimedCostUsdMicro,
            },
          }
        : {}),
      applied_at: null,
    },
    author_agent: input.criticAgentId,
  });
}

/**
 * Review a session with the deterministic checks only (no model call) and persist the
 * ReviewRow (subject: session) with its findings. CriticService.review({kind:"session"}) at
 * tier 1+ adds a model read on top of these checks.
 */
export async function reviewSession(opts: ReviewSessionOptions): Promise<ReviewOutput> {
  const { store } = opts;
  const clock = opts.clock ?? store.clock;
  const tier = opts.tier ?? 0;
  const t0 = clock.monotonic();
  const data = await loadSessionReviewData(store, opts.sessionId);
  const checks = sessionChecks(data);
  const ruled = applyVerdictRules(checks, tier);
  const summary =
    `Session review: ${checks.metrics.doneTasks} done task(s) (${checks.metrics.plannedDoneTasks}/${checks.metrics.plannedTasks} planned), ` +
    `cost ${usd(checks.metrics.actualUsdMicro)} against an estimate of ${usd(checks.metrics.estimateUsdMicro)}; ` +
    `${checks.findings.length} finding(s).`;
  const out: ReviewOutput = {
    grade: ruled.grade,
    confidence: ruled.confidence,
    verdict: ruled.verdict,
    findings: checks.findings,
    evidence: checks.evidence,
    summary,
    model: SESSION_REVIEW_MODEL,
    tier,
    durationMs: Math.max(0, Math.round(clock.monotonic() - t0)),
    costUsdMicro: 0,
    outcome: "completed",
    adjustments: ruled.adjustments,
    patterns: [],
    lessonProposals: [],
  };
  if (opts.persist === false) return out;

  const review = await store.review.insert({
    task_id: null,
    session_id: opts.sessionId,
    critic_model: out.model,
    tier,
    grade: out.grade,
    confidence: out.confidence,
    verdict: out.verdict,
    evidence: out.evidence as JsonValue[],
    summary: out.summary,
    author_agent: opts.criticAgentId,
  });
  const status: FindingStatus = out.verdict === "accept" ? "wontfix" : "open";
  const findingIds: string[] = [];
  for (const f of out.findings) {
    const row = await store.finding.insert({
      review_id: review.id,
      task_id: null,
      severity: f.severity,
      description: f.description,
      required_action: f.requiredAction,
      status,
      fingerprint: f.fingerprint,
      author_agent: opts.criticAgentId,
    });
    findingIds.push(row.id);
  }
  let humanRequestId: string | undefined;
  if (out.verdict === "human") {
    const req = await fileSessionReviewRequest(store, {
      session: data.session,
      humanId: opts.humanId ?? null,
      criticAgentId: opts.criticAgentId,
      reviewId: review.id,
      grade: out.grade,
      summary: out.summary,
      findings: out.findings,
      findingIds,
      metrics: checks.metrics,
    });
    humanRequestId = req.id;
  }
  const { patterns, lessonProposals } = await patternsFor(store, out.findings);
  try {
    // Its own type (U-017): the runner reports the review as `critic.session_review`, and a
    // second event of that type showed the review twice in the session log.
    await store.event.append(opts.sessionId, "critic.session_review_metrics", {
      reviewId: review.id,
      grade: out.grade,
      verdict: out.verdict,
      findings: out.findings.length,
      metrics: checks.metrics as unknown as JsonValue,
      at: clock.nowIso(),
    } as JsonValue);
  } catch (e) {
    log("critic").warn("could not append the session review event", { error: errorMessage(e) });
  }
  return { ...out, reviewId: review.id, findingIds, humanRequestId, patterns, lessonProposals };
}
