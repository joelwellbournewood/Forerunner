/**
 * Display helpers for ISO-8601 UTC timestamps, in the computer's time zone. One way of writing a
 * time on every screen (design §5, P7-9): 24 hours, "04:36", whatever the browser's language
 * (an en-US browser wrote "04:32:05 AM" in a log beside "Waits until 04:36" from the daemon).
 */

/** "04:36": hours and minutes, 24 hours. */
const HH_MM: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/** "3 Nov 2026, 04:36". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}, ${d.toLocaleTimeString("en-GB", HH_MM)}`;
}

/**
 * "04:36" today, "4 Nov, 04:36" another day: a time a person waits for or looks back on, as the
 * daemon's own sentences write it ("Waits until 04:36", `clockTime`) and Files' copy line
 * (`copyUpdatedWords`). `now` is injectable for tests.
 */
export function formatClock(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString("en-GB", HH_MM);
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

/** Date only, for axes and compact rows. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Day and month as a sentence names them: "1 Nov" (design §5, "Decision"). */
export function formatDayMonth(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "16:02": a log line's time, 24 hours, no seconds (design §5, P7-9). */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-GB", HH_MM);
}

/** "3 min ago", "2 h ago", "yesterday"; `now` is injectable for tests. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, now - t);
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return formatDateTime(iso);
}

/**
 * How long a session worked, as its row in the Sessions list says it (d1109-sessions): "under a
 * minute", "12 min", "1 h 5 min", "2 h". Null (still working) reads "".
 */
export function durationWords(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 60_000) return "under a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes - h * 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m} min ${rest} s`;
}
