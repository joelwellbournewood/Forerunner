/**
 * The voice bridge (spec O, Q; ADR 0012, ADR 0048): the real `VoiceLoop` of `@forerunner/voice`
 * wired to the runtime's `ConversationAgent` through the loop's `converse` port, with the
 * spoken approval rules in front of a pending change card. It is what the daemon's voice
 * routes drive and what the shells reach: microphone PCM goes in through `push`, the
 * push-to-talk press through `press`, a typed line through `text` (the text fallback), the
 * loop's events come out through `subscribe` (the daemon streams them over SSE), and playback
 * chunks go to the `AudioSink` (paced on the clock by default; the shell plays what the `audio`
 * events carry).
 *
 * Every state change still goes through the command registry: the conversation agent parses
 * the line, composes the change card and files it; this bridge only decides whether a spoken
 * line is the "yes" the card waits for (`expectYes`, spec O.7) or a "no", and hands that
 * answer to the registry itself (`confirm` as a yes with `source: "voice"`, `cancel`), exactly
 * as a tap from the shell does. The registry is the one source of truth for what waits: the
 * bridge's copy of the card follows the registry's pending list (a card answered in the UI,
 * by email or expired is gone here too; a yes to it is refused by the registry with the
 * reason), never the conversation agent's per-human copy, which a typed line drops. A line the
 * rules refuse (a question, a qualifier, a deferral, a hesitation) never confirms anything:
 * the card is read back again. Every approval decision carries the exact line and the
 * registry's outcome, and every turn's transcript and latency report are appended to the
 * conversation session's event log (`voice.approval`, `voice.turn`, plus the `chat.*` rows
 * the agent would have written for a line the bridge answered itself); the session's start,
 * stop and approval decisions are `audit_log` rows; audio is never stored unless `storeAudio`
 * is on, and never logged.
 */
import { EventEmitter } from "node:events";
import type { Actor, ConfirmationAnswer } from "@forerunner/commands";
import { type Clock, errorMessage, ForerunnerError, join, log, newId } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import type { ChatReply, ConversationAgent, PendingConfirmation } from "../conversation/agent.ts";
import type { CommandResultView } from "../loop/ports.ts";
import {
  AsyncQueue,
  type AudioChunk,
  type AudioSink,
  buildLatencyReport,
  type ConverseFn,
  DEFAULT_LATENCY_TARGETS,
  type LatencyReport,
  type LatencyTargets,
  pacedSink,
  type SpokenApprovalRecord,
  type SttProvider,
  spokenApprovalRecord,
  type TranscriptEntry,
  type TtsProvider,
  VoiceLoop,
  type VoiceLoopEvent,
  type VoiceLoopState,
  type VoiceMode,
} from "./pkg.ts";
import { TextTurnStt } from "./text-turn.ts";

/** What the bridge needs of the command registry: the cards that wait, a yes or a tap, a no. */
export interface VoiceBridgeCommands {
  confirm(pendingId: string, answer: ConfirmationAnswer): Promise<CommandResultView>;
  cancel(pendingId: string, by: Actor): Promise<CommandResultView>;
  /** The registry's pending cards of the human: the one source of truth for what still waits. */
  pending(humanId?: string): ReadonlyArray<{ id: string }>;
}

export interface VoiceBridgeOptions {
  /** The voice session id the daemon hands out; default a fresh id. */
  id?: string;
  agent: ConversationAgent;
  commands: VoiceBridgeCommands;
  store: StateStore;
  clock: Clock;
  humanId: string;
  agentId: string;
  /** The project the conversation starts on (the registry's active project wins once recorded). */
  projectId?: string;
  /** BCP-47 language for the spoken approval rules and the providers. */
  language?: string;
  /** Default push-to-talk; open mic runs the loop's VAD on the pushed audio. */
  mode?: VoiceMode;
  stt: SttProvider;
  tts: TtsProvider;
  /** Playback target; default `pacedSink(clock)` (the shell plays the `audio` events). */
  sink?: AudioSink;
  /** Off by default: audio is never written unless this is true (spec O.10). */
  storeAudio?: boolean;
  /** Base directory for stored audio; this session's WAVs go under `<audioDir>/<id>`. */
  audioDir?: string;
  env?: NodeJS.ProcessEnv;
  targets?: Partial<LatencyTargets>;
  /** Events kept for `eventsAfter` (a reconnecting stream); audio events are never kept. */
  bufferSize?: number;
  /** Provider names for the audit row. */
  providers?: { stt: string; tts: string };
}

