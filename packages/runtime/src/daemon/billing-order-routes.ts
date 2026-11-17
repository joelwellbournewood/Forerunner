import {
  type BillingSource,
  type CredentialPolicyId,
  credentialPolicyOf,
  ORDERABLE_KINDS,
  usdToChfMicro,
  type WhenStopped,
} from "@forerunner/billing";
import type { Clock } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";
import { Hono } from "hono";
import { planUsageOf, refusedSince, restingUntilOf } from "../wiring/billing-pick.ts";
import { stateSources } from "../wiring/billing-ports.ts";
import {
  BillingOrderBody,
  type BillingOrderKind,
  type BillingOrderSourceView,
  type BillingOrderView,
} from "./billing-order-types.ts";

/**
 * Settings -> Claude: which to use first (U-078, ADR 0100).
 *   GET  /settings/billing-order          -> BillingOrderView
 *   POST /settings/billing-order { order } -> BillingOrderView
 *
 * The order is the person's (`human.notify_prefs.billing_order`), stored through the command
 * registry's `settings.set billing_order` (low risk: no card; Changes lists it with Undo), plus
 * one `settings.billing_order` audit row. `seedBillingSources` never touches it, and the billing
 * router reads it at every pick, so the next call and the next task follow it, after a restart
 * too. Each row says what the source is, how it is used, whether a call could use it now (the
 * router's rules: disabled, no credential, resting after a usage limit, the allowance's stop
 * line, the monthly cap) and what it has spent this month.
 */
export interface BillingOrderRoutesDeps {
  store: Pick<StateStore, "billingSource" | "costLedger" | "human" | "auditLog">;
  /** `get` tells a refused credential from a new one saved since (U-078). */
  vault: Pick<Vault, "has"> & Partial<Pick<Vault, "get">>;
  clock: Clock;
  humanId: string;
  chfPerUsd: () => number;
  /**
   * d1109-cred-screens (CS-2, C5-left-4): stores the preset an order maps onto through
   * `settings.set credential_policy` (the change log's row): the order changed, the person's
   * rule at a stop kept (`presetForOrder`).
   */
  setPolicy: (preset: CredentialPolicyId) => Promise<void>;
  /** The provider the install was started with outside the saved credentials (`RuntimeApp.startedWith`). */
  startedWith?: string | null;
}

/** The audit row a change of the order writes. */
export const BILLING_ORDER_AUDIT_TOOL = "settings.billing_order";

const NAMES: Record<BillingOrderKind, string> = {
  subscription: "Claude subscription",
  api_key: "API key",
  plan_credits: "Plan credits",
};

/**
 * The preset an order maps onto (CS-2, C5-left-4: POST /settings/billing-order keeps answering
 * and stores the policy): the order changed, the person's rule at a stop kept. A key-first order
 * has no "ask" preset: it maps onto "API key only", which never moves by itself either.
 */
export function presetForOrder(
  order: readonly BillingOrderKind[],
  whenStopped: WhenStopped,
): CredentialPolicyId {
  if (order[0] === "subscription")
    return whenStopped === "ask"
      ? "subscription_then_ask"
      : whenStopped === "next"
        ? "subscription_then_key"
        : "subscription_then_wait";
  return whenStopped === "next" ? "key_then_subscription" : "key_only";
}

