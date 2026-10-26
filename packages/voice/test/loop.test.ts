import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { spokenApprovalRecord } from "../src/approval.ts";
import {
  type ConverseFn,
  PACED_SINK_AHEAD_MS,
  pacedSink,
  type ReplyMode,
  VoiceLoop,
  type VoiceLoopEvent,
  type VoiceMode,
} from "../src/loop.ts";
import { FakeStt, type FakeSttScript, FakeTts } from "../src/providers/fake.ts";
import { AsyncQueue } from "../src/queue.ts";
import {
  type AudioChunk,
  type AudioSink,
  chunkDurationMs,
  type SttEvent,
  type SttProvider,
  type SttSession,
  type TtsProvider,
} from "../src/types.ts";
import { chunkify, decodeWav, silence, synth } from "../src/wav.ts";
import { advance, advanceStepwise, runUntilIdle, settle } from "./helpers.ts";

interface SetupOptions {
  mode?: VoiceMode;
  scripts?: FakeSttScript[];
  finalDelayMs?: number;
  sentences?: string[];
  modelDelayMs?: number;
  ttsChunks?: number;
  storeAudio?: boolean;
  audioDir?: string;
  converse?: ConverseFn;
  tts?: TtsProvider;
  sink?: AudioSink;
  clock?: SimulatedClock;
  replyMode?: ReplyMode;
}

function setup(o: SetupOptions = {}) {
  const clock = o.clock ?? new SimulatedClock(0);
  const stt = new FakeStt({
    clock,
    scripts: o.scripts ?? [
      { partials: [{ atAudioMs: 100, text: "what" }], final: "what is the status" },
    ],
    finalDelayMs: o.finalDelayMs ?? 300,
  });
  const tts = new FakeTts({
    clock,
    firstChunkLatencyMs: 200,
    chunkMs: 100,
    chunks: o.ttsChunks ?? 3,
  });
  const events: VoiceLoopEvent[] = [];
  const sentences = o.sentences ?? ["All good. ", "Two tasks ", "remain."];
  const converse: ConverseFn =
    o.converse ??
    async function* (_text, signal) {
      await clock.sleep(o.modelDelayMs ?? 500, signal);
      for (const s of sentences) yield s;
    };
  const loop = new VoiceLoop({
    stt,
    tts: o.tts ?? tts,
    mode: o.mode ?? "push_to_talk",
    converse,
    clock,
    onEvent: (e) => events.push(e),
    ...(o.sink ? { sink: o.sink } : {}),
    ...(o.storeAudio ? { storeAudio: true, sessionId: "s1" } : {}),
    ...(o.audioDir ? { audioDir: o.audioDir } : {}),
    ...(o.replyMode ? { replyMode: o.replyMode } : {}),
  });
  loop.start();
  return { clock, stt, tts, events, loop };
}

const speech = (ms: number, startMs = 0) => chunkify(synth(440, ms), 20, 16000, startMs);
const quiet = (ms: number, startMs = 0) => chunkify(silence(ms), 20, 16000, startMs);

/** Push chunks as a device delivers them: each one arrives once its audio has been captured. */
function pushRealtime(loop: VoiceLoop, clock: SimulatedClock, chunks: AudioChunk[]): void {
  for (const c of chunks) {
    clock.tickMonotonic(chunkDurationMs(c));
    loop.push(c);
  }
}

/** A paced sink that counts stop() calls. */
function countingSink(clock: SimulatedClock): AudioSink & { stops: number } {
  const sink = {
    stops: 0,
    play: (chunk: AudioChunk, signal: AbortSignal) =>
      clock.sleep(chunkDurationMs(chunk), signal).catch(() => {}),
    stop: () => {
      sink.stops++;
    },
  };
  return sink;
}

const typesOf = (events: VoiceLoopEvent[]) => events.map((e) => e.type);

/** A push-to-talk turn: 400 ms of speech, released 20 ms after the last chunk. */
function pttTurn(loop: VoiceLoop, clock: SimulatedClock): void {
  loop.pressStart();
  for (const c of speech(400)) loop.push(c);
  clock.tickMonotonic(20);
  loop.pressEnd();
}

