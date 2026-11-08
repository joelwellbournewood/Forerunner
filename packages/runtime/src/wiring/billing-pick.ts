import { createHash } from "node:crypto";
import {
  BillingRouter,
  type BillingSource,
  type BillingSourceKind,
  type BillingSourceProbe,
  type BillingSourceStatus,
  billingOrderOf,
  DEFAULT_ROUTING_POLICY,
  monthWindow,
  type RouteSkip,
  type RoutingPolicy,
} from "@forerunner/billing";
import type { Clock } from "@forerunner/platform";
import { errorMessage, ForerunnerError, log, redact } from "@forerunner/platform";
import type { BillingSourceRow, JsonObject, StateStore } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";
import { restUntil } from "../provider/usage-limit.ts";
import {
  type CredentialAbilities,
  type PlanUsage,
  TASK_NEEDS,
  type TaskBillingPick,
  type TaskBillingPort,
  type TaskBillingRequest,
  type TaskNeed,
  type TaskNeeds,
} from "../session/billing.ts";
import type { CredentialWait } from "../session/credential-wait.ts";
import {
  BILLING_REFUSED_AUDIT_TOOL,
  closeRefusedCards,
  fileRefusedCard,
} from "../session/credential-wait.ts";
import {
  PLAN_USD_MONTHLY_ENV,
  type PlanAllowance,
  resolvePlanAllowance,
} from "../setup/plan-allowance.ts";
import { SECRET_NAMES } from "../setup/wizard.ts";
import { stateSources } from "./billing-ports.ts";

/**
 * Per-task billing for the daemon (ADR 0044): the human's sources seeded from the vault, a
 * probe that reads the vault and the ledger, and the router's pick for one task.
 */

/** The plan share cap the seeded subscription row carries (the policy default, spec I.1). */
export const SEEDED_PLAN_SHARE_CAP = 0.95;

export interface SeedBillingSourcesOptions {
  store: Pick<StateStore, "billingSource">;
  vault: Pick<Vault, "has">;
  humanId: string;
  env?: NodeJS.ProcessEnv;
  /**
   * The subscription's plan allowance (`limits.planUsdMicro`; ADR 0044), resolved by the
   * caller from its inputs (`resolvePlanAllowance`: the composition's option, the
   * environment, `config.json`, else the default). Absent: the environment, else the default.
   */
  planAllowance?: PlanAllowance;
}

/**
 * The human's billing sources from what the vault holds: a `subscription` row for
 * `anthropic_subscription_token` and an `api_key` row for `anthropic_api_key`, both when both
 * exist (the router then picks per task), each once (a row whose `credential_ref` names the
 * secret is kept, enabled or not; the subscription row's `limits.planUsdMicro` follows the
 * allowance in force when the human set one, and gets the default only when it has none), a
 * `fake` row only when nothing else exists so the fake provider has a source, and an earlier
 * `fake` row disabled as soon as a real source is enabled (the router never bills real work
 * to a stand-in). Returns every row of the human after seeding.
 */
export async function seedBillingSources(
  opts: SeedBillingSourcesOptions,
): Promise<BillingSourceRow[]> {
  const { store, vault, humanId } = opts;
  const allowance =
    opts.planAllowance ??
    resolvePlanAllowance([{ value: opts.env?.[PLAN_USD_MONTHLY_ENV], origin: "env" }]);
  const existing = await store.billingSource.list({ human_id: humanId }, { limit: 100 });
  const byRef = (ref: string) => existing.find((r) => r.credential_ref === ref);
  const hasOauth = await vault.has(SECRET_NAMES.anthropicOauth);
  const hasKey = await vault.has(SECRET_NAMES.anthropic);
  const added: BillingSourceRow[] = [];
  const subscription = byRef(SECRET_NAMES.anthropicOauth);
  if (hasOauth && !subscription) {
    added.push(
      await store.billingSource.insert({
        human_id: humanId,
        kind: "subscription",
        label: "Claude subscription",
        credential_ref: SECRET_NAMES.anthropicOauth,
        limits: { planShareCap: SEEDED_PLAN_SHARE_CAP, planUsdMicro: allowance.usdMicro },
        enabled: true,
        priority: 1,
      }),
    );
  } else if (hasOauth && subscription) {
    // A human-set allowance wins over the row; the default only fills a row that has none
    // (a value edited on the row itself stands).
    const current = subscription.limits.planUsdMicro;
    const hasOwn = typeof current === "number" && current > 0;
    const next = allowance.origin !== "default" || !hasOwn ? allowance.usdMicro : current;
    if (next !== current) {
      const patched = await store.billingSource.patch(subscription.id, {
        limits: { ...subscription.limits, planUsdMicro: next },
      });
      existing[existing.indexOf(subscription)] = patched;
    }
  }
  if (hasKey && !byRef(SECRET_NAMES.anthropic)) {
    added.push(
      await store.billingSource.insert({
        human_id: humanId,
        kind: "api_key",
        label: "Anthropic API key",
        credential_ref: SECRET_NAMES.anthropic,
        limits: {},
        enabled: true,
        priority: 2,
      }),
    );
  }
  if (existing.length === 0 && added.length === 0) {
    added.push(
      await store.billingSource.insert({
        human_id: humanId,
        kind: "fake",
        label: "No credential (fake provider)",
        credential_ref: "none",
        limits: {},
        enabled: true,
        priority: 9,
      }),
    );
  }
  const realEnabled = [...existing, ...added].some((r) => r.kind !== "fake" && r.enabled);
  if (realEnabled) {
    for (const [i, row] of existing.entries()) {
      if (row.kind === "fake" && row.enabled) {
        existing[i] = await store.billingSource.patch(row.id, { enabled: false });
      }
    }
  }
  return [...existing, ...added];
}

