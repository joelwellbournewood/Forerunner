/**
 * Reading a text aloud outside a voice turn (spec A.6 "readable aloud", L.6 "TTS for summaries
 * and alerts"; ADR 0063): the project summary, a session summary, an urgent notification. One
 * `Utterance` is one text synthesised sentence by sentence (`splitSentences`) through the TTS
 * provider the registry's policy picked, with no model call and no STT, so it works without a
 * model credential. Playback takes the voice loop's path: `audio` events carry the PCM frames
 * the daemon streams to the player (`GET /speak/:id/events`, the same frame as a voice turn's;
 * the app window plays them, the sink here only paces them on the clock), held until the
 * player's stream attached or a short grace passed. One voice at a time: a new utterance
 * cancels the one in flight, starts are serialised; a cancel is immediate. What is recorded: one `voice.speak` row on the human's
 * conversation session (the text as heard, never audio) and one `voice.speak` audit row
 * (counts and the provider, never the text).
 */
import { EventEmitter } from "node:events";
import type { CommandSource } from "@forerunner/commands";
import { type Clock, errorMessage, ForerunnerError, log, newId } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import {
  AsyncQueue,
  type AudioChunk,
  type AudioSink,
  pacedSink,
  splitSentences,
  type TtsProvider,
  type VoiceProviderRegistry,
} from "./pkg.ts";
import type { VoicePreferences } from "./providers.ts";
import { pickTts, type VoiceProviderPick } from "./sessions.ts";

export type SpeakSubject =
  | { kind: "project"; id: string; name: string }
  | { kind: "session"; id: string; projectId: string | null }
  | { kind: "notification"; id: string; notificationKind: string };

/** Who asked: a command's source, or the notifier. */
export type SpeakSource = CommandSource | "notification";

/**
 * Who plays the frames (ADR 0063): `requester` when the caller follows the utterance it asked
 * for itself (the UI's Read aloud button), `any` when every attached speech player should
 * (an alert, `summary.speak` by chat). Carried on the `speak.started` frame.
 */
export type SpeakPlayer = "requester" | "any";

export interface SpeakRequest {
  text: string;
  subject: SpeakSubject;
  source: SpeakSource;
  /** BCP-47 for the provider. */
  language?: string;
  /** Who plays it; default `any`. */
  player?: SpeakPlayer;
}

export type SpeakState = "speaking" | "done" | "cancelled" | "failed";

export interface SpeakRecord {
  id: string;
  subject: SpeakSubject;
  source: SpeakSource;
  state: SpeakState;
  text: string;
  sentences: number;
  /** The sentences whose playback started, joined (what the person heard). */
  heard: string;
  /** The rest, when the utterance was cut short. */
  unspokenText: string | null;
  audioChunks: number;
  audioStored: false;
  /** From the request to the first audio chunk, on the clock. */
  firstAudioMs: number | null;
  provider: string;
  startedAt: string;
  endedAt: string | null;
  error: { code: string; message: string } | null;
}

export type SpeakEvent =
  | { type: "sentence"; index: number; text: string }
  | { type: "audio"; sentenceIndex: number; chunk: AudioChunk }
  | { type: "speaking_start"; firstAudioMs: number }
  | { type: "speaking_end" }
  | { type: "error"; error: { code: string; message: string } }
  | { type: "speak.done"; record: SpeakRecord };

/** One event as the daemon streams it: numbered so a stream can resume. */
export interface SpeakEntry {
  seq: number;
  at: string;
  event: SpeakEvent;
}

export interface UtteranceOptions {
  id: string;
  request: SpeakRequest;
  tts: TtsProvider;
  provider: VoiceProviderPick;
  sink: AudioSink;
  clock: Clock;
  conversationSessionId: string;
  /** Runs before the utterance resolves; what it writes is the row (the manager's). */
  persist?: (record: SpeakRecord) => Promise<void>;
  /** Events kept for `eventsAfter`; audio events are never kept. */
  bufferSize?: number;
  /**
   * Playback waits for the first stream subscriber up to this long (on the clock), so the
   * player that attaches after the `POST` or the `speak.started` frame hears the first words
   * (audio frames are live only). 0 plays at once. Synthesis runs meanwhile.
   */
  awaitListenerMs?: number;
}

