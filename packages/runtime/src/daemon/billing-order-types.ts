import { z } from "zod";

/**
 * Settings -> Claude: which to use first (U-078, ADR 0100): the person's Claude credentials in
 * the order every model call uses them, each with how it is used, whether it can be used now
 * and what it has spent this month. `billing-order-routes.ts` serves it.
 */
export const BillingOrderKind = z.enum(["subscription", "api_key", "plan_credits"]);
export type BillingOrderKind = z.infer<typeof BillingOrderKind>;

const MoneyMicro = z.object({ usdMicro: z.number(), chfMicro: z.number() });

export const BillingOrderSourceView = z.object({
  id: z.string(),
  kind: BillingOrderKind,
  /** How the person names it: "Claude subscription", "API key", "Plan credits". */
  name: z.string(),
  /**
   * How its calls are made: `claude_code` (the subscription's token, in Claude Code only, ADR
   * 0098) or `api` (straight to the Messages API, where promotional API credits apply).
   */
  via: z.enum(["claude_code", "api"]),
  /** A call could use it now. */
  usable: z.boolean(),
  /**
   * Why not, when it cannot: `allowance` (the subscription's share of its allowance is at the
   * stop line), `monthly_cap` (the source's monthly cap is reached), `resting` (it met its
   * provider's usage limit; until `restingUntil`), `no_credential` (nothing saved in the
   * vault), `disabled`. Null when usable.
   */
  blocked: z.enum(["allowance", "monthly_cap", "resting", "no_credential", "disabled"]).nullable(),
  /** ISO time a resting source may serve again; null unless `blocked` is `resting`. */
  restingUntil: z.string().nullable(),
  /** The subscription's share of its monthly allowance (0..1); null for API-style sources. */
  planShare: z.number().nullable(),
  /** The share at which subscription work stops (the row's `planShareCap`); null otherwise. */
  planShareCap: z.number().nullable(),
  /** This UTC month's spend on it (API-equivalent for the subscription), USD and CHF. */
  monthSpent: MoneyMicro,
  /** An API-style source's monthly cap (`limits.monthlyUsdMicro`); null when it has none. */
  monthlyCap: MoneyMicro.nullable(),
});
export type BillingOrderSourceView = z.infer<typeof BillingOrderSourceView>;

export const BillingOrderView = z.object({
  /** The person chose an order; false: the defaults apply (see `order`). */
  chosen: z.boolean(),
  /**
   * The order the rows are in: the person's, else the order task runs use by default
   * (subscription first). Without a chosen order, Chat, planning and reviews use the API key
   * first (ADR 0098), which the screen says.
   */
  order: z.array(BillingOrderKind),
  sources: z.array(BillingOrderSourceView),
});
export type BillingOrderView = z.infer<typeof BillingOrderView>;

export const BillingOrderBody = z.object({
  /** The person's order, first used first: each kind once. */
  order: z.array(BillingOrderKind).min(1).max(3),
});
export type BillingOrderBody = z.infer<typeof BillingOrderBody>;

export const BILLING_ORDER_ROUTES = {
  billingOrder:
    "GET /settings/billing-order (BillingOrderView: the person's Claude credentials in the order every call uses them, each with how it is used (through Claude Code, or straight to the API where promotional credits apply), whether it can be used now and why not, and this month's spend; U-078)",
  setBillingOrder:
    "POST /settings/billing-order { order } (BillingOrderView: stored through settings.set billing_order, so Changes lists it with Undo, plus one settings.billing_order audit row; every next call and task follows it; 400 validation for an empty list, an unknown kind or a kind twice)",
} as const;
