#!/usr/bin/env -S pnpm exec tsx
/**
 * voice-run: the reusable halves of a real-audio voice run (phase 5 gate row "Voice first audio
 * on real audio devices, Windows and Linux", requirement D.8: first audio under 1.2 s). A human
 * speaks push-to-talk turns into the UI against `fr daemon` with the local providers; this
 * script checks the machine beforehand and reads the measured turns back afterwards.
 *
 *   tsx scripts/voice-run.ts check
 *       Are the local STT (faster-whisper) and TTS (Kokoro, or Piper with FORERUNNER_PIPER_MODEL)
 *       providers available, as the daemon's own registry probes them? Node, Python and the
 *       packages, and the install commands for what is missing (nothing is installed).
 *       Exit 0 when voice can run on local providers, 1 otherwise.
 *   tsx scripts/voice-run.ts report [--since <iso>] [--exclude-first <n>]
 *       One line per `voice.turn` row since --since (default: the last 24 h) with the latency
 *       stages the row records, then n, median and p90 of first audio against the voice_chat
 *       target and a final `VOICE RESULT:` line. Two first-audio figures: the daemon-side one
 *       (`totalToFirstAudioMs`, taken where the daemon's paced sink gets the first chunk) and
 *       the heard one (`heardFirstAudioMs`, posted by the conversation panel's player: the
 *       press release to its first chunk at the speaker, so the SSE hop, decoding, scheduling
 *       and the output device are in it). The result is decided on the heard figure when any
 *       counted turn has one, else on the daemon-side figure, and the line says which.
 *       --exclude-first <n> leaves out the first n audio turns of the whole window (all voice
 *       sessions together, in time order; typed turns and text replies do not count towards
 *       n): one warm-up per daemon start means passing the number of starts, not 1 per session.
 *       Turns replied in text (the panel's "Reply: text", `replyMode: "text"` on the row: no
 *       TTS, no audio) have no first audio and are left out of both figures, and the report
 *       says how many.
 *       Exit 0 when the median is within the target, 2 when it is not (or no turn was
 *       measured), 1 on a refusal or an error.
 *
 * Both refuse to run without FORERUNNER_HOME: the run keeps its config, store and vault profile
 * apart from the everyday install, and `report` reads only a SQLite store inside that home.
 * Transcripts (`said`, `heard`, `unspokenText`), error messages and audio are never printed:
 * the rows hold what the human said, so only numbers, the turn's source and codes leave them.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appDirs,
  type Clock,
  currentPlatform,
  errorMessage,
  isInside,
  join,
  type Platform,
  resolve,
  systemClock,
} from "@forerunner/platform";
import { MODE_DEFAULTS } from "../packages/runtime/src/models/ladder.ts";
import { readConfig } from "../packages/runtime/src/setup/wizard.ts";
import {
  detectNvidiaGpu,
  readVoiceSettings,
  recommendedProfile,
} from "../packages/runtime/src/voice/install.ts";
import type { GpuView, VoiceProfile } from "../packages/runtime/src/voice/install-types.ts";
import { LocalVoice } from "../packages/runtime/src/voice/local-profile.ts";
import { DEFAULT_LATENCY_TARGETS } from "../packages/runtime/src/voice/pkg.ts";
import {
  buildVoiceRegistry,
  VOICE_PREFERENCE_ENV,
} from "../packages/runtime/src/voice/providers.ts";
import {
  ENTITIES,
  type EntityDef,
  type EventRow,
  openStore,
  parseStoreUrl,
  Repository,
  type StateStore,
} from "../packages/state/src/index.ts";
import { MemoryVault } from "../packages/vault/src/memory.ts";
import {
  type ProviderStatus,
  pythonRun,
  type VoiceProviderRegistry,
} from "../packages/voice/src/index.ts";

export type Out = (line: string) => void;

export const NODE_MIN = [22, 13] as const;
/** kokoro 0.9.4 declares `requires_python >=3.10,<3.13` (PyPI metadata, 2026-10-25). */
export const KOKORO_PYTHON = { min: [3, 10], below: [3, 13] } as const;
/** The voice_chat mode's response target (spec D.8): first audio, in ms. */
export const FIRST_AUDIO_TARGET_MS = MODE_DEFAULTS.voice_chat.targetMs;

