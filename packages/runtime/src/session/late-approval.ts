import { type Clock, errorMessage, log } from "@forerunner/platform";
import type {
  HumanRequestRow,
  JsonObject,
  SessionStatus,
  StateStore,
  TaskRow,
  TaskStatus,
} from "@forerunner/state";
import { type ActionClass, ALWAYS_HUMAN } from "../enforcement/autonomy.ts";
import { isYes } from "../wiring/state-ports.ts";
import { answerApplied, markAnswer } from "./answer-mark.ts";
import { unappliedAnswers } from "./findings.ts";
import type { StartOutcome, StartRequest } from "./triggers.ts";

/**
 * A hooks approval answered after its session ended (spec J.7, S.6; ADR 0088). The enforcement
 * hooks hold a tool call behind a `human_request` row (`StateApprovals`, `change_card.key` the
 * SHA-256 of the tool's canonical raw input, `tool`, `actionClass`; the row names the task and
 * the session). A pending call ends its run `needs_human`, the task goes `needs_human`, the
 * session moves on and ends. The port finds the answer again by the task and the key when a
 * later session of the task re-makes the call; what is missing is the session that re-makes
 * it, since no start resumes an ended session and a `needs_human` task is never planned. This
 * module is that producer:
 *
 *   `syncLateApprovals` (from `RuntimeApp.syncApprovals`: the answer route, the commands, the
 *   poll, a session's end) scans the human's answered blocking approvals whose card is a hooks
 *   approval, filed by this agent for a task, whose session has ended and whose answer the
 *   session did not use (an always-human "yes" still unspent, `consumedAt` absent; for any
 *   other class, whose "yes" is never spent, an answer that came after the session's
 *   `ended_at`; a "no" that came after it). Per row, once (`markAnswer`, the mark the cloud
 *   runner's inbox trigger shares):
 *
 *   yes, task `needs_human` -> the card is claimed (`outcome: "starting"`), the task goes
 *        `needs_human -> ready` ("approval answered (request <id>): <tool>"), the scheduler is
 *        asked for one `message` start of the project (`approvalRequestId` names the request)
 *        and the scheduler's answer and `start_id` are recorded; the follow-up plans the task,
 *        its re-made call consumes the answer and runs; a start the port throws on or that
 *        fails after the scheduler took it is `start_failed` with the error, one audit row and
 *        one warning (`reportLateStartFailure`, through `reportingPlanStartFailures`);
 *   yes, task `ready` -> the same without the move (someone put it back already);
 *   yes, task `done`, `cancelled` or `failed` -> `task_moved_on`: nothing starts; the row
 *        stays the task's answer should a rework re-make the call;
 *   yes, task `claimed`, `in_progress`, `in_review` -> nothing yet: another session has it and
 *        the port consumes the answer there if the call is re-made; the next sync looks again;
 *   no -> `refused`: nothing starts, the task records the refusal (`reason`, by the human) and
 *        stays where it is; the row goes on denying that call for the task.
 *
 * Every outcome is one audit row `session.late_approval` (ids, tool, class and outcome, never
 * the input). A level 0 or 1 project's follow-up files its plan for approval as every session
 * at that level does; the late answer is consumed when that plan runs.
 */
export const LATE_APPROVAL_AUDIT_TOOL = "session.late_approval";

/** Session statuses after which a session re-makes no call. */
export const SESSION_ENDED: readonly SessionStatus[] = ["stopped", "completed", "failed", "killed"];

/** Task statuses in which the task's answer is nobody's to act on any more. */
const TASK_MOVED_ON: readonly TaskStatus[] = ["done", "cancelled", "failed"];

const TOOL_KEY_RE = /^(.+):[0-9a-f]{64}$/;

/** The hooks' card key: `<tool>:<sha256 hex of the canonical raw input>` (`approvalKeyFor`). */
export function isToolApprovalKey(key: string | undefined): boolean {
  return typeof key === "string" && TOOL_KEY_RE.test(key);
}

/** The part of a hooks approval's card this module reads. */
interface ToolApprovalCard {
  key?: string;
  tool?: string;
  actionClass?: string;
  consumedAt?: string;
}

