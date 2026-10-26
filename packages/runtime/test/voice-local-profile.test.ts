import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type AppDirs, appDirs, dirname, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import {
  type VoiceSettings,
  venvPythonPath,
  voiceDirs,
  writeVoiceSettings,
} from "../src/voice/install.ts";
import {
  type LocalHelperOptions,
  LocalVoice,
  localVoiceSettings,
} from "../src/voice/local-profile.ts";
import { buildVoiceRegistry } from "../src/voice/providers.ts";

/**
 * The daemon's local providers follow the voice profile (ADR 0090): the managed venv's
 * interpreter, the profile's devices (cuda with a loud CPU fallback on gpu), the models folder
 * as HF_HOME, or "voice is off" for none. voice.json is read at every use, so a switch from
 * the CLI or Settings applies at the next voice session without a restart.
 */

function home(): { dirs: AppDirs; env: NodeJS.ProcessEnv } {
  const h = mkdtempSync(join(tmpdir(), "fr-voice-local-"));
  const env = { FORERUNNER_HOME: h };
  return { dirs: appDirs({ env }), env };
}

function installed(
  dirs: AppDirs,
  profile: "cpu" | "gpu",
  verified: VoiceSettings["verified"],
  platform: "linux" | "windows" = "linux",
): string {
  const venv = voiceDirs(dirs).venv(profile);
  const py = venvPythonPath(venv, platform);
  mkdirSync(dirname(py), { recursive: true });
  writeFileSync(py, "");
  writeVoiceSettings(dirs, {
    version: 1,
    profile,
    updatedAt: "2026-10-26T10:00:00.000Z",
    install: {
      venv,
      python: py,
      pythonVersion: "3.12.7",
      requirementsSha256: "x",
      installedAt: "2026-10-26T10:00:00.000Z",
    },
    verified,
  });
  return py;
}

const cuda = { device: "cuda", computeType: "float16", fallback: null };
const ttsCuda = { device: "cuda", computeType: null, fallback: null };

