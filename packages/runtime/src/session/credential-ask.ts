import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, StateStore } from "@forerunner/state";
import { updateSourceLimits, waitingOf } from "../wiring/billing-pick.ts";
import type { CredentialWait } from "./credential-wait.ts";
import { ASK_OPTIONS } from "./credential-words.ts";
import { unappliedAnswers } from "./findings.ts";

/**
 * d1109-cred-engine CE-7 (ADR 0120; the owner's 7a: "use subscription until runs out --> go to
 * API after asking human"): under 'Subscription first, then ask' a stop of the first choice files
 * ONE card per stop ("Use your API key until 15:40?"), filed only by the writer that set
 * `limits.asking {stopKey, requestId}` on the stopped source with the version check, so a review
 * and a task run that hold at the same instant file one card, and a restart files none again.
 *
 * - **Use API key** re-reads the stop and writes `limits.grant {to, stopKey}` (version-checked,
 *   audit row `billing.grant`): every pick but a background job's may use the API key until that
 *   stop ends. The waiting work goes on (the caller's `onGrant`).
 * - **Wait** moves nothing; the asking mark keeps the stop, so no second card comes; the
 *   person's waiting session goes on by itself at the stop's end (d1109-starts-engine).
 * - A second or late answer changes nothing; an answer after the stop ended grants nothing.
 * - The wake (`settleAsks`) ends grants whose stop is over and withdraws open cards whose stop
 *   ended, whose preset is no longer 'ask', or whose other credential cannot serve any more.
 */

/** The ask card's key. */
export const CREDENTIAL_ASK_KEY = "credential:ask";

/** The audit row a grant writes. */
export const BILLING_GRANT_AUDIT_TOOL = "billing.grant";

const logger = log("credential-ask");

export interface AskStop {
  sourceId: string;
  stopKey: string;
  kind: CredentialWait["kind"];
  reason: CredentialWait["reason"];
  until: string | null;
}

/**
 * The one ask card for this stop (CE-7): filed only by the writer that set `limits.asking` for
 * this stop key (a stop already asked about, or answered without a card, files nothing). Returns
 * the card filed now, or null.
 */
export async function ensureAskCard(
  deps: {
    store: Pick<StateStore, "billingSource" | "humanRequest">;
    clock: Clock;
    humanId: string;
    /** What the waiting work's next calls cost on the other credential (USD micro). */
    estimateUsdMicro: number;
    chfPerUsd: number;
  },
  stop: AskStop,
): Promise<HumanRequestRow | null> {
  let mine = false;
  await updateSourceLimits(deps.store, stop.sourceId, (limits) => {
    const asking = limits.asking as { stopKey?: unknown } | undefined;
    mine = asking?.stopKey !== stop.stopKey;
    return mine
      ? {
          ...limits,
          asking: { stopKey: stop.stopKey, requestId: null, at: deps.clock.nowIso() },
        }
      : null;
  });
  if (!mine) return null;
  const request = await deps.store.humanRequest.insert({
    human_id: deps.humanId,
    project_id: null,
    task_id: null,
    session_id: null,
    kind: "approval",
    why: "Use your API key until your Claude subscription can work again?",
    steps: [],
    options: [...ASK_OPTIONS],
    blocking: true,
    risk: "medium",
    change_card: {
      key: CREDENTIAL_ASK_KEY,
      source_id: stop.sourceId,
      stop_key: stop.stopKey,
      credential_kind: stop.kind,
      reason: stop.reason,
      until: stop.until,
      estimate_usd_micro: Math.max(0, Math.round(deps.estimateUsdMicro)),
      chf_per_usd: deps.chfPerUsd,
      filed_at: deps.clock.nowIso(),
      applied_at: null,
    },
    author_agent: null,
  });
  await updateSourceLimits(deps.store, stop.sourceId, (limits) => {
    const asking = limits.asking as { stopKey?: unknown; requestId?: unknown } | undefined;
    if (asking?.stopKey !== stop.stopKey || asking.requestId === request.id) return null;
    return { ...limits, asking: { ...(asking as JsonObject), requestId: request.id } };
  });
  return request;
}

