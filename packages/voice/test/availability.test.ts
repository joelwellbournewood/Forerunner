import { describe, expect, it } from "vitest";
import { CartesiaTts } from "../src/providers/cloud/cartesia.ts";
import { DeepgramStt } from "../src/providers/cloud/deepgram.ts";
import { ElevenLabsTts } from "../src/providers/cloud/elevenlabs.ts";
import { FasterWhisperStt } from "../src/providers/local/faster-whisper.ts";
import { KokoroTts } from "../src/providers/local/kokoro.ts";
import { PiperTts } from "../src/providers/local/piper.ts";
import { findPython, probePythonModule } from "../src/providers/local/python.ts";
import { fakeKey, fakeWsFactory } from "./helpers.ts";

const python = await findPython();
const MISSING_PY = "forerunner-no-such-python-xyz";

describe("availability probes never throw", () => {
  it("faster-whisper reports a missing interpreter", async () => {
    const stt = new FasterWhisperStt({ python: MISSING_PY });
    const a = await stt.isAvailable();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/no python interpreter found/);
  });

  it("kokoro reports a missing interpreter", async () => {
    const a = await new KokoroTts({ python: MISSING_PY }).isAvailable();
    expect(a).toMatchObject({ ok: false });
    expect(a.reason).toMatch(/no python interpreter/);
  });

  it.skipIf(python === null)(
    "reports a missing module with the interpreter that was used",
    async () => {
      const probe = await probePythonModule("forerunner_module_that_does_not_exist", {
        python: python ?? undefined,
      });
      expect(probe.ok).toBe(false);
      expect(probe.python).toBe(python);
      expect(probe.reason).toMatch(/import forerunner_module_that_does_not_exist failed/);
      const ok = await probePythonModule("json", { python: python ?? undefined });
      expect(ok).toMatchObject({ ok: true, python });
    },
  );

  it("rejects an invalid module name before spawning anything", async () => {
    const probe = await probePythonModule("os; import sys");
    expect(probe).toMatchObject({ ok: false, python: null });
    expect(probe.reason).toMatch(/invalid module name/);
  });

  it("piper reports a missing binary and a missing model", async () => {
    const a = await new PiperTts({
      binary: "forerunner-no-such-piper",
      modelPath: "x.onnx",
    }).isAvailable();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/not found on PATH/);
    const b = await new PiperTts({
      binary: process.execPath,
      modelPath: "no-such-model.onnx",
    }).isAvailable();
    expect(b.ok).toBe(false);
    expect(b.reason).toMatch(/piper unavailable/);
  });

  it("cloud providers are available only with a key (and a voice for TTS)", async () => {
    const none = async () => undefined;
    const some = async () => fakeKey("dg_");
    const { factory } = fakeWsFactory();
    expect(
      (
        await new DeepgramStt({
          apiKeyRef: "secret:dg",
          resolveSecret: none,
          ws: factory,
        }).isAvailable()
      ).ok,
    ).toBe(false);
    const dg = await new DeepgramStt({
      apiKeyRef: "secret:dg",
      resolveSecret: some,
      ws: factory,
    }).isAvailable();
    expect(dg.ok).toBe(true);
    expect(dg.reason).not.toContain(fakeKey("dg_"));

    const ct = new CartesiaTts({ apiKeyRef: "secret:ct", resolveSecret: some, ws: factory });
    expect((await ct.isAvailable()).reason).toMatch(/voice id/);
    const ctVoice = new CartesiaTts({
      apiKeyRef: "secret:ct",
      resolveSecret: some,
      ws: factory,
      voice: "v1",
    });
    expect((await ctVoice.isAvailable()).ok).toBe(true);

    const el = new ElevenLabsTts({ apiKeyRef: "secret:el", resolveSecret: none, voice: "v1" });
    expect((await el.isAvailable()).ok).toBe(false);
    const thrower = async () => {
      throw new Error("vault locked");
    };
    const locked = await new ElevenLabsTts({
      apiKeyRef: "secret:el",
      resolveSecret: thrower,
      voice: "v",
    }).isAvailable();
    expect(locked).toMatchObject({ ok: false });
    expect(locked.reason).toMatch(/vault locked/);
  });
});
