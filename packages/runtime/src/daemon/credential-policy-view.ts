// Light imports only (the policy and money modules, never the billing or commands index, which
// reach the state store): the UI's fake daemon builds the same view from these functions.
import { formatChf } from "@forerunner/billing/money";
import {
  CREDENTIAL_POLICIES,
  type CredentialPolicyId,
  credentialPolicyEffectWords as credentialPolicyEffect,
  credentialPolicyLabel as credentialPolicyWords,
  moneyRank,
  type StopReason,
  type WhenStopped,
} from "@forerunner/billing/policy";
import { clockTime } from "../session/credential-wait.ts";
import { moneyWords } from "../session/money-words.ts";

/**
 * d1109-cred-screens (ADR 0120 amended 2026-11-16; D5, the owner's 7a: "It should also be
 * possible to give a framework for what to use when, and then the system just does it", and
 * answer 4: "There should be a nice clean options menu"): every sentence the screens say about
 * which Claude does the work, in one place. Settings' section, the Start dialog, the plan card,
 * the rows, the session page, the drawer and Costs read them from here; the cards' and the log's
 * sentences are in `session/credential-words.ts` (d1109-cred-engine).
 *
 * Design §5: one sentence read at a glance, CHF with two decimals and "about" for estimates,
 * times in the person's time zone, no ids, no raw states, no markdown; a sentence promises only
 * what the engine does.
 */

/** A credential kind the screens name. */
export type CredentialKind = "subscription" | "api_key" | "plan_credits";

/** What a preset is called and what it does when the first credential runs out (CS-1). */
export interface PresetWords {
  id: CredentialPolicyId;
  label: string;
  line: string;
  /** It moves work onto money by itself when the first choice runs out (or starts there). */
  movesMoney: boolean;
}

/** Each preset's one line, as the options menu shows it (each at most 100 characters). */
const PRESET_LINES: Record<CredentialPolicyId, string> = {
  subscription_then_wait:
    "When your subscription runs out, nothing moves to your API key; the work waits for it.",
  subscription_then_ask:
    "When your subscription runs out, one card asks: go on with your API key at its cost, or wait.",
  subscription_then_key:
    "When your subscription runs out, your API key takes over at once. You are told the cost.",
  key_then_subscription:
    "Your API key does the work, at a cost per use. When it runs out, your subscription takes over.",
  key_only:
    "Your API key does all the work, at a cost per use. When it runs out, the work waits for it.",
};

/** The five presets in the order a person reads them (least money first). */
export function presetWords(): PresetWords[] {
  return CREDENTIAL_POLICIES.map((id) => ({
    id,
    label: credentialPolicyWords(id),
    line: PRESET_LINES[id],
    movesMoney:
      id === "subscription_then_key" || id === "key_then_subscription" || id === "key_only",
  }));
}

/** The intro line above the presets. */
export const POLICY_INTRO =
  "Your Claude subscription has no cost per use within your plan's limits; your API key costs money per use.";

/**
 * The default preset, until the person picks one (the owner's answer 4 of 2026-11-09): shown
 * selected, with this line. A task only the API key can do here still runs on it, as its plan
 * card says (ADR 0100 point 13), so the line does not say "everything".
 */
export const NOT_CHOSEN_LINE =
  "Used until you choose: your subscription first for everything it can do here; when it runs out, the work waits.";

/** An earlier "API key first, then wait" order no preset matches: none selected, this line. */
export const EARLIER_LINE =
  "Your earlier choice: your API key first, your subscription only for a task your key cannot do here. When your key runs out, the work waits.";

/** What "runs out" means, once under the presets. */
export const RUNS_OUT_LINE =
  "Runs out means: its usage limit is reached, the share of your subscription Forerunner may use is used, or Anthropic refuses it.";

/** The subscription-first presets' footnote (the chooser's capability move, ADR 0100 point 13). */
export const SUBSCRIPTION_FIRST_FOOTNOTE =
  "A task only your API key can do here (one that must ask you) still runs on it; the plan card says so.";

