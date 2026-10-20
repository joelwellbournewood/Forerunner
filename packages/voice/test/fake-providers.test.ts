import { SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { FakeStt, FakeTts, ScriptedVad } from "../src/providers/fake.ts";
import type { AudioChunk, SttEvent } from "../src/types.ts";
import { chunkify, synth } from "../src/wav.ts";
import { advance, settle } from "./helpers.ts";

describe("FakeStt", () => {
  it("emits partials as audio accumulates and the final after the scripted delay", async () => {
    const clock = new SimulatedClock(0);
    const stt = new FakeStt({
      clock,
      scripts: [
        {
          partials: [
            { atAudioMs: 100, text: "what" },
            { atAudioMs: 300, text: "what is the" },
          ],
          final: "what is the status",
          finalDelayMs: 250,
        },
      ],
    });
    const session = stt.start({ sampleRate: 16000 });
    const events: SttEvent[] = [];
    const consumer = (async () => {
      for await (const e of session.events) events.push(e);
    })();
    for (const c of chunkify(synth(440, 400), 50)) session.push(c);
    await settle();
    expect(events.map((e) => e.type)).toEqual(["partial", "partial"]);
    clock.tickMonotonic(10);
    session.endOfSpeech();
    await advance(clock, 249);
    expect(events).toHaveLength(2);
    await advance(clock, 1);
    await consumer;
    expect(events[2]).toMatchObject({ type: "final", text: "what is the status", atMs: 260 });
    expect(session.audioMs).toBe(400);
  });

  it("uses one script per session and repeats the last one", async () => {
    const clock = new SimulatedClock(0);
    const stt = new FakeStt({
      clock,
      scripts: [{ final: "one" }, { final: "two" }],
      finalDelayMs: 0,
    });
    const finals: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = stt.start({ sampleRate: 16000 });
      s.endOfSpeech();
      for await (const e of s.events) if (e.type === "final") finals.push(e.text);
    }
    expect(finals).toEqual(["one", "two", "two"]);
  });

  it("close() cancels a pending final", async () => {
    const clock = new SimulatedClock(0);
    const stt = new FakeStt({ clock, scripts: [{ final: "late" }], finalDelayMs: 500 });
    const s = stt.start({ sampleRate: 16000 });
    s.endOfSpeech();
    await s.close();
    const events: SttEvent[] = [];
    for await (const e of s.events) events.push(e);
    expect(events).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe("FakeTts", () => {
  it("delivers the first chunk after the scripted latency, then the rest", async () => {
    const clock = new SimulatedClock(0);
    const tts = new FakeTts({ clock, firstChunkLatencyMs: 150, chunkMs: 100, chunks: 3 });
    const chunks: AudioChunk[] = [];
    const run = (async () => {
      for await (const c of tts.synthesize("Hello.")) chunks.push(c);
    })();
    await advance(clock, 149);
    expect(chunks).toHaveLength(0);
    await advance(clock, 1);
    await run;
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.timestampMs)).toEqual([0, 100, 200]);
    expect(tts.calls[0]).toMatchObject({
      text: "Hello.",
      firstChunkAtMs: 150,
      chunks: 3,
      finished: true,
    });
  });

  it("stops on abort and records it", async () => {
    const clock = new SimulatedClock(0);
    const tts = new FakeTts({ clock, firstChunkLatencyMs: 100, interChunkMs: 50, chunks: 5 });
    const ac = new AbortController();
    const chunks: AudioChunk[] = [];
    const run = (async () => {
      for await (const c of tts.synthesize("Long sentence.", { signal: ac.signal })) chunks.push(c);
    })();
    await advance(clock, 100);
    expect(chunks).toHaveLength(1);
    ac.abort();
    await run;
    expect(chunks).toHaveLength(1);
    expect(tts.calls[0]?.aborted).toBe(true);
    expect(tts.calls[0]?.finished).toBe(false);
  });
});

describe("ScriptedVad", () => {
  it("returns the queued events per push", () => {
    const vad = new ScriptedVad();
    vad.enqueue([], [{ type: "speech_start", atMs: 20 }]);
    const chunk: AudioChunk = {
      pcm: new Int16Array(160),
      sampleRate: 16000,
      channels: 1,
      timestampMs: 0,
    };
    expect(vad.push(chunk)).toEqual([]);
    expect(vad.push(chunk)).toEqual([{ type: "speech_start", atMs: 20 }]);
    expect(vad.speaking).toBe(true);
    expect(vad.push(chunk)).toEqual([]);
  });
});
