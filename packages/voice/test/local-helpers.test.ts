import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ForerunnerError, join, Logger, log, SimulatedClock } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FasterWhisperStt, HelperMessageSchema } from "../src/providers/local/faster-whisper.ts";
import {
  describeHelperExit,
  HelperProcess,
  StderrTail,
} from "../src/providers/local/helper-process.ts";
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

  /**
   * The GPU run of 2026-10-26: the retry sent the same audio with the same settings to a fresh
   * helper and crashed the same way, so the utterance was lost twice. The retry now decodes
   * differently: greedy at temperature 0 with no temperature fallback, and after a crash on the
   * GPU on a one-utterance CPU (int8) helper; later turns go back to the usual helper.
   */
  const recorded = async (file: string) =>
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            pid: number;
            device: string;
            computeType: string;
            decode: unknown;
            audioBytes: number;
          },
      );
  const retryWith = (name: string, device: string, computeType: string) =>
    new FasterWhisperStt({
      python: node,
      helperPath: fixture("crashing_stt_helper.mjs"),
      device,
      computeType,
      extraArgs: [
        "--crash-file",
        join(dir, name),
        "--crash-times",
        "1",
        "--record-file",
        join(dir, `${name}.jsonl`),
      ],
    });
  const GREEDY = { beam_size: 1, temperature: [0] };

  it("a crash on the CPU: the retry decodes greedy at temperature 0; the next turn decodes as usual", async () => {
    const stt = retryWith("cpu-retry", "cpu", "int8");
    try {
      const { result: events, lines } = await captured(() => utterance(stt));
      expect(events.at(-1)).toMatchObject({ type: "final", text: "hello world 6400" });
      const next = await utterance(stt);
      expect(next.at(-1)).toMatchObject({ type: "final", text: "hello world 6400" });
      const [retry, later] = await recorded(join(dir, "cpu-retry.jsonl"));
      expect(retry).toMatchObject({ device: "cpu", computeType: "int8", decode: GREEDY });
      expect(retry?.audioBytes).toBe(6400);
      // The helper the retry started stays for later turns, with the usual decode options.
      expect(later).toMatchObject({ pid: retry?.pid, device: "cpu", decode: null });
      const warn = lines.find((l) => l.includes("retrying the utterance"));
      expect(warn).toContain('"retryMode":"greedy at temperature 0"');
    } finally {
      await stt.dispose();
    }
  });

  it("a crash on the GPU: the retry runs greedy on a CPU (int8) helper for that utterance, then the GPU again", async () => {
    const stt = retryWith("gpu-retry", "cuda", "float16");
    try {
      const { result: events, lines } = await captured(() => utterance(stt));
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "final", text: "hello world 6400" });
      const next = await utterance(stt);
      expect(next.at(-1)).toMatchObject({ type: "final", text: "hello world 6400" });
      const [retry, later] = await recorded(join(dir, "gpu-retry.jsonl"));
      expect(retry).toMatchObject({ device: "cpu", computeType: "int8", decode: GREEDY });
      expect(later).toMatchObject({ device: "cuda", computeType: "float16", decode: null });
      expect(later?.pid).not.toBe(retry?.pid);
      const warn = lines.find((l) => l.includes("retrying the utterance"));
      expect(warn).toContain('"retryMode":"greedy at temperature 0 on the CPU (int8)"');
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

  /**
   * The GPU run of 2026-10-26: the first utterance crashed twice with 0xC0000005 and nothing
   * said where, because the helper's stderr (Python's faulthandler traceback, since this
   * change) was logged at debug level only. A non-zero exit now carries the stderr's last lines.
   */
  it("a crash carries the last 40 lines of the helper's stderr: in a warning and in the error's details", async () => {
    const stt = crashing("stderr", 2, ["--stderr-lines", "60"]);
    try {
      const { result: events, lines } = await captured(() => utterance(stt));
      const error = events.find((e) => e.type === "error");
      if (error?.type !== "error") throw new Error("no error event");
      const details = error.details ?? {};
      const tail = String(details.stderrTail);
      expect(tail.split("\n")).toEqual(
        Array.from({ length: 40 }, (_, i) => `trace ${String(i + 21).padStart(3, "0")}`),
      );
      expect(details).toMatchObject({ exitCode: 70, exitCodeHex: "0x00000046" });
      // The first crash, the one the retry was for, keeps its own tail.
      expect(details.firstCrash).toMatchObject({ exitCodeHex: "0x00000046" });
      expect(String((details.firstCrash as { stderrTail?: string }).stderrTail)).toContain(
        "trace 060",
      );
      // Both crashes are warnings that carry the tail.
      const warned = lines.filter((l) => l.startsWith("warn ") && l.includes("trace 060"));
      expect(warned.map((l) => l.split(" {")[0])).toEqual([
        "warn helper crashed mid-transcription; restarting it and retrying the utterance",
        "warn helper crashed mid-transcription; the turn fails",
      ]);
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

  it("a helper crash fails the sentence with the stderr's last 40 lines, logged as a warning", async () => {
    const crashing = new KokoroTts({ python: node, helperPath: fixture("fake_tts_helper.mjs") });
    const lines: string[] = [];
    const off = Logger.addSink((rec) => {
      if (rec.scope === "voice:kokoro")
        lines.push(`${rec.level} ${rec.msg} ${JSON.stringify(rec.data ?? {})}`);
    });
    try {
      let caught: unknown;
      try {
        for await (const _c of crashing.synthesize("CRASH")) {
          // drain
        }
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ForerunnerError);
      const err = caught as ForerunnerError;
      expect(err.code).toBe("provider_error");
      expect(err.message).toContain("0x00000046");
      expect(String(err.details.stderrTail).split("\n")).toEqual(
        Array.from({ length: 40 }, (_, i) => `trace ${String(i + 11).padStart(3, "0")}`),
      );
      const warned = lines.find(
        (l) => l.startsWith("warn helper exited") && l.includes("trace 050"),
      );
      expect(warned).toBeDefined();
    } finally {
      off();
      await crashing.dispose();
    }
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

describe("StderrTail", () => {
  it("keeps the last lines whole across chunks split mid-line, with the unfinished line last", () => {
    const tail = new StderrTail(3, 1000);
    tail.push("one\ntw");
    tail.push("o\r\nthree\nfour\nfi");
    expect(tail.text()).toBe("three\nfour\nfi");
    tail.push("ve\n");
    expect(tail.text()).toBe("three\nfour\nfive");
  });

  it("caps the size: the newest characters are kept, an over-long line is cut at its start", () => {
    const tail = new StderrTail(40, 100);
    for (let i = 0; i < 20; i++) tail.push(`${"x".repeat(20)} ${i}\n`);
    const text = tail.text();
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.endsWith("x 19")).toBe(true);
    tail.push(`${"y".repeat(500)}END\n`);
    expect(tail.text().length).toBeLessThanOrEqual(100);
    expect(tail.text().endsWith("yEND")).toBe(true);
  });

  it("a HelperProcess keeps its helper's stderr tail (40 lines)", async () => {
    let exited = false;
    const proc = new HelperProcess({
      argv: [
        node,
        "-e",
        'for (let i = 1; i <= 45; i++) process.stderr.write("line " + i + "\\n"); process.exitCode = 3',
      ],
      log: log("voice:test"),
      onStdout: () => {},
      onExit: () => {
        exited = true;
      },
    });
    for (let waited = 0; !exited && waited < 5000; waited += 20)
      await new Promise<void>((r) => setTimeout(r, 20));
    expect(exited).toBe(true);
    const lines = proc.stderrTail().split("\n");
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe("line 6");
    expect(lines.at(-1)).toBe("line 45");
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
