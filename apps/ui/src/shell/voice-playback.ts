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
 * stream: the session is over). A silenced turn's late frames are dropped, and so is what it
 * still buffers. A turn that ends normally lets the queue finish.
 *
 * A jitter buffer sits in front of the queue: a local TTS on a slow CPU streams its ~100 ms
 * chunks slower than real time, and scheduling each one as it arrives left a gap inside a
 * word at every late chunk (the real-audio run of 2026-10-26). A turn starts only once
 * `JITTER_START_MS` of audio is in hand, or earlier when the sentence being buffered is known
 * to be complete (the next sentence's first chunk, `speaking_end`, a normal `turn_end`) or no
 * audio came for `JITTER_IDLE_MS`. When the queue runs dry inside a turn (a chunk arrives after
 * the last one ended) the target doubles, up to `JITTER_MAX_MS`, and the turn re-buffers to it
 * before resuming: one pause instead of a gap per chunk. The target is kept for the rest of the
 * session (the CPU stays as slow) and never shrinks. A buffer's contents start `leadMs` after
 * the context's current time (or right after what still plays), so a main-thread stall between
 * scheduling and the render quantum does not clip its start (a click); back-to-back chunks
 * follow without a gap and without a fade (consecutive chunks are one waveform cut at sample
 * boundaries; a fade would dip every chunk).
 *
 * What the human heard (spec O.5, D.8): after `turnEnded()` (the push-to-talk release: Send or
 * the hotkey) the next turn's first chunk is measured. Its scheduled start in context time is
 * mapped onto the page's clock (`now()` and `currentTime` read together), the context's and the
 * device's latency (`baseLatency` plus `outputLatency`) is added, and the release time is subtracted
 * (a turn played while the context is not running is not measured):
 * release to sound at the speaker, all on one clock, buffering and lead included (the figure is
 * read when the buffered audio is scheduled, not when its first chunk arrived). It is posted once per turn
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
  /** The jitter buffer's current target in ms (grows after an underrun; diagnostics). */
  readonly bufferTargetMs: number;
}

/** With an empty queue a chunk starts this long after the context's current time. */
export const PLAYBACK_LEAD_MS = 50;
/** The jitter buffer's target at a session's start: audio in hand before a turn starts. */
export const JITTER_START_MS = 200;
/** The target doubles after each underrun up to this bound (kept for the session). */
export const JITTER_MAX_MS = 1000;
/** A buffer short of its target starts anyway once no audio came for this long. */
export const JITTER_IDLE_MS = 250;

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
  /** A timer on the page's clock (the buffer's pause rule); returns its cancel. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const defaultSetTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

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

/**
 * The latency after a chunk's scheduled start, in ms: the context's own `baseLatency` plus
 * `outputLatency` to the device (consecutive stages); either is left out where the browser does
 * not report it.
 */
