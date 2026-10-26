/**
 * The local voice helpers as the voice profile says (ADR 0090). `LocalVoice` stands in the
 * registry as "faster-whisper" and "kokoro" and builds the real providers from
 * `<config>/voice.json` at every use: the managed venv's interpreter, the profile's devices,
 * the models folder as HF_HOME. When voice.json changes (`fr voice install` from a terminal,
 * the Settings → Voice switch) the next use stops the old helper processes and starts new
 * ones, so no restart is needed. Without voice.json (an install from before profiles, or a
 * voice-run home) the helpers are built as before: whichever Python is found, device auto.
 *
 * gpu: STT runs `--device cuda --compute-type float16 --cpu-fallback` and Kokoro
 * `--device cuda --cpu-fallback`: a CUDA failure at run time falls back to the CPU and the
 * helper says so (stderr, the ready line's `fallback`). A side whose install check already
 * fell back (voice.json `verified.*.fallback`) starts on the CPU instead of failing on CUDA at
 * every start; `fr voice install --gpu` checks the GPU again.
 */
import { existsSync } from "node:fs";
import {
  type AppDirs,
  type Clock,
  currentPlatform,
  ForerunnerError,
  type Platform,
} from "@forerunner/platform";
import {
  type Availability,
  FasterWhisperStt,
  KokoroTts,
  type SttProvider,
  type SttSession,
  type SttStartOptions,
  type TtsOptions,
  type TtsProvider,
} from "@forerunner/voice";
import { readVoiceSettings, venvPythonPath, voiceDirs } from "./install.ts";
import { type VoiceProfile, voiceInstallCommand } from "./install-types.ts";

export interface LocalVoiceSettings {
  profile: VoiceProfile;
  /** Why local voice is off (profile none, or a profile whose venv is missing); null when on. */
  off: string | null;
  /** The managed venv's interpreter; null when FORERUNNER_PYTHON (or the lookup) decides. */
  python: string | null;
  /** Added to the helpers' environment (HF_HOME: the managed models folder). */
  env: Record<string, string>;
  stt: { device: string; computeType: string; cpuFallback: boolean };
  tts: { device: string; cpuFallback: boolean };
}

export interface LocalVoiceDeps {
  dirs: AppDirs;
  env: NodeJS.ProcessEnv;
  platform?: Platform;
}

/** What voice.json means for the helpers; null without voice.json (the behaviour from before profiles). */
export function localVoiceSettings(deps: LocalVoiceDeps): LocalVoiceSettings | null {
  const s = readVoiceSettings(deps.dirs);
  if (!s) return null;
  const vd = voiceDirs(deps.dirs);
  const platform = deps.platform ?? currentPlatform();
  const base = {
    profile: s.profile,
    python: null,
    env: { HF_HOME: vd.models },
    stt: { device: "cpu", computeType: "int8", cpuFallback: false },
    tts: { device: "cpu", cpuFallback: false },
  };
  // FORERUNNER_PYTHON wins in every case: the human named the interpreter, so local voice is
  // never "off" for want of the managed venv. With profile none it runs as before profiles.
  const override = !!deps.env.FORERUNNER_PYTHON?.trim();
  if (s.profile === "none")
    return override
      ? null
      : {
          ...base,
          off: `local voice is off (voice profile none); turn it on in Settings -> Voice or with ${voiceInstallCommand("cpu")} (or --gpu)`,
        };
  const venvPython = venvPythonPath(vd.venv(s.profile), platform);
  if (!override && !existsSync(venvPython))
    return {
      ...base,
      off: `voice profile ${s.profile} is not installed (no ${venvPython}); run ${voiceInstallCommand(s.profile)}`,
    };
  const python = override ? null : venvPython;
  if (s.profile === "cpu") return { ...base, off: null, python };
  const sttFellBack = s.verified?.stt.fallback != null || s.verified?.stt.device === "cpu";
  const ttsFellBack = s.verified?.tts.fallback != null || s.verified?.tts.device === "cpu";
  return {
    ...base,
    off: null,
    python,
    stt: sttFellBack
      ? { device: "cpu", computeType: "int8", cpuFallback: false }
      : { device: "cuda", computeType: "float16", cpuFallback: true },
    tts: ttsFellBack
      ? { device: "cpu", cpuFallback: false }
      : { device: "cuda", cpuFallback: true },
  };
}

/** The options a pair of helpers is built with (what a test factory sees). */
export interface LocalHelperOptions {
  python?: string;
  env?: NodeJS.ProcessEnv;
  clock: Clock;
  stt: { model?: string; device?: string; computeType?: string; extraArgs: string[] };
  tts: { voice?: string; extraArgs: string[] };
}

interface Disposable {
  dispose?(): Promise<void>;
}
export interface LocalPair {
  stt: SttProvider & Disposable;
  tts: TtsProvider & Disposable;
}

export function defaultLocalFactory(o: LocalHelperOptions): LocalPair {
  return {
    stt: new FasterWhisperStt({
      clock: o.clock,
      ...(o.env ? { env: o.env } : {}),
      ...(o.python ? { python: o.python } : {}),
      ...(o.stt.model ? { model: o.stt.model } : {}),
      ...(o.stt.device ? { device: o.stt.device } : {}),
      ...(o.stt.computeType ? { computeType: o.stt.computeType } : {}),
      ...(o.stt.extraArgs.length ? { extraArgs: o.stt.extraArgs } : {}),
    }),
    tts: new KokoroTts({
      clock: o.clock,
      ...(o.env ? { env: o.env } : {}),
      ...(o.python ? { python: o.python } : {}),
      ...(o.tts.voice ? { voice: o.tts.voice } : {}),
      ...(o.tts.extraArgs.length ? { extraArgs: o.tts.extraArgs } : {}),
    }),
  };
}