export type VoiceTurnSource = "audio" | "text";
export type VoiceAnswerMethod = "spoken" | "tap" | "no";

/** A spoken (or tapped) approval decision with the card it answered and what the registry did. */
export interface VoiceApproval extends SpokenApprovalRecord {
  method: VoiceAnswerMethod;
  pendingId: string;
  commands: string[];
  /**
   * The registry's outcome: `pending` when the line was not an answer and the card still
   * waits; else what the registry did with the answer (`done`, `partial`, `cancelled`, or
   * `refused` with the `reason`: a card answered elsewhere or expired, a high-risk card that
   * needs the paired device).
   */
  status: CommandResultView["status"];
  reason: string | null;
}

export interface VoiceTurn {
  turn: number;
  source: VoiceTurnSource;
  /** What the human said (the final transcript). */
  said: string;
  /** What the human heard: the assistant transcript line (what was played). */
  heard: string;
  /**
   * The conversation agent's reply; null when the bridge answered the line itself: a spoken
   * answer to a card (refused and read back again, or confirmed or cancelled by the registry).
   */
  reply: ChatReply | null;
  /** The approval decision of this turn, when a card was pending. */
  approval: VoiceApproval | null;
  /** The registry's result when this turn answered a card (sentence, change log id, undo). */
  outcome: CommandResultView | null;
  /** The change card waiting after this turn (read back, needs a yes or a tap). */
  pending: PendingConfirmation | null;
  latency: LatencyReport;
  /** Audio chunks played for this turn. */
  audioChunks: number;
  audioStored: boolean;
  /** Playback was cut short (barge-in, stop, a failed turn). */
  interrupted: boolean;
  unspokenText: string | null;
  error: { code: string; message: string } | null;
  entries: { user: TranscriptEntry | null; assistant: TranscriptEntry | null };
}

export type VoiceBridgeEvent =
  | VoiceLoopEvent
  /**
   * First audio of a turn (spec O.5): measured from the moment the end of the turn was
   * detected (the push-to-talk release, the VAD's `speech_end`) and from the final transcript.
   * The loop's report at `turn_end` adds the end-of-turn detection stage itself.
   */
  | {
      type: "voice.first_audio";
      turn: number;
      sinceTurnEndMs: number | null;
      sinceFinalMs: number | null;
      targetMs: number;
      withinTarget: boolean;
    }
  /** The agent read a change card back and waits for a yes or a tap (approval needed). */
  | { type: "voice.readback"; turn: number; pending: PendingConfirmation }
  | { type: "voice.approval"; turn: number; approval: VoiceApproval }
  /** The registry's result of an answer to the card: a spoken yes or no, a tap or a "no" from the shell. */
  | {
      type: "voice.answer";
      turn: number;
      pendingId: string;
      answer: "tap" | "no" | "spoken";
      result: CommandResultView;
    }
  | { type: "voice.turn"; turn: number; record: VoiceTurn }
  | { type: "voice.stopped"; turn: number };

/** One event as the daemon streams it: numbered so a stream can resume. */
export interface VoiceBridgeEntry {
  seq: number;
  at: string;
  event: VoiceBridgeEvent;
}

interface TurnState {
  turn: number;
  source: VoiceTurnSource;
  reply: ChatReply | null;
  approval: VoiceApproval | null;
  outcome: CommandResultView | null;
  chunks: number;
  tEndOfTurn: number | null;
  tFinal: number | null;
  error: ForerunnerError | null;
  ended: boolean;
  waiters: Array<(t: VoiceTurn) => void>;
}

