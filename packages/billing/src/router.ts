/**
 * Billing routing: which source pays for a call.
 *
 * The provider's rules about subscriptions, plan credits and API keys changed several times
 * in 2026, so the rules live in one data object, RoutingPolicy. A provider rule change is a
 * change to DEFAULT_ROUTING_POLICY (or to the policy a deployment passes in), not to the
 * router code. Two rules are not policy and cannot be configured away:
 *   1. a source is only ever used for its owner's agent (spec: plans are for individual use);
 *   2. a disabled source is never used.
 */
import { ForerunnerError } from "@forerunner/platform";
import type {
  BillingSource,
  BillingSourceKind,
  BillingSourceProbe,
  BillingSourceStatus,
} from "./sources.ts";

export type Runner = "pc" | "cloud";
export type Purpose = "interactive" | "session" | "batch" | "critic" | "chat";
/** Ladder tiers; open so a policy can name future tiers. */
export type ModelTier = "haiku" | "sonnet" | "opus" | "fable" | (string & {});

export interface RouteContext {
  humanId: string;
  agentId: string;
  runner: Runner;
  purpose: Purpose;
  modelTier: ModelTier;
  /**
   * The person's order of their credential kinds (U-078, ADR 0100), first used first. When
   * set, the survivors are sorted by it for every purpose; a kind it does not name comes after
   * the named ones, in the purpose's own order. The purpose's `preference` still decides which
   * kinds the purpose may use at all. Absent or empty: the purpose's `preference` orders them.
   */
  order?: readonly BillingSourceKind[];
  /**
   * "When my first choice runs out mid-session: Wait" (U-078, the owner's decision of
   * 2026-11-02, ADR 0100 amended): a source that rests after a usage limit, or whose credential
   * Anthropic refused (the session lead's default of 2026-11-03), and ranks ahead of every
   * source that could serve makes the pick wait for it instead of moving on: the pick throws
   * `unavailable` with `details.waitFor` (the source, its kind, until when or null, and
   * `reason` `limit` or `refused`). Off ("Use the other one", and every non-task call): the
   * next source serves, as before.
   */
  waitOnRest?: boolean;
}

export interface RoutingPolicy {
  /** Plan usage share at or above which a subscription is skipped (source limits override). */
  planShareCap: number;
  /** When a subscription may be used on the cloud runner. */
  subscriptionOnCloudRunner: "never" | "personal_runner_only" | "always";
  /** Kinds in order of preference per purpose; kinds not listed are never used for it. */
  preference: Record<Purpose, readonly BillingSourceKind[]>;
  /** Optional: kinds allowed per model tier (e.g. top tier only on API-style sources). */
  kindsForTier?: Partial<Record<string, readonly BillingSourceKind[]>>;
}

export const DEFAULT_PLAN_SHARE_CAP = 0.95;

const SUBSCRIPTION_FIRST: readonly BillingSourceKind[] = [
  "subscription",
  "plan_credits",
  "api_key",
  "fake",
];
const API_FIRST: readonly BillingSourceKind[] = ["api_key", "plan_credits", "subscription", "fake"];

/** Spec defaults: subscription first, API key as fallback and for batch and cloud work. */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = Object.freeze({
  planShareCap: DEFAULT_PLAN_SHARE_CAP,
  subscriptionOnCloudRunner: "personal_runner_only",
  preference: Object.freeze({
    interactive: SUBSCRIPTION_FIRST,
    session: SUBSCRIPTION_FIRST,
    chat: SUBSCRIPTION_FIRST,
    critic: SUBSCRIPTION_FIRST,
    batch: API_FIRST,
  }),
}) as RoutingPolicy;

/**
 * The kinds a person puts in order (U-078, ADR 0100): every real credential kind. The fake
 * source is the stand-in of an install without credentials and is never theirs to order.
 */
export const ORDERABLE_KINDS: readonly BillingSourceKind[] = Object.freeze([
  "subscription",
  "api_key",
  "plan_credits",
]);

/**
 * A person's order as stored (`human.notify_prefs.billing_order`): a non-empty list of
 * distinct orderable kinds. Anything else (absent, malformed, a duplicate, `fake`) is null,
 * which means no order is chosen and the defaults apply.
 */
