import type { BillingSourceKind } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { HumanRequestRow, HumanRow, StateStore } from "@forerunner/state";
import { quietHoursEndAt, resolvePrefs } from "../notifications/prefs.ts";

/**
 * Work that waits for a Claude credential (U-078, ADR 0100 amended 2026-11-03, the owner's
 * decision of 2026-11-02 "refused-key detection and one card; wait at a limit with the reset
 * time and start by itself; honest words"): what the router's "no source" says about the wait,
 * the words every screen uses for it, and the one Inbox card per refused credential.
 *
 * - **At a limit.** The credential rests until its reset; the task is no failure: it goes back
 *   to ready without counting a try, and the session ends with one sentence ("Waits until 15:40
 *   (your subscription's limit); then your session goes on."), its row says the same, and the
 *   person's session goes on once at the reset (`limits.waiting[].kept` on the source, after a
 *   restart too; S-10, ADR 0118). Work outside a session the person started waits for their
 *   next Start ("; then it runs at your next Start.").
 * - **Refused.** Anthropic refused the key or the sign-in (a 401 or 403): the credential is
 *   marked (`limits.refusedAt`), one card names it, the router skips it, and work no other
 *   credential may take waits for a new one ("Waits for a new API key: save one in Settings."):
 *   the person's session goes on once one is saved; other work waits for their next Start.
 */

/** Why the work waits. */
export interface CredentialWait {
  /**
   * `limit`: until the credential's reset; `refused`: until a new credential is saved; `share`:
   * the subscription reached the share Forerunner may use (until the next month's start, or a
   * raised allowance); `key_month`: an API key reached its monthly cap (until the next month);
   * `needs`: only a credential that cannot serve now (or that the person's policy leaves out)
   * can do the task here (CE-3; `stop` names what stopped it, absent when the policy leaves it
   * out).
   */
  reason: "limit" | "refused" | "share" | "key_month" | "needs";
  /** The billing source the work waits for ("" for `needs` when the policy leaves it out). */
  sourceId: string;
  kind: BillingSourceKind;
  /** When the credential may serve again (ISO); null for `refused` (and a `needs` with no end). */
  until: string | null;
  /** CE-2: the stop's key (one ask card and one grant per stop). */
  stopKey?: string;
  /** CE-7: the person's policy asks first: one card for this stop. */
  ask?: boolean;
  /** `needs`: what stopped the credential that can do the task. */
  stop?: "limit" | "refused" | "share" | "key_month";
}

const WAIT_REASONS: readonly string[] = ["limit", "refused", "share", "key_month", "needs"];
const STOPS: readonly string[] = ["limit", "refused", "share", "key_month"];

/** The session's stop reason when nothing it may run can be billed now. */
export const CREDENTIAL_WAIT_STOP = "credential_wait";

/**
 * The reason a task that waits for a Claude credential is given back with (U-078; the leftovers
 * of wave 7): its row alone reads "Waits until …" (`taskDisplay`), not every ready task of the
 * project, since under "Wait" only the tasks whose first choice cannot serve wait (ADR 0100
 * point 10) and the others run.
 */
export const CREDENTIAL_WAIT_REASON = "waits for a Claude credential: back to ready";

/** The Inbox card of a refused credential (one per credential, filed once). */
export const CREDENTIAL_REFUSED_KEY = "credential:refused";

/** The audit row a refusal writes. */
export const BILLING_REFUSED_AUDIT_TOOL = "billing.refused";

interface SkipLike {
  sourceId?: unknown;
  kind?: unknown;
  code?: unknown;
  until?: unknown;
}

/**
 * The wait a router's "no source" (`unavailable`) means, or null when it is no wait (nothing is
 * saved at all, a source turned off): the first choice the 'wait' rule holds to
 * (`details.waitFor`), else the earliest reset among resting sources, else a refused source.
 */
