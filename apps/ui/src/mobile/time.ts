/**
 * Wall-clock helpers in the human's time zone, mirroring `packages/commands/src/time.ts` for
 * the phrases the phone understands ("tonight" and "until tomorrow" end at 06:00 the next
 * morning; "until HH:MM" is the next time that wall clock comes round). Kept local because
 * the commands package pulls Node-only modules the WebView cannot load. Instants are ISO
 * UTC; only rendering is local.
 */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
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
  };
}

function offsetMs(utcMs: number, timezone: string): number {
  const p = localParts(utcMs, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

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

export function localMidnight(utcMs: number, timezone: string, dayOffset = 0): number {
  const p = localParts(utcMs, timezone);
  return zonedToUtc(p.year, p.month, p.day + dayOffset, 0, 0, timezone);
}

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

/** "Tonight" ends at 06:00 the next morning (06:00 today when it is still night). */
export function endOfTonight(nowMs: number, timezone: string): number {
  return nextLocalTime(nowMs, 6, 0, timezone);
}

/** "Until tomorrow" is the same instant as tonight: 06:00 the next morning. */
export function startOfTomorrow(nowMs: number, timezone: string): number {
  const p = localParts(nowMs, timezone);
  return zonedToUtc(p.year, p.month, p.day + 1, 6, 0, timezone);
}

export function formatLocalTime(iso: string | number, timezone: string): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  const p = localParts(ms, timezone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function formatLocalDateTime(iso: string | number, timezone: string): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  const p = localParts(ms, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${formatLocalTime(ms, timezone)}`;
}

/** "06:00" when the window ends today or tomorrow, else the full local date and time. */
export function describeUntil(iso: string | number, nowMs: number, timezone: string): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (ms < localMidnight(nowMs, timezone, 2)) return formatLocalTime(ms, timezone);
  return formatLocalDateTime(ms, timezone);
}

export function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** The browser's time zone, or UTC when it cannot tell. */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