function cardOf(row: Pick<HumanRequestRow, "change_card">): ToolApprovalCard {
  return (row.change_card ?? {}) as ToolApprovalCard;
}

/**
 * Whether the request is a hooks approval of a tool call: an `approval` whose card carries the
 * tool, the action class and the hooks' key for that tool. A plan request (`plan:<session>`),
 * an extension grant or a sign-off is not one.
 */
export function isToolApprovalRequest(row: Pick<HumanRequestRow, "kind" | "change_card">): boolean {
  const card = cardOf(row);
  return (
    row.kind === "approval" &&
    typeof card.tool === "string" &&
    typeof card.actionClass === "string" &&
    isToolApprovalKey(card.key) &&
    card.key?.startsWith(`${card.tool}:`) === true
  );
}

/** What acting on one answer reads and writes (the cloud runner's trigger holds this much). */
export type LateApprovalStore = Pick<
  StateStore,
  "humanRequest" | "session" | "task" | "auditLog" | "message"
>;

export interface LateApprovalDeps {
  store: LateApprovalStore;
  clock: Clock;
  humanId: string;
  /** The principal agent whose rows are acted on: another agent's are its own daemon's. */
  agentId: string;
}

/** The scheduler's `requestStart`: the entry's id is the start's identity (ADR 0049). */
export type LateStartPort = (req: StartRequest) => Promise<{ id: string; result: StartOutcome }>;

export interface LateApprovalSyncDeps extends Omit<LateApprovalDeps, "store"> {
  /** The scan (`unappliedAnswers`) pages the whole inbox: the full store. */
  store: StateStore;
  start: LateStartPort;
}

export interface LateApprovalSyncResult {
  /** Late approvals handed to the scheduler (started, queued or deferred). */
  started: number;
  /** Late refusals consumed; nothing ran. */
  refused: number;
  /** Answers that started nothing and were recorded as such (`task_moved_on`, `start_failed`). */
  skipped: number;
}

/** What a claim found: `start` carries the claimed row and the task now `ready`. */
export type LateApprovalClaim =
  | { kind: "start"; claimed: HumanRequestRow; task: TaskRow }
  /** Marked and audited; nothing to start (`refused`, `task_moved_on`). */
  | { kind: "done"; outcome: "refused" | "task_moved_on" }
  /** Not this answer's time: the session still runs, another session has the task, or the session used it. */
  | { kind: "wait" }
  /** Another producer marked the row first. */
  | { kind: "lost" };

// ---------------------------------------------------------------------------------------

function auditLate(
  deps: LateApprovalDeps,
  row: HumanRequestRow,
  allowed: boolean,
  result: JsonObject,
): Promise<unknown> {
  const card = cardOf(row);
  return deps.store.auditLog.append({
    session_id: row.session_id,
    run_id: null,
    agent_id: deps.agentId,
    human_id: deps.humanId,
    tool: LATE_APPROVAL_AUDIT_TOOL,
    input_summary: JSON.stringify({
      requestId: row.id,
      taskId: row.task_id,
      tool: card.tool ?? null,
      actionClass: card.actionClass ?? null,
      answer: isYes(row.answer) ? "yes" : "no",
    }),
    result_summary: JSON.stringify(result),
    allowed,
    cost_usd_micro: 0,
    occurred_at: deps.clock.nowIso(),
  });
}

/** The warning the human gets when the follow-up of their answer could not be started. */
async function warnStartFailed(deps: LateApprovalDeps, row: HumanRequestRow, error: string) {
  await deps.store.message.send({
    from_agent_id: deps.agentId,
    to_human_id: deps.humanId,
    project_id: row.project_id,
    type: "warning",
    body: `The follow-up of your answer (request ${row.id}, ${cardOf(row).tool ?? "a tool call"}) could not be started: ${error}. Start the agent by hand; the task is ready and your answer stands.`,
    requires_ack: false,
    author_agent: deps.agentId,
  });
}

/**
 * Whether the answer is one its session did not use. An always-human "yes" is spent as it is
 * handed out, so an unspent one was never used, whenever it came; any other "yes", and every
 * "no", counts only when it came after the session ended (the session saw an earlier one).
 */
