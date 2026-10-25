import { type DaemonClient, routePath } from "../api/client.ts";
import type { EventSourceFactory, EventSourceLike } from "../api/sse.ts";
import { type AudioOutput, decodeFrame } from "../lib/speech.ts";

/**
 * Playback of a voice session's reply (spec O.3): the daemon streams the reply as `audio`
 * frames (base64 16-bit little-endian PCM with its `sampleRate` and `channels`) on
 * `GET /voice/sessions/:id/events`; this follows that stream with EventSource and schedules
 * the chunks back to back through Web Audio, in the order they arrive. The daemon's sink only
 * paces the frames and the desktop shell plays nothing natively (`media.rs` only answers the
 * webview's microphone permission), so this window is what makes the reply audible, in a
 * browser and in the Tauri webview alike.
 *
 * What is queued is silenced when the loop says the reply is over before its end: a
 * `barge_in`, an `error` (the loop aborts its sink), a `turn_end` whose latency says the turn
 * was interrupted, and `voice.stopped`; a turn that ends normally lets the queue finish.
 * Frames sent before the subscription are not asked for (`afterSeq` = the session's last seq),
 * and audio frames are never replayed by the daemon anyway. Without EventSource or an audio
 * output nothing plays and the turn still shows as text.
 */
export interface VoiceReplyPlayer {
  readonly sessionId: string;
  /** Silence what is queued and stop following the session; closes the audio output. */
  close(): void;
}

export interface VoiceReplyOptions {
  eventSource?: EventSourceFactory | undefined;
  /** The audio output; `null` plays nothing. Default: a new AudioContext when there is one. */
  audio?: () => AudioOutput | null;
}

interface AudioFrame {
  sentenceIndex: number;
  sampleRate: number;
  channels: number;
  pcm: string;
}

function defaultEventSource(): EventSourceFactory | undefined {
  if (typeof EventSource === "undefined") return undefined;
  return (url) => new EventSource(url);
}

function defaultAudio(): AudioOutput | null {
  if (typeof AudioContext === "undefined") return null;
  try {
    return new AudioContext();
  } catch {
    return null;
  }
}

export function followVoiceReply(
  client: DaemonClient,
  session: { id: string; lastSeq: number },
  options: VoiceReplyOptions = {},
): VoiceReplyPlayer | null {
  const factory = options.eventSource === undefined ? defaultEventSource() : options.eventSource;
  if (!factory) return null;
  // Created on the Talk click or the hotkey press, so the context may start; resumed anyway
  // (a webview can create it suspended without a gesture).
  const audio = options.audio ? options.audio() : defaultAudio();
  void audio?.resume?.().catch(() => undefined);
  let source: EventSourceLike | null = null;
  try {
    source = factory(
      client.url(
        routePath("voiceEvents", { id: session.id }),
        { afterSeq: Math.max(0, session.lastSeq) },
        true,
      ),
    );
  } catch {
    source = null;
  }
  let closed = false;
  let nextAt = 0;
  const queued = new Set<AudioBufferSourceNode>();

  const silence = () => {
    for (const node of queued) {
      try {
        node.stop();
      } catch {
        // already ended
      }
    }
    queued.clear();
    nextAt = 0;
  };

  const play = (frame: AudioFrame) => {
    if (!audio) return;
    const channels = decodeFrame(frame);
    const frames = channels[0]?.length ?? 0;
    if (frames === 0 || !(frame.sampleRate > 0)) return;
    const buffer = audio.createBuffer(channels.length, frames, frame.sampleRate);
    for (const [c, data] of channels.entries()) buffer.copyToChannel(data, c);
    const node = audio.createBufferSource();
    node.buffer = buffer;
    node.connect(audio.destination);
    node.onended = () => queued.delete(node);
    nextAt = Math.max(audio.currentTime, nextAt);
    node.start(nextAt);
    nextAt += buffer.duration;
    queued.add(node);
  };

  source?.addEventListener("voice.event", (ev) => {
    if (closed) return;
    let parsed: { type?: string; data?: unknown };
    try {
      parsed = JSON.parse(String(ev.data)) as { type?: string; data?: unknown };
    } catch {
      return;
    }
    switch (parsed.type) {
      case "audio":
        play(parsed.data as AudioFrame);
        break;
      case "barge_in":
      case "error":
      case "voice.stopped":
        silence();
        break;
      case "turn_end": {
        const latency = (parsed.data as { latency?: { interrupted?: boolean } } | null)?.latency;
        if (latency?.interrupted) silence();
        break;
      }
      default:
        break;
    }
  });

  return {
    sessionId: session.id,
    close() {
      if (closed) return;
      closed = true;
      silence();
      source?.close();
      source = null;
      void audio?.close().catch(() => undefined);
    },
  };
}
