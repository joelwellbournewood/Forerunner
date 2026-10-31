import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, JsonValue, StateStore } from "@forerunner/state";
import type { CommandLoop, PendingView } from "./commands.ts";
import type { CommandResultView } from "./ports.ts";

/**
 * Change cards answered in the Inbox (spec Q, ADR 0030 item 3; U-029). A medium or high-risk
 * change asked for in Chat, by voice, from the palette or from the phone waits as a pending
 * confirmation: a `human_request` row (the card the Inbox shows, options `yes`/`no` or
 * `approve on device`/`reject`) plus the executor's closure, which lives in this daemon only.
 * The Inbox answers the row (the daemon's `POST /requests/:id/answer`; the phone and the web
 * approvals through the state service), and none of those paths reaches the closure. This is
 * the one place that applies such answers, for every caller: the daemon's `syncApprovals`
 * (the answer route, `request.answer`, the approvals poll, compose) and the remote watcher's
 * drain. It reads the rows behind this daemon's open cards: an approval runs the change (a
 * medium card as a tap, a high-risk card as a device confirmation naming this daemon's own
 * desktop row without a biometric, which the policy accepts for the same human: the daemon's
 * route is the human at this PC, the state service already checked a phone's biometric), a
 * rejection cancels it. Rows the executor answered itself (they carry its `verdict`) are left
 * alone, and an answer by another human is ignored. An approval the executor refuses (the
 * desktop row revoked, the risk rose since the card was shown, no desktop row to confirm a
 * high-risk card) is not applied: it is reported through `onRefused` and the dead card dropped,
 * so the next sync does not repeat it and the human asks again; a refusal because another
 * answer is in flight is retried on the next sync.
 */
export interface AnsweredCardsDeps {
  store: Pick<StateStore, "humanRequest">;
  commands: Pick<CommandLoop, "confirm" | "cancel" | "pending">;
  humanId: string;
  /** This PC's desktop device row: a high-risk card approved in the Inbox is confirmed as it. */
  deviceId: string | null;
  /** An approval the executor refused (not a transient conflict): audit it, tell the human. */
  onRefused?: (card: PendingView, result: CommandResultView) => Promise<void>;
}

export interface AnsweredCardsResult {
  applied: number;
  cancelled: number;
  refused: number;
}

export async function syncAnsweredCards(deps: AnsweredCardsDeps): Promise<AnsweredCardsResult> {
  const logger = log("answered-cards");
  let applied = 0;
  let cancelled = 0;
  let refused = 0;
  for (const p of deps.commands.pending(deps.humanId)) {
    let row: HumanRequestRow | undefined;
    try {
      row = await deps.store.humanRequest.get(p.id);
    } catch (e) {
      logger.warn("could not read the request behind a pending card", {
        id: p.id,
        error: errorMessage(e),
      });
      continue;
    }
    if (row?.status !== "answered") continue;
    if (isExecutorAnswer(row.answer)) continue;
    const by = { kind: "human" as const, id: row.answered_by ?? deps.humanId };
    if (by.id !== deps.humanId) {
      logger.warn("a pending card was answered by another human; ignored", { id: p.id });
      continue;
    }
    const approved = approvalOf(
      row.answer,
      row.options.filter((o): o is string => typeof o === "string"),
    );
    let r: CommandResultView;
    if (!approved) {
      r = await deps.commands.cancel(p.id, by);
      // A refused cancel means the card is already gone (expired, answered elsewhere).
      if (r.status !== "refused") cancelled++;
      logger.info("answered change card cancelled", { id: p.id, status: r.status });
      continue;
    }
    if (p.decision === "needs_device" && !deps.deviceId) {
      r = {
        status: "refused",
        commands: cardCommands(p.cardJson),
        reason:
          "this daemon has no desktop device row to confirm a high-risk change; confirm it on a paired phone or in the app's Changes settings",
        code: "approval_required",
      };
    } else {
      r =
        p.decision === "needs_device"
          ? await deps.commands.confirm(p.id, {
              kind: "device",
              deviceId: deps.deviceId as string,
              biometric: false,
              by,
            })
          : await deps.commands.confirm(p.id, { kind: "tap", by, source: "chat" });
    }
    if (r.status === "refused") {
      // Another answer (the UI's route) holds the card: it is theirs, or ours next sync.
      if (r.code === "version_conflict") continue;
      refused++;
      logger.warn("answered change card refused by the executor; card dropped", {
        id: p.id,
        code: r.code ?? null,
        reason: r.reason ?? "refused",
      });
      try {
        await deps.onRefused?.(p, r);
      } catch (e) {
        logger.warn("could not report the refused card", { id: p.id, error: errorMessage(e) });
      }
      try {
        // A refusal that already took the card out of the executor (its risk rose) makes this
        // a no-op refusal; either way nothing is pending afterwards.
        await deps.commands.cancel(p.id, by);
      } catch (e) {
        logger.warn("could not drop the refused card", { id: p.id, error: errorMessage(e) });
      }
      continue;
    }
    applied++;
    logger.info("answered change card applied", { id: p.id, status: r.status });
  }
  return { applied, cancelled, refused };
}

