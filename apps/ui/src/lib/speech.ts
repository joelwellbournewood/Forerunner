import type { SpeakStartedView, SpeakView } from "@forerunner/runtime/daemon/api-types";
import { type DaemonClient, routePath } from "../api/client.ts";
import type { EventSourceFactory } from "../api/sse.ts";

/**
 * Playback of an utterance the daemon is reading aloud (spec A.6, L.6; ADR 0063). The daemon
 * synthesises through the voice provider and streams `audio` frames (16-bit PCM, the same frame
 * as a voice turn's reply) on `GET /speak/:id/events`; this follows the stream with
 * EventSource and plays the frames through Web Audio, scheduled back to back. Where the
 * browser has no EventSource or no AudioContext (jsdom, a webview without audio) it polls the
 * utterance until it ended, so the screen still follows what the daemon reads.
 *
 * This window is the only thing that makes the daemon's speech audible: the desktop sidecar
 * shows toasts but plays no audio, and the daemon's own sink only paces the frames. Where the
 * window can play, its `/events` stream declares it a speech player (`?speech=play`) and
 * `createSpeechAnnouncer` plays every utterance the daemon announces for any player (`speak.
 * started` with `player: "any"`: a voice alert, `summary.speak` by chat); the Read aloud
 * button plays its own (`player: "requester"`). The daemon holds playback until the stream
 * attached (a short grace), so the first words are not lost.
 */
export type PlaybackEnd = "done" | "cancelled" | "failed";

export interface SpeechPlayback {
  /** Resolves when the utterance ended (as the daemon reports it) or `stop()` was called. */
  readonly done: Promise<PlaybackEnd>;
  stop(): void;
}

/** The slice of `AudioContext` the player uses; injectable for tests. */
export interface AudioOutput {
  readonly currentTime: number;
  readonly destination: AudioNode;
  createBuffer(channels: number, frames: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  close(): Promise<void>;
  /** A context created without a user gesture may start suspended; resumed before playing. */
  resume?(): Promise<void>;
  /** Seconds from the context's output to the device's (AudioContext; not every browser has it). */
  readonly outputLatency?: number;
  /** Seconds the context itself adds before its output (AudioContext). */
  readonly baseLatency?: number;
  /** "running" while the context's clock advances (AudioContext); suspended: frozen. */
  readonly state?: string;
}

export interface PlaybackOptions {
  eventSource?: EventSourceFactory | undefined;
  /** The audio output; `null` plays nothing. Default: a new AudioContext when the browser has one. */
  audio?: () => AudioOutput | null;
  pollIntervalMs?: number;
  /** The sentence whose audio started (the screen highlights it). */
  onSentence?: (index: number) => void;
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

/** Whether this window can play the daemon's speech (EventSource and Web Audio both exist). */
export function canPlaySpeech(): boolean {
  return typeof EventSource !== "undefined" && typeof AudioContext !== "undefined";
}

function defaultAudio(): AudioOutput | null {
  if (typeof AudioContext === "undefined") return null;
  try {
    return new AudioContext();
  } catch {
    return null;
  }
}

/** Base64 16-bit little-endian PCM into one float buffer per channel. */
export function decodeFrame(frame: AudioFrame): Float32Array<ArrayBuffer>[] {
  const bytes = Uint8Array.from(atob(frame.pcm), (ch) => ch.charCodeAt(0));
  const samples = new Int16Array(bytes.buffer.slice(0, bytes.byteLength - (bytes.byteLength % 2)));
  const channels = Math.max(1, frame.channels);
  const frames = Math.floor(samples.length / channels);
  const out = Array.from(
    { length: channels },
    () => new Float32Array(new ArrayBuffer(frames * Float32Array.BYTES_PER_ELEMENT)),
  );
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      (out[c] as Float32Array)[i] = (samples[i * channels + c] ?? 0) / 32768;
    }
  }
  return out;
}

