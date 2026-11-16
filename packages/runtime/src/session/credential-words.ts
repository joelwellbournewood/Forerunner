import type { BillingSourceKind } from "@forerunner/billing";
import { type CredentialWait, clockTime, yourCredential } from "./credential-wait.ts";

/**
 * Every person-facing sentence of the credential policy (d1109-cred-engine, ADR 0120; design §5:
 * one sentence read at a glance, CHF only, no ids, no raw states, a sentence promises only what
 * the app does). The card words are computed when the card is shown; the screens of
 * d1109-cred-screens read them from here.
 */

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The stop a wait names as a phrase after the credential: "is at its limit until 15:40". */
export interface StopWords {
  /** "15:40" today, "Tue 1 Dec, 01:00" another day. */
  untilText: string;
  /** The day alone for a month's stop ("Tue 1 Dec"), else `untilText`. */
  untilShort: string;
}

/** The wait's end in the person's clock (null for a refusal). */
export function stopWordsOf(
  wait: Pick<CredentialWait, "until">,
  opts: { timezone?: string; nowMs: number },
): StopWords | null {
  if (!wait.until) return null;
  const untilText = clockTime(wait.until, opts.timezone, opts.nowMs);
  return { untilText, untilShort: untilText.replace(/, \d\d:\d\d$/, "") };
}

/** "Your Claude subscription is at its limit until 15:40" (no full stop). */
export function stoppedPhrase(
  wait: Pick<CredentialWait, "reason" | "kind" | "stop">,
  until: string | null,
): string {
  const reason = wait.reason === "needs" ? (wait.stop ?? "limit") : wait.reason;
  const who = capital(yourCredential(wait.kind));
  if (reason === "refused")
    return `Anthropic refused ${wait.kind === "subscription" ? "your Claude sign-in" : "your API key"}`;
  const at = until ? ` until ${until}` : "";
  if (reason === "share") return `${who} is at the share Forerunner may use${at}`;
  if (reason === "key_month") return `${who} is at its monthly cap${at}`;
  return `${who} is at its limit${at}`;
}

/** "your subscription is at its limit until 15:40" (the short, lower-case form for a note). */
function shortStopped(
  wait: Pick<CredentialWait, "reason" | "kind" | "stop">,
  until: string | null,
) {
  return stoppedPhrase(wait, until)
    .replace("Your Claude subscription", "your subscription")
    .replace(/^Your /, "your ");
}

// ── CE-7: the ask card ────────────────────────────────────────────────────────────────────────

export interface AskCardInput {
  /** The stopped credential (the subscription under subscription_then_ask). */
  wait: Pick<CredentialWait, "reason" | "kind" | "until" | "stop">;
  timezone?: string;
  nowMs: number;
  /** "CHF 0.90": what the waiting work's next calls would cost on the other credential. */
  estimateChf: string;
  /** A session the person started waits for this stop (it goes on by itself after a Wait). */
  sessionWaits: boolean;
  /** When the person's waiting session goes on, when their quiet hours end later (ISO). */
  goesOnAt?: string;
}

export interface AskCardWords {
  title: string;
  body: string;
  options: { label: "Use API key" | "Wait"; explain: string }[];
  details: string[];
  /** The Done line of each answer, and the line of a card its stop's end closed. */
  done: { use: string; wait: string };
  closed: string;
}

/** The Ask card's option labels, in their order (Use API key first). */
export const ASK_OPTIONS = ["Use API key", "Wait"] as const;

/** The card's words, computed when it is shown (CE-7, CE-6). */
export function askCardWords(input: AskCardInput): AskCardWords {
  const opts = { ...(input.timezone ? { timezone: input.timezone } : {}), nowMs: input.nowMs };
  const w = stopWordsOf(input.wait, opts);
  const share = (input.wait.reason === "needs" ? input.wait.stop : input.wait.reason) === "share";
  const until = w?.untilText ?? "its reset";
  const goesOn = input.goesOnAt ? clockTime(input.goesOnAt, input.timezone, input.nowMs) : until;
  const after = input.goesOnAt ? `${goesOn} (after your quiet hours)` : goesOn;
  const title = share
    ? `Use your API key until ${w?.untilShort ?? "the month's end"}?`
    : `Use your API key until ${until}?`;
  const body = `${stoppedPhrase(input.wait, share ? null : until)}${
    share ? " this month" : ""
  }. Your API key can do the waiting work now: about ${input.estimateChf}.`;
  const useExplain = `Your work and chat use your API key until ${share ? (w?.untilShort ?? until) : until}: about ${input.estimateChf} for what waits now.`;
  const waitExplain = share
    ? input.sessionWaits
      ? `Nothing moves until ${until}, or until you raise the allowance; then your session goes on.`
      : `Nothing moves. After ${until}, or a raised allowance, the work runs at your next Start.`
    : input.sessionWaits
      ? `Nothing moves until ${after}; then your session goes on with your subscription.`
      : `Nothing moves. After ${until} the work runs at your next Start.`;
  return {
    title,
    body,
    options: [
      { label: "Use API key", explain: useExplain },
      { label: "Wait", explain: waitExplain },
    ],
    details: [
      "Forerunner's own monthly checks wait for your subscription; they cost nothing meanwhile.",
    ],
    done: {
      use: input.sessionWaits
        ? `Done: your API key does the work until ${share ? (w?.untilShort ?? until) : until}; your session goes on now.`
        : `Done: your API key does the work until ${share ? (w?.untilShort ?? until) : until}; the waiting work runs at your next Start.`,
      wait: input.sessionWaits
        ? `Done: nothing moves until ${after}; then your session goes on.`
        : `Done: nothing moves until ${until}; then the work runs at your next Start.`,
    },
    closed: `Closed: ${yourCredential(input.wait.kind)} can work again.`,
  };
}

