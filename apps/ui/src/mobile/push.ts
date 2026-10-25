/**
 * Push notifications (spec R.6) behind one port. Two modes, decided by the Android build:
 * with a Firebase project (`google-services.json` in the app module, ADR 0085 point 9) the
 * shell's `push_status` reports `fcm` and the FCM registration token; the controller sends
 * that token at pairing (`pushToken`) and after a refresh (`PUT /devices/:id/push-token`),
 * and the state service pushes through FCM. Without it, and in a browser, the visible polling
 * stand-in raises in-app notices from the change feed (live or polling) and Settings says
 * "FCM not configured". Quiet hours apply to both. Nothing in the app depends on push: every
 * screen reads the service itself. The token goes to the state service and nowhere else: the
 * UI never logs, shows or stores it (only its SHA-256 fingerprint is kept, to tell a refresh
 * from the token already registered).
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

/**
 * The in-app route a tapped notification opens. The Android shell turns the FCM `link` into
 * `fr://open?link=<path>` (MainActivity) and the deep-link plugin hands it over like a pairing
 * link. Only a plain absolute app path is accepted (`/inbox`, `/sessions/ses_1`): no scheme,
 * no host, no `//`, no `..`, no query; anything else is null and opens nothing.
 */
export function parsePushLink(text: string): string | null {
  const t = text.trim();
  if (!/^fr:\/\/open(?:[/?]|$)/i.test(t)) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  return safeAppPath(u.searchParams.get("link"));
}

const APP_PATH = /^\/[A-Za-z0-9._~/-]{0,199}$/;

/** `link` when it is a plain in-app path, else null. */
export function safeAppPath(link: string | null | undefined): string | null {
  if (typeof link !== "string") return null;
  if (!APP_PATH.test(link) || link.startsWith("//")) return null;
  if (link.split("/").some((part) => part === "." || part === "..")) return null;
  return link;
}

/**
 * The SHA-256 fingerprint (hex) of a registration token, kept in place of the token so the
 * controller can tell a refresh from the token already registered.
 */
export async function pushTokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
