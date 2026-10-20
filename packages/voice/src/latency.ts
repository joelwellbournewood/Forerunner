/**
 * Per-turn latency measurement against the spec's budget:
 * end of turn ~0.2 s, final transcript ~0.3 s, model first token ~0.5 s, first audio ~0.2 s,
 * under 1.2 s to first audio. Each stage is measured and shown with a withinTarget flag.
 */

export interface LatencyTargets {
  endOfTurnMs: number;
  finalTranscriptMs: number;
  modelFirstTokenMs: number;
  firstAudioMs: number;
  totalToFirstAudioMs: number;
}

export const DEFAULT_LATENCY_TARGETS: LatencyTargets = {
  endOfTurnMs: 200,
  finalTranscriptMs: 300,
  modelFirstTokenMs: 500,
  firstAudioMs: 200,
  totalToFirstAudioMs: 1200,
};

export interface LatencyStage {
  /** null when the stage was never reached (empty transcript, barge-in before audio). */
  ms: number | null;
  targetMs: number;
  withinTarget: boolean;
}

export interface LatencyReport {
  turn: number;
  /** Last speech -> end-of-turn detected (VAD hangover, or the PTT release). */
  endOfTurnMs: number | null;
  /** End of turn -> final transcript from STT. */
  finalTranscriptMs: number | null;
  /** Final transcript -> first model text delta. */
  modelFirstTokenMs: number | null;
  /** First model delta -> first audio chunk (includes waiting for the first sentence). */
  firstAudioMs: number | null;
  /** End of turn -> first audio chunk; equals the sum of the four stages. */
  totalToFirstAudioMs: number | null;
  stages: {
    endOfTurn: LatencyStage;
    finalTranscript: LatencyStage;
    modelFirstToken: LatencyStage;
    firstAudio: LatencyStage;
    total: LatencyStage;
  };
  /** Every reached stage inside its target and first audio reached. */
  withinTarget: boolean;
  /** Diagnostics: first delta -> first complete sentence, and sentence sent -> first TTS chunk. */
  firstSentenceMs: number | null;
  ttsFirstByteMs: number | null;
  interrupted: boolean;
  /** The model produced no text, or the transcript was empty. */
  noResponse: boolean;
  targets: LatencyTargets;
}

export interface LatencyInput {
  turn: number;
  endOfTurnMs: number | null;
  finalTranscriptMs: number | null;
  modelFirstTokenMs: number | null;
  firstAudioMs: number | null;
  firstSentenceMs?: number | null;
  ttsFirstByteMs?: number | null;
  interrupted?: boolean;
  noResponse?: boolean;
}

function stage(ms: number | null, targetMs: number): LatencyStage {
  const rounded = ms === null ? null : Math.round(ms * 1000) / 1000;
  return { ms: rounded, targetMs, withinTarget: rounded !== null && rounded <= targetMs };
}

export function buildLatencyReport(
  input: LatencyInput,
  targets: Partial<LatencyTargets> = {},
): LatencyReport {
  const t: LatencyTargets = { ...DEFAULT_LATENCY_TARGETS, ...targets };
  const parts = [
    input.endOfTurnMs,
    input.finalTranscriptMs,
    input.modelFirstTokenMs,
    input.firstAudioMs,
  ];
  const total = parts.every((p) => p !== null)
    ? (parts as number[]).reduce((a, b) => a + b, 0)
    : null;
  const stages = {
    endOfTurn: stage(input.endOfTurnMs, t.endOfTurnMs),
    finalTranscript: stage(input.finalTranscriptMs, t.finalTranscriptMs),
    modelFirstToken: stage(input.modelFirstTokenMs, t.modelFirstTokenMs),
    firstAudio: stage(input.firstAudioMs, t.firstAudioMs),
    total: stage(total, t.totalToFirstAudioMs),
  };
  return {
    turn: input.turn,
    endOfTurnMs: stages.endOfTurn.ms,
    finalTranscriptMs: stages.finalTranscript.ms,
    modelFirstTokenMs: stages.modelFirstToken.ms,
    firstAudioMs: stages.firstAudio.ms,
    totalToFirstAudioMs: stages.total.ms,
    stages,
    withinTarget: Object.values(stages).every((s) => s.withinTarget),
    firstSentenceMs: input.firstSentenceMs ?? null,
    ttsFirstByteMs: input.ttsFirstByteMs ?? null,
    interrupted: input.interrupted ?? false,
    noResponse: input.noResponse ?? false,
    targets: t,
  };
}

/** One line per stage, the way the UI's latency strip shows it. */
export function formatLatencyReport(r: LatencyReport): string {
  const row = (label: string, s: LatencyStage) =>
    `${label.padEnd(18)} ${s.ms === null ? "   -  " : `${s.ms.toFixed(0).padStart(5)}ms`} / ${String(s.targetMs).padStart(4)}ms ${s.withinTarget ? "ok" : "over"}`;
  return [
    `turn ${r.turn}${r.interrupted ? " (interrupted)" : ""}${r.noResponse ? " (no response)" : ""}`,
    row("end of turn", r.stages.endOfTurn),
    row("final transcript", r.stages.finalTranscript),
    row("model first token", r.stages.modelFirstToken),
    row("first audio", r.stages.firstAudio),
    row("total", r.stages.total),
  ].join("\n");
}

/** Median of the totals across turns (the phase-5 gate measures this per platform). */
export function medianTotalToFirstAudio(reports: LatencyReport[]): number | null {
  const xs = reports
    .map((r) => r.totalToFirstAudioMs)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1
    ? (xs[mid] as number)
    : ((xs[mid - 1] as number) + (xs[mid] as number)) / 2;
}