/**
 * The daemon's probe: a source is available when the vault holds its credential (the fake
 * source needs none); a subscription reports the plan share this month, which is the larger
 * of the share the month's ledger rows carry (`MAX(plan_usage_share)`, what the last run or a
 * probe reported) and the month's API-equivalent spend over the source's allowance
 * (`limits.planUsdMicro`) when it has one; an API-style source reports the month's spend so
 * the router can apply `limits.monthlyUsdMicro`.
 */
export class VaultLedgerProbe implements BillingSourceProbe {
  constructor(
    private readonly deps: {
      /** `get` reads the credential a refusal named (U-078): a new one ends the mark. */
      vault: Pick<Vault, "has"> & Partial<Pick<Vault, "get">>;
      store: Pick<StateStore, "costLedger">;
      clock: Clock;
    },
  ) {}

  async status(source: BillingSource): Promise<BillingSourceStatus> {
    const checkedAt = this.deps.clock.nowIso();
    if (source.kind === "fake") return { available: true, checkedAt };
    let present = false;
    try {
      present = source.credentialRef ? await this.deps.vault.has(source.credentialRef) : false;
    } catch {
      present = false;
    }
    if (!present) {
      return {
        available: false,
        reason: `no credential ${source.credentialRef || "(none)"} in the vault`,
        checkedAt,
      };
    }
    const usage = await planUsageOf(this.deps.store, this.deps.clock, source);
    const resting = restingUntilOf(source, this.deps.clock.now());
    const refused = await refusedSince(source, this.deps.vault);
    return {
      available: true,
      checkedAt,
      monthSpentUsdMicro: usage.monthUsdMicro,
      ...(usage.share !== null ? { planUsageShare: usage.share } : {}),
      ...(resting ? { restingUntil: resting } : {}),
      ...(refused ? { refused } : {}),
    };
  }
}

/**
 * A credential's fingerprint for the refused mark (U-078): the first 16 hex characters of its
 * SHA-256. It tells "the credential that was refused" from "a new one" and is never the value.
 */
export function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * When Anthropic refused the source's credential (`limits.refusedAt`, U-078), while the vault
 * still holds the credential that was refused; null when it is not refused, or a new credential
 * was saved since (whichever way: the app's setup, `fr setup`, another install's vault).
 */
export function refusedNow(
  source: Pick<BillingSource, "limits">,
  current: string | null | undefined,
): string | null {
  const at = source.limits.refusedAt;
  if (typeof at !== "string") return null;
  const key = source.limits.refusedKey;
  if (typeof key === "string" && typeof current === "string" && current)
    return credentialFingerprint(current) === key ? at : null;
  return at;
}

/** `refusedNow` with the vault's credential read (only for a source that carries the mark). */
export async function refusedSince(
  source: Pick<BillingSource, "limits" | "credentialRef">,
  vault: Partial<Pick<Vault, "get">>,
): Promise<string | null> {
  if (typeof source.limits.refusedAt !== "string") return null;
  const current =
    vault.get && source.credentialRef
      ? await vault.get(source.credentialRef).catch(() => null)
      : null;
  return refusedNow(source, current);
}

/**
 * The time a source rests until after a usage limit (`limits.restingUntil`, ADR 0100), when it
 * is still ahead of `nowMs`; null when the source does not rest (or no longer).
 */
export function restingUntilOf(
  source: Pick<BillingSource, "limits">,
  nowMs: number,
): string | null {
  const until = source.limits.restingUntil;
  if (typeof until !== "string") return null;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > nowMs ? until : null;
}

/**
 * The person's order of their credentials (U-078, ADR 0100): `human.notify_prefs.billing_order`
 * as `settings.set billing_order` stores it, null when none is chosen (or it is malformed).
 */
export const BILLING_ORDER_SETTING = "billing_order";

export async function personOrderOf(
  store: Pick<StateStore, "human">,
  humanId: string,
): Promise<BillingSourceKind[] | null> {
  const human = await store.human.get(humanId).catch(() => null);
  return billingOrderOf(human?.notify_prefs?.[BILLING_ORDER_SETTING]);
}

/**
 * The order the non-task calls (chat, intake, the critic, the model watch, the monthly jobs) use
 * when the person chose none: ADR 0098's choice kept, the API key when there is one, else the
 * subscription (ADR 0100). Task runs keep the policy's per-purpose order.
 */
export const CALL_FALLBACK_ORDER: readonly BillingSourceKind[] = Object.freeze([
  "api_key",
  "plan_credits",
  "subscription",
]);