/** The refusal both subcommands give without a dedicated home; null when one is set. */
export function dedicatedHome(env: NodeJS.ProcessEnv): string | null {
  const h = env.FORERUNNER_HOME?.trim();
  return h ? resolve(h) : null;
}

const REFUSE_HOME =
  "voice-run: refusing to run without FORERUNNER_HOME. Set it to a directory used only for this run " +
  "(for example %USERPROFILE%\\forerunner-voice-run or ~/forerunner-voice-run) so its config, store " + // path-ok an example shown to the human, not a path the script builds
  "and vault profile stay apart from the everyday install.";

// ---------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------

export interface PythonFacts {
  /** The interpreter that ran (`FORERUNNER_PYTHON` first, then the OS candidates); null when none. */
  python: string | null;
  version: string | null;
  reason: string;
}

export interface CheckDeps {
  env: NodeJS.ProcessEnv;
  out: Out;
  platform?: Platform;
  nodeVersion?: string;
  /** The daemon's registry over an empty vault by default (no cloud key: local or nothing). */
  registry?: VoiceProviderRegistry;
  python?: () => Promise<PythonFacts>;
  /** The NVIDIA GPU (nvidia-smi by default). */
  gpu?: () => Promise<GpuView>;
}

export interface CheckResult {
  ok: boolean;
  stt: string | null;
  tts: string | null;
  missing: string[];
  commands: string[];
  /** The voice profile of this home (ADR 0090); null when none was chosen. */
  profile: VoiceProfile | null;
  /** The devices the profile's last check verified. */
  devices: { stt: string; tts: string } | null;
}

function versionAtLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

const parseVersion = (s: string | null): number[] =>
  (s ?? "")
    .replace(/^v/, "")
    .split(".")
    .map((x) => Number.parseInt(x, 10))
    .filter((x) => Number.isFinite(x));

async function defaultPython(env: NodeJS.ProcessEnv): Promise<PythonFacts> {
  const r = await pythonRun("import sys; print('%d.%d.%d' % sys.version_info[:3])", { env });
  if (r.python === null) return { python: null, version: null, reason: r.stderr.trim() };
  if (r.code !== 0)
    return { python: r.python, version: null, reason: r.stderr.trim() || `exit ${r.code}` };
  return { python: r.python, version: r.stdout.trim(), reason: "runs" };
}

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

function statusLine(s: ProviderStatus): string {
  return `  ${s.selected ? "*" : " "} ${s.name.padEnd(15)} ${s.kind.padEnd(6)} ${s.available ? "available  " : "unavailable"} ${s.reason}`;
}

