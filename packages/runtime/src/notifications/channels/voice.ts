/**
 * Voice channel (spec L.6 "TTS for alerts"; ADR 0063): an urgent notification is read aloud
 * through the voice provider registry, on top of the delivery the fallback chain made (the
 * toast stays: speech carries no link and vanishes). It is an *announcing* channel: the
 * notifier runs it for urgent records only, after the chain, and it never ends the chain. It
 * speaks only when the human turned voice alerts on (`notify_prefs.voice_alerts`), an app
 * window that plays speech holds the event stream (`/events?speech=play`: the UI in the
 * desktop shell's webview, which plays the frames through Web Audio; someone is at the machine
 * to hear it), no voice conversation is open (it would talk over it) and it is not quiet
 * hours; otherwise the delivery row says why (`skipped`) and the other channels have already
 * done their part. An utterance that failed or was cut short is not a delivery. The text is the notification's title and body, which producers already
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
  /** How the utterance ended: only `done` is a delivery. */
  state: "done" | "cancelled" | "failed";
  /** The provider's error when it failed. */
  error: { code: string; message: string } | null;
}

/** The slice of the daemon's speaker (`SpeakSessions`) the channel needs. */
export interface AlertSpeaker {
  say(req: {
    text: string;
    subject: VoiceChannelSpeakRequest["subject"];
    source: "notification";
  }): Promise<{
    id: string;
    sentences: readonly string[];
    done: Promise<{
      state: string;
      audioChunks: number;
      provider: string;
      error: { code: string; message: string } | null;
    }>;
  }>;
}

/** The channel's `speak` port over the speaker: waits for the end and reports how it ended. */
export function speakThrough(speaker: () => AlertSpeaker): VoiceChannelOptions["speak"] {
  return async (req) => {
    const u = await speaker().say({ text: req.text, subject: req.subject, source: "notification" });
    const r = await u.done;
    return {
      id: u.id,
      sentences: u.sentences.length,
      audioChunks: r.audioChunks,
      provider: r.provider,
      state: r.state === "done" ? "done" : r.state === "cancelled" ? "cancelled" : "failed",
      error: r.error,
    };
  };
}

export interface VoiceChannelOptions {
  clock: Clock;
  /** Reads the text aloud and resolves when it ended; throws `unavailable` when no TTS can run. */
  speak: (req: VoiceChannelSpeakRequest) => Promise<VoiceChannelSpoken>;
  /**
   * How many speech players hold the event stream (`/events?speech=play`); nothing is spoken
   * when no client would play the frames.
   */
  playersConnected: () => number;
  /** Why the voice is busy (an open voice conversation), or null; a busy voice is skipped. */
  busy?: () => string | null;
  /** Longest text read aloud; default 600 characters. */
  maxChars?: number;
}

export const VOICE_ALERTS_OFF = "voice alerts are off (set voice_alerts to true)";
export const VOICE_NOT_URGENT = "voice speaks urgent notifications only";
export const VOICE_QUIET_HOURS = "quiet hours";
export const VOICE_NO_PLAYER = "no app window open to play speech";
export const VOICE_IN_CONVERSATION = "a voice conversation is open";
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

  /**
   * The ADR 0063 rule: urgent only, never in quiet hours, only with a speech player attached,
   * never over an open voice conversation.
   */
  accepts(n: Notification, ctx: ChannelContext): string | null {
    if (urgencyOf(n) !== "urgent") return VOICE_NOT_URGENT;
    if (isQuietAt(ctx.prefs.quiet_hours, ctx.prefs.timezone, this.opts.clock.now()))
      return VOICE_QUIET_HOURS;
    if (this.opts.playersConnected() <= 0) return VOICE_NO_PLAYER;
    return this.opts.busy?.() ?? null;
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
      if (r.state === "cancelled") {
        return { ok: false, reason: "cut short by a newer utterance", retryable: false };
      }
      if (r.state === "failed") {
        // Retried only when nothing was heard: a retry repeats the whole alert.
        return {
          ok: false,
          reason: redact(r.error?.message ?? "speech failed").slice(0, 300),
          retryable: r.audioChunks === 0,
        };
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