const DEFAULT_BUFFER = 1000;
export const VOICE_SESSION_AUDIT_TOOL = "voice.session";
export const VOICE_APPROVAL_AUDIT_TOOL = "voice.approval";
/**
 * A spoken "no" that cancels the card: the registry's own reading of a typed or spoken reply
 * (`confirmByText`) and the conversation agent's. Every other negation `expectYes` flags (a
 * hesitation: "wait", "maybe", "not now") refuses without cancelling; the card waits.
 */
const SPOKEN_NO_RE = /^\s*(no|nope|cancel|stop|nein|non|abbrechen)\b/i;

export class VoiceBridge {
  readonly id: string;
  readonly loop: VoiceLoop;
  /** The conversation session whose event log holds the chat, the approvals and the turns. */
  readonly sessionId: string;
  readonly mode: VoiceMode;
  readonly language: string | null;
  readonly projectId: string | null;
  readonly startedAt: string;
  readonly turns: VoiceTurn[] = [];
  readonly approvals: VoiceApproval[] = [];
  endedAt: string | null = null;
  private pendingCard: PendingConfirmation | null = null;
  private readonly textStt: TextTurnStt;
  private readonly emitter = new EventEmitter();
  private readonly buffer: VoiceBridgeEntry[] = [];
  private seq = 0;
  private readonly live = new Map<number, TurnState>();
  private nextSource: VoiceTurnSource = "audio";
  private chain: Promise<void> = Promise.resolve();
  private readonly logger = log("voice:bridge");
  private readonly clock: Clock;

