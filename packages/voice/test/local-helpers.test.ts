import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, Logger, log, SimulatedClock } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FasterWhisperStt, HelperMessageSchema } from "../src/providers/local/faster-whisper.ts";
import { describeHelperExit, HelperProcess } from "../src/providers/local/helper-process.ts";
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

/**
 * The real-audio run of 2026-10-26: fr_stt.py died mid-transcription with exit code 3221225477
 * (0xC0000005, an access violation inside faster-whisper on Windows, CPU int8, under heavy CPU
 * load) and the turn failed with the human's speech lost. One crash now costs nothing the human
 * notices: the helper is restarted and the utterance's audio, still in memory, is sent again.
 */
describe("FasterWhisperStt when the helper crashes mid-transcription", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fr-stt-crash-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const crashing = (name: string, times: number, extra: string[] = [], readyTimeoutMs?: number) =>
    new FasterWhisperStt({
      python: node,
      helperPath: fixture("crashing_stt_helper.mjs"),
      extraArgs: ["--crash-file", join(dir, name), "--crash-times", String(times), ...extra],
      ...(readyTimeoutMs !== undefined ? { readyTimeoutMs } : {}),
    });
  /** Wait in real time (the helper is a real process) until `cond` holds, at most `ms`. */
  const waitFor = async (cond: () => boolean, ms = 5000) => {
    for (let waited = 0; !cond() && waited < ms; waited += 20)
      await new Promise<void>((r) => setTimeout(r, 20));
    expect(cond()).toBe(true);
  };
  const utterance = async (stt: FasterWhisperStt) => {
    const events: SttEvent[] = [];
    const session = stt.start({ sampleRate: 16000 });
    for (const c of chunkify(synth(440, 200), 20)) session.push(c);
    session.endOfSpeech();
    for await (const e of session.events) events.push(e);
    return events;
  };
  const captured = async <T>(fn: () => Promise<T>) => {
    const lines: string[] = [];
    const off = Logger.addSink((rec) => {
      if (rec.scope === "voice:faster-whisper")
        lines.push(`${rec.level} ${rec.msg} ${JSON.stringify(rec.data ?? {})}`);
    });
    try {
      return { result: await fn(), lines };
    } finally {
      off();
    }
  };

  it("restarts the helper and retries the utterance's audio once: the turn gets its final", async () => {
    const stt = crashing("once", 1);
    try {
      const { result: events, lines } = await captured(() => utterance(stt));
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      // The whole utterance reached the new helper: 200 ms at 16 kHz mono = 6400 bytes.
      expect(events.at(-1)).toMatchObject({ type: "final", text: "hello world 6400" });
      // The crash is logged as a warning with the exit code in hex and a plain cause.
      const crash = lines.find((l) => l.includes("retrying the utterance"));
      expect(crash).toBeDefined();
      expect(crash).toMatch(/^warn /);
      expect(crash).toContain("0x00000046");
      expect(crash).toMatch(/"cause":"[^"]+"/);
      // The restarted helper serves the next utterance as usual.
      const next = await utterance(stt);
      expect(next.at(-1)).toMatchObject({ type: "final", text: "hello world 6400" });
    } finally {
      await stt.dispose();
    }
  });

  it("retries a crash in the middle of the audio, before the end of speech, with all of the audio", async () => {
    const stt = crashing("mid-audio", 1, ["--crash-at", "audio"]);
    let retried = false;
    const off = Logger.addSink((rec) => {
      if (rec.msg.includes("retrying the utterance")) retried = true;
    });
    try {
      const events: SttEvent[] = [];
      const session = stt.start({ sampleRate: 16000 });
      const chunks = chunkify(synth(440, 200), 20);
      for (const c of chunks.slice(0, 4)) session.push(c);
      // The helper dies on the first audio frame; the human is still talking.
      await waitFor(() => retried);
      for (const c of chunks.slice(4)) session.push(c);
      session.endOfSpeech();
      for await (const e of session.events) events.push(e);
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "final", text: "hello world 6400" });
    } finally {
      off();
      await stt.dispose();
    }
  });

  it("a helper that dies in the middle of a stdout line does not garble the new helper's lines", async () => {
    // Without a fresh line reader the half line glues onto the new helper's ready line, which
    // no longer parses, and the retry waits out the ready timeout.
    const stt = crashing("half-line", 1, ["--partial-line"], 3000);
    try {
      const events = await utterance(stt);
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "final", text: "hello world 6400" });
    } finally {
      await stt.dispose();
    }
  }, 10_000);

  it("the exit of a helper already let go only logs: the next utterance on a new helper is untouched", async () => {
    const stt = new FasterWhisperStt({ python: node, helperPath: fixture("fake_stt_helper.mjs") });
    try {
      const first = stt.start({ sampleRate: 16000 });
      for (const c of chunkify(synth(440, 100), 20)) first.push(c);
      const firstEvents: SttEvent[] = [];
      const it = first.events[Symbol.asyncIterator]();
      const partial = await it.next();
      expect(partial.value).toMatchObject({ type: "partial" });
      // The old helper is stopped and a new utterance starts before its exit arrives.
      const disposing = stt.dispose();
      const events = await utterance(stt);
      await disposing;
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "final", text: "hello world 6400" });
      // The utterance the provider let go of ended; it is not left waiting.
      for (let r = await it.next(); !r.done; r = await it.next()) firstEvents.push(r.value);
      expect(firstEvents.some((e) => e.type === "final")).toBe(false);
    } finally {
      await stt.dispose();
    }
  });

  it("fails the utterance only when the retry crashes too, naming the exit code in hex", async () => {
    const stt = crashing("twice", 2);
    try {
      const events = await utterance(stt);
      const errors = events.filter((e) => e.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: "provider_error", retryable: true });
      const message = errors[0]?.type === "error" ? errors[0].message : "";
      expect(message).toContain("0x00000046");
      expect(message).toContain("after one retry");
      expect(events.some((e) => e.type === "final")).toBe(false);
    } finally {
      await stt.dispose();
    }
  });
});

