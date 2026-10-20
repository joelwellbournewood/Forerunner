/**
 * Reading, validating and writing `human.notify_prefs`, plus the pure decisions that depend on
 * them: which channels a kind goes to, whether it is quiet hours now, whether the digest is due.
 * Time-zone arithmetic reuses `localParts` from the session scheduler (no second implementation).
 */
import type { HumanRow, JsonObject, JsonValue } from "@forerunner/state";
import { z } from "zod";
import { localParts } from "../session/triggers.ts";
import {
  CHANNEL_NAMES,
  type ChannelName,
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationPrefs,
  type QuietHours,
  type ResolvedPrefs,
} from "./types.ts";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const E164 = /^\+?[0-9]{6,20}$/;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const QuietHoursSchema = z
  .object({ start: z.string().regex(HHMM), end: z.string().regex(HHMM) })
  .strict();

const ChannelList = z.array(z.enum(CHANNEL_NAMES)).max(CHANNEL_NAMES.length);

/** What `PUT /notifications/prefs` accepts: every field optional, unknown fields refused. */
export const NotificationPrefsPatch = z
  .object({
    channels: z.partialRecord(z.enum(NOTIFICATION_KINDS), ChannelList).optional(),
    quiet_hours: QuietHoursSchema.nullable().optional(),
    timezone: z
      .string()
      .min(1)
      .refine(isValidTimezone, { message: "unknown IANA time zone" })
      .nullable()
      .optional(),
    digest_time: z.string().regex(HHMM).nullable().optional(),
    telegram_chat_id: z.string().min(1).max(64).nullable().optional(),
    signal_number: z.string().regex(E164).nullable().optional(),
    email: z.email().nullable().optional(),
    notify_channel: z
      .enum([...CHANNEL_NAMES, "push"])
      .nullable()
      .optional(),
  })
  .strict();
export type NotificationPrefsPatch = z.infer<typeof NotificationPrefsPatch>;

export const DEFAULT_PREFS: Readonly<NotificationPrefs> = Object.freeze({
  channels: {},
  quiet_hours: null,
  timezone: null,
  digest_time: null,
  telegram_chat_id: null,
  signal_number: null,
  email: null,
  notify_channel: null,
});

/**
 * Tolerant read: each known key is validated on its own and falls back to its default when the
 * stored value is malformed (other writers share this JSON object). Unknown keys are ignored
 * here and preserved by `writePrefs`.
 */
export function readPrefs(json: JsonObject | null | undefined): NotificationPrefs {
  const raw = json ?? {};
  const field = <T>(key: keyof NotificationPrefs, schema: z.ZodType<T>, fallback: T): T => {
    if (!Object.hasOwn(raw, key)) return fallback;
    const r = schema.safeParse(raw[key]);
    return r.success ? r.data : fallback;
  };
  const shape = NotificationPrefsPatch.shape;
  const channels = field("channels", shape.channels, undefined) ?? {};
  return {
    channels: dedupeChannels(channels),
    quiet_hours: field("quiet_hours", shape.quiet_hours, undefined) ?? null,
    timezone: field("timezone", shape.timezone, undefined) ?? null,
    digest_time: field("digest_time", shape.digest_time, undefined) ?? null,
    telegram_chat_id: field("telegram_chat_id", shape.telegram_chat_id, undefined) ?? null,
    signal_number: field("signal_number", shape.signal_number, undefined) ?? null,
    email: field("email", shape.email, undefined) ?? null,
    notify_channel: field("notify_channel", shape.notify_channel, undefined) ?? null,
  };
}

function dedupeChannels(
  channels: Partial<Record<NotificationKind, ChannelName[]>>,
): Partial<Record<NotificationKind, ChannelName[]>> {
  const out: Partial<Record<NotificationKind, ChannelName[]>> = {};
  for (const kind of NOTIFICATION_KINDS) {
    const list = channels[kind];
    if (list) out[kind] = [...new Set(list)];
  }
  return out;
}

