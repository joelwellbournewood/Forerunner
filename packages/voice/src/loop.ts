/**
 * The voice loop: push-to-talk or open mic -> streaming STT -> conversation agent (injected
 * from runtime) -> sentence-by-sentence streaming TTS, with barge-in and per-turn latency
 * measurement. Device IO is outside: the shell pushes microphone PCM in and gets playback
 * chunks out through an AudioSink.
 */
import {
  type Clock,
  type ErrorCode,
  errorMessage,
  ForerunnerError,
  type Logger,
  log,
} from "@forerunner/platform";
import { buildLatencyReport, type LatencyReport, type LatencyTargets } from "./latency.ts";
import { AsyncQueue } from "./queue.ts";
import { SentenceSplitter } from "./sentences.ts";
import { AudioStore } from "./store.ts";
import {
  type AudioChunk,
  type AudioSink,
  chunkDurationMs,
  type SttEvent,
  type SttProvider,
  type SttSession,
  type TtsProvider,
  type Vad,
} from "./types.ts";
import { EnergyVad } from "./vad.ts";
import { concatPcm, toMono16 } from "./wav.ts";

export type VoiceMode = "push_to_talk" | "open_mic";
export type VoiceLoopState = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

/** The conversation agent (runtime) as a stream of text deltas; must stop on `signal`. */
export type ConverseFn = (transcript: string, signal: AbortSignal) => AsyncIterable<string>;

export interface TranscriptEntry {
  turn: number;
  role: "user" | "assistant";
  text: string;
  /** ISO-8601 UTC. */
  at: string;
  audioStored: boolean;
  audioFile?: string;
  /**
   * Assistant entries only: playback was cut short (barge-in, stop() or a failed turn), so
   * `text` is only what the person heard and `unspokenText` what was generated but never played.
   */
  interrupted?: boolean;
  unspokenText?: string;
}

export type VoiceLoopEvent =
  | { type: "state"; state: VoiceLoopState; turn: number }
  | { type: "turn_start"; turn: number }
  | { type: "transcript_partial"; turn: number; text: string }
  | { type: "transcript_final"; turn: number; text: string; entry: TranscriptEntry }
  | { type: "model_delta"; turn: number; text: string }
  | { type: "sentence"; turn: number; index: number; text: string }
  | { type: "audio"; turn: number; sentenceIndex: number; chunk: AudioChunk }
  | { type: "speaking_start"; turn: number }
  | { type: "speaking_end"; turn: number }
  | { type: "barge_in"; turn: number; spokenText: string }
  | {
      type: "turn_end";
      turn: number;
      latency: LatencyReport;
      /** null when nothing was heard: empty transcript, or cut short before the first chunk. */
      entry: TranscriptEntry | null;
      /** Text the model generated that was never played (only when the turn was cut short). */
      unspokenText?: string;
    }
  | { type: "error"; turn: number; error: ForerunnerError };

export interface VoiceLoopOptions {
  stt: SttProvider;
  tts: TtsProvider;
  /** Default: EnergyVad with spec defaults (150 ms min speech, 200 ms end of turn). */
  vad?: Vad;
  mode: VoiceMode;
  converse: ConverseFn;
  clock: Clock;
  onEvent?: (e: VoiceLoopEvent) => void;
  /**
   * Playback target; default paces chunks in real time on the clock without a device, each
   * handed over at its place on the play-head (`pacedSink(clock, 0)`). The daemon's bridge
   * passes `pacedSink(clock)`, which runs `PACED_SINK_AHEAD_MS` ahead for the window's player.
   */
  sink?: AudioSink;
  sampleRate?: number;
  language?: string;
  voice?: string;
  speed?: number;
  /** Speech while the agent talks aborts TTS and the model stream. Default true. */
  bargeIn?: boolean;
  /** How many sentences to synthesise ahead of playback. Default 1. */
  prefetchSentences?: number;
  /** Audio kept before a VAD speech_start so the first syllable is not lost. Default 300 ms. */
  preRollMs?: number;
  /** Give up on STT if no final transcript arrives. Default 10 s. */
  sttFinalTimeoutMs?: number;
  /** Off by default: audio is never written to disk unless this is true. */
  storeAudio?: boolean;
  sessionId?: string;
  audioDir?: string;
  env?: NodeJS.ProcessEnv;
  targets?: Partial<LatencyTargets>;
}