/** The Ask card's line once its stop's end, a changed preset or the other credential closed it. */
export function askClosedLine(
  why: "stop_ended" | "policy_changed" | "other_cannot",
  kind: BillingSourceKind | string,
): string {
  if (why === "stop_ended") return `Closed: ${yourCredential(kind)} can work again.`;
  if (why === "policy_changed")
    return 'Closed: "Which Claude does the work" changed, so this question no longer applies.';
  return "Closed: your API key cannot do the work now either.";
}

// ── CE-8: refusals ────────────────────────────────────────────────────────────────────────────

/** What kind of refusal it was (stored as `limits.refusedCategory`; never the provider's words). */
export type RefusalCategory = "signed_out" | "invalid_key" | "not_allowed" | "other";

/**
 * The refusal's category from the failed call (CE-8): a 401 or `authentication_error` on a key
 * is an invalid or deleted key; a 403 `permission_error` is a key that may not use this model or
 * workspace; Claude Code's `authentication_failed` (or a 401 on the sign-in) is an expired or
 * signed-out sign-in; anything else, Anthropic did not accept it.
 */
export function refusalCategoryOf(
  kind: BillingSourceKind | string,
  message: string,
): RefusalCategory {
  const m = message.toLowerCase();
  if (kind === "subscription") {
    if (
      /authentication_failed|authentication_error|\b401\b|oauth|expired|sign(ed)? ?out|log ?in/.test(
        m,
      )
    )
      return "signed_out";
    if (/permission_error|\b403\b/.test(m)) return "not_allowed";
    return "other";
  }
  if (/permission_error|\b403\b|not allowed|not permitted/.test(m)) return "not_allowed";
  if (/authentication_error|\b401\b|invalid x-api-key|invalid api key|invalid_api_key/.test(m))
    return "invalid_key";
  return "other";
}

/** Why the credential was refused, in one sentence (CE-8). */
export function refusalWhy(category: RefusalCategory | null | undefined): string {
  switch (category) {
    case "signed_out":
      return "The sign-in has expired or was signed out.";
    case "invalid_key":
      return "The key is not valid or was deleted.";
    case "not_allowed":
      return "The key may not use this model or workspace.";
    default:
      return "Anthropic did not accept it.";
  }
}

/**
 * The refused card's body by the person's rule (CE-8): what the work does until a new one is
 * saved. `other` is the credential that can take the work (absent: none can), `estimateChf` the
 * waiting work's next calls on the API key (ask).
 */
export function refusedBody(input: {
  category: RefusalCategory | null | undefined;
  rule: "wait" | "next" | "ask";
  other?: BillingSourceKind | string | null;
  estimateChf?: string;
}): string {
  const why = refusalWhy(input.category);
  if (input.rule === "next" && input.other)
    return input.other === "subscription"
      ? `${why} Save a new one in Settings; until then your Claude subscription does the work.`
      : `${why} Save a new one in Settings; until then your API key does the work, at a cost per use.`;
  if (input.rule === "ask" && input.other === "api_key" && input.estimateChf)
    return `${why} Save a new one in Settings, or go on with your API key until then (about ${input.estimateChf}).`;
  return `${why} Save a new one in Settings; until then the work waits.`;
}

// ── CE-11: the session log ───────────────────────────────────────────────────────────────────

/** '"Style the page" goes on with your API key from where it stopped: your subscription ...'. */
export function switchLogLine(
  title: string,
  to: BillingSourceKind | string,
  wait: Pick<CredentialWait, "reason" | "kind" | "stop">,
  until: string | null,
): string {
  return `"${title}" goes on with ${yourCredential(to)} from where it stopped: ${shortStopped(wait, until)}.`;
}

/** The line when the first choice serves again in a session that moved (once per stop). */
export function backLogLine(kind: BillingSourceKind | string): string {
  return `${capital(yourCredential(kind))} can work again; the next tasks use it.`;
}

// ── CE-12: the switch notification ───────────────────────────────────────────────────────────

/** One notification per stop and session for a move onto money the policy made by itself. */
export function switchNotificationWords(input: {
  projectName: string;
  wait: Pick<CredentialWait, "reason" | "kind" | "stop">;
  until: string | null;
  estimateChf: string;
}): { title: string; body: string } {
  return {
    title: `${input.projectName}: work goes on with your API key`,
    body: `${stoppedPhrase(input.wait, input.until)}. Your API key costs money: about ${input.estimateChf} for what is left.`,
  };
}

// ── CE-9: chat ───────────────────────────────────────────────────────────────────────────────

/** The reply of a chat question the policy holds (no model call, no ledger row). */
export function chatHoldReply(
  wait: Pick<CredentialWait, "reason" | "kind" | "stop">,
  until: string | null,
): string {
  return `${stoppedPhrase(wait, until)}, so I have not answered. I can still add, move and start tasks.`;
}

/** The one-off press's consequence line: "Answers this question on your API key: about CHF 0.02." */
export function chatOneOffExplain(to: BillingSourceKind | string, estimateChf: string): string {
  return `Answers this question on ${yourCredential(to)}: about ${estimateChf}.`;
}

/** The note under an answer another credential gave: once per stop per conversation. */
export function chatSwitchNote(
  to: BillingSourceKind | string,
  wait: Pick<CredentialWait, "reason" | "kind" | "stop">,
  until: string | null,
): string {
  return `Answered with ${yourCredential(to)}: ${shortStopped(wait, until)}.`;
}

// ── CE-13: the setting ───────────────────────────────────────────────────────────────────────

/** settings.set billing_order or mid_session_limit (and their Undo) once the policy is stored. */
export const LEGACY_SETTING_REPLACED =
  'This was replaced by "Which Claude does the work"; change it there.';
