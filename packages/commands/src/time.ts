import { ForerunnerError } from "@forerunner/platform";

/**
 * Wall-clock helpers in a human's time zone without a date library. "Tonight" means until
 * 06:00 the next morning, "tomorrow" the same instant, "until HH:MM" the next time that wall
 * clock comes round. Instants are stored as ISO-8601 UTC; only rendering is local.
 */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday. */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (e) {
      throw new ForerunnerError("validation", `unknown time zone ${timezone}`, {
        details: { timezone },
        cause: e,
      });
    }
    formatters.set(timezone, f);
  }
  return f;
}

export function localParts(utcMs: number, timezone: string): LocalParts {
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? "Sun"),
  };
}

function offsetMs(utcMs: number, timezone: string): number {
  const p = localParts(utcMs, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

/** The UTC instant of a local wall-clock time in `timezone`. Handles DST by a second pass. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess, timezone);
  return guess - offsetMs(first, timezone);
}

/** Start of the local day that contains `utcMs`, shifted by `dayOffset` days. */
export function localMidnight(utcMs: number, timezone: string, dayOffset = 0): number {
  const p = localParts(utcMs, timezone);
  return zonedToUtc(p.year, p.month, p.day + dayOffset, 0, 0, timezone);
}

/** The next occurrence of HH:MM local, strictly after `nowMs` (today if still ahead). */
export function nextLocalTime(
  nowMs: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const p = localParts(nowMs, timezone);
  const today = zonedToUtc(p.year, p.month, p.day, hour, minute, timezone);
  if (today > nowMs) return today;
  return zonedToUtc(p.year, p.month, p.day + 1, hour, minute, timezone);
}

/** "Tonight" ends at 06:00 local the next morning (06:00 today when it is still night). */
export function endOfTonight(nowMs: number, timezone: string): number {
  return nextLocalTime(nowMs, 6, 0, timezone);
}

/** "Until tomorrow" is the same instant as tonight: 06:00 the next morning. */
export function startOfTomorrow(nowMs: number, timezone: string): number {
  const p = localParts(nowMs, timezone);
  return zonedToUtc(p.year, p.month, p.day + 1, 6, 0, timezone);
}

/** "HH:MM" in the time zone. */
export function formatLocalTime(iso: string | number, timezone: string): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  const p = localParts(ms, timezone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "YYYY-MM-DD HH:MM" in the time zone. */
export function formatLocalDateTime(iso: string | number, timezone: string): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  const p = localParts(ms, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${formatLocalTime(ms, timezone)}`;
}

/**
 * How a change card and a sentence name the end of a window: "06:00" when it ends today or
 * tomorrow, "Tue 06:00" within the week, the full date beyond.
 */
export function describeUntil(iso: string | number, nowMs: number, timezone: string): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  const tomorrowEnd = localMidnight(nowMs, timezone, 2);
  if (ms < tomorrowEnd) return formatLocalTime(ms, timezone);
  if (ms < localMidnight(nowMs, timezone, 7)) {
    return `${WEEKDAYS[localParts(ms, timezone).weekday]} ${formatLocalTime(ms, timezone)}`;
  }
  return formatLocalDateTime(ms, timezone);
}

/** "tonight's", "today's" or "the", for a temporary budget that ends at `iso`. */
export function windowAdjective(iso: string | number, nowMs: number, timezone: string): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  const p = localParts(ms, timezone);
  const endsTomorrowMorning =
    ms >= localMidnight(nowMs, timezone, 1) &&
    ms < localMidnight(nowMs, timezone, 2) &&
    p.hour < 12;
  const endsTonight = ms >= nowMs && ms < localMidnight(nowMs, timezone, 1) && p.hour < 6;
  if (endsTomorrowMorning || endsTonight) return "tonight's";
  if (ms >= nowMs && ms < localMidnight(nowMs, timezone, 1)) return "today's";
  return "the";
}

export function isIsoInstant(value: string): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
