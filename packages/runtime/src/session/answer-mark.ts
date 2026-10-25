import { type Clock, ForerunnerError } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, StateStore } from "@forerunner/state";

/**
 * The mark an answered request carries once something acted on its answer: `applied_at`, the
 * `outcome` and whatever else the producer records (`start_id`, `error`). It is shared by every
 * producer that turns an inbox answer into a session start: the daemon's `syncPlanApprovals`
 * and `syncLateApprovals` (`plan-approval.ts`, `late-approval.ts`; ADR 0053, ADR 0088) and the
 * cloud runner's inbox trigger on the same store, so "an answered request is acted on at most
 * once" holds across the route, the poll, a restart and two installs.
 */

/** Whether an answered request was acted on (its card carries `applied_at`). */
export function answerApplied(row: Pick<HumanRequestRow, "change_card">): boolean {
  return Boolean((row.change_card as JsonObject | null)?.applied_at);
}

function markOf(row: Pick<HumanRequestRow, "change_card">): string {
  const card = (row.change_card ?? {}) as JsonObject;
  return JSON.stringify([card.applied_at ?? null, card.outcome ?? null]);
}

/**
 * Records what became of an answered request on its card: `applied_at`, the `outcome` and
 * `extra`. The write is conditional on the version the caller read, so of two producers of a
 * start (the daemon's sync and the cloud runner's inbox trigger on a shared store, or two
 * overlapping syncs of one daemon) exactly one marks a request first; the other gets null and
 * starts nothing. A version that moved for another reason (the row was not marked meanwhile:
 * the hooks' port spending the answer, say) is read again and the mark retried. The claimer's
 * later marks pass the row it got back, so a report written in between (a start failure) is
 * kept.
 */
export async function markAnswer(
  store: Pick<StateStore, "humanRequest">,
  clock: Clock,
  row: HumanRequestRow,
  outcome: string,
  extra: JsonObject = {},
): Promise<HumanRequestRow | null> {
  let current = row;
  for (let attempt = 0; attempt < 3; attempt++) {
    const card = (current.change_card ?? {}) as JsonObject;
    try {
      return await store.humanRequest.update(current.id, current.version, {
        change_card: { ...card, applied_at: clock.nowIso(), outcome, ...extra },
      });
    } catch (e) {
      if (!(e instanceof ForerunnerError && e.code === "version_conflict")) throw e;
      const fresh = await store.humanRequest.get(current.id);
      // Marked meanwhile: by the other producer's claim, or by a report after this claim.
      if (!fresh || markOf(fresh) !== markOf(current)) return null;
      current = fresh;
    }
  }
  return null;
}
