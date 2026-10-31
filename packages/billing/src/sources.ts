/**
 * Billing sources: how a human pays for model calls (spec "Model access and billing").
 *
 * A source never holds a credential. `credentialRef` is the name of a secret in the vault
 * (e.g. "anthropic_api_key"); the runtime resolves it when it builds the provider client.
 */
import { ForerunnerError } from "@forerunner/platform";
import { z } from "zod";

export type BillingSourceKind = "subscription" | "plan_credits" | "api_key" | "fake";

export const BILLING_SOURCE_KINDS: readonly BillingSourceKind[] = [
  "subscription",
  "plan_credits",
  "api_key",
  "fake",
];

/** Mirrors the state package's COST_KINDS: how an entry is labelled in the cost ledger. */
export type CostKind = "api" | "subscription" | "plan_credits";

export interface BillingSourceLimits {
  /** Hard monthly spend limit for this source in usd_micro (API-style sources). */
  monthlyUsdMicro?: number;
  /** Plan usage share (0..1) above which a subscription is not routed to. */
  planShareCap?: number;
  /**
   * The plan's allowance as an estimated API-equivalent in usd_micro per UTC month
   * (subscriptions). With it the runtime computes the plan usage share from the month's
   * "subscription" ledger rows; without it the share is whatever the last probe or run
   * reported (ADR 0044).
   */
  planUsdMicro?: number;
  /**
   * True when the cloud runner that would use this subscription is the owner's personal
   * runner. Only then may a subscription be used off the owner's PC (spec, Security).
   */
  personalRunner?: boolean;
  /**
   * ISO time until which the source rests: its provider answered that the plan's or the
   * account's usage limit is reached (U-078, ADR 0100). Until then the daemon's probe reports
   * it and the router skips the source (`cooldown`); a time in the past means nothing.
   */
  restingUntil?: string;
}

export interface BillingSource {
  id: string;
  kind: BillingSourceKind;
  /** Owner. A source is never used for another human's agent. */
  humanId: string;
  label: string;
  /** Secret reference name in the vault, never a value. */
  credentialRef: string;
  enabled: boolean;
  /** Routing priority among sources of the same kind; lower first. */
  priority: number;
  limits: BillingSourceLimits;
}

export interface BillingSourceStatus {
  available: boolean;
  /** 0..1 share of the plan limit used so far (subscriptions). */
  planUsageShare?: number;
  /** Spend this month in usd_micro, when the probe knows it (API-style sources). */
  monthSpentUsdMicro?: number;
  /**
   * Set while the source rests after a usage limit: the ISO time it may serve again (ADR 0100).
   * A probe sets it only for a time still ahead; the router then skips the source with code
   * `cooldown`.
   */
  restingUntil?: string;
  reason?: string;
  checkedAt?: string;
}

export interface BillingSourceProbe {
  status(source: BillingSource): Promise<BillingSourceStatus>;
}

/** Ledger kind for a source kind. The fake provider bills like the API (exact cost). */
export function ledgerKindFor(kind: BillingSourceKind): CostKind {
  switch (kind) {
    case "subscription":
      return "subscription";
    case "plan_credits":
      return "plan_credits";
    case "api_key":
    case "fake":
      return "api";
    default: {
      const never: never = kind;
      throw new ForerunnerError("validation", `unknown billing source kind ${String(never)}`);
    }
  }
}

/** Subscription usage has no per-token price; its ledger entries are API-equivalent estimates. */
export function isEstimatedKind(kind: BillingSourceKind): boolean {
  return kind === "subscription";
}

const LOOKS_LIKE_A_VALUE =
  /^(sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[baprs]-|akia|ey[jh])/i;
const REF_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/**
 * A credential reference is a short name, not a secret. Rejects anything shaped like a
 * token so a pasted key cannot end up in the state store. The message never echoes the value.
 */
export function assertCredentialRef(ref: string): string {
  if (typeof ref !== "string" || !REF_NAME.test(ref) || LOOKS_LIKE_A_VALUE.test(ref)) {
    throw new ForerunnerError(
      "validation",
      "credentialRef must be a secret reference name, not a credential value",
      { details: { length: typeof ref === "string" ? ref.length : 0 } },
    );
  }
  return ref;
}

const limitsSchema = z
  .object({
    monthlyUsdMicro: z.number().int().nonnegative().optional(),
    planShareCap: z.number().min(0).max(1).optional(),
    planUsdMicro: z.number().int().positive().optional(),
    personalRunner: z.boolean().optional(),
    restingUntil: z.string().optional(),
  })
  .strict();

export const billingSourceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["subscription", "plan_credits", "api_key", "fake"]),
    humanId: z.string().min(1),
    label: z.string().min(1).max(120),
    credentialRef: z.string(),
    enabled: z.boolean(),
    priority: z.number().int(),
    limits: limitsSchema,
  })
  .strict();

/** Validate a source record (shape plus the credentialRef rule). */
export function assertBillingSource(input: unknown): BillingSource {
  const parsed = billingSourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new ForerunnerError("validation", "invalid billing source", {
      details: { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
    });
  }
  assertCredentialRef(parsed.data.credentialRef);
  return parsed.data;
}

/** Convenience for tests and setup: a source with sensible defaults. */
export function makeBillingSource(
  partial: Pick<BillingSource, "id" | "kind" | "humanId"> & Partial<BillingSource>,
): BillingSource {
  return assertBillingSource({
    label: `${partial.kind} ${partial.id}`,
    credentialRef: partial.kind === "fake" ? "fake_provider" : `${partial.kind}_${partial.id}`,
    enabled: true,
    priority: 100,
    limits: {},
    ...partial,
  });
}

/** Probe for tests: statuses set by source id; unknown sources are available. */
export class FakeProbe implements BillingSourceProbe {
  private readonly statuses = new Map<string, BillingSourceStatus>();
  readonly calls: string[] = [];

  constructor(initial: Record<string, BillingSourceStatus> = {}) {
    for (const [id, s] of Object.entries(initial)) this.statuses.set(id, s);
  }

  set(sourceId: string, status: BillingSourceStatus): this {
    this.statuses.set(sourceId, status);
    return this;
  }

  async status(source: BillingSource): Promise<BillingSourceStatus> {
    this.calls.push(source.id);
    return this.statuses.get(source.id) ?? { available: true };
  }
}
