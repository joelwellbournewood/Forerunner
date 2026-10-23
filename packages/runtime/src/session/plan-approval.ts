import { createHash } from "node:crypto";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, JsonValue, StateStore } from "@forerunner/state";
import { unappliedAnswers } from "./findings.ts";
import type { PlanItem } from "./runner.ts";
import type { StartOutcome, StartRequest } from "./triggers.ts";

/**
 * Plan approval (spec J.6 Advisor "plans and proposes only", J.7 Assisted "acts after approval
 * of each plan"; ADR 0053). A session at level 0 or 1 whose plan is not approved files it as
 * one blocking `approval` request and ends `stopped` with `plan_awaiting_approval`. The
 * request's card names the plan the human is approving:
 *
 *   key      `plan:<session>`                        the session that filed it
 *   plan_id  `plan:<session>#<sha256>`               the session plus the hash of the planned
 *                                                    task ids in order (`planIdOf`)
 *   plan     the `SessionPlan` as shown in the inbox
 *
 * The answer starts the follow-up: the daemon's `syncPlanApprovals` (from
 * `RuntimeApp.syncApprovals`, after its answer route and on the approvals poll) and the cloud
 * runner's inbox trigger ask the scheduler for a `message` session whose `planApproved` is
 * that `plan_id`. The runner plans again and compares (`planApprovalOf`): the same task ids in
 * the same order run with the plan approved in the token; anything else (a task added, removed
 * or reordered since the human looked) is filed as a new request and never run. A bare `true`
 * approves whatever is planned and is for callers that are themselves the approver (the
 * scenario harness); the daemon and the cloud runner always bind.
 *
 * Every answered request is acted on once: the card records `applied_at`, the outcome and the
 * scheduler's `start_id`, written before the start is asked for, so a second sync (the poll,
 * the route, a restart) finds nothing to do. A rejected plan starts nothing and the tasks stay
 * `ready` for the next session to propose again.
 */
export const PLAN_KEY_PREFIX = "plan:";
export const PLAN_APPROVAL_OPTIONS = ["approve", "reject"] as const;
export type PlanAnswer = (typeof PLAN_APPROVAL_OPTIONS)[number];
/** Audit row per answered plan request (ids and the outcome, never the plan text). */
export const PLAN_APPROVAL_AUDIT_TOOL = "session.plan_approval";