export function credentialWaitOf(error: unknown): CredentialWait | null {
  if (!(error instanceof ForerunnerError) || error.code !== "unavailable") return null;
  const d = (error.details ?? {}) as { waitFor?: SkipLike; skipped?: SkipLike[] };
  const w = d.waitFor as
    | (SkipLike & { reason?: unknown; stopKey?: unknown; ask?: unknown; stop?: unknown })
    | undefined;
  // CE-2: the router's wait names its reason, the stop's key and whether the person is asked.
  if (w && typeof w.sourceId === "string" && WAIT_REASONS.includes(String(w.reason)))
    return {
      reason: w.reason as CredentialWait["reason"],
      sourceId: w.sourceId,
      kind: (w.kind as BillingSourceKind) ?? "api_key",
      until: typeof w.until === "string" ? w.until : null,
      ...(typeof w.stopKey === "string" ? { stopKey: w.stopKey } : {}),
      ...(w.ask === true ? { ask: true } : {}),
      ...(STOPS.includes(String(w.stop)) ? { stop: w.stop as CredentialWait["stop"] } : {}),
    };
  if (w && typeof w.sourceId === "string" && typeof w.until === "string")
    return {
      reason: "limit",
      sourceId: w.sourceId,
      kind: (w.kind as BillingSourceKind) ?? "api_key",
      until: w.until,
    };
  // 'Wait' held to a refused first choice (U-078): the work waits for a new credential.
  if (w && typeof w.sourceId === "string" && w.reason === "refused")
    return {
      reason: "refused",
      sourceId: w.sourceId,
      kind: (w.kind as BillingSourceKind) ?? "api_key",
      until: null,
    };
  const skipped = Array.isArray(d.skipped) ? d.skipped : [];
  const resting = skipped
    .filter((s) => s.code === "cooldown" && typeof s.until === "string")
    .sort((a, b) => String(a.until).localeCompare(String(b.until)))[0];
  if (resting && typeof resting.sourceId === "string")
    return {
      reason: "limit",
      sourceId: resting.sourceId,
      kind: (resting.kind as BillingSourceKind) ?? "api_key",
      until: String(resting.until),
    };
  const refused = skipped.find((s) => s.code === "refused" && typeof s.sourceId === "string");
  if (refused)
    return {
      reason: "refused",
      sourceId: String(refused.sourceId),
      kind: (refused.kind as BillingSourceKind) ?? "api_key",
      until: null,
    };
  return null;
}

/** "your subscription", "your API key": a credential as the person owns it. */
export function yourCredential(kind: BillingSourceKind | string): string {
  switch (kind) {
    case "subscription":
      return "your Claude subscription";
    case "plan_credits":
      return "your plan credits";
    default:
      return "your API key";
  }
}

/** "your subscription's limit", "your API key's limit". */
function limitOf(kind: BillingSourceKind | string): string {
  switch (kind) {
    case "subscription":
      return "your subscription's limit";
    case "plan_credits":
      return "your plan credits' limit";
    default:
      return "your API key's limit";
  }
}

/**
 * CE-2: the stop a wait names, in the words after its time: "your subscription's limit", "your
 * subscription's allowance" (the share Forerunner may use), "your API key's monthly cap".
 */
function stopWordsOf(wait: Pick<CredentialWait, "reason" | "kind" | "stop">): string {
  const r = wait.reason === "needs" ? wait.stop : wait.reason;
  if (r === "share") return "your subscription's allowance";
  if (r === "key_month") return `${yourCredential(wait.kind)}'s monthly cap`;
  return limitOf(wait.kind);
}

/**
 * A `needs` wait read as the stop that holds it (CE-3): the credential that can do the task is
 * stopped, so the words are that stop's; a `needs` wait the policy alone makes stays as it is.
 */
export function asStopWait(wait: CredentialWait): CredentialWait {
  return wait.reason === "needs" && wait.stop ? { ...wait, reason: wait.stop } : wait;
}

/** The stop a wait names, as the session log's stopped-run sentence reads it. */
export function stopReasonOf(wait: CredentialWait): "limit" | "refused" | "share" {
  const w = asStopWait(wait);
  return w.reason === "refused" || w.reason === "share" ? w.reason : "limit";
}

/**
 * CE-3: the task only a credential the person's policy leaves out can do here: "Only your Claude
 * subscription can do this task here, and "Which Claude does the work" leaves it out."
 */
function leftOutSentence(wait: CredentialWait, title?: string): string {
  const who = title ? `"${title}" waits` : "Waits";
  return `${who}: only ${yourCredential(wait.kind)} can do it here, and "Which Claude does the work" in Settings leaves it out.`;
}

/** What a refused credential's replacement is called: "a new API key", "a new Claude sign-in". */
function newCredential(kind: BillingSourceKind | string): string {
  return kind === "subscription" ? "a new Claude sign-in" : "a new API key";
}

/**
 * A reset time as a person reads it in their time zone: "15:40" today, "Wed 4 Nov, 15:40" on
 * another day (design §5: plain words, no UTC or ISO).
 */