describe("localVoiceSettings: what the profile means for the helpers", () => {
  it("no voice.json: null (the behaviour from before profiles: any Python, device auto)", () => {
    const { dirs, env } = home();
    expect(localVoiceSettings({ dirs, env, platform: "linux" })).toBeNull();
  });

  it("none: off, with the way to turn it on", () => {
    const { dirs, env } = home();
    writeVoiceSettings(dirs, { version: 1, profile: "none", updatedAt: "2026-10-26T10:00:00Z" });
    const s = localVoiceSettings({ dirs, env, platform: "linux" });
    expect(s?.off).toMatch(/voice is off/);
    expect(s?.off).toMatch(/fr voice install --cpu/);
    expect(s?.off).toMatch(/Settings/);
  });

  it("gpu, verified on cuda: the venv's Python, STT cuda float16 and Kokoro cuda, both with the CPU fallback", () => {
    const { dirs, env } = home();
    const py = installed(dirs, "gpu", { at: "t", stt: cuda, tts: ttsCuda });
    const s = localVoiceSettings({ dirs, env, platform: "linux" });
    expect(s).toMatchObject({
      profile: "gpu",
      off: null,
      python: py,
      stt: { device: "cuda", computeType: "float16", cpuFallback: true },
      tts: { device: "cuda", cpuFallback: true },
    });
    expect(s?.env.HF_HOME).toBe(voiceDirs(dirs).models);
  });

  it("gpu whose check fell back: the CPU from the start, no CUDA attempt at every start", () => {
    const { dirs, env } = home();
    installed(dirs, "gpu", {
      at: "t",
      stt: { device: "cpu", computeType: "int8", fallback: "cublas64_12.dll not found" },
      tts: ttsCuda,
    });
    const s = localVoiceSettings({ dirs, env, platform: "linux" });
    expect(s?.stt).toEqual({ device: "cpu", computeType: "int8", cpuFallback: false });
    expect(s?.tts).toEqual({ device: "cuda", cpuFallback: true });
  });

  it("cpu: int8 on the CPU and Kokoro on the CPU", () => {
    const { dirs, env } = home();
    installed(dirs, "cpu", {
      at: "t",
      stt: { device: "cpu", computeType: "int8", fallback: null },
      tts: { device: "cpu", computeType: null, fallback: null },
    });
    const s = localVoiceSettings({ dirs, env, platform: "linux" });
    expect(s?.stt).toEqual({ device: "cpu", computeType: "int8", cpuFallback: false });
    expect(s?.tts).toEqual({ device: "cpu", cpuFallback: false });
  });

  it("a profile whose venv is gone: off until it is installed again", () => {
    const { dirs, env } = home();
    writeVoiceSettings(dirs, { version: 1, profile: "gpu", updatedAt: "t" });
    const s = localVoiceSettings({ dirs, env, platform: "linux" });
    expect(s?.off).toMatch(/fr voice install --gpu/);
  });

  it("FORERUNNER_PYTHON wins over the managed venv (devices still follow the profile)", () => {
    const { dirs, env } = home();
    installed(dirs, "gpu", { at: "t", stt: cuda, tts: ttsCuda });
    const s = localVoiceSettings({
      dirs,
      env: { ...env, FORERUNNER_PYTHON: "/opt/py/bin/python" },
      platform: "linux",
    });
    expect(s?.python).toBeNull();
    expect(s?.stt.device).toBe("cuda");
  });

  it("FORERUNNER_PYTHON wins in every case: profile none, or a profile whose venv is gone", () => {
    const { dirs, env } = home();
    const withPy = { ...env, FORERUNNER_PYTHON: "/opt/py/bin/python" };
    writeVoiceSettings(dirs, { version: 1, profile: "none", updatedAt: "t" });
    // Not off: the interpreter named by the environment is used, as before profiles.
    expect(localVoiceSettings({ dirs, env: withPy, platform: "linux" })).toBeNull();
    writeVoiceSettings(dirs, { version: 1, profile: "gpu", updatedAt: "t" });
    const gone = localVoiceSettings({ dirs, env: withPy, platform: "linux" });
    expect(gone?.off).toBeNull();
    expect(gone?.python).toBeNull();
    expect(gone?.stt.device).toBe("cuda");
  });
});

describe("LocalVoice: the registry's faster-whisper and kokoro follow voice.json", () => {
  it("none: the registry reports why local voice is unavailable", async () => {
    const { dirs, env } = home();
    writeVoiceSettings(dirs, { version: 1, profile: "none", updatedAt: "t" });
    const local = new LocalVoice({ dirs, env, clock: new SimulatedClock() });
    const registry = buildVoiceRegistry({
      env,
      vault: new MemoryVault(),
      clock: new SimulatedClock(),
      local,
    });
    const stt = await registry.statusStt();
    const tts = await registry.statusTts();
    expect(stt.find((s) => s.name === "faster-whisper")?.reason).toMatch(/voice is off/);
    expect(tts.find((s) => s.name === "kokoro")?.reason).toMatch(/voice is off/);
    expect(stt.find((s) => s.name === "faster-whisper")?.available).toBe(false);
  });

  it("builds the helpers with the profile's argv and rebuilds them when voice.json changes", async () => {
    const { dirs, env } = home();
    installed(dirs, "cpu", {
      at: "t",
      stt: { device: "cpu", computeType: "int8", fallback: null },
      tts: { device: "cpu", computeType: null, fallback: null },
    });
    const built: LocalHelperOptions[] = [];
    let disposed = 0;
    const local = new LocalVoice({
      dirs,
      env,
      clock: new SimulatedClock(),
      factory: (o) => {
        built.push(o);
        const fake = {
          isAvailable: async () => ({ ok: true, reason: "fake" }),
          dispose: async () => {
            disposed++;
          },
        };
        return {
          stt: {
            name: "faster-whisper",
            kind: "local",
            ...fake,
            start: () => {
              throw new Error("no");
            },
          },
          tts: { name: "kokoro", kind: "local", ...fake, synthesize: async function* () {} },
        };
      },
    });
    await local.stt.isAvailable();
    expect(built).toHaveLength(1);
    expect(built[0]?.stt).toMatchObject({ device: "cpu", computeType: "int8", extraArgs: [] });
    expect(built[0]?.tts.extraArgs).toEqual(["--device", "cpu"]);
    await local.tts.isAvailable();
    expect(built).toHaveLength(1);
    // The CLI switches to gpu: the next use builds new helpers and stops the old ones.
    installed(dirs, "gpu", { at: "t2", stt: cuda, tts: ttsCuda });
    await local.stt.isAvailable();
    expect(built).toHaveLength(2);
    expect(disposed).toBe(2);
    expect(built[1]?.stt).toMatchObject({
      device: "cuda",
      computeType: "float16",
      extraArgs: ["--cpu-fallback"],
    });
    expect(built[1]?.tts.extraArgs).toEqual(["--device", "cuda", "--cpu-fallback"]);
    expect(built[1]?.env?.HF_HOME).toBe(voiceDirs(dirs).models);
  });
});

