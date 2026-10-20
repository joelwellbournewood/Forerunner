import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { currentPlatform, join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { CartesiaTts } from "../src/providers/cloud/cartesia.ts";
import { DeepgramStt } from "../src/providers/cloud/deepgram.ts";
import { ElevenLabsTts } from "../src/providers/cloud/elevenlabs.ts";
import { FasterWhisperStt } from "../src/providers/local/faster-whisper.ts";
import { KokoroTts } from "../src/providers/local/kokoro.ts";
import { PiperTts } from "../src/providers/local/piper.ts";
import {
  findPython,
  interpreterDidNotRun,
  probePythonModule,
  pythonRun,
} from "../src/providers/local/python.ts";
import { fakeKey, fakeWsFactory } from "./helpers.ts";

const python = await findPython();
const MISSING_PY = "forerunner-no-such-python-xyz";

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

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

  it("recognises an interpreter that did not run (Windows Store alias)", () => {
    expect(interpreterDidNotRun(9009, "")).toBe(true);
    expect(
      interpreterDidNotRun(
        49,
        "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Manage App Execution Aliases.",
      ),
    ).toBe(true);
    expect(interpreterDidNotRun(1, "ModuleNotFoundError: No module named 'kokoro'")).toBe(false);
    expect(interpreterDidNotRun(0, "")).toBe(false);
    expect(interpreterDidNotRun(null, "")).toBe(false);
  });

  it.skipIf(currentPlatform() === "windows")(
    "skips a stub that only says Python was not found and tries the next candidate",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "fr-pystub-"));
      tmpDirs.push(dir);
      const stub = join(dir, "python");
      await writeFile(
        stub,
        "#!/bin/sh\necho 'Python was not found; run without arguments to install from the Microsoft Store' >&2\nexit 49\n",
      );
      await chmod(stub, 0o755);
      const r = await pythonRun("print(1)", { env: { ...process.env, FORERUNNER_PYTHON: stub } });
      expect(r.python).not.toBe(stub);
      if (python !== null) expect(r).toMatchObject({ python, code: 0 });
      else expect(r.python).toBeNull();
    },
  );

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