/** The audit row a rest after a usage limit writes (ADR 0100). */
export const BILLING_REST_AUDIT_TOOL = "billing.rest";

/**
 * What this install offers each credential (U-078, the chooser; ADR 0100 amended): the inputs of
 * `capabilitiesOf`, read by the composition (`RuntimeApp.chooserFacts`).
 */
export interface ChooserFacts {
  /** The loop driver's page reader is registered (`web_fetch`, unless `FORERUNNER_WEB_FETCH=off`). */
  webFetch: boolean;
  /**
   * Anthropic's web search on the API key ('web-search', the owner's decision of 2026-11-02): on
   * unless `FORERUNNER_WEB_SEARCH=off` or the account switched it off for every saved key (the
   * mark `wiring/web-search.ts` keeps on the key's billing source).
   */
  keySearch: boolean;
  /**
   * The account switched web search off for every saved API key (the mark a refusal leaves;
   * `keySearch` is then false): only the words read it, to say why ('web-search', review).
   */
  keySearchOff?: boolean;
  /**
   * Forerunner's page reader on the subscription ('sites', the owner's decision of 2026-11-02):
   * offered through the Agent SDK's tool server wherever the page reader is registered.
   */
  subscriptionPages: boolean;
  /** `cc:Bash` on the SDK path (`FORERUNNER_SDK_HOST_COMMANDS`): commands outside the sandbox. */
  hostCommands: boolean;
  /** Whether the Docker sandbox is ready (null: not known); only the words read it. */
  dockerReady?: boolean | null;
}

/**
 * The facts of an install with nothing switched (the page reader and web search on the API key,
 * no host commands).
 */
export const DEFAULT_CHOOSER_FACTS: ChooserFacts = Object.freeze({
  webFetch: true,
  keySearch: true,
  subscriptionPages: true,
  hostCommands: false,
  dockerReady: null,
});

/**
 * What a credential can do for a task on this install (U-078, the owner's decision of
 * 2026-11-02): the one place 'web-search' and 'sites' change for their kind.
 *
 * - **API key** (and plan credits; the loop driver): reads web pages when the page reader is on,
 *   searches with Anthropic's web search beside it unless search is switched off ('web-search',
 *   `keySearch`; never without the page reader, since a search result alone sources nothing),
 *   runs commands in the sandbox (Docker for a full review, which waits for it; ADR 0101), and
 *   can ask the person (`ask_person`, ADR 0095).
 * - **Claude subscription** (Claude Code through the Agent SDK): searches the web, opens no page
 *   until 'sites' lands (the hooks refuse every page: an entry's domain list is empty), runs no
 *   command unless host commands are on (no sandbox lease covers the subprocess), and cannot ask
 *   the person while it works (it lists its questions in its report).
 * - **fake** (an install without credentials): the loop driver, as the API key, without search
 *   (the stand-in model runs no server tool).
 */
export function capabilitiesOf(kind: BillingSourceKind, facts: ChooserFacts): CredentialAbilities {
  if (kind === "subscription")
    return {
      webRead: facts.subscriptionPages,
      // 'sites': Claude Code's search is offered only beside the page reader, as on the key: a
      // search result alone sources nothing.
      webSearch: facts.subscriptionPages,
      commands: facts.hostCommands,
      askPerson: false,
    };
  return {
    webRead: facts.webFetch,
    // A search is offered only beside the page reader: a result alone sources nothing.
    webSearch: kind !== "fake" && facts.keySearch && facts.webFetch,
    commands: true,
    askPerson: true,
  };
}

/**
 * How well a credential meets a task's hard needs, as a list compared item by item (higher is
 * better): how many it meets, then page reading, then search, then asking, then commands (the
 * owner's rule: "ranked by what it can do when none can do everything").
 */