/** `check`: what the daemon would pick for voice on this machine, and what to install. */
export async function runCheck(deps: CheckDeps): Promise<CheckResult> {
  const { env, out } = deps;
  const platform = deps.platform ?? currentPlatform();
  const home = dedicatedHome(env);
  if (!home) {
    out(REFUSE_HOME);
    return {
      ok: false,
      stt: null,
      tts: null,
      missing: ["FORERUNNER_HOME"],
      commands: [],
      profile: null,
      devices: null,
    };
  }
  out(`voice-run check (FORERUNNER_HOME=${home}, ${platform})`);
  const missing: string[] = [];
  const commands: string[] = [];

  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const nodeOk = versionAtLeast(parseVersion(nodeVersion), NODE_MIN);
  out(`${nodeOk ? "ok " : "!! "} node            ${nodeVersion} (needs >= ${NODE_MIN.join(".")})`);
  if (!nodeOk) {
    missing.push("node");
    commands.push(
      platform === "windows"
        ? "winget install -e --id OpenJS.NodeJS.LTS"
        : "install Node.js 22.13 or later (https://nodejs.org or your distribution's nodejs package)",
    );
  }

  const py = await (deps.python ?? (() => defaultPython(env)))();
  const pyVersion = parseVersion(py.version);
  out(
    `${py.version ? "ok " : "!! "} python          ${py.version ? `${py.version} (${py.python})` : `not found: ${py.reason}`}${env.FORERUNNER_PYTHON ? " [FORERUNNER_PYTHON]" : ""}`,
  );

  // The voice profile (ADR 0090): what `fr voice install` put in this home and verified.
  const dirs = appDirs({ env });
  const voice = readVoiceSettings(dirs);
  const gpu = await (deps.gpu ?? (() => detectNvidiaGpu({ platform })))();
  out(
    `${gpu.present ? "ok " : "-- "} gpu             ${gpu.present ? `${gpu.name ?? "NVIDIA"}${gpu.driver ? `, driver ${gpu.driver}` : ""}` : `none (${gpu.reason})`}`,
  );
  const managed = `pnpm fr -- voice install --${recommendedProfile(gpu)}`;
  if (!voice) {
    out(
      `--  voice profile   not chosen (local voice uses the Python found below; for the managed venv with pinned packages: ${managed})`,
    );
  } else {
    out(
      `${voice.profile === "none" ? "!! " : "ok "} voice profile   ${voice.profile}${voice.profile === "none" ? " (local voice is off: pnpm fr -- voice install --cpu|--gpu)" : ""}`,
    );
    if (voice.install) out(`--  venv python     ${voice.install.python}`);
  }
  const verified = voice && voice.profile !== "none" ? voice.verified : undefined;
  const devices = verified ? { stt: verified.stt.device, tts: verified.tts.device } : null;
  if (verified) {
    const fellBack = [verified.stt.fallback, verified.tts.fallback].filter((f): f is string => !!f);
    out(
      `${fellBack.length ? "!! " : "ok "} devices         speech recognition ${verified.stt.device}${verified.stt.computeType ? ` (${verified.stt.computeType})` : ""}, speech ${verified.tts.device} (verified ${verified.at})`,
    );
    for (const f of fellBack)
      out(
        `note: the GPU check fell back to the CPU: ${f} (fix the driver, then pnpm fr -- voice install --gpu)`,
      );
  } else if (voice && voice.profile !== "none") {
    out(`!!  devices         not verified (pnpm fr -- voice install --${voice.profile})`);
  }

  const registry =
    deps.registry ??
    buildVoiceRegistry({
      env,
      vault: new MemoryVault(),
      clock: systemClock,
      local: new LocalVoice({ dirs, env, clock: systemClock, platform }),
    });
  const overrides = (["stt", "tts"] as const)
    .map((side) => ({ side, name: env[VOICE_PREFERENCE_ENV[side]]?.trim() }))
    .filter((o): o is { side: "stt" | "tts"; name: string } => !!o.name);
  const pick = async (side: "stt" | "tts") => {
    const preferred = overrides.find((o) => o.side === side)?.name;
    const input = {
      ...(preferred ? { preferred, preferredBy: `set by ${VOICE_PREFERENCE_ENV[side]}` } : {}),
      hasSecret: () => false,
    };
    try {
      const sel =
        side === "stt" ? await registry.selectStt(input) : await registry.selectTts(input);
      return { statuses: sel.statuses, name: sel.name, kind: sel.kind, reason: sel.reason };
    } catch (e) {
      const statuses =
        side === "stt" ? await registry.statusStt(input) : await registry.statusTts(input);
      return { statuses, name: null, kind: null, reason: errorMessage(e) };
    }
  };
  const stt = await pick("stt");
  const tts = await pick("tts");
  const row = (rows: ProviderStatus[], name: string) => rows.find((s) => s.name === name);
  const whisper = row(stt.statuses, "faster-whisper");
  const kokoro = row(tts.statuses, "kokoro");
  const piper = row(tts.statuses, "piper");
  out(
    `${whisper?.available ? "ok " : "!! "} faster_whisper  ${whisper ? whisper.reason : "not registered"}`,
  );
  out(
    `${kokoro?.available ? "ok " : "!! "} kokoro          ${kokoro ? kokoro.reason : "not registered"}`,
  );
  out(
    `${piper?.available ? "ok " : "-- "} piper           ${piper ? piper.reason : "not configured (optional; set FORERUNNER_PIPER_MODEL to a voice .onnx with its .onnx.json beside it and put piper on PATH)"}`,
  );
  out("stt providers (* = the one the daemon picks):");
  for (const s of stt.statuses) out(statusLine(s));
  out("tts providers (* = the one the daemon picks):");
  for (const s of tts.statuses) out(statusLine(s));
  for (const o of overrides)
    out(`note: ${VOICE_PREFERENCE_ENV[o.side]}=${o.name} overrides the pick`);
  const sttLocal = stt.kind === "local";
  const ttsLocal = tts.kind === "local";
  out(
    `${sttLocal ? "ok " : "!! "} stt picked      ${stt.name ? `${stt.name} (${stt.kind}): ${stt.reason}` : `none: ${stt.reason}`}`,
  );
  out(
    `${ttsLocal ? "ok " : "!! "} tts picked      ${tts.name ? `${tts.name} (${tts.kind}): ${tts.reason}` : `none: ${tts.reason}`}`,
  );

  // What to install: Python, then the packages into one interpreter (a venv under the home).
  const venvPython = join(
    home,
    "voice-venv",
    ...(platform === "windows" ? ["Scripts", "python.exe"] : ["bin", "python"]),
  );
  const packages: string[] = [];
  if (!whisper?.available) packages.push("faster-whisper");
  if (!ttsLocal && !kokoro?.available) packages.push("kokoro");
  const kokoroPythonOk =
    pyVersion.length > 0 &&
    versionAtLeast(pyVersion, KOKORO_PYTHON.min) &&
    !versionAtLeast(pyVersion, KOKORO_PYTHON.below);
  if (!py.version) {
    missing.push("python");
    commands.push(
      platform === "windows"
        ? "winget install -e --id Python.Python.3.12   (then open a new terminal)"
        : "sudo apt-get install -y python3 python3-venv python3-pip   (Debian/Ubuntu; Python 3.10 to 3.12 for kokoro)",
    );
  }
  if (packages.length) {
    missing.push(...packages.map((p) => p.replace("-", "_")));
    if (env.FORERUNNER_PYTHON && py.version && (kokoroPythonOk || !packages.includes("kokoro"))) {
      commands.push(
        `${quote(py.python ?? env.FORERUNNER_PYTHON)} -m pip install ${packages.join(" ")}`,
      );
    } else {
      const base =
        platform === "windows"
          ? "py -3.12"
          : py.version && kokoroPythonOk
            ? quote(py.python ?? "python3")
            : "python3.12";
      if (py.version && !kokoroPythonOk && packages.includes("kokoro"))
        out(
          `note: kokoro needs Python ${KOKORO_PYTHON.min.join(".")} to below ${KOKORO_PYTHON.below.join(".")}; ${py.version} found, so the venv below is made with 3.12`,
        );
      commands.push(`${base} -m venv ${quote(join(home, "voice-venv"))}`);
      commands.push(`${quote(venvPython)} -m pip install ${packages.join(" ")}`);
      commands.push(
        platform === "windows"
          ? `set FORERUNNER_PYTHON=${venvPython}`
          : `export FORERUNNER_PYTHON=${quote(venvPython)}`,
      );
    }
  }
  if (!sttLocal || !ttsLocal) {
    if (!sttLocal && !missing.includes("faster_whisper")) missing.push("stt");
    if (!ttsLocal && !missing.includes("kokoro")) missing.push("tts");
  }

  // Setup state of the dedicated home, for information (voice also needs the model key).
  const config = readConfig(dirs);
  out(
    config
      ? `-- setup          config present (profile ${config.profile}); Anthropic credential recorded: ${config.credentials?.anthropic ? "yes" : "no"}`
      : "-- setup          not set up yet in this home (fr setup --non-interactive --profile voice-run; the key from FORERUNNER_ANTHROPIC_KEY)",
  );

  const ok = nodeOk && !!py.version && sttLocal && ttsLocal;
  if (commands.length) {
    out("install (nothing was installed):");
    for (const c of commands) out(`  ${c}`);
    out(
      "first use downloads the models: faster-whisper base (about 150 MB) and Kokoro-82M with its voice (about 330 MB) from Hugging Face",
    );
    out(`or the managed install (venv, pinned packages, models, device check): ${managed}`);
  }
  out(ok ? "VOICE CHECK: ok" : `VOICE CHECK: not ready (${[...new Set(missing)].join(", ")})`);
  return {
    ok,
    stt: stt.name,
    tts: tts.name,
    missing: [...new Set(missing)],
    commands,
    profile: voice?.profile ?? null,
    devices,
  };
}

