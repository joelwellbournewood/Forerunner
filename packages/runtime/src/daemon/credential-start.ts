import { credentialPolicyOf, grantOf, type StopReason } from "@forerunner/billing";
import type { Clock } from "@forerunner/platform";
import type { JsonObject, StateStore } from "@forerunner/state";
import { chfText } from "../money-words.ts";
import { continuationGoesOnAt } from "../session/credential-wait.ts";
import { aboutWords } from "../session/money-words.ts";
import { keptContinuationOf, keptStartOf, type RouterTaskBilling } from "../wiring/billing-pick.ts";
import {
  grantStartLine,
  ifRunsOutLine,
  ONE_OFF_UNDER_WAIT,
  planCardLine,
  sessionGoesOnLine,
  startLaterExplain,
  startLaterLabel,
  startRunOutLine,
  startStoppedLine,
  useApiKeyExplain,
} from "./credential-policy-view.ts";

/**
 * d1109-cred-screens CS-3 (ADR 0120 amended 2026-11-16; the owner's 7a "go to API after asking
 * human" and the reading of 2026-11-09: "the person is there; 'wait' means the app does nothing
 * by itself, not that the person cannot choose"): what the Start dialog says of which Claude
 * does the work, and whether its "Use API key" may be offered. Read only: looking records
 * nothing. `POST /sessions` with `useOtherCredential` acts on `offer` alone.
 */
export interface StartCredentialView {
  /** One line under the plan sentence; null with one credential saved or under ask and wait with the first choice out. */
  line: string | null;
  /** Under ask and wait with the first choice out and the API key able to serve: the two buttons. */
  runOut: {
    use: { label: string; explain: string };
    /** "Start at 15:40" (a person start kept for the reset); null when a session already waits or for a refusal. */
    later: { label: string; explain: string } | null;
    /** The preset leans to: ask -> use first, wait -> later first. */
    lean: "use" | "later";
    /** The project's own session already waits to go on: "Your session of 14:05 goes on by itself at 15:40." */
    goesOnLine: string | null;
    /**
     * The one line above the two buttons ("Your subscription is at its limit until 15:40."): with
     * "Use API key" offered, "Nothing can run until 15:40" would not be true.
     */
    stoppedLine: string;
  } | null;
}

/** The stop "Use API key" acts on (CS-3), when it may be offered. */
export interface StartCredentialOffer {
  sourceId: string;
  stopKey: string;
  kind: string;
  reason: StopReason;
  until: string | null;
  whenStopped: "ask" | "wait";
}

export interface StartCredentialDeps {
  store: StateStore;
  clock: Clock;
  humanId: string;
  billing: Pick<RouterTaskBilling, "firstChoiceStop" | "currentStopOf" | "savedKinds"> | null;
  chfPerUsd: () => number;
  /** What is left of the monthly cap (null: no cap). */
  monthLeftUsdMicro: () => Promise<number | null>;
}

/**
 * What the start would do (the review of the fix-up): whether it runs work (something runnable,
 * or a task larger than the work budget) and whether Stop all holds every start. A start that
 * runs nothing, or that Stop all refuses, gets no stopped-first-choice line and no "Use API
 * key": before, the dialog offered it with "about CHF 0.00" and its yes moved every other
 * project's work and chat onto the key for a start that never ran.
 */
export interface StartRunsFacts {
  runsWork: boolean;
  stopped: boolean;
  /**
   * fixup-l4-cred-screens (L4-creds-17; design §1, "what the app says is true now"): whether no
   * ready task of the project can run now, each one's own pick meeting a credential wait
   * (`waits.now`, read only). Under "then the other one" the line says the other credential runs
   * the start only when the work can run there: work that only the stopped credential can do
   * here (commands set to the API key, a task that needs the person's answers) waits for it, and
   * the dialog's blocked sentence says so alone. Asked only in that branch.
   */
  waitsNow?: () => Promise<boolean>;
}

