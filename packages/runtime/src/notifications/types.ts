/**
 * Notifications (spec K QoL "desktop notifications, tray menu", J inbox, E/F handoff at session
 * end, R.6 "push for approvals, finished sessions, budget warnings and messages, with quiet
 * hours", build order phase 5). Kinds, urgency, the notification shape, the per-human
 * preferences stored in `human.notify_prefs`, and the delivery records. ADR 0017 records the
 * channel fallback order and what counts as urgent.
 */

export const NOTIFICATION_KINDS = [
  "request_opened",
  "request_blocking",
  "session_ended",
  "budget_stop",
  "critic_verdict",
  "injection_flagged",
  "update_available",
  "update_applied",
  "email_command_received",
  "peer_message",
  "kill_switch",
  "daily_digest",
  "critic_calibration",
  "handover_report",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const URGENCIES = ["info", "normal", "urgent"] as const;
export type Urgency = (typeof URGENCIES)[number];

/** Channels in the default fallback order (ADR 0017): immediate first, slowest last. */
export const CHANNEL_NAMES = ["desktop", "telegram", "signal", "email"] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

/**
 * Default urgency per kind (ADR 0017). Urgent kinds go through quiet hours and never wait for
 * the digest; info kinds are bundled into the daily digest when one is configured; normal
 * kinds are sent at once outside quiet hours and held until the window ends inside them.
 */
export const KIND_URGENCY: Readonly<Record<NotificationKind, Urgency>> = {
  request_opened: "normal",
  request_blocking: "urgent",
  session_ended: "normal",
  budget_stop: "urgent",
  critic_verdict: "info",
  injection_flagged: "urgent",
  update_available: "info",
  update_applied: "normal",
  email_command_received: "normal",
  peer_message: "info",
  kill_switch: "urgent",
  daily_digest: "normal",
  critic_calibration: "normal",
  handover_report: "normal",
};

/** Kinds that always go through, whatever the hour (ADR 0017). */
export const URGENT_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>(
  (Object.keys(KIND_URGENCY) as NotificationKind[]).filter((k) => KIND_URGENCY[k] === "urgent"),
);

export interface Notification {
  kind: NotificationKind;
  humanId: string;
  title: string;
  body: string;
  /** Deep link into the app: a UI route path such as "/inbox" or "/sessions/<id>" (ADR 0031). */
  link: string;
  projectId?: string;
  /** When set, the delivery is also appended to that session's event log. */
  sessionId?: string;
  /** Same key within the dedupe window means the same notification: sent once. */
  dedupeKey: string;
  /** Raises the kind's default urgency; an urgent kind can never be lowered. */
  urgency?: Urgency;
}

/** Effective urgency: the kind's default, raised (never lowered) by the notification. */
export function urgencyOf(n: Pick<Notification, "kind" | "urgency">): Urgency {
  const base = KIND_URGENCY[n.kind];
  if (base === "urgent" || !n.urgency) return base;
  const rank: Record<Urgency, number> = { info: 0, normal: 1, urgent: 2 };
  return rank[n.urgency] > rank[base] ? n.urgency : base;
}

/** Local wall-clock window in HH:MM; `start === end` means no quiet hours. */
export interface QuietHours {
  start: string;
  end: string;
}

/**
 * Per-human preferences, stored as JSON in `human.notify_prefs`. Every field has a default so
 * `{}` is a valid value. Other modules keep their own keys in the same JSON object
 * (`cloud_runner`, ...); this module preserves what it does not know.
 */
export interface NotificationPrefs {
  /** Channels per kind in preference order; the first that delivers wins. Absent: the defaults. */
  channels: Partial<Record<NotificationKind, ChannelName[]>>;
  quiet_hours: QuietHours | null;
  /** IANA zone for quiet hours and the digest; null means the human's own `timezone`. */
  timezone: string | null;
  /** HH:MM local time of the daily digest; null disables the digest (info items go out at once). */
  digest_time: string | null;
  telegram_chat_id: string | null;
  /** The human's own Signal number (recipient), E.164. */
  signal_number: string | null;
  /** Address for the email channel; null means the human's primary email. */
  email: string | null;
  /** The single preferred channel the NL settings command writes ("push" is the Android client). */
  notify_channel: ChannelName | "push" | null;
}

/** Preferences with the human's own facts filled in. */
export interface ResolvedPrefs extends NotificationPrefs {
  timezone: string;
}

export type DeliveryStatus = "delivered" | "failed" | "unavailable" | "skipped";

/** One channel's outcome for one notification (after retries). */
export interface Delivery {
  channel: ChannelName;
  status: DeliveryStatus;
  reason: string | null;
  attempts: number;
  at: string;
}

export type NotificationOutcome =
  | "delivered"
  | "failed"
  | "held"
  | "digested"
  | "deduped"
  | "no_channel";

export type HeldFor = "quiet_hours" | "digest";

export interface NotificationRecord {
  id: string;
  notification: Notification;
  urgency: Urgency;
  outcome: NotificationOutcome;
  /** Why a `held` record waits: the quiet window to end, or the digest time. */
  heldFor: HeldFor | null;
  deliveries: Delivery[];
  createdAt: string;
  /** When the record left the queue (delivered, failed, bundled). Null while held. */
  resolvedAt: string | null;
}

/**
 * `fr://<route>` deep link for channels that leave the app (ADR 0031). The home route "/" is
 * `fr://open`, the explicit form the shell documents and tests for "/" (an empty authority
 * `fr://` is not a link every OS handler passes on).
 */
export function deepLinkFor(route: string): string {
  const path = route.replace(/^\/+/, "");
  return `fr://${path || "open"}`;
}