// ---------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------

/** The stages a `voice.turn` row records, named as in packages/voice/src/latency.ts. */
export const STAGES = [
  { key: "endOfTurnMs", target: DEFAULT_LATENCY_TARGETS.endOfTurnMs },
  { key: "finalTranscriptMs", target: DEFAULT_LATENCY_TARGETS.finalTranscriptMs },
  { key: "modelFirstTokenMs", target: DEFAULT_LATENCY_TARGETS.modelFirstTokenMs },
  { key: "firstAudioMs", target: DEFAULT_LATENCY_TARGETS.firstAudioMs },
  { key: "firstSentenceMs", target: null },
  { key: "ttsFirstByteMs", target: null },
] as const;
export type StageKey = (typeof STAGES)[number]["key"];

export interface TurnSample {
  at: string;
  /** The voice session that wrote the row (rows from before it was recorded have none). */
  voiceSessionId: string | null;
  turn: number | null;
  source: string;
  /** How the reply went out; rows written before the mode was recorded were spoken. */
  replyMode: "voice" | "text";
  totalToFirstAudioMs: number | null;
  /** What the human heard, from the row or a later `voice.heard` row of the same turn. */
  heardFirstAudioMs: number | null;
  stages: Record<StageKey, number | null>;
  withinTarget: boolean | null;
  interrupted: boolean;
  errorCode: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** An id as the runtime makes them (never free text). */
const idOf = (v: unknown): string | null =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;

/** Numbers, the source and codes only: never `said`, `heard`, `unspokenText` or a message. */
export function turnSample(e: Pick<EventRow, "created_at" | "payload">): TurnSample {
  const p = obj(e.payload);
  const l = obj(p.latency);
  const stages = {} as Record<StageKey, number | null>;
  for (const s of STAGES) stages[s.key] = num(l[s.key]);
  const code = obj(p.error).code;
  return {
    at: e.created_at,
    voiceSessionId: idOf(p.voiceSessionId),
    turn: num(p.turn),
    source: typeof p.source === "string" && /^[a-z_]{1,16}$/.test(p.source) ? p.source : "unknown",
    replyMode: p.replyMode === "text" ? "text" : "voice",
    totalToFirstAudioMs: num(l.totalToFirstAudioMs),
    heardFirstAudioMs: num(l.heardFirstAudioMs),
    stages,
    withinTarget: typeof l.withinTarget === "boolean" ? l.withinTarget : null,
    interrupted: p.interrupted === true,
    errorCode: typeof code === "string" && /^[a-z_.]{1,40}$/.test(code) ? code : null,
  };
}

/** The median as the phase 5 gate takes it (`medianTotalToFirstAudio`: mean of the middle two). */
export function median(values: readonly number[]): number | null {
  const xs = [...values].sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1
    ? (xs[mid] as number)
    : ((xs[mid - 1] as number) + (xs[mid] as number)) / 2;
}

/**
 * p90 by nearest rank, the rule the /performance view uses (`nearestRank`). Only the rule:
 * /performance counts every turn of its window (typed and warm-up turns too), so its voice p90
 * is over a different set of turns than this report's.
 */
export function p90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const xs = [...values].sort((a, b) => a - b);
  const rank = Math.min(xs.length, Math.max(1, Math.ceil(0.9 * xs.length)));
  return xs[rank - 1] ?? null;
}