/** Walk through the scripted delays: final transcript, model first token, first audio. */
async function throughFirstAudio(clock: SimulatedClock): Promise<void> {
  await advance(clock, 300);
  await advance(clock, 500);
  await advance(clock, 200);
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("VoiceLoop push-to-talk", () => {
  it("measures every stage and the total equals the sum of the scripted delays", async () => {
    const { clock, loop, events } = setup();
    pttTurn(loop, clock);
    expect(loop.state).toBe("transcribing");
    await throughFirstAudio(clock);
    expect(loop.state).toBe("speaking");
    expect(events.some((e) => e.type === "speaking_start")).toBe(true);
    await advanceStepwise(clock, 1500, 50);
    await loop.idle();

    const r = loop.latencies[0];
    expect(r).toMatchObject({
      turn: 1,
      endOfTurnMs: 20,
      finalTranscriptMs: 300,
      modelFirstTokenMs: 500,
      firstAudioMs: 200,
      totalToFirstAudioMs: 1020,
      withinTarget: true,
      interrupted: false,
    });
    expect(r?.ttsFirstByteMs).toBe(200);
    expect(r?.firstSentenceMs).toBe(0);
    expect(Object.values(r?.stages ?? {}).every((s) => s.withinTarget)).toBe(true);
    expect(loop.state).toBe("idle");
  });

  it("keeps the transcript with audioStored:false, emits partials, sentences and audio in order", async () => {
    const { clock, loop, events } = setup();
    pttTurn(loop, clock);
    await throughFirstAudio(clock);
    await advanceStepwise(clock, 1500, 50);
    await loop.idle();

    expect(loop.transcript).toEqual([
      {
        turn: 1,
        role: "user",
        text: "what is the status",
        at: expect.any(String),
        audioStored: false,
      },
      {
        turn: 1,
        role: "assistant",
        text: "All good. Two tasks remain.",
        at: expect.any(String),
        audioStored: false,
      },
    ]);
    expect(events.filter((e) => e.type === "transcript_partial").map((e) => e.text)).toEqual([
      "what",
    ]);
    expect(events.filter((e) => e.type === "sentence").map((e) => e.text)).toEqual([
      "All good.",
      "Two tasks remain.",
    ]);
    const audio = events.filter((e) => e.type === "audio");
    expect(audio.map((e) => e.sentenceIndex)).toEqual([0, 0, 0, 1, 1, 1]);
    const types = events.map((e) => e.type);
    expect(types.indexOf("speaking_end")).toBeLessThan(types.indexOf("turn_end"));
    expect(types.filter((t) => t === "turn_end")).toHaveLength(1);
  });

  it("with a sink that runs ahead, the turn ends only once the sink's play-head has played out", async () => {
    const clock = new SimulatedClock(0);
    const { loop, events } = setup({ clock, sink: pacedSink(clock, PACED_SINK_AHEAD_MS) });
    pttTurn(loop, clock);
    await throughFirstAudio(clock);
    const firstAudioAt = clock.monotonic();
    expect(events.some((e) => e.type === "speaking_start")).toBe(true);
    let endedAt: number | null = null;
    for (let i = 0; i < 400 && endedAt === null; i++) {
      await advance(clock, 10);
      if (events.some((e) => e.type === "speaking_end")) endedAt = clock.monotonic();
    }
    await loop.idle();
    // Two sentences of three 100 ms chunks: 600 ms of audio from the first chunk. A turn that
    // ended when the last chunk was handed over (up to the lead early) would end the window's
    // playback early too (`/speak`'s player closes its output on the end).
    const audioMs = events.filter((e) => e.type === "audio").length * 100;
    expect(audioMs).toBe(600);
    expect(endedAt).not.toBeNull();
    expect(endedAt ?? 0).toBeGreaterThanOrEqual(firstAudioAt + audioMs);
    const types = events.map((e) => e.type);
    expect(types.indexOf("speaking_end")).toBeLessThan(types.indexOf("turn_end"));
  });

  it("synthesises sentence i+1 while sentence i plays, in order", async () => {
    const { clock, loop, tts, events } = setup({ sentences: ["One. ", "Two. ", "Three."] });
    pttTurn(loop, clock);
    await throughFirstAudio(clock);
    await advanceStepwise(clock, 2000, 50);
    await loop.idle();

    expect(tts.calls.map((c) => c.text)).toEqual(["One.", "Two.", "Three."]);
    const [c0, c1, c2] = tts.calls;
    if (!c0 || !c1 || !c2) throw new Error("expected three calls");
    // sentence 1 is requested as soon as sentence 0 has been synthesised and handed to playback;
    // the fake delivers all of sentence 0's chunks at its first-chunk latency, so that is the
    // moment of its first chunk, well before sentence 0 has finished playing (300 ms)
    expect(c1.startedAtMs).toBe(c0.firstChunkAtMs);
    expect(c1.startedAtMs).toBeLessThan((c0.firstChunkAtMs ?? 0) + 300);
    // sentence 2 (prefetch 1) waits until sentence 1 is handed to playback, which happens when
    // sentence 0 has finished playing; sentence 1 was synthesised by then
    expect(c2.startedAtMs).toBe((c0.firstChunkAtMs ?? 0) + 300);
    const idx = events.filter((e) => e.type === "audio").map((e) => e.sentenceIndex);
    expect(idx).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    expect(tts.calls.every((c) => c.finished)).toBe(true);
  });

  it("with chunks arriving over time, sentence i+1 is requested once sentence i is synthesised, while it still plays", async () => {
    const clock = new SimulatedClock(0);
    const tts = new FakeTts({
      clock,
      firstChunkLatencyMs: 200,
      chunkMs: 100,
      chunks: 3,
      interChunkMs: 100,
    });
    const { loop, events } = setup({ clock, tts, sentences: ["One. ", "Two. ", "Three."] });
    pttTurn(loop, clock);
    await throughFirstAudio(clock);
    await advanceStepwise(clock, 3000, 50);
    await loop.idle();
    const [c0, c1, c2] = tts.calls;
    if (!c0 || !c1 || !c2) throw new Error("expected three calls");
    const fc0 = c0.firstChunkAtMs ?? 0;
    // sentence 0: chunks at fc0, fc0+100, fc0+200; its playback runs until fc0+300
    expect(c1.startedAtMs).toBe(fc0 + 200); // requested when sentence 0's stream completed
    expect(c1.startedAtMs).toBeLessThan(fc0 + 300); // while sentence 0 is still playing
    // sentence 1: synthesised fc0+200 .. fc0+600, handed to playback at fc0+300
    expect(c2.startedAtMs).toBe(fc0 + 600);
    const idx = events.filter((e) => e.type === "audio").map((e) => e.sentenceIndex);
    expect(idx).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  });

  it("pressing push-to-talk while the agent speaks is a barge-in", async () => {
    const { clock, loop, events, tts } = setup({
      scripts: [{ final: "first" }, { final: "second" }],
      ttsChunks: 5,
    });
    pttTurn(loop, clock);
    await throughFirstAudio(clock);
    await advance(clock, 100);
    loop.pressStart();
    expect(loop.state).toBe("listening");
    expect(loop.currentTurn).toBe(2);
    await settle();
    expect(events.find((e) => e.type === "barge_in")).toMatchObject({
      turn: 1,
      spokenText: "All good.",
    });
    const first = loop.transcript.find((e) => e.role === "assistant");
    expect(first).toMatchObject({
      turn: 1,
      text: "All good.",
      interrupted: true,
      unspokenText: "Two tasks remain.",
    });
    expect(tts.calls.some((c) => c.aborted)).toBe(true);
    for (const c of speech(200)) loop.push(c);
    loop.pressEnd();
    await throughFirstAudio(clock);
    await advanceStepwise(clock, 2000, 50);
    await loop.idle();
    expect(loop.latencies).toHaveLength(2);
    expect(loop.latencies[1]).toMatchObject({ turn: 2, withinTarget: true, interrupted: false });
    expect(loop.transcript.map((e) => `${e.turn}:${e.role}`)).toEqual([
      "1:user",
      "1:assistant",
      "2:user",
      "2:assistant",
    ]);
  });

  it("flags stages over target", async () => {
    const { clock, loop } = setup({ finalDelayMs: 600 });
    pttTurn(loop, clock);
    await advance(clock, 600);
    await advance(clock, 500);
    await advance(clock, 200);
    await advanceStepwise(clock, 1500, 50);
    await loop.idle();
    const r = loop.latencies[0];
    expect(r?.stages.finalTranscript).toEqual({ ms: 600, targetMs: 300, withinTarget: false });
    expect(r?.stages.total).toMatchObject({ ms: 1320, withinTarget: false });
    expect(r?.withinTarget).toBe(false);
  });

  it("ends the turn without a response when the transcript is empty", async () => {
    const { clock, loop, events, tts } = setup({ scripts: [{ final: "   " }] });
    pttTurn(loop, clock);
    await advance(clock, 300);
    await loop.idle();
    const end = events.find((e) => e.type === "turn_end");
    expect(end).toMatchObject({ turn: 1, entry: null });
    expect(end?.type === "turn_end" && end.latency.noResponse).toBe(true);
    expect(tts.calls).toHaveLength(0);
    expect(loop.state).toBe("idle");
  });

  it("stop() is immediate and records the interruption", async () => {
    const { clock, loop, events } = setup({ ttsChunks: 10 });
    pttTurn(loop, clock);
    await throughFirstAudio(clock);
    await loop.stop();
    expect(loop.state).toBe("idle");
    const end = events.find((e) => e.type === "turn_end");
    expect(end?.type === "turn_end" && end.latency.interrupted).toBe(true);
    loop.pressStart();
    expect(loop.state).toBe("idle"); // stopped loops ignore input until start()
    loop.start();
    loop.pressStart();
    expect(loop.state).toBe("listening");
  });

  it("logs a spoken approval with the exact transcript line", async () => {
    const { clock, loop, events } = setup({
      scripts: [{ final: "Yes, approve the twelve franc run." }],
      sentences: ["Done."],
    });
    pttTurn(loop, clock);
    await throughFirstAudio(clock);
    await advanceStepwise(clock, 800, 50);
    await loop.idle();
    const final = events.find((e) => e.type === "transcript_final");
    if (final?.type !== "transcript_final") throw new Error("no final");
    const rec = spokenApprovalRecord(final.turn, final.entry.text, clock, "start session (12 CHF)");
    expect(rec).toMatchObject({
      turn: 1,
      approved: true,
      matched: "yes",
      line: "Yes, approve the twelve franc run.",
    });
  });

  it("surfaces an STT error as an error event and returns to idle", async () => {
    const failing: SttProvider = {
      name: "failing",
      kind: "fake",
      isAvailable: async () => ({ ok: true, reason: "" }),
      start: () => {
        const queue = new AsyncQueue<SttEvent>();
        const session: SttSession = {
          push: () => {},
          endOfSpeech: () => {
            queue.push({ type: "error", code: "provider_error", message: "boom", retryable: true });
            queue.close();
          },
          events: queue,
          close: async () => queue.close(),
        };
        return session;
      },
    };
    const clock = new SimulatedClock(0);
    const events: VoiceLoopEvent[] = [];
    const loop = new VoiceLoop({
      stt: failing,
      tts: new FakeTts({ clock }),
      mode: "push_to_talk",
      converse: async function* () {
        yield "x";
      },
      clock,
      onEvent: (e) => events.push(e),
    });
    loop.start();
    loop.pressStart();
    loop.pressEnd();
    await loop.idle();
    expect(events.find((e) => e.type === "error")).toMatchObject({
      turn: 1,
      error: expect.objectContaining({ code: "provider_error", message: "boom" }),
    });
    expect(loop.state).toBe("idle");
  });

  it("a barge-in while thinking leaves no empty assistant entry", async () => {
    const { clock, loop, events } = setup({
      scripts: [{ final: "first" }, { final: "second" }],
      modelDelayMs: 500,
    });
    pttTurn(loop, clock);
    await advance(clock, 300);
    expect(loop.state).toBe("thinking");
    loop.pressStart(); // nothing generated yet
    await settle();
    expect(events.find((e) => e.type === "barge_in")).toMatchObject({ turn: 1, spokenText: "" });
    const end = events.find((e) => e.type === "turn_end");
    expect(end).toMatchObject({ turn: 1, entry: null });
    expect(end?.type === "turn_end" && end.unspokenText).toBeUndefined();
    expect(loop.transcript.map((e) => `${e.turn}:${e.role}`)).toEqual(["1:user"]);
    expect(loop.state).toBe("listening");
  });

  it("a barge-in before the first sentence keeps the generated text on turn_end only", async () => {
    const { clock, loop, events } = setup({
      scripts: [{ final: "first" }, { final: "second" }],
      converse: async function* (_t, signal) {
        yield "All good"; // no sentence end yet
        await clock.sleep(10_000, signal);
        yield ".";
      },
    });
    pttTurn(loop, clock);
    await advance(clock, 300);
    await advance(clock, 100);
    expect(loop.state).toBe("thinking");
    loop.pressStart();
    await settle();
    const end = events.find((e) => e.type === "turn_end");
    expect(end).toMatchObject({ turn: 1, entry: null, unspokenText: "All good" });
    expect(loop.transcript.filter((e) => e.role === "assistant")).toHaveLength(0);
    expect(loop.state).toBe("listening");
  });

  it("a converse() that ignores its signal cannot hold the loop after a barge-in", async () => {
    const clock0 = new SimulatedClock(0);
    const { clock, loop, events } = setup({
      ttsChunks: 10,
      converse: async function* () {
        yield "One. ";
        await clock0.sleep(60_000); // never resolves in this test
        yield "Two.";
      },
    });
    pttTurn(loop, clock);
    await advance(clock, 300);
    await advance(clock, 200); // first audio (no model delay in this converse)
    expect(loop.state).toBe("speaking");
    loop.pressStart();
    await settle();
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({ turn: 1 });
    expect(loop.state).toBe("listening");
  });

  it("stop() while transcribing calls no model and plays nothing", async () => {
    let converseCalls = 0;
    const { clock, loop, events, tts } = setup({
      converse: async function* (_t, signal) {
        converseCalls++;
        await clock.sleep(500, signal);
        yield "All good.";
      },
    });
    pttTurn(loop, clock);
    expect(loop.state).toBe("transcribing");
    await loop.stop();
    expect(loop.state).toBe("idle");
    // the scripted final (300 ms), model delay and TTS latency would all have elapsed
    await advanceStepwise(clock, 3000, 50);
    await loop.idle();
    expect(converseCalls).toBe(0);
    expect(tts.calls).toHaveLength(0);
    expect(events.filter((e) => e.type === "state").map((e) => e.state)).toEqual([
      "listening",
      "transcribing",
      "idle",
    ]);
    const end = events.find((e) => e.type === "turn_end");
    expect(end).toMatchObject({ turn: 1, entry: null });
    expect(end?.type === "turn_end" && end.latency.interrupted).toBe(true);
    expect(loop.transcript).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("push-to-talk: mic audio without a press never barges in (the press is the barge-in)", async () => {
    const { clock, loop, events } = setup({ ttsChunks: 5 });
    pttTurn(loop, clock);
    await advance(clock, 300);
    expect(loop.state).toBe("thinking");
    for (const c of speech(400, 1000)) loop.push(c); // a loud room while the model thinks
    await settle();
    expect(loop.state).toBe("thinking");
    await advance(clock, 500);
    await advance(clock, 200);
    expect(loop.state).toBe("speaking");
    for (const c of speech(400, 2000)) loop.push(c); // speaker echo without AEC, no press
    await settle();
    expect(events.some((e) => e.type === "barge_in")).toBe(false);
    expect(loop.state).toBe("speaking");
    expect(loop.currentTurn).toBe(1);
    await advanceStepwise(clock, 2000, 50);
    await loop.idle();
    expect(loop.state).toBe("idle");
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
    expect(loop.latencies).toHaveLength(1);
    expect(loop.latencies[0]).toMatchObject({ interrupted: false });
    expect(loop.transcript.map((e) => e.role)).toEqual(["user", "assistant"]);
  });

  it("unspokenText follows the sentence list when the model separates sentences with newlines", async () => {
    const { clock, loop, events } = setup({
      scripts: [{ final: "first" }, { final: "second" }],
      converse: async function* () {
        yield "All good.\n\nTwo tasks remain.\n\nThird thing. Fourth thing.";
      },
    });
    pttTurn(loop, clock);
    await advance(clock, 300); // final; the model answers at once
    await advance(clock, 200); // first audio
    expect(loop.state).toBe("speaking");
    await advance(clock, 350); // sentence 0 played (300 ms), sentence 1 is playing
    loop.pressStart();
    await settle();
    expect(events.find((e) => e.type === "barge_in")).toMatchObject({
      turn: 1,
      spokenText: "All good. Two tasks remain.",
    });
    expect(loop.transcript.find((e) => e.role === "assistant")).toMatchObject({
      text: "All good. Two tasks remain.",
      interrupted: true,
      unspokenText: "Third thing. Fourth thing.",
    });
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({
      turn: 1,
      unspokenText: "Third thing. Fourth thing.",
    });
  });

  it("a TTS slow to honour its abort cannot flip the next turn's state", async () => {
    const clock = new SimulatedClock(0);
    const silent = (timestampMs: number): AudioChunk => ({
      pcm: new Int16Array(1600),
      sampleRate: 16000,
      channels: 1,
      timestampMs,
    });
    const slow: TtsProvider = {
      name: "slow-abort",
      kind: "fake",
      isAvailable: async () => ({ ok: true, reason: "" }),
      synthesize: async function* (_text, opts) {
        await clock.sleep(200);
        yield silent(0);
        await clock.sleep(1500); // ignores the signal for 1.5 s
        if (opts?.signal?.aborted) return;
        yield silent(100);
      },
    };
    const { loop, events } = setup({
      clock,
      tts: slow,
      scripts: [{ final: "first" }, { final: "second" }],
      sentences: ["One. "],
    });
    pttTurn(loop, clock); // released at 20
    await throughFirstAudio(clock); // final 320, first token 820, first chunk 1020
    expect(loop.state).toBe("speaking");
    await advance(clock, 50);
    loop.pressStart(); // barge-in at 1070; the old TTS will only return at 2520
    for (const c of speech(200)) loop.push(c);
    clock.tickMonotonic(20);
    loop.pressEnd(); // 1090
    await advance(clock, 300); // 1390 final
    await advance(clock, 500); // 1890 first token
    await advance(clock, 200); // 2090 first chunk of turn 2
    expect(loop.state).toBe("speaking");
    expect(loop.currentTurn).toBe(2);
    expect(events.some((e) => e.type === "turn_end" && e.turn === 1)).toBe(false);
    await advance(clock, 600); // 2690: the old turn's tail has run
    expect(events.some((e) => e.type === "turn_end" && e.turn === 1)).toBe(true);
    expect(loop.state).toBe("speaking"); // turn 2 untouched
    await advanceStepwise(clock, 3000, 50);
    await loop.idle();
    expect(loop.state).toBe("idle");
    const idleAt = events.findIndex((e) => e.type === "state" && e.state === "idle");
    const turn2End = events.findIndex((e) => e.type === "turn_end" && e.turn === 2);
    expect(turn2End).toBeGreaterThan(-1);
    expect(idleAt).toBeGreaterThan(turn2End);
    expect(events.filter((e) => e.type === "state").map((e) => `${e.turn}:${e.state}`)).toEqual([
      "1:listening",
      "1:transcribing",
      "1:thinking",
      "1:speaking",
      "2:listening",
      "2:transcribing",
      "2:thinking",
      "2:speaking",
      "2:idle",
    ]);
    expect(loop.transcript.map((e) => `${e.turn}:${e.role}`)).toEqual([
      "1:user",
      "1:assistant",
      "2:user",
      "2:assistant",
    ]);
  });
});

describe("VoiceLoop open mic", () => {
  it("starts a turn on VAD speech start with pre-roll and ends it after 200 ms of silence", async () => {
    const { clock, loop, events, stt } = setup({ mode: "open_mic" });
    pushRealtime(loop, clock, speech(500));
    const start = events.find((e) => e.type === "turn_start");
    expect(start).toMatchObject({ turn: 1 });
    expect(loop.state).toBe("listening");
    pushRealtime(loop, clock, quiet(200, 500)); // the 10th silent chunk completes the hangover
    expect(loop.state).toBe("transcribing");
    // pre-roll (160 ms before speech_start) + speech + 200 ms of silence until the turn ended
    expect(stt.sessions[0]?.audioMs).toBe(700);
    await throughFirstAudio(clock);
    await advanceStepwise(clock, 1500, 50);
    await loop.idle();
    // measured on the clock: chunks delivered in real time make it exactly the 200 ms hangover
    expect(loop.latencies[0]).toMatchObject({
      endOfTurnMs: 200,
      totalToFirstAudioMs: 1200,
      withinTarget: true,
    });
    expect(loop.state).toBe("idle");
  });

  it("measures end of turn on the clock, so late chunk delivery counts", async () => {
    const { clock, loop } = setup({ mode: "open_mic" });
    pushRealtime(loop, clock, speech(500));
    const silent = quiet(200, 500);
    pushRealtime(loop, clock, silent.slice(0, 9));
    expect(loop.state).toBe("listening");
    clock.tickMonotonic(50); // the chunk that completes the hangover arrives 50 ms late
    pushRealtime(loop, clock, silent.slice(9));
    expect(loop.state).toBe("transcribing");
    await throughFirstAudio(clock);
    await advanceStepwise(clock, 1500, 50);
    await loop.idle();
    const r = loop.latencies[0];
    expect(r?.stages.endOfTurn).toEqual({ ms: 250, targetMs: 200, withinTarget: false });
    expect(r?.totalToFirstAudioMs).toBe(1250);
  });

  it("speech while the agent talks aborts TTS within one chunk and the next turn starts clean", async () => {
    const { clock, loop, events, tts } = setup({
      mode: "open_mic",
      scripts: [{ final: "tell me everything" }, { final: "stop and summarise" }],
      sentences: ["All good. ", "Two tasks remain. ", "Third thing."],
      ttsChunks: 5,
    });
    for (const c of speech(500)) loop.push(c);
    for (const c of quiet(300, 500)) loop.push(c);
    await throughFirstAudio(clock);
    await advance(clock, 100); // one chunk played, the second is playing
    expect(loop.state).toBe("speaking");

    for (const c of speech(200, 2000)) loop.push(c); // the human interrupts
    const bargeAt = events.findIndex((e) => e.type === "barge_in");
    expect(bargeAt).toBeGreaterThan(0);
    expect(events[bargeAt]).toMatchObject({ turn: 1, spokenText: "All good." });
    await settle();
    expect(events.slice(bargeAt).filter((e) => e.type === "audio" && e.turn === 1)).toHaveLength(0);
    const audioBefore = events.slice(0, bargeAt).filter((e) => e.type === "audio");
    expect(audioBefore.length).toBeLessThanOrEqual(3);
    expect(tts.calls.filter((c) => c.aborted).length).toBeGreaterThanOrEqual(1);

    expect(loop.state).toBe("listening");
    expect(loop.currentTurn).toBe(2);
    const turn1 = loop.transcript.filter((e) => e.turn === 1);
    expect(turn1[1]).toMatchObject({
      role: "assistant",
      text: "All good.",
      interrupted: true,
      unspokenText: "Two tasks remain. Third thing.",
    });

    for (const c of quiet(400, 2200)) loop.push(c);
    expect(loop.state).toBe("transcribing");
    await throughFirstAudio(clock);
    await advanceStepwise(clock, 3000, 50);
    await loop.idle();
    expect(loop.latencies).toHaveLength(2);
    expect(loop.latencies[1]).toMatchObject({ turn: 2, interrupted: false, withinTarget: true });
    const turn2 = loop.transcript.filter((e) => e.turn === 2);
    expect(turn2.map((e) => e.text)).toEqual([
      "stop and summarise",
      "All good. Two tasks remain. Third thing.",
    ]);
  });

  it("ignores audio while transcribing and does not retrigger on the agent's own silence", async () => {
    const { clock, loop, events } = setup({ mode: "open_mic" });
    for (const c of speech(500)) loop.push(c);
    for (const c of quiet(400, 500)) loop.push(c);
    for (const c of speech(200, 900)) loop.push(c); // arrives during transcribing
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
    await throughFirstAudio(clock);
    for (const c of quiet(500, 1100)) loop.push(c); // quiet room while speaking
    expect(events.some((e) => e.type === "barge_in")).toBe(false);
    await advanceStepwise(clock, 1500, 50);
    await loop.idle();
    expect(loop.latencies).toHaveLength(1);
  });
});

describe("VoiceLoop audio storage", () => {
  it("writes nothing unless storeAudio is on, then writes WAVs and a retention note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fr-voice-"));
    tmpDirs.push(dir);
    const off = setup({ audioDir: dir });
    pttTurn(off.loop, off.clock);
    await runUntilIdle(off.loop, off.clock);
    expect(await readdir(dir)).toEqual([]);
    expect(off.loop.transcript.every((e) => e.audioStored === false)).toBe(true);

    const on = setup({ storeAudio: true, audioDir: dir });
    pttTurn(on.loop, on.clock);
    await runUntilIdle(on.loop, on.clock);
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["RETENTION.md", "turn-0001-assistant.wav", "turn-0001-user.wav"]);
    const user = decodeWav(await readFile(join(dir, "turn-0001-user.wav")));
    expect(user.sampleRate).toBe(16000);
    expect(user.pcm.length).toBe(6400); // 400 ms
    const assistant = decodeWav(await readFile(join(dir, "turn-0001-assistant.wav")));
    expect(assistant.pcm.length).toBe(6 * 1600); // 2 sentences x 3 chunks x 100 ms
    expect(on.loop.transcript.map((e) => e.audioStored)).toEqual([true, true]);
    expect(on.loop.transcript[0]?.audioFile).toBe(join(dir, "turn-0001-user.wav"));
    expect(await readFile(join(dir, "RETENTION.md"), "utf8")).toContain(
      "Delete this folder at any",
    );
  });
});

