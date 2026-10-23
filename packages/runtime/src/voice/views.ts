/**
 * The daemon's views of the voice bridge (`api-types.ts` shapes): sessions, turns, approvals
 * and the event frames of the SSE stream. Audio is base64 16-bit PCM in the frame and goes
 * nowhere else; money is rendered in CHF at the day's rate like every other view.
 */

import type { ChatReply, PendingConfirmation } from "../conversation/agent.ts";
import type {
  ChatPendingView,
  ChatReplyView,
  CommandResultJson,
  SpeakEventView,
  SpeakView,
  VoiceAnswerView,
  VoiceApprovalView,
  VoiceEventView,
  VoiceLatencyView,
  VoiceProviderView,
  VoiceSessionView,
  VoiceStatusView,
  VoiceTurnView,
} from "../daemon/api-types.ts";
import { VOICE_MODES } from "../daemon/api-types.ts";
import { money } from "../daemon/views.ts";
import type { CommandResultView } from "../loop/ports.ts";
import type { VoiceApproval, VoiceBridgeEntry, VoiceTurn } from "./bridge.ts";
import { type AudioChunk, bytesToPcm, type LatencyReport, toInt16 } from "./pkg.ts";
import type { VoiceAvailability, VoiceSession } from "./sessions.ts";
import type { SpeakEntry, SpeakRecord, Utterance } from "./speak.ts";

export function chatPendingView(p: PendingConfirmation, chf: number): ChatPendingView {
  return {
    id: p.id,
    readback: p.readback,
    estimate: money(p.costUsdMicro ?? 0, chf),
    commands: p.commands,
    decision: p.decision ?? null,
  };
}

export function voiceChatReplyView(r: ChatReply, chf: number): ChatReplyView {
  return {
    reply: r.reply,
    actions: r.actions,
    pendingConfirmation: r.pendingConfirmation ? chatPendingView(r.pendingConfirmation, chf) : null,
    question: r.question,
    ttftMs: r.ttftMs,
    cost: money(r.costUsdMicro, chf),
    transcriptId: r.transcriptId,
    activeProjectId: r.activeProjectId,
  };
}

export function voiceLatencyView(l: LatencyReport): VoiceLatencyView {
  return {
    turn: l.turn,
    endOfTurnMs: l.endOfTurnMs,
    finalTranscriptMs: l.finalTranscriptMs,
    modelFirstTokenMs: l.modelFirstTokenMs,
    firstAudioMs: l.firstAudioMs,
    totalToFirstAudioMs: l.totalToFirstAudioMs,
    stages: l.stages,
    withinTarget: l.withinTarget,
    firstSentenceMs: l.firstSentenceMs,
    ttsFirstByteMs: l.ttsFirstByteMs,
    interrupted: l.interrupted,
    noResponse: l.noResponse,
    targets: l.targets,
  };
}

/** The registry's result as the views carry it: the cost in CHF at the day's rate. */
export function commandResultJson(r: CommandResultView, chf: number): CommandResultJson {
  const { costUsdMicro, ...rest } = r;
  return {
    ...rest,
    ...(typeof costUsdMicro === "number" ? { cost: money(costUsdMicro, chf) } : {}),
  };
}

export function voiceApprovalView(a: VoiceApproval): VoiceApprovalView {
  return {
    turn: a.turn,
    line: a.line,
    approved: a.approved,
    matched: a.matched,
    blockedBy: a.blockedBy,
    at: a.at,
    ...(a.subject !== undefined ? { subject: a.subject } : {}),
    method: a.method,
    pendingId: a.pendingId,
    commands: a.commands,
    status: a.status,
    reason: a.reason,
  };
}

export function voiceTurnView(t: VoiceTurn, chf: number): VoiceTurnView {
  return {
    turn: t.turn,
    source: t.source,
    said: t.said,
    heard: t.heard,
    reply: t.reply ? voiceChatReplyView(t.reply, chf) : null,
    approval: t.approval ? voiceApprovalView(t.approval) : null,
    outcome: t.outcome ? commandResultJson(t.outcome, chf) : null,
    pending: t.pending ? chatPendingView(t.pending, chf) : null,
    latency: voiceLatencyView(t.latency),
    audioChunks: t.audioChunks,
    audioStored: t.audioStored,
    interrupted: t.interrupted,
    unspokenText: t.unspokenText,
    error: t.error,
  };
}

export function voiceSessionView(s: VoiceSession, chf: number): VoiceSessionView {
  const b = s.bridge;
  return {
    id: s.id,
    state: b.state,
    turn: b.currentTurn,
    mode: b.mode,
    language: b.language,
    projectId: b.projectId,
    conversationSessionId: b.sessionId,
    providers: { stt: s.providers.stt, tts: s.providers.tts },
    pending: b.pending ? chatPendingView(b.pending, chf) : null,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    turns: b.turns.length,
    lastTurn: b.lastTurn ? voiceTurnView(b.lastTurn, chf) : null,
    lastSeq: b.lastSeq,
  };
}