export function billingOrderOf(value: unknown): BillingSourceKind[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: BillingSourceKind[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !ORDERABLE_KINDS.includes(v as BillingSourceKind)) return null;
    if (out.includes(v as BillingSourceKind)) return null;
    out.push(v as BillingSourceKind);
  }
  return out;
}

export type SkipCode =
  | "other_human"
  | "disabled"
  | "cloud_runner"
  | "unavailable"
  /** The source met its provider's usage limit and rests until `status.restingUntil` (ADR 0100). */
  | "cooldown"
  /** Anthropic refused the source's credential; it serves again once a new one is saved (U-078). */
  | "refused"
  | "plan_share"
  | "monthly_limit"
  | "tier"
  | "purpose";

export interface RouteSkip {
  sourceId: string;
  kind: BillingSourceKind;
  code: SkipCode;
  reason: string;
  /** `cooldown`: the ISO time the source may serve again. */
  until?: string;
}

export interface RouteDecision {
  source: BillingSource;
  status: BillingSourceStatus;
  reason: string;
  skipped: RouteSkip[];
}

export type SourceLister = (
  humanId: string,
) => Promise<readonly BillingSource[]> | readonly BillingSource[];

export interface BillingRouterOptions {
  probe: BillingSourceProbe;
  /** All sources, or a function returning the sources for a human. */
  sources: readonly BillingSource[] | SourceLister;
  policy?: RoutingPolicy;
}

function pct(share: number): string {
  return `${Math.round(share * 1000) / 10}%`;
}

export class BillingRouter {
  private readonly probe: BillingSourceProbe;
  private readonly lister: SourceLister;
  readonly policy: RoutingPolicy;

  constructor(opts: BillingRouterOptions) {
    this.probe = opts.probe;
    const sources = opts.sources;
    this.lister = typeof sources === "function" ? sources : () => sources;
    this.policy = opts.policy ?? DEFAULT_ROUTING_POLICY;
  }