/** A factory whose helpers record use and can hold a session or a synthesis open. */
function trackingFactory() {
  const built: LocalHelperOptions[] = [];
  let disposed = 0;
  let releaseSynth: () => void = () => {};
  const factory = (o: LocalHelperOptions) => {
    built.push(o);
    const index = built.length;
    return {
      stt: {
        name: "faster-whisper",
        kind: "local" as const,
        isAvailable: async () => ({ ok: true, reason: `pair ${index}` }),
        start: () => {
          let closed = false;
          const queue: unknown[] = [];
          return {
            events: {
              async *[Symbol.asyncIterator]() {
                while (!closed) await new Promise((r) => setTimeout(r, 5));
                yield* queue as never[];
              },
            },
            push: () => {},
            endOfSpeech: () => {},
            close: async () => {
              closed = true;
            },
          };
        },
        dispose: async () => {
          disposed++;
        },
      },
      tts: {
        name: "kokoro",
        kind: "local" as const,
        isAvailable: async () => ({ ok: true, reason: `pair ${index}` }),
        synthesize: async function* () {
          await new Promise<void>((r) => {
            releaseSynth = r;
          });
          yield { pcm: new Int16Array(10), sampleRate: 24000, channels: 1, timestampMs: 0 };
        },
        dispose: async () => {
          disposed++;
        },
      },
    };
  };
  return { factory, built, disposed: () => disposed, releaseSynth: () => releaseSynth() };
}

const cpuVerified = {
  at: "t",
  stt: { device: "cpu", computeType: "int8", fallback: null },
  tts: { device: "cpu", computeType: null, fallback: null },
};