export async function startCredential(
  deps: StartCredentialDeps,
  projectId: string,
  /** What the session would spend: the runnable work's estimate, capped by its work budget. */
  estimateUsdMicro: number,
  facts: StartRunsFacts = { runsWork: true, stopped: false },
): Promise<{ view: StartCredentialView | null; offer: StartCredentialOffer | null }> {
  if (!deps.billing) return { view: null, offer: null };
  const human = await deps.store.human.get(deps.humanId);
  const policy = credentialPolicyOf((human?.notify_prefs ?? {}) as Record<string, unknown>);
  const saved = await deps.billing.savedKinds();
  if (!(saved.includes("subscription") && saved.includes("api_key")))
    return { view: null, offer: null };
  const opts = {
    ...(human?.timezone ? { timezone: human.timezone } : {}),
    nowMs: deps.clock.now(),
  };
  const first = await deps.billing.firstChoiceStop().catch(() => null);
  if (!first || first.reason === "needs" || !first.stopKey)
    return { view: { line: ifRunsOutLine(policy.rule, saved), runOut: null }, offer: null };
  // S-10's one wait per project: the project's own session already waits to go on by itself
  // (or a Start was kept for the reset); "Use API key" makes it go on now.
  const continuation = await keptContinuationOf(deps.store, projectId).catch(() => null);
  const keptStart = continuation
    ? null
    : await keptStartOf(deps.store, projectId).catch(() => null);
  // Every line below is about a start that runs: none when it would run nothing or Stop all
  // refuses it (the dialog's own sentence says why), and nothing to press.
  if (facts.stopped || !(facts.runsWork || continuation || keptStart))
    return { view: { line: null, runOut: null }, offer: null };
  const stop = { reason: first.reason, until: first.until };
  const about = aboutWords(
    chfText(Math.max(0, estimateUsdMicro), deps.chfPerUsd()),
    estimateUsdMicro,
  );
  const row = await deps.store.billingSource.get(first.sourceId).catch(() => undefined);
  const grant = grantOf((row?.limits as JsonObject | undefined)?.grant);
  if (grant && grant.stopKey === first.stopKey)
    return {
      view: { line: grantStartLine(first.kind, grant.to, stop, about, opts), runOut: null },
      offer: null,
    };
  // The other credential (the API key, after the subscription) serves now, and the month has room.
  const serves = async (): Promise<boolean> => {
    if (first.kind !== "subscription") return false;
    const key = (await deps.store.billingSource.list({ human_id: deps.humanId }, { limit: 100 }))
      .filter((r) => r.kind === "api_key" && r.enabled)
      .sort((a, b) => a.priority - b.priority)[0];
    if (!key) return false;
    if (await deps.billing?.currentStopOf(key.id).catch(() => ({ stopKey: "?" }))) return false;
    const left = await deps.monthLeftUsdMicro();
    return left === null || left > 0;
  };
  // l4-cred-screens (L4-creds-17, live check 4's LC-C26): under 'next' the other credential takes
  // over in either direction: the API key after the subscription (and the month has room), or the
  // subscription after the key, when the rule lets it serve and it has no stop of its own. Before,
  // `serves` was written for the subscription first only, so with the key first and resting the
  // dialog said nothing of which Claude does the work.
  const nextServes = async (): Promise<boolean> => {
    if (first.kind === "subscription") return serves();
    if (!policy.rule.kinds.includes("subscription")) return false;
    const sub = (await deps.store.billingSource.list({ human_id: deps.humanId }, { limit: 100 }))
      .filter((r) => r.kind === "subscription" && r.enabled)
      .sort((a, b) => a.priority - b.priority)[0];
    if (!sub) return false;
    return !(await deps.billing?.currentStopOf(sub.id).catch(() => ({ stopKey: "?" })));
  };
  if (policy.rule.whenStopped === "next") {
    // fixup-l4-cred-screens (the review of L4-creds-17): the other credential serves and the work
    // can run on it. Before, a key-first dialog said "..., so this runs on your subscription"
    // beside "Nothing can run until 11:40 (your API key's limit)" for work only the key can do.
    const waitsNow = async () =>
      facts.waitsNow ? await facts.waitsNow().catch(() => false) : false;
    const runsThere = (await nextServes()) && !(await waitsNow());
    return {
      view: {
        line: runsThere ? startRunOutLine(first.kind, stop, about, opts) : null,
        runOut: null,
      },
      offer: null,
    };
  }
  const whenStopped = policy.rule.whenStopped;
  if ((whenStopped === "wait" && !ONE_OFF_UNDER_WAIT) || !(await serves()))
    return { view: { line: null, runOut: null }, offer: null };
  let goesOnLine: string | null = null;
  if (continuation && first.until) {
    const session = continuation.kept.continues
      ? await deps.store.session.get(continuation.kept.continues).catch(() => undefined)
      : undefined;
    const startedAt = session?.started_at ?? session?.created_at ?? continuation.entry.since;
    const goesOnAt = continuationGoesOnAt(human, first.until) ?? first.until;
    if (startedAt) goesOnLine = sessionGoesOnLine(startedAt, goesOnAt, opts);
  }
  const later =
    continuation || keptStart || !first.until
      ? null
      : { label: startLaterLabel(stop, opts), explain: startLaterExplain(first.kind) };
  return {
    view: {
      line: null,
      runOut: {
        use: { label: "Use API key", explain: useApiKeyExplain(first.kind, stop, about, opts) },
        later,
        lean: whenStopped === "ask" ? "use" : "later",
        goesOnLine,
        stoppedLine: startStoppedLine(first.kind, stop, opts),
      },
    },
    offer: {
      sourceId: first.sourceId,
      stopKey: first.stopKey,
      kind: first.kind,
      reason: first.reason as StopReason,
      until: first.until,
      whenStopped,
    },
  };
}