interface Capture {
  turn: number;
  session: SttSession;
  abort: AbortController;
  final: Promise<Extract<SttEvent, { type: "final" }>>;
  lastAudioAt: number;
  userPcm: Int16Array[];
}

interface Response {
  turn: number;
  abort: AbortController;
  /** Every sentence the splitter emitted, in order. */
  sentences: string[];
  /** Sentences whose playback started (a prefix of `sentences`, by index). */
  spoken: string[];
  /** Index of the last sentence whose playback started; -1 before the first chunk. */
  lastPlayedIndex: number;
  generated: string;
  /** Why the turn was cut short; null while it runs or when it completed. */
  abortedBy: "barge_in" | "stop" | "failure" | null;
}

/** A pushed chunk: where it ends on the capture timeline and when the loop received it. */
interface PushRecord {
  endMs: number;
  at: number;
}

interface ReadyItem {
  index: number;
  text: string;
  chunks: AsyncQueue<AudioChunk>;
  sentAt: number;
}

const CAPTURE_RATE = 16000;
/** Pushes remembered for the open-mic end-of-turn measurement (10 s of 20 ms chunks). */
const PUSH_LOG_SIZE = 512;

export class VoiceLoop {
  readonly transcript: TranscriptEntry[] = [];
  readonly latencies: LatencyReport[] = [];
  private stateValue: VoiceLoopState = "idle";
  private turn = 0;
  private capture: Capture | null = null;
  /** The capture whose final transcript runTurn() is waiting for; stop() aborts it. */
  private transcribing: Capture | null = null;
  private response: Response | null = null;
  private preRoll: AudioChunk[] = [];
  private preRollMs = 0;
  private pushLog: PushRecord[] = [];
  private inFlight: Promise<void> = Promise.resolve();
  private readonly vad: Vad;
  private readonly sink: AudioSink;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly store: AudioStore | null;
  private stopped = false;

  constructor(private readonly opts: VoiceLoopOptions) {
    this.clock = opts.clock;
    this.logger = log("voice:loop");
    this.vad = opts.vad ?? new EnergyVad();
    this.sink = opts.sink ?? pacedSink(opts.clock, 0);
    this.store = opts.storeAudio
      ? new AudioStore({
          ...(opts.audioDir ? { dir: opts.audioDir } : {}),
          sessionId: opts.sessionId ?? "session",
          ...(opts.env ? { env: opts.env } : {}),
        })
      : null;
  }

  get state(): VoiceLoopState {
    return this.stateValue;
  }

  get currentTurn(): number {
    return this.turn;
  }

  /** Resolves once the turn in flight (if any) has ended. */
  idle(): Promise<void> {
    return this.inFlight;
  }

  start(): void {
    this.stopped = false;
    this.setState("idle");
  }

  /**
   * Abort everything. Stopping is immediate in every state: a capture still listening, a
   * turn waiting for its final transcript (no model call follows), a reply being generated or
   * played.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abortResponse("stop");
    const caps = [this.capture, this.transcribing].filter((c): c is Capture => c !== null);
    this.capture = null;
    for (const cap of caps) {
      cap.abort.abort(new ForerunnerError("killed", "stop"));
      await cap.session.close();
    }
    this.setState("idle");
    await this.inFlight.catch(() => {});
  }

  /** Push-to-talk pressed. While the agent speaks this is a barge-in. */
  pressStart(): void {
    if (this.stopped) return;
    if (this.stateValue === "thinking" || this.stateValue === "speaking") {
      this.bargeIn();
      this.beginCapture([]);
      return;
    }
    if (this.stateValue === "idle") this.beginCapture([]);
  }

  /** Push-to-talk released: the turn ends now. */
  pressEnd(): void {
    const cap = this.capture;
    if (!cap || this.stateValue !== "listening") return;
    this.endTurn(Math.max(0, this.clock.monotonic() - cap.lastAudioAt));
  }

