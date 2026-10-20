/**
 * Scripted providers for tests and for the "no key, no helper" fallback. Every delay goes
 * through the injected Clock so a SimulatedClock makes latency measurements exact.
 */
import type { Clock } from "@forerunner/platform";
import { AsyncQueue } from "../queue.ts";
import {
  type AudioChunk,
  type Availability,
  chunkDurationMs,
  type SttEvent,
  type SttProvider,
  type SttSession,
  type SttStartOptions,
  type TtsOptions,
  type TtsProvider,
  type Vad,
  type VadEvent,
} from "../types.ts";

export interface FakeSttScript {
  /** Partials emitted once the pushed audio reaches `atAudioMs`. */
  partials?: Array<{ atAudioMs: number; text: string }>;
  /** The final transcript, emitted `finalDelayMs` after endOfSpeech(). */
  final: string;
  finalDelayMs?: number;
}

export interface FakeSttOptions {
  clock: Clock;
  /** One script per session (turn); the last one repeats. A function receives the turn index. */
  scripts: FakeSttScript[] | ((turn: number) => FakeSttScript);
  /** Default delay between endOfSpeech() and the final transcript. Default 300 ms. */
  finalDelayMs?: number;
  available?: boolean;
  name?: string;
}

export class FakeSttSession implements SttSession {
  readonly queue = new AsyncQueue<SttEvent>();
  readonly events: AsyncIterable<SttEvent> = this.queue;
  audioMs = 0;
  chunks = 0;
  ended = false;
  closed = false;
  private emitted = 0;
  private cancelFinal: (() => void) | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly script: FakeSttScript,
    private readonly defaultFinalDelayMs: number,
    signal?: AbortSignal,
  ) {
    signal?.addEventListener("abort", () => void this.close(), { once: true });
  }

  push(chunk: AudioChunk): void {
    if (this.ended || this.closed) return;
    this.chunks++;
    this.audioMs += chunkDurationMs(chunk);
    const partials = this.script.partials ?? [];
    while (this.emitted < partials.length) {
      const p = partials[this.emitted] as { atAudioMs: number; text: string };
      if (p.atAudioMs > this.audioMs) break;
      this.emitted++;
      this.queue.push({ type: "partial", text: p.text, atMs: this.clock.monotonic() });
    }
  }

  endOfSpeech(): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    const delay = this.script.finalDelayMs ?? this.defaultFinalDelayMs;
    const fire = () => {
      this.cancelFinal = null;
      if (this.closed) return;
      this.queue.push({
        type: "final",
        text: this.script.final,
        atMs: this.clock.monotonic(),
        startMs: 0,
        endMs: this.audioMs,
      });
      this.queue.close();
    };
    if (delay <= 0) fire();
    else this.cancelFinal = this.clock.setTimeout(fire, delay);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelFinal?.();
    this.cancelFinal = null;
    this.queue.close();
  }
}

export class FakeStt implements SttProvider {
  readonly name: string;
  readonly kind = "fake" as const;
  readonly sessions: FakeSttSession[] = [];
  private turn = 0;

  constructor(private readonly opts: FakeSttOptions) {
    this.name = opts.name ?? "fake-stt";
  }

  async isAvailable(): Promise<Availability> {
    return this.opts.available === false
      ? { ok: false, reason: "fake STT marked unavailable" }
      : { ok: true, reason: "fake STT (scripted transcripts)" };
  }

  start(opts: SttStartOptions): FakeSttSession {
    const script = this.scriptFor(this.turn++);
    const s = new FakeSttSession(
      this.opts.clock,
      script,
      this.opts.finalDelayMs ?? 300,
      opts.signal,
    );
    this.sessions.push(s);
    return s;
  }

  private scriptFor(turn: number): FakeSttScript {
    const scripts = this.opts.scripts;
    if (typeof scripts === "function") return scripts(turn);
    if (scripts.length === 0) return { final: "" };
    return scripts[Math.min(turn, scripts.length - 1)] as FakeSttScript;
  }
}

export interface FakeTtsOptions {
  clock: Clock;
  /** Delay before the first chunk of every sentence. Default 200 ms. */
  firstChunkLatencyMs?: number;
  /** Audio duration of each chunk. Default 100 ms. */
  chunkMs?: number;
  /** Chunks per sentence: a number or a function of the text. Default 3. */
  chunks?: number | ((text: string) => number);
  /** Delay between chunks after the first. Default 0 (the rest arrives at once). */
  interChunkMs?: number;
  sampleRate?: number;
  available?: boolean;
  name?: string;
}

export interface FakeTtsCall {
  text: string;
  startedAtMs: number;
  firstChunkAtMs: number | null;
  chunks: number;
  aborted: boolean;
  finished: boolean;
}

export class FakeTts implements TtsProvider {
  readonly name: string;
  readonly kind = "fake" as const;
  readonly calls: FakeTtsCall[] = [];

  constructor(private readonly opts: FakeTtsOptions) {
    this.name = opts.name ?? "fake-tts";
  }

  async isAvailable(): Promise<Availability> {
    return this.opts.available === false
      ? { ok: false, reason: "fake TTS marked unavailable" }
      : { ok: true, reason: "fake TTS (silence)" };
  }

  async *synthesize(text: string, opts: TtsOptions = {}): AsyncIterable<AudioChunk> {
    const clock = this.opts.clock;
    const sampleRate = opts.sampleRate ?? this.opts.sampleRate ?? 16000;
    const chunkMs = this.opts.chunkMs ?? 100;
    const n = Math.max(
      1,
      typeof this.opts.chunks === "function" ? this.opts.chunks(text) : (this.opts.chunks ?? 3),
    );
    const call: FakeTtsCall = {
      text,
      startedAtMs: clock.monotonic(),
      firstChunkAtMs: null,
      chunks: 0,
      aborted: false,
      finished: false,
    };
    this.calls.push(call);
    const signal = opts.signal;
    const samples = Math.round((chunkMs / 1000) * sampleRate);
    try {
      await clock.sleep(this.opts.firstChunkLatencyMs ?? 200, signal);
      for (let i = 0; i < n; i++) {
        if (i > 0 && (this.opts.interChunkMs ?? 0) > 0) {
          await clock.sleep(this.opts.interChunkMs ?? 0, signal);
        }
        if (signal?.aborted) {
          call.aborted = true;
          return;
        }
        if (call.firstChunkAtMs === null) call.firstChunkAtMs = clock.monotonic();
        call.chunks++;
        yield {
          pcm: new Int16Array(samples),
          sampleRate,
          channels: 1,
          timestampMs: i * chunkMs,
        };
      }
      call.finished = true;
    } catch (e) {
      if (signal?.aborted) {
        call.aborted = true;
        return;
      }
      throw e;
    }
  }
}

/** A VAD whose events are scripted per push; handy for app-level tests. */
export class ScriptedVad implements Vad {
  private queue: VadEvent[][] = [];
  speaking = false;

  /** Events returned by the next push() calls, one array per call. */
  enqueue(...perPush: VadEvent[][]): void {
    this.queue.push(...perPush);
  }

  push(_chunk: AudioChunk): VadEvent[] {
    const events = this.queue.shift() ?? [];
    for (const e of events) this.speaking = e.type === "speech_start";
    return events;
  }

  reset(): void {
    this.queue = [];
    this.speaking = false;
  }
}