/** The person's name for a credential: "your subscription", "your API key". */
function short(kind: CredentialKind | string): string {
  if (kind === "subscription") return "your subscription";
  if (kind === "plan_credits") return "your plan credits";
  return "your API key";
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The other credential of a subscription-or-key pair. */
function otherOf(kind: CredentialKind | string): CredentialKind {
  return kind === "subscription" ? "api_key" : "subscription";
}

/**
 * The folded sentence when only one Claude credential is saved (CS-1): the presets have nothing
 * to choose between. A session the person started goes on at the reset (the owner's binding
 * answer of 2026-11-09: "a session the person started goes on by itself when its Claude
 * credential is back").
 */
export function oneCredentialSentence(kind: CredentialKind | string): {
  sentence: string;
  link: { label: string; to: string };
} {
  if (kind === "subscription")
    return {
      sentence:
        "Only your Claude subscription is saved: it does the work; when it runs out the work waits for its reset, and a session you started goes on then. Save an API key to choose what happens then.",
      link: { label: "Save an API key", to: "/setup" },
    };
  return {
    sentence:
      "Only your API key is saved: it does the work, at a cost per use; when it runs out the work waits for it, and a session you started goes on then. Save your Claude subscription to choose what happens then.",
    link: { label: "Save your subscription", to: "/setup" },
  };
}

/** No Claude credential is saved: nothing to choose yet. */
export const NONE_SAVED_SENTENCE =
  "No Claude credential is saved yet. Save your Claude subscription or an API key to choose which does the work.";

/**
 * No Claude credential is saved while the app answers with a model it was started with (the
 * bench's stand-in, `RuntimeApp.startedWith`; U-078): the same, saying why it answers anyway.
 */
export const STARTED_WITH_SENTENCE =
  "No Claude credential is saved here; this app answers with a model of its own for now. Save your Claude subscription or an API key to choose which does the work.";

/**
 * A credential's role under the preset (CS-1's rows): "Does the work", "After you say yes, when
 * your subscription runs out", "Takes over when your subscription runs out", "Only for a task
 * your subscription cannot do", "Not used".
 */
export function roleWords(
  kind: CredentialKind | string,
  rule: { order: readonly string[]; whenStopped: WhenStopped; kinds: readonly string[] },
  savedKinds: readonly string[],
): string {
  if (!rule.kinds.includes(kind)) return "Not used";
  const first = rule.order.find((k) => savedKinds.includes(k)) ?? rule.order[0];
  if (kind === first) return "Does the work";
  const firstName = short(first ?? "subscription");
  if (rule.whenStopped === "ask") return `After you say yes, when ${firstName} runs out`;
  if (rule.whenStopped === "next") return `Takes over when ${firstName} runs out`;
  return `Only for a task ${firstName} cannot do`;
}

/** A stop of a credential, as the screens read it (`stopOf` with the source's kind). */
export interface StopFacts {
  reason: StopReason;
  /** ISO; null for a refusal. */
  until: string | null;
}

export interface ClockOpts {
  timezone?: string;
  nowMs: number;
}

/** "15:40" today, "Wed 4 Nov, 15:40" another day; the day alone for a month's stop. */
export function untilWords(stop: StopFacts, opts: ClockOpts): string {
  if (!stop.until) return "";
  const t = clockTime(stop.until, opts.timezone, opts.nowMs);
  return stop.reason === "share" || stop.reason === "key_month" ? t.replace(/, \d\d:\d\d$/, "") : t;
}

/** "(your subscription's limit)", "(your subscription's share)", "(your API key's monthly cap)". */
export function stopNameWords(kind: CredentialKind | string, reason: StopReason): string {
  if (reason === "share") return "your subscription's share";
  if (reason === "key_month") return `${short(kind)}'s monthly cap`;
  if (reason === "refused") return `${short(kind)} was refused`;
  return `${short(kind)}'s limit`;
}

/** A credential's state now (CS-1's rows): "Works now", "At its limit until 15:40", ... */
export function stateWords(
  kind: CredentialKind | string,
  facts: {
    saved: boolean;
    enabled: boolean;
    stop: StopFacts | null;
  },
  opts: ClockOpts,
): { words: string; link: { label: string; to: string } | null } {
  if (!facts.enabled) return { words: "Turned off", link: null };
  if (!facts.saved) return { words: "Not saved", link: { label: "Save it", to: "/setup" } };
  const s = facts.stop;
  if (!s) return { words: "Works now", link: null };
  const at = untilWords(s, opts);
  switch (s.reason) {
    case "refused":
      return kind === "subscription"
        ? {
            words: "Refused: save a new sign-in",
            link: { label: "Save a new sign-in", to: "/setup" },
          }
        : { words: "Refused: save a new key", link: { label: "Save a new key", to: "/setup" } };
    case "share":
      return {
        words: `Share used until ${at}`,
        link: { label: "Change the allowance", to: "/settings#plan-allowance" },
      };
    case "key_month":
      return { words: `Monthly cap reached until ${at}`, link: null };
    default:
      return { words: `At its limit until ${at}`, link: null };
  }
}

/** This month's use (CS-1's rows): "34% of this month's allowance used", "CHF 2.10 this month". */
export function monthWords(
  kind: CredentialKind | string,
  facts: { planShare: number | null; monthChf: string },
): string {
  if (kind === "subscription") {
    const share = facts.planShare ?? 0;
    return `${Math.round(share * 100)}% of this month's allowance used`;
  }
  return `${facts.monthChf} this month`;
}

/**
 * What happens if the first choice runs out (CS-1's now line, CS-3's Start dialog line, CS-4's
 * plan card line): one sentence, or null with one credential saved.
 */
export function ifRunsOutLine(
  rule: { order: readonly string[]; whenStopped: WhenStopped; kinds: readonly string[] },
  savedKinds: readonly string[],
): string | null {
  const saved = rule.order.filter((k) => savedKinds.includes(k) && rule.kinds.includes(k));
  const both = savedKinds.includes("subscription") && savedKinds.includes("api_key");
  if (!both) return null;
  const first = saved[0] ?? rule.order[0] ?? "subscription";
  const firstName = short(first);
  if (first === "subscription") {
    if (rule.whenStopped === "ask")
      return "If your subscription runs out, you are asked before your API key is used.";
    if (rule.whenStopped === "next")
      return "If your subscription runs out, the work goes on with your API key (costs money).";
    return "If your subscription runs out, the work waits for it.";
  }
  if (rule.whenStopped === "next" && rule.kinds.includes("subscription"))
    return `If ${firstName} runs out, the work goes on with your subscription.`;
  return `If ${firstName} runs out, the work waits for it.`;
}

/** "Your subscription is at its limit until 15:40" (no full stop): the first choice now. */
export function firstStoppedPhrase(
  kind: CredentialKind | string,
  stop: StopFacts,
  opts: ClockOpts,
): string {
  const at = untilWords(stop, opts);
  const who = capital(short(kind));
  switch (stop.reason) {
    case "refused":
      return kind === "subscription"
        ? "Anthropic refused your Claude sign-in"
        : "Anthropic refused your API key";
    case "share":
      return `${who} has used its share until ${at}`;
    case "key_month":
      return `${who} is at its monthly cap until ${at}`;
    default:
      return `${who} is at its limit until ${at}`;
  }
}

/** "until 15:40" / "until Tue 1 Dec" / "until a new sign-in is saved". */
export function untilClause(kind: CredentialKind | string, stop: StopFacts, opts: ClockOpts) {
  if (stop.reason === "refused")
    return kind === "subscription" ? "until a new sign-in is saved" : "until a new key is saved";
  return `until ${untilWords(stop, opts)}`;
}

/**
 * Settings' now line while the first choice is out (CS-1), by the rule and the facts: under ask
 * with the card open "... Answer the card to use your API key, or wait." [Answer]; under ask
 * with no card open "...; you are asked before your API key is used." (l4-cred-screens,
 * L4-creds-25: it said the work waits, beside a preset that asks); under next "...; your API key
 * does the work meanwhile."; else "...; the work waits for it."
 */
export function stoppedNowLine(
  kind: CredentialKind | string,
  stop: StopFacts,
  rule: WhenStopped,
  opts: ClockOpts & { askOpen: boolean },
): string {
  const head = firstStoppedPhrase(kind, stop, opts);
  const other = short(otherOf(kind));
  if (rule === "ask" && opts.askOpen) return `${head}. Answer the card to use ${other}, or wait.`;
  if (rule === "ask") return `${head}; you are asked before ${other} is used.`;
  if (rule === "next") return `${head}; ${other} does the work meanwhile.`;
  return `${head}; the work waits for it.`;
}

/**
 * What Settings' "Stop using it" does (CS-1; the review of the fix-up: the button had no line):
 * the yes ends, a run already going on the other credential finishes (a run is never moved
 * mid-way, ADR 0100 point 3), and the next pick waits for the stopped one.
 */
export function grantEndLine(
  stoppedKind: CredentialKind | string,
  to: CredentialKind | string,
): string {
  return `Stop using it: what already runs on ${short(to)} finishes; new work waits for ${short(stoppedKind)}.`;
}

/** Settings' now line with a yes standing (CS-1): "Your work and chat use your API key until 15:40: you said yes." */
export function grantNowLine(
  stoppedKind: CredentialKind | string,
  to: CredentialKind | string,
  stop: StopFacts,
  opts: ClockOpts,
): string {
  return `Your work and chat use ${short(to)} ${untilClause(stoppedKind, stop, opts)}: you said yes.`;
}

// ── CS-3: the Start dialog ───────────────────────────────────────────────────────────────────

/**
 * Open owner question (runC-plan.json owner_questions, CS-3/CS-8): under "Subscription first,
 * then wait" the Start dialog and chat still offer a one-off "Use API key" that spends only when
 * the person presses it. Built meanwhile: offered under "then wait" and "ask before API key"
 * alike. The owner's answer changes this one constant (false: only under "ask before API key").
 */
export const ONE_OFF_UNDER_WAIT = true;

/** Under next with the first choice out: "Your subscription is at its limit until 15:40, so this runs on your API key (about CHF 0.90)." */
export function startRunOutLine(
  kind: CredentialKind | string,
  stop: StopFacts,
  aboutChf: string,
  opts: ClockOpts,
): string {
  return `${firstStoppedPhrase(kind, stop, opts)}, so this runs on ${short(otherOf(kind))} (${aboutChf}).`;
}

/**
 * w8-l4-leftovers (L4i-left-32): the work only the stopped first choice can do here, said after
 * the run-out line, which then counts only the rest: '"Deploy the site" waits for your API key.';
 * two or more: '"Deploy the site" and 1 more wait for your API key.'.
 */
export function waitsForFirstLine(
  titles: readonly string[],
  kind: CredentialKind | string,
): string {
  const [one] = titles;
  const who = short(kind);
  if (titles.length <= 1) return `"${one ?? ""}" waits for ${who}.`;
  return `"${one}" and ${titles.length - 1} more wait for ${who}.`;
}

/** Under ask and wait with the first choice out: the one line above the two buttons. */
export function startStoppedLine(
  kind: CredentialKind | string,
  stop: StopFacts,
  opts: ClockOpts,
): string {
  return `${firstStoppedPhrase(kind, stop, opts)}.`;
}

/**
 * 'Use API key': "Runs now on your API key until 15:40, about CHF 0.90; nothing passes this
 * session's budget." After a refusal (l4-cred-screens, L4-creds-25: "until a new sign-in is
 * saved, ...; nothing passes ..." ran past design §5's 100 characters) it says the step instead:
 * "Runs now on your API key until you sign in again, about CHF 0.90."
 */
export function useApiKeyExplain(
  kind: CredentialKind | string,
  stop: StopFacts,
  aboutChf: string,
  opts: ClockOpts,
): string {
  const other = short(otherOf(kind));
  if (stop.reason === "refused")
    return `Runs now on ${other} ${kind === "subscription" ? "until you sign in again" : "until you save a new key"}, ${aboutChf}.`;
  return `Runs now on ${other} ${untilClause(kind, stop, opts)}, ${aboutChf}; nothing passes this session's budget.`;
}

/** 'Start at 15:40' (at most three words): "Start at 15:40", "Start on 1 Dec". */
export function startLaterLabel(stop: StopFacts, opts: ClockOpts): string {
  if (stop.reason === "share" || stop.reason === "key_month") {
    const day = untilWords(stop, opts).replace(/^\w{3} /, "");
    return `Start on ${day}`;
  }
  return `Start at ${untilWords(stop, opts)}`;
}

/** 'Start at 15:40': "Runs on your subscription once it is back; nothing moves before." */
export function startLaterExplain(kind: CredentialKind | string): string {
  return `Runs on ${short(kind)} once it is back; nothing moves before.`;
}

/** With a yes standing: "You said yes to your API key until 15:40, so this runs on it (about CHF 0.90)." */
export function grantStartLine(
  stoppedKind: CredentialKind | string,
  to: CredentialKind | string,
  stop: StopFacts,
  aboutChf: string,
  opts: ClockOpts,
): string {
  return `You said yes to ${short(to)} ${untilClause(stoppedKind, stop, opts)}, so this runs on it (${aboutChf}).`;
}

/** A session of the project already waits to go on: "Your session of 14:05 goes on by itself at 15:40." */
export function sessionGoesOnLine(startedAt: string, goesOnAt: string, opts: ClockOpts): string {
  return `Your session of ${clockTime(startedAt, opts.timezone, opts.nowMs)} goes on by itself at ${clockTime(goesOnAt, opts.timezone, opts.nowMs)}.`;
}

// ── CS-4: the plan card ──────────────────────────────────────────────────────────────────────

/**
 * The plan card's foot line: the preset's if-it-runs-out line, or while the first choice is out
 * its run-out form ("Your subscription is at its limit until 15:40: you are asked before your
 * API key is used.").
 */
export function planCardLine(
  rule: { order: readonly string[]; whenStopped: WhenStopped; kinds: readonly string[] },
  savedKinds: readonly string[],
  first: { kind: CredentialKind | string; stop: StopFacts } | null,
  opts: ClockOpts & {
    granted?: boolean;
    /**
     * l4-cred-screens (L4-creds-15): the waiting work's one figure ("about CHF 0.25", the ask
     * card's and the Start dialog's), said where the API key would do the plan's work.
     */
    about?: string;
  },
): string | null {
  const line = ifRunsOutLine(rule, savedKinds);
  if (!line) return null;
  if (!first) return line;
  const head = firstStoppedPhrase(first.kind, first.stop, opts);
  const otherKind = otherOf(first.kind);
  const other = short(otherKind);
  // Only the API key costs money per use (L4-creds-17: under "API key first, then
  // subscription" the subscription takes over, and no money moves).
  const cost = otherKind === "api_key" ? ` (${opts.about ?? "costs money"})` : "";
  if (opts.granted)
    return `${head}: you said yes, so ${other} does the work meanwhile${otherKind === "api_key" && opts.about ? ` (${opts.about})` : ""}.`;
  if (rule.whenStopped === "ask")
    return `${head}: you are asked before ${other} is used${opts.about ? ` (${opts.about})` : ""}.`;
  if (rule.whenStopped === "next") return `${head}: ${other} does the work meanwhile${cost}.`;
  return `${head}: the work waits for it.`;
}

// ── CS-6: the switch on the session page, the result and the drawer ──────────────────────────

/** "On your API key since 14:20 (your subscription's limit): CHF 0.42 so far." */
export function sessionSwitchLine(
  to: CredentialKind | string,
  from: { kind: CredentialKind | string; reason: StopReason },
  at: string,
  spentChf: string,
  opts: ClockOpts,
): string {
  return `On ${short(to)} since ${clockTime(at, opts.timezone, opts.nowMs)} (${stopNameWords(from.kind, from.reason)}): ${spentChf} so far.`;
}

/** "Your API key took over at 14:20 (your subscription's limit): CHF 0.42 of CHF 0.62." */
export function resultSwitchLine(
  to: CredentialKind | string,
  from: { kind: CredentialKind | string; reason: StopReason },
  at: string,
  onItChf: string,
  totalChf: string,
  opts: ClockOpts,
): string {
  return `${capital(short(to))} took over at ${clockTime(at, opts.timezone, opts.nowMs)} (${stopNameWords(from.kind, from.reason)}): ${onItChf} of ${totalChf}.`;
}

/** The task drawer's run: "On your API key after your subscription's limit · CHF 0.43". */
export function drawerRunLine(
  to: CredentialKind | string,
  from: { kind: CredentialKind | string; reason: StopReason },
  costChf: string,
): string {
  return `On ${short(to)} after ${stopNameWords(from.kind, from.reason)} · ${costChf}`;
}

// ── CS-9: Costs by credential ────────────────────────────────────────────────────────────────

/** "Your API key: CHF 1.20" / "Your Claude subscription: CHF 2.10 (estimate, 12% of its allowance)". */
export function costByCredentialWords(
  kind: CredentialKind | string,
  chf: string,
  share: number | null,
): string {
  if (kind === "subscription")
    return `Your Claude subscription: ${chf} (estimate${share !== null ? `, ${Math.round(share * 100)}% of its allowance` : ""})`;
  if (kind === "plan_credits") return `Your plan credits: ${chf}`;
  if (kind === "fake") return `The stand-in model: ${chf}`;
  return `Your API key: ${chf}`;
}

// ── CS-1: the whole section from plain facts (the daemon's route and the UI's fake build it alike) ─

/** One saved (or listed) credential's facts, read now. */
export interface CredentialFacts {
  kind: CredentialKind;
  saved: boolean;
  enabled: boolean;
  /** The router's stop now (`currentStopOf`), with its key; null when it serves. */
  stop: (StopFacts & { stopKey: string }) | null;
  /** The subscription's share of its allowance this month (0..1). */
  planShare: number | null;
  /** This month's spend in CHF micro units. */
  monthChfMicro: number;
  /** A standing yes on this (stopped) source: to that kind, for that stop. */
  grant: { to: CredentialKind; stopKey: string } | null;
}

/** The section's view (`CredentialPolicyView` in credential-policy-types.ts). */
export interface CredentialPolicySectionView {
  intro: string;
  presets: PresetWords[];
  selected: CredentialPolicyId | null;
  chosen: "stored" | "derived" | "default";
  choiceLine: string | null;
  rows: {
    kind: CredentialKind;
    name: string;
    role: string;
    state: string;
    stopped: boolean;
    link: { label: string; to: string } | null;
    month: string;
  }[];
  nowLine: string | null;
  answer: { label: string; to: string } | null;
  grant: boolean;
  grantEndLine: string | null;
  runsOutLine: string | null;
  footnote: string | null;
  single: { sentence: string; link: { label: string; to: string } } | null;
}

const NAMES: Record<CredentialKind, string> = {
  subscription: "Claude subscription",
  api_key: "API key",
  plan_credits: "Plan credits",
};

/**
 * The section from the facts (CS-1): the preset in force (`credentialPolicyOf`), the credentials
 * in its order with their role, state and month, what happens next computed now, and the folded
 * sentence with one credential saved.
 */
export function credentialPolicySection(input: {
  policy: {
    id: CredentialPolicyId | "earlier";
    chosen: "stored" | "derived" | "default";
    rule: { order: readonly string[]; whenStopped: WhenStopped; kinds: readonly string[] };
  };
  credentials: readonly CredentialFacts[];
  /** The open ask card's id (its Answer opens it), if any. */
  openAskId: string | null;
  opts: ClockOpts;
  /** The model the app was started with outside the saved credentials, if any. */
  startedWith?: string | null;
}): CredentialPolicySectionView {
  const { policy, opts } = input;
  const rank = (k: string) => {
    const i = policy.rule.order.indexOf(k);
    return i < 0 ? 99 : i;
  };
  const listed = [...input.credentials]
    .filter((c) => c.kind !== "plan_credits" || c.saved)
    .sort((a, b) => rank(a.kind) - rank(b.kind));
  const savedKinds = [...new Set(listed.filter((c) => c.saved).map((c) => c.kind))];
  const firstKind = policy.rule.order.find((k) => savedKinds.includes(k as CredentialKind));
  const seen = new Set<string>();
  const rows: CredentialPolicySectionView["rows"] = [];
  let first: CredentialFacts | null = null;
  for (const c of listed) {
    if (seen.has(c.kind)) continue;
    seen.add(c.kind);
    const stop = c.saved && c.enabled ? c.stop : null;
    const state = stateWords(
      c.kind,
      {
        saved: c.saved,
        enabled: c.enabled,
        stop: stop ? { reason: stop.reason, until: stop.until } : null,
      },
      opts,
    );
    rows.push({
      kind: c.kind,
      name: NAMES[c.kind],
      role: roleWords(c.kind, policy.rule, savedKinds),
      state: state.words,
      stopped: !!stop || !c.enabled,
      link: state.link,
      month: monthWords(c.kind, {
        planShare: c.planShare,
        monthChf: moneyWords(formatChf(Math.max(0, c.monthChfMicro)), c.monthChfMicro),
      }),
    });
    if (c.kind === firstKind && stop) first = { ...c, stop };
  }
  const both = savedKinds.includes("subscription") && savedKinds.includes("api_key");
  let nowLine: string | null = null;
  let answer: CredentialPolicySectionView["answer"] = null;
  let grant = false;
  let grantEnd: string | null = null;
  if (both && first?.stop) {
    const g = first.grant && first.grant.stopKey === first.stop.stopKey ? first.grant : null;
    if (g) {
      nowLine = grantNowLine(first.kind, g.to, first.stop, opts);
      grant = true;
      grantEnd = grantEndLine(first.kind, g.to);
    } else {
      const askOpen = policy.rule.whenStopped === "ask" && !!input.openAskId;
      nowLine = stoppedNowLine(first.kind, first.stop, policy.rule.whenStopped, {
        ...opts,
        askOpen,
      });
      if (askOpen && input.openAskId)
        answer = { label: "Answer", to: `/inbox#card-${encodeURIComponent(input.openAskId)}` };
    }
  } else if (both) nowLine = ifRunsOutLine(policy.rule, savedKinds);
  return {
    intro: POLICY_INTRO,
    presets: presetWords(),
    selected: policy.id === "earlier" ? null : policy.id,
    chosen: policy.chosen,
    choiceLine:
      policy.id === "earlier" ? EARLIER_LINE : policy.chosen === "default" ? NOT_CHOSEN_LINE : null,
    rows,
    nowLine,
    answer,
    grant,
    grantEndLine: grantEnd,
    runsOutLine: both ? RUNS_OUT_LINE : null,
    footnote: both && policy.rule.order[0] === "subscription" ? SUBSCRIPTION_FIRST_FOOTNOTE : null,
    single: both
      ? null
      : savedKinds.length === 0
        ? {
            sentence: input.startedWith ? STARTED_WITH_SENTENCE : NONE_SAVED_SENTENCE,
            link: { label: "Connect Claude", to: "/setup" },
          }
        : oneCredentialSentence(savedKinds.includes("subscription") ? "subscription" : "api_key"),
  };
}

/**
 * The change card's words of a preset change (the daemon's `settings.set credential_policy`, its
 * `askOf` and `sentenceOf`), for the UI's fake daemon to say the same: whether it moves less
 * money (acts at once), the read-back and the change log sentence.
 */
export function policyChangeWords(
  from: CredentialPolicyId | "earlier",
  to: CredentialPolicyId,
): { narrows: boolean; ask: string; sentence: string } {
  const effect = credentialPolicyEffect(to);
  return {
    narrows: moneyRank(to) <= moneyRank(from),
    ask: `Set which Claude does the work to ${credentialPolicyWords(to)}? ${capital(effect)}.`,
    sentence: `Set which Claude does the work from ${credentialPolicyWords(from)} to ${credentialPolicyWords(to)}: ${effect}. Undo.`,
  };
}

/** The policy in force from stored settings (the engine's reading, re-exported for the fake). */
export { credentialPolicyOf } from "@forerunner/billing/policy";