interface ReadyItem {
  index: number;
  text: string;
  chunks: AsyncQueue<AudioChunk>;
}

const DEFAULT_BUFFER = 1000;
export const VOICE_SPEAK_AUDIT_TOOL = "voice.speak";
export const VOICE_SPEAK_EVENT = "voice.speak";

export class Utterance {
  readonly id: string;
  readonly subject: SpeakSubject;
  readonly source: SpeakSource;
  readonly player: SpeakPlayer;
  readonly text: string;
  readonly sentences: string[];
  readonly provider: VoiceProviderPick;
  readonly startedAt: string;
  readonly conversationSessionId: string;
  /** Resolves with the record once playback ended and the row is written. */
  readonly done: Promise<SpeakRecord>;
  state: SpeakState = "speaking";
  endedAt: string | null = null;
  audioChunks = 0;
  firstAudioMs: number | null = null;
  error: { code: string; message: string } | null = null;
  private readonly spoken: string[] = [];
  private cancelled = false;
  private readonly abort = new AbortController();
  private readonly emitter = new EventEmitter();
  private readonly buffer: SpeakEntry[] = [];
  private seq = 0;
  private listened = false;
  private listenerArrived: (() => void) | null = null;
  private readonly t0: number;
  private readonly logger = log("voice:speak");

  constructor(private readonly opts: UtteranceOptions) {
    this.id = opts.id;
    this.subject = opts.request.subject;
    this.source = opts.request.source;
    this.player = opts.request.player ?? "any";
    this.text = opts.request.text;
    this.sentences = splitSentences(opts.request.text);
    this.provider = opts.provider;
    this.startedAt = opts.clock.nowIso();
    this.conversationSessionId = opts.conversationSessionId;
    this.t0 = opts.clock.monotonic();
    this.done = this.run();
  }

  get ended(): boolean {
    return this.endedAt !== null;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Stop at once in every state; input is never needed, so nothing is refused afterwards. */
  cancel(): void {
    if (this.state !== "speaking") return;
    this.cancelled = true;
    this.abort.abort(new ForerunnerError("killed", "cancelled"));
  }

  subscribe(listener: (entry: SpeakEntry) => void): () => void {
    this.emitter.on("event", listener);
    if (!this.listened) {
      this.listened = true;
      this.listenerArrived?.();
    }
    return () => this.emitter.off("event", listener);
  }

  /** Whether a stream subscribed; playback holds until one did or the grace passed. */
  get hasListener(): boolean {
    return this.listened;
  }

  /** Resolves once a subscriber attached, the grace period passed or the utterance aborted. */
  private untilListener(signal: AbortSignal): Promise<void> {
    const graceMs = this.opts.awaitListenerMs ?? 0;
    if (this.listened || graceMs <= 0 || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const ac = new AbortController();
      const finish = () => {
        this.listenerArrived = null;
        signal.removeEventListener("abort", finish);
        ac.abort();
        resolve();
      };
      this.listenerArrived = finish;
      signal.addEventListener("abort", finish, { once: true });
      this.opts.clock.sleep(graceMs, ac.signal).then(finish, finish);
    });
  }

  /** Buffered events after `seq` (audio chunks are never replayed). */
  eventsAfter(seq: number): SpeakEntry[] {
    return this.buffer.filter((e) => e.seq > seq);
  }