function unusedBySession(row: HumanRequestRow, endedAt: string): boolean {
  const card = cardOf(row);
  if (card.consumedAt) return false;
  if (isYes(row.answer) && ALWAYS_HUMAN.has(card.actionClass as ActionClass)) return true;
  return row.answered_at !== null && row.answered_at > endedAt;
}

/**
 * Acts once on one answered hooks approval: the claim, the task move and the records, up to
 * the start, which the caller makes (the daemon's scheduler, the cloud runner's request). The
 * cloud runner's inbox trigger calls this before it asks for its session, so both producers
 * decide the same way and the mark they share decides who acts.
 */
export async function claimLateApproval(
  deps: LateApprovalDeps,
  row: HumanRequestRow,
): Promise<LateApprovalClaim> {
  const { store, clock } = deps;
  const logger = log("late-approval");
  if (!row.task_id || !row.session_id || row.author_agent !== deps.agentId) return { kind: "wait" };
  if (answerApplied(row)) return { kind: "lost" };
  const session = await store.session.get(row.session_id);
  if (!session || !SESSION_ENDED.includes(session.status) || !session.ended_at)
    return { kind: "wait" };
  if (!unusedBySession(row, session.ended_at)) return { kind: "wait" };
  const tool = cardOf(row).tool ?? "the call";
  const task = await store.task.get(row.task_id);
  if (!isYes(row.answer)) {
    const marked = await markAnswer(store, clock, row, "refused");
    if (!marked) return { kind: "lost" };
    if (task && task.status === "needs_human") {
      // The task records the refusal; it stays where the pause left it.
      await store.task.patch(task.id, {
        reason: `human refused ${tool} (request ${row.id})`,
        author_human: deps.humanId,
        author_agent: null,
      });
    }
    await auditLate(deps, row, false, { outcome: "refused", taskStatus: task?.status ?? null });
    logger.info("late refusal recorded; nothing runs", { requestId: row.id, taskId: row.task_id });
    return { kind: "done", outcome: "refused" };
  }
  if (!task || TASK_MOVED_ON.includes(task.status)) {
    const marked = await markAnswer(store, clock, row, "task_moved_on");
    if (!marked) return { kind: "lost" };
    await auditLate(deps, row, false, {
      outcome: "task_moved_on",
      taskStatus: task?.status ?? null,
    });
    logger.info("late approval not acted on: the task moved on", {
      requestId: row.id,
      taskId: row.task_id,
      taskStatus: task?.status ?? null,
    });
    return { kind: "done", outcome: "task_moved_on" };
  }
  if (task.status !== "needs_human" && task.status !== "ready") return { kind: "wait" };
  // Claimed before the task moves and the start is asked for: an answered request starts at
  // most one session, across the route, the poll, a restart and the cloud runner's trigger.
  const claimed = await markAnswer(store, clock, row, "starting");
  if (!claimed) return { kind: "lost" };
  let ready = task;
  if (task.status === "needs_human") {
    ready = await store.task.transition(
      task.id,
      task.version,
      "ready",
      `approval answered (request ${row.id}): ${tool}`,
      { humanId: deps.humanId },
    );
  }
  return { kind: "start", claimed, task: ready };
}

/** The start a claimed late approval asks the scheduler for. */
export function lateStartRequest(agentId: string, row: HumanRequestRow): StartRequest {
  return {
    agentId,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    trigger: "message",
    reason: `approval answered (request ${row.id})`,
    approvalRequestId: row.id,
  };
}

/**
 * Records the scheduler's answer on a claimed row (`started`, `queued`, `deferred`, or
 * `start_failed` with the error and the warning). Conditional on the claim: a start that
 * already failed in the background (`reportLateStartFailure`) keeps its `start_failed`.
 */