const PLAN_ID_RE = /^plan:([^#\s]+)#([0-9a-f]{64})$/;

/** The card key of the plan request a session files. */
export function planKeyOf(sessionId: string): string {
  return `${PLAN_KEY_PREFIX}${sessionId}`;
}

/** SHA-256 over the planned task ids in order: what the human approved, as a short identity. */
export function planHash(items: readonly Pick<PlanItem, "taskId">[]): string {
  const h = createHash("sha256");
  for (const item of items) h.update(`${item.taskId}\n`);
  return h.digest("hex");
}

/** `plan:<session>#<hash>`: the approved plan's identity a start carries as `planApproved`. */
export function planIdOf(sessionId: string, items: readonly Pick<PlanItem, "taskId">[]): string {
  return `${planKeyOf(sessionId)}#${planHash(items)}`;
}

/** The session and the hash a plan id names, or null for anything else. */
export function parsePlanId(id: string): { sessionId: string; hash: string } | null {
  const m = PLAN_ID_RE.exec(id);
  return m?.[1] && m[2] ? { sessionId: m[1], hash: m[2] } : null;
}

/** Whether the request is a session's plan request (its card is keyed `plan:<session>`). */
export function isPlanRequest(row: Pick<HumanRequestRow, "change_card">): boolean {
  const key = row.change_card?.key;
  return typeof key === "string" && key.startsWith(PLAN_KEY_PREFIX);
}

/** The bound plan id a plan request's card carries, or null (not a plan request, or unbound). */
export function approvedPlanIdOf(row: Pick<HumanRequestRow, "change_card">): string | null {
  if (!isPlanRequest(row)) return null;
  const id = row.change_card?.plan_id;
  return typeof id === "string" && PLAN_ID_RE.test(id) ? id : null;
}

/** The answer of a plan request as one of its options, or null. */
export function planAnswer(answer: JsonValue | null): PlanAnswer | null {
  const raw =
    typeof answer === "string"
      ? answer
      : answer && typeof answer === "object" && !Array.isArray(answer)
        ? ((answer as JsonObject).option ??
          (answer as JsonObject).choice ??
          (answer as JsonObject).answer)
        : null;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (/^(approve|approved|yes|run|go|ok)$/.test(v)) return "approve";
  if (/^(reject|rejected|no|deny|denied|cancel|drop)$/.test(v)) return "reject";
  return null;
}

/**
 * What a start's `planApproved` says about the plan computed now: `approved` (a bare `true`,
 * or a bound id whose hash is the plan's), `changed` (a bound id for another plan: asked
 * again, never run) or `none` (nothing was approved).
 */
export function planApprovalOf(
  planApproved: boolean | string | undefined,
  items: readonly Pick<PlanItem, "taskId">[],
): "approved" | "changed" | "none" {
  if (planApproved === true) return "approved";
  if (typeof planApproved !== "string") return "none";
  const parsed = parsePlanId(planApproved);
  if (!parsed) return "changed";
  return parsed.hash === planHash(items) ? "approved" : "changed";
}

// ---------------------------------------------------------------------------------------
// The daemon's sync step

/** Why an answered plan request started nothing (`change_card.outcome`). */
export type PlanApprovalSkip = "unrecognized_answer" | "unbound_plan" | "start_failed";

export interface PlanApprovalSyncResult {
  /** Approved plans handed to the scheduler (started, queued or deferred). */
  started: number;
  rejected: number;
  /** Answered requests that started nothing and were recorded with a `PlanApprovalSkip`. */
  skipped: number;
}

/** The scheduler's `requestStart`: the entry's id is the start's identity (ADR 0049). */
export type PlanStartPort = (req: StartRequest) => Promise<{ id: string; result: StartOutcome }>;

export interface PlanApprovalSyncDeps {
  store: StateStore;
  clock: Clock;
  humanId: string;
  /** The daemon's principal agent: only its own plan requests are acted on here. */
  agentId: string;
  start: PlanStartPort;
}

/**
 * A filing session an earlier build left `paused` (it ends `stopped` now) would make every
 * start of the agent a `claim_conflict`; it is closed along `paused -> stopped` before the
 * start is asked for. Nothing runs it: the runner returned when it filed the plan.
 */
async function closeFilingSession(store: StateStore, sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  const session = await store.session.get(sessionId);
  if (session?.status !== "paused") return;
  const handoff = session.handoff as { stop_reason?: unknown } | null;
  if (handoff?.stop_reason !== "plan_awaiting_approval") return;
  await store.session.setStatus(session.id, session.version, "stopped");
}

/** Act once on every answered plan request of the human that was not acted on yet. */
export async function syncPlanApprovals(
  deps: PlanApprovalSyncDeps,
): Promise<PlanApprovalSyncResult> {
  const logger = log("plan-approval");
  const { store, clock } = deps;
  const out: PlanApprovalSyncResult = { started: 0, rejected: 0, skipped: 0 };
  const rows = await unappliedAnswers(
    store,
    deps.humanId,
    (key) => key?.startsWith(PLAN_KEY_PREFIX) === true,
  );
  for (const row of rows) {
    // Another agent's plan (a shared store) is its own daemon's business.
    if (row.author_agent !== deps.agentId) continue;
    const card = (row.change_card ?? {}) as JsonObject;
    const answer = planAnswer(row.answer);
    const planId = approvedPlanIdOf(row);
    const mark = (outcome: string, extra: JsonObject = {}) =>
      store.humanRequest.patch(row.id, {
        change_card: { ...card, applied_at: clock.nowIso(), outcome, ...extra },
      });
    const audit = (allowed: boolean, result: JsonObject) =>
      store.auditLog.append({
        session_id: row.session_id,
        run_id: null,
        agent_id: deps.agentId,
        human_id: deps.humanId,
        tool: PLAN_APPROVAL_AUDIT_TOOL,
        input_summary: JSON.stringify({ requestId: row.id, planId, answer }),
        result_summary: JSON.stringify(result),
        allowed,
        cost_usd_micro: 0,
        occurred_at: clock.nowIso(),
      });
    if (!answer) {
      out.skipped++;
      await mark("unrecognized_answer");
      await audit(false, { outcome: "unrecognized_answer" });
      continue;
    }
    if (answer === "reject") {
      out.rejected++;
      await mark("rejected");
      await audit(false, { outcome: "rejected" });
      logger.info("plan rejected; nothing starts, the tasks stay", {
        requestId: row.id,
        sessionId: row.session_id,
      });
      continue;
    }
    if (!planId) {
      // A plan request without the plan's identity (filed by an earlier build) cannot be
      // run as approved: the next session proposes the plan again.
      out.skipped++;
      await mark("unbound_plan");
      await audit(false, { outcome: "unbound_plan" });
      logger.warn("plan approval ignored: the request names no plan id", { requestId: row.id });
      continue;
    }
    await closeFilingSession(store, row.session_id);
    // Marked before the start is asked for: an answered request starts at most one session.
    await mark("starting");
    const req: StartRequest = {
      agentId: deps.agentId,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      trigger: "message",
      reason: `plan approved (request ${row.id})`,
      planApproved: planId,
    };
    try {
      const entry = await deps.start(req);
      await mark(entry.result, { start_id: entry.id });
      await audit(true, { outcome: entry.result, startId: entry.id });
      out.started++;
      logger.info("approved plan handed to the scheduler", {
        requestId: row.id,
        sessionId: row.session_id,
        outcome: entry.result,
        startId: entry.id,
      });
    } catch (e) {
      const error = errorMessage(e);
      out.skipped++;
      await mark("start_failed", { error });
      await audit(false, { outcome: "start_failed", error });
      logger.warn("approved plan could not be started", { requestId: row.id, error });
      await store.message.send({
        from_agent_id: deps.agentId,
        to_human_id: deps.humanId,
        project_id: row.project_id,
        type: "warning",
        body: `The plan you approved (request ${row.id}) could not be started: ${error}. Start the agent by hand; it will propose the plan again.`,
        requires_ack: false,
        author_agent: deps.agentId,
      });
    }
  }
  return out;
}