/**
 * The person chose Wait in the Start dialog (its "Start at 15:40" under 'ask', d1109-cred-screens
 * CS-3: "under ask it also records the person's Wait for this stop, so no card follows"): the
 * stop is marked asked before the kept start's wait is noted, so no card follows their own
 * choice; an ask card of this stop that is already open (another project's work met the stop
 * first) is answered "Wait" and applied at once (outcome waited: the person's session goes on by
 * itself at the stop's end), so one stop asks one question, also after a restart. Returns whether
 * a card was closed.
 */
export async function recordWait(
  deps: {
    store: Pick<StateStore, "billingSource" | "humanRequest">;
    clock: Clock;
    humanId: string;
  },
  stop: { sourceId: string; stopKey: string },
): Promise<{ closedCard: boolean }> {
  await updateSourceLimits(deps.store, stop.sourceId, (limits) => {
    const asking = limits.asking as { stopKey?: unknown } | undefined;
    if (asking?.stopKey === stop.stopKey) return null;
    return {
      ...limits,
      asking: { stopKey: stop.stopKey, requestId: null, at: deps.clock.nowIso(), answer: "wait" },
    };
  });
  let closedCard = false;
  const open = (
    await deps.store.humanRequest.open({ humanId: deps.humanId }, { limit: 500 })
  ).filter((r) => {
    const card = r.change_card as { key?: unknown; stop_key?: unknown } | null;
    return card?.key === CREDENTIAL_ASK_KEY && card.stop_key === stop.stopKey;
  });
  for (const r of open) {
    const answered = await deps.store.humanRequest
      .answer(r.id, r.version, ASK_OPTIONS[1], deps.humanId, deps.clock.nowIso())
      .catch(() => null);
    if (!answered) continue;
    await deps.store.humanRequest.patch(answered.id, {
      change_card: {
        ...((answered.change_card ?? {}) as JsonObject),
        applied_at: deps.clock.nowIso(),
        outcome: "waited",
        session_goes_on: true,
      },
    });
    closedCard = true;
  }
  return { closedCard };
}

/**
 * d1109-cred-screens CS-3 (the Start dialog's "Use API key", the person's tap): the same grant
 * the ask card's Use API key writes (`limits.grant {to, stopKey, by: "start"}`, version-checked,
 * one billing.grant audit row), for this stop only. An open ask card of the stop is answered with
 * "Use API key" and applied at once (outcome granted), so it shows its Done line and the sync
 * never applies it twice. Returns whether a card was closed.
 */
export async function grantForStart(
  deps: {
    store: Pick<StateStore, "billingSource" | "humanRequest" | "auditLog">;
    clock: Clock;
    humanId: string;
  },
  stop: { sourceId: string; stopKey: string },
  sessionGoesOn: boolean,
): Promise<{ closedCard: boolean }> {
  await updateSourceLimits(deps.store, stop.sourceId, (limits) => {
    const g = limits.grant as { stopKey?: unknown } | undefined;
    if (g?.stopKey === stop.stopKey) return null;
    return {
      ...limits,
      grant: { to: "api_key", stopKey: stop.stopKey, by: "start", at: deps.clock.nowIso() },
    };
  });
  await deps.store.auditLog
    .append({
      tool: BILLING_GRANT_AUDIT_TOOL,
      allowed: true,
      human_id: deps.humanId,
      input_summary: JSON.stringify({ sourceId: stop.sourceId, to: "api_key", by: "start" }),
      result_summary:
        "the person's yes in the Start dialog: the API key serves until this stop ends",
      occurred_at: deps.clock.nowIso(),
    })
    .catch(() => undefined);
  let closedCard = false;
  const open = (
    await deps.store.humanRequest.open({ humanId: deps.humanId }, { limit: 500 })
  ).filter((r) => {
    const card = r.change_card as { key?: unknown; stop_key?: unknown } | null;
    return card?.key === CREDENTIAL_ASK_KEY && card.stop_key === stop.stopKey;
  });
  for (const r of open) {
    const answered = await deps.store.humanRequest
      .answer(r.id, r.version, ASK_OPTIONS[0], deps.humanId, deps.clock.nowIso())
      .catch(() => null);
    if (!answered) continue;
    await deps.store.humanRequest.patch(answered.id, {
      change_card: {
        ...((answered.change_card ?? {}) as JsonObject),
        applied_at: deps.clock.nowIso(),
        outcome: "granted",
        session_goes_on: sessionGoesOn,
      },
    });
    closedCard = true;
  }
  return { closedCard };
}

