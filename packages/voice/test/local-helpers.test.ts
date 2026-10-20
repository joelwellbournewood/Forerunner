import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, log, SimulatedClock } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FasterWhisperStt } from "../src/providers/local/faster-whisper.ts";
import { HelperProcess } from "../src/providers/local/helper-process.ts";
import { KokoroTts } from "../src/providers/local/kokoro.ts";
import { PiperTts } from "../src/providers/local/piper.ts";
import type { AudioChunk, SttEvent } from "../src/types.ts";
import { chunkify, synth } from "../src/wav.ts";
import { fixture, settle } from "./helpers.ts";

// The Python helpers are replaced by node scripts that speak the same protocol, so the
// Node side (framing, process lifetime, cancellation) is tested on every machine.
const node = process.execPath;

describe("FasterWhisperStt over the helper protocol", () => {
  const stt = new FasterWhisperStt({ python: node, helperPath: fixture("fake_stt_helper.mjs") });
  afterAll(() => stt.dispose());

  it("streams partial then final transcripts for an utterance and reuses the process", async () => {
    const events: SttEvent[] = [];
    const session = stt.start({ sampleRate: 16000 });
    for (const c of chunkify(synth(440, 200), 20)) session.push(c);
    session.endOfSpeech();
    for await (const e of session.events) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["partial", "final"]);
    // 200 ms at 16 kHz mono = 6400 bytes, the helper echoes the byte count
    expect(events[1]).toMatchObject({ type: "final", text: "hello world 6400", language: "en" });

    const second = stt.start({ sampleRate: 48000 });
    for (const c of chunkify(synth(440, 100, 48000), 20, 48000)) second.push(c);
    second.endOfSpeech();
    const finals: SttEvent[] = [];
    for await (const e of second.events) if (e.type === "final") finals.push(e);
    // 48 kHz input is resampled to 16 kHz before it reaches the helper: 100 ms = 3200 bytes
    expect(finals[0]).toMatchObject({ text: "hello world 3200" });
  });

  it("reports a helper that exits before ready as unavailable", async () => {
    const broken = new FasterWhisperStt({
      python: node,
      helperPath: fixture("no-such-helper.mjs"),
      readyTimeoutMs: 5000,
    });
    const session = broken.start({ sampleRate: 16000 });
    const events: SttEvent[] = [];
    for await (const e of session.events) events.push(e);
    expect(events[0]?.type).toBe("error");
    await broken.dispose();
  });
});

describe("KokoroTts over the helper protocol", () => {
  const tts = new KokoroTts({ python: node, helperPath: fixture("fake_tts_helper.mjs") });
  afterAll(() => tts.dispose());

  it("yields PCM chunks at the helper's sample rate and serves requests in order", async () => {
    const chunks: AudioChunk[] = [];
    for await (const c of tts.synthesize("Hello there.")) chunks.push(c);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ sampleRate: 24000, channels: 1, timestampMs: 0 });
    expect(chunks[2]?.timestampMs).toBe(200);
    expect(tts.outputSampleRate).toBe(24000);
    const again: AudioChunk[] = [];
    for await (const c of tts.synthesize("Second.")) again.push(c);
    expect(again).toHaveLength(3);
  });

  it("surfaces helper errors as provider_error", async () => {
    await expect(
      (async () => {
        for await (const _c of tts.synthesize("FAIL")) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("stops on abort and sends a cancel frame", async () => {
    const ac = new AbortController();
    ac.abort();
    const chunks: AudioChunk[] = [];
    for await (const c of tts.synthesize("Never.", { signal: ac.signal })) chunks.push(c);
    expect(chunks).toHaveLength(0);
    // an already-cancelled sentence (barge-in while it was queued) leaves no request behind
    expect(tts.pendingRequests).toBe(0);
  });
});

describe("HelperProcess", () => {
  it("kills a helper that ignores stdin closing once the grace period on the Clock elapses", async () => {
    const clock = new SimulatedClock(0);
    let exited = false;
    const proc = new HelperProcess({
      argv: [node, fixture("stubborn_helper.mjs")],
      clock,
      log: log("voice:test"),
      onStdout: () => {},
      onExit: () => {
        exited = true;
      },
    });
    const stopped = proc.stop(undefined, 2000);
    await settle(20);
    expect(proc.alive).toBe(true); // stdin closed, helper still running
    await clock.advance(1999);
    await settle(20);
    expect(proc.alive).toBe(true); // grace period not over
    await clock.advance(1); // kill fires on the simulated clock, not on real time
    // Without the Clock the kill would wait 2 s of real time; the bound below is shorter.
    await Promise.race([stopped, new Promise<void>((r) => setTimeout(r, 1500))]);
    expect(proc.alive).toBe(false);
    expect(exited).toBe(true);
  });
});

describe("PiperTts over a stand-in binary", () => {
  let dir: string;
  let model: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fr-piper-"));
    model = join(dir, "voice.onnx");
    await writeFile(model, "not a real model");
    await writeFile(`${model}.json`, JSON.stringify({ audio: { sample_rate: 22050 } }));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("probes the binary and model, then streams raw PCM from stdout", async () => {
    const tts = new PiperTts({
      binary: node,
      argvPrefix: [fixture("fake_piper.mjs")],
      modelPath: model,
    });
    expect((await tts.isAvailable()).ok).toBe(true);
    const chunks: AudioChunk[] = [];
    for await (const c of tts.synthesize("Hello world")) chunks.push(c);
    // 11 characters * 50 ms = 550 ms at 22050 Hz in ~100 ms chunks
    const total = chunks.reduce((n, c) => n + c.pcm.length, 0);
    expect(total).toBe(Math.round(22050 * 0.05 * 11));
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks[0]).toMatchObject({ sampleRate: 22050, channels: 1 });
  });

  it("fails with provider_error when the binary exits non-zero", async () => {
    const tts = new PiperTts({
      binary: node,
      argvPrefix: [fixture("fake_piper.mjs")],
      modelPath: join(dir, "missing.onnx"),
    });
    await expect(
      (async () => {
        for await (const _c of tts.synthesize("x")) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ code: "provider_error" });
  });
});
