import { Logger, type LogRecord, SimulatedClock } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CartesiaTts } from "../src/providers/cloud/cartesia.ts";
import { DeepgramStt } from "../src/providers/cloud/deepgram.ts";
import { ElevenLabsTts } from "../src/providers/cloud/elevenlabs.ts";
import type { HttpStreamFn } from "../src/providers/cloud/transport.ts";
import type { AudioChunk, SttEvent } from "../src/types.ts";
import { chunkify, pcmBytes, synth } from "../src/wav.ts";
import { bytePieces, fakeKey, fakeWsFactory, settle } from "./helpers.ts";

const DG_KEY = fakeKey("dg_");
const CT_KEY = fakeKey("sk_car_");
const EL_KEY = fakeKey("sk_el_");

let logs: LogRecord[] = [];
beforeEach(() => {
  logs = [];
  Logger.setSinks([(r) => logs.push(r)]);
  Logger.setLevel("debug");
});
afterEach(() => {
  Logger.setSinks([]);
  Logger.setLevel("info");
});

function results(transcript: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "Results",
    channel: { alternatives: [{ transcript, confidence: 0.98 }] },
    start: 0.1,
    duration: 1.2,
    ...extra,
  };
}

describe("DeepgramStt", () => {
  it("sends the key in a header, buffers audio until open, emits partials and one final", async () => {
    const clock = new SimulatedClock(0);
    const { factory, sockets } = fakeWsFactory();
    const dg = new DeepgramStt({
      apiKeyRef: "secret:deepgram",
      resolveSecret: async () => DG_KEY,
      ws: factory,
      clock,
    });
    const session = dg.start({ sampleRate: 16000, language: "en" });
    const events: SttEvent[] = [];
    const consumer = (async () => {
      for await (const e of session.events) events.push(e);
    })();
    const [chunk] = chunkify(synth(440, 20), 20) as [AudioChunk];
    session.push(chunk);
    await settle();
    const sock = sockets[0];
    if (!sock) throw new Error("no socket");
    expect(sock.url).toContain("wss://api.deepgram.com/v1/listen?");
    expect(sock.url).toContain("encoding=linear16");
    expect(sock.url).toContain("language=en");
    expect(sock.url).not.toContain(DG_KEY);
    expect(sock.opts.headers?.Authorization).toBe(`Token ${DG_KEY}`);
    expect(sock.sent).toHaveLength(0);
    sock.open();
    expect(sock.sent).toHaveLength(1);
    expect(sock.sent[0]).toEqual(pcmBytes(synth(440, 20)));

    sock.message(results("what is", { is_final: false }));
    sock.message(results("what is the status", { is_final: true, speech_final: true }));
    sock.message(results("of the", { is_final: false }));
    await settle();
    expect(events.map((e) => e.type)).toEqual(["partial", "partial"]);
    expect(events[1]).toMatchObject({ type: "partial", text: "what is the status of the" });

    session.endOfSpeech();
    expect(sock.sentJson()).toContainEqual({ type: "Finalize" });
    sock.message(results("of the build", { is_final: true, from_finalize: true }));
    await consumer;
    expect(events[2]).toMatchObject({
      type: "final",
      text: "what is the status of the build",
      confidence: 0.98,
      startMs: 100,
    });
    expect(sock.sentJson()).toContainEqual({ type: "CloseStream" });
    expect(sock.closed).not.toBeNull();
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(DG_KEY);
  });

  it("emits the final from what it has when the finalise answer never comes", async () => {
    const clock = new SimulatedClock(0);
    const { factory, sockets } = fakeWsFactory();
    const dg = new DeepgramStt({
      apiKeyRef: "secret:deepgram",
      resolveSecret: async () => DG_KEY,
      ws: factory,
      clock,
    });
    const session = dg.start({ sampleRate: 16000 });
    const events: SttEvent[] = [];
    const consumer = (async () => {
      for await (const e of session.events) events.push(e);
    })();
    await settle();
    sockets[0]?.open();
    sockets[0]?.message(results("hello", { is_final: true }));
    session.endOfSpeech();
    await clock.advance(1500);
    await consumer;
    expect(events.at(-1)).toMatchObject({ type: "final", text: "hello" });
  });

  it("reports a missing key as provider_auth without connecting", async () => {
    const { factory, sockets } = fakeWsFactory();
    const dg = new DeepgramStt({
      apiKeyRef: "secret:deepgram",
      resolveSecret: async () => undefined,
      ws: factory,
    });
    const session = dg.start({ sampleRate: 16000 });
    const events: SttEvent[] = [];
    for await (const e of session.events) events.push(e);
    expect(events[0]).toMatchObject({ type: "error", code: "provider_auth" });
    expect(sockets).toHaveLength(0);
  });

  it("surfaces a Deepgram error message", async () => {
    const { factory, sockets } = fakeWsFactory();
    const dg = new DeepgramStt({
      apiKeyRef: "secret:deepgram",
      resolveSecret: async () => DG_KEY,
      ws: factory,
    });
    const session = dg.start({ sampleRate: 16000 });
    const events: SttEvent[] = [];
    const consumer = (async () => {
      for await (const e of session.events) events.push(e);
    })();
    await settle();
    sockets[0]?.open();
    sockets[0]?.message({ type: "Error", description: "bad request" });
    await consumer;
    expect(events[0]).toMatchObject({
      type: "error",
      code: "provider_error",
      message: "bad request",
    });
  });
});