describe("VoiceLoop failures", () => {
  it("a converse() that throws while audio plays aborts playback before turn_end and goes idle", async () => {
    const clock = new SimulatedClock(0);
    const sink = countingSink(clock);
    // one chunk every 100 ms, so the sentence is still being synthesised when the model dies
    const tts = new FakeTts({
      clock,
      firstChunkLatencyMs: 200,
      chunkMs: 100,
      chunks: 5,
      interChunkMs: 100,
    });
    const { loop, events } = setup({
      clock,
      sink,
      tts,
      converse: async function* () {
        yield "All good. ";
        await clock.sleep(350); // a budget hook kills the model call mid-stream
        throw new ForerunnerError("budget_exceeded", "voice budget spent");
      },
    });
    pttTurn(loop, clock);
    await advance(clock, 300); // final transcript
    await advance(clock, 200); // first audio (no model delay)
    expect(loop.state).toBe("speaking");
    await advance(clock, 200); // converse throws at 650 while chunks 2..5 are still pending
    await settle();

    const types = typesOf(events);
    const endIdx = types.indexOf("turn_end");
    expect(types.indexOf("error")).toBeGreaterThan(-1);
    expect(types.indexOf("error")).toBeLessThan(endIdx);
    expect(events.find((e) => e.type === "error")).toMatchObject({
      turn: 1,
      error: expect.objectContaining({ code: "budget_exceeded" }),
    });
    expect(loop.state).toBe("idle");
    expect(sink.stops).toBe(1);
    expect(tts.calls.map((c) => c.aborted)).toEqual([true]); // synthesis cut off mid-sentence
    // after turn_end only the idle transition follows, even once time moves on
    await advanceStepwise(clock, 2000, 50);
    expect(events.slice(endIdx + 1).filter((e) => e.turn === 1)).toEqual([
      { type: "state", state: "idle", turn: 1 },
    ]);
    expect(loop.state).toBe("idle");
    // the person heard the first sentence only
    expect(loop.transcript.find((e) => e.role === "assistant")).toMatchObject({
      text: "All good.",
      interrupted: true,
      unspokenText: "",
    });
    expect(loop.latencies[0]).toMatchObject({ interrupted: false, firstAudioMs: 200 });
    // the next turn starts clean
    loop.pressStart();
    expect(loop.state).toBe("listening");
    expect(loop.currentTurn).toBe(2);
  });

  it("a converse() that throws before any audio never lets a late chunk flip the state", async () => {
    const { clock, loop, events, tts } = setup({
      ttsChunks: 5,
      converse: async function* () {
        yield "All good. ";
        throw new Error("model gone");
      },
    });
    pttTurn(loop, clock);
    await advance(clock, 300);
    await settle();
    expect(loop.state).toBe("idle");
    const states = events.filter((e) => e.type === "state").map((e) => e.state);
    expect(states).toEqual(["listening", "transcribing", "thinking", "idle"]);
    await advanceStepwise(clock, 1500, 50); // the TTS first-chunk delay would have elapsed
    expect(events.filter((e) => e.type === "audio")).toHaveLength(0);
    expect(events.filter((e) => e.type === "state").map((e) => e.state)).toEqual(states);
    expect(loop.state).toBe("idle");
    expect(tts.calls.map((c) => c.aborted)).toEqual([true]);
    const end = events.find((e) => e.type === "turn_end");
    expect(end).toMatchObject({ turn: 1, entry: null, unspokenText: "All good." });
    expect(events.find((e) => e.type === "error")).toMatchObject({
      error: expect.objectContaining({ code: "provider_error", message: "model gone" }),
    });
  });

  it("a failing TTS aborts the model stream instead of letting it run on", async () => {
    const failing: TtsProvider = {
      name: "failing-tts",
      kind: "fake",
      isAvailable: async () => ({ ok: true, reason: "" }),
      synthesize: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            Promise.reject(new ForerunnerError("provider_error", "tts down", { retryable: true })),
        }),
      }),
    };
    let pulled = 0;
    let seen: AbortSignal | null = null;
    const clock = new SimulatedClock(0);
    const { loop, events } = setup({
      clock,
      tts: failing,
      converse: async function* (_t, signal) {
        seen = signal;
        for (let i = 0; i < 16; i++) {
          pulled++;
          yield `Sentence ${i}. `;
          await clock.sleep(100); // ignores the signal on purpose
        }
      },
    });
    pttTurn(loop, clock);
    await advance(clock, 300);
    await settle();
    expect(events.find((e) => e.type === "error")).toMatchObject({
      turn: 1,
      error: expect.objectContaining({ code: "provider_error", message: "tts down" }),
    });
    expect(loop.state).toBe("idle");
    const signal = seen as AbortSignal | null;
    expect(signal?.aborted).toBe(true);
    const deltasAtError = events.filter((e) => e.type === "model_delta").length;
    expect(deltasAtError).toBe(1);
    await advanceStepwise(clock, 2000, 50);
    // the generator is released at its next yield; no delta of the dead turn is emitted
    expect(events.filter((e) => e.type === "model_delta")).toHaveLength(deltasAtError);
    expect(pulled).toBeLessThanOrEqual(2);
    expect(clock.pendingTimers()).toBe(0);
    expect(loop.transcript.filter((e) => e.role === "assistant")).toHaveLength(0);
  });
});

