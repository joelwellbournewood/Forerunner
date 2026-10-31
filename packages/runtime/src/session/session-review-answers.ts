import {
  isSessionReviewRequest,
  loadSessionReviewData,
  SESSION_REVIEW_KEY,
  sessionChecks,
  sessionReviewAnswer,
} from "@forerunner/critic";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { FindingRow, HumanRequestRow, JsonObject, StateStore } from "@forerunner/state";

/**
 * The answers of session review requests (spec H.6; U-033), applied from
 * `RuntimeApp.syncApprovals`. The critic files the request for the session's owner when the
 * review needs them (`fileSessionReviewRequest`, `@forerunner/critic`):
 *
 *   "Acknowledge" -> the review's open findings are marked `wontfix` (seen; the session is over
 *       and has nothing left to fix); the request closes.
 *   "Correct the summary" -> one correction is appended to the session's summary from the
 *       records as they are now (done tasks over everything the session planned or ran, the
 *       spend), so the Sessions screen, the digest and the next session's diff read the true
 *       numbers; the summary findings are resolved, the others marked `wontfix`.
 *
 * Each answer is applied once (`applied_at` and the `outcome` on the card, in the same
 * transaction as its writes). A request filed with the old options ("acknowledge", "cancel")
 * is read the same way, "cancel" as an acknowledgement: nothing is left to cancel after a
 * session ended. An answer outside the options is recorded `unrecognized_answer`.
 */
export interface SessionReviewSyncResult {
  acknowledged: number;
  corrected: number;
  skipped: number;
}

const PAGE = 200;

export async function syncSessionReviewAnswers(deps: {
  store: StateStore;
  clock: Clock;
  humanId: string;
}): Promise<SessionReviewSyncResult> {
  const logger = log("session-review-answers");
  const out: SessionReviewSyncResult = { acknowledged: 0, corrected: 0, skipped: 0 };
  for (const row of await unapplied(deps.store, deps.humanId)) {
    try {
      const outcome = await apply(deps, row);
      if (outcome === "acknowledged") out.acknowledged++;
      else if (outcome === "corrected") out.corrected++;
      else out.skipped++;
    } catch (e) {
      logger.warn("session review answer not applied", {
        requestId: row.id,
        error: errorMessage(e),
      });
    }
  }
  return out;
}

async function unapplied(store: StateStore, humanId: string): Promise<HumanRequestRow[]> {
  const found: HumanRequestRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await store.humanRequest.list(
      { kind: "approval", human_id: humanId, status: "answered", blocking: false } as never,
      {
        orderBy: [
          { column: "created_at", direction: "asc" },
          { column: "id", direction: "asc" },
        ],
        limit: PAGE,
        offset,
      },
    );
    for (const row of page) {
      if (!isSessionReviewRequest(row)) continue;
      if ((row.change_card as JsonObject | null)?.applied_at) continue;
      found.push(row);
    }
    if (page.length < PAGE) return found;
  }
}

/** The findings the request is about: the card's, else the session's latest review's. */
async function findingsOf(store: StateStore, row: HumanRequestRow): Promise<FindingRow[]> {
  const card = (row.change_card ?? {}) as JsonObject;
  let reviewId = typeof card.review_id === "string" ? card.review_id : null;
  if (!reviewId && row.session_id) {
    const reviews = await store.review.list({ session_id: row.session_id } as never, {
      orderBy: [{ column: "created_at", direction: "desc" }],
      limit: 20,
    });
    reviewId = reviews.find((r) => r.task_id === null)?.id ?? null;
  }
  return reviewId ? store.finding.forReview(reviewId) : [];
}

const usd = (micro: number): string => `USD ${(micro / 1_000_000).toFixed(2)}`;
/** The person reads CHF (U-074); a USD figure only when the records hold no CHF. */
const chf = (micro: number): string => `CHF ${(micro / 1_000_000).toFixed(2)}`;

async function apply(
  deps: { store: StateStore; clock: Clock; humanId: string },
  row: HumanRequestRow,
): Promise<string> {
  const { store, clock } = deps;
  const answer = sessionReviewAnswer(row.answer);
  const mark = (tx: StateStore, outcome: string) =>
    tx.humanRequest.patch(row.id, {
      change_card: {
        ...((row.change_card ?? {}) as JsonObject),
        key: SESSION_REVIEW_KEY,
        applied_at: clock.nowIso(),
        outcome,
      },
    });
  if (!answer || !row.session_id) {
    await mark(store, "unrecognized_answer");
    return "unrecognized_answer";
  }
  const sessionId = row.session_id;
  const findings = (await findingsOf(store, row)).filter((f) => f.status === "open");
  let correction: string | null = null;
  if (answer === "correct") {
    const checks = sessionChecks(await loadSessionReviewData(store, sessionId));
    const m = checks.metrics;
    const said = [
      m.claimedDone !== null ? `${m.claimedDone} done` : null,
      m.claimedCostChfMicro !== null
        ? `a cost of ${chf(m.claimedCostChfMicro)}`
        : m.claimedCostUsdMicro !== null
          ? `a cost of ${usd(m.claimedCostUsdMicro)}`
          : null,
    ].filter((x): x is string => x !== null);
    const spent = m.actualChfMicro !== null ? chf(m.actualChfMicro) : usd(m.actualUsdMicro);
    correction = `Corrected after the session review (request ${row.id}): by the records, ${m.doneTasks} of the task(s) the session planned or ran are done (${m.plannedDoneTasks} of ${m.plannedTasks} planned) and it spent ${spent}${said.length ? `; the summary said ${said.join(" and ")}` : ""}.`;
  }
  return store.transaction(async (tx) => {
    if (correction) {
      const session = await tx.session.mustGet(sessionId);
      await tx.session.patch(session.id, {
        summary: `${session.summary.trim()} ${correction}`.trim(),
      });
    }
    for (const f of findings) {
      const fresh = await tx.finding.mustGet(f.id);
      if (fresh.status !== "open") continue;
      if (correction && /^summary\b/i.test(fresh.description))
        await tx.finding.resolve(fresh.id, fresh.version, null);
      else await tx.finding.wontfix(fresh.id, fresh.version);
    }
    const outcome = answer === "correct" ? "corrected" : "acknowledged";
    await mark(tx, outcome);
    return outcome;
  });
}
