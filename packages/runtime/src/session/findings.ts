import { SIGNOFF_KEY, type SignoffAnswer } from "@forerunner/critic";
import { type Clock, errorMessage, ForerunnerError, log } from "@forerunner/platform";
import type {
  FindingRow,
  HumanRequestRow,
  JsonObject,
  SessionRow,
  StateStore,
  TaskRow,
  TaskStatus,
} from "@forerunner/state";
import { blockedFindingsAnswer, signoffAnswer } from "../wiring/request-answers.ts";

/**
 * A close blocked by open findings (spec B.4). The store refuses `in_review -> done` while a
 * finding of an earlier review is open; that happens on the tier 0 mechanical path (nobody
 * reviewed whether the rework addressed the finding) and when the critic accepted but a
 * finding from another review is still open. The task stays in review, which later sessions
 * never plan, so the exit is the human's: one blocking request per task asks whether to
 * rework (failed -> ready, the finding becomes a brief constraint), to accept the finding as
 * resolved by the work (the finding is resolved against the run and the task closes), or to
 * cancel. `syncBlockedByFindings` applies the answer from the inbox (`syncApprovals`).
 */
export const BLOCKED_FINDINGS_KEY = "findings:blocked";
export const BLOCKED_FINDINGS_OPTIONS = ["rework", "accept", "cancel"] as const;
export type BlockedFindingsAnswer = (typeof BLOCKED_FINDINGS_OPTIONS)[number];

export interface BlockedRequestInput {
  store: StateStore;
  task: TaskRow;
  /** The session that hit the block; null when filed outside a session. */
  session: Pick<SessionRow, "id"> | null;
  humanId: string;
  /** The principal agent that ran the task (author of the request). */
  agentId: string;
  /** The run that produced the work; an accepted finding is resolved against it. */
  runId: string | null;
  findings: readonly FindingRow[];
  /** Which path refused the close. */
  path: "tier0" | "critic_accept";
}

/** File (or reuse) the blocking request for a task whose close is refused by open findings. */
export async function fileBlockedByFindingsRequest(
  input: BlockedRequestInput,
): Promise<{ request: HumanRequestRow; reused: boolean }> {
  const { store, task } = input;
  const open = (await store.humanRequest.open({ humanId: input.humanId }, { limit: 500 })).find(
    (r) => r.task_id === task.id && keyOf(r) === BLOCKED_FINDINGS_KEY,
  );
  if (open) return { request: open, reused: true };
  const findings = input.findings.slice(0, 50);
  const request = await store.humanRequest.insert({
    human_id: input.humanId,
    project_id: task.project_id,
    task_id: task.id,
    session_id: input.session?.id ?? null,
    kind: "approval",
    why: `"${task.title}" cannot close: ${findings.length} critic finding(s) from an earlier review are still open and ${
      input.path === "tier0"
        ? "a tier 0 task closes on automated checks alone, so nobody verified the rework against them"
        : "the critic's accept did not cover them"
    }. Rework it with the findings as constraints, accept the findings as resolved by this work, or cancel the task.`.slice(
      0,
      4000,
    ),
    steps: findings.map((f) => `[${f.severity}] ${f.description} -> ${f.required_action}`),
    options: [...BLOCKED_FINDINGS_OPTIONS],
    blocking: true,
    risk: findings.some((f) => f.severity === "critical" || f.severity === "high")
      ? "high"
      : "medium",
    change_card: {
      key: BLOCKED_FINDINGS_KEY,
      task_id: task.id,
      run_id: input.runId,
      finding_ids: findings.map((f) => f.id),
      path: input.path,
      applied_at: null,
    },
    author_agent: input.agentId,
  });
  return { request, reused: false };
}

export interface BlockedSyncResult {
  reworked: number;
  accepted: number;
  cancelled: number;
  /** Answered requests whose task had moved on or whose answer was not one of the options. */
  skipped: number;
}

/**
 * The answers of the blocked-findings and sign-off requests as one of their options, or null.
 * The readers live in `wiring/request-answers.ts`, where the answer routes refuse an answer
 * they cannot read (U-034) with the same function.
 */
export { blockedFindingsAnswer, signoffAnswer };

/** Who applies the answers of the in-review cards (the blocked findings, the failed review). */
interface InReviewSyncDeps {
  store: StateStore;
  clock: Clock;
  humanId: string;
  /** Actor of the transitions (the principal agent); the human's id is recorded with it. */
  agentId?: string | null;
}

/** The reasons an in-review card's answer records on the task (spec B.5). */
interface InReviewReasons {
  accept: (requestId: string) => string;
  rework: (requestId: string) => string;
  reworkReady: string;
  cancel: (requestId: string) => string;
}