/** A local provider that is off, with the reason the status rows show. */
function offPair(reason: string): LocalPair {
  const unavailable = async (): Promise<Availability> => ({ ok: false, reason });
  return {
    stt: {
      name: "faster-whisper",
      kind: "local",
      isAvailable: unavailable,
      start: () => {
        throw new ForerunnerError("unavailable", reason);
      },
    },
    tts: {
      name: "kokoro",
      kind: "local",
      isAvailable: unavailable,
      // biome-ignore lint/correctness/useYield: it throws before any audio
      synthesize: async function* () {
        throw new ForerunnerError("unavailable", reason);
      },
    },
  };
}

export interface LocalVoiceOptions extends LocalVoiceDeps {
  clock: Clock;
  factory?: (o: LocalHelperOptions) => LocalPair;
  /**
   * Why local voice must not start now (a voice install is running); null when it may. New
   * sessions and new sentences are refused with it; the ones running finish.
   */
  blocked?: () => string | null;
}

export class LocalVoice {
  readonly stt: SttProvider;
  readonly tts: TtsProvider;
  private key: string | null = null;
  private pair: LocalPair | null = null;
  /** Open STT sessions and sentences being synthesised on the current pair. */
  private using = 0;

  constructor(private readonly opts: LocalVoiceOptions) {
    const refuse = () => this.opts.blocked?.() ?? null;
    this.stt = {
      name: "faster-whisper",
      kind: "local",
      isAvailable: async () => {
        const why = refuse();
        return why ? { ok: false, reason: why } : this.current().stt.isAvailable();
      },
      start: (o: SttStartOptions): SttSession => {
        const why = refuse();
        if (why) throw new ForerunnerError("unavailable", why);
        return this.tracked(this.current().stt.start(o));
      },
    };
    const self = this;
    this.tts = {
      name: "kokoro",
      kind: "local",
      isAvailable: async () => {
        const why = refuse();
        return why ? { ok: false, reason: why } : this.current().tts.isAvailable();
      },
      synthesize: async function* (text: string, o?: TtsOptions) {
        const why = refuse();
        if (why) throw new ForerunnerError("unavailable", why);
        const inner = self.current().tts;
        self.using++;
        try {
          yield* inner.synthesize(text, o);
        } finally {
          self.using--;
        }
      },
    };
  }

  /** Sessions and sentences in flight on the local helpers (a switch waits for none). */
  inUse(): number {
    return this.using;
  }

  settings(): LocalVoiceSettings | null {
    return localVoiceSettings(this.opts);
  }

  /**
   * The helpers for the profile in force. When voice.json changed they are rebuilt and the old
   * ones stopped, but not while a session or a sentence still uses them: the change waits
   * until that ends (the old helpers keep serving it), so nothing is cut off mid-utterance.
   */
  current(): LocalPair {
    const s = this.settings();
    const key = JSON.stringify(s);
    if (this.pair && (key === this.key || this.using > 0)) return this.pair;
    const old = this.pair;
    this.pair = this.build(s);
    this.key = key;
    if (old) void this.stop(old);
    return this.pair;
  }

  /** Stop the running helpers (before their venv is deleted); the next use starts new ones. */
  async release(): Promise<void> {
    const old = this.pair;
    this.pair = null;
    this.key = null;
    if (old) await this.stop(old);
  }

  /** Counts a session as in use until it is closed or its events end. */
  private tracked(session: SttSession): SttSession {
    this.using++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.using--;
    };
    const events = session.events;
    return {
      push: (c) => session.push(c),
      endOfSpeech: () => session.endOfSpeech(),
      close: async () => {
        try {
          await session.close();
        } finally {
          finish();
        }
      },
      events: {
        async *[Symbol.asyncIterator]() {
          try {
            yield* events;
          } finally {
            finish();
          }
        },
      },
    };
  }

  private async stop(pair: LocalPair): Promise<void> {
    await Promise.all([pair.stt.dispose?.(), pair.tts.dispose?.()]);
  }

  private build(s: LocalVoiceSettings | null): LocalPair {
    if (s?.off) return offPair(s.off);
    const env = this.opts.env;
    const model = env.FORERUNNER_WHISPER_MODEL?.trim() || undefined;
    const voice = env.FORERUNNER_KOKORO_VOICE?.trim() || undefined;
    const factory = this.opts.factory ?? defaultLocalFactory;
    if (!s)
      return factory({
        clock: this.opts.clock,
        env,
        stt: { model, extraArgs: [] },
        tts: { voice, extraArgs: [] },
      });
    return factory({
      clock: this.opts.clock,
      env: { ...env, ...s.env },
      ...(s.python ? { python: s.python } : {}),
      stt: {
        model,
        device: s.stt.device,
        computeType: s.stt.computeType,
        extraArgs: s.stt.cpuFallback ? ["--cpu-fallback"] : [],
      },
      tts: {
        voice,
        extraArgs: ["--device", s.tts.device, ...(s.tts.cpuFallback ? ["--cpu-fallback"] : [])],
      },
    });
  }
}
