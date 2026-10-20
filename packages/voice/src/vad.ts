/**
 * Energy + zero-crossing voice activity detector with hangover.
 *
 * Deterministic: it works on fixed frames cut from the pushed chunks, keeps the leftover
 * samples between pushes, and derives every event time from chunk timestamps, so the same
 * PCM always produces the same events whatever the chunk size.
 */
import { type AudioChunk, toInt16, type Vad, type VadEvent } from "./types.ts";
import { downmix } from "./wav.ts";

export interface VadOptions {
  /** Frame length used for the decision. Default 20 ms. */
  frameMs?: number;
  /** RMS level (0..1 of full scale) at or above which a frame counts as loud. Default 0.02. */
  energyThreshold?: number;
  /** Zero-crossing rate (crossings per sample) above which a loud frame is treated as noise. Default 0.5. */
  zcrMax?: number;
  /** Speech shorter than this is ignored. Default 150 ms. */
  minSpeechMs?: number;
  /** Silence needed after speech before the turn ends (the hangover). Default 200 ms. */
  endOfTurnSilenceMs?: number;
}

export const DEFAULT_VAD_OPTIONS: Required<VadOptions> = {
  frameMs: 20,
  energyThreshold: 0.02,
  zcrMax: 0.5,
  minSpeechMs: 150,
  endOfTurnSilenceMs: 200,
};

export class EnergyVad implements Vad {
  private readonly opts: Required<VadOptions>;
  private leftover: Int16Array = new Int16Array(0);
  private leftoverStartMs = 0;
  private state: "silence" | "candidate" | "speech" = "silence";
  private candidateStartMs = 0;
  private candidateMs = 0;
  private lastSpeechEndMs = 0;
  private silenceMs = 0;
  private speechStartMs = 0;

  constructor(opts: VadOptions = {}) {
    this.opts = { ...DEFAULT_VAD_OPTIONS, ...opts };
  }

  get speaking(): boolean {
    return this.state === "speech";
  }

  reset(): void {
    this.leftover = new Int16Array(0);
    this.leftoverStartMs = 0;
    this.state = "silence";
    this.candidateMs = 0;
    this.silenceMs = 0;
  }

  push(chunk: AudioChunk): VadEvent[] {
    const mono = downmix(toInt16(chunk.pcm), chunk.channels);
    const frameLen = Math.max(1, Math.round((this.opts.frameMs / 1000) * chunk.sampleRate));
    const events: VadEvent[] = [];

    let samples: Int16Array;
    let startMs: number;
    if (this.leftover.length > 0) {
      samples = new Int16Array(this.leftover.length + mono.length);
      samples.set(this.leftover, 0);
      samples.set(mono, this.leftover.length);
      startMs = this.leftoverStartMs;
    } else {
      samples = mono;
      startMs = chunk.timestampMs;
    }

    let off = 0;
    for (; off + frameLen <= samples.length; off += frameLen) {
      const frameStart = startMs + (off / chunk.sampleRate) * 1000;
      const loud = this.isSpeechFrame(samples.subarray(off, off + frameLen));
      this.step(loud, frameStart, this.opts.frameMs, events);
    }
    this.leftover = samples.slice(off);
    this.leftoverStartMs = startMs + (off / chunk.sampleRate) * 1000;
    return events;
  }

  private isSpeechFrame(frame: Int16Array): boolean {
    let sum = 0;
    let crossings = 0;
    let prev = frame[0] ?? 0;
    for (let i = 0; i < frame.length; i++) {
      const s = frame[i] ?? 0;
      sum += s * s;
      if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) crossings++;
      prev = s;
    }
    const rms = Math.sqrt(sum / Math.max(1, frame.length)) / 32768;
    const zcr = crossings / Math.max(1, frame.length);
    return rms >= this.opts.energyThreshold && zcr <= this.opts.zcrMax;
  }

  private step(loud: boolean, frameStart: number, frameMs: number, out: VadEvent[]): void {
    const frameEnd = frameStart + frameMs;
    switch (this.state) {
      case "silence":
        if (loud) {
          this.state = "candidate";
          this.candidateStartMs = frameStart;
          this.candidateMs = frameMs;
          this.promoteIfLongEnough(frameEnd, out);
        }
        break;
      case "candidate":
        if (loud) {
          this.candidateMs += frameMs;
          this.promoteIfLongEnough(frameEnd, out);
        } else {
          this.state = "silence";
          this.candidateMs = 0;
        }
        break;
      case "speech":
        if (loud) {
          this.silenceMs = 0;
          this.lastSpeechEndMs = frameEnd;
        } else {
          this.silenceMs += frameMs;
          if (this.silenceMs >= this.opts.endOfTurnSilenceMs) {
            out.push({
              type: "speech_end",
              atMs: round(this.lastSpeechEndMs),
              endOfTurnMs: round(this.silenceMs),
              speechMs: round(this.lastSpeechEndMs - this.speechStartMs),
            });
            this.state = "silence";
            this.silenceMs = 0;
          }
        }
        break;
    }
  }

  private promoteIfLongEnough(frameEnd: number, out: VadEvent[]): void {
    if (this.candidateMs >= this.opts.minSpeechMs) {
      this.state = "speech";
      this.speechStartMs = this.candidateStartMs;
      this.lastSpeechEndMs = frameEnd;
      this.silenceMs = 0;
      out.push({ type: "speech_start", atMs: round(this.candidateStartMs) });
    }
  }
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