  record(): SpeakRecord {
    const cutShort = this.state === "cancelled" || this.state === "failed";
    const unspoken = cutShort ? this.sentences.slice(this.spoken.length).join(" ") : "";
    return {
      id: this.id,
      subject: this.subject,
      source: this.source,
      state: this.state,
      text: this.text,
      sentences: this.sentences.length,
      heard: this.spoken.join(" "),
      unspokenText: unspoken.length > 0 ? unspoken : null,
      audioChunks: this.audioChunks,
      audioStored: false,
      firstAudioMs: this.firstAudioMs,
      provider: this.provider.name,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      error: this.error,
    };
  }

  private emit(event: SpeakEvent): void {
    const entry: SpeakEntry = { seq: ++this.seq, at: this.opts.clock.nowIso(), event };
    if (event.type !== "audio") {
      this.buffer.push(entry);
      const limit = this.opts.bufferSize ?? DEFAULT_BUFFER;
      if (this.buffer.length > limit) this.buffer.splice(0, this.buffer.length - limit);
    }
    try {
      this.emitter.emit("event", entry);
    } catch (e) {
      this.logger.warn("speak event listener threw", { error: errorMessage(e) });
    }
  }

  /**
   * The pipeline of the voice loop's reply, without the model: every sentence is announced up
   * front (the shell shows the text), then synthesised one ahead of playback and played in
   * order. One failing stage ends the utterance; a cancel aborts the provider call in flight
   * and flushes the sink.
   */
  private async run(): Promise<SpeakRecord> {
    const { tts, sink, clock } = this.opts;
    const signal = this.abort.signal;
    for (const [index, text] of this.sentences.entries())
      this.emit({ type: "sentence", index, text });
    const ready = new AsyncQueue<ReadyItem>();
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
      ready.close();
      for (const w of waiters) w.resolve();
      waiters = [];
      sink.stop();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const language = this.opts.request.language;

    const synth = (async () => {
      try {
        for (const [index, text] of this.sentences.entries()) {
          if (signal.aborted) break;
          await waitPlayStarted(index - 1);
          if (signal.aborted) break;
          const item: ReadyItem = { index, text, chunks: new AsyncQueue<AudioChunk>() };
          ready.push(item);
          try {
            for await (const c of tts.synthesize(text, {
              signal,
              ...(language ? { language } : {}),
            })) {
              if (signal.aborted) break;
              item.chunks.push(c);
            }
          } catch (e) {
            if (!signal.aborted) item.chunks.fail(e);
          } finally {
            item.chunks.close();
          }
        }
      } finally {
        ready.close();
      }
    })();

    const play = (async () => {
      let held = false;
      for await (const item of ready) {
        if (!held) {
          held = true;
          await this.untilListener(signal);
        }
        if (signal.aborted) break;
        markPlayStarted(item.index);
        let started = false;
        for await (const c of item.chunks) {
          if (signal.aborted) break;
          if (!started) {
            started = true;
            this.spoken.push(item.text);
          }
          if (this.firstAudioMs === null) {
            this.firstAudioMs = clock.monotonic() - this.t0;
            this.emit({ type: "speaking_start", firstAudioMs: this.firstAudioMs });
          }
          this.audioChunks++;
          this.emit({ type: "audio", sentenceIndex: item.index, chunk: c });
          try {
            await sink.play(c, signal);
          } catch {
            if (signal.aborted) break;
          }
        }
      }
      // The paced sink runs ahead of real time: `speaking_end` and `speak.done` wait for its
      // play-head, or the window's player (which closes its output on `speak.done`) cuts the
      // tail.
      if (!signal.aborted) await sink.drain?.(signal).catch(() => {});
    })();

    let failure: unknown = null;
    const onFailure = (e: unknown) => {
      if (signal.aborted) return;
      failure = e;
      this.abort.abort(e);
    };
    await Promise.all([synth.catch(onFailure), play.catch(onFailure)]);
    signal.removeEventListener("abort", onAbort);

    if (failure !== null) {
      const err =
        failure instanceof ForerunnerError
          ? failure
          : new ForerunnerError("provider_error", errorMessage(failure), { cause: failure });
      this.error = { code: err.code, message: err.message };
      this.state = "failed";
      this.logger.error("speak failed", { id: this.id, code: err.code, message: err.message });
      this.emit({ type: "error", error: this.error });
    } else {
      this.state = this.cancelled ? "cancelled" : "done";
    }
    this.endedAt = clock.nowIso();
    if (this.firstAudioMs !== null) this.emit({ type: "speaking_end" });
    const record = this.record();
    try {
      await this.opts.persist?.(record);
    } catch (e) {
      this.logger.warn("could not write the voice.speak row", {
        id: this.id,
        error: errorMessage(e),
      });
    }
    this.emit({ type: "speak.done", record });
    return record;
  }
}

