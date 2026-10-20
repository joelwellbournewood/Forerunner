/**
 * Spec defaults (Open decisions): monthly cap CHF 150 per human, session cap CHF 5.
 * Caps are enforced in USD micro-units; CHF defaults are converted at the day's rate when
 * the caps are built, so a rate move changes the USD figure, not the CHF promise.
 */
import { type Caps, DEFAULT_RESERVE_SHARE } from "./caps.ts";
import { chfMicro, chfToUsdMicro } from "./money.ts";
import type { RateSource } from "./rates.ts";
import { DEFAULT_PLAN_SHARE_CAP } from "./router.ts";

export const DEFAULT_MONTHLY_CAP_CHF = 150;
export const DEFAULT_SESSION_CAP_CHF = 5;

export interface ChfCaps {
  monthlyChf?: number;
  sessionChf?: number;
  projectChf?: number;
  taskChf?: number;
  runChf?: number;
  reserveShare?: number;
  planShareCap?: number;
}

/** Build USD caps from CHF figures at a given rate (defaults filled in). */
export function capsFromChf(chf: ChfCaps, rateChfPerUsd: number): Caps {
  const toUsd = (c: number) => chfToUsdMicro(chfMicro(c), rateChfPerUsd);
  const caps: Caps = {
    monthUsdMicro: toUsd(chf.monthlyChf ?? DEFAULT_MONTHLY_CAP_CHF),
    sessionUsdMicro: toUsd(chf.sessionChf ?? DEFAULT_SESSION_CAP_CHF),
    reserveShare: chf.reserveShare ?? DEFAULT_RESERVE_SHARE,
    planShareCap: chf.planShareCap ?? DEFAULT_PLAN_SHARE_CAP,
  };
  if (chf.projectChf !== undefined) caps.projectUsdMicro = toUsd(chf.projectChf);
  if (chf.taskChf !== undefined) caps.taskUsdMicro = toUsd(chf.taskChf);
  if (chf.runChf !== undefined) caps.runUsdMicro = toUsd(chf.runChf);
  return caps;
}

/** Default caps at the rate for `dateIso`, with optional CHF overrides. */
export async function defaultCaps(
  rates: RateSource,
  dateIso: string,
  overrides: ChfCaps = {},
): Promise<Caps> {
  const rate = await rates.chfPerUsd(dateIso);
  return capsFromChf(overrides, rate);
}