describe("LocalVoice: live sessions and a profile change", () => {
  it("defers a swap while an STT session is open; the old helpers live until it ends", async () => {
    const { dirs, env } = home();
    installed(dirs, "cpu", cpuVerified);
    const t = trackingFactory();
    const local = new LocalVoice({ dirs, env, clock: new SimulatedClock(), factory: t.factory });
    const session = local.stt.start({ sampleRate: 16000 });
    expect(local.inUse()).toBe(1);
    installed(dirs, "gpu", { at: "t2", stt: cuda, tts: ttsCuda });
    // Still the old pair, nothing stopped, while the session is open.
    expect((await local.stt.isAvailable()).reason).toBe("pair 1");
    expect(t.built).toHaveLength(1);
    expect(t.disposed()).toBe(0);
    await session.close();
    expect(local.inUse()).toBe(0);
    expect((await local.stt.isAvailable()).reason).toBe("pair 2");
    expect(t.disposed()).toBe(2);
  });

  it("defers a swap while a sentence is being synthesised", async () => {
    const { dirs, env } = home();
    installed(dirs, "cpu", cpuVerified);
    const t = trackingFactory();
    const local = new LocalVoice({ dirs, env, clock: new SimulatedClock(), factory: t.factory });
    const it = local.tts.synthesize("Hello.")[Symbol.asyncIterator]();
    const first = it.next();
    await new Promise((r) => setTimeout(r, 5));
    expect(local.inUse()).toBe(1);
    installed(dirs, "gpu", { at: "t2", stt: cuda, tts: ttsCuda });
    expect((await local.tts.isAvailable()).reason).toBe("pair 1");
    t.releaseSynth();
    await first;
    await it.next();
    expect(local.inUse()).toBe(0);
    expect((await local.tts.isAvailable()).reason).toBe("pair 2");
  });

  it("refuses new sessions and speech while an install runs, with the reason", async () => {
    const { dirs, env } = home();
    installed(dirs, "cpu", cpuVerified);
    let installing: string | null = "a voice install is running";
    const t = trackingFactory();
    const local = new LocalVoice({
      dirs,
      env,
      clock: new SimulatedClock(),
      factory: t.factory,
      blocked: () => installing,
    });
    expect(await local.stt.isAvailable()).toEqual({
      ok: false,
      reason: "a voice install is running",
    });
    expect(() => local.stt.start({ sampleRate: 16000 })).toThrow(/voice install is running/);
    const speak = async () => {
      for await (const _ of local.tts.synthesize("Hi.")) {
        // nothing
      }
    };
    await expect(speak()).rejects.toThrow(/voice install is running/);
    installing = null;
    expect((await local.stt.isAvailable()).ok).toBe(true);
  });
});

describe("LocalVoice: a session's use always ends", () => {
  const sessionFactory = (events: () => AsyncIterable<unknown>) => () => {
    const fake = { isAvailable: async () => ({ ok: true, reason: "ok" }), dispose: async () => {} };
    return {
      stt: {
        name: "faster-whisper",
        kind: "local" as const,
        ...fake,
        start: () => ({
          events: events() as never,
          push: () => {},
          endOfSpeech: () => {},
          close: async () => {},
        }),
      },
      tts: { name: "kokoro", kind: "local" as const, ...fake, synthesize: async function* () {} },
    };
  };

  it("at the inner session's final or error, even when the reader never ends its loop", async () => {
    const { dirs, env } = home();
    installed(dirs, "cpu", cpuVerified);
    for (const last of [
      { type: "final", text: "hi", atMs: 1 },
      { type: "error", code: "provider_error", message: "x", retryable: true, atMs: 1 },
    ]) {
      const local = new LocalVoice({
        dirs,
        env,
        clock: new SimulatedClock(),
        factory: sessionFactory(async function* () {
          yield last;
          await new Promise(() => {}); // never ends
        }),
      });
      const session = local.stt.start({ sampleRate: 16000 });
      expect(local.inUse()).toBe(1);
      const it = session.events[Symbol.asyncIterator]();
      expect((await it.next()).value).toMatchObject({ type: last.type });
      expect(local.inUse()).toBe(0);
    }
  });

  it("release() resets a leaked count with a warning", async () => {
    const { dirs, env } = home();
    installed(dirs, "cpu", cpuVerified);
    const warnings: string[] = [];
    const local = new LocalVoice({
      dirs,
      env,
      clock: new SimulatedClock(),
      warn: (m) => warnings.push(m),
      factory: sessionFactory(async function* () {
        await new Promise(() => {});
      }),
    });
    local.stt.start({ sampleRate: 16000 }); // never read, never closed
    expect(local.inUse()).toBe(1);
    await local.release();
    expect(local.inUse()).toBe(0);
    expect(warnings.join("\n")).toMatch(/1 local voice use.*still counted/);
  });
});
