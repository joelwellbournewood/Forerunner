/**
 * Money primitives (ADR 0008).
 *
 * Every amount is an integer number of micro-units: 1 USD = 1_000_000 usd_micro,
 * 1 CHF = 1_000_000 chf_micro. Nothing stores or sums floats. Safe integers cover
 * about 9 billion units, far beyond any cap Forerunner enforces.
 *
 * Rounding rule, used everywhere a fractional value becomes an integer (decimal input to
 * micro-units, currency conversion, shares of a cap, 2-decimal display): half-up, with ties
 * rounded away from zero (0.5 -> 1, -0.5 -> -1). Binary float noise on decimal inputs
 * (1.005 * 1e6 = 1004999.9999999999) is absorbed by a tiny epsilon before flooring; the
 * epsilon is far below any real tie at the magnitudes money takes.
 */
import { ForerunnerError } from "@forerunner/platform";

export const MICRO_PER_UNIT = 1_000_000;
export const MICRO_PER_CENT = 10_000;

export type Currency = "USD" | "CHF";

const ROUNDING_EPSILON = 1e-7;

function validationError(message: string, details: Record<string, unknown>): ForerunnerError {
  return new ForerunnerError("validation", message, { details });
}

/** Round half-up (ties away from zero) to an integer. Throws on NaN or infinity. */
export function roundHalfUp(x: number): number {
  if (!Number.isFinite(x)) {
    throw validationError("cannot round a non-finite number", { value: String(x) });
  }
  const magnitude = Math.floor(Math.abs(x) + 0.5 + ROUNDING_EPSILON);
  if (magnitude === 0) return 0;
  return x < 0 ? -magnitude : magnitude;
}

/** True when `n` is a valid micro-unit amount (a safe integer). */
export function isMicro(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n);
}

/** Assert that `n` is an integer micro-unit amount; returns it for chaining. */
export function assertMicro(n: number, what = "amount"): number {
  if (!Number.isSafeInteger(n)) {
    throw validationError(`${what} must be an integer number of micro-units`, {
      what,
      value: String(n),
    });
  }
  return n;
}

/** Positive, finite exchange rate or share factor. */
export function assertRate(rate: number, what = "rate"): number {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw validationError(`${what} must be a positive finite number`, {
      what,
      value: String(rate),
    });
  }
  return rate;
}

/** Decimal amount (e.g. 1.5) to micro-units (1_500_000), rounding half-up. */
export function toMicro(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw validationError("amount must be a finite number", { value: String(amount) });
  }
  return roundHalfUp(amount * MICRO_PER_UNIT);
}

/** USD decimal to usd_micro. */
export function usdMicro(usd: number): number {
  return toMicro(usd);
}

/** CHF decimal to chf_micro. */
export function chfMicro(chf: number): number {
  return toMicro(chf);
}

/** Integer cents (or rappen) to micro-units. */
export function fromCents(cents: number): number {
  if (!Number.isSafeInteger(cents)) {
    throw validationError("cents must be an integer", { value: String(cents) });
  }
  return cents * MICRO_PER_CENT;
}

/** Micro-units to integer cents, rounding half-up. */
export function toCents(micro: number): number {
  assertMicro(micro);
  return roundHalfUp(micro / MICRO_PER_CENT);
}

/** Micro-units to a decimal number. Display and arithmetic on the way out only. */
export function toDecimal(micro: number): number {
  assertMicro(micro);
  return micro / MICRO_PER_UNIT;
}

export interface FormatOptions {
  /** Decimal places shown, 0..6. Default 2. */
  decimals?: number;
  /** Thousands separator, e.g. "'" for Swiss style. Default none. */
  grouping?: string;
}

/** Format micro-units as a plain decimal string with fixed decimals, rounding half-up. */
export function formatAmount(micro: number, opts: FormatOptions = {}): string {
  assertMicro(micro);
  const decimals = opts.decimals ?? 2;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    throw validationError("decimals must be an integer between 0 and 6", { decimals });
  }
  const scale = 10 ** (6 - decimals);
  const units = roundHalfUp(micro / scale);
  const negative = units < 0;
  const abs = Math.abs(units);
  const divisor = 10 ** decimals;
  const whole = Math.floor(abs / divisor);
  const frac = abs % divisor;
  let wholeStr = String(whole);
  if (opts.grouping) {
    wholeStr = wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, opts.grouping);
  }
  const fracStr = decimals > 0 ? `.${String(frac).padStart(decimals, "0")}` : "";
  return `${negative ? "-" : ""}${wholeStr}${fracStr}`;
}

/** "CHF 12.34" / "USD 0.05". */
export function formatMoney(micro: number, currency: Currency, opts: FormatOptions = {}): string {
  return `${currency} ${formatAmount(micro, opts)}`;
}

export function formatUsd(micro: number, opts: FormatOptions = {}): string {
  return formatMoney(micro, "USD", opts);
}

export function formatChf(micro: number, opts: FormatOptions = {}): string {
  return formatMoney(micro, "CHF", opts);
}

/** usd_micro to chf_micro at `rateChfPerUsd`, rounding half-up. */
export function usdToChfMicro(usd: number, rateChfPerUsd: number): number {
  assertMicro(usd, "usd_micro");
  assertRate(rateChfPerUsd, "rate_chf_per_usd");
  return roundHalfUp(usd * rateChfPerUsd);
}

/** chf_micro to usd_micro at `rateChfPerUsd`, rounding half-up. */
export function chfToUsdMicro(chf: number, rateChfPerUsd: number): number {
  assertMicro(chf, "chf_micro");
  assertRate(rateChfPerUsd, "rate_chf_per_usd");
  return roundHalfUp(chf / rateChfPerUsd);
}

/** A share (0..n) of an amount, rounding half-up. */
export function shareOf(micro: number, share: number): number {
  assertMicro(micro);
  if (!Number.isFinite(share) || share < 0) {
    throw validationError("share must be a non-negative finite number", { share });
  }
  return roundHalfUp(micro * share);
}

/** spent / cap as a plain ratio; cap must be positive. */
export function ratioOf(spent: number, cap: number): number {
  assertMicro(spent, "spent");
  assertMicro(cap, "cap");
  if (cap <= 0) throw validationError("cap must be positive", { cap });
  return spent / cap;
}

/** Sum of micro-unit amounts; validates each term. */
export function sumMicro(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += assertMicro(v);
  return assertMicro(total, "sum");
}
