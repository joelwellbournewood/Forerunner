import { ForerunnerError } from "@forerunner/platform";

/**
 * The subscription's plan allowance (ADR 0044): the estimated API-equivalent usage, in USD per
 * UTC month, that the plan usage share is computed against. The provider reports no plan usage
 * to the Agent SDK, so the daemon estimates the share as the month's "subscription" ledger rows
 * at list price over this allowance, and the caps stop subscription work at `planShareCap` of
 * it (spec I.1, I.5). It is a first-class setup input: `fr setup --plan-usd-monthly`,
 * `FORERUNNER_PLAN_USD_MONTHLY`, the interactive question, or `config.json`'s
 * `subscription.planUsdMonthly`; when nothing says, a conservative default applies so the
 * plan level always exists. The value is never a secret.
 */
export const PLAN_USD_MONTHLY_ENV = "FORERUNNER_PLAN_USD_MONTHLY";

/**
 * The default allowance, USD of API-equivalent usage per month, when no input sets one: the
 * price of a mid plan, deliberately low so an unconfigured install stops subscription work
 * (and asks) early rather than late. Raise it with `fr setup --plan-usd-monthly`.
 */
export const DEFAULT_PLAN_USD_MONTHLY = 50;

/** Where the allowance in force came from, most explicit first. */
export type PlanAllowanceOrigin = "flag" | "option" | "env" | "prompt" | "config" | "default";

export interface PlanAllowance {
  usdMonthly: number;
  /** The same in usd_micro: the subscription row's `limits.planUsdMicro`. */
  usdMicro: number;
  origin: PlanAllowanceOrigin;
}

/**
 * A positive finite number of USD from a flag, an environment value or a config field; null
 * for anything else (absent, empty, not a plain decimal, zero, negative). Never throws.
 */
export function parsePlanUsdMonthly(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `parsePlanUsdMonthly`, or a `validation` error naming the input (never echoing it). */
export function assertPlanUsdMonthly(value: unknown, what: string): number {
  const n = parsePlanUsdMonthly(value);
  if (n === null) {
    throw new ForerunnerError(
      "validation",
      `${what} must be a positive number of USD per month, e.g. 100`,
    );
  }
  return n;
}

export function planAllowanceOf(usdMonthly: number, origin: PlanAllowanceOrigin): PlanAllowance {
  return { usdMonthly, usdMicro: Math.round(usdMonthly * 1_000_000), origin };
}

/**
 * The allowance in force: the first candidate that parses, in the order given (callers list
 * them most explicit first: a flag, the environment, the prompt's answer, the config file),
 * else the default.
 */
export function resolvePlanAllowance(
  candidates: readonly { value: unknown; origin: PlanAllowanceOrigin }[],
): PlanAllowance {
  for (const c of candidates) {
    const n = parsePlanUsdMonthly(c.value);
    if (n !== null) return planAllowanceOf(n, c.origin);
  }
  return planAllowanceOf(DEFAULT_PLAN_USD_MONTHLY, "default");
}

/** One line for a setup summary or a status view: the amount, and where it came from. */
export function describePlanAllowance(a: PlanAllowance): string {
  const amount = `plan allowance USD ${a.usdMonthly}/month`;
  switch (a.origin) {
    case "default":
      return `${amount} (default; set it with fr setup --plan-usd-monthly or ${PLAN_USD_MONTHLY_ENV})`;
    case "flag":
      return `${amount} from --plan-usd-monthly`;
    case "option":
      return `${amount} from the composition`;
    case "env":
      return `${amount} from ${PLAN_USD_MONTHLY_ENV}`;
    case "prompt":
      return `${amount} as entered`;
    case "config":
      return `${amount} from config.json`;
  }
}