  private constructor(
    private readonly opts: VoiceBridgeOptions,
    sessionId: string,
  ) {
    this.clock = opts.clock;
    this.id = opts.id ?? newId(opts.clock.now());
    this.sessionId = sessionId;
    this.mode = opts.mode ?? "push_to_talk";
    this.language = opts.language ?? null;
    this.projectId = opts.projectId ?? null;
    this.startedAt = opts.clock.nowIso();
    this.textStt = new TextTurnStt(opts.stt, opts.clock);
    this.loop = new VoiceLoop({
      stt: this.textStt,
      tts: opts.tts,
      mode: this.mode,
      converse: this.converse,
      clock: opts.clock,
      sink: opts.sink ?? pacedSink(opts.clock),
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.storeAudio ? { storeAudio: true, sessionId: this.id } : {}),
      ...(opts.audioDir ? { audioDir: join(opts.audioDir, this.id) } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.targets ? { targets: opts.targets } : {}),
      onEvent: (e) => this.onLoopEvent(e),
    });
  }

  /** Open the bridge on the human's conversation session and start the loop. */
  static async create(opts: VoiceBridgeOptions): Promise<VoiceBridge> {
    const sessionId = await opts.agent.conversationSessionId(opts.agentId, opts.projectId ?? null);
    const bridge = new VoiceBridge(opts, sessionId);
    await bridge.audit(VOICE_SESSION_AUDIT_TOOL, true, {
      action: "start",
      id: bridge.id,
      mode: bridge.mode,
      language: bridge.language,
      projectId: bridge.projectId,
      stt: opts.providers?.stt ?? opts.stt.name,
      tts: opts.providers?.tts ?? opts.tts.name,
      storeAudio: opts.storeAudio === true,
    });
    bridge.loop.start();
    return bridge;
  }

  get state(): VoiceLoopState {
    return this.loop.state;
  }

  get currentTurn(): number {
    return this.loop.currentTurn;
  }

  get ended(): boolean {
    return this.endedAt !== null;
  }

  /**
   * The change card this session read back and still waits on: taken from the agent's reply,
   * kept only while the registry lists it (checked at every answer).
   */
  get pending(): PendingConfirmation | null {
    return this.pendingCard;
  }

  get lastTurn(): VoiceTurn | null {
    return this.turns[this.turns.length - 1] ?? null;
  }

  // -------------------------------------------------------------------------------------
  // Input from the shell

  /** Push-to-talk pressed or released. While the agent speaks a press is the barge-in. */
  press(pressed: boolean): void {
    this.assertOpen();
    if (pressed) {
      this.nextSource = "audio";
      this.loop.pressStart();
    } else {
      this.loop.pressEnd();
    }
  }

  /** Microphone audio (any rate and channel count; the loop converts for STT and the VAD). */
  push(chunk: AudioChunk): void {
    this.assertOpen();
    this.loop.push(chunk);
  }

  /**
   * The text fallback: a typed line runs as one push-to-talk turn without audio (the same
   * converse port, approval rules, TTS pipeline and rows). Resolves when the turn has ended.
   * Refused while a capture is open or a transcript is awaited.
   */
  async text(text: string): Promise<VoiceTurn> {
    this.assertOpen();
    const line = text.trim();
    if (!line) throw new ForerunnerError("validation", "text must not be empty");
    const state = this.loop.state;
    if (state === "listening" || state === "transcribing") {
      throw new ForerunnerError("validation", `a voice turn is ${state}; wait for it to end`);
    }
    this.nextSource = "text";
    this.textStt.inject(line);
    this.loop.pressStart();
    if (this.loop.state !== "listening") {
      this.textStt.clear();
      this.nextSource = "audio";
      throw new ForerunnerError("unavailable", "the voice loop did not open a turn");
    }
    const turn = this.loop.currentTurn;
    const done = this.turnEnded(turn);
    this.loop.pressEnd();
    return done;
  }

  /**
   * The shell answered the read-back without speaking: a tap confirms the card through the
   * registry as a tap (a medium-risk card; a high-risk one still needs the paired device, and
   * the registry says so), a "no" cancels it. The registry decides: a card it no longer holds
   * (answered elsewhere, expired) is refused with the reason and forgotten here. A spoken yes
   * is a turn, not this.
   */
  async answer(
    answer: "tap" | "no",
    by: Actor,
  ): Promise<{ pendingId: string; result: CommandResultView; approval: VoiceApproval }> {
    this.assertOpen();
    const card = this.pendingCard;
    if (!card) throw new ForerunnerError("not_found", "no change card is waiting for an answer");
    const result =
      answer === "tap"
        ? await this.opts.commands.confirm(card.id, { kind: "tap", by, source: "voice" })
        : await this.opts.commands.cancel(card.id, by);
    const turn = this.loop.currentTurn;
    const approval = await this.decided(
      turn,
      card,
      {
        turn,
        line: "",
        approved: answer === "tap",
        matched: null,
        blockedBy: null,
        at: this.clock.nowIso(),
        subject: card.readback,
        method: answer,
      },
      result,
    );
    this.record({ type: "voice.answer", turn, pendingId: card.id, answer, result });
    return { pendingId: card.id, result, approval };
  }

  /** Stop at once in every state (spec O.9); input is refused afterwards. */
  async stop(): Promise<void> {
    if (this.endedAt !== null) return;
    this.endedAt = this.clock.nowIso();
    await this.loop.stop();
    await this.chain;
    await this.audit(VOICE_SESSION_AUDIT_TOOL, true, {
      action: "stop",
      id: this.id,
      turns: this.turns.length,
    });
    this.record({ type: "voice.stopped", turn: this.loop.currentTurn });
  }

  /** Resolves with the turn's record once the loop has ended that turn. */
  turnEnded(turn: number): Promise<VoiceTurn> {
    const existing = this.turns.find((t) => t.turn === turn);
    if (existing) return Promise.resolve(existing);
    const st = this.live.get(turn);
    if (!st) return Promise.reject(new ForerunnerError("not_found", `no voice turn ${turn}`));
    return new Promise((resolve) => st.waiters.push(resolve));
  }

  // -------------------------------------------------------------------------------------
  // Events for the daemon's stream

  subscribe(listener: (entry: VoiceBridgeEntry) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  /** Buffered events after `seq` (audio chunks are never replayed). */
  eventsAfter(seq: number): VoiceBridgeEntry[] {
    return this.buffer.filter((e) => e.seq > seq);
  }

  get lastSeq(): number {
    return this.seq;
  }

  // -------------------------------------------------------------------------------------
  // Internals

  private assertOpen(): void {
    if (this.endedAt !== null) {
      throw new ForerunnerError("validation", `voice session ${this.id} has ended`);
    }
  }

  private record(event: VoiceBridgeEvent): void {
    const entry: VoiceBridgeEntry = { seq: ++this.seq, at: this.clock.nowIso(), event };
    if (event.type !== "audio") {
      this.buffer.push(entry);
      const limit = this.opts.bufferSize ?? DEFAULT_BUFFER;
      if (this.buffer.length > limit) this.buffer.splice(0, this.buffer.length - limit);
    }
    try {
      this.emitter.emit("event", entry);
    } catch (e) {
      this.logger.warn("voice event listener threw", { error: errorMessage(e) });
    }
  }

  private appendEvent(type: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.opts.store.event.append(this.sessionId, type, payload as never, 0, {
      authorHuman: this.opts.humanId,
    });
  }

  private async audit(
    tool: string,
    allowed: boolean,
    input: Record<string, unknown>,
    denied?: string,
  ): Promise<void> {
    try {
      await this.opts.store.auditLog.append({
        tool,
        allowed,
        denied_reason: denied ?? null,
        session_id: this.sessionId,
        agent_id: this.opts.agentId,
        human_id: this.opts.humanId,
        input_summary: JSON.stringify(input),
        result_summary: allowed ? "ok" : (denied ?? "refused"),
        cost_usd_micro: 0,
        occurred_at: this.clock.nowIso(),
        author_human: this.opts.humanId,
      });
    } catch (e) {
      this.logger.warn("could not write the voice audit row", { tool, error: errorMessage(e) });
    }
  }

  private turnState(turn: number): TurnState {
    let st = this.live.get(turn);
    if (!st) {
      st = {
        turn,
        source: "audio",
        reply: null,
        approval: null,
        outcome: null,
        chunks: 0,
        tEndOfTurn: null,
        tFinal: null,
        error: null,
        ended: false,
        waiters: [],
      };
      this.live.set(turn, st);
    }
    return st;
  }

  private onLoopEvent(e: VoiceLoopEvent): void {
    switch (e.type) {
      case "turn_start": {
        const st = this.turnState(e.turn);
        st.source = this.nextSource;
        this.nextSource = "audio";
        break;
      }
      case "state": {
        if (e.state === "transcribing") this.turnState(e.turn).tEndOfTurn = this.clock.monotonic();
        // A turn that failed before its reply (an STT error) ends without `turn_end`: close it.
        if (e.state === "idle") {
          for (const st of this.live.values()) {
            if (st.error && !st.ended) this.finish(st, null, null);
          }
        }
        break;
      }
      case "transcript_final":
        this.turnState(e.turn).tFinal = this.clock.monotonic();
        break;
      case "audio":
        this.turnState(e.turn).chunks++;
        break;
      case "speaking_start": {
        const st = this.turnState(e.turn);
        const now = this.clock.monotonic();
        const sinceTurnEndMs = st.tEndOfTurn === null ? null : now - st.tEndOfTurn;
        const targetMs =
          this.opts.targets?.totalToFirstAudioMs ?? DEFAULT_LATENCY_TARGETS.totalToFirstAudioMs;
        this.record(e);
        this.record({
          type: "voice.first_audio",
          turn: e.turn,
          sinceTurnEndMs,
          sinceFinalMs: st.tFinal === null ? null : now - st.tFinal,
          targetMs,
          withinTarget: sinceTurnEndMs !== null && sinceTurnEndMs <= targetMs,
        });
        return;
      }
      case "error":
        this.turnState(e.turn).error = e.error;
        break;
      case "turn_end": {
        this.record(e);
        this.finish(this.turnState(e.turn), e.latency, e.entry, e.unspokenText);
        return;
      }
      default:
        break;
    }
    this.record(e);
  }

  /** Close a turn: its record, the `voice.turn` row, the event, the waiters. */
  private finish(
    st: TurnState,
    latency: LatencyReport | null,
    assistant: TranscriptEntry | null,
    unspoken?: string,
  ): void {
    if (st.ended) return;
    st.ended = true;
    const turn = st.turn;
    const user = this.loop.transcript.find((t) => t.turn === turn && t.role === "user") ?? null;
    const report =
      latency ??
      buildLatencyReport(
        {
          turn,
          endOfTurnMs: null,
          finalTranscriptMs: null,
          modelFirstTokenMs: null,
          firstAudioMs: null,
          noResponse: true,
        },
        this.opts.targets,
      );
    const record: VoiceTurn = {
      turn,
      source: st.source,
      said: user?.text ?? "",
      heard: assistant?.text ?? "",
      reply: st.reply,
      approval: st.approval,
      outcome: st.outcome,
      pending: this.pendingCard,
      latency: report,
      audioChunks: st.chunks,
      audioStored: assistant?.audioStored ?? user?.audioStored ?? false,
      interrupted: assistant?.interrupted === true || report.interrupted,
      unspokenText: unspoken ?? assistant?.unspokenText ?? null,
      error: st.error ? { code: st.error.code, message: st.error.message } : null,
      entries: { user, assistant },
    };
    this.turns.push(record);
    this.live.delete(turn);
    // Spec O.5, O.10: the transcript and the measured stages are session history. Rows are
    // appended in turn order; the waiters resolve once the row is written.
    this.chain = this.chain
      .then(() =>
        this.appendEvent("voice.turn", {
          turn,
          source: record.source,
          said: record.said,
          heard: record.heard,
          audioChunks: record.audioChunks,
          audioStored: record.audioStored,
          interrupted: record.interrupted,
          unspokenText: record.unspokenText,
          pendingId: record.pending?.id ?? null,
          outcome: record.outcome?.status ?? null,
          error: record.error,
          latency: {
            endOfTurnMs: report.endOfTurnMs,
            finalTranscriptMs: report.finalTranscriptMs,
            modelFirstTokenMs: report.modelFirstTokenMs,
            firstAudioMs: report.firstAudioMs,
            totalToFirstAudioMs: report.totalToFirstAudioMs,
            withinTarget: report.withinTarget,
            // Diagnostics inside the first-audio stage: first delta -> first sentence, and
            // sentence sent -> first TTS chunk (the real-audio run's report reads them).
            firstSentenceMs: report.firstSentenceMs,
            ttsFirstByteMs: report.ttsFirstByteMs,
          },
        }),
      )
      .catch((e: unknown) => {
        this.logger.warn("could not write the voice.turn row", { turn, error: errorMessage(e) });
      })
      .then(() => {
        this.record({ type: "voice.turn", turn, record });
        for (const w of st.waiters) w(record);
        st.waiters = [];
      });
  }

  private readonly converse: ConverseFn = (transcript, signal) =>
    this.converseTurn(transcript, signal);

  /** A line said while a card waits: decided by the rules, carried out by the registry. */
  private async spokenAnswer(
    st: TurnState,
    card: PendingConfirmation,
    record: SpokenApprovalRecord,
  ): Promise<string> {
    const by: Actor = { kind: "human", id: this.opts.humanId };
    let result: CommandResultView | null = null;
    if (record.approved) {
      result = await this.opts.commands.confirm(card.id, { kind: "yes", by, source: "voice" });
    } else if (isSpokenNo(record)) {
      result = await this.opts.commands.cancel(card.id, by);
    }
    const approval = await this.decided(st.turn, card, { ...record, method: "spoken" }, result);
    st.approval = approval;
    st.outcome = result;
    // Not a yes and not a no: nothing is confirmed, the card stays, the read-back repeats.
    const spoken = result
      ? spokenOutcome(result)
      : `I did not take that as a yes. ${card.readback}`;
    await this.chatRows(record, spoken, card, result);
    if (result) {
      this.record({
        type: "voice.answer",
        turn: st.turn,
        pendingId: card.id,
        answer: "spoken",
        result,
      });
    }
    return spoken;
  }

  /**
   * Book an approval decision: the bridge's copy of the card follows the registry's pending
   * list, the `voice.approval` row and audit row carry the exact line and the registry's
   * status, and a card that still waits is read back again (the event the shell shows).
   */
  private async decided(
    turn: number,
    card: PendingConfirmation,
    decision: SpokenApprovalRecord & { method: VoiceAnswerMethod },
    result: CommandResultView | null,
  ): Promise<VoiceApproval> {
    const stays = this.registryHas(card.id);
    this.pendingCard = stays ? card : null;
    const notAnswered = decision.blockedBy ? `not a yes: ${decision.blockedBy}` : "not a yes";
    const approval: VoiceApproval = {
      ...decision,
      pendingId: card.id,
      commands: card.commands,
      status: result?.status ?? "pending",
      reason: result ? (result.reason ?? null) : notAnswered,
    };
    this.approvals.push(approval);
    await this.appendEvent("voice.approval", { ...approval });
    const allowed = result !== null && result.status !== "refused";
    await this.audit(
      VOICE_APPROVAL_AUDIT_TOOL,
      allowed,
      {
        method: approval.method,
        line: approval.line,
        approved: approval.approved,
        blockedBy: approval.blockedBy,
        pendingId: card.id,
        commands: card.commands,
        status: approval.status,
        ...(approval.reason ? { reason: approval.reason } : {}),
      },
      allowed ? undefined : (approval.reason ?? "refused"),
    );
    this.record({ type: "voice.approval", turn, approval });
    if (stays) this.record({ type: "voice.readback", turn, pending: card });
    return approval;
  }

  /** Whether the registry still lists the card for this human. */
  private registryHas(pendingId: string): boolean {
    return this.opts.commands.pending(this.opts.humanId).some((p) => p.id === pendingId);
  }

  /**
   * The transcript rows the conversation agent writes for a line it handles (`chat.human`,
   * `chat.confirmed` / `chat.cancelled`, `chat.reply`; `daemon/views.ts` renders them), for a
   * line the bridge answered itself, so the conversation reads the same either way.
   */
  private async chatRows(
    record: SpokenApprovalRecord,
    spoken: string,
    card: PendingConfirmation,
    result: CommandResultView | null,
  ): Promise<void> {
    const transcriptId = newId(this.clock.now());
    await this.appendEvent("chat.human", { transcriptId, text: record.line, source: "voice" });
    if (result) {
      await this.appendEvent(record.approved ? "chat.confirmed" : "chat.cancelled", {
        confirmationId: card.id,
        transcriptId,
        commands: card.commands,
        words: record.line,
        status: result.status,
      });
    }
    const acted = result !== null && (result.status === "done" || result.status === "partial");
    await this.appendEvent("chat.reply", {
      transcriptId,
      text: spoken,
      actions: acted ? [card.commands.join("+") || "command"] : [],
    });
  }

  /**
   * The loop's converse port over the conversation agent. With a card pending, the spoken
   * rules decide whether the line is a yes (spec O.7) or a no, the registry carries the answer
   * out and the decision is logged with the exact line and the registry's outcome; a refused
   * line repeats the read-back. None of that reaches the agent. The registry's pending list
   * is the truth: a card it no longer holds is gone here too, and a line that is not an
   * answer to it is a plain line.
   */
  private async *converseTurn(transcript: string, signal: AbortSignal): AsyncIterable<string> {
    const turn = this.loop.currentTurn;
    const st = this.turnState(turn);
    const card = this.pendingCard;
    // Spec O.9, "stopping is immediate": a stop said while a work session runs is the kill
    // switch, not a "no" to the card (`expectYes` reads "stop" as a negation). The line goes to
    // the agent, which cancels the card and runs the stop (`ConversationAgent.stopsLiveSession`);
    // a card the registry still holds after that (the agent's copy had been dropped by a typed
    // line) is cancelled below, so nothing waits for a yes after a stop.
    const stopOverCard =
      card !== null && (await this.opts.agent.stopsLiveSession(this.opts.agentId, transcript));
    if (card && !stopOverCard) {
      const record = spokenApprovalRecord(
        turn,
        transcript,
        this.clock,
        card.readback,
        this.language ? { language: this.language } : {},
      );
      const isAnswer = record.approved || isSpokenNo(record);
      if (isAnswer || this.registryHas(card.id)) {
        st.reply = null;
        yield await this.spokenAnswer(st, card, record);
        return;
      }
    }
    this.pendingCard = null;
    const deltas = new AsyncQueue<string>();
    let streamed = "";
    void this.opts.agent
      .chat({
        humanId: this.opts.humanId,
        agentId: this.opts.agentId,
        ...(this.projectId ? { projectId: this.projectId } : {}),
        text: transcript,
        source: "voice",
        signal,
        onToken: (t) => {
          streamed += t;
          deltas.push(t);
        },
      })
      .then(
        async (reply) => {
          try {
            st.reply = reply;
            this.pendingCard = reply.pendingConfirmation;
            if (reply.pendingConfirmation) {
              this.record({ type: "voice.readback", turn, pending: reply.pendingConfirmation });
            }
            if (stopOverCard && card && this.registryHas(card.id)) {
              const result = await this.opts.commands.cancel(card.id, {
                kind: "human",
                id: this.opts.humanId,
              });
              this.record({ type: "voice.answer", turn, pendingId: card.id, answer: "no", result });
            }
            // A deterministic turn (no model call) streams nothing: the whole reply is spoken.
            // After a model turn the agent appends the read-back of a pending card to the text
            // it streamed: speak what was not streamed yet, never the same words twice.
            const rest = unstreamedPart(reply, streamed);
            if (rest.trim()) deltas.push(rest);
          } catch (e) {
            deltas.fail(e);
            return;
          }
          deltas.close();
        },
        (e: unknown) => deltas.fail(e),
      );
    for await (const d of deltas) yield d;
  }
}