/**
 * d1109-cred-screens CS-4: the plan card's foot line, computed when shown: the preset's
 * if-it-runs-out line, or while the first choice is out its run-out form; null with one
 * credential saved. The per-task runs-on lines stay the chooser's.
 */
export async function planCredentialLine(
  deps: Pick<StartCredentialDeps, "store" | "clock" | "humanId" | "billing"> & {
    chfPerUsd?: () => number;
  },
  /**
   * l4-cred-screens (L4-creds-15): what the plan's work is planned at (`waitingWorkUsdMicro`
   * over its tasks, within the work budget): said where the API key would do it, as the ask card
   * and the Start dialog say it.
   */
  planUsdMicro?: number,
): Promise<string | null> {
  if (!deps.billing) return null;
  const human = await deps.store.human.get(deps.humanId);
  const policy = credentialPolicyOf((human?.notify_prefs ?? {}) as Record<string, unknown>);
  const saved = await deps.billing.savedKinds();
  const opts = {
    ...(human?.timezone ? { timezone: human.timezone } : {}),
    nowMs: deps.clock.now(),
  };
  const first = await deps.billing.firstChoiceStop().catch(() => null);
  if (!first || first.reason === "needs") return planCardLine(policy.rule, saved, null, opts);
  const row = await deps.store.billingSource.get(first.sourceId).catch(() => undefined);
  const grant = grantOf((row?.limits as JsonObject | undefined)?.grant);
  const about =
    typeof planUsdMicro === "number" && planUsdMicro > 0 && deps.chfPerUsd
      ? aboutWords(chfText(planUsdMicro, deps.chfPerUsd()), planUsdMicro)
      : undefined;
  return planCardLine(
    policy.rule,
    saved,
    { kind: first.kind, stop: { reason: first.reason, until: first.until } },
    {
      ...opts,
      granted: !!grant && grant.stopKey === first.stopKey,
      ...(about ? { about } : {}),
    },
  );
}