export async function recordLateStart(
  deps: LateApprovalDeps,
  row: HumanRequestRow,
  claimed: HumanRequestRow,
  result: StartOutcome | "start_failed",
  extra: { startId?: string; error?: string } = {},
): Promise<void> {
  const { store, clock } = deps;
  if (result === "start_failed") {
    const error = extra.error ?? "start failed";
    await markAnswer(store, clock, claimed, "start_failed", {
      error,
      failure_reported_at: clock.nowIso(),
    });
    await auditLate(deps, row, false, { outcome: "start_failed", error });
    log("late-approval").warn("late approval's follow-up could not be started", {
      requestId: row.id,
      error,
    });
    await warnStartFailed(deps, row, error);
    return;
  }
  await markAnswer(store, clock, claimed, result, extra.startId ? { start_id: extra.startId } : {});
  await auditLate(deps, row, true, {
    outcome: result,
    ...(extra.startId ? { startId: extra.startId } : {}),
  });
  log("late-approval").info("late approval handed to the scheduler", {
    requestId: row.id,
    taskId: row.task_id,
    outcome: result,
    startId: extra.startId ?? null,
  });
}

/**
 * Gives a claim back (the cloud runner's start was skipped for a PC that came online): the
 * card as it was before the claim. The task stays `ready`; the PC daemon's sync finds the
 * unapplied answer and starts the follow-up there.
 */
export async function releaseLateClaim(
  store: Pick<StateStore, "humanRequest">,
  claimed: HumanRequestRow,
  before: HumanRequestRow,
): Promise<void> {
  await store.humanRequest.update(claimed.id, claimed.version, { change_card: before.change_card });
}

/**
 * A start bound to a late approval failed after the scheduler took it (`runner.start`
 * rejecting in the background: `claim_conflict`, `provider_auth`, the schema gate), which
 * `requestStart` never reports to its caller. The card says `start_failed` with the error, one
 * audit row is written and the human is warned once (`failure_reported_at`); the request is not
 * retried (the task is `ready`; the next session of the project consumes the answer).
 * `reportingPlanStartFailures` calls it for a request carrying `approvalRequestId`.
 */
export async function reportLateStartFailure(
  deps: LateApprovalDeps,
  requestId: string,
  e: unknown,
): Promise<void> {
  const row = await deps.store.humanRequest.get(requestId);
  if (!row || !isToolApprovalRequest(row)) return;
  if ((row.change_card as JsonObject).failure_reported_at) return;
  const error = errorMessage(e);
  await deps.store.humanRequest.patch(row.id, {
    change_card: {
      ...(row.change_card as JsonObject),
      applied_at: deps.clock.nowIso(),
      outcome: "start_failed",
      error,
      failure_reported_at: deps.clock.nowIso(),
    },
  });
  await auditLate(deps, row, false, { outcome: "start_failed", error });
  log("late-approval").warn("late approval's follow-up could not be started", {
    requestId: row.id,
    error,
  });
  await warnStartFailed(deps, row, error);
}

/**
 * Act once on every late hooks approval of the human that was not acted on yet (the module
 * comment). A row that fails is logged and left for the next sync; the other rows still act.
 */
export async function syncLateApprovals(
  deps: LateApprovalSyncDeps,
): Promise<LateApprovalSyncResult> {
  const logger = log("late-approval");
  const out: LateApprovalSyncResult = { started: 0, refused: 0, skipped: 0 };
  const rows = await unappliedAnswers(deps.store, deps.humanId, isToolApprovalKey);
  for (const row of rows) {
    if (!isToolApprovalRequest(row) || row.author_agent !== deps.agentId) continue;
    try {
      const claim = await claimLateApproval(deps, row);
      if (claim.kind === "done") {
        if (claim.outcome === "refused") out.refused++;
        else out.skipped++;
        continue;
      }
      if (claim.kind !== "start") continue;
      let entry: { id: string; result: StartOutcome };
      try {
        entry = await deps.start(lateStartRequest(deps.agentId, row));
      } catch (e) {
        await recordLateStart(deps, row, claim.claimed, "start_failed", { error: errorMessage(e) });
        out.skipped++;
        continue;
      }
      await recordLateStart(deps, row, claim.claimed, entry.result, { startId: entry.id });
      out.started++;
    } catch (e) {
      logger.warn("late approval not applied", { requestId: row.id, error: errorMessage(e) });
    }
  }
  return out;
}