/** The audit row the end of a grant writes (d1109-cred-screens). */
export const BILLING_GRANT_END_AUDIT_TOOL = "billing.grant_end";

/**
 * d1109-cred-screens CS-1 (Settings' "Stop using it"): the person ends their standing yes. The
 * grant goes (version-checked); the asking mark stays, so no new card comes for this stop and
 * the next pick waits for its end. A run already going on the other credential finishes (a run
 * is never moved mid-way, ADR 0100 point 3). Returns the sources whose grant ended.
 */
export async function endGrant(
  store: Pick<StateStore, "billingSource" | "auditLog">,
  clock: Clock,
  humanId: string,
): Promise<string[]> {
  const ended: string[] = [];
  for (const row of await store.billingSource.list({ human_id: humanId }, { limit: 100 })) {
    if (!(row.limits as { grant?: unknown }).grant) continue;
    let mine = false;
    await updateSourceLimits(store, row.id, (limits) => {
      if (!limits.grant) return null;
      mine = true;
      const { grant: _g, ...rest } = limits;
      return rest;
    });
    if (!mine) continue;
    ended.push(row.id);
    await store.auditLog
      .append({
        tool: BILLING_GRANT_END_AUDIT_TOOL,
        allowed: true,
        human_id: humanId,
        input_summary: JSON.stringify({ sourceId: row.id }),
        result_summary: "the person ended their yes: the next pick waits for the stop's end",
        occurred_at: clock.nowIso(),
      })
      .catch(() => undefined);
  }
  return ended;
}

/** The person's answer of an ask card: Use API key or Wait (the option labels), else null. */
export function askAnswerOf(answer: unknown): "use" | "wait" | null {
  const raw =
    typeof answer === "string"
      ? answer
      : answer && typeof answer === "object"
        ? String((answer as { choice?: unknown }).choice ?? "")
        : "";
  const a = raw.trim().toLowerCase();
  if (a === "use api key") return "use";
  if (a === "wait") return "wait";
  return null;
}

export interface AskAnswerDeps {
  store: StateStore;
  clock: Clock;
  humanId: string;
  /** The stop the source is at now (null: it serves again). */
  currentStop(sourceId: string): Promise<{ stopKey: string } | null>;
  /**
   * The grant is written: the waiting work goes on (a running session takes its waiting tasks
   * back; a session that ended to wait goes on now as the person's start). Returns whether a
   * person's session goes on now.
   */
  onGrant(sourceId: string, projectIds: readonly string[]): Promise<boolean>;
}

/**
 * The answered ask cards (CE-7), applied once each: Use API key grants this stop and lets the
 * waiting work go on; Wait moves nothing. A card answered after its stop ended grants nothing.
 * The outcome is kept on the card (`granted`, `waited`, `stop_ended`), which its Done line reads.
 */
export async function syncAskAnswers(
  deps: AskAnswerDeps,
): Promise<{ granted: number; waited: number; late: number }> {
  const out = { granted: 0, waited: 0, late: 0 };
  for (const row of await unappliedAnswers(deps.store, deps.humanId, CREDENTIAL_ASK_KEY)) {
    const card = (row.change_card ?? {}) as JsonObject;
    const finish = (outcome: string, extra: JsonObject = {}) =>
      deps.store.humanRequest.patch(row.id, {
        change_card: { ...card, applied_at: deps.clock.nowIso(), outcome, ...extra },
      });
    const sourceId = typeof card.source_id === "string" ? card.source_id : "";
    const stopKey = typeof card.stop_key === "string" ? card.stop_key : "";
    const answer = askAnswerOf(row.answer);
    try {
      const now = sourceId ? await deps.currentStop(sourceId) : null;
      if (!now || now.stopKey !== stopKey) {
        out.late++;
        await finish("stop_ended");
        continue;
      }
      if (answer !== "use") {
        // The person's session that ended to wait goes on by itself at the stop's end.
        const src = await deps.store.billingSource.get(sourceId);
        const goesOn = waitingOf((src?.limits ?? {}) as JsonObject).some((w) => !!w.kept);
        out.waited++;
        await finish("waited", { session_goes_on: goesOn });
        continue;
      }
      await updateSourceLimits(deps.store, sourceId, (limits) => {
        const g = limits.grant as { stopKey?: unknown } | undefined;
        if (g?.stopKey === stopKey) return null;
        return {
          ...limits,
          grant: { to: "api_key", stopKey, by: "card", at: deps.clock.nowIso() },
        };
      });
      await deps.store.auditLog
        .append({
          tool: BILLING_GRANT_AUDIT_TOOL,
          allowed: true,
          human_id: deps.humanId,
          input_summary: JSON.stringify({ sourceId, to: "api_key", by: "card" }),
          result_summary: "the person's yes: the API key serves until this stop ends",
          occurred_at: deps.clock.nowIso(),
        })
        .catch(() => undefined);
      const row2 = await deps.store.billingSource.get(sourceId);
      const projects = [
        ...new Set(waitingOf((row2?.limits ?? {}) as JsonObject).map((w) => w.projectId)),
      ];
      const sessionGoesOn = await deps.onGrant(sourceId, projects).catch((e: unknown) => {
        logger.warn("the waiting work did not go on after the grant", { error: errorMessage(e) });
        return false;
      });
      out.granted++;
      await finish("granted", { session_goes_on: sessionGoesOn });
    } catch (e) {
      logger.warn("the ask card's answer was not applied", { error: errorMessage(e) });
    }
  }
  return out;
}