  /** Microphone audio from the shell (any rate/channels; converted for STT and VAD). */
  push(chunk: AudioChunk): void {
    if (this.stopped) return;
    this.notePush(chunk);
    switch (this.stateValue) {
      case "listening": {
        const cap = this.capture;
        if (!cap) return;
        cap.lastAudioAt = this.clock.monotonic();
        cap.session.push(chunk);
        if (this.store) cap.userPcm.push(toMono16(chunk, CAPTURE_RATE));
        if (this.opts.mode === "open_mic") {
          for (const ev of this.vad.push(chunk)) {
            if (ev.type === "speech_end") {
              this.endTurn(this.measureEndOfTurn(ev.atMs, ev.endOfTurnMs));
              break;
            }
          }
        }
        return;
      }
      case "idle": {
        if (this.opts.mode !== "open_mic") return;
        this.keepPreRoll(chunk);
        if (this.vad.push(chunk).some((e) => e.type === "speech_start")) {
          this.beginCapture(this.takePreRoll());
        }
        return;
      }
      case "thinking":
      case "speaking": {
        // Push-to-talk: the press is the barge-in. Mic audio arriving without a press (room
        // noise, speaker echo without AEC) must not open a capture that only a release could end.
        if (this.opts.mode !== "open_mic" || this.opts.bargeIn === false) return;
        this.keepPreRoll(chunk);
        if (this.vad.push(chunk).some((e) => e.type === "speech_start")) {
          this.bargeIn();
          this.beginCapture(this.takePreRoll());
        }
        return;
      }
      default:
        return; // transcribing: the turn has ended, the next one starts after the reply
    }
  }

  /** Remember when each chunk arrived so end of turn can be measured on the clock. */
  private notePush(chunk: AudioChunk): void {
    const last = this.pushLog[this.pushLog.length - 1];
    // A timeline that restarts (new capture stream) invalidates the earlier records.
    if (last && chunk.timestampMs < last.endMs - 1e-6) this.pushLog = [];
    this.pushLog.push({
      endMs: chunk.timestampMs + chunkDurationMs(chunk),
      at: this.clock.monotonic(),
    });
    if (this.pushLog.length > PUSH_LOG_SIZE) {
      this.pushLog.splice(0, this.pushLog.length - PUSH_LOG_SIZE);
    }
  }

  /**
   * Open mic: wall-clock time from the arrival of the chunk holding the last loud frame
   * (`speechEndMs` on the capture timeline) to now, when the VAD reported the end of turn. This
   * includes the configured hangover plus any capture or delivery delay. Falls back to the
   * hangover when the chunk is no longer in the log.
   */
  private measureEndOfTurn(speechEndMs: number, hangoverMs: number): number {
    const rec = this.pushLog.find((r) => r.endMs >= speechEndMs - 1e-6);
    if (!rec) return hangoverMs;
    return Math.max(0, this.clock.monotonic() - rec.at);
  }

  private keepPreRoll(chunk: AudioChunk): void {
    const limit = this.opts.preRollMs ?? 300;
    this.preRoll.push(chunk);
    this.preRollMs += chunkDurationMs(chunk);
    while (this.preRoll.length > 1 && this.preRollMs > limit) {
      const first = this.preRoll.shift() as AudioChunk;
      this.preRollMs -= chunkDurationMs(first);
    }
  }

  private takePreRoll(): AudioChunk[] {
    const out = this.preRoll;
    this.preRoll = [];
    this.preRollMs = 0;
    return out;
  }

  private setState(s: VoiceLoopState): void {
    if (this.stateValue === s) return;
    this.stateValue = s;
    this.emit({ type: "state", state: s, turn: this.turn });
  }

  private emit(e: VoiceLoopEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch (err) {
      this.logger.warn("onEvent threw", { message: errorMessage(err) });
    }
  }

  private beginCapture(preRoll: AudioChunk[]): void {
    const turn = ++this.turn;
    const abort = new AbortController();
    const session = this.opts.stt.start({
      sampleRate: CAPTURE_RATE,
      ...(this.opts.language ? { language: this.opts.language } : {}),
      signal: abort.signal,
    });
    const final = this.pumpStt(turn, session);
    final.catch(() => {}); // observed by endTurn; avoid an unhandled rejection before then
    const cap: Capture = {
      turn,
      session,
      abort,
      final,
      lastAudioAt: this.clock.monotonic(),
      userPcm: [],
    };
    this.capture = cap;
    this.setState("listening");
    this.emit({ type: "turn_start", turn });
    for (const c of preRoll) {
      session.push(c);
      if (this.store) cap.userPcm.push(toMono16(c, CAPTURE_RATE));
    }
  }