function deviceLatencyMs(audio: AudioOutput): number {
  const ms = (v: number | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v * 1000 : 0;
  return ms(audio.baseLatency) + ms(audio.outputLatency);
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
  const setTimer = options.setTimer ?? defaultSetTimer;
  let closed = false;
  let nextAt = 0;
  const queued = new Set<AudioBufferSourceNode>();
  /** The turn whose audio is buffered or queued (or was last played). */
  let playingTurn: number | null = null;
  /** Whether the playing turn has scheduled audio yet. */
  let started = false;
  /** Collecting audio before the turn starts or resumes after an underrun. */
  let buffering = false;
  let pending: Array<{ buffer: AudioBuffer; sentenceIndex: number }> = [];
  let pendingS = 0;
  let targetS = JITTER_START_MS / 1000;
  const maxS = JITTER_MAX_MS / 1000;
  let cancelIdle: (() => void) | null = null;
  /** Turns cut short: their late frames are not played. */
  const silenced = new Set<number>();
  /** The highest turn that played audio; a release measures the first turn after it. */
  let lastAudioTurn = 0;
  let release: { atMs: number; afterTurn: number } | null = null;
  const measured = new Set<number>();

  const stopIdle = () => {
    cancelIdle?.();
    cancelIdle = null;
  };

  const silence = () => {
    stopIdle();
    pending = [];
    pendingS = 0;
    buffering = false;
    started = false;
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

  /** Measure the playing turn's first scheduled chunk (`startAt` in context time). */
  const measure = (output: AudioOutput, turn: number, startAt: number, ctxNow: number) => {
    const wallNow = now();
    if (release && turn > release.afterTurn && !measured.has(turn)) {
      measured.add(turn);
      // A suspended context's clock is frozen: its start time says nothing about when (or
      // whether) the human hears it, so that turn is not measured.
      if (output.state !== undefined && output.state !== "running") {
        release = null;
        return;
      }
      const heard = wallNow + (startAt - ctxNow) * 1000 + deviceLatencyMs(output) - release.atMs;
      release = null;
      if (Number.isFinite(heard) && heard >= 0) onHeard(turn, Math.round(heard));
    }
  };

  /**
   * Schedule what is buffered back to back: after the queue if it still plays, otherwise after
   * the lead. The heard figure is read here, so it includes the time spent buffering.
   */
  const flush = () => {
    stopIdle();
    buffering = false;
    if (!audio || closed || pending.length === 0) return;
    const ctxNow = audio.currentTime;
    const startAt = nextAt > ctxNow ? nextAt : ctxNow + leadS;
    let at = startAt;
    for (const { buffer } of pending) {
      const node = audio.createBufferSource();
      node.buffer = buffer;
      node.connect(audio.destination);
      node.onended = () => queued.delete(node);
      node.start(at);
      queued.add(node);
      at += buffer.duration;
    }
    nextAt = at;
    pending = [];
    pendingS = 0;
    const turn = playingTurn;
    if (turn === null) return;
    if (!started) measure(audio, turn, startAt, ctxNow);
    started = true;
    lastAudioTurn = Math.max(lastAudioTurn, turn);
  };

  const play = (turn: number | null, frame: AudioFrame) => {
    if (!audio) return;
    if (turn !== null && silenced.has(turn)) return;
    const channels = decodeFrame(frame);
    const frames = channels[0]?.length ?? 0;
    if (frames === 0 || !(frame.sampleRate > 0)) return;
    const buffer = audio.createBuffer(channels.length, frames, frame.sampleRate);
    for (const [c, data] of channels.entries()) buffer.copyToChannel(data, c);
    const sentenceIndex = typeof frame.sentenceIndex === "number" ? frame.sentenceIndex : 0;
    if (turn !== playingTurn) {
      // A new turn: what an earlier turn still buffers goes out first, then this one buffers.
      if (pending.length > 0) flush();
      playingTurn = turn;
      started = false;
      buffering = true;
    } else if (!buffering) {
      if (!started) buffering = true;
      else if (nextAt <= audio.currentTime) {
        // An underrun inside the turn: the queue ran dry before this chunk came. Resume only
        // with more in hand, so a TTS slower than real time pauses once rather than at every
        // late chunk.
        targetS = Math.min(maxS, targetS * 2);
        buffering = true;
      }
    }
    if (!buffering) {
      pending = [{ buffer, sentenceIndex }];
      flush();
      return;
    }
    // A chunk of the next sentence: the buffered sentence is complete, so it starts even when
    // it is shorter than the target.
    const sentenceDone = pending.length > 0 && pending[0]?.sentenceIndex !== sentenceIndex;
    pending.push({ buffer, sentenceIndex });
    pendingS += buffer.duration;
    if (sentenceDone || pendingS >= targetS - 1e-9) {
      flush();
      return;
    }
    // Short of the target: start anyway when no more audio comes for a while.
    stopIdle();
    cancelIdle = setTimer(() => {
      cancelIdle = null;
      if (buffering) flush();
    }, JITTER_IDLE_MS);
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
      case "speaking_end":
        // The turn's audio is complete: what is buffered starts, short of the target or not.
        if (forPlaying && buffering) flush();
        break;
      case "turn_end": {
        const latency = (parsed.data as { latency?: { interrupted?: boolean } } | null)?.latency;
        if (latency?.interrupted && forPlaying) silence();
        else if (forPlaying && buffering) flush();
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
    get bufferTargetMs() {
      return Math.round(targetS * 1000);
    },
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
