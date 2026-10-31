import { writeFileSync } from "node:fs";
import type { AppDirs, Clock } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";
import { Hono } from "hono";
import {
  PLAN_USD_MONTHLY_ENV,
  type PlanAllowance,
  type PlanAllowanceOrigin,
  planAllowanceOf,
  resolvePlanAllowance,
} from "./plan-allowance.ts";
import { PlanAllowanceBody, type PlanAllowanceView } from "./types.ts";
import { configPath, readConfig, runSetup, SECRET_NAMES } from "./wizard.ts";

/**
 * Settings → Claude subscription allowance (U-052): the plan allowance (ADR 0044) as a field in
 * the app. 1.0.4 took it only from `fr setup --plan-usd-monthly`, `FORERUNNER_PLAN_USD_MONTHLY`
 * or `config.json`, none of which the installed app offers, so every install ran on the USD 50
 * default and a Max subscriber's work stopped early.
 *
 * The person enters CHF per month; the daemon converts at its rate of the day and stores USD,
 * as the runtime expects: `config.json`'s `subscription.planUsdMonthly` (what the next start
 * resolves) and the subscription billing row's `limits.planUsdMicro` (what the next pick and
 * the plan share read), so it takes effect at once and after a restart.
 *   GET  /settings/plan-allowance               -> PlanAllowanceView
 *   POST /settings/plan-allowance { chfMonthly } -> PlanAllowanceView
 */
export interface PlanAllowanceRoutesDeps {
  dirs: AppDirs;
  env: NodeJS.ProcessEnv;
  vault: Vault;
  clock: Clock;
  store: Pick<StateStore, "billingSource" | "auditLog">;
  humanId: string;
  chfPerUsd: () => number;
  /** The allowance the runtime composed with (an `option` or `env` origin wins over the field). */
  current: () => PlanAllowance;
  /** Called with the allowance the field set, so the running runtime reports it. */
  onChanged?: (a: PlanAllowance) => void;
}

/** The row's stop line when it has none (ADR 0044: `SEEDED_PLAN_SHARE_CAP`). */
const DEFAULT_STOP_SHARE = 0.95;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function createPlanAllowanceRoutes(deps: PlanAllowanceRoutesDeps): Hono {
  const app = new Hono();
  const overriding = (origin: PlanAllowanceOrigin) => origin === "option" || origin === "env";

  const subscriptionRow = async () =>
    (await deps.store.billingSource.list({ human_id: deps.humanId }, { limit: 100 })).find(
      (r) => r.credential_ref === SECRET_NAMES.anthropicOauth,
    );

  async function view(): Promise<PlanAllowanceView> {
    const composed = deps.current();
    const inForce = overriding(composed.origin)
      ? composed
      : resolvePlanAllowance([
          { value: readConfig(deps.dirs)?.subscription?.planUsdMonthly, origin: "config" },
        ]);
    const rate = deps.chfPerUsd();
    const row = await subscriptionRow();
    const cap = row?.limits.planShareCap;
    return {
      subscription: await deps.vault.has(SECRET_NAMES.anthropicOauth),
      usdMonthly: inForce.usdMonthly,
      chfMonthly: round2(inForce.usdMonthly * rate),
      chfPerUsd: rate,
      origin: inForce.origin,
      overridden: overriding(composed.origin),
      stopShare: typeof cap === "number" && cap > 0 ? cap : DEFAULT_STOP_SHARE,
    };
  }

  app.get("/settings/plan-allowance", async (c) => c.json(await view()));

  app.post("/settings/plan-allowance", async (c) => {
    const parsed = PlanAllowanceBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        {
          code: "validation",
          message: "Enter the allowance as a positive amount of CHF per month, e.g. 160.",
          details: {},
        },
        400,
      );
    }
    const composed = deps.current();
    if (overriding(composed.origin)) {
      return c.json(
        {
          code: "validation",
          message: `${PLAN_USD_MONTHLY_ENV} is set on this computer and decides the allowance; remove it to set the allowance here.`,
          details: { origin: composed.origin },
        },
        409,
      );
    }
    const rate = deps.chfPerUsd();
    const usd = round2(parsed.data.chfMonthly / rate);
    if (!(usd > 0)) {
      return c.json(
        { code: "validation", message: "The allowance is too small to store.", details: {} },
        400,
      );
    }
    const next = planAllowanceOf(usd, "config");
    // config.json: what the next start resolves (created as `fr setup` would when missing).
    if (!readConfig(deps.dirs)) {
      await runSetup(deps.vault, {
        nonInteractive: false,
        installRecord: false,
        dirs: deps.dirs,
        env: Object.fromEntries(
          Object.entries(deps.env).filter(([k]) => !/TOKEN|KEY|PLAN_USD/.test(k)),
        ),
      });
    }
    const config = readConfig(deps.dirs);
    if (config) {
      writeFileSync(
        configPath(deps.dirs),
        `${JSON.stringify({ ...config, subscription: { planUsdMonthly: usd } }, null, 2)}\n`,
      );
    }
    // The billing row: what the next pick and the plan share read, so it applies at once.
    const row = await subscriptionRow();
    if (row)
      await deps.store.billingSource.patch(row.id, {
        limits: { ...row.limits, planUsdMicro: next.usdMicro },
      });
    deps.onChanged?.(next);
    await deps.store.auditLog
      .append({
        tool: "settings.plan_allowance",
        allowed: true,
        human_id: deps.humanId,
        input_summary: `chf_monthly: ${parsed.data.chfMonthly}`,
        result_summary: `usd_monthly: ${usd} at ${rate} CHF/USD`,
        occurred_at: deps.clock.nowIso(),
      })
      .catch(() => undefined);
    return c.json(await view());
  });

  return app;
}