/** The sentence the human hears for the registry's answer (the conversation agent's wording). */
export function spokenOutcome(r: CommandResultView): string {
  switch (r.status) {
    case "done":
      return r.sentence ?? "Done.";
    case "partial":
      return `${r.sentence ?? "Done."} (partly: ${r.reason ?? "a step failed"})`;
    case "pending":
      return r.readback ?? "Needs confirmation.";
    case "cancelled":
      return "Cancelled; nothing was changed.";
    default:
      return `Not done: ${r.reason ?? "refused"}.`;
  }
}

/** A negation that is a "no" to the card (cancel), not a hesitation (the card waits). */
function isSpokenNo(record: SpokenApprovalRecord): boolean {
  return record.blockedBy === "negation" && SPOKEN_NO_RE.test(record.line);
}

/** What of a reply the shell still has to say after the deltas it already streamed. */
export function unstreamedPart(reply: ChatReply, streamed: string): string {
  if (streamed.length === 0) return reply.reply;
  const prefix = streamed.trimEnd();
  if (reply.reply.startsWith(prefix)) return reply.reply.slice(prefix.length);
  const readback = reply.pendingConfirmation?.readback ?? "";
  if (readback && reply.reply.endsWith(readback) && !streamed.includes(readback)) return readback;
  return "";
}