const ms = (v: number | null): string => (v === null ? "-" : String(Math.round(v)));

export interface ReportDeps {
  env: NodeJS.ProcessEnv;
  out: Out;
  argv: string[];
  clock?: Clock;
  /** Opens the store; the dedicated home's SQLite file by default. */
  open?: (url: string) => Promise<StateStore>;
}

export interface ReportResult {
  code: 0 | 1 | 2;
  /** Which figure decided: what the player heard, or the daemon-side one when none was posted. */
  basis: "heard" | "daemon-side";
  n: number;
  median: number | null;
  p90: number | null;
  met: boolean;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? "" : v;
}

/** The store of the dedicated home: its config's (or FORERUNNER_STATE_URL's) SQLite file. */
export function homeStoreUrl(env: NodeJS.ProcessEnv, home: string): string {
  const dirs = appDirs({ env });
  const url =
    env.FORERUNNER_STATE_URL ??
    readConfig(dirs)?.stateUrl ??
    `sqlite:${join(dirs.data, "state.sqlite")}`;
  const parsed = parseStoreUrl(url);
  if (parsed.dialect !== "sqlite" || parsed.location === ":memory:")
    throw new Error(
      "voice-run: refusing: the run's store is not a SQLite file (a shared store is not a dedicated run home)",
    );
  if (!isInside(home, resolve(parsed.location)))
    throw new Error(
      `voice-run: refusing: the store ${parsed.location} is outside FORERUNNER_HOME (${home}); use a home whose config keeps its own store`,
    );
  if (!existsSync(parsed.location))
    throw new Error(
      `voice-run: no store yet at ${parsed.location} (start the daemon in this home and speak first)`,
    );
  return url;
}

