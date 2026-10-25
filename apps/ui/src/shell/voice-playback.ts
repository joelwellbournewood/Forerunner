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
 * Every frame is numbered (`seq`, also its SSE id). The player keeps the last seq it acted on
 * and drops any frame at or below it: an EventSource reconnects on its own (a stream hiccup,
 * and every few seconds once the daemon has ended the stream of a stopped session), and a
 * replayed `barge_in` must not silence the reply playing now. The daemon resumes after the
 * Last-Event-ID the browser sends; this check holds even when it does not.
 *
 * What is queued is silenced when the loop says the reply of the turn being played is over
 * before its end: a `barge_in`, an `error` (the loop aborts its sink) or a `turn_end` whose
 * latency says the turn was interrupted, each only for the turn whose audio is queued (an
 * event of another turn leaves it alone), and `voice.stopped` always (it also closes the
 * stream: the session is over). A silenced turn's late frames are dropped. A turn that ends
 * normally lets the queue finish. With an empty queue a chunk starts `leadMs` after the
 * context's current time, so a main-thread stall between scheduling and the render quantum
 * does not clip its start (a click); back-to-back chunks follow without a gap.
 *
 * What the human heard (spec O.5, D.8): after `turnEnded()` (the push-to-talk release: Send or
 * the hotkey) the next turn's first chunk is measured. Its scheduled start in context time is
 * mapped onto the page's clock (`now()` and `currentTime` read together), the output device's
 * latency (`outputLatency`, else `baseLatency`) is added, and the release time is subtracted:
 * release to sound at the speaker, all on one clock, lead included. It is posted once per turn
 * (`POST /voice/sessions/:id/heard`) and lands on the turn's `voice.turn` row as
 * `heardFirstAudioMs`, beside the daemon-side `totalToFirstAudioMs`. Without EventSource or an
 * audio output nothing plays, nothing is measured and the turn still shows as text.
 */
export interface VoiceReplyPlayer {
  readonly sessionId: string;
  /** The human released push-to-talk now: the next turn's first chunk is measured from here. */
  turnEnded(): void;
  /** Resume the output (call it from a click or key handler: a context may start suspended). */
  resume(): void;
  /** Silence what is queued and stop following the session; closes the audio output. */
  close(): void;
}

/** With an empty queue a chunk starts this long after the context's current time. */
export const PLAYBACK_LEAD_MS = 50;

export interface VoiceReplyOptions {
  eventSource?: EventSourceFactory | undefined;
  /**
   * The audio output, created in the Talk click or the hotkey press (`createVoiceOutput`) so
   * the context may start; `null` plays nothing. Default: a new one here.
   */
  output?: AudioOutput | null;
  /** The page's clock in ms (`performance.now()`); the release and the start are read on it. */
  now?: () => number;
  /** Where the heard figure goes; default `client.voiceHeard`. */
  onHeard?: (turn: number, heardFirstAudioMs: number) => void;
  leadMs?: number;
}

interface AudioFrame {
  sentenceIndex: number;
  sampleRate: number;
  channels: number;
  pcm: string;
}

interface Frame {
  seq?: unknown;
  type?: string;
  turn?: unknown;
  data?: unknown;
}

function defaultEventSource(): EventSourceFactory | undefined {
  if (typeof EventSource === "undefined") return undefined;
  return (url) => new EventSource(url);
}

const defaultNow = () => (typeof performance !== "undefined" ? performance.now() : Number.NaN);

/**
 * A new audio output, resumed at once: call it synchronously in the click or key handler that
 * starts the turn (before any await), so a webview that wants a user gesture lets it start.
 */
export function createVoiceOutput(factory?: () => AudioOutput | null): AudioOutput | null {
  let output: AudioOutput | null = null;
  try {
    output = factory ? factory() : typeof AudioContext === "undefined" ? null : new AudioContext();
  } catch {
    output = null;
  }
  void output?.resume?.().catch(() => undefined);
  return output;
}

/** The output device's latency in ms: `outputLatency` where the browser reports it, else `baseLatency`. */
function deviceLatencyMs(audio: AudioOutput): number {
  const out = audio.outputLatency;
  if (typeof out === "number" && Number.isFinite(out) && out > 0) return out * 1000;
  const base = audio.baseLatency;
  if (typeof base === "number" && Number.isFinite(base) && base > 0) return base * 1000;
  return 0;
}

