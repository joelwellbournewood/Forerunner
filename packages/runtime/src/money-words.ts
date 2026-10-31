/**
 * Money as a person reads it (U-074): CHF, never USD. Amounts are kept in USD micro-units
 * (AGENTS.md); a text that has no day's rate at hand (a refusal, an estimate on a card) converts
 * at `DEFAULT_CHF_PER_USD`, the rate the billing package falls back to.
 */
import { DEFAULT_CHF_PER_USD, formatChf, usdToChfMicro } from "@forerunner/billing";

/** "CHF 1.20" for a USD micro amount, at `chfPerUsd` (the default rate without one). */
export function chfText(usdMicro: number, chfPerUsd: number = DEFAULT_CHF_PER_USD): string {
  const usd = Number.isFinite(usdMicro) ? Math.max(0, Math.round(usdMicro)) : 0;
  return formatChf(usdToChfMicro(usd, chfPerUsd));
}
