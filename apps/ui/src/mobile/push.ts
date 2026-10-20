/**
 * Push notifications (spec R.6) behind one port. FCM is not configured for this build (no
 * project keys; `docs/status/BLOCKERS.md`), so the shipped implementation is the visible
 * polling stand-in: the change feed (live or polling) raises in-app notices for approvals,
 * finished sessions, budget warnings and messages, and the Settings screen says "polling
 * stand-in (FCM not configured)". `FcmPush` is the seam the FCM wiring fills (token from the
 * shell's `push_token` command, registered at pairing as `pushToken`); quiet hours apply to
 * both. Nothing in the app depends on push: every screen reads the service itself.
 */
export type PushMode = "fcm" | "polling";

export interface PushStatus {
  mode: PushMode;
  /** Short reason shown in Settings, e.g. "FCM not configured; the change feed polls". */
  detail: string;
  /** The registration token to send at pairing, when a real push channel exists. */
  token: string | null;
}

export interface QuietHours {
  /** "22:00" to "07:00" local; null disables. */
  from: string | null;
  to: string | null;
}

export type PushCategory = "approval" | "session" | "budget" | "message";

export interface PushNotice {
  category: PushCategory;
  title: string;
  body: string;
  at: string;
}

export interface PushPort {
  status(): Promise<PushStatus>;
  /** Show a notice now (or swallow it inside quiet hours); returns whether it was shown. */
  notify(notice: PushNotice, quiet: QuietHours, nowLocalMinutes: number): boolean;
}

function minutesOf(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** True when `nowMinutes` (minutes since local midnight) falls inside the quiet window. */
export function inQuietHours(quiet: QuietHours, nowMinutes: number): boolean {
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  if (from === null || to === null) return false;
  if (from === to) return false;
  if (from < to) return nowMinutes >= from && nowMinutes < to;
  // Over midnight, e.g. 22:00 to 07:00.
  return nowMinutes >= from || nowMinutes < to;
}

/** The stand-in: in-app notices from the change feed; `shown` is what a screen renders. */
export class PollingPush implements PushPort {
  readonly shown: PushNotice[] = [];
  readonly suppressed: PushNotice[] = [];

  constructor(private readonly onShow?: (notice: PushNotice) => void) {}

  async status(): Promise<PushStatus> {
    return {
      mode: "polling",
      detail: "FCM not configured; notices come from the change feed (live or polling)",
      token: null,
    };
  }

  notify(notice: PushNotice, quiet: QuietHours, nowLocalMinutes: number): boolean {
    if (inQuietHours(quiet, nowLocalMinutes)) {
      this.suppressed.push(notice);
      return false;
    }
    this.shown.push(notice);
    if (this.shown.length > 50) this.shown.shift();
    this.onShow?.(notice);
    return true;
  }
}

/** Notices the change feed turns into push: the categories of spec R.6. */
export function noticeFor(
  type: string,
  payload: Record<string, unknown>,
  at: string,
): PushNotice | null {
  if (type === "human_request.changed" && payload.status === "open") {
    return {
      category: "approval",
      title: payload.blocking ? "Approval needed (blocking)" : "A request waits on you",
      body: "Open the inbox to answer.",
      at,
    };
  }
  if (
    type === "session.changed" &&
    (payload.status === "completed" || payload.status === "failed")
  ) {
    return {
      category: "session",
      title: payload.status === "completed" ? "Session finished" : "Session failed",
      body: typeof payload.id === "string" ? `Session ${payload.id}` : "",
      at,
    };
  }
  if (type === "message.changed" && !payload.receipt) {
    return { category: "message", title: "New message", body: "Open the inbox to read it.", at };
  }
  if (type === "project.changed" && payload.budgetWarning === true) {
    return {
      category: "budget",
      title: "Budget warning",
      body: "A project is near its budget.",
      at,
    };
  }
  return null;
}