  private async pumpStt(
    turn: number,
    session: SttSession,
  ): Promise<Extract<SttEvent, { type: "final" }>> {
    for await (const ev of session.events) {
      if (ev.type === "partial") {
        this.emit({ type: "transcript_partial", turn, text: ev.text });
      } else if (ev.type === "final") {
        return ev;
      } else {
        throw new ForerunnerError(asErrorCode(ev.code), ev.message, { retryable: ev.retryable });
      }
    }
    throw new ForerunnerError("provider_error", "STT session ended without a final transcript");
  }

  private endTurn(endOfTurnMs: number): void {
    const cap = this.capture;
    if (!cap) return;
    this.capture = null;
    this.transcribing = cap;
    this.setState("transcribing");
    this.vad.reset();
    const run = this.runTurn(cap, endOfTurnMs)
      .catch((e: unknown) => {
        const err = asForerunnerError(e, "internal");
        this.logger.error("turn failed", { turn: cap.turn, code: err.code, message: err.message });
        this.emit({ type: "error", turn: cap.turn, error: err });
        if (this.turn === cap.turn && this.stateValue === "transcribing") this.setState("idle");
      })
      .finally(() => {
        if (this.transcribing === cap) this.transcribing = null;
      });
    this.inFlight = run;
  }

  private async runTurn(cap: Capture, endOfTurnMs: number): Promise<void> {
    const tEnd = this.clock.monotonic();
    const stopSignal = cap.abort.signal;
    cap.session.endOfSpeech();

    const timeoutAbort = new AbortController();
    const timeoutMs = this.opts.sttFinalTimeoutMs ?? 10_000;
    // stop() aborts the capture; the wait for the final ends at once, whatever STT does.
    const stopped = new Promise<never>((_, reject) => {
      const fail = () => reject(new ForerunnerError("killed", "stop"));
      if (stopSignal.aborted) fail();
      else stopSignal.addEventListener("abort", fail, { once: true });
    });
    stopped.catch(() => {});
    let final: Extract<SttEvent, { type: "final" }>;
    try {
      final = await Promise.race([
        cap.final,
        stopped,
        this.clock.sleep(timeoutMs, timeoutAbort.signal).then(() => {
          throw new ForerunnerError("timeout", `no final transcript within ${timeoutMs} ms`, {
            retryable: true,
          });
        }),
      ]);
    } catch (e) {
      if (stopSignal.aborted) {
        this.endStopped(cap.turn, endOfTurnMs, null);
        return;
      }
      throw e;
    } finally {
      timeoutAbort.abort();
      await cap.session.close();
    }
    const tFinal = this.clock.monotonic();
    const finalTranscriptMs = tFinal - tEnd;
    if (stopSignal.aborted) {
      // The final arrived in the same tick as stop(): keep nothing, call no model.
      this.endStopped(cap.turn, endOfTurnMs, finalTranscriptMs);
      return;
    }

    const userEntry: TranscriptEntry = {
      turn: cap.turn,
      role: "user",
      text: final.text,
      at: this.clock.nowIso(),
      audioStored: false,
    };
    this.transcript.push(userEntry);
    this.emit({ type: "transcript_final", turn: cap.turn, text: final.text, entry: userEntry });
    // The write runs in the background so disk IO never delays the model call.
    const userWrite =
      this.store && cap.userPcm.length > 0
        ? this.store
            .writeTurn(cap.turn, "user", concatPcm(...cap.userPcm), CAPTURE_RATE)
            .then((file) => {
              userEntry.audioFile = file;
              userEntry.audioStored = true;
            })
        : Promise.resolve();

    if (final.text.trim().length === 0) {
      await userWrite;
      const latency = buildLatencyReport(
        {
          turn: cap.turn,
          endOfTurnMs,
          finalTranscriptMs,
          modelFirstTokenMs: null,
          firstAudioMs: null,
          noResponse: true,
        },
        this.opts.targets,
      );
      this.latencies.push(latency);
      this.emit({ type: "turn_end", turn: cap.turn, latency, entry: null });
      if (this.turn === cap.turn && this.stateValue === "transcribing") this.setState("idle");
      return;
    }

    if (stopSignal.aborted) {
      await userWrite;
      this.endStopped(cap.turn, endOfTurnMs, finalTranscriptMs);
      return;
    }
    try {
      await this.respond(cap.turn, final.text, { tEnd, tFinal, endOfTurnMs, finalTranscriptMs });
    } finally {
      await userWrite;
    }
  }