/** Merge a validated patch into the stored JSON, keeping keys this module does not own. */
export function writePrefs(
  existing: JsonObject | null | undefined,
  patch: NotificationPrefsPatch,
): JsonObject {
  const current = readPrefs(existing);
  const next: NotificationPrefs = { ...current };
  if (patch.channels !== undefined) {
    const merged: Partial<Record<NotificationKind, ChannelName[]>> = { ...current.channels };
    for (const kind of NOTIFICATION_KINDS) {
      const list = patch.channels[kind];
      if (list !== undefined) merged[kind] = [...new Set(list)];
    }
    next.channels = merged;
  }
  if (patch.quiet_hours !== undefined) next.quiet_hours = patch.quiet_hours;
  if (patch.timezone !== undefined) next.timezone = patch.timezone;
  if (patch.digest_time !== undefined) next.digest_time = patch.digest_time;
  if (patch.telegram_chat_id !== undefined) next.telegram_chat_id = patch.telegram_chat_id;
  if (patch.signal_number !== undefined) next.signal_number = patch.signal_number;
  if (patch.email !== undefined) next.email = patch.email;
  if (patch.notify_channel !== undefined) next.notify_channel = patch.notify_channel;
  return { ...(existing ?? {}), ...toJson(next) };
}

function toJson(p: NotificationPrefs): JsonObject {
  const channels: JsonObject = {};
  for (const kind of NOTIFICATION_KINDS) {
    const list = p.channels[kind];
    if (list) channels[kind] = [...list];
  }
  const quiet: JsonValue = p.quiet_hours
    ? { start: p.quiet_hours.start, end: p.quiet_hours.end }
    : null;
  return {
    channels,
    quiet_hours: quiet,
    timezone: p.timezone,
    digest_time: p.digest_time,
    telegram_chat_id: p.telegram_chat_id,
    signal_number: p.signal_number,
    email: p.email,
    notify_channel: p.notify_channel,
  };
}

/** The stored preferences with the human's own time zone and email filled in. */
export function resolvePrefs(
  human: Pick<HumanRow, "timezone" | "email" | "notify_prefs">,
): ResolvedPrefs {
  const prefs = readPrefs(human.notify_prefs);
  const tz = prefs.timezone && isValidTimezone(prefs.timezone) ? prefs.timezone : human.timezone;
  return {
    ...prefs,
    timezone: tz && isValidTimezone(tz) ? tz : "UTC",
    email: prefs.email ?? (human.email || null),
  };
}

/**
 * Ordered channels for a kind (ADR 0017): the explicit per-kind list when set, otherwise the
 * preferred channel (`notify_channel`, desktop for "push" and when unset) followed by the
 * remaining channels in `CHANNEL_NAMES` order. The notifier skips channels that are not
 * configured and stops at the first delivery.
 */
export function channelsFor(kind: NotificationKind, prefs: NotificationPrefs): ChannelName[] {
  const explicit = prefs.channels[kind];
  if (explicit) return [...explicit];
  const preferred: ChannelName =
    prefs.notify_channel && prefs.notify_channel !== "push" ? prefs.notify_channel : "desktop";
  return [preferred, ...CHANNEL_NAMES.filter((c) => c !== preferred)];
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** True when the local time in `timezone` falls inside the window; a window may span midnight. */
export function isQuietAt(quiet: QuietHours | null, timezone: string, nowMs: number): boolean {
  if (!quiet || quiet.start === quiet.end) return false;
  const lp = localParts(nowMs, timezone);
  const t = lp.hour * 60 + lp.minute;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** Local day key (YYYY-MM-DD in `timezone`) and whether the digest time has passed today. */
export function digestState(
  digestTime: string | null,
  timezone: string,
  nowMs: number,
): { dayKey: string; due: boolean } {
  const lp = localParts(nowMs, timezone);
  if (!digestTime) return { dayKey: lp.dayKey, due: false };
  return { dayKey: lp.dayKey, due: lp.hour * 60 + lp.minute >= minutesOf(digestTime) };
}
