/**
 * Voice on the scenario world (scenario 3, spec O): the real `VoiceLoop` of `@forerunner/voice`
 * with the package's fake STT and TTS providers, wired to the runtime's `ConversationAgent`
 * through the loop's `converse` port. The OS audio devices live in the Tauri shell and cannot
 * run here, so the bridge below stands where the shell's voice wiring stands: microphone PCM
 * goes in through `loop.push`, playback chunks come out through an `AudioSink`, and the
 * conversation agent's reply streams into the loop sentence by sentence.
 *
 * The bridge also applies the spoken approval rules (`expectYes`, spec O.7) when the agent has
 * a change card pending for the human: a line the rules accept is forwarded to the agent as
 * the human's yes (the exact transcript line is kept in the approval record), a line they
 * refuse (a question, a qualifier, a deferral) never confirms anything and the card is read
 * back again. Every spoken approval decision and every turn's transcript and latency report
 * are appended to the conversation session's event log (`voice.approval`, `voice.turn`), so
 * the scenario asserts them on rows, not on the loop's memory alone.
 */
import type { ChatReply, ConversationAgent, PendingConfirmation } from "@forerunner/runtime";
import { isYes } from "@forerunner/runtime";
import type { StateStore } from "@forerunner/state";
// `@forerunner/voice` is not declared in tests/e2e/package.json; the relative path reaches the
// same sources the shell runs (docs/maintainers/testing.md, Scenarios, Known issues).
import {
  AsyncQueue,
  type AudioChunk,
  type ConverseFn,
  chunkify,
  collectingSink,
  FakeStt,
  type FakeSttScript,
  FakeTts,
  type LatencyReport,
  type SpokenApprovalRecord,
  spokenApprovalRecord,
  synth,
  type TranscriptEntry,
  VoiceLoop,
  type VoiceLoopEvent,
} from "../../../packages/voice/src/index.ts";
import type { Install, ScenarioWorld } from "./scenario-world.ts";

export interface VoiceBridgeOptions {
  agent: ConversationAgent;
  install: Install;
  /** The project the conversation starts on (the agent's active project wins once recorded). */
  projectId?: string;
  /** BCP-47 language for the spoken approval rules. */
  language?: string;
  /** Fake STT: delay from end of speech to the final transcript. Default 300 ms. */
  sttFinalDelayMs?: number;
  /** Fake TTS: delay before the first chunk of every sentence. Default 200 ms. */
  ttsFirstChunkMs?: number;
  /** Real-time bound on one turn's simulated stepping. Default 30 s of simulated time. */
  maxTurnMs?: number;
}

export interface VoiceTurn {
  turn: number;
  /** What J said (the final transcript). */
  said: string;
  /** What J heard: the assistant transcript line (what was played). */
  heard: string;
  /** The conversation agent's reply; null when the bridge answered itself (a refused yes). */
  reply: ChatReply | null;
  /** The spoken approval decision of this turn, when a card was pending. */
  approval: SpokenApprovalRecord | null;
  latency: LatencyReport;
  /** Audio chunks the sink received for this turn. */
  audioChunks: number;
  entries: { user: TranscriptEntry | null; assistant: TranscriptEntry | null };
}

export interface VoiceBridge {
  loop: VoiceLoop;
  stt: FakeStt;
  tts: FakeTts;
  /** The conversation session whose event log holds the chat, the approvals and the turns. */
  sessionId: string;
  turns: VoiceTurn[];
  events: VoiceLoopEvent[];
  approvals: SpokenApprovalRecord[];
  /** The change card the agent is waiting on, read from its last reply. */
  readonly pending: PendingConfirmation | null;
  /** One push-to-talk turn: J says `text`; resolves when the reply has been played. */
  say(text: string): Promise<VoiceTurn>;
  stop(): Promise<void>;
}

/** Let every pending microtask and I/O callback run (the store's queries, the provider). */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

const SPEECH_MS = 400;
const FRAME_MS = 20;
const STEP_MS = 50;
const RELEASE_AFTER_MS = 20;