  /** stop() while waiting for the transcript: end the turn without a model call. */
  private endStopped(turn: number, endOfTurnMs: number, finalTranscriptMs: number | null): void {
    const latency = buildLatencyReport(
      {
        turn,
        endOfTurnMs,
        finalTranscriptMs,
        modelFirstTokenMs: null,
        firstAudioMs: null,
        interrupted: true,
        noResponse: true,
      },
      this.opts.targets,
    );
    this.latencies.push(latency);
    this.emit({ type: "turn_end", turn, latency, entry: null });
    if (this.turn === turn && this.stateValue === "transcribing") this.setState("idle");
  }

  private async respond(
    turn: number,
    transcript: string,
    t: { tEnd: number; tFinal: number; endOfTurnMs: number; finalTranscriptMs: number },
  ): Promise<void> {
    const abort = new AbortController();
    const signal = abort.signal;
    const res: Response = {
      turn,
      abort,
      sentences: [],
      spoken: [],
      lastPlayedIndex: -1,
      generated: "",
      abortedBy: null,
    };
    this.response = res;
    this.setState("thinking");

    const splitter = new SentenceSplitter();
    const sentences = new AsyncQueue<string>();
    const ready = new AsyncQueue<ReadyItem>();
    const prefetch = Math.max(0, this.opts.prefetchSentences ?? 1);
    const assistantPcm: Int16Array[] = [];
    let assistantRate = CAPTURE_RATE;
    let tFirstToken: number | null = null;
    let tFirstSentence: number | null = null;
    let tFirstAudio: number | null = null;
    let ttsFirstByteMs: number | null = null;
    let sentenceCount = 0;
    let playStarted = -1;
    let waiters: Array<{ index: number; resolve: () => void }> = [];

    const waitPlayStarted = (index: number): Promise<void> => {
      if (index < 0 || playStarted >= index || signal.aborted) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ index, resolve }));
    };
    const markPlayStarted = (index: number) => {
      playStarted = Math.max(playStarted, index);
      const still: typeof waiters = [];
      for (const w of waiters) {
        if (playStarted >= w.index) w.resolve();
        else still.push(w);
      }
      waiters = still;
    };
    const onAbort = () => {
      sentences.close();
      ready.close();
      for (const w of waiters) w.resolve();
      waiters = [];
      this.sink.stop();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const emitSentence = (text: string) => {
      const index = sentenceCount++;
      if (tFirstSentence === null) tFirstSentence = this.clock.monotonic();
      res.sentences.push(text);
      this.emit({ type: "sentence", turn, index, text });
      sentences.push(text);
    };

    const modelLoop = (async () => {
      try {
        for await (const delta of this.opts.converse(transcript, signal)) {
          if (signal.aborted) break;
          if (tFirstToken === null) tFirstToken = this.clock.monotonic();
          res.generated += delta;
          this.emit({ type: "model_delta", turn, text: delta });
          for (const s of splitter.push(delta)) emitSentence(s);
        }
        if (!signal.aborted) {
          const last = splitter.flush();
          if (last) emitSentence(last);
        }
      } finally {
        sentences.close();
      }
    })();

    const synthWorker = (async () => {
      let index = 0;
      try {
        for await (const text of sentences) {
          if (signal.aborted) break;
          await waitPlayStarted(index - prefetch);
          if (signal.aborted) break;
          const item: ReadyItem = {
            index,
            text,
            chunks: new AsyncQueue<AudioChunk>(),
            sentAt: this.clock.monotonic(),
          };
          ready.push(item);
          try {
            const ttsOpts = {
              ...(this.opts.voice ? { voice: this.opts.voice } : {}),
              ...(this.opts.speed !== undefined ? { speed: this.opts.speed } : {}),
              ...(this.opts.language ? { language: this.opts.language } : {}),
              signal,
            };
            for await (const c of this.opts.tts.synthesize(text, ttsOpts)) {
              if (signal.aborted) break;
              item.chunks.push(c);
            }
          } catch (e) {
            if (!signal.aborted) item.chunks.fail(e);
          } finally {
            item.chunks.close();
          }
          index++;
        }
      } finally {
        ready.close();
      }
    })();

    const playWorker = (async () => {
      for await (const item of ready) {
        if (signal.aborted) break;
        markPlayStarted(item.index);
        let started = false;
        try {
          for await (const c of item.chunks) {
            if (signal.aborted) break;
            if (!started) {
              started = true;
              res.spoken.push(item.text);
              res.lastPlayedIndex = item.index;
            }
            if (tFirstAudio === null) {
              tFirstAudio = this.clock.monotonic();
              ttsFirstByteMs = tFirstAudio - item.sentAt;
              // Only the current turn owns the state (a barge-in aborts this signal first).
              if (this.turn === turn && this.response === res) this.setState("speaking");
              this.emit({ type: "speaking_start", turn });
            }
            this.emit({ type: "audio", turn, sentenceIndex: item.index, chunk: c });
            if (this.store) {
              assistantRate = c.sampleRate;
              assistantPcm.push(toMono16(c, c.sampleRate));
            }
            try {
              await this.sink.play(c, signal);
            } catch {
              if (signal.aborted) break;
            }
          }
        } catch (e) {
          if (!signal.aborted) throw e;
        }
      }
    })();

    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });

    let failure: unknown = null;
    const onWorkerFailure = (e: unknown) => {
      // Errors while winding down after a barge-in or stop() are noise, not a second failure.
      if (res.abortedBy !== null) return;
      failure = e;
      res.abortedBy = "failure";
      abort.abort(e);
    };
    try {
      // One worker failing aborts the whole turn (model stream, pending TTS calls, playback);
      // the turn only ends once every worker has finished, so nothing runs on after turn_end.
      // A converse() that ignores its signal must not keep the loop hostage: it is raced
      // against the abort.
      await Promise.all(
        [Promise.race([modelLoop, aborted]), synthWorker, playWorker].map((w) =>
          w.catch(onWorkerFailure),
        ),
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.response === res) this.response = null;
    }
    modelLoop.catch(() => {});

    if (failure !== null) {
      const err = asForerunnerError(failure, "provider_error");
      this.logger.error("turn failed", { turn, code: err.code, message: err.message });
      this.emit({ type: "error", turn, error: err });
    }

    const cutShort = res.abortedBy !== null;
    const byHuman = res.abortedBy === "barge_in" || res.abortedBy === "stop";
    const spokenText = res.spoken.join(" ");
    // From the sentence list, not character offsets: the model may separate sentences with
    // newlines or double spaces, which the spoken text (joined with single spaces) does not keep.
    const unspokenParts = cutShort ? res.sentences.slice(res.lastPlayedIndex + 1) : [];
    const rest = cutShort ? splitter.pending.trim() : "";
    if (rest) unspokenParts.push(rest);
    const unspokenText = unspokenParts.join(" ");
    // No assistant line when nothing was heard: session history must not get an empty entry.
    const heard = cutShort ? spokenText.length > 0 : res.generated.trim().length > 0;
    let entry: TranscriptEntry | null = null;
    if (heard) {
      entry = {
        turn,
        role: "assistant",
        text: cutShort ? spokenText : res.generated,
        at: this.clock.nowIso(),
        audioStored: false,
        ...(cutShort ? { interrupted: true, unspokenText } : {}),
      };
      this.insertTranscript(entry);
      if (this.store && assistantPcm.length > 0) {
        entry.audioFile = await this.store.writeTurn(
          turn,
          "assistant",
          concatPcm(...assistantPcm),
          assistantRate,
        );
        entry.audioStored = true;
      }
    }

    const latency = buildLatencyReport(
      {
        turn,
        endOfTurnMs: t.endOfTurnMs,
        finalTranscriptMs: t.finalTranscriptMs,
        modelFirstTokenMs: tFirstToken === null ? null : tFirstToken - t.tFinal,
        firstAudioMs:
          tFirstAudio === null || tFirstToken === null ? null : tFirstAudio - tFirstToken,
        firstSentenceMs:
          tFirstSentence === null || tFirstToken === null ? null : tFirstSentence - tFirstToken,
        ttsFirstByteMs,
        interrupted: byHuman,
        noResponse: res.generated.length === 0,
      },
      this.opts.targets,
    );
    this.latencies.push(latency);
    if (tFirstAudio !== null) this.emit({ type: "speaking_end", turn });
    this.emit({
      type: "turn_end",
      turn,
      latency,
      entry,
      ...(unspokenText.length > 0 ? { unspokenText } : {}),
    });
    // Every worker has finished, so no late chunk can flip the state after this. A turn that
    // was barged in on may end after the next turn started: its tail must not touch that state.
    if (this.turn !== turn) return;
    if (this.stateValue === "thinking" || this.stateValue === "speaking") this.setState("idle");
  }

  /**
   * Keep the transcript in turn order. A turn that was barged in on ends only once its TTS has
   * honoured the abort, which can be after the next turn's user line was written; its assistant
   * line still belongs right after its own user line.
   */
  private insertTranscript(entry: TranscriptEntry): void {
    let at = this.transcript.length;
    for (;;) {
      const prev = this.transcript[at - 1];
      if (!prev || prev.turn <= entry.turn) break;
      at--;
    }
    this.transcript.splice(at, 0, entry);
  }

  private bargeIn(): void {
    const res = this.response;
    // A turn already winding down (failed, stopped) is not interrupted a second time.
    if (!res || res.abort.signal.aborted) return;
    this.emit({ type: "barge_in", turn: res.turn, spokenText: res.spoken.join(" ") });
    this.abortResponse("barge_in");
  }

  private abortResponse(reason: "barge_in" | "stop"): void {
    const res = this.response;
    if (!res) return;
    if (res.abortedBy === null) res.abortedBy = reason;
    res.abort.abort(new ForerunnerError("killed", reason));
  }
}