/** `report`: the measured turns of the window and the result line. */
export async function runReport(deps: ReportDeps): Promise<ReportResult> {
  const { env, out, argv } = deps;
  const fail = (line: string): ReportResult => {
    out(line);
    return { code: 1, basis: "daemon-side", n: 0, median: null, p90: null, met: false };
  };
  const home = dedicatedHome(env);
  if (!home) return fail(REFUSE_HOME);
  const clock = deps.clock ?? systemClock;
  const sinceArg = flag(argv, "--since");
  const since =
    sinceArg === undefined
      ? new Date(Date.parse(clock.nowIso()) - 86_400_000).toISOString()
      : sinceArg;
  if (!since || Number.isNaN(Date.parse(since)))
    return fail(`voice-run: --since needs an ISO-8601 time, got ${JSON.stringify(sinceArg ?? "")}`);
  const sinceIso = new Date(Date.parse(since)).toISOString();
  const excludeArg = flag(argv, "--exclude-first");
  const exclude = excludeArg === undefined ? 0 : Number(excludeArg);
  if (!Number.isInteger(exclude) || exclude < 0)
    return fail(
      `voice-run: --exclude-first needs a whole number, got ${JSON.stringify(excludeArg)}`,
    );

  let rows: EventRow[];
  try {
    const url = homeStoreUrl(env, home);
    const store = await (deps.open ?? ((u: string) => openStore({ url: u, migrate: false })))(url);
    try {
      rows = await new Repository<EventRow>(
        store.event.db,
        ENTITIES.event as EntityDef,
        store.event.clock,
      ).rows(
        `SELECT * FROM "event" WHERE "type" IN (?, ?) AND "created_at" >= ? ORDER BY "created_at", "id"`,
        ["voice.turn", "voice.heard", sinceIso],
      );
    } finally {
      await store.close().catch(() => undefined);
    }
  } catch (e) {
    return fail(errorMessage(e));
  }

  // A heard figure that arrived after its turn's row was written is a `voice.heard` row of the
  // same conversation session, voice session and turn, written after it.
  const samples: TurnSample[] = [];
  const byKey = new Map<string, TurnSample>();
  const key = (sessionId: string, vs: string | null, turn: number | null) =>
    vs === null || turn === null ? null : `${sessionId}|${vs}|${turn}`;
  for (const row of rows) {
    if (row.type === "voice.turn") {
      const sample = turnSample(row);
      samples.push(sample);
      const k = key(row.session_id, sample.voiceSessionId, sample.turn);
      if (k) byKey.set(k, sample);
      continue;
    }
    const p = obj(row.payload);
    const k = key(row.session_id, idOf(p.voiceSessionId), num(p.turn));
    const target = k ? byKey.get(k) : undefined;
    const heard = num(p.heardFirstAudioMs);
    if (target && target.heardFirstAudioMs === null && heard !== null)
      target.heardFirstAudioMs = heard;
  }
  out(
    `voice-run report (FORERUNNER_HOME=${home}) voice.turn rows since ${sinceIso}: ${samples.length}`,
  );
  const measured: TurnSample[] = [];
  let audioSeen = 0;
  let typed = 0;
  let textReplies = 0;
  let warmup = 0;
  let unmeasured = 0;
  // Only worth saying per turn when the run has heard figures at all.
  const anyHeard = samples.some((s) => s.heardFirstAudioMs !== null);
  for (const s of samples) {
    let note = "";
    if (s.source !== "audio") {
      typed++;
      note = " [not counted: typed turn]";
    } else if (s.replyMode === "text") {
      // Nothing was spoken: no first audio to measure, whatever the row carries.
      textReplies++;
      note = " [not counted: text reply, nothing spoken]";
    } else if (audioSeen++ < exclude) {
      warmup++;
      note = " [not counted: warm-up]";
    } else if (s.totalToFirstAudioMs === null) {
      unmeasured++;
      note = " [not counted: no first audio]";
    } else {
      measured.push(s);
      if (anyHeard && s.heardFirstAudioMs === null) note = " [no heard figure: daemon-side only]";
    }
    const stages = STAGES.map((st) => `${st.key}=${ms(s.stages[st.key])}`).join(" ");
    out(
      `${s.at} turn=${s.turn ?? "-"} source=${s.source} totalToFirstAudioMs=${ms(s.totalToFirstAudioMs)} heardFirstAudioMs=${ms(s.heardFirstAudioMs)} ${stages} within=${s.withinTarget === null ? "-" : s.withinTarget ? "yes" : "no"}${s.interrupted ? " interrupted" : ""}${s.replyMode === "text" ? " reply=text" : ""}${s.errorCode ? ` error=${s.errorCode}` : ""}${note}`,
    );
  }
  const target = FIRST_AUDIO_TARGET_MS;
  const targetNote = `target=${target} (MODE_DEFAULTS.voice_chat, ${MODE_DEFAULTS.voice_chat.targetKind})`;
  const summary = (xs: number[]) => {
    const m = median(xs);
    const q = p90(xs);
    return {
      n: xs.length,
      median: m,
      p90: q,
      met: m !== null && m <= target,
      line: `n=${xs.length} median=${ms(m)} p90=${ms(q)} ${targetNote}; median within target: ${m !== null && m <= target ? "yes" : "no"}; p90 within target: ${q !== null && q <= target ? "yes" : "no"}${xs.length > 0 && xs.length < 10 ? "; fewer than 10 turns" : ""}`,
    };
  };
  const daemon = summary(measured.map((s) => s.totalToFirstAudioMs as number));
  const heardTurns = measured.filter((s) => s.heardFirstAudioMs !== null);
  const heard = summary(heardTurns.map((s) => s.heardFirstAudioMs as number));
  out(
    `turns: ${samples.length} in the window; ${measured.length} counted; ${typed} typed, ${textReplies > 0 ? `${textReplies} text ${textReplies === 1 ? "reply" : "replies"}, ` : ""}${warmup} warm-up, ${unmeasured} without first audio left out`,
  );
  if (textReplies > 0)
    out(
      `text replies (reply mode text: no TTS, no audio) have no first audio and are left out of both first-audio figures: ${textReplies}`,
    );
  out(
    `first audio, daemon-side (totalToFirstAudioMs, measured where the daemon's paced sink takes the first chunk; the SSE hop, decoding, scheduling and the output device come after it): ${daemon.line}`,
  );
  out(
    heardTurns.length === 0
      ? "first audio, heard (heardFirstAudioMs): none recorded (no player posted one: the result is the daemon-side figure)"
      : `first audio, heard (heardFirstAudioMs, the panel's player: the press release to its first chunk at the speaker): ${heard.line}${heardTurns.length < measured.length ? `; ${measured.length - heardTurns.length} of ${measured.length} counted turns have no heard figure and are left out of it` : ""}`,
  );
  out(
    `stage medians: ${STAGES.map((st) => {
      const xs = measured.map((s) => s.stages[st.key]).filter((x): x is number => x !== null);
      return `${st.key}=${ms(median(xs))}${st.target === null ? "" : `/${st.target}`}`;
    }).join(" ")}`,
  );
  const basis: ReportResult["basis"] = heardTurns.length > 0 ? "heard" : "daemon-side";
  const result = basis === "heard" ? heard : daemon;
  out(
    `VOICE RESULT: n=${result.n} median=${ms(result.median)} p90=${ms(result.p90)} target=${target} ${result.met ? "met" : "not met"} (${basis} first audio)`,
  );
  return {
    code: result.met ? 0 : 2,
    basis,
    n: result.n,
    median: result.median,
    p90: result.p90,
    met: result.met,
  };
}

// ---------------------------------------------------------------------------------------------

export async function main(argv: string[], env: NodeJS.ProcessEnv, out: Out): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "check") return (await runCheck({ env, out })).ok ? 0 : 1;
  if (cmd === "report") return (await runReport({ env, out, argv: rest })).code;
  out(
    "usage: tsx scripts/voice-run.ts check | report [--since <iso>] [--exclude-first <n>]  (n: the first n audio turns of the whole window, all sessions together)",
  );
  return 1;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // exitCode, not exit(): stdout is a pipe in the gate run and exit() can cut it off unflushed.
  main(process.argv.slice(2), process.env, (line) => console.log(line)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`voice-run: ${errorMessage(e)}`);
      process.exitCode = 1;
    },
  );
}
