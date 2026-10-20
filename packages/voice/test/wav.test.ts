import { describe, expect, it } from "vitest";
import { toInt16 } from "../src/types.ts";
import {
  bytesToPcm,
  chunkify,
  decodeWav,
  downmix,
  encodeWav,
  pcmBytes,
  resample,
  silence,
  synth,
  toMono16,
} from "../src/wav.ts";

describe("wav", () => {
  it("round-trips PCM through WAV", () => {
    const pcm = synth(440, 50, 16000, 0.8);
    const file = encodeWav(pcm, 16000, 1);
    expect(file.toString("ascii", 0, 4)).toBe("RIFF");
    expect(file.length).toBe(44 + pcm.length * 2);
    const decoded = decodeWav(file);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toBe(1);
    expect(Array.from(decoded.pcm)).toEqual(Array.from(pcm));
  });

  it("rejects non-WAV input with a validation error", () => {
    expect(() => decodeWav(Buffer.from("not a wav file at all"))).toThrow(/RIFF/);
    const bad = encodeWav(silence(10), 16000);
    bad.writeUInt16LE(3, 20); // float format
    expect(() => decodeWav(bad)).toThrow(/16-bit PCM/);
  });

  it("generates tones and silence of the right length", () => {
    expect(synth(440, 100, 16000).length).toBe(1600);
    expect(silence(250, 8000).length).toBe(2000);
    expect(Math.max(...synth(440, 10, 16000, 0.5))).toBeLessThanOrEqual(16384);
    expect(silence(10).every((s) => s === 0)).toBe(true);
  });

  it("chunkifies with running timestamps", () => {
    const chunks = chunkify(synth(440, 55), 20, 16000, 1000);
    expect(chunks.map((c) => c.timestampMs)).toEqual([1000, 1020, 1040]);
    expect(toInt16(chunks[2]?.pcm ?? new Int16Array()).length).toBe(240);
  });

  it("resamples and downmixes", () => {
    const at48 = synth(440, 100, 48000);
    const at16 = resample(at48, 48000, 16000);
    expect(at16.length).toBe(1600);
    const stereo = new Int16Array([100, 300, -200, -400]);
    expect(Array.from(downmix(stereo, 2))).toEqual([200, -300]);
    const mono = toMono16({ pcm: at48, sampleRate: 48000, channels: 1, timestampMs: 0 });
    expect(mono.length).toBe(1600);
  });

  it("converts between Int16Array and little-endian bytes, tolerating odd offsets", () => {
    const pcm = new Int16Array([1, -1, 32767, -32768]);
    const bytes = pcmBytes(pcm);
    expect(bytes.length).toBe(8);
    expect(Array.from(bytesToPcm(bytes))).toEqual([1, -1, 32767, -32768]);
    const shifted = Buffer.concat([Buffer.from([0]), bytes]).subarray(1);
    expect(Array.from(toInt16(shifted))).toEqual([1, -1, 32767, -32768]);
  });
});