/**
 * The wake's part (CE-7, before the waits are taken): a grant whose stop is over ends, and an
 * open ask card whose stop ended (the person's waiting session then goes on as after Wait) or
 * whose preset is no longer 'ask' is withdrawn, with its line. Returns the cards closed.
 */
export async function settleAsks(deps: {
  store: StateStore;
  humanId: string;
  currentStop(sourceId: string): Promise<{ stopKey: string } | null>;
  /** The person's rule at a stop now. */
  rule(): Promise<"wait" | "ask" | "next">;
  /**
   * Whether another credential can do the waiting work now (the card's Use API key): absent, it
   * is taken to; false closes an open card ("Closed: your API key cannot do the work now
   * either."), since its yes could move nothing.
   */
  otherServes?(sourceId: string): Promise<boolean>;
}): Promise<number> {
  for (const row of await deps.store.billingSource.list(
    { human_id: deps.humanId },
    { limit: 100 },
  )) {
    const limits = (row.limits ?? {}) as JsonObject;
    const grant = limits.grant as { stopKey?: unknown } | undefined;
    const asking = limits.asking as { stopKey?: unknown } | undefined;
    if (!grant && !asking) continue;
    const now = await deps.currentStop(row.id).catch(() => null);
    await updateSourceLimits(deps.store, row.id, (l) => {
      const g = l.grant as { stopKey?: unknown } | undefined;
      const a = l.asking as { stopKey?: unknown } | undefined;
      const endGrant = !!g && g.stopKey !== now?.stopKey;
      const endAsk = !!a && a.stopKey !== now?.stopKey;
      if (!endGrant && !endAsk) return null;
      const { grant: _g, asking: _a, ...rest } = l;
      return {
        ...rest,
        ...(g && !endGrant ? { grant: g as JsonObject } : {}),
        ...(a && !endAsk ? { asking: a as JsonObject } : {}),
      };
    });
  }
  const rule = await deps.rule();
  let closed = 0;
  const open = (
    await deps.store.humanRequest.open({ humanId: deps.humanId }, { limit: 500 })
  ).filter((r) => (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_ASK_KEY);
  for (const r of open) {
    const card = r.change_card as JsonObject;
    const sourceId = typeof card.source_id === "string" ? card.source_id : "";
    const now = sourceId ? await deps.currentStop(sourceId).catch(() => null) : null;
    const why =
      !now || now.stopKey !== card.stop_key
        ? "stop_ended"
        : rule !== "ask"
          ? "policy_changed"
          : deps.otherServes && !(await deps.otherServes(sourceId).catch(() => true))
            ? "other_cannot"
            : null;
    if (!why) continue;
    await deps.store.humanRequest
      .patch(r.id, { change_card: { ...card, closed_why: why } })
      .catch(() => undefined);
    const fresh = await deps.store.humanRequest.get(r.id);
    if (fresh)
      await deps.store.humanRequest.withdraw(fresh.id, fresh.version).catch(() => undefined);
    closed++;
  }
  return closed;
}