export function needsScore(abilities: CredentialAbilities, needs: TaskNeeds): number[] {
  const met = (n: TaskNeed) => (needs.hard.includes(n) && abilities[n] ? 1 : 0);
  return [needs.hard.filter((n) => abilities[n]).length, ...TASK_NEEDS.map(met)];
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The items grouped by how well their credential meets the task's hard needs, best first (U-078):
 * the first group meets every hard need when any credential does. The person's order decides
 * inside a group; a later group is used only when no credential of the earlier ones can serve.
 * Without hard needs: one group, the order alone.
 */
export function groupByNeeds<T>(
  items: readonly T[],
  kindOf: (item: T) => BillingSourceKind,
  needs: TaskNeeds | undefined,
  facts: ChooserFacts,
): T[][] {
  if (!needs || needs.hard.length === 0 || items.length === 0) return [[...items]];
  const scored = items.map((item) => ({
    item,
    score: needsScore(capabilitiesOf(kindOf(item), facts), needs),
  }));
  const scores = [...new Set(scored.map((s) => s.score.join(",")))]
    .map((k) => k.split(",").map(Number))
    .sort(compareScores);
  return scores.map((score) =>
    scored.filter((s) => s.score.join(",") === score.join(",")).map((s) => s.item),
  );
}

/**
 * The credential a task runs on among the saved kinds (in the person's order, first used first),
 * and what that means (U-078): the first kind of the best group, the person's first choice, the
 * hard needs only the chosen one meets (`onlyIt`, said when it is not the first choice), the hard
 * needs it lacks (`lacks`: none meets them all) and the needs that only make the work better
 * that it lacks (`lost`). Null without a saved kind. Availability (a rest, a refusal, a cap) is
 * the router's; this is what each can do.
 */
export interface CredentialChoice {
  kind: BillingSourceKind;
  first: BillingSourceKind;
  /** What the chosen credential can do here, and the task's hard needs. */
  can: CredentialAbilities;
  hard: readonly TaskNeed[];
  onlyIt: TaskNeed[];
  lacks: TaskNeed[];
  lost: TaskNeed[];
}

export function chooseAmong(
  kindsInOrder: readonly BillingSourceKind[],
  needs: TaskNeeds,
  facts: ChooserFacts,
): CredentialChoice | null {
  const first = kindsInOrder[0];
  if (!first) return null;
  const kind = groupByNeeds(kindsInOrder, (k) => k, needs, facts)[0]?.[0] ?? first;
  return describeChoice(kind, first, needs, facts);
}

/** `CredentialChoice` for a credential the router picked (its reason in the audit row). */
export function describeChoice(
  kind: BillingSourceKind,
  first: BillingSourceKind,
  needs: TaskNeeds,
  facts: ChooserFacts,
): CredentialChoice {
  const can = capabilitiesOf(kind, facts);
  const firstCan = capabilitiesOf(first, facts);
  return {
    kind,
    first,
    can,
    hard: needs.hard,
    onlyIt: kind === first ? [] : needs.hard.filter((n) => can[n] && !firstCan[n]),
    lacks: needs.hard.filter((n) => !can[n]),
    lost: needs.better.filter((n) => !can[n]),
  };
}

/** This month's ledger facts for a source (see `VaultLedgerProbe`). */
export async function planUsageOf(
  store: Pick<StateStore, "costLedger">,
  clock: Clock,
  source: BillingSource,
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): Promise<PlanUsage> {
  const sum = await store.costLedger.sum({
    billingSourceId: source.id,
    ...monthWindow(clock.now()),
  });
  const allowance =
    typeof source.limits.planUsdMicro === "number" && source.limits.planUsdMicro > 0
      ? source.limits.planUsdMicro
      : null;
  const reported = typeof sum.plan_usage_share === "number" ? sum.plan_usage_share : null;
  const estimated = allowance ? sum.usd_micro / allowance : null;
  const share =
    reported === null && estimated === null
      ? null
      : Math.round(Math.max(reported ?? 0, estimated ?? 0) * 1_000_000) / 1_000_000;
  return {
    share,
    monthUsdMicro: sum.usd_micro,
    allowanceUsdMicro: allowance,
    cap: source.limits.planShareCap ?? policy.planShareCap,
  };
}

/**
 * The routing policy of this install: the package default, with subscriptions allowed off
 * the PC only on the human's personal runner (the PC itself is always theirs).
 */
export function pcRoutingPolicy(
  personalRunner: boolean,
  base: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): RoutingPolicy {
  return personalRunner ? { ...base, subscriptionOnCloudRunner: "always" } : base;
}

export interface RouterTaskBillingOptions {
  /**
   * `human` for the person's order, `auditLog` for the rest's and the refusal's audit rows (ADR
   * 0100), `humanRequest` for the refused credential's one card (U-078).
   */
  store: Pick<StateStore, "billingSource" | "costLedger" | "human" | "auditLog"> &
    Partial<Pick<StateStore, "humanRequest">>;
  /** `get` (optional) fingerprints a refused credential, so a new one ends the mark (U-078). */
  vault: Pick<Vault, "has"> & Partial<Pick<Vault, "get">>;
  clock: Clock;
  /** The human whose sources this install pays with (the daemon's human). */
  humanId: string;
  /** Whether this install is that human's own runner (the PC: true). */
  personalRunner?: boolean;
  /** Test seam: the probe in place of the vault-and-ledger one. */
  probe?: BillingSourceProbe;
  /** Test seam: the policy in place of `pcRoutingPolicy`. */
  policy?: RoutingPolicy;
  /**
   * What this install offers each credential (U-078, `capabilitiesOf`), read at every pick; the
   * composition passes its page reader and host-commands flags. Absent: `DEFAULT_CHOOSER_FACTS`.
   */
  facts?: () => ChooserFacts;
}

/**
 * `BillingRouter.pick` for one task on this install (ADR 0044). Inputs: the runner kind and
 * whether it is the human's personal runner (policy), the agent's owner against the daemon's
 * human (another human's agent never sees a subscription: the row is withheld before the
 * router runs and reported as skipped `other_human`), and the plan share from the ledger
 * against the caps (the probe). A subscription pick names the "sdk" driver, everything else
 * the "loop" driver.
 */
export class RouterTaskBilling implements TaskBillingPort {
  private readonly logger = log("billing-pick");
  private readonly policy: RoutingPolicy;
  private readonly probe: BillingSourceProbe;
  private readonly sources: (humanId: string) => Promise<BillingSource[]>;
  /** What this install offers each credential now (U-078). */
  readonly facts: () => ChooserFacts;

  constructor(private readonly opts: RouterTaskBillingOptions) {
    this.facts = opts.facts ?? (() => DEFAULT_CHOOSER_FACTS);
    this.policy = opts.policy ?? pcRoutingPolicy(opts.personalRunner ?? true);
    this.probe =
      opts.probe ??
      new VaultLedgerProbe({ vault: opts.vault, store: opts.store, clock: opts.clock });
    this.sources = stateSources(opts.store as StateStore);
  }

  async pick(req: TaskBillingRequest): Promise<TaskBillingPick> {
    const all = await this.sources(this.opts.humanId);
    const withheld: RouteSkip[] = [];
    const ownAgent = req.agentOwnerHumanId === this.opts.humanId;
    const excluded = new Set(req.exclude ?? []);
    // A `fake` row is the stand-in of an install without credentials: beside a real source it
    // is never a candidate, so a subscription at its cap and an API key at its limit end in
    // "no source" rather than real work billed to a row that is no credential.
    const realSource = all.some((s) => s.kind !== "fake");
    const candidates = all.filter((s) => {
      if (excluded.has(s.id)) {
        withheld.push({
          sourceId: s.id,
          kind: s.kind,
          code: "cooldown",
          reason: "it just met its usage limit on this call",
        });
        return false;
      }
      if (s.kind === "subscription" && !ownAgent) {
        withheld.push({
          sourceId: s.id,
          kind: s.kind,
          code: "other_human",
          reason:
            "the agent belongs to another human; a subscription is only used for its owner's agent",
        });
        return false;
      }
      if (s.kind === "fake" && realSource) {
        withheld.push({
          sourceId: s.id,
          kind: s.kind,
          code: "unavailable",
          reason:
            "a fake source is a stand-in for an install without credentials; never used beside a real source",
        });
        return false;
      }
      return true;
    });
    // The person's order (U-078, ADR 0100), read at every pick so a change in Settings applies
    // to the next call; without one, the caller's fallback order, else the purpose's own.
    const order = (await personOrderOf(this.opts.store, this.opts.humanId)) ?? req.fallbackOrder;
    const purpose = req.purpose ?? "session";
    // The chooser (U-078, the owner's decision of 2026-11-02): what the task needs against what
    // each credential can do here. The credentials that meet every hard need come first and the
    // person's order decides among them; another group only when none of the first can serve now
    // (a 'wait' for a first choice that rests holds, as in one group). This replaced C-64's
    // "research on the API key first" (`firstKinds`), a default the owner's decision superseded.
    const facts = this.facts();
    const groups = groupByNeeds(candidates, (s) => s.kind, req.needs, facts);
    const passed: RouteSkip[] = [];
    let decision: Awaited<ReturnType<BillingRouter["pick"]>> | null = null;
    let failed: ForerunnerError | null = null;
    for (const group of groups) {
      const router = new BillingRouter({ probe: this.probe, sources: group, policy: this.policy });
      try {
        decision = await router.pick({
          humanId: this.opts.humanId,
          agentId: req.agentId,
          runner: req.runner,
          purpose,
          modelTier: req.modelTier,
          ...(order?.length ? { order } : {}),
          ...(req.waitOnRest ? { waitOnRest: true } : {}),
        });
        break;
      } catch (e) {
        if (!(e instanceof ForerunnerError) || e.code !== "unavailable") throw e;
        const details = (e.details ?? {}) as { waitFor?: unknown; skipped?: RouteSkip[] };
        // 'Wait' holds to the first choice that can do the task: nothing moves to a group that
        // can do less of it.
        if (details.waitFor) throw withSkipped(e, [...passed, ...(details.skipped ?? [])]);
        passed.push(...(details.skipped ?? []));
        failed = e;
      }
    }
    if (!decision) {
      throw failed
        ? withSkipped(failed, passed)
        : new ForerunnerError("unavailable", `no billing source available for ${purpose} work`, {
            details: { skipped: passed as never },
          });
    }
    const skipped = [...withheld, ...passed, ...decision.skipped];
    let reason = decision.reason;
    if (req.needs && (req.needs.hard.length || req.needs.better.length)) {
      const kinds = [...new Set(candidates.map((s) => s.kind))].sort(
        (a, b) =>
          kindRank(a, order, this.policy, purpose) - kindRank(b, order, this.policy, purpose),
      );
      const said = choiceReason(
        describeChoice(decision.source.kind, kinds[0] ?? decision.source.kind, req.needs, facts),
      );
      if (said) reason += `; ${said}`;
    }
    if (withheld.length) {
      reason += `; withheld ${withheld.map((s) => `${s.kind} ${s.sourceId}: ${s.reason}`).join(", ")}`;
    }
    const plan =
      decision.source.kind === "subscription"
        ? await planUsageOf(this.opts.store, this.opts.clock, decision.source, this.policy)
        : null;
    const driver = decision.source.kind === "subscription" ? "sdk" : "loop";
    this.logger.info("billing source picked", {
      sourceId: decision.source.id,
      kind: decision.source.kind,
      driver,
      agentId: req.agentId,
      runner: req.runner,
      ...(plan?.share !== null && plan !== null ? { planUsageShare: plan.share } : {}),
    });
    return { source: decision.source, driver, reason, skipped, plan };
  }

  /**
   * The credential kinds a task of the human's own agent could run on here, in the order a task
   * pick uses (the person's, else the session policy's), first used first (U-078: the plan card,
   * New task and Settings say where work runs from this): enabled sources whose credential the
   * vault holds; never the fake stand-in. A rest or a refusal does not take a kind out: what each
   * can do is the chooser's question, whether it can serve now the router's.
   */
  async savedKinds(): Promise<BillingSourceKind[]> {
    const kinds: BillingSourceKind[] = [];
    for (const s of await this.sources(this.opts.humanId)) {
      if (s.kind === "fake" || kinds.includes(s.kind) || !s.credentialRef) continue;
      if (await this.opts.vault.has(s.credentialRef).catch(() => false)) kinds.push(s.kind);
    }
    const order = await personOrderOf(this.opts.store, this.opts.humanId);
    return kinds.sort(
      (a, b) =>
        kindRank(a, order, this.policy, "session") - kindRank(b, order, this.policy, "session"),
    );
  }

  /**
   * R-runsonrefused: the saved credentials that cannot serve now, by kind (the first source of a
   * kind decides): refused (its refusal stands for the credential the vault holds) or resting
   * (until its reset). `savedKinds` keeps them on purpose (what each can do is the chooser's
   * question); the runs-on words ask this, so they never promise a credential that waits.
   */
  async blockedKinds(): Promise<Map<BillingSourceKind, CredentialWait>> {
    const out = new Map<BillingSourceKind, CredentialWait>();
    const now = this.opts.clock.now();
    for (const s of await this.sources(this.opts.humanId)) {
      if (s.kind === "fake" || out.has(s.kind) || !s.credentialRef) continue;
      if (await refusedSince(s, this.opts.vault)) {
        out.set(s.kind, { reason: "refused", sourceId: s.id, kind: s.kind, until: null });
        continue;
      }
      const until = restingUntilOf(s, now);
      if (until) out.set(s.kind, { reason: "limit", sourceId: s.id, kind: s.kind, until });
    }
    return out;
  }

  /**
   * The source met its provider's usage limit (ADR 0100): `limits.restingUntil` on its row
   * (the reported reset when it is ahead, else an hour), so every later pick, after a restart
   * too, skips it with `cooldown` until then; one `billing.rest` audit row. Returns the time.
   */
  async rest(sourceId: string, resetAt: string | undefined, why: string): Promise<string> {
    const until = restUntil(resetAt, this.opts.clock.now());
    const row = await updateSourceLimits(this.opts.store, sourceId, (limits) => ({
      ...limits,
      restingUntil: until,
    }));
    this.logger.warn("billing source rests after a usage limit", { sourceId, until });
    await this.opts.store.auditLog
      .append({
        tool: BILLING_REST_AUDIT_TOOL,
        allowed: true,
        human_id: this.opts.humanId,
        input_summary: JSON.stringify({
          sourceId,
          kind: row?.kind ?? null,
          resetAt: resetAt ?? null,
        }),
        result_summary: `rests until ${until}: ${why}`.slice(0, 500),
        occurred_at: this.opts.clock.nowIso(),
      })
      .catch(() => undefined);
    return until;
  }

  /**
   * Anthropic refused the source's credential (U-078: a 401 or 403 key, an expired sign-in):
   * `limits.refusedAt` with the refused credential's fingerprint, so every later pick skips it
   * (`refused`) until a new one is saved, after a restart too; one `billing.refused` audit row;
   * and one Inbox card per credential ("Anthropic refused your API key. Save a new one in
   * Settings."), filed once while the mark stands. A second refusal of the same credential
   * changes nothing.
   */
  async refuse(sourceId: string, why: string): Promise<void> {
    const row = await this.opts.store.billingSource.get(sourceId);
    if (!row) return;
    const current =
      this.opts.vault.get && row.credential_ref
        ? await this.opts.vault.get(row.credential_ref).catch(() => null)
        : null;
    const fingerprint = current ? credentialFingerprint(current) : undefined;
    const known = (limits: JsonObject) =>
      typeof limits.refusedAt === "string" &&
      (fingerprint === undefined || limits.refusedKey === fingerprint);
    const words = redact(current ? why.split(current).join("[REDACTED]") : why).slice(0, 300);
    let marked = false;
    if (!known(row.limits as JsonObject))
      await updateSourceLimits(this.opts.store, row.id, (limits) => {
        // Another refusal of the same credential may have marked it meanwhile.
        marked = !known(limits);
        return marked
          ? {
              ...limits,
              refusedAt: this.opts.clock.nowIso(),
              ...(fingerprint ? { refusedKey: fingerprint } : {}),
              refusedWhy: words,
            }
          : null;
      });
    if (marked) {
      this.logger.warn("billing source refused: its credential was not accepted", {
        sourceId,
        kind: row.kind,
      });
      await this.opts.store.auditLog
        .append({
          tool: BILLING_REFUSED_AUDIT_TOOL,
          allowed: true,
          human_id: this.opts.humanId,
          input_summary: JSON.stringify({ sourceId, kind: row.kind }),
          result_summary: `refused: ${words}`.slice(0, 500),
          occurred_at: this.opts.clock.nowIso(),
        })
        .catch(() => undefined);
    }
    if (this.opts.store.humanRequest && row.kind !== "fake")
      await fileRefusedCard(this.opts.store as Pick<StateStore, "humanRequest">, {
        humanId: this.opts.humanId,
        agentId: null,
        sourceId: row.id,
        kind: row.kind,
      }).catch((e: unknown) =>
        this.logger.warn("the refused credential's card was not filed", {
          sourceId,
          error: errorMessage(e),
        }),
      );
  }

  /**
   * A project's work waits for this source (its reset, or a new credential; U-078): kept on the
   * source (`limits.waiting`), so `takeReady` starts its session by itself once the source can
   * serve again, after a restart too. One entry per project.
   */
  async noteWait(sourceId: string, projectId: string, agentId: string): Promise<void> {
    await updateSourceLimits(this.opts.store, sourceId, (limits) => {
      const waiting = waitingOf(limits);
      if (waiting.some((w) => w.projectId === projectId)) return null;
      return {
        ...limits,
        waiting: [...waiting, { projectId, agentId, since: this.opts.clock.nowIso() }],
      };
    });
  }

  /**
   * The projects whose wait is over now (U-078): every source with waiting projects that serves
   * again (its rest ended, and no refusal stands: a new credential was saved). Their entries are
   * taken off the source, and a refusal a new credential ended is cleared with its card; the
   * caller starts each project's session. A source still resting or refused keeps its list,
   * except a project whose work another credential serves now (`servesNow`, R-refusedstays: a
   * subscription saved while the only key is refused; before, its tasks kept "Waits for a new
   * API key" and nothing started). `servesNow` asks the billing pick as the task runs would, so
   * 'Wait' still holds work to a first choice that rests or was refused.
   */
  async takeReady(
    servesNow?: (projectId: string) => Promise<boolean>,
  ): Promise<{ projectId: string; agentId: string; sourceId: string }[]> {
    const rows = await this.opts.store.billingSource.list(
      { human_id: this.opts.humanId },
      { limit: 100 },
    );
    const out: { projectId: string; agentId: string; sourceId: string }[] = [];
    const now = this.opts.clock.now();
    for (const listed of rows) {
      // Read and written with the version check (R-limitsrmw): a wait noted, a rest or a
      // refusal written meanwhile is read again, so it is either taken here or kept.
      let taken: { projectId: string; agentId: string; since: string }[] = [];
      let stale = false;
      if (typeof listed.limits.refusedAt !== "string" && !waitingOf(listed.limits).length) continue;
      // The credential the vault holds now (async, so read before the write). Whether the
      // source is refused is judged from the copy each write works on (TR-4): a refusal written
      // between the list above and the write is of the credential the vault holds, so it is
      // kept; before, it was judged from the listed copy, read as stale and cleared with its
      // card, and the work that waited started on the refused credential.
      const credentialRef = listed.credential_ref ?? "";
      const current =
        this.opts.vault.get && credentialRef
          ? await this.opts.vault.get(credentialRef).catch(() => null)
          : null;
      const refusedIn = (limits: JsonObject) =>
        refusedNow({ limits: limits as BillingSource["limits"] }, current) !== null;
      const refused = refusedIn(listed.limits as JsonObject);
      // A source that cannot serve: the projects whose work another credential serves now
      // (async, so asked before the write).
      const servedElsewhere = new Set<string>();
      const stuck =
        refused || !!restingUntilOf({ limits: listed.limits as BillingSource["limits"] }, now);
      if (stuck && servesNow)
        for (const w of waitingOf(listed.limits))
          if (await servesNow(w.projectId).catch(() => false)) servedElsewhere.add(w.projectId);
      await updateSourceLimits(this.opts.store, listed.id, (limits) => {
        const refusedHere = refusedIn(limits);
        stale = typeof limits.refusedAt === "string" && !refusedHere;
        const waiting = waitingOf(limits);
        const free =
          !refusedHere && !restingUntilOf({ limits: limits as BillingSource["limits"] }, now);
        taken = free ? waiting : waiting.filter((w) => servedElsewhere.has(w.projectId));
        const kept = free ? [] : waiting.filter((w) => !servedElsewhere.has(w.projectId));
        if (!stale && !taken.length) return null;
        const { refusedAt: _a, refusedKey: _k, refusedWhy: _w, waiting: _l, ...rest } = limits;
        return {
          ...rest,
          ...(refusedHere && limits.refusedAt ? { refusedAt: limits.refusedAt } : {}),
          ...(refusedHere && limits.refusedKey ? { refusedKey: limits.refusedKey } : {}),
          ...(refusedHere && limits.refusedWhy ? { refusedWhy: limits.refusedWhy } : {}),
          ...(kept.length ? { waiting: kept } : {}),
        };
      });
      const row = listed;
      if (stale && this.opts.store.humanRequest)
        await closeRefusedCards(
          this.opts.store as Pick<StateStore, "humanRequest">,
          this.opts.humanId,
          row.id,
        ).catch(() => undefined);
      for (const w of taken) out.push({ ...w, sourceId: row.id });
    }
    return out;
  }

  /**
   * A new credential of `kind` was saved (the setup assistant, U-078): its source's refusal
   * ends at once, whatever the vault can tell (`takeReady` clears it on the next pass too).
   */
  async credentialSaved(kind: "api_key" | "subscription"): Promise<void> {
    const rows = await this.opts.store.billingSource.list(
      { human_id: this.opts.humanId },
      { limit: 100 },
    );
    for (const row of rows) {
      if (row.kind !== kind || typeof row.limits.refusedAt !== "string") continue;
      await updateSourceLimits(this.opts.store, row.id, (limits) => {
        if (typeof limits.refusedAt !== "string") return null;
        const { refusedAt: _a, refusedKey: _k, refusedWhy: _w, ...rest } = limits;
        return rest;
      });
      if (this.opts.store.humanRequest)
        await closeRefusedCards(
          this.opts.store as Pick<StateStore, "humanRequest">,
          this.opts.humanId,
          row.id,
        ).catch(() => undefined);
    }
  }
}

/** The router's "no source" again, with every group's skipped sources (the wait words read them). */
function withSkipped(e: ForerunnerError, skipped: readonly RouteSkip[]): ForerunnerError {
  return new ForerunnerError(e.code, e.message, {
    details: { ...((e.details ?? {}) as object), skipped: skipped as never },
  });
}

/** A kind's place in the order a pick uses: the person's (or the caller's), else the purpose's. */
function kindRank(
  kind: BillingSourceKind,
  order: readonly BillingSourceKind[] | null | undefined,
  policy: RoutingPolicy,
  purpose: NonNullable<TaskBillingRequest["purpose"]>,
): number {
  const pref = policy.preference[purpose] ?? [];
  const p = pref.indexOf(kind);
  const own = p >= 0 ? p : pref.length;
  if (!order?.length) return own;
  const i = order.indexOf(kind);
  return i >= 0 ? i : order.length + own;
}

/** What the needs did to a pick, for its audit row (the person reads `choiceLine`'s words). */
function choiceReason(c: CredentialChoice): string | null {
  const words = (ns: readonly TaskNeed[]) => ns.join(", ");
  const parts: string[] = [];
  if (c.onlyIt.length)
    parts.push(`only ${c.kind} meets ${words(c.onlyIt)} (first choice ${c.first})`);
  if (c.lacks.length)
    parts.push(`no credential meets every hard need; ${c.kind} lacks ${words(c.lacks)}`);
  if (c.lost.length)
    parts.push(`${c.kind} lacks ${words(c.lost)}, which only makes the work better`);
  return parts.length ? `chooser: ${parts.join("; ")}` : null;
}

/**
 * Change one billing source's `limits` with the store's version check (R-limitsrmw): `change`
 * gets the limits as stored now and returns the new ones (null: nothing to write); a write
 * another one beat is read again and changed again, so two writes landing together both stand
 * (before, each wrote back the copy it had read, and one was lost). Returns the row as written,
 * or undefined when it is gone. `change` may run more than once: it must not act, only compute.
 */
export async function updateSourceLimits(
  store: { billingSource: Pick<StateStore["billingSource"], "get" | "update"> },
  sourceId: string,
  change: (limits: JsonObject, row: BillingSourceRow) => JsonObject | null,
): Promise<BillingSourceRow | undefined> {
  for (let attempt = 1; ; attempt++) {
    const row = await store.billingSource.get(sourceId);
    if (!row) return undefined;
    const next = change({ ...(row.limits as JsonObject) }, row);
    if (next === null) return row;
    try {
      return await store.billingSource.update(row.id, row.version, { limits: next });
    } catch (e) {
      if (e instanceof ForerunnerError && e.code === "version_conflict" && attempt < LIMITS_TRIES)
        continue;
      throw e;
    }
  }
}

/** How often a limits write that another write beat is tried again (`updateSourceLimits`). */
const LIMITS_TRIES = 8;

/** The projects that wait for a source (`limits.waiting`, U-078), well-formed entries only. */
export function waitingOf(
  limits: Record<string, unknown>,
): { projectId: string; agentId: string; since: string }[] {
  const list = Array.isArray(limits.waiting) ? limits.waiting : [];
  return list.flatMap((w) => {
    if (!w || typeof w !== "object") return [];
    const { projectId, agentId, since } = w as Record<string, unknown>;
    return typeof projectId === "string" && typeof agentId === "string"
      ? [{ projectId, agentId, since: typeof since === "string" ? since : "" }]
      : [];
  });
}

/** `FORERUNNER_SDK_HOST_COMMANDS`: "1" grants `cc:Bash` on the SDK path (see `SdkExecutorDeps.hostCommands`). */
export const SDK_HOST_COMMANDS_ENV = "FORERUNNER_SDK_HOST_COMMANDS";

/** Whether `cc:Bash` runs where the Claude Code subprocess runs: the option, else the env flag, else off. */
export function sdkHostCommandsEnabled(env: NodeJS.ProcessEnv, override?: boolean): boolean {
  if (override !== undefined) return override;
  return env[SDK_HOST_COMMANDS_ENV]?.trim() === "1";
}