export async function voiceBridge(
  world: ScenarioWorld,
  opts: VoiceBridgeOptions,
): Promise<VoiceBridge> {
  const { clock, store } = world;
  const { agent, install } = opts;
  const humanId = install.human.id;
  const agentId = install.agent.id;
  const sessionId = await agent.conversationSessionId(agentId, opts.projectId ?? null);
  const scripts: FakeSttScript[] = [];
  const stt = new FakeStt({
    clock,
    scripts: (turn) => scripts[turn] ?? { final: "" },
    finalDelayMs: opts.sttFinalDelayMs ?? 300,
  });
  const tts = new FakeTts({
    clock,
    firstChunkLatencyMs: opts.ttsFirstChunkMs ?? 200,
    chunkMs: 100,
    chunks: 2,
  });
  const sink = collectingSink();
  const events: VoiceLoopEvent[] = [];
  const approvals: SpokenApprovalRecord[] = [];
  const turns: VoiceTurn[] = [];
  let pending: PendingConfirmation | null = null;
  let currentReply: ChatReply | null = null;
  let currentApproval: SpokenApprovalRecord | null = null;
  let chunksBefore = 0;
  const language = opts.language;

  const appendEvent = (type: string, payload: Record<string, unknown>) =>
    store.event.append(sessionId, type, payload as never, 0, { authorHuman: humanId });

  const converse: ConverseFn = async function* (transcript, signal) {
    const turn = loop.currentTurn;
    let text = transcript;
    if (pending) {
      // Spec O.7: the agent read the card back and waits for "yes"; the spoken rules decide
      // whether this line is one, and the decision is logged with the exact line.
      const record = spokenApprovalRecord(
        turn,
        transcript,
        clock,
        pending.readback,
        language ? { language } : {},
      );
      approvals.push(record);
      currentApproval = record;
      await appendEvent("voice.approval", {
        ...record,
        pendingId: pending.id,
        commands: pending.commands,
      });
      if (!record.approved && record.blockedBy !== "negation") {
        // Not a yes: nothing is confirmed, the card stays pending, the read-back repeats.
        currentReply = null;
        yield `I did not take that as a yes. ${pending.readback}`;
        return;
      }
      // The exact line when the agent's own check reads it as a yes, else the canonical word.
      text = record.approved && !isYes(transcript) ? "yes" : transcript;
    }
    const deltas = new AsyncQueue<string>();
    let streamed = "";
    void agent
      .chat({
        humanId,
        agentId,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        text,
        source: "voice",
        signal,
        onToken: (t) => {
          streamed += t;
          deltas.push(t);
        },
      })
      .then(
        (reply) => {
          currentReply = reply;
          pending = reply.pendingConfirmation;
          // A deterministic turn (no model call) streams nothing: the whole reply is spoken.
          // After a model turn the agent appends the read-back of a pending card to the text
          // it streamed: speak what was not streamed yet, never the same words twice.
          const rest = unstreamedPart(reply, streamed);
          if (rest.trim()) deltas.push(rest);
          deltas.close();
        },
        (e: unknown) => deltas.fail(e),
      );
    for await (const d of deltas) yield d;
  };

  const loop = new VoiceLoop({
    stt,
    tts,
    mode: "push_to_talk",
    converse,
    clock,
    sink,
    ...(language ? { language } : {}),
    onEvent: (e) => events.push(e),
  });
  loop.start();

  const speech = (): AudioChunk[] => chunkify(synth(440, SPEECH_MS), FRAME_MS, 16000, 0);

  const bridge: VoiceBridge = {
    loop,
    stt,
    tts,
    sessionId,
    turns,
    events,
    approvals,
    get pending() {
      return pending;
    },
    async say(text) {
      const index = loop.currentTurn; // the next turn's index for the STT script
      scripts[index] = {
        partials: [{ atAudioMs: 100, text: text.split(" ")[0] ?? "" }],
        final: text,
      };
      currentReply = null;
      currentApproval = null;
      chunksBefore = sink.chunks.length;
      loop.pressStart();
      // The device delivers 20 ms frames as they are captured; the release comes 20 ms after
      // the last frame (the push-to-talk end of turn the latency report measures).
      for (const c of speech()) {
        clock.tickMonotonic(FRAME_MS);
        loop.push(c);
      }
      clock.tickMonotonic(RELEASE_AFTER_MS);
      loop.pressEnd();
      // Step the simulated clock until the reply has been played: the STT final, the model
      // stream and the TTS chunks all run on it; the store's work settles between steps.
      const limit = opts.maxTurnMs ?? 30_000;
      let spent = 0;
      while (loop.state !== "idle" && spent < limit) {
        await settle(24);
        await clock.advance(STEP_MS);
        spent += STEP_MS;
      }
      await loop.idle();
      await settle();
      const turn = loop.currentTurn;
      const latency = loop.latencies.find((l) => l.turn === turn);
      if (!latency) throw new Error(`voice turn ${turn} ended without a latency report`);
      const user = loop.transcript.find((t) => t.turn === turn && t.role === "user") ?? null;
      const assistant =
        loop.transcript.find((t) => t.turn === turn && t.role === "assistant") ?? null;
      const record: VoiceTurn = {
        turn,
        said: user?.text ?? "",
        heard: assistant?.text ?? "",
        reply: currentReply,
        approval: currentApproval,
        latency,
        audioChunks: sink.chunks.length - chunksBefore,
        entries: { user, assistant },
      };
      turns.push(record);
      // Spec O.5, O.10: the transcript and the measured stages are session history.
      await appendEvent("voice.turn", {
        turn,
        said: record.said,
        heard: record.heard,
        audioChunks: record.audioChunks,
        audioStored: assistant?.audioStored ?? false,
        latency: {
          endOfTurnMs: latency.endOfTurnMs,
          finalTranscriptMs: latency.finalTranscriptMs,
          modelFirstTokenMs: latency.modelFirstTokenMs,
          firstAudioMs: latency.firstAudioMs,
          totalToFirstAudioMs: latency.totalToFirstAudioMs,
          withinTarget: latency.withinTarget,
        },
      });
      return record;
    },
    stop: () => loop.stop(),
  };
  return bridge;
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

/** The scenario's view of a store's event rows of one type (payloads as objects). */
export async function eventsOfType(
  store: StateStore,
  sessionId: string,
  type: string,
): Promise<Record<string, unknown>[]> {
  const rows = await store.event.list(sessionId);
  return rows.filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);
}
