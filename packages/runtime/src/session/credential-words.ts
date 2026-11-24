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
export function shortStoppedPhrase(
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

/**
 * d1109-cred-screens (CS-8; design §5 rule 7): the ask card's figure: "about CHF 0.40", "less than
 * CHF 0.01" alone under a centime, and none when no figure is known ("CHF 0.00": the work's
 * estimate was not known when the card was filed): the sentence then says the cost per use.
 */
function askFigure(estimateChf: string): { body: string; use: string } {
  if (/^CHF 0\.00$/.test(estimateChf.trim()))
    return { body: ", at a cost per use", use: ", at a cost per use" };
  const est = /^less than /.test(estimateChf) ? estimateChf : `about ${estimateChf}`;
  return { body: `: ${est}`, use: `: ${est} for what waits now` };
}

/** The Ask card's option labels, in their order (Use API key first). */
export const ASK_OPTIONS = ["Use API key", "Wait"] as const;

/**
 * The ask card of a refusal (CE-8, the owner's 7c: "follow the framework for a) or b) as if it has
 * run out, but also give the user some kind of notification"): under "then ask me" a refused
 * first choice is a stop like a limit, asked about once, until a new one is saved; the refused
 * card stays the notification with its link to save one.
 */
function refusedAskWords(input: AskCardInput): AskCardWords {
  const saved =
    input.wait.kind === "subscription" ? "a new sign-in is saved" : "a new key is saved";
  const fig = askFigure(input.estimateChf);
  return {
    title: `Use your API key until ${saved}?`,
    body: `${stoppedPhrase(input.wait, null)}. Your API key can do the waiting work now${fig.body}.`,
    options: [
      {
        label: "Use API key",
        explain: `Your work and chat use your API key until ${saved}${fig.use}.`,
      },
      {
        label: "Wait",
        explain: input.sessionWaits
          ? `Nothing moves until ${saved}; then your session goes on with your subscription.`
          : `Nothing moves. Once ${saved}, the work runs at your next Start.`,
      },
    ],
    details: [
      "Forerunner's own monthly checks wait for your subscription; they cost nothing meanwhile.",
    ],
    done: {
      use: input.sessionWaits
        ? `Your API key does the work until ${saved}; your session goes on now.`
        : `Your API key does the work until ${saved}; the waiting work runs at your next Start.`,
      wait: input.sessionWaits
        ? `Nothing moves until ${saved}; then your session goes on.`
        : `Nothing moves until ${saved}; then the work runs at your next Start.`,
    },
    closed: `Closed: ${yourCredential(input.wait.kind)} can work again.`,
  };
}

/** The card's words, computed when it is shown (CE-7, CE-6). */
export function askCardWords(input: AskCardInput): AskCardWords {
  if ((input.wait.reason === "needs" ? input.wait.stop : input.wait.reason) === "refused")
    return refusedAskWords(input);
  const opts = { ...(input.timezone ? { timezone: input.timezone } : {}), nowMs: input.nowMs };
  const w = stopWordsOf(input.wait, opts);
  const share = (input.wait.reason === "needs" ? input.wait.stop : input.wait.reason) === "share";
  const until = w?.untilText ?? "its reset";
  const goesOn = input.goesOnAt ? clockTime(input.goesOnAt, input.timezone, input.nowMs) : until;
  const after = input.goesOnAt ? `${goesOn} (after your quiet hours)` : goesOn;
  const title = share
    ? `Use your API key until ${w?.untilShort ?? "the month's end"}?`
    : `Use your API key until ${until}?`;
  const fig = askFigure(input.estimateChf);
  const body = `${stoppedPhrase(input.wait, share ? null : until)}${
    share ? " this month" : ""
  }. Your API key can do the waiting work now${fig.body}.`;
  const useExplain = `Your work and chat use your API key until ${share ? (w?.untilShort ?? until) : until}${fig.use}.`;
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
    // The outcome the Inbox shows after "Done: " (its Done line) and alone in Answered: one
    // sentence, no "Done:" of its own (before, the screen read "Done: Done: ...").
    done: {
      use: input.sessionWaits
        ? `Your API key does the work until ${share ? (w?.untilShort ?? until) : until}; your session goes on now.`
        : `Your API key does the work until ${share ? (w?.untilShort ?? until) : until}; the waiting work runs at your next Start.`,
      wait: input.sessionWaits
        ? `Nothing moves until ${after}; then your session goes on.`
        : `Nothing moves until ${until}; then the work runs at your next Start.`,
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

/**
 * C5-left-5 (d1109-cred-screens): the refused card's closed line says what became of waiting
 * work only when work waited: 'A new one is saved; the work that waited for it goes on.' after
 * a save with work waiting, 'A new key is saved.' (or sign-in) with none, and 'Closed: the work
 * that waited for it goes on with your Claude subscription.' when another credential took it
 * all while this one stays refused (TR-10; before, that card read 'A new one is saved; ...').
 */
export function refusedClosedLine(
  kind: BillingSourceKind | string,
  why: "saved" | "taken",
  workWaited: boolean,
): string {
  if (why === "taken")
    return `Closed: the work that waited for it goes on with ${kind === "subscription" ? "your API key" : "your Claude subscription"}.`;
  if (workWaited) return "A new one is saved; the work that waited for it goes on.";
  return kind === "subscription" ? "A new sign-in is saved." : "A new key is saved.";
}

// ── CE-11: the session log ───────────────────────────────────────────────────────────────────

/** '"Style the page" goes on with your API key from where it stopped: your subscription ...'. */
export function switchLogLine(
  title: string,
  to: BillingSourceKind | string,
  wait: Pick<CredentialWait, "reason" | "kind" | "stop">,
  until: string | null,
): string {
  return `"${title}" goes on with ${yourCredential(to)} from where it stopped: ${shortStoppedPhrase(wait, until)}.`;
}

/**
 * C5-left-1 (CE-11): the session log's line of a run that went to another credential: the run
 * that goes on with a task its credential stopped reads `switchLogLine`; a task that starts on
 * it reads '"B" runs on your API key: your subscription is at its limit until 15:40.'. After the
 * person's yes for this stop (the ask card, the Start dialog's Use API key) the line says so:
 * '..., and you said yes.' (C5's review: before, the log never said why the work ran on the key).
 */
export function switchRunLine(
  title: string,
  sw: {
    to: BillingSourceKind | string;
    from: BillingSourceKind;
    stop: "limit" | "refused" | "share" | "key_month";
    by: "policy" | "grant";
  },
  until: string | null,
  continues: boolean,
): string {
  const wait = { reason: sw.stop, kind: sw.from } as const;
  const line = continues
    ? switchLogLine(title, sw.to, wait, until)
    : `"${title}" runs on ${yourCredential(sw.to)}: ${shortStoppedPhrase(wait, until)}.`;
  return sw.by === "grant" ? `${line.slice(0, -1)}, and you said yes.` : line;
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
  // d1109-cred-screens (C5-left-2): "less than CHF 0.01" stands alone, as in chat's one-off line.
  const est = /^less than /.test(input.estimateChf)
    ? input.estimateChf
    : `about ${input.estimateChf}`;
  return {
    title: `${input.projectName}: work goes on with your API key`,
    body: `${stoppedPhrase(input.wait, input.until)}. Your API key costs money: ${est} for what is left.`,
  };
}

// ── CE-9: chat ───────────────────────────────────────────────────────────────────────────────

/**
 * The reply of a chat question the policy holds (no model call, no ledger row). l4-cred-engine
 * L4-creds-8: by the stop's reason, and never a promise to start work (before, every stop ended
 * "I can still add, move and start tasks." while the Start dialog refused a start): a refusal
 * says what to do in Settings; a limit, the share or a monthly cap says what chat still does.
 */
export function chatHoldReply(
  wait: Pick<CredentialWait, "reason" | "kind" | "stop">,
  until: string | null,
  /**
   * l4-starts-carried (L4a-left-5): when a Start of the chat's project now is kept for the
   * reset ("at 15:40", the Start dialog's and chat's own start keep it): the reply says so
   * ("...; a Start now runs at 15:40."). Absent: a Start now would not be kept (nothing would
   * run, a session or a kept start already waits, no project).
   */
  startsWhen?: string | null,
): string {
  const reason = wait.reason === "needs" ? (wait.stop ?? "limit") : wait.reason;
  if (reason === "refused")
    return `${stoppedPhrase(wait, until)}, so I have not answered. ${
      wait.kind === "subscription" ? "Sign in again in Settings" : "Save a new key in Settings"
    }; until then I can still add and change tasks.`;
  const start = startsWhen ? `; a Start now runs ${startsWhen}` : "";
  return `${stoppedPhrase(wait, until)}, so I have not answered. I can still add and change tasks${start}.`;
}

/** The one-off press's consequence line: "Answers this question on your API key: about CHF 0.02." */
export function chatOneOffExplain(to: BillingSourceKind | string, estimateChf: string): string {
  // d1109-cred-screens: "less than CHF 0.01" stands alone ("about less than" says nothing more).
  const est = /^less than /.test(estimateChf) ? estimateChf : `about ${estimateChf}`;
  return `Answers this question on ${yourCredential(to)}: ${est}.`;
}

/** The note under an answer another credential gave: once per stop per conversation. */
export function chatSwitchNote(
  to: BillingSourceKind | string,
  wait: Pick<CredentialWait, "reason" | "kind" | "stop">,
  until: string | null,
): string {
  return `Answered with ${yourCredential(to)}: ${shortStoppedPhrase(wait, until)}.`;
}

// ── CE-6 (l4-cred-engine L4-creds-1): a raised allowance ends the share's stop ─────────────────

/**
 * The line Settings shows after the person raised the subscription's allowance and the share's
 * stop ended: their session that waited goes on now (or at the end of their quiet hours), or the
 * tasks that waited are ready for their next Start. Null when nothing waited for the share.
 */
export function allowanceRaisedLine(
  input:
    | { session: { startedAt: string | null }; quietUntil: string | null }
    | { readyTasks: number },
  words: { timezone?: string; nowMs: number },
): string | null {
  const head = "Your subscription's allowance is raised";
  if ("session" in input) {
    const of = input.session.startedAt
      ? ` of ${clockTime(input.session.startedAt, words.timezone, words.nowMs)}`
      : "";
    return input.quietUntil
      ? `${head}: your session${of} goes on at ${clockTime(input.quietUntil, words.timezone, words.nowMs)}, after your quiet hours.`
      : `${head}: your session${of} goes on now.`;
  }
  if (input.readyTasks <= 0) return null;
  return `${head}: ${input.readyTasks === 1 ? "1 task is" : `${input.readyTasks} tasks are`} ready again for your next Start.`;
}

// ── CE-13: the setting ───────────────────────────────────────────────────────────────────────

/** settings.set billing_order or mid_session_limit (and their Undo) once the policy is stored. */
export const LEGACY_SETTING_REPLACED =
  'This was replaced by "Which Claude does the work"; change it there.';