export function followVoiceReply(
  client: DaemonClient,
  session: { id: string; lastSeq: number },
  options: VoiceReplyOptions = {},
): VoiceReplyPlayer | null {
  const factory = options.eventSource === undefined ? defaultEventSource() : options.eventSource;
  if (!factory) return null;
  const audio = options.output === undefined ? createVoiceOutput() : options.output;
  const now = options.now ?? defaultNow;
  const leadS = Math.max(0, options.leadMs ?? PLAYBACK_LEAD_MS) / 1000;
  const onHeard =
    options.onHeard ??
    ((turn: number, ms: number) => {
      void client.voiceHeard(session.id, { turn, heardFirstAudioMs: ms }).catch(() => undefined);
    });
  let lastSeq = Math.max(0, session.lastSeq);
  let source: EventSourceLike | null = null;
  try {
    source = factory(
      client.url(routePath("voiceEvents", { id: session.id }), { afterSeq: lastSeq }, true),
    );
  } catch {
    source = null;
  }
  let closed = false;
  let nextAt = 0;
  const queued = new Set<AudioBufferSourceNode>();
  /** The turn whose audio is queued (or was last played). */
  let playingTurn: number | null = null;
  /** Turns cut short: their late frames are not played. */
  const silenced = new Set<number>();
  /** The highest turn that played audio; a release measures the first turn after it. */
  let lastAudioTurn = 0;
  let release: { atMs: number; afterTurn: number } | null = null;
  const measured = new Set<number>();

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
    if (playingTurn !== null) silenced.add(playingTurn);
  };

  const play = (turn: number | null, frame: AudioFrame) => {
    if (!audio) return;
    if (turn !== null && silenced.has(turn)) return;
    const channels = decodeFrame(frame);
    const frames = channels[0]?.length ?? 0;
    if (frames === 0 || !(frame.sampleRate > 0)) return;
    const buffer = audio.createBuffer(channels.length, frames, frame.sampleRate);
    for (const [c, data] of channels.entries()) buffer.copyToChannel(data, c);
    const node = audio.createBufferSource();
    node.buffer = buffer;
    node.connect(audio.destination);
    node.onended = () => queued.delete(node);
    const ctxNow = audio.currentTime;
    const wallNow = now();
    // An empty (or drained) queue starts after the lead; a queued reply continues back to back.
    const startAt = nextAt > ctxNow ? nextAt : ctxNow + leadS;
    node.start(startAt);
    nextAt = startAt + buffer.duration;
    queued.add(node);
    if (turn === null) return;
    playingTurn = turn;
    if (release && turn > release.afterTurn && !measured.has(turn)) {
      measured.add(turn);
      const heard = wallNow + (startAt - ctxNow) * 1000 + deviceLatencyMs(audio) - release.atMs;
      release = null;
      if (Number.isFinite(heard) && heard >= 0) onHeard(turn, Math.round(heard));
    }
    lastAudioTurn = Math.max(lastAudioTurn, turn);
  };

  source?.addEventListener("voice.event", (ev) => {
    // Closed, or no longer following a stopped session.
    if (closed || source === null) return;
    let parsed: Frame;
    try {
      parsed = JSON.parse(String(ev.data)) as Frame;
    } catch {
      return;
    }
    // A frame this player already acted on (a reconnect's replay) is dropped.
    if (typeof parsed.seq === "number") {
      if (parsed.seq <= lastSeq) return;
      lastSeq = parsed.seq;
    }
    const turn = typeof parsed.turn === "number" ? parsed.turn : null;
    const forPlaying = turn === null || turn === playingTurn;
    switch (parsed.type) {
      case "audio":
        play(turn, parsed.data as AudioFrame);
        break;
      case "barge_in":
      case "error":
        if (forPlaying) silence();
        break;
      case "voice.stopped":
        silence();
        // The session is over: stop following it (the daemon ends the stream; an open
        // EventSource would reconnect every few seconds).
        source?.close();
        source = null;
        break;
      case "turn_end": {
        const latency = (parsed.data as { latency?: { interrupted?: boolean } } | null)?.latency;
        if (latency?.interrupted && forPlaying) silence();
        // The released turn ended without audio: the next turn is not measured from it.
        if (release && turn !== null && turn > release.afterTurn && !measured.has(turn))
          release = null;
        break;
      }
      default:
        break;
    }
  });

  return {
    sessionId: session.id,
    turnEnded() {
      if (closed) return;
      const atMs = now();
      release = Number.isFinite(atMs) ? { atMs, afterTurn: lastAudioTurn } : null;
    },
    resume() {
      void audio?.resume?.().catch(() => undefined);
    },
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