export function clockTime(iso: string, timezone: string | undefined, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "later";
  const zone = validZone(timezone);
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(t));
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  if (day(t) === day(nowMs)) return hm;
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(t));
  return `${date.replace(",", "")}, ${hm}`;
}

function validZone(timezone: string | undefined): string {
  if (!timezone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

/**
 * What comes after a wait (d1109-starts-engine S-10, S-12; ADR 0118): the person's own session
 * goes on by itself when it waits for its credential (`goesOn`: a continuation or a person start
 * is kept), else the work waits for the person's next Start (a stop's end only prepares it).
 */
export function afterWaitClause(goesOn: boolean | undefined): string {
  return goesOn ? "then your session goes on" : "then it runs at your next Start";
}

/**
 * S-10 (ADR 0118): when the person's waiting session goes on, if their quiet hours hold it past
 * the stop's end (a continuation starts with nobody pressing anything, so quiet hours hold it):
 * the end of the quiet hours, as an ISO time; undefined when it goes on at the stop's end. Every
 * sentence that says when it goes on names this later time (`goesOnAt`).
 */
export function continuationGoesOnAt(
  human: Pick<HumanRow, "timezone" | "email" | "notify_prefs"> | null | undefined,
  until: string | null | undefined,
): string | undefined {
  if (!human || !until) return undefined;
  const at = Date.parse(until);
  if (!Number.isFinite(at)) return undefined;
  const prefs = resolvePrefs(human);
  return quietHoursEndAt(prefs.quiet_hours, prefs.timezone, at) ?? undefined;
}

/** `continuationGoesOnAt` as the words' option: `{ goesOnAt }`, or nothing when not later. */
export function goesOnAtWords(
  human: Pick<HumanRow, "timezone" | "email" | "notify_prefs"> | null | undefined,
  until: string | null | undefined,
): { goesOnAt?: string } {
  const at = continuationGoesOnAt(human, until);
  return at ? { goesOnAt: at } : {};
}

/**
 * The wait as one sentence (the session result, the log, the Overview): "Waits until 15:40 (your
 * subscription's limit); then your session goes on." (the person's session waits to go on, S-10)
 * or "...; then it runs at your next Start.", or "Waits for a new API key: save one in
 * Settings." With `title`, the task is named: '"Write the notes" waits until ...'. With
 * `goesOnAt` (the end of the person's quiet hours, later than the reset) the time is that one:
 * "Waits until 07:00 (after your quiet hours); then your session goes on.".
 */
export function waitSentence(
  given: CredentialWait,
  opts: { timezone?: string; nowMs: number; title?: string; goesOn?: boolean; goesOnAt?: string },
): string {
  const wait = asStopWait(given);
  if (wait.reason === "needs") return leftOutSentence(wait, opts.title);
  const who = opts.title ? `"${opts.title}" waits` : "Waits";
  // CE-7: under 'ask' the work waits for the person's answer on the one card.
  if (wait.ask && wait.reason !== "refused")
    return `${who} for your answer: use ${otherCredentialOf(wait.kind)}? The card is in the Inbox.`;
  if (wait.reason === "refused")
    return `${who} for ${newCredential(wait.kind)}: save one in Settings${opts.goesOn ? `; ${afterWaitClause(true)}` : ""}.`;
  if (opts.goesOn && opts.goesOnAt)
    return `${who} until ${clockTime(opts.goesOnAt, opts.timezone, opts.nowMs)} (after your quiet hours); ${afterWaitClause(true)}.`;
  const at = wait.until ? clockTime(wait.until, opts.timezone, opts.nowMs) : "its reset";
  return `${who} until ${at} (${stopWordsOf(wait)}); ${afterWaitClause(opts.goesOn)}.`;
}

/**
 * The Start check's sentence for work that waits for a credential's reset while no Start has
 * kept that wait yet (leftovers7-tailrun TR-2): looking at the check records nothing, so the
 * sentence says what Start does ("Nothing can run until 15:40 (your subscription's limit).
 * Press Start and the work starts then."; W15-65: before, "... and it runs then.", with no
 * thing for "it"), and Start keeps the wait so the work starts at the reset.
 */
export function startKeepsWaitSentence(
  wait: CredentialWait,
  opts: { timezone?: string; nowMs: number },
): string {
  const at = wait.until ? clockTime(wait.until, opts.timezone, opts.nowMs) : "its reset";
  return `Nothing can run until ${at} (${stopWordsOf(wait)}). ${PRESS_START_THEN}`;
}

const PRESS_START_THEN = "Press Start and the work starts then.";

/**
 * S-10 (ADR 0118): a Start the person pressed while the credential was out, kept for its reset,
 * as the project's status says it: "Starts at 15:40 (your subscription's limit)". Null for a
 * refusal or a reset not known.
 */
export function keptStartLine(
  wait: CredentialWait,
  opts: { timezone?: string; nowMs: number },
): string | null {
  if (wait.reason === "refused" || wait.reason === "needs" || !wait.until) return null;
  return `Starts at ${clockTime(wait.until, opts.timezone, opts.nowMs)} (${stopWordsOf(wait)})`;
}

/**
 * W15-66: the wait where none is recorded (the credential chooser's runs-on line on New task,
 * the plan card and Settings): creating a task keeps no wait, so nothing starts by itself; a
 * Start keeps it (TR-2). "Waits until 15:40 (your subscription's limit). Press Start and the
 * work starts then." A refusal: "Waits for a new API key: save one in Settings." (as
 * `waitSentence`). Before, the line said "... and starts by itself.".
 */
export function waitThenStartSentence(
  wait: CredentialWait,
  opts: { timezone?: string; nowMs: number },
): string {
  const w = asStopWait(wait);
  if (w.reason === "refused" || w.reason === "needs") return waitSentence(w, opts);
  const at = w.until ? clockTime(w.until, opts.timezone, opts.nowMs) : "its reset";
  return `Waits until ${at} (${stopWordsOf(w)}). ${PRESS_START_THEN}`;
}

/**
 * W15-78: the Start check's refusal while a wait is kept or a credential was refused, as one
 * sentence with a subject, from the wait's own sentence (`waitSentence`, untitled): "Nothing can
 * run until 15:40 (your subscription's limit); it starts by itself then." or "Nothing can run
 * until you save a new API key in Settings." Before: "Nothing can run yet. Waits until ...".
 */
export function nothingRunsYetSentence(waitText: string): string {
  const until = /^Waits (until .+?); (then .+)\.$/.exec(waitText.trim());
  if (until) return `Nothing can run ${until[1]}; ${until[2]}.`;
  const saved = /^Waits for (.+?): save one in Settings(?:; .+)?\.$/.exec(waitText.trim());
  if (saved) return `Nothing can run until you save ${saved[1]} in Settings.`;
  return `Nothing can run yet. ${waitText}`;
}

/**
 * W15-67: the wait in a few words after "Ready: 1 task; ", from the Start check's sentence
 * (`startKeepsWaitSentence`, `waitSentence`, both untitled): "nothing runs until 09:30 (your API
 * key's limit)", "your session goes on at 09:30 (your API key's limit)", "nothing runs until you
 * save a new API key".
 */
export function waitHeadWords(waitText: string): string {
  const t = waitText.trim();
  const start = /^Nothing can run (until .+?)\. Press Start/.exec(t);
  if (start) return `nothing runs ${start[1]}`;
  const goesOn = /^Waits until (.+); then your session goes on\.$/.exec(t);
  if (goesOn) return `your session goes on at ${goesOn[1]}`;
  const kept = /^Waits (until .+); then it runs at your next Start\.$/.exec(t);
  if (kept) return `nothing runs ${kept[1]}`;
  const saved = /^Waits for (.+?): save one in Settings(?:; .+)?\.$/.exec(t);
  if (saved) return `nothing runs until you save ${saved[1]}`;
  return "it waits for a Claude credential";
}

/**
 * W15-78: what Anthropic refused, as the person set it up: "your API key", "your subscription
 * sign-in", or "your key or sign-in" when the run does not say which (before: "the credential",
 * the code's word).
 */
export function refusedCredentialWords(kind: string | null | undefined): string {
  if (kind === "api_key") return "your API key";
  if (kind === "subscription") return "your subscription sign-in";
  return "your key or sign-in";
}

/**
 * A waiting task's row (design §2: a status, then one line of why): label and detail, with what
 * the project's status sentence says of the waiting tasks (`line`: "Waiting for a new API key",
 * "Waiting until 15:40 (your subscription's limit)") and the link that unblocks a refusal.
 */
export function waitRowWords(
  given: CredentialWait,
  opts: {
    timezone?: string;
    nowMs: number;
    goesOn?: boolean;
    goesOnAt?: string;
    /** S-10: a Start the person pressed is kept for the reset: the status says it starts then. */
    startKept?: boolean;
  },
): CredentialWaitWords {
  const wait = asStopWait(given);
  // CE-7: under 'ask' the row says the work waits for the person's answer on the one card.
  if (wait.ask && wait.reason !== "refused")
    return {
      label: `Waits for your answer: use ${otherCredentialOf(wait.kind)}?`,
      detail: "Answer the card in the Inbox.",
      line: "Waiting for your answer",
      save: null,
    };
  if (wait.reason === "needs")
    return {
      label: `Waits for ${yourCredential(wait.kind)}`,
      detail: leftOutSentence(wait)
        .replace(/^Waits: /, "")
        .replace(/^o/, "O"),
      line: `Waiting for ${yourCredential(wait.kind)}`,
      save: null,
    };
  if (wait.reason === "refused")
    return {
      label: `Waits for ${newCredential(wait.kind)}`,
      detail: `Save one in Settings; ${afterWaitClause(opts.goesOn)}.`,
      line: `Waiting for ${newCredential(wait.kind)}`,
      save: saveLink(wait.kind),
    };
  // S-10: the person's waiting session goes on when their quiet hours end, later than the reset.
  if (opts.goesOn && opts.goesOnAt) {
    const later = clockTime(opts.goesOnAt, opts.timezone, opts.nowMs);
    return {
      label: `Waits until ${later}, after your quiet hours`,
      detail: "Then your session goes on.",
      line: `Waiting until ${later} (after your quiet hours)`,
      save: null,
    };
  }
  const at = wait.until ? clockTime(wait.until, opts.timezone, opts.nowMs) : "its reset";
  return {
    label: `Waits until ${at}, ${stopWordsOf(wait)}`,
    detail: opts.goesOn ? "Then your session goes on." : "Then it runs at your next Start.",
    // S-10: "Starts at 15:40 (your subscription's limit)" while the person's Start is kept.
    line:
      (opts.startKept ? keptStartLine(wait, opts) : null) ??
      `Waiting until ${at} (${stopWordsOf(wait)})`,
    save: null,
  };
}

/** A credential wait in the words of a task row and of the project's status sentence. */
export interface CredentialWaitWords {
  label: string;
  detail: string;
  /** The status sentence's head; the count of waiting tasks follows it ("…: 2 tasks"). */
  line: string;
  /** Where a refused credential's replacement is saved (null at a limit: nothing to do). */
  save: { label: string; to: string } | null;
}

/** The refused card's link and the status sentence's: where a new key or sign-in is saved. */
export function saveLink(kind: BillingSourceKind | string): { label: string; to: string } {
  return {
    label: kind === "subscription" ? "Save a new sign-in" : "Save a new key",
    to: "/setup",
  };
}

/**
 * The plan from the brief waits for a credential (U-078, the review of credential-limits):
 * planning that meets a refusal or a limit is no failure. `text` is the project page's sentence
 * ("Planning waits for a new API key: save one in Settings.", "Planning waits until 15:40 (your
 * subscription's limit) and starts by itself."), `short` the status sentence's ("Planning
 * waits for a new API key", "Planning waits until 15:40, your subscription's limit"). The plan
 * is drafted by itself once the credential serves (`RuntimeApp.billing.waits`).
 */
export function planWaitWords(
  given: CredentialWait,
  opts: { timezone?: string; nowMs: number },
): { text: string; short: string } {
  const wait = asStopWait(given);
  // CE-7: under 'ask' the plan waits for the person's answer on the one card.
  if (wait.ask && wait.reason !== "refused")
    return {
      text: `Planning waits for your answer: use ${otherCredentialOf(wait.kind)}? The card is in the Inbox.`,
      short: "Planning waits for your answer",
    };
  if (wait.reason === "needs")
    return {
      text: `Planning ${leftOutSentence(wait).replace(/^Waits/, "waits")}`,
      short: `Planning waits for ${yourCredential(wait.kind)}`,
    };
  if (wait.reason === "refused")
    return {
      text: `Planning waits for ${newCredential(wait.kind)}: save one in Settings.`,
      short: `Planning waits for ${newCredential(wait.kind)}`,
    };
  const at = wait.until ? clockTime(wait.until, opts.timezone, opts.nowMs) : "its reset";
  return {
    text: `Planning waits until ${at} (${stopWordsOf(wait)}) and starts by itself.`,
    short: `Planning waits until ${at}, ${stopWordsOf(wait)}`,
  };
}

/** A credential wait read back from stored JSON (`summary_cache.intake.wait`), or null. */
export function credentialWaitFrom(value: unknown): CredentialWait | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!WAIT_REASONS.includes(String(v.reason))) return null;
  if (typeof v.sourceId !== "string" || typeof v.kind !== "string") return null;
  return {
    reason: v.reason as CredentialWait["reason"],
    sourceId: v.sourceId,
    kind: v.kind as BillingSourceKind,
    until: typeof v.until === "string" ? v.until : null,
    ...(typeof v.stopKey === "string" ? { stopKey: v.stopKey } : {}),
    ...(v.ask === true ? { ask: true } : {}),
    ...(STOPS.includes(String(v.stop)) ? { stop: v.stop as CredentialWait["stop"] } : {}),
  };
}