export async function billingOrderView(deps: BillingOrderRoutesDeps): Promise<BillingOrderView> {
  // C5-left-4: the order in force is the credential policy's (stored, derived from the earlier
  // order, or the default), never `billing_order` alone, so this view shows what every pick does.
  const human = await deps.store.human.get(deps.humanId);
  const policy = credentialPolicyOf((human?.notify_prefs ?? {}) as Record<string, unknown>);
  const chosen = policy.chosen !== "default";
  const rows = await deps.store.billingSource.list({ human_id: deps.humanId }, { limit: 100 });
  // The kinds this person has a row of, in the policy's order; a kind the preset leaves out
  // ("API key only" leaves the subscription out) comes last.
  const present = new Set(rows.map((r) => r.kind));
  const inOrder = policy.rule.order.filter(
    (k): k is BillingOrderKind => ORDERABLE_KINDS.includes(k) && present.has(k),
  );
  const order: BillingOrderKind[] = [
    ...inOrder,
    ...ORDERABLE_KINDS.filter(
      (k): k is BillingOrderKind => present.has(k) && !inOrder.includes(k as BillingOrderKind),
    ),
  ];
  const enabled = new Set(
    (await stateSources(deps.store as StateStore)(deps.humanId)).map((s) => s.id),
  );
  const rate = deps.chfPerUsd();
  const money = (usd: number) => ({ usdMicro: usd, chfMicro: usdToChfMicro(usd, rate) });
  const rank = (k: BillingOrderKind) => {
    const i = order.indexOf(k);
    return i >= 0 ? i : order.length;
  };
  const sources: BillingOrderSourceView[] = [];
  for (const r of rows) {
    if (!ORDERABLE_KINDS.includes(r.kind as BillingOrderKind)) continue;
    const kind = r.kind as BillingOrderKind;
    const source: BillingSource = {
      id: r.id,
      kind,
      humanId: r.human_id,
      label: r.label,
      credentialRef: r.credential_ref ?? "",
      enabled: r.enabled,
      priority: r.priority,
      limits: (r.limits as BillingSource["limits"]) ?? {},
    };
    const usage = await planUsageOf(deps.store, deps.clock, source);
    const hasCredential = source.credentialRef
      ? await deps.vault.has(source.credentialRef).catch(() => false)
      : false;
    const resting = restingUntilOf(source, deps.clock.now());
    const refused = hasCredential ? await refusedSince(source, deps.vault) : null;
    const monthlyCap =
      typeof source.limits.monthlyUsdMicro === "number" ? source.limits.monthlyUsdMicro : null;
    const blocked: BillingOrderSourceView["blocked"] = !enabled.has(r.id)
      ? "disabled"
      : !hasCredential
        ? "no_credential"
        : refused
          ? "refused"
          : resting
            ? "resting"
            : kind === "subscription" && usage.share !== null && usage.share >= usage.cap
              ? "allowance"
              : monthlyCap !== null && usage.monthUsdMicro >= monthlyCap
                ? "monthly_cap"
                : null;
    sources.push({
      id: r.id,
      kind,
      name: NAMES[kind],
      via: kind === "subscription" ? "claude_code" : "api",
      usable: blocked === null,
      blocked,
      restingUntil: blocked === "resting" ? resting : null,
      planShare: kind === "subscription" ? usage.share : null,
      planShareCap: kind === "subscription" ? usage.cap : null,
      monthSpent: money(usage.monthUsdMicro),
      monthlyCap: monthlyCap !== null ? money(monthlyCap) : null,
    });
  }
  sources.sort(
    (a, b) =>
      rank(a.kind) - rank(b.kind) ||
      (rows.find((r) => r.id === a.id)?.priority ?? 0) -
        (rows.find((r) => r.id === b.id)?.priority ?? 0),
  );
  return { chosen, order, sources, startedWith: deps.startedWith ?? null };
}

export function createBillingOrderRoutes(deps: BillingOrderRoutesDeps): Hono {
  const app = new Hono();

  app.get("/settings/billing-order", async (c) => c.json(await billingOrderView(deps)));

  app.post("/settings/billing-order", async (c) => {
    const parsed = BillingOrderBody.safeParse(await c.req.json().catch(() => ({})));
    const order = parsed.success ? parsed.data.order : null;
    if (!order || new Set(order).size !== order.length) {
      return c.json(
        {
          code: "validation",
          message:
            "Give the order as a list of your credentials, each once: subscription, api_key, plan_credits.",
          details: {},
        },
        400,
      );
    }
    const human = await deps.store.human.get(deps.humanId);
    const before = credentialPolicyOf((human?.notify_prefs ?? {}) as Record<string, unknown>);
    const preset = presetForOrder(order, before.rule.whenStopped);
    if (preset !== before.id || before.chosen !== "stored") await deps.setPolicy(preset);
    await deps.store.auditLog
      .append({
        tool: BILLING_ORDER_AUDIT_TOOL,
        allowed: true,
        human_id: deps.humanId,
        input_summary: JSON.stringify({ order }),
        result_summary: `policy ${before.id} (${before.chosen}) -> ${preset}`,
        occurred_at: deps.clock.nowIso(),
      })
      .catch(() => undefined);
    return c.json(await billingOrderView(deps));
  });

  return app;
}
