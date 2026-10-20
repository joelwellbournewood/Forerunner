/**
 * Minimal money helpers for the email module (micro-units, ADR 0008). They mirror the
 * conventions of @forerunner/billing (integer micro-units, half-up rounding, CHF display) so
 * the orchestrator can pass billing's rate source and estimator straight into the ports.
 */
import { ForerunnerError } from "@forerunner/platform";

export const MICRO_PER_UNIT = 1_000_000;

export function roundHalfUp(x: number): number {
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

function assertRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new ForerunnerError("validation", "exchange rate must be a positive number", {
      details: { rate },
    });
  }
  return rate;
}

export function chfToUsdMicro(chfMicro: number, rateChfPerUsd: number): number {
  return roundHalfUp(chfMicro / assertRate(rateChfPerUsd));
}

export function usdToChfMicro(usdMicro: number, rateChfPerUsd: number): number {
  return roundHalfUp(usdMicro * assertRate(rateChfPerUsd));
}

/** "CHF 5.00" from micro-units, two decimals, half-up. */
export function formatChfMicro(chfMicro: number): string {
  const cents = roundHalfUp(chfMicro / 10_000);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  return `${negative ? "-" : ""}CHF ${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Format a USD micro amount as CHF at the given rate. */
export function formatUsdMicroAsChf(usdMicro: number, rateChfPerUsd: number): string {
  return formatChfMicro(usdToChfMicro(usdMicro, rateChfPerUsd));
}

/** Local calendar day (YYYY-MM-DD) of an instant in an IANA time zone; UTC when the zone is unknown. */
export function localDayKey(ms: number, timeZone: string): string {
  return dayFormatter(timeZone).format(new Date(ms));
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  formatters.set(timeZone, fmt);
  return fmt;
}
