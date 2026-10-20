/**
 * Money display. The daemon sends USD micro-units plus CHF micro-units computed at the day's
 * rate (ADR 0008, ADR 0011); the UI shows CHF with two decimals and never USD except in a
 * tooltip. Arithmetic mirrors `@forerunner/billing` (`formatAmount`: half-up, ties away from
 * zero) without importing it, because billing pulls in Node-only modules.
 */

export interface MoneyLike {
  usdMicro: number;
  chfMicro: number;
}

const MICRO = 1_000_000;

function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** "12.34" from chf micro-units. Throws on a non-integer. */
export function formatAmount(micro: number, decimals = 2): string {
  if (!Number.isInteger(micro)) throw new Error(`money: not an integer micro amount: ${micro}`);
  const scale = 10 ** (6 - decimals);
  const units = roundHalfUp(micro / scale);
  const negative = units < 0;
  const abs = Math.abs(units);
  const divisor = 10 ** decimals;
  const whole = Math.floor(abs / divisor);
  const frac = abs % divisor;
  const wholeStr = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const fracStr = decimals > 0 ? `.${String(frac).padStart(decimals, "0")}` : "";
  return `${negative ? "-" : ""}${wholeStr}${fracStr}`;
}

/** "CHF 12.34". */
export function formatChf(chfMicro: number): string {
  return `CHF ${formatAmount(chfMicro)}`;
}

/** The display string for a Money value: CHF only. */
export function formatMoney(money: MoneyLike): string {
  return formatChf(money.chfMicro);
}

/** Tooltip text with the raw USD figure, the only place USD is ever shown. */
export function moneyTooltip(money: MoneyLike): string {
  return `USD ${formatAmount(money.usdMicro)} at the day's rate`;
}

/** 0..1 share of `spent` against `cap`; 0 when the cap is zero; clamps above 1 to 1. */
export function spendRatio(spent: MoneyLike, cap: MoneyLike): number {
  if (cap.chfMicro <= 0) return 0;
  return Math.min(1, Math.max(0, spent.chfMicro / cap.chfMicro));
}

/** Whole percent for a bar label. */
export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** CHF decimal input ("12.5") to micro-units; null when not a finite non-negative number. */
export function chfToMicro(input: string): number | null {
  const trimmed = input.trim().replace(/'/g, "");
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return roundHalfUp(value * MICRO);
}

/**
 * CHF micro-units to USD micro-units at the rate implied by a Money pair (usd/chf), or the
 * documented default rate (ADR 0008: 0.80 CHF per USD) when the pair carries no CHF.
 */
export const DEFAULT_CHF_PER_USD = 0.8;
export function chfMicroToUsdMicro(chfMicro: number, reference?: MoneyLike): number {
  const rate =
    reference && reference.chfMicro > 0 && reference.usdMicro > 0
      ? reference.chfMicro / reference.usdMicro
      : DEFAULT_CHF_PER_USD;
  return roundHalfUp(chfMicro / rate);
}
