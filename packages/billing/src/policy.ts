/**
 * The person's credential policy (U-078, D5, ADR 0120): which of their Claude credentials does
 * the work, and what happens when the first one stops (its usage limit, the share of the
 * subscription Forerunner may use, an API key's monthly cap, or Anthropic refusing it). One
 * policy for every call: task runs, the critic's reviews, planning, the task check, chat and the
 * background jobs (the owner's answer 4 of 2026-11-09: "it should use the order that the user
 * specifies ... There should be a nice clean options menu.").
 *
 * Five presets, stored as `human.notify_prefs.credential_policy`. Until the person picks one, an
 * earlier choice of the two older settings (`billing_order`, `mid_session_limit`) is read as the
 * policy, derived at every read so nothing a person chose changes; with nothing chosen, the
 * default preset (subscription first, then wait) applies to every call.
 */
import type { BillingSourceKind, BillingSourceLimits, BillingSourceStatus } from "./sources.ts";

/** The presets, in the order a person reads them (least money first). */
export const CREDENTIAL_POLICIES = [
  "subscription_then_wait",
  "subscription_then_ask",
  "subscription_then_key",
  "key_then_subscription",
  "key_only",
] as const;

export type CredentialPolicyId = (typeof CREDENTIAL_POLICIES)[number];

/** The setting's key in `human.notify_prefs`. */
export const CREDENTIAL_POLICY_SETTING = "credential_policy";

/** The preset of a person who never chose (the owner's default of 2026-11-02, answer 4). */
export const DEFAULT_CREDENTIAL_POLICY: CredentialPolicyId = "subscription_then_wait";

/** The older settings the policy replaces, read only to derive an earlier choice. */
export const LEGACY_ORDER_SETTING = "billing_order";
export const LEGACY_MID_SESSION_SETTING = "mid_session_limit";

/**
 * What happens when the first credential stops: `next` goes on with the next one at once, `ask`
 * files one card per stop (Use API key / Wait) and waits for the answer, `wait` moves nothing
 * until the stop ends.
 */
export type WhenStopped = "next" | "ask" | "wait";

export interface CredentialRule {
  /** The kinds in the order they are used, first used first. */
  order: readonly BillingSourceKind[];
  whenStopped: WhenStopped;
  /** The kinds the policy lets serve at all (key_only leaves the subscription out). */
  kinds: readonly BillingSourceKind[];
}

export interface CredentialPolicy {
  /** The preset, or `earlier` for an earlier choice no preset matches (an API-key-first order + wait). */
  id: CredentialPolicyId | "earlier";
  /**
   * `stored`: the person picked the preset; `derived`: read from their earlier settings;
   * `default`: nothing chosen (Settings says it is used until they pick).
   */
  chosen: "stored" | "derived" | "default";
  rule: CredentialRule;
}

const SUBSCRIPTION_FIRST: readonly BillingSourceKind[] = Object.freeze([
  "subscription",
  "plan_credits",
  "api_key",
]);
const KEY_FIRST: readonly BillingSourceKind[] = Object.freeze([
  "api_key",
  "plan_credits",
  "subscription",
]);
const KEY_KINDS: readonly BillingSourceKind[] = Object.freeze(["api_key", "plan_credits"]);

/** Each preset's order, its rule at a stop and the kinds it lets serve. */
export function ruleOf(id: CredentialPolicyId): CredentialRule {
  switch (id) {
    case "subscription_then_wait":
      return { order: SUBSCRIPTION_FIRST, whenStopped: "wait", kinds: SUBSCRIPTION_FIRST };
    case "subscription_then_ask":
      return { order: SUBSCRIPTION_FIRST, whenStopped: "ask", kinds: SUBSCRIPTION_FIRST };
    case "subscription_then_key":
      return { order: SUBSCRIPTION_FIRST, whenStopped: "next", kinds: SUBSCRIPTION_FIRST };
    case "key_then_subscription":
      return { order: KEY_FIRST, whenStopped: "next", kinds: KEY_FIRST };
    case "key_only":
      return { order: KEY_KINDS, whenStopped: "wait", kinds: KEY_KINDS };
  }
}

/** A stored preset id, or null for anything else (absent, malformed). */
export function credentialPolicyIdOf(value: unknown): CredentialPolicyId | null {
  return typeof value === "string" && (CREDENTIAL_POLICIES as readonly string[]).includes(value)
    ? (value as CredentialPolicyId)
    : null;
}

const ORDERABLE: readonly BillingSourceKind[] = ["subscription", "api_key", "plan_credits"];

/** A stored `billing_order` (a non-empty list of distinct orderable kinds), else null. */
function legacyOrderOf(value: unknown): BillingSourceKind[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: BillingSourceKind[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !ORDERABLE.includes(v as BillingSourceKind)) return null;
    if (out.includes(v as BillingSourceKind)) return null;
    out.push(v as BillingSourceKind);
  }
  return out;
}

/**
 * The person's policy from their settings (`human.notify_prefs`), read at every pick: the stored
 * preset; else their earlier choice read as one (subscription first + wait or nothing:
 * subscription_then_wait; + use the other one: subscription_then_key; an API key or plan credits
 * first + use the other one: key_then_subscription; + wait or nothing: that order with wait and
 * every kind, so a task only the subscription can do here still runs on it, as before); else the
 * default preset for every call (subscription_then_key under an explicit "use the other one").
 */