/** How far `pacedSink` hands chunks over ahead of their place on its play-head, in ms. */
export const PACED_SINK_AHEAD_MS = 300;

/**
 * Default sink: pretends to play on the clock, with no device (the app window plays the `audio`
 * frames). It keeps a play-head (where the chunks handed over so far end) and resolves once the
 * play-head is at most `aheadMs` beyond now, like a device with that much buffer. Pacing
 * against the play-head rather than sleeping each chunk's duration from the moment the last
 * sleep woke keeps it at real time when its timer wakes late (a loaded event loop, Windows
 * timers): per-chunk sleeps fell behind a few ms per chunk, so the frames reached the player
 * slower than real time and its queue ran dry inside words. A chunk that came after the
 * play-head had passed (generation slower than real time) restarts it from now. `stop()`
 * (a barge-in) flushes it.
 */
export function pacedSink(clock: Clock, aheadMs = PACED_SINK_AHEAD_MS): AudioSink {
  let until: number | null = null;
  return {
    play: async (chunk, signal) => {
      const now = clock.monotonic();
      const start = until !== null && until > now ? until : now;
      until = start + chunkDurationMs(chunk);
      const wait = until - aheadMs - now;
      if (wait > 0) await clock.sleep(wait, signal).catch(() => {});
    },
    stop: () => {
      until = null;
    },
  };
}

