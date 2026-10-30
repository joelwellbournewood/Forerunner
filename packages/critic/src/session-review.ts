import { type Clock, errorMessage, log } from "@forerunner/platform";
import type {
  FindingStatus,
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
  // subset of it (a summary may speak of the plan only). Anything else has no record behind it.
  if (claims.done !== undefined && claims.done !== doneTasks && claims.done !== plannedDoneTasks) {
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
    const req = await store.humanRequest.insert({
      human_id: null,
      project_id: data.session.project_id,
      task_id: null,
      session_id: opts.sessionId,
      kind: "approval",
      why: `Session review needs your eyes (grade ${out.grade}): ${out.summary}`.slice(0, 4000),
      steps: out.findings.map((f) => `[${f.severity}] ${f.description}: ${f.requiredAction}`),
      options: ["acknowledge", "cancel"],
      blocking: false,
      risk: "medium",
      author_agent: opts.criticAgentId,
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
