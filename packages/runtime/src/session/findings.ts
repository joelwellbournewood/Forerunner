import { type Clock, errorMessage, log } from "@forerunner/platform";
import type {
  FindingRow,
  HumanRequestRow,
  JsonObject,
  JsonValue,
  SessionRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";

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

/** The answer of a blocked-findings request as one of its options, or null. */
export function blockedFindingsAnswer(answer: JsonValue | null): BlockedFindingsAnswer | null {
  const raw =
    typeof answer === "string"
      ? answer
      : answer && typeof answer === "object" && !Array.isArray(answer)
        ? ((answer as JsonObject).choice ?? (answer as JsonObject).answer)
        : null;
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (/^(rework|revise|retry|redo)$/.test(v)) return "rework";
  if (/^(accept|accepted|resolve|resolved|close)$/.test(v)) return "accept";
  if (/^(cancel|cancelled|canceled|drop)$/.test(v)) return "cancel";
  return null;
}

/**
 * Apply every answered blocked-findings request of the human that was not applied yet. The
 * task must still be in review; otherwise the answer is recorded as skipped. Every outcome is
 * written to the request's card (`applied_at`, `outcome`) so it is applied once.
 */
export async function syncBlockedByFindings(deps: {
  store: StateStore;
  clock: Clock;
  humanId: string;
  /** Actor of the transitions (the principal agent); the human's id is recorded with it. */
  agentId?: string | null;
}): Promise<BlockedSyncResult> {
  const logger = log("findings");
  const { store, clock } = deps;
  const out: BlockedSyncResult = { reworked: 0, accepted: 0, cancelled: 0, skipped: 0 };
  const rows = await store.humanRequest.list(
    { kind: "approval", human_id: deps.humanId, status: "answered" },
    { orderBy: [{ column: "created_at", direction: "desc" }], limit: 200 },
  );
  for (const row of rows) {
    if (keyOf(row) !== BLOCKED_FINDINGS_KEY) continue;
    const card = (row.change_card ?? {}) as JsonObject;
    if (card.applied_at) continue;
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
        await store.task.transition(
          task.id,
          task.version,
          "done",
          `human accepted the open findings as resolved by the work (request ${row.id})`,
          actor,
        );
        out.accepted++;
      } else if (answer === "rework") {
        const failed = await store.task.transition(
          task.id,
          task.version,
          "failed",
          `human asked for a rework against the open findings (request ${row.id})`,
          actor,
        );
        await store.task.transition(
          failed.id,
          failed.version,
          "ready",
          "rework: the open findings are constraints of the next brief",
          actor,
        );
        out.reworked++;
      } else {
        await store.task.transition(
          task.id,
          task.version,
          "cancelled",
          `human cancelled the task over its open findings (request ${row.id})`,
          actor,
        );
        out.cancelled++;
      }
      await finish(answer);
    } catch (e) {
      logger.warn("blocked-findings answer not applied", {
        requestId: row.id,
        error: errorMessage(e),
      });
    }
  }
  return out;
}

function keyOf(r: HumanRequestRow): string | undefined {
  const key = (r.change_card as JsonObject | null)?.key;
  return typeof key === "string" ? key : undefined;
}