  async pick(ctx: RouteContext): Promise<RouteDecision> {
    const all = await this.lister(ctx.humanId);
    const skipped: RouteSkip[] = [];
    const preference = this.policy.preference[ctx.purpose];
    if (!preference) {
      throw new ForerunnerError(
        "validation",
        `routing policy has no entry for purpose "${ctx.purpose}"`,
      );
    }
    const tierKinds = this.policy.kindsForTier?.[ctx.modelTier];

    const candidates: { source: BillingSource; status: BillingSourceStatus; rank: number }[] = [];
    /** Sources resting after a usage limit, with their rank (the 'wait' rule reads them). */
    const resting: { source: BillingSource; rank: number; until: string }[] = [];
    /** Sources whose credential was refused, with their rank (the 'wait' rule reads them too). */
    const refused: { source: BillingSource; rank: number }[] = [];
    for (const source of all) {
      // Invariant, not policy: never another human's source.
      if (source.humanId !== ctx.humanId) {
        skipped.push(skip(source, "other_human", "belongs to another human"));
        continue;
      }
      if (!source.enabled) {
        skipped.push(skip(source, "disabled", "disabled"));
        continue;
      }
      const rank = preference.indexOf(source.kind);
      if (rank < 0) {
        skipped.push(skip(source, "purpose", `${source.kind} is not used for ${ctx.purpose} work`));
        continue;
      }
      if (tierKinds && !tierKinds.includes(source.kind)) {
        skipped.push(
          skip(source, "tier", `${source.kind} is not allowed for tier ${ctx.modelTier}`),
        );
        continue;
      }
      if (source.kind === "subscription" && ctx.runner === "cloud") {
        const mode = this.policy.subscriptionOnCloudRunner;
        const allowed =
          mode === "always" ||
          (mode === "personal_runner_only" && source.limits.personalRunner === true);
        if (!allowed) {
          skipped.push(
            skip(source, "cloud_runner", "subscriptions are not used on a shared cloud runner"),
          );
          continue;
        }
      }
      const status = await this.probe.status(source);
      if (!status.available) {
        skipped.push(skip(source, "unavailable", status.reason ?? "not available"));
        continue;
      }
      if (status.refused) {
        skipped.push(skip(source, "refused", `its credential was refused at ${status.refused}`));
        // 'Wait' holds to a refused first choice too (U-078, the session lead's default of
        // 2026-11-03): its work waits for a new credential rather than move onto another one.
        refused.push({ source, rank: rankOf(source.kind, rank, ctx.order) });
        continue;
      }
      if (status.restingUntil) {
        skipped.push({
          ...skip(source, "cooldown", `resting after a usage limit until ${status.restingUntil}`),
          until: status.restingUntil,
        });
        resting.push({
          source,
          rank: rankOf(source.kind, rank, ctx.order),
          until: status.restingUntil,
        });
        continue;
      }
      if (source.kind === "subscription" && typeof status.planUsageShare === "number") {
        const cap = source.limits.planShareCap ?? this.policy.planShareCap;
        if (status.planUsageShare >= cap) {
          skipped.push(
            skip(
              source,
              "plan_share",
              `plan usage ${pct(status.planUsageShare)} is at or above the cap ${pct(cap)}`,
            ),
          );
          continue;
        }
      }
      if (
        typeof source.limits.monthlyUsdMicro === "number" &&
        typeof status.monthSpentUsdMicro === "number" &&
        status.monthSpentUsdMicro >= source.limits.monthlyUsdMicro
      ) {
        skipped.push(skip(source, "monthly_limit", "monthly limit for this source reached"));
        continue;
      }
      candidates.push({ source, status, rank: rankOf(source.kind, rank, ctx.order) });
    }

    candidates.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.source.priority - b.source.priority ||
        (a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0),
    );
    const chosen = candidates[0];
    const details = () => ({
      humanId: ctx.humanId,
      agentId: ctx.agentId,
      purpose: ctx.purpose,
      runner: ctx.runner,
      skipped: skipped.map((s) => ({
        sourceId: s.sourceId,
        kind: s.kind,
        code: s.code,
        reason: s.reason,
        ...(s.until ? { until: s.until } : {}),
      })),
    });
    // 'Wait' (U-078): the first choice rests, or Anthropic refused it, so nothing moves onto a
    // later one: the work waits for its reset, or for a new credential.
    const held: { source: BillingSource; rank: number; until: string | null }[] = [
      ...resting,
      ...refused.map((r) => ({ ...r, until: null })),
    ];
    held.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.source.priority - b.source.priority ||
        (a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0),
    );
    const first = held[0];
    if (
      ctx.waitOnRest &&
      first &&
      (!chosen ||
        first.rank < chosen.rank ||
        (first.rank === chosen.rank && first.source.priority < chosen.source.priority))
    ) {
      throw new ForerunnerError(
        "unavailable",
        first.until
          ? `the first choice for ${ctx.purpose} work rests until ${first.until}; waiting for it`
          : `the first choice for ${ctx.purpose} work was refused; waiting for a new credential`,
        {
          details: {
            ...details(),
            waitFor: {
              sourceId: first.source.id,
              kind: first.source.kind,
              until: first.until,
              reason: first.until ? "limit" : "refused",
            },
          },
        },
      );
    }
    if (!chosen) {
      throw new ForerunnerError(
        "unavailable",
        `no billing source available for ${ctx.purpose} work on the ${ctx.runner} runner`,
        { details: details() },
      );
    }

    let reason = `${chosen.source.kind} "${chosen.source.label}" for ${ctx.purpose} work on the ${ctx.runner} runner`;
    if (ctx.order?.length) reason += ` (your order: ${ctx.order.join(", ")})`;
    if (chosen.source.kind === "subscription" && typeof chosen.status.planUsageShare === "number") {
      const cap = chosen.source.limits.planShareCap ?? this.policy.planShareCap;
      reason += ` (plan usage ${pct(chosen.status.planUsageShare)} below the cap ${pct(cap)})`;
    }
    if (skipped.length > 0) {
      reason += `; skipped ${skipped.map((s) => `${s.kind} ${s.sourceId}: ${s.reason}`).join(", ")}`;
    }
    return { source: chosen.source, status: chosen.status, reason, skipped };
  }
}

/**
 * A survivor's rank: its place in the person's order when there is one (a kind the order does
 * not name ranks after every named kind, in the purpose's order), else its place in the
 * purpose's preference.
 */
function rankOf(
  kind: BillingSourceKind,
  preferenceRank: number,
  order: readonly BillingSourceKind[] | undefined,
): number {
  if (!order || order.length === 0) return preferenceRank;
  const i = order.indexOf(kind);
  return i >= 0 ? i : order.length + preferenceRank;
}

function skip(source: BillingSource, code: SkipCode, reason: string): RouteSkip {
  return { sourceId: source.id, kind: source.kind, code, reason };
}