describe("VoiceLoop reply text", () => {
  it("voice replies: each sentence's text is out before its first audio, the deltas before that", async () => {
    const { clock, loop, events } = setup();
    pttTurn(loop, clock);
    await throughFirstAudio(clock);
    await advanceStepwise(clock, 1500, 50);
    await loop.idle();
    const types = typesOf(events);
    for (const index of [0, 1]) {
      const sentenceAt = events.findIndex((e) => e.type === "sentence" && e.index === index);
      const audioAt = events.findIndex((e) => e.type === "audio" && e.sentenceIndex === index);
      expect(sentenceAt).toBeGreaterThan(-1);
      expect(sentenceAt).toBeLessThan(audioAt);
    }
    expect(types.indexOf("model_delta")).toBeLessThan(types.indexOf("sentence"));
    expect(events.find((e) => e.type === "transcript_final")).toMatchObject({
      turn: 1,
      text: "what is the status",
    });
    expect(types.indexOf("transcript_final")).toBeLessThan(types.indexOf("model_delta"));
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({ replyMode: "voice" });
  });
});

describe("VoiceLoop text replies (replyMode: text)", () => {
  it("streams the reply as text with no TTS and no audio, and ends the turn when the text is complete", async () => {
    const { clock, loop, events, tts } = setup({ replyMode: "text" });
    expect(loop.replyMode).toBe("text");
    pttTurn(loop, clock);
    await advance(clock, 300); // final transcript
    await advance(clock, 500); // the model's reply, all at once
    await settle();
    await loop.idle();
    expect(loop.state).toBe("idle");
    expect(tts.calls).toHaveLength(0);
    const types = typesOf(events);
    expect(types).not.toContain("audio");
    expect(types).not.toContain("speaking_start");
    expect(types).not.toContain("speaking_end");
    expect(
      events.filter((e) => e.type === "state").map((e) => (e.type === "state" ? e.state : "")),
    ).toEqual(["listening", "transcribing", "thinking", "idle"]);
    expect(events.filter((e) => e.type === "model_delta").map((e) => e.text)).toEqual([
      "All good. ",
      "Two tasks ",
      "remain.",
    ]);
    expect(events.filter((e) => e.type === "sentence").map((e) => e.text)).toEqual([
      "All good.",
      "Two tasks remain.",
    ]);
    const end = events.find((e) => e.type === "turn_end");
    expect(end).toMatchObject({
      turn: 1,
      replyMode: "text",
      entry: { role: "assistant", text: "All good. Two tasks remain." },
    });
    expect(end?.type === "turn_end" && end.unspokenText).toBeUndefined();
    const r = loop.latencies[0];
    expect(r).toMatchObject({
      modelFirstTokenMs: 500,
      firstAudioMs: null,
      totalToFirstAudioMs: null,
      ttsFirstByteMs: null,
      interrupted: false,
      noResponse: false,
    });
    // Nothing waits on a TTS or a sink: the turn ended the moment the text did.
    expect(clock.pendingTimers()).toBe(0);
  });

  it("a press while the text streams stops generation, as a typed stop does: the shown text is kept", async () => {
    let seen: AbortSignal | null = null;
    const { clock, loop, events, tts } = setup({
      replyMode: "text",
      scripts: [{ final: "first" }, { final: "second" }],
      converse: async function* (_t, signal) {
        seen = signal;
        yield "All good. ";
        yield "Two tasks";
        await clock.sleep(10_000, signal);
        yield " remain.";
      },
    });
    pttTurn(loop, clock);
    await advance(clock, 300);
    await settle();
    expect(loop.state).toBe("thinking");
    loop.pressStart();
    await settle();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    expect(events.find((e) => e.type === "barge_in")).toMatchObject({ turn: 1 });
    const end = events.find((e) => e.type === "turn_end");
    expect(end).toMatchObject({
      turn: 1,
      replyMode: "text",
      entry: { role: "assistant", text: "All good. Two tasks", interrupted: true },
    });
    // Nothing was to be spoken: no unspoken part, on the entry or the event.
    expect(end?.type === "turn_end" && end.unspokenText).toBeUndefined();
    expect(end?.type === "turn_end" && end.entry?.unspokenText).toBeUndefined();
    expect(end?.type === "turn_end" && end.latency.interrupted).toBe(true);
    expect(tts.calls).toHaveLength(0);
    expect(loop.state).toBe("listening");
  });

  it("setReplyMode applies from the next reply: a voice turn, then a text turn", async () => {
    const { clock, loop, events, tts } = setup({
      scripts: [{ final: "first" }, { final: "second" }],
    });
    expect(loop.replyMode).toBe("voice");
    pttTurn(loop, clock);
    await throughFirstAudio(clock);
    // Switching while a voice reply plays leaves that reply alone.
    loop.setReplyMode("text");
    await runUntilIdle(loop, clock);
    const callsAfterFirst = tts.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    pttTurn(loop, clock);
    await runUntilIdle(loop, clock);
    expect(tts.calls).toHaveLength(callsAfterFirst);
    const ends = events.filter((e) => e.type === "turn_end");
    expect(ends.map((e) => (e.type === "turn_end" ? e.replyMode : null))).toEqual([
      "voice",
      "text",
    ]);
    expect(events.filter((e) => e.type === "audio" && e.turn === 2)).toHaveLength(0);
  });

  it("a turn keeps the mode it started with: a switch during the capture applies to the next turn", async () => {
    const { clock, loop, events, tts } = setup({
      scripts: [{ final: "first" }, { final: "" }],
    });
    loop.pressStart();
    expect(events.find((e) => e.type === "turn_start")).toMatchObject({
      turn: 1,
      replyMode: "voice",
    });
    loop.setReplyMode("text"); // while the human still speaks
    for (const c of speech(400)) loop.push(c);
    clock.tickMonotonic(20);
    loop.pressEnd();
    await runUntilIdle(loop, clock);
    expect(tts.calls.length).toBeGreaterThan(0);
    const firstEnd = events.find((e) => e.type === "turn_end" && e.turn === 1);
    expect(firstEnd).toMatchObject({ replyMode: "voice" });
    // An empty transcript (no reply at all) reports the mode its turn started with, not the
    // mode in force when it ended.
    loop.pressStart();
    expect(events.filter((e) => e.type === "turn_start").at(-1)).toMatchObject({
      turn: 2,
      replyMode: "text",
    });
    loop.setReplyMode("voice");
    clock.tickMonotonic(20);
    loop.pressEnd();
    await runUntilIdle(loop, clock);
    expect(events.find((e) => e.type === "turn_end" && e.turn === 2)).toMatchObject({
      replyMode: "text",
      entry: null,
    });
  });
});
