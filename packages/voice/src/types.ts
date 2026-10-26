/**
 * Contracts for the voice package. Device IO (microphone capture, speaker playback) lives in
 * the Tauri shell (WASAPI on Windows, PipeWire/PulseAudio on Linux); this package only sees
 * PCM streams and runs the loop between STT, the conversation agent and TTS.
 */

/** A slice of mono or interleaved PCM, 16-bit signed little-endian samples. */
export interface AudioChunk {
  pcm: Int16Array | Buffer;
  sampleRate: number;
  channels: number;
  /** Position of the first sample on the capture or playback timeline, in ms. */
  timestampMs: number;
}

export type ProviderKind = "local" | "cloud" | "fake";

/** Result of an availability probe. Probes never throw; `reason` explains a false `ok`. */
export interface Availability {
  ok: boolean;
  reason: string;
}

export interface SttStartOptions {
  sampleRate: number;
  language?: string;
  signal?: AbortSignal;
}

export type SttEvent =
  | { type: "partial"; text: string; atMs: number }
  | {
      type: "final";
      text: string;
      /** Monotonic ms when the final transcript became available. */
      atMs: number;
      /** Speech span inside the audio, when the provider reports it. */
      startMs?: number;
      endMs?: number;
      language?: string;
      confidence?: number;
    }
  | {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
      /** Diagnostics for the log and the turn's error (a crashed helper's exit and stderr tail). */
      details?: Record<string, unknown>;
    };

export interface SttSession {
  push(chunk: AudioChunk): void;
  /** The speaker stopped: produce the final transcript as fast as possible. */
  endOfSpeech(): void;
  /** Partial transcripts, then one final (or an error). Ends after close() or the final. */
  readonly events: AsyncIterable<SttEvent>;
  close(): Promise<void>;
}

export interface SttProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  isAvailable(): Promise<Availability>;
  start(opts: SttStartOptions): SttSession;
}

export interface TtsOptions {
  voice?: string;
  /** 1 = normal; providers map it to their own parameter. */
  speed?: number;
  /** Requested output rate; providers that cannot honour it report the real rate per chunk. */
  sampleRate?: number;
  language?: string;
  signal?: AbortSignal;
}

export interface TtsProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  isAvailable(): Promise<Availability>;
  /** Streams audio for one sentence. Stops promptly when `opts.signal` aborts. */
  synthesize(text: string, opts?: TtsOptions): AsyncIterable<AudioChunk>;
}

export type VadEvent =
  | { type: "speech_start"; atMs: number }
  | {
      type: "speech_end";
      /** Timeline position where speech actually ended. */
      atMs: number;
      /** How long after the real end the detector noticed it (the hangover). */
      endOfTurnMs: number;
      /** Length of the speech segment. */
      speechMs: number;
    };

export interface Vad {
  push(chunk: AudioChunk): VadEvent[];
  reset(): void;
  readonly speaking: boolean;
}

/** Where synthesised audio goes. The Tauri shell implements this over the device. */
export interface AudioSink {
  /** Resolves when the chunk has been handed over (or dropped because of the abort). */
  play(chunk: AudioChunk, signal: AbortSignal): Promise<void>;
  /** Flush anything queued on the device; called on barge-in. */
  stop(): void;
  /**
   * Resolves once what was handed over has played out (or at once on the abort). A sink that
   * runs ahead of real time implements it; the loop and the speaker await it before they say
   * the reply ended, so a player that closes on the end does not cut the tail.
   */
  drain?(signal: AbortSignal): Promise<void>;
}

/** Returns the 16-bit samples of a chunk as an Int16Array (a view when aligned, else a copy). */
export function toInt16(pcm: Int16Array | Buffer): Int16Array {
  if (pcm instanceof Int16Array) return pcm;
  const even = pcm.byteLength - (pcm.byteLength % 2);
  if (pcm.byteOffset % 2 === 0) {
    return new Int16Array(pcm.buffer, pcm.byteOffset, even / 2);
  }
  const copy = new Int16Array(even / 2);
  for (let i = 0; i < copy.length; i++) copy[i] = pcm.readInt16LE(i * 2);
  return copy;
}

/** Duration of a chunk in ms. */
export function chunkDurationMs(chunk: AudioChunk): number {
  const frames = toInt16(chunk.pcm).length / Math.max(1, chunk.channels);
  return (frames / chunk.sampleRate) * 1000;
}