/**
 * Apply every answered blocked-findings request of the human that was not applied yet. The
 * task must still be in review; otherwise the answer is recorded as skipped. Every outcome is
 * written to the request's card (`applied_at`, `outcome`) so it is applied once.
 */
export async function syncBlockedByFindings(deps: InReviewSyncDeps): Promise<BlockedSyncResult> {
  return syncInReviewCards(deps, BLOCKED_FINDINGS_KEY, "blocked-findings", {
    accept: (id) => `human accepted the open findings as resolved by the work (request ${id})`,
    rework: (id) => `human asked for a rework against the open findings (request ${id})`,
    reworkReady: "rework: the open findings are constraints of the next brief",
    cancel: (id) => `human cancelled the task over its open findings (request ${id})`,
  });
}

/**
 * The cards whose task waits in review for the person's word, with the options rework, accept
 * and cancel (`blockedFindingsAnswer` reads them): accept resolves the task's open findings
 * against the card's run and closes it, rework sends it back to ready through `failed` (the
 * attempt counted), cancel cancels it. A task no longer in review, or an answer outside the
 * options, is skipped and recorded as such.
 */
async function syncInReviewCards(
  deps: InReviewSyncDeps,
  key: string,
  what: string,
  reasons: InReviewReasons,
): Promise<BlockedSyncResult> {
  const logger = log("findings");
  const { store, clock } = deps;
  const out: BlockedSyncResult = { reworked: 0, accepted: 0, cancelled: 0, skipped: 0 };
  for (const row of await unappliedAnswers(store, deps.humanId, key)) {
    const card = (row.change_card ?? {}) as JsonObject;
    const actor = { agentId: deps.agentId ?? undefined, humanId: deps.humanId };
    const finish = (outcome: string) =>
      store.humanRequest.patch(row.id, {
        change_card: { ...card, applied_at: clock.nowIso(), outcome },
      });
    const answer = blockedFindingsAnswer(row.answer);
    const task = row.task_id ? await store.task.get(row.task_id) : undefined;
    if (!answer || !task || task.status !== "in_review") {
      out.skipped++;
      await finish(!answer ? "unrecognized_answer" : "task_moved_on");
      continue;
    }
    try {
      if (answer === "accept") {
        const runId = typeof card.run_id === "string" ? card.run_id : null;
        for (const f of await store.finding.openFor(task.id))
          await store.finding.resolve(f.id, f.version, runId);
        await store.task.transition(task.id, task.version, "done", reasons.accept(row.id), actor);
        out.accepted++;
      } else if (answer === "rework") {
        const failed = await store.task.transition(
          task.id,
          task.version,
          "failed",
          reasons.rework(row.id),
          actor,
        );
        await store.task.transition(failed.id, failed.version, "ready", reasons.reworkReady, actor);
        out.reworked++;
      } else {
        await store.task.transition(
          task.id,
          task.version,
          "cancelled",
          reasons.cancel(row.id),
          actor,
        );
        out.cancelled++;
      }
      await finish(answer);
    } catch (e) {
      logger.warn(`${what} answer not applied`, {
        requestId: row.id,
        error: errorMessage(e),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// A critic review that failed (U-045)

/**
 * A critic review that failed (an error, not a verdict: the critic's model unreachable, its
 * reply unreadable) left the task in review for good: no later session plans a task in review
 * and nothing else moved it. The session now files one blocking card for the task, with the
 * error, whose options are those of the blocked-findings card and act the same way
 * (`syncReviewFailedAnswers`): rework sends the task back to ready (the next session runs it
 * and the critic reviews the new run), accept takes the work as it is and closes the task
 * (open findings of an earlier review resolved against the run), cancel cancels it.
 */
export const REVIEW_FAILED_KEY = "critic:review_failed";
export const REVIEW_FAILED_OPTIONS = ["rework", "accept", "cancel"] as const;

export interface ReviewFailedRequestInput {
  store: StateStore;
  task: TaskRow;
  /** The session whose review failed; null when filed outside a session. */
  session: Pick<SessionRow, "id"> | null;
  humanId: string;
  /** The principal agent that ran the task (author of the request). */
  agentId: string;
  /** The run the review was of; an accepted finding is resolved against it. */
  runId: string | null;
  /** What the review failed with, as the person reads it. */
  error: string;
}

/** File (or reuse) the blocking card for a task whose critic review failed (U-045). */
export async function fileReviewFailedRequest(
  input: ReviewFailedRequestInput,
): Promise<{ request: HumanRequestRow; reused: boolean }> {
  const { store, task } = input;
  const open = (await store.humanRequest.open({ humanId: input.humanId }, { limit: 500 })).find(
    (r) => r.task_id === task.id && keyOf(r) === REVIEW_FAILED_KEY,
  );
  if (open) return { request: open, reused: true };
  const findings = (await store.finding.openFor(task.id)).slice(0, 50);
  const error = input.error.trim().slice(0, 500) || "no reason given";
  const request = await store.humanRequest.insert({
    human_id: input.humanId,
    project_id: task.project_id,
    task_id: task.id,
    session_id: input.session?.id ?? null,
    kind: "approval",
    why: `The critic could not review "${task.title}" (${error}), so the work is not checked and the task waits in review for you. rework: the task runs again in the next session and the critic reviews the new run. accept: take the work as it is, without a review${
      findings.length
        ? `; its ${findings.length} open finding(s) from an earlier review are marked resolved`
        : ""
    }. cancel: cancel the task.`.slice(0, 4000),
    steps: [
      `Review error: ${error}`,
      ...findings.map((f) => `[${f.severity}] ${f.description} -> ${f.required_action}`),
    ],
    options: [...REVIEW_FAILED_OPTIONS],
    blocking: true,
    risk: "medium",
    change_card: {
      key: REVIEW_FAILED_KEY,
      task_id: task.id,
      run_id: input.runId,
      error,
      finding_ids: findings.map((f) => f.id),
      applied_at: null,
    },
    author_agent: input.agentId,
  });
  return { request, reused: false };
}

/** Apply the answered review-failed cards (U-045); run from `RuntimeApp.syncApprovals`. */
export async function syncReviewFailedAnswers(deps: InReviewSyncDeps): Promise<BlockedSyncResult> {
  return syncInReviewCards(deps, REVIEW_FAILED_KEY, "review-failed", {
    accept: (id) => `human accepted the work without a critic review (request ${id})`,
    rework: (id) => `human asked for a rework after the critic review failed (request ${id})`,
    reworkReady: "rework: the next session runs the task again and the critic reviews it",
    cancel: (id) => `human cancelled the task after the critic review failed (request ${id})`,
  });
}

function keyOf(r: HumanRequestRow): string | undefined {
  const key = (r.change_card as JsonObject | null)?.key;
  return typeof key === "string" ? key : undefined;
}

/** A page of the scan below; the store filters the columns, the card key is read here. */
const ANSWERS_PAGE = 200;

/**
 * The human's answered blocking approvals whose card has this key (or whose key the predicate
 * accepts) and is not applied yet, newest first. Every request this file and
 * `plan-approval.ts` apply is `blocking`, which keeps the scan to the sign-offs, the
 * blocked-findings requests, the plan requests and the few other blocking approvals; the
 * pages run until the last one so an answer that sat behind a long run of later answers (a
 * long downtime of the daemon) is still found.
 */
export async function unappliedAnswers(
  store: StateStore,
  humanId: string,
  key: string | ((key: string | undefined) => boolean),
): Promise<HumanRequestRow[]> {
  const matches = typeof key === "string" ? (k: string) => k === key : (k: string) => key(k);
  return unappliedBlockingAnswers(store, humanId, matches);
}

/**
 * The same scan for every card key the predicate accepts (the intake's `intake:<project>`
 * keys, `session/intake.ts`; the plan requests, `plan-approval.ts`), so every answer path pages
 * the inbox the one way.
 */
export async function unappliedBlockingAnswers(
  store: StateStore,
  humanId: string,
  matches: (key: string) => boolean,
): Promise<HumanRequestRow[]> {
  const found: HumanRequestRow[] = [];
  for (let offset = 0; ; offset += ANSWERS_PAGE) {
    const page = await store.humanRequest.list(
      { kind: "approval", human_id: humanId, status: "answered", blocking: true },
      {
        orderBy: [
          { column: "created_at", direction: "desc" },
          { column: "id", direction: "desc" },
        ],
        limit: ANSWERS_PAGE,
        offset,
      },
    );
    for (const row of page) {
      const key = keyOf(row);
      if (key === undefined || !matches(key)) continue;
      if ((row.change_card as JsonObject).applied_at) continue;
      found.push(row);
    }
    if (page.length < ANSWERS_PAGE) return found;
  }
}

// ---------------------------------------------------------------------------------------
// Critic sign-off answers (spec H.2; phase 5 follow-up RT-P5-1)

/**
 * The critic's `human` decision (a tier 3 review, a `human` verdict, the retry ladder's last
 * rung) moves the task to `needs_human` and files one blocking request with the options
 * accept / revise / cancel and a `change_card` keyed `SIGNOFF_KEY` (`@forerunner/critic`,
 * `signoffCard`). `syncSignoffAnswers`, run from `RuntimeApp.syncApprovals` (the daemon's
 * answer route and its approvals poll), applies the inbox's answer:
 *
 *   accept -> the findings the card names and every other open finding of the task up to
 *             its review (the rework's history: the critic resolves earlier findings only on
 *             its own accept, so the ladder's last rung leaves them open) are resolved
 *             against the run the card names and the task closes (`done`);
 *   revise -> `failed -> ready` with the attempt counted (the retry ladder's next rung), the
 *             findings kept open as the next brief's constraints, the owner agent told;
 *   cancel -> `cancelled`.
 *
 * The answer applies only to the task's current sign-off: a request whose review is not the
 * task's latest (the task left `needs_human` and was reviewed again while the request stayed
 * open in the inbox) is `stale` and touches nothing, so an old card never closes the task or
 * resolves a later review's findings. Every answer is applied once (the card records
 * `applied_at` and the outcome), in one store transaction with one `critic.signoff` audit
 * row (ids and the outcome, never the text). A task the human moved on before the sync, a
 * stale request and an answer outside the options are skipped and recorded as such
 * (`task_moved_on`, `stale`, `unrecognized_answer`); a close the store refuses over an open
 * finding of a review newer than the card's is recorded `findings_open` and the task stays.
 */
export const SIGNOFF_AUDIT_TOOL = "critic.signoff";

/** Why an answered sign-off was not applied (`change_card.outcome`). */
export type SignoffSkip = "unrecognized_answer" | "task_moved_on" | "stale" | "findings_open";

export interface SignoffSyncResult {
  accepted: number;
  revised: number;
  cancelled: number;
  /** Answered requests skipped and recorded with a `SignoffSkip` outcome. */
  skipped: number;
}

/**
 * `needs_human -> done` is no edge of the task workflow (`packages/state/src/workflow.ts`;
 * `needs_human -> ready` and `-> cancelled` are its only exits), so an accepted sign-off
 * closes the task along the graph's own edges, in the caller's transaction: the task
 * re-enters the flow and closes through review. Every rule of the store holds on the way
 * (the claim is cleared, no open finding at close) and nothing observes the intermediate
 * states.
 */
const CLOSE_FROM_NEEDS_HUMAN: readonly TaskStatus[] = [
  "ready",
  "claimed",
  "in_progress",
  "in_review",
  "done",
];

async function closeFromNeedsHuman(
  tx: StateStore,
  task: TaskRow,
  reason: string,
  actor: { agentId?: string; humanId?: string },
): Promise<TaskRow> {
  let current = task;
  for (const to of CLOSE_FROM_NEEDS_HUMAN)
    current = await tx.task.transition(current.id, current.version, to, reason, actor);
  return current;
}

/**
 * Whether the request is the task's current sign-off: its review is the task's latest. A
 * card without a review id (a review that was not recorded) is current while no review of
 * the task is newer than the request.
 */
async function isStale(
  store: StateStore,
  row: HumanRequestRow,
  card: JsonObject,
): Promise<boolean> {
  if (!row.task_id) return false;
  const latest = await store.review.latestForTask(row.task_id);
  if (!latest) return false;
  if (typeof card.review_id === "string") return latest.id !== card.review_id;
  return latest.created_at > row.created_at;
}

/** Apply every answered sign-off request of the human that was not applied yet. */
export async function syncSignoffAnswers(deps: {
  store: StateStore;
  clock: Clock;
  humanId: string;
  /** Actor of the transitions (the principal agent); the human's id is recorded with it. */
  agentId?: string | null;
}): Promise<SignoffSyncResult> {
  const logger = log("findings");
  const { store, clock } = deps;
  const out: SignoffSyncResult = { accepted: 0, revised: 0, cancelled: 0, skipped: 0 };
  for (const row of await unappliedAnswers(store, deps.humanId, SIGNOFF_KEY)) {
    const card = (row.change_card ?? {}) as JsonObject;
    const actor = { agentId: deps.agentId ?? undefined, humanId: deps.humanId };
    const finish = (tx: StateStore, outcome: SignoffAnswer | SignoffSkip) =>
      tx.humanRequest.patch(row.id, {
        change_card: { ...card, applied_at: clock.nowIso(), outcome },
      });
    const skip = async (why: SignoffSkip) => {
      out.skipped++;
      await finish(store, why);
    };
    const answer = signoffAnswer(row.answer);
    const task = row.task_id ? await store.task.get(row.task_id) : undefined;
    if (!answer) {
      await skip("unrecognized_answer");
      continue;
    }
    if (!task || task.status !== "needs_human") {
      await skip("task_moved_on");
      continue;
    }
    if (await isStale(store, row, card)) {
      logger.info("sign-off answer skipped: the task was reviewed again since", {
        requestId: row.id,
        taskId: task.id,
      });
      await skip("stale");
      continue;
    }
    const runId = typeof card.run_id === "string" ? card.run_id : null;
    const named = new Set(
      Array.isArray(card.finding_ids)
        ? card.finding_ids.filter((id): id is string => typeof id === "string")
        : [],
    );
    try {
      await store.transaction(async (tx) => {
        let final: TaskRow;
        let resolvedFindings = 0;
        if (answer === "accept") {
          // The card's findings, and the task's other open ones: the request is the task's
          // current sign-off, so every open finding belongs to its review or an earlier one.
          for (const f of await tx.finding.openFor(task.id)) {
            if (!named.has(f.id) && !(await reviewedBefore(tx, f, card, row))) continue;
            await tx.finding.resolve(f.id, f.version, runId);
            resolvedFindings++;
          }
          final = await closeFromNeedsHuman(
            tx,
            task,
            `human accepted the critic's sign-off (request ${row.id})`,
            actor,
          );
        } else if (answer === "revise") {
          const ready = await tx.task.transition(
            task.id,
            task.version,
            "ready",
            `human asked for a revision at sign-off (request ${row.id})`,
            actor,
          );
          const failed = await tx.task.transition(
            ready.id,
            ready.version,
            "failed",
            `revision requested at sign-off (request ${row.id})`,
            actor,
          );
          final = await tx.task.transition(
            failed.id,
            failed.version,
            "ready",
            "retry after the sign-off's revision request: the open findings are constraints of the next brief",
            actor,
          );
          await tellOwner(tx, row, final);
        } else {
          final = await tx.task.transition(
            task.id,
            task.version,
            "cancelled",
            `human cancelled the task at sign-off (request ${row.id})`,
            actor,
          );
        }
        await tx.auditLog.append({
          session_id: row.session_id,
          run_id: runId,
          agent_id: deps.agentId ?? null,
          human_id: deps.humanId,
          tool: SIGNOFF_AUDIT_TOOL,
          input_summary: JSON.stringify({ requestId: row.id, taskId: task.id, answer }),
          result_summary: JSON.stringify({
            outcome: answer,
            status: final.status,
            attempt: final.attempt,
            resolvedFindings,
          }),
          allowed: true,
          cost_usd_micro: 0,
          occurred_at: clock.nowIso(),
        });
        await finish(tx, answer);
      });
      if (answer === "accept") out.accepted++;
      else if (answer === "revise") out.revised++;
      else out.cancelled++;
    } catch (e) {
      if (e instanceof ForerunnerError && e.code === "findings_open") {
        logger.warn("sign-off accept refused: a finding of a later review is open", {
          requestId: row.id,
          taskId: task.id,
        });
        await skip("findings_open");
        continue;
      }
      logger.warn("sign-off answer not applied", { requestId: row.id, error: errorMessage(e) });
    }
  }
  return out;
}

/**
 * A finding of the card's review or of an earlier review of the task (for a card without a
 * review id: a review not newer than the request).
 */
async function reviewedBefore(
  tx: StateStore,
  finding: FindingRow,
  card: JsonObject,
  request: HumanRequestRow,
): Promise<boolean> {
  if (finding.review_id === card.review_id) return true;
  const theirs = await tx.review.get(finding.review_id);
  if (!theirs) return false;
  if (typeof card.review_id !== "string") return theirs.created_at <= request.created_at;
  const own = await tx.review.get(card.review_id);
  return !!own && theirs.created_at <= own.created_at;
}

/** A revision asked at sign-off: the owner agent gets the request's steps as required actions. */
async function tellOwner(tx: StateStore, row: HumanRequestRow, task: TaskRow): Promise<void> {
  const from = row.author_agent;
  const to = task.owner_agent_id;
  if (!from || !to) return;
  const body = [
    `Revision requested at sign-off for task "${task.title}" (request ${row.id}).`,
    row.why,
    row.steps.length ? "Required actions:" : "No specific finding was recorded.",
    ...row.steps.map((s) => `- ${s}`),
  ].join("\n");
  await tx.message.send({
    from_agent_id: from,
    to_agent_id: to,
    to_human_id: null,
    project_id: task.project_id,
    task_id: task.id,
    type: "request",
    body,
    requires_ack: true,
    author_agent: from,
  });
}
