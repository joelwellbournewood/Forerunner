import { credentialPolicyOf, grantOf, type StopReason } from "@forerunner/billing";
import type { Clock } from "@forerunner/platform";
import type { JsonObject, StateStore } from "@forerunner/state";
import { Hono } from "hono";
import { CREDENTIAL_ASK_KEY, endGrant } from "../session/credential-ask.ts";
import { type BillingOrderRoutesDeps, billingOrderView } from "./billing-order-routes.ts";
import type { CredentialPolicyView } from "./credential-policy-types.ts";
import { type CredentialFacts, credentialPolicySection } from "./credential-policy-view.ts";

/**
 * d1109-cred-screens CS-1 (ADR 0120 amended 2026-11-16; the owner's answer 4 of 2026-11-09:
 * "There should be a nice clean options menu"): Settings -> Basics -> "Which Claude does the
 * work".
 *   GET  /settings/credential-policy           -> CredentialPolicyView
 *   POST /settings/credential-policy/grant/end -> CredentialPolicyView
 *
 * The preset is read as the engine reads it at every pick (`credentialPolicyOf`: stored, an
 * earlier choice derived, or the default); each saved credential's state is the router's stop
 * now (`currentStopOf`). A choice goes through `POST /commands/execute settings.set
 * credential_policy`, so its change card, Changes and Undo are every setting's; the only write
 * route is the end of a standing yes ("Stop using it").
 */
export interface CredentialPolicyRoutesDeps extends BillingOrderRoutesDeps {
  store: BillingOrderRoutesDeps["store"] & Pick<StateStore, "humanRequest">;
  clock: Clock;
  /** The router's stop of a source now, with its key (`RouterTaskBilling.currentStopOf`). */
  currentStopOf(
    sourceId: string,
  ): Promise<{ reason: StopReason; until: string | null; stopKey: string } | null>;
  /** The yes ended: the rows and the cards read it again. */
  changed?: () => void;
}

export async function credentialPolicyView(
  deps: CredentialPolicyRoutesDeps,
): Promise<CredentialPolicyView> {
  const human = await deps.store.human.get(deps.humanId);
  const policy = credentialPolicyOf((human?.notify_prefs ?? {}) as Record<string, unknown>);
  const order = await billingOrderView(deps);
  const rows = await deps.store.billingSource.list({ human_id: deps.humanId }, { limit: 100 });
  const credentials: CredentialFacts[] = [];
  for (const s of order.sources) {
    const saved = s.blocked !== "no_credential";
    const enabled = s.blocked !== "disabled";
    const stop = saved && enabled ? await deps.currentStopOf(s.id).catch(() => null) : null;
    const g = grantOf((rows.find((r) => r.id === s.id)?.limits as JsonObject | undefined)?.grant);
    credentials.push({
      kind: s.kind,
      saved,
      enabled,
      stop,
      planShare: s.planShare,
      monthChfMicro: s.monthSpent.chfMicro,
      grant: g ? { to: g.to as CredentialFacts["kind"], stopKey: g.stopKey } : null,
    });
  }
  // The open ask card, if any: the now line's Answer opens it.
  const openAsk = (await deps.store.humanRequest.open({ humanId: deps.humanId }, { limit: 500 }))
    .filter((r) => (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_ASK_KEY)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return credentialPolicySection({
    policy,
    credentials,
    openAskId: openAsk?.id ?? null,
    startedWith: deps.startedWith ?? null,
    opts: {
      ...(human?.timezone ? { timezone: human.timezone } : {}),
      nowMs: deps.clock.now(),
    },
  });
}

export function createCredentialPolicyRoutes(deps: CredentialPolicyRoutesDeps): Hono {
  const app = new Hono();
  app.get("/settings/credential-policy", async (c) => c.json(await credentialPolicyView(deps)));
  app.post("/settings/credential-policy/grant/end", async (c) => {
    const ended = await endGrant(deps.store as StateStore, deps.clock, deps.humanId);
    if (ended.length) deps.changed?.();
    return c.json(await credentialPolicyView(deps));
  });
  return app;
}