export function voiceStatusView(a: VoiceAvailability): VoiceStatusView {
  const pick = (p: VoiceProviderView | null) => (p ? { ...p } : null);
  return {
    available: a.available,
    reason: a.reason,
    stt: pick(a.stt),
    tts: pick(a.tts),
    statuses: {
      stt: a.statuses.stt.map((s) => ({ ...s })),
      tts: a.statuses.tts.map((s) => ({ ...s })),
    },
    preferences: {
      stt: a.preferences.stt ? { ...a.preferences.stt } : null,
      tts: a.preferences.tts ? { ...a.preferences.tts } : null,
      skipped: a.preferences.skipped.map((s) => ({ ...s })),
    },
    sessions: a.sessions,
    maxSessions: a.maxSessions,
    modes: [...VOICE_MODES],
  };
}

export function voiceAnswerView(
  r: { pendingId: string; result: CommandResultView; approval: VoiceApproval },
  answer: "tap" | "no",
  chf: number,
): VoiceAnswerView {
  return {
    pendingId: r.pendingId,
    answer,
    result: commandResultJson(r.result, chf),
    approval: voiceApprovalView(r.approval),
  };
}

/** Base64 of a chunk's 16-bit little-endian samples. */
export function encodePcm(chunk: AudioChunk): string {
  const samples = toInt16(chunk.pcm);
  const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return bytes.toString("base64");
}

/** Decode what `POST /voice/sessions/:id/audio` carries into the loop's chunk. */
export function decodePcm(
  bytes: Uint8Array,
  meta: { sampleRate: number; channels: number; timestampMs: number },
): AudioChunk {
  return {
    pcm: bytesToPcm(bytes),
    sampleRate: meta.sampleRate,
    channels: meta.channels,
    timestampMs: meta.timestampMs,
  };
}

/** One event as the stream sends it; the loop's fields minus `type` and `turn`. */
export function voiceEventView(entry: VoiceBridgeEntry, chf: number): VoiceEventView {
  const e = entry.event;
  const base = { seq: entry.seq, at: entry.at, type: e.type, turn: "turn" in e ? e.turn : null };
  switch (e.type) {
    case "audio":
      return {
        ...base,
        data: {
          sentenceIndex: e.sentenceIndex,
          sampleRate: e.chunk.sampleRate,
          channels: e.chunk.channels,
          timestampMs: e.chunk.timestampMs,
          pcm: encodePcm(e.chunk),
        },
      };
    case "error":
      return { ...base, data: { code: e.error.code, message: e.error.message } };
    case "turn_end":
      return {
        ...base,
        data: {
          latency: voiceLatencyView(e.latency),
          entry: e.entry,
          unspokenText: e.unspokenText ?? null,
        },
      };
    case "voice.readback":
      return { ...base, data: { pending: chatPendingView(e.pending, chf) } };
    case "voice.approval":
      return { ...base, data: { approval: voiceApprovalView(e.approval) } };
    case "voice.answer":
      return {
        ...base,
        data: {
          pendingId: e.pendingId,
          answer: e.answer,
          result: commandResultJson(e.result, chf),
        },
      };
    case "voice.turn":
      return { ...base, data: { record: voiceTurnView(e.record, chf) } };
    default: {
      const { type: _type, ...rest } = e as { type: string } & Record<string, unknown>;
      const data = { ...rest };
      delete data.turn;
      return { ...base, data };
    }
  }
}

/** An utterance as `GET /speak/:id` answers it: the record plus the sentences and the provider. */
export function speakView(u: Utterance): SpeakView {
  const r = u.record();
  return {
    ...speakRecordView(r),
    sentences: [...u.sentences],
    provider: { ...u.provider },
    conversationSessionId: u.conversationSessionId,
    lastSeq: u.lastSeq,
  };
}

function speakRecordView(
  r: SpeakRecord,
): Omit<SpeakView, "sentences" | "provider" | "conversationSessionId" | "lastSeq"> {
  return {
    id: r.id,
    subject: r.subject,
    source: r.source,
    state: r.state,
    text: r.text,
    heard: r.heard,
    unspokenText: r.unspokenText,
    audioChunks: r.audioChunks,
    audioStored: false,
    firstAudioMs: r.firstAudioMs,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    error: r.error,
  };
}

/** One frame of `GET /speak/:id/events`; an audio frame has the voice loop's shape. */
export function speakEventView(entry: SpeakEntry): SpeakEventView {
  const e = entry.event;
  const base = { seq: entry.seq, at: entry.at, type: e.type };
  switch (e.type) {
    case "audio":
      return {
        ...base,
        data: {
          sentenceIndex: e.sentenceIndex,
          sampleRate: e.chunk.sampleRate,
          channels: e.chunk.channels,
          timestampMs: e.chunk.timestampMs,
          pcm: encodePcm(e.chunk),
        },
      };
    case "speak.done":
      return { ...base, data: { record: speakRecordView(e.record) } };
    default: {
      const { type: _type, ...rest } = e as { type: string } & Record<string, unknown>;
      return { ...base, data: { ...rest } };
    }
  }
}