/** A sink that hands chunks over instantly and records them (tests, transcription-only). */
export function collectingSink(): AudioSink & { chunks: AudioChunk[] } {
  const chunks: AudioChunk[] = [];
  return {
    chunks,
    play: async (chunk) => {
      chunks.push(chunk);
    },
    stop: () => {},
  };
}

const ERROR_CODES = new Set<string>([
  "budget_exceeded",
  "step_cap_exceeded",
  "depth_exceeded",
  "timeout",
  "tool_not_allowed",
  "path_not_allowed",
  "domain_not_allowed",
  "secret_not_granted",
  "autonomy_insufficient",
  "approval_required",
  "claim_conflict",
  "version_conflict",
  "not_found",
  "validation",
  "brief_incomplete",
  "findings_open",
  "killed",
  "provider_error",
  "provider_auth",
  "provider_rate_limit",
  "not_supported",
  "unavailable",
  "injection_suspected",
  "internal",
]);

function asErrorCode(code: string): ErrorCode {
  return (ERROR_CODES.has(code) ? code : "provider_error") as ErrorCode;
}

function asForerunnerError(e: unknown, code: ErrorCode): ForerunnerError {
  return e instanceof ForerunnerError
    ? e
    : new ForerunnerError(code, errorMessage(e), { cause: e });
}
