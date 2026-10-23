/**
 * Voice channel (spec L.6 "TTS for alerts"; ADR 0063): an urgent notification is read aloud
 * through the voice provider registry, on top of the delivery the fallback chain made (the
 * toast stays: speech carries no link and vanishes). It is an *announcing* channel: the
 * notifier runs it for urgent records only, after the chain, and it never ends the chain. It
 * speaks only when the human turned voice alerts on (`notify_prefs.voice_alerts`), a desktop
 * shell holds the event stream (someone is at the machine to hear it) and it is not quiet
 * hours; otherwise the delivery row says why (`skipped`) and the other channels have already
 * done their part. The text is the notification's title and body, which producers already
 * redact; the channel asserts it and refuses to speak a credential shape.
 */
import { type Clock, log, redact } from "@forerunner/platform";
import { isQuietAt } from "../prefs.ts";
import { type Notification, type NotificationKind, urgencyOf } from "../types.ts";
import type { Channel, ChannelContext, ChannelResult } from "./types.ts";

export interface VoiceChannelSpeakRequest {
  text: string;
  humanId: string;
  subject: { kind: "notification"; id: string; notificationKind: NotificationKind };
}

/** What the speaker reports once the utterance ended. */
export interface VoiceChannelSpoken {
  id: string;
  sentences: number;
  audioChunks: number;
  provider: string;
  interrupted: boolean;
}

export interface VoiceChannelOptions {
  clock: Clock;
  /** Reads the text aloud and resolves when it ended; throws `unavailable` when no TTS can run. */
  speak: (req: VoiceChannelSpeakRequest) => Promise<VoiceChannelSpoken>;
  /** How many shells hold the event stream; nothing is spoken to an empty room. */
  shellsConnected: () => number;
  /** Longest text read aloud; default 600 characters. */
  maxChars?: number;
}

export const VOICE_ALERTS_OFF = "voice alerts are off (set voice_alerts to true)";
export const VOICE_NOT_URGENT = "voice speaks urgent notifications only";
export const VOICE_QUIET_HOURS = "quiet hours";
export const VOICE_NO_SHELL = "no desktop shell attached";
export const VOICE_SECRET_SHAPE = "the notification text carries a credential shape; not spoken";

function cut(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** The spoken form: the title as a sentence, then the body. */
export function spokenAlert(n: Pick<Notification, "title" | "body">, maxChars = 600): string {
  const title = n.title.trim().replace(/[.!?]+$/, "");
  const body = n.body.trim();
  return cut(body ? `${title}. ${body}` : `${title}.`, maxChars);
}

export class VoiceChannel implements Channel {
  readonly name = "voice" as const;
  readonly announce = true;
  private readonly logger = log("notify:voice");

  constructor(private readonly opts: VoiceChannelOptions) {}

  configured(ctx: ChannelContext): string | null {
    return ctx.prefs.voice_alerts ? null : VOICE_ALERTS_OFF;
  }

  /** The ADR 0063 rule: urgent only, never in quiet hours, only with someone at the desktop. */
  accepts(n: Notification, ctx: ChannelContext): string | null {
    if (urgencyOf(n) !== "urgent") return VOICE_NOT_URGENT;
    if (isQuietAt(ctx.prefs.quiet_hours, ctx.prefs.timezone, this.opts.clock.now()))
      return VOICE_QUIET_HOURS;
    if (this.opts.shellsConnected() <= 0) return VOICE_NO_SHELL;
    return null;
  }

  async send(n: Notification, ctx: ChannelContext): Promise<ChannelResult> {
    const text = spokenAlert(n, this.opts.maxChars ?? 600);
    // Producers redact; this is the assertion. A text that changes under redaction is never
    // spoken, and neither the text nor the match reaches the log or the delivery row.
    if (redact(text) !== text) {
      this.logger.warn("notification text not spoken: credential shape", { kind: n.kind });
      return { ok: false, reason: VOICE_SECRET_SHAPE, retryable: false };
    }
    try {
      const r = await this.opts.speak({
        text,
        humanId: n.humanId,
        subject: {
          kind: "notification",
          id: ctx.recordId ?? n.dedupeKey,
          notificationKind: n.kind,
        },
      });
      if (r.interrupted) {
        return { ok: false, reason: "cut short by a newer utterance", retryable: false };
      }
      return {
        ok: true,
        detail: `spoken: ${r.sentences} sentence(s), ${r.audioChunks} chunk(s) via ${r.provider}`,
      };
    } catch (e) {
      const code = (e as { code?: string }).code;
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        reason: redact(message).slice(0, 300),
        retryable: code !== "unavailable" && code !== "validation",
      };
    }
  }
}
