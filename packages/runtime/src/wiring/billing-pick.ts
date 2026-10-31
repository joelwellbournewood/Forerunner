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
import { log } from "@forerunner/platform";
import type { BillingSourceRow, StateStore } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";
import { restUntil } from "../provider/usage-limit.ts";
import type {
  PlanUsage,
  TaskBillingPick,
  TaskBillingPort,
  TaskBillingRequest,
} from "../session/billing.ts";
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
      vault: Pick<Vault, "has">;
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
    return {
      available: true,
      checkedAt,
      monthSpentUsdMicro: usage.monthUsdMicro,
      ...(usage.share !== null ? { planUsageShare: usage.share } : {}),
      ...(resting ? { restingUntil: resting } : {}),
    };
  }
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
  /** `human` for the person's order, `auditLog` for the rest's audit row (ADR 0100). */
  store: Pick<StateStore, "billingSource" | "costLedger" | "human" | "auditLog">;
  vault: Pick<Vault, "has">;
  clock: Clock;
  /** The human whose sources this install pays with (the daemon's human). */
  humanId: string;
  /** Whether this install is that human's own runner (the PC: true). */
  personalRunner?: boolean;
  /** Test seam: the probe in place of the vault-and-ledger one. */
  probe?: BillingSourceProbe;
  /** Test seam: the policy in place of `pcRoutingPolicy`. */
  policy?: RoutingPolicy;
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

  constructor(private readonly opts: RouterTaskBillingOptions) {
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
    const router = new BillingRouter({
      probe: this.probe,
      sources: candidates,
      policy: this.policy,
    });
    // The person's order (U-078, ADR 0100), read at every pick so a change in Settings applies
    // to the next call; without one, the caller's fallback order, else the purpose's own.
    const order = (await personOrderOf(this.opts.store, this.opts.humanId)) ?? req.fallbackOrder;
    const decision = await router.pick({
      humanId: this.opts.humanId,
      agentId: req.agentId,
      runner: req.runner,
      purpose: req.purpose ?? "session",
      modelTier: req.modelTier,
      ...(order?.length ? { order } : {}),
    });
    const skipped = [...withheld, ...decision.skipped];
    let reason = decision.reason;
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
   * The source met its provider's usage limit (ADR 0100): `limits.restingUntil` on its row
   * (the reported reset when it is ahead, else an hour), so every later pick, after a restart
   * too, skips it with `cooldown` until then; one `billing.rest` audit row. Returns the time.
   */
  async rest(sourceId: string, resetAt: string | undefined, why: string): Promise<string> {
    const until = restUntil(resetAt, this.opts.clock.now());
    const row = await this.opts.store.billingSource.get(sourceId);
    if (row) {
      await this.opts.store.billingSource.patch(row.id, {
        limits: { ...row.limits, restingUntil: until },
      });
    }
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
}

/** `FORERUNNER_SDK_HOST_COMMANDS`: "1" grants `cc:Bash` on the SDK path (see `SdkExecutorDeps.hostCommands`). */
export const SDK_HOST_COMMANDS_ENV = "FORERUNNER_SDK_HOST_COMMANDS";

/** Whether `cc:Bash` runs where the Claude Code subprocess runs: the option, else the env flag, else off. */
export function sdkHostCommandsEnabled(env: NodeJS.ProcessEnv, override?: boolean): boolean {
  if (override !== undefined) return override;
  return env[SDK_HOST_COMMANDS_ENV]?.trim() === "1";
}