export function playSpeech(
  client: DaemonClient,
  speakId: string,
  options: PlaybackOptions = {},
): SpeechPlayback {
  const factory = options.eventSource === undefined ? defaultEventSource() : options.eventSource;
  const audio = options.audio ? options.audio() : defaultAudio();
  void audio?.resume?.().catch(() => undefined);
  let resolveDone: (end: PlaybackEnd) => void = () => undefined;
  const done = new Promise<PlaybackEnd>((resolve) => {
    resolveDone = resolve;
  });
  let finished = false;
  let source: ReturnType<EventSourceFactory> | null = null;
  let pollHandle: ReturnType<typeof setTimeout> | null = null;
  let nextAt = 0;
  let lastSentence = -1;

  const finish = (end: PlaybackEnd) => {
    if (finished) return;
    finished = true;
    if (pollHandle !== null) clearTimeout(pollHandle);
    source?.close();
    source = null;
    void audio?.close().catch(() => undefined);
    resolveDone(end);
  };

  const play = (frame: AudioFrame) => {
    if (frame.sentenceIndex !== lastSentence) {
      lastSentence = frame.sentenceIndex;
      options.onSentence?.(frame.sentenceIndex);
    }
    if (!audio) return;
    const channels = decodeFrame(frame);
    const frames = channels[0]?.length ?? 0;
    if (frames === 0) return;
    const buffer = audio.createBuffer(channels.length, frames, frame.sampleRate);
    for (const [c, data] of channels.entries()) buffer.copyToChannel(data, c);
    const node = audio.createBufferSource();
    node.buffer = buffer;
    node.connect(audio.destination);
    nextAt = Math.max(audio.currentTime, nextAt);
    node.start(nextAt);
    nextAt += buffer.duration;
  };

  const poll = () => {
    if (finished) return;
    client.speak(speakId).then(
      (view: SpeakView) => {
        if (finished) return;
        if (view.state !== "speaking") {
          finish(
            view.state === "done" ? "done" : view.state === "cancelled" ? "cancelled" : "failed",
          );
          return;
        }
        pollHandle = setTimeout(poll, options.pollIntervalMs ?? 1000);
      },
      () => finish("failed"),
    );
  };

  if (!factory) {
    poll();
  } else {
    try {
      source = factory(
        client.url(routePath("speakEvents", { id: speakId }), { afterSeq: 0 }, true),
      );
    } catch {
      source = null;
    }
    if (!source) {
      poll();
    } else {
      source.addEventListener("speak.event", (ev) => {
        if (finished) return;
        let parsed: { type?: string; data?: unknown };
        try {
          parsed = JSON.parse(String(ev.data)) as { type?: string; data?: unknown };
        } catch {
          return;
        }
        if (parsed.type === "audio") play(parsed.data as AudioFrame);
        else if (parsed.type === "speak.done") {
          const state = (parsed.data as { record?: { state?: string } }).record?.state;
          finish(state === "done" ? "done" : state === "cancelled" ? "cancelled" : "failed");
        } else if (parsed.type === "error") finish("failed");
      });
      source.onerror = () => {
        // The stream dropped: follow the utterance by polling instead of a silent spinner.
        source?.close();
        source = null;
        poll();
      };
    }
  }

  return {
    done,
    stop: () => finish("cancelled"),
  };
}

export interface SpeechAnnouncer {
  /** Told of every `speak.started` frame; plays the ones meant for any player. */
  started(view: SpeakStartedView): void;
  /** The utterance this window is playing for the daemon, if any. */
  readonly playing: string | null;
  close(): void;
}

/**
 * The window's speech player for what the daemon reads aloud on its own (ADR 0063): a voice
 * alert, `summary.speak` asked by chat. One at a time, as the daemon has one voice: a newer
 * utterance replaces the one playing (the daemon has already cancelled it). Utterances the
 * Read aloud button asked for (`player: "requester"`) are left to the button.
 */
export function createSpeechAnnouncer(
  client: DaemonClient,
  options: PlaybackOptions = {},
): SpeechAnnouncer {
  let current: { id: string; playback: SpeechPlayback } | null = null;
  let closed = false;
  return {
    started(view) {
      if (closed || view.player !== "any" || current?.id === view.id) return;
      current?.playback.stop();
      const entry = { id: view.id, playback: playSpeech(client, view.id, options) };
      current = entry;
      void entry.playback.done.then(() => {
        if (current === entry) current = null;
      });
    },
    get playing() {
      return current?.id ?? null;
    },
    close() {
      closed = true;
      current?.playback.stop();
      current = null;
    },
  };
}
