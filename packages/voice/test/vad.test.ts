import { describe, expect, it } from "vitest";
import type { VadEvent } from "../src/types.ts";
import { EnergyVad } from "../src/vad.ts";
import { chunkify, concatPcm, noise, silence, synth } from "../src/wav.ts";

function runVad(pcm: Int16Array, frameMs: number, vad = new EnergyVad()): VadEvent[] {
  const out: VadEvent[] = [];
  for (const c of chunkify(pcm, frameMs)) out.push(...vad.push(c));
  return out;
}

describe("EnergyVad", () => {
  it("detects a tone burst followed by silence as one turn with the 200 ms hangover", () => {
    const pcm = concatPcm(silence(100), synth(440, 500), silence(400));
    const events = runVad(pcm, 20);
    expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
    const [start, end] = events as [VadEvent, VadEvent];
    expect(start.atMs).toBe(100);
    if (end.type !== "speech_end") throw new Error("expected speech_end");
    expect(end.atMs).toBe(600);
    expect(end.endOfTurnMs).toBe(200);
    expect(end.speechMs).toBe(500);
  });

  it("ignores bursts shorter than the 150 ms minimum", () => {
    const pcm = concatPcm(silence(100), synth(440, 100), silence(400));
    expect(runVad(pcm, 20)).toEqual([]);
  });

  it("treats quiet room noise as silence", () => {
    const pcm = concatPcm(noise(600), synth(440, 300), noise(400));
    const events = runVad(pcm, 20);
    expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
  });

  it("is deterministic and independent of the chunk size", () => {
    const pcm = concatPcm(
      silence(60),
      synth(300, 420),
      silence(130),
      synth(300, 200),
      silence(500),
    );
    const a = runVad(pcm, 10);
    const b = runVad(pcm, 100);
    const c = runVad(pcm, 37);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
  });

  it("does not end the turn on a pause shorter than the hangover", () => {
    const pcm = concatPcm(synth(440, 300), silence(150), synth(440, 300), silence(400));
    const events = runVad(pcm, 20);
    expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
    const end = events[1];
    if (end?.type !== "speech_end") throw new Error("expected speech_end");
    // speech ends at 750 ms; the 740-760 frame is still loud, so the detector reports 760
    expect(end.atMs).toBe(760);
    expect(end.speechMs).toBe(760);
  });

  it("honours a custom end-of-turn silence and reset()", () => {
    const vad = new EnergyVad({ endOfTurnSilenceMs: 400 });
    const pcm = concatPcm(synth(440, 300), silence(300));
    expect(runVad(pcm, 20, vad).map((e) => e.type)).toEqual(["speech_start"]);
    expect(vad.speaking).toBe(true);
    vad.reset();
    expect(vad.speaking).toBe(false);
    const after = runVad(concatPcm(silence(500)), 20, vad);
    expect(after).toEqual([]);
  });

  it("rejects high zero-crossing noise even when loud", () => {
    // A 7 kHz tone at 16 kHz crosses zero ~0.875 times per sample: above zcrMax.
    const pcm = concatPcm(synth(7000, 400, 16000, 0.9), silence(400));
    expect(runVad(pcm, 20)).toEqual([]);
  });

  it("downmixes stereo input", () => {
    const mono = concatPcm(silence(100), synth(440, 300), silence(400));
    const stereo = new Int16Array(mono.length * 2);
    for (let i = 0; i < mono.length; i++) {
      stereo[i * 2] = mono[i] ?? 0;
      stereo[i * 2 + 1] = mono[i] ?? 0;
    }
    const vad = new EnergyVad();
    const events: VadEvent[] = [];
    for (const c of chunkify(stereo, 20, 16000, 0, 2)) events.push(...vad.push(c));
    expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
  });
});