/**
 * Whether a request is a change card of the command executor (`CommandExecutor.createPending`
 * in `@forerunner/commands`): an approval whose card carries the confirmation decision and the
 * email token the executor writes.
 */
export function isChangeCardRequest(row: Pick<HumanRequestRow, "kind" | "change_card">): boolean {
  const card = row.change_card as JsonObject | null;
  return (
    row.kind === "approval" &&
    card !== null &&
    typeof card === "object" &&
    !Array.isArray(card) &&
    typeof card.email_token === "string" &&
    (card.decision === "needs_yes" || card.decision === "needs_device")
  );
}

export interface OrphanedCardsDeps {
  store: Pick<StateStore, "humanRequest" | "message">;
  clock: Clock;
  commands: Pick<CommandLoop, "pending">;
  humanId: string;
  agentId: string;
}

/**
 * The open change cards of this human that no closure stands behind (U-029): the executor's
 * pending confirmations live in the daemon that showed them, so after a restart (a crash, an
 * update, Quit and start) their cards would stay in the Inbox as buttons that do nothing. The
 * daemon expires them when it starts and tells the human once, in plain words, that the change
 * was not made and to ask again. Only the daemon (its background services) calls this: a CLI
 * one-shot composes on the same store while the daemon runs and must not expire its cards.
 * One daemon per human holds pending cards (the remote watcher and the PC-wins rule assume one
 * PC per human); the cloud runner files none.
 */
export async function expireOrphanedCards(deps: OrphanedCardsDeps): Promise<number> {
  const logger = log("answered-cards");
  const live = new Set(deps.commands.pending(deps.humanId).map((p) => p.id));
  const open = await deps.store.humanRequest.open({ humanId: deps.humanId }, { limit: 500 });
  let expired = 0;
  for (const row of open) {
    if (!isChangeCardRequest(row) || live.has(row.id)) continue;
    if (row.author_human !== deps.humanId && row.author_agent !== deps.agentId) continue;
    try {
      await deps.store.humanRequest.expire(row.id, row.version);
    } catch (e) {
      logger.warn("orphaned change card not expired", { id: row.id, error: errorMessage(e) });
      continue;
    }
    expired++;
    const card = row.change_card as JsonObject;
    const what = typeof card.what === "string" && card.what ? card.what : row.why;
    const change =
      typeof card.oldValue === "string" && typeof card.newValue === "string"
        ? ` (${card.oldValue} to ${card.newValue})`
        : "";
    try {
      await deps.store.message.send({
        from_agent_id: deps.agentId,
        to_human_id: deps.humanId,
        project_id: row.project_id,
        type: "warning",
        body: `The change you asked for was not made: ${what}${change}. Forerunner restarted before you answered its card, and a card can only be answered while the app that showed it runs. Ask again in Chat if you still want it.`,
        requires_ack: false,
        author_agent: deps.agentId,
      });
    } catch (e) {
      logger.warn("could not tell the human about an expired change card", {
        id: row.id,
        error: errorMessage(e),
      });
    }
    logger.info("orphaned change card expired at start", { id: row.id, at: deps.clock.nowIso() });
  }
  return expired;
}

/** The command names a change card covers (its parts, else the one command). */
export function cardCommands(card: Record<string, unknown> | null | undefined): string[] {
  if (!card) return [];
  const parts = card.parts;
  if (Array.isArray(parts) && parts.length) {
    return parts
      .map((p) => (p && typeof p === "object" ? (p as { command?: unknown }).command : null))
      .filter((c): c is string => typeof c === "string");
  }
  return typeof card.command === "string" ? [card.command] : [];
}

/** The executor records its own confirmation as `{ verdict, kind, by, device_id, biometric }`. */
export function isExecutorAnswer(answer: JsonValue | null): boolean {
  return (
    answer !== null &&
    typeof answer === "object" &&
    !Array.isArray(answer) &&
    typeof (answer as JsonObject).verdict === "string"
  );
}

const YES_RE = /^\s*(yes|ja|oui|ok|okay|approve|approved|confirm|confirmed|approve on device)\b/i;

/**
 * Whether an inbox answer approves the card: the first option (`yes` / `approve on device`),
 * a yes-like word, `true`, or an object whose `choice`, `option`, `answer` or `approved`
 * says so. Anything else is a rejection.
 */
export function approvalOf(answer: JsonValue | null, options: readonly string[]): boolean {
  if (answer === null || answer === undefined) return false;
  if (typeof answer === "boolean") return answer;
  if (typeof answer === "string") {
    const first = options[0];
    if (first && answer.trim().toLowerCase() === first.toLowerCase()) return true;
    return YES_RE.test(answer);
  }
  if (typeof answer === "object" && !Array.isArray(answer)) {
    const o = answer as JsonObject;
    if (typeof o.approved === "boolean") return o.approved;
    for (const key of ["choice", "option", "answer", "verdict"]) {
      const v = o[key];
      if (typeof v === "string" || typeof v === "boolean") return approvalOf(v, options);
    }
  }
  return false;
}