describe("CartesiaTts", () => {
  it("opens one socket per sentence, sends the request and decodes base64 chunks", async () => {
    const { factory, sockets } = fakeWsFactory();
    const tts = new CartesiaTts({
      apiKeyRef: "secret:cartesia",
      resolveSecret: async () => CT_KEY,
      ws: factory,
      voice: "voice-123",
      sampleRate: 24000,
    });
    const chunks: AudioChunk[] = [];
    const run = (async () => {
      for await (const c of tts.synthesize("Hello there.", { speed: 1.2 })) chunks.push(c);
    })();
    await settle();
    const sock = sockets[0];
    if (!sock) throw new Error("no socket");
    expect(sock.url).not.toContain(CT_KEY);
    expect(sock.opts.headers?.["X-API-Key"]).toBe(CT_KEY);
    sock.open();
    const req = sock.sentJson()[0];
    expect(req).toMatchObject({
      transcript: "Hello there.",
      voice: { mode: "id", id: "voice-123" },
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
      speed: "fast",
      continue: false,
    });
    const pcm = synth(440, 10, 24000);
    sock.message({
      type: "chunk",
      data: pcmBytes(pcm).toString("base64"),
      done: false,
      context_id: req?.context_id,
    });
    sock.message({
      type: "chunk",
      data: pcmBytes(pcm).toString("base64"),
      done: false,
      context_id: req?.context_id,
    });
    sock.message({ type: "done", context_id: req?.context_id });
    await run;
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatchObject({ sampleRate: 24000, timestampMs: 10 });
    expect(Array.from(chunks[0]?.pcm ?? [])).toEqual(Array.from(pcm));
    expect(sock.closed).not.toBeNull();
    expect(JSON.stringify(logs)).not.toContain(CT_KEY);
  });

  it("closes the socket and stops on abort", async () => {
    const { factory, sockets } = fakeWsFactory();
    const tts = new CartesiaTts({
      apiKeyRef: "secret:cartesia",
      resolveSecret: async () => CT_KEY,
      ws: factory,
      voice: "v",
    });
    const ac = new AbortController();
    const chunks: AudioChunk[] = [];
    const run = (async () => {
      for await (const c of tts.synthesize("Long.", { signal: ac.signal })) chunks.push(c);
    })();
    await settle();
    sockets[0]?.open();
    sockets[0]?.message({
      type: "chunk",
      data: pcmBytes(synth(440, 10, 24000)).toString("base64"),
      done: false,
    });
    await settle();
    ac.abort();
    await run;
    expect(chunks).toHaveLength(1);
    expect(sockets[0]?.closed).not.toBeNull();
  });

  it("fails with provider_error on an error message and validation without a voice", async () => {
    const { factory, sockets } = fakeWsFactory();
    const tts = new CartesiaTts({
      apiKeyRef: "secret:cartesia",
      resolveSecret: async () => CT_KEY,
      ws: factory,
      voice: "v",
    });
    const run = (async () => {
      for await (const _c of tts.synthesize("x")) {
        // drain
      }
    })();
    await settle();
    sockets[0]?.open();
    sockets[0]?.message({ type: "error", error: "invalid voice" });
    await expect(run).rejects.toMatchObject({ code: "provider_error" });

    const noVoice = new CartesiaTts({
      apiKeyRef: "secret:cartesia",
      resolveSecret: async () => CT_KEY,
      ws: factory,
    });
    await expect(
      (async () => {
        for await (const _c of noVoice.synthesize("x")) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ code: "validation" });
  });
});

describe("ElevenLabsTts", () => {
  it("posts to the stream endpoint with the key header and chunks the PCM body", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const pcm = synth(440, 100, 24000); // 4800 bytes
    const bytes = pcmBytes(pcm);
    const http: HttpStreamFn = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return {
        status: 200,
        headers: {},
        body: bytePieces([
          bytes.subarray(0, 1601),
          bytes.subarray(1601, 3000),
          bytes.subarray(3000),
        ]),
      };
    };
    const tts = new ElevenLabsTts({
      apiKeyRef: "secret:eleven",
      resolveSecret: async () => EL_KEY,
      http,
      voice: "v-9",
    });
    const chunks: AudioChunk[] = [];
    for await (const c of tts.synthesize("Hi.", { speed: 1.1 })) chunks.push(c);
    expect(calls[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/v-9/stream?output_format=pcm_24000",
    );
    expect(calls[0]?.headers["xi-api-key"]).toBe(EL_KEY);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      text: "Hi.",
      voice_settings: { speed: 1.1 },
    });
    const all = chunks.flatMap((c) => Array.from(c.pcm));
    expect(all).toEqual(Array.from(pcm));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.timestampMs).toBe(0);
    expect(JSON.stringify(logs)).not.toContain(EL_KEY);
  });

  it("maps 401 to provider_auth and other failures to provider_error", async () => {
    const http: HttpStreamFn = async () => ({
      status: 401,
      headers: {},
      body: bytePieces([Buffer.from('{"detail":"invalid key"}')]),
    });
    const tts = new ElevenLabsTts({
      apiKeyRef: "secret:eleven",
      resolveSecret: async () => EL_KEY,
      http,
      voice: "v",
    });
    await expect(
      (async () => {
        for await (const _c of tts.synthesize("x")) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ code: "provider_auth" });
    const bad = new ElevenLabsTts({
      apiKeyRef: "secret:eleven",
      resolveSecret: async () => EL_KEY,
      http,
      voice: "v",
      sampleRate: 8000,
    });
    await expect(
      (async () => {
        for await (const _c of bad.synthesize("x")) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("returns instead of throwing when the signal aborts and the body rejects", async () => {
    const ac = new AbortController();
    const bytes = pcmBytes(synth(440, 100, 24000));
    const http: HttpStreamFn = async (_url, init) => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield bytes.subarray(0, 2400);
        // the fetch transport's reader.read() rejects with AbortError once the signal aborts
        await new Promise<void>((_, reject) => {
          const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (init.signal?.aborted) fail();
          else init.signal?.addEventListener("abort", fail, { once: true });
        });
        yield bytes.subarray(2400);
      })(),
    });
    const tts = new ElevenLabsTts({
      apiKeyRef: "secret:eleven",
      resolveSecret: async () => EL_KEY,
      http,
      voice: "v",
    });
    const chunks: AudioChunk[] = [];
    const run = (async () => {
      for await (const c of tts.synthesize("Long.", { signal: ac.signal })) chunks.push(c);
    })();
    await settle();
    ac.abort();
    await expect(run).resolves.toBeUndefined();
    expect(chunks).toHaveLength(1);
  });
});
