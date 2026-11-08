import type { BillingSourceKind } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { HumanRequestRow, StateStore } from "@forerunner/state";

/**
 * Work that waits for a Claude credential (U-078, ADR 0100 amended 2026-11-03, the owner's
 * decision of 2026-11-02 "refused-key detection and one card; wait at a limit with the reset
 * time and start by itself; honest words"): what the router's "no source" says about the wait,
 * the words every screen uses for it, and the one Inbox card per refused credential.
 *
 * - **At a limit.** The credential rests until its reset; the task is no failure: it goes back
 *   to ready without counting a try, and the session ends with one sentence ("Waits until 15:40
 *   (your subscription's limit) and starts by itself."), its row says the same, and a session of
 *   the project starts by itself at the reset (`limits.waiting` on the source, after a restart
 *   too).
 * - **Refused.** Anthropic refused the key or the sign-in (a 401 or 403): the credential is
 *   marked (`limits.refusedAt`), one card names it, the router skips it, and work no other
 *   credential may take waits for a new one ("Waits for a new API key: save one in Settings."),
 *   which starts it by itself once saved.
 */

/** Why the work waits. */
export interface CredentialWait {
  /** `limit`: until the credential's reset; `refused`: until a new credential is saved. */
  reason: "limit" | "refused";
  /** The billing source the work waits for. */
  sourceId: string;
  kind: BillingSourceKind;
  /** `limit`: when the credential may serve again (ISO); null for `refused`. */
  until: string | null;
}

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
  const w = d.waitFor as (SkipLike & { reason?: unknown }) | undefined;
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
 * The wait as one sentence (the session result, the log, the Overview): "Waits until 15:40 (your
 * subscription's limit) and starts by itself." or "Waits for a new API key: save one in
 * Settings." With `title`, the task is named: '"Write the notes" waits until ...'.
 */
export function waitSentence(
  wait: CredentialWait,
  opts: { timezone?: string; nowMs: number; title?: string },
): string {
  const who = opts.title ? `"${opts.title}" waits` : "Waits";
  if (wait.reason === "refused")
    return `${who} for ${newCredential(wait.kind)}: save one in Settings.`;
  const at = wait.until ? clockTime(wait.until, opts.timezone, opts.nowMs) : "its reset";
  return `${who} until ${at} (${limitOf(wait.kind)}) and starts by itself.`;
}

/**
 * A waiting task's row (design §2: a status, then one line of why): label and detail, with what
 * the project's status sentence says of the waiting tasks (`line`: "Waiting for a new API key",
 * "Waiting until 15:40 (your subscription's limit)") and the link that unblocks a refusal.
 */
export function waitRowWords(
  wait: CredentialWait,
  opts: { timezone?: string; nowMs: number },
): CredentialWaitWords {
  if (wait.reason === "refused")
    return {
      label: `Waits for ${newCredential(wait.kind)}`,
      detail: "Save one in Settings; it starts by itself then.",
      line: `Waiting for ${newCredential(wait.kind)}`,
      save: saveLink(wait.kind),
    };
  const at = wait.until ? clockTime(wait.until, opts.timezone, opts.nowMs) : "its reset";
  return {
    label: `Waits until ${at}, ${limitOf(wait.kind)}`,
    detail: "It starts by itself then.",
    line: `Waiting until ${at} (${limitOf(wait.kind)})`,
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
  wait: CredentialWait,
  opts: { timezone?: string; nowMs: number },
): { text: string; short: string } {
  if (wait.reason === "refused")
    return {
      text: `Planning waits for ${newCredential(wait.kind)}: save one in Settings.`,
      short: `Planning waits for ${newCredential(wait.kind)}`,
    };
  const at = wait.until ? clockTime(wait.until, opts.timezone, opts.nowMs) : "its reset";
  return {
    text: `Planning waits until ${at} (${limitOf(wait.kind)}) and starts by itself.`,
    short: `Planning waits until ${at}, ${limitOf(wait.kind)}`,
  };
}

/** A credential wait read back from stored JSON (`summary_cache.intake.wait`), or null. */
export function credentialWaitFrom(value: unknown): CredentialWait | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.reason !== "limit" && v.reason !== "refused") return null;
  if (typeof v.sourceId !== "string" || typeof v.kind !== "string") return null;
  return {
    reason: v.reason,
    sourceId: v.sourceId,
    kind: v.kind as BillingSourceKind,
    until: typeof v.until === "string" ? v.until : null,
  };
}

/**
 * The session log's sentence after a credential stopped a run (U-078, design §5.9: no promise
 * the code does not keep): what happened, then what comes of the task, agreeing with what is
 * scheduled. `next` is the credential that takes over now, or the wait.
 */
export function stoppedRunSentence(
  stop: { reason: "limit" | "refused"; kind: BillingSourceKind | string },
  title: string,
  next: { continuesOn: BillingSourceKind | string } | { wait: CredentialWait },
  opts: { timezone?: string; nowMs: number },
): string {
  const head =
    stop.reason === "refused"
      ? `Anthropic refused ${yourCredential(stop.kind).replace("your Claude subscription", "your Claude sign-in")}`
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