export function credentialPolicyOf(
  prefs: Record<string, unknown> | null | undefined,
): CredentialPolicy {
  const p = prefs ?? {};
  const stored = credentialPolicyIdOf(p[CREDENTIAL_POLICY_SETTING]);
  if (stored) return { id: stored, chosen: "stored", rule: ruleOf(stored) };
  const order = legacyOrderOf(p[LEGACY_ORDER_SETTING]);
  const useOther = p[LEGACY_MID_SESSION_SETTING] === "use_other";
  if (!order) {
    const id: CredentialPolicyId = useOther ? "subscription_then_key" : DEFAULT_CREDENTIAL_POLICY;
    return { id, chosen: "default", rule: ruleOf(id) };
  }
  if (order[0] === "subscription") {
    const id: CredentialPolicyId = useOther ? "subscription_then_key" : "subscription_then_wait";
    return { id, chosen: "derived", rule: ruleOf(id) };
  }
  if (useOther)
    return {
      id: "key_then_subscription",
      chosen: "derived",
      rule: ruleOf("key_then_subscription"),
    };
  // An earlier "API key first, then wait": that order, every kind (the chooser keeps a task only
  // the subscription can do here on it, as before), and wait at a stop.
  const rest = ORDERABLE.filter((k) => !order.includes(k));
  return {
    id: "earlier",
    chosen: "derived",
    rule: { order: [...order, ...rest], whenStopped: "wait", kinds: [...ORDERABLE] },
  };
}

/**
 * How much money a policy can move without the person (CE-13): a change to a lower rank acts at
 * once, a change to a higher one asks the person's yes. The earlier choice ranks as key_only.
 */
export function moneyRank(id: CredentialPolicyId | "earlier"): number {
  switch (id) {
    case "subscription_then_wait":
      return 0;
    case "subscription_then_ask":
      return 1;
    case "subscription_then_key":
      return 2;
    default:
      return 3;
  }
}

/** What stopped a credential: its usage limit, Anthropic's refusal, the share, the key's month cap. */
export type StopReason = "limit" | "refused" | "share" | "key_month";

/** The first moment of the next UTC month after `nowMs`, as ISO (a share or month cap ends then). */
export function nextMonthStartIso(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/** The UTC month `nowMs` falls in, as "2026-11". */
function monthOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/**
 * The stop a source is at now and its key (CE-2): one key per stop, so an answer given for one
 * stop never covers the next. The same row gives the same key; a new rest, a new refusal, a
 * raised allowance or cap, or a new month gives another. Null when the source is not stopped.
 */
export function stopOf(
  source: { kind: BillingSourceKind; limits: BillingSourceLimits },
  status: BillingSourceStatus,
  nowMs: number,
  planShareCap: number,
): { reason: StopReason; until: string | null; stopKey: string } | null {
  if (status.refused)
    return { reason: "refused", until: null, stopKey: `refused:${status.refused}` };
  if (status.restingUntil)
    return {
      reason: "limit",
      until: status.restingUntil,
      stopKey: `limit:${status.restingUntil}`,
    };
  if (source.kind === "subscription" && typeof status.planUsageShare === "number") {
    const cap = source.limits.planShareCap ?? planShareCap;
    if (status.planUsageShare >= cap)
      return {
        reason: "share",
        until: nextMonthStartIso(nowMs),
        stopKey: `share:${monthOf(nowMs)}:${source.limits.planUsdMicro ?? 0}:${cap}`,
      };
  }
  if (
    typeof source.limits.monthlyUsdMicro === "number" &&
    typeof status.monthSpentUsdMicro === "number" &&
    status.monthSpentUsdMicro >= source.limits.monthlyUsdMicro
  )
    return {
      reason: "key_month",
      until: nextMonthStartIso(nowMs),
      stopKey: `key_month:${monthOf(nowMs)}:${source.limits.monthlyUsdMicro}`,
    };
  return null;
}

/** `stopOf`'s key alone (null when the source is not stopped). */
export function stopKeyOf(
  source: { kind: BillingSourceKind; limits: BillingSourceLimits },
  status: BillingSourceStatus,
  nowMs: number,
  planShareCap: number,
): string | null {
  return stopOf(source, status, nowMs, planShareCap)?.stopKey ?? null;
}

/**
 * The person's yes for one stop (CE-7, `limits.grant` on the stopped source): the granted kind
 * serves while that stop lasts, for every purpose but the background jobs.
 */
export interface CredentialGrant {
  to: BillingSourceKind;
  stopKey: string;
  by: "card" | "start";
  at: string;
}

/** A stored grant, or null for anything else. */
export function grantOf(value: unknown): CredentialGrant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const g = value as Record<string, unknown>;
  if (typeof g.to !== "string" || !ORDERABLE.includes(g.to as BillingSourceKind)) return null;
  if (typeof g.stopKey !== "string" || !g.stopKey) return null;
  return {
    to: g.to as BillingSourceKind,
    stopKey: g.stopKey,
    by: g.by === "start" ? "start" : "card",
    at: typeof g.at === "string" ? g.at : "",
  };
}
