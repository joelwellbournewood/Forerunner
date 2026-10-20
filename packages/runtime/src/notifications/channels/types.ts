/**
 * Channel contract. A channel never decides routing, quiet hours or retries: it reports whether
 * it is configured for this human and tries one send. `retryable: false` tells the notifier to
 * move on to the next channel at once (missing tool, missing address, rejected payload).
 */
import type { ChannelName, Notification, ResolvedPrefs } from "../types.ts";

export interface HumanFacts {
  id: string;
  name: string;
  email: string;
  timezone: string;
}

export interface ChannelContext {
  human: HumanFacts;
  prefs: ResolvedPrefs;
  /**
   * The `NotificationRecord` id this send belongs to (what `GET /notifications/recent` lists),
   * set by the notifier on every dispatch; absent for a test send, which has no record.
   */
  recordId?: string;
}

export type ChannelResult =
  | { ok: true; detail: string | null }
  | { ok: false; reason: string; retryable: boolean };

export interface Channel {
  readonly name: ChannelName;
  /** Null when the channel can be used for this human; otherwise why not (shown in settings). */
  configured(ctx: ChannelContext): string | null;
  send(n: Notification, ctx: ChannelContext): Promise<ChannelResult>;
}

/** Plain-text body for channels outside the app: body, then the deep link. */
export function plainText(n: Notification, deepLink: string): string {
  return `${n.title}\n\n${n.body}\n\nOpen: ${deepLink}`;
}
