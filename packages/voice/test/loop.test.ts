import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { spokenApprovalRecord } from "../src/approval.ts";
import { type ConverseFn, VoiceLoop, type VoiceLoopEvent, type VoiceMode } from "../src/loop.ts";
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

  it("synthesises sentence i+1 while sentence i plays, in order", async () => {
    const { clock, loop, tts, events } = setup({ sentences: ["One. ", "Two. ", "Three."] });
    pttTurn(loop, clock);
    await throughFirstAudio(clock);
    await advanceStepwise(clock, 2000, 50);
    await loop.idle();

    expect(tts.calls.map((c) => c.text)).toEqual(["One.", "Two.", "Three."]);
    const [c0, c1, c2] = tts.calls;
    if (!c0 || !c1 || !c2) throw new Error("expected three calls");
    // sentence 1 is requested the moment sentence 0 starts playing, before it has finished
    expect(c1.startedAtMs).toBe(c0.firstChunkAtMs);
    expect(c1.startedAtMs).toBeLessThan((c0.firstChunkAtMs ?? 0) + 300);
    // sentence 2 waits until sentence 1 starts playing (after sentence 0's 300 ms)
    expect(c2.startedAtMs).toBe((c0.firstChunkAtMs ?? 0) + 300);
    const idx = events.filter((e) => e.type === "audio").map((e) => e.sentenceIndex);
    expect(idx).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    expect(tts.calls.every((c) => c.finished)).toBe(true);
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