/** The credential the person is asked to go on with: "your API key" for a subscription's stop. */
export function otherCredentialOf(kind: BillingSourceKind | string): string {
  return kind === "subscription" ? "your API key" : "your Claude subscription";
}

/**
 * The session log's sentence after a credential stopped a run (U-078, design §5.9: no promise
 * the code does not keep): what happened, then what comes of the task, agreeing with what is
 * scheduled. `next` is the credential that takes over now, or the wait.
 */
export function stoppedRunSentence(
  stop: { reason: "limit" | "refused" | "share"; kind: BillingSourceKind | string },
  title: string,
  next: { continuesOn: BillingSourceKind | string } | { wait: CredentialWait },
  opts: { timezone?: string; nowMs: number; goesOn?: boolean },
): string {
  const head =
    stop.reason === "refused"
      ? `Anthropic refused ${yourCredential(stop.kind).replace("your Claude subscription", "your Claude sign-in")}`
      : stop.reason === "share"
        ? `${capital(yourCredential(stop.kind))} reached the share Forerunner may use`
        : `${capital(yourCredential(stop.kind))} reached its usage limit`;
  const then =
    "wait" in next
      ? waitSentence(next.wait, { ...opts, title })
      : `"${title}" continues on ${yourCredential(next.continuesOn)} now.`;
  return `${head}; ${then}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The refused card's title: "Anthropic refused your API key". */
export function refusedCardTitle(kind: BillingSourceKind | string): string {
  return kind === "subscription"
    ? "Anthropic refused your Claude sign-in"
    : "Anthropic refused your API key";
}

/**
 * One Inbox card per refused credential (U-078): filed once while the mark stands (an open card
 * for the same source is kept), with no task: the work waits on the credential, not on the
 * person's decision about it. Saving a new credential closes it (`closeRefusedCards`).
 */
export async function fileRefusedCard(
  store: Pick<StateStore, "humanRequest">,
  input: { humanId: string; agentId: string | null; sourceId: string; kind: BillingSourceKind },
): Promise<{ request: HumanRequestRow; reused: boolean }> {
  const open = await openRefusedCards(store, input.humanId);
  const same = open.find(
    (r) => (r.change_card as { source_id?: unknown }).source_id === input.sourceId,
  );
  if (same) return { request: same, reused: true };
  const title = refusedCardTitle(input.kind);
  const request = await store.humanRequest.insert({
    human_id: input.humanId,
    project_id: null,
    task_id: null,
    session_id: null,
    kind: "info",
    why: `${title}. Save a new one in Settings.`,
    steps: [],
    options: [],
    blocking: true,
    risk: "low",
    change_card: {
      key: CREDENTIAL_REFUSED_KEY,
      source_id: input.sourceId,
      credential_kind: input.kind,
      title,
      applied_at: null,
    },
    author_agent: input.agentId,
  });
  return { request, reused: false };
}

/** The open refused-credential cards of the person. */
export async function openRefusedCards(
  store: Pick<StateStore, "humanRequest">,
  humanId: string,
): Promise<HumanRequestRow[]> {
  const open = await store.humanRequest.open({ humanId }, { limit: 500 });
  return open.filter(
    (r) => (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_REFUSED_KEY,
  );
}

/** Closes the refused card of a source whose new credential was saved (or every source's). */
export async function closeRefusedCards(
  store: Pick<StateStore, "humanRequest">,
  humanId: string,
  sourceId?: string,
): Promise<number> {
  let closed = 0;
  for (const r of await openRefusedCards(store, humanId)) {
    const card = r.change_card as { source_id?: unknown };
    if (sourceId && card.source_id !== sourceId) continue;
    await store.humanRequest.withdraw(r.id, r.version).catch(() => undefined);
    closed++;
  }
  return closed;
}