describe("describeHelperExit", () => {
  it("names a Windows crash status in hex with a plain cause", () => {
    const av = describeHelperExit(3221225477, null);
    expect(av.hex).toBe("0xC0000005");
    expect(av.cause).toMatch(/access violation/);
    expect(av.text).toContain("exit code 3221225477 (0xC0000005)");
    // The same status read as a signed 32-bit number.
    expect(describeHelperExit(-1073741819, null).hex).toBe("0xC0000005");
    expect(describeHelperExit(3221226505, null).cause).toMatch(/stack buffer overrun/);
  });

  it("names a signal and an ordinary exit code", () => {
    expect(describeHelperExit(null, "SIGSEGV")).toMatchObject({ hex: null });
    expect(describeHelperExit(null, "SIGSEGV").cause).toMatch(/segmentation fault/);
    expect(describeHelperExit(null, "SIGKILL").cause).toMatch(/killed/);
    const one = describeHelperExit(1, null);
    expect(one.hex).toBe("0x00000001");
    expect(one.text).toContain("exit code 1 (0x00000001)");
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

describe("fr_stt.py message schema", () => {
  it("accepts helper lines with nulls and unknown keys and rejects malformed ones", () => {
    expect(
      HelperMessageSchema.safeParse({ type: "ready", model: null, selftest: true }).success,
    ).toBe(true);
    const final = HelperMessageSchema.safeParse({
      type: "final",
      text: "hi",
      start_ms: 0,
      end_ms: 120,
      language: "en",
      at_ms: 20,
    });
    expect(final.success).toBe(true);
    expect(final.success && final.data).toMatchObject({ type: "final", text: "hi", end_ms: 120 });
    expect(HelperMessageSchema.safeParse({ type: "final", text: 5 }).success).toBe(false);
    expect(HelperMessageSchema.safeParse({ text: "no type" }).success).toBe(false);
    expect(HelperMessageSchema.safeParse("ready").success).toBe(false);
  });
});