export interface SpeakSessionsDeps {
  registry: VoiceProviderRegistry;
  /**
   * The preferred providers, read at every utterance (as the voice sessions read theirs), so a
   * changed preference applies to the next read-aloud without a restart. Default: none, the
   * registry's policy decides.
   */
  preferences?: () => Promise<VoicePreferences> | VoicePreferences;
  hasSecret?: (ref: string) => Promise<boolean>;
  store: StateStore;
  clock: Clock;
  humanId: string;
  agentId: string;
  /** The session whose event log gets the `voice.speak` row (the human's conversation session). */
  sessionIdFor: () => Promise<string>;
  /** Playback sink per utterance; default: paced on the clock (the shell plays the frames). */
  sink?: (clock: Clock) => AudioSink;
  /** Told of every utterance as it starts (the daemon announces it on its bus). */
  onStart?: (utterance: Utterance) => void;
  /** Finished utterances kept for a late `GET` or stream: at most `keepDone`, none older than `retainDoneMs`. */
  keepDone?: number;
  retainDoneMs?: number;
  /** How long playback waits for its player's stream (`UtteranceOptions.awaitListenerMs`). */
  awaitListenerMs?: number;
}

export const DEFAULT_KEEP_DONE = 8;
export const DEFAULT_RETAIN_DONE_MS = 10 * 60_000;
/** A player attaches within a round trip; past this the frames go to the paced sink alone. */
export const DEFAULT_AWAIT_LISTENER_MS = 1500;

/** The daemon's speaker: picks the TTS provider per utterance and keeps one voice at a time. */
export class SpeakSessions {
  private readonly all = new Map<string, Utterance>();
  private speaking: Utterance | null = null;
  /** Starts run one after the other, so the newest request always cancels the one before. */
  private starting: Promise<unknown> = Promise.resolve();
  private readonly logger = log("voice:speak");

  constructor(private readonly deps: SpeakSessionsDeps) {}

  /** The utterance in flight, if any. */
  get current(): Utterance | null {
    return this.speaking && this.speaking.state === "speaking" ? this.speaking : null;
  }

  /**
   * Start reading `text` aloud; refused with `unavailable` and the reason when no TTS can run.
   * One voice (spec L.6): starts are serialised, so of two overlapping requests the later one
   * cancels the earlier, whatever the provider pick and the session lookup cost.
   */
  say(req: SpeakRequest): Promise<Utterance> {
    const started = this.starting.then(() => this.start(req));
    this.starting = started.catch(() => undefined);
    return started;
  }

  private async start(req: SpeakRequest): Promise<Utterance> {
    this.sweep();
    const text = req.text.trim();
    if (!text) throw new ForerunnerError("validation", "nothing to read aloud");
    const preferred = this.deps.preferences ? await this.deps.preferences() : undefined;
    const picked = await pickTts(this.deps.registry, preferred, this.deps.hasSecret);
    // One voice (spec L.6): nothing talks over itself.
    this.current?.cancel();
    const conversationSessionId = await this.deps.sessionIdFor();
    const utterance = new Utterance({
      id: newId(this.deps.clock.now()),
      request: { ...req, text },
      tts: picked.provider,
      provider: picked.pick,
      sink: this.deps.sink ? this.deps.sink(this.deps.clock) : pacedSink(this.deps.clock),
      clock: this.deps.clock,
      conversationSessionId,
      persist: (record) => this.persist(record),
      awaitListenerMs: this.deps.awaitListenerMs ?? DEFAULT_AWAIT_LISTENER_MS,
    });
    this.all.set(utterance.id, utterance);
    this.speaking = utterance;
    utterance.done.catch(() => undefined);
    try {
      this.deps.onStart?.(utterance);
    } catch (e) {
      this.logger.warn("speak onStart threw", { error: errorMessage(e) });
    }
    return utterance;
  }

  get(id: string): Utterance | undefined {
    this.sweep();
    return this.all.get(id);
  }

  mustGet(id: string): Utterance {
    const u = this.get(id);
    if (!u) throw new ForerunnerError("not_found", `no utterance ${id}`);
    return u;
  }

  /** Cancel at once; resolves once the utterance has ended and its row is written. */
  async cancel(id: string): Promise<Utterance> {
    const u = this.mustGet(id);
    u.cancel();
    await u.done.catch(() => undefined);
    return u;
  }

  /** Cancel what is speaking and wait for its row. */
  async close(): Promise<void> {
    const u = this.current;
    if (!u) return;
    u.cancel();
    await u.done.catch(() => undefined);
  }

  /** The `voice.speak` row on the conversation session and the audit row; never the audio. */
  private async persist(record: SpeakRecord): Promise<void> {
    const { store, clock, humanId, agentId } = this.deps;
    await store.event.append(
      this.all.get(record.id)?.conversationSessionId ?? (await this.deps.sessionIdFor()),
      VOICE_SPEAK_EVENT,
      {
        id: record.id,
        subject: record.subject,
        source: record.source,
        state: record.state,
        heard: record.heard,
        unspokenText: record.unspokenText,
        sentences: record.sentences,
        chars: record.text.length,
        audioChunks: record.audioChunks,
        audioStored: false,
        interrupted: record.state === "cancelled",
        firstAudioMs: record.firstAudioMs,
        provider: record.provider,
        error: record.error,
      } as never,
      0,
      { authorHuman: humanId },
    );
    try {
      await store.auditLog.append({
        tool: VOICE_SPEAK_AUDIT_TOOL,
        allowed: record.state !== "failed",
        denied_reason: record.error ? record.error.message.slice(0, 300) : null,
        session_id: this.all.get(record.id)?.conversationSessionId ?? null,
        agent_id: agentId,
        human_id: humanId,
        input_summary: JSON.stringify({
          id: record.id,
          subject: record.subject,
          source: record.source,
          sentences: record.sentences,
          chars: record.text.length,
          provider: record.provider,
        }),
        result_summary: `${record.state}: ${record.audioChunks} chunk(s)${
          record.firstAudioMs === null ? "" : `, first audio after ${record.firstAudioMs} ms`
        }`,
        cost_usd_micro: 0,
        occurred_at: clock.nowIso(),
        author_human: humanId,
      });
    } catch (e) {
      this.logger.warn("could not write the voice.speak audit row", { error: errorMessage(e) });
    }
  }

  /** Drop finished utterances beyond the kept count or older than the window; no timer runs. */
  private sweep(): void {
    const now = this.deps.clock.now();
    const keep = this.deps.keepDone ?? DEFAULT_KEEP_DONE;
    const retain = this.deps.retainDoneMs ?? DEFAULT_RETAIN_DONE_MS;
    const finished = [...this.all.values()]
      .filter((u) => u.endedAt !== null)
      .sort((a, b) => Date.parse(a.endedAt ?? "") - Date.parse(b.endedAt ?? ""));
    for (const [i, u] of finished.entries()) {
      const beyondCap = finished.length - i > keep;
      const stale = now - Date.parse(u.endedAt ?? "") > retain;
      if (beyondCap || stale) this.all.delete(u.id);
    }
  }
}
