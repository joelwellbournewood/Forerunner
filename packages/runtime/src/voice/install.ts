/**
 * The local voice stack's installer (ADR 0089): `fr voice install [--cpu|--gpu]`,
 * `fr voice remove`, `fr setup --voice`, and the daemon's `POST /voice/install` all run this.
 *
 * A profile is a managed venv under the data directory (`<data>/voice/venv-<profile>`, one per
 * profile, so a switch never rewrites the interpreter a running helper uses), the pinned
 * `packages/voice/python/requirements-<profile>.txt`, the models in `<data>/voice/models`
 * (HF_HOME for the helpers), and a verify run of both helpers on the profile's device. What is
 * installed and verified is written to `<config>/voice.json`, which the daemon's local
 * providers read at every use (local-profile.ts).
 *
 * Long and network-heavy, so: every step streams progress events; a venv that runs and a
 * marker that matches the pins are reused (a second run only verifies); pip resumes broken
 * downloads (`--resume-retries`) and keeps its cache; the models are fetched by
 * fr_voice_models.py, which skips what is cached; the marker and voice.json are written only
 * after the step succeeded, so an interrupted run is finished by running it again. Nothing
 * here takes a secret: the models are public and no argument carries a credential.
 *
 * The GPU check runs the helpers on cuda without --cpu-fallback, so a CUDA failure is seen.
 * It then falls back loudly: a warning naming the error, the CPU verified instead, the reason
 * recorded in voice.json (the card and `fr voice status` show it), exit code 2.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  type AppDirs,
  type Clock,
  currentPlatform,
  dirname,
  errorMessage,
  ForerunnerError,
  join,
  killTree,
  type Platform,
  spawnProcess,
  systemClock,
} from "@forerunner/platform";
import {
  DEFAULT_STT_HELPER,
  encodeInFrame,
  FrameReader,
  interpreterDidNotRun,
  STT_IN,
  TTS_IN,
  TTS_OUT,
} from "@forerunner/voice";
import {
  type GpuView,
  VOICE_PROFILE_INFO,
  VOICE_PROFILES,
  type VoiceDeviceView,
  type VoiceInstallEvent,
  type VoiceProfile,
  voiceInstallCommand,
} from "./install-types.ts";

export { voiceInstallCommand } from "./install-types.ts";

/** pip inside the venv: 25.1+ resumes interrupted downloads (`--resume-retries`). */
export const PIP_VERSION = "26.2.2";
/** kokoro 0.9.4 declares `requires_python >=3.10,<3.13`. */
export const VOICE_PYTHON = { min: [3, 10], below: [3, 13] } as const;
/** packages/voice/python: the helpers, the model fetcher and the requirements files. */
export const DEFAULT_HELPERS_DIR = dirname(DEFAULT_STT_HELPER);

export type InstalledProfile = Exclude<VoiceProfile, "none">;

// ---------------------------------------------------------------------------------------------
// Paths and the settings file
// ---------------------------------------------------------------------------------------------

export interface VoiceDirs {
  root: string;
  models: string;
  venv(profile: InstalledProfile): string;
  /** `<config>/voice.json`: the profile and what was installed and verified. */
  settings: string;
  lock: string;
}

export function voiceDirs(dirs: AppDirs): VoiceDirs {
  const root = join(dirs.data, "voice");
  return {
    root,
    models: join(root, "models"),
    venv: (profile) => join(root, `venv-${profile}`),
    settings: join(dirs.config, "voice.json"),
    lock: join(root, "install.lock"),
  };
}

export function venvPythonPath(venv: string, platform: Platform = currentPlatform()): string {
  return platform === "windows" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
}

export function requirementsFile(
  profile: InstalledProfile,
  helpersDir = DEFAULT_HELPERS_DIR,
): string {
  return join(helpersDir, `requirements-${profile}.txt`);
}

export interface VoiceSettings {
  version: 1;
  profile: VoiceProfile;
  updatedAt: string;
  install?: {
    venv: string;
    python: string;
    pythonVersion: string;
    requirementsSha256: string;
    installedAt: string;
  };
  verified?: { at: string; stt: VoiceDeviceView; tts: VoiceDeviceView };
  gpu?: { name: string | null; driver: string | null } | null;
}

export function readVoiceSettings(dirs: AppDirs): VoiceSettings | null {
  const p = voiceDirs(dirs).settings;
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as VoiceSettings;
    return v && (VOICE_PROFILES as readonly string[]).includes(v.profile) ? v : null;
  } catch {
    return null;
  }
}

export function writeVoiceSettings(dirs: AppDirs, settings: VoiceSettings): void {
  const p = voiceDirs(dirs).settings;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(settings, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

export interface VoiceProcRequest {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  /** Bytes for stdin (the helpers' frames); stdin is closed after. */
  input?: Buffer;
  timeoutMs?: number;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (text: string) => void;
  signal?: AbortSignal;
}

export interface VoiceProcResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** The process never started (ENOENT): the message. */
  error?: string;
}

export type VoiceProcRunner = (req: VoiceProcRequest) => Promise<VoiceProcResult>;

const STDOUT_KEEP = 4 * 1024 * 1024;
const STDERR_KEEP = 64 * 1024;

/** Spawns through the platform runner (argv, never a shell); output is streamed and capped. */
export const defaultVoiceRunner: VoiceProcRunner = (req) =>
  new Promise((resolveRun) => {
    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(req.argv, { env: req.env });
    } catch (e) {
      resolveRun({ code: null, stdout: Buffer.alloc(0), stderr: "", error: errorMessage(e) });
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let settled = false;
    const finish = (r: VoiceProcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      resolveRun(r);
    };
    const timer = setTimeout(
      () => {
        killTree(child);
        err += `\ntimed out after ${Math.round((req.timeoutMs ?? 0) / 1000)} s`;
      },
      req.timeoutMs ?? 30 * 60_000,
    );
    const onAbort = () => killTree(child);
    req.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d: Buffer) => {
      req.onStdout?.(d);
      if (outBytes < STDOUT_KEEP) {
        out.push(d);
        outBytes += d.length;
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      req.onStderr?.(text);
      err = (err + text).slice(-STDERR_KEEP);
    });
    child.stdin?.on("error", () => {
      // the process exited before reading its input; the exit code says why
    });
    child.on("error", (e) =>
      finish({ code: null, stdout: Buffer.concat(out), stderr: err, error: errorMessage(e) }),
    );
    child.on("close", (code) => finish({ code, stdout: Buffer.concat(out), stderr: err }));
    if (req.input) child.stdin?.end(req.input);
    else child.stdin?.end();
  });

/** Feeds text chunks, calls back per complete line (\n or \r ended). */
class Lines {
  private buf = "";
  seen = false;
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: Buffer | string): void {
    this.seen = true;
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parts = this.buf.split(/\r\n|\r|\n/);
    this.buf = parts.pop() ?? "";
    for (const p of parts) if (p.trim()) this.onLine(p);
  }
  end(): void {
    if (this.buf.trim()) this.onLine(this.buf);
    this.buf = "";
  }
}

/** Progress events at most every 2% of a total (always the first and the last). */
class Throttle {
  private last = new Map<string, number>();
  constructor(private readonly out: (e: VoiceInstallEvent) => void) {}
  progress(what: string, bytes: number, total: number | null): void {
    const key = what;
    const pct = total ? Math.floor((bytes / total) * 50) : Math.floor(bytes / (25 * 1024 * 1024));
    const prev = this.last.get(key);
    const final = total !== null && bytes >= total;
    if (prev === pct && !final) return;
    this.last.set(key, pct);
    this.out({ type: "progress", what, bytes, total });
  }
}

const tail = (s: string, lines = 6) =>
  s
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .join("\n");

// ---------------------------------------------------------------------------------------------
// The GPU and Python
// ---------------------------------------------------------------------------------------------

export interface GpuDeps {
  run?: VoiceProcRunner;
  platform?: Platform;
  /** Linux: the driver's version file, read when nvidia-smi is missing. */
  procVersionFile?: string;
}

/** An NVIDIA GPU with a working driver: nvidia-smi (Windows and Linux), then the Linux driver file. */
export async function detectNvidiaGpu(deps: GpuDeps = {}): Promise<GpuView> {
  const run = deps.run ?? defaultVoiceRunner;
  const platform = deps.platform ?? currentPlatform();
  const r = await run({
    argv: [
      "nvidia-smi",
      "--query-gpu=name,driver_version,memory.total",
      "--format=csv,noheader,nounits",
    ],
    timeoutMs: 15_000,
  });
  if (r.code === 0) {
    const first =
      r.stdout
        .toString("utf8")
        .split(/\r?\n/)
        .find((l) => l.trim()) ?? "";
    const [name, driver, mem] = first.split(",").map((s) => s.trim());
    if (name) {
      const memoryMb = Number(mem);
      return {
        present: true,
        name,
        driver: driver || null,
        memoryMb: Number.isFinite(memoryMb) ? memoryMb : null,
        reason: "found by nvidia-smi",
      };
    }
  }
  const why = r.error
    ? "nvidia-smi not found (no NVIDIA driver)"
    : `nvidia-smi failed: ${tail(r.stderr, 1) || `exit ${r.code}`}`;
  const procFile = deps.procVersionFile ?? "/proc/driver/nvidia/version";
  if (platform === "linux" && existsSync(procFile)) {
    return {
      present: true,
      name: null,
      driver: null,
      memoryMb: null,
      reason: `NVIDIA driver loaded (${procFile}); ${why}`,
    };
  }
  return { present: false, name: null, driver: null, memoryMb: null, reason: why };
}

export function recommendedProfile(gpu: GpuView): InstalledProfile {
  return gpu.present ? "gpu" : "cpu";
}

const VERSION_CODE = "import sys; print('%d.%d.%d' % sys.version_info[:3])";

function parseVersion(s: string): number[] {
  return s
    .trim()
    .split(".")
    .map((x) => Number.parseInt(x, 10))
    .filter((x) => Number.isFinite(x));
}

export function pythonVersionOk(version: string): boolean {
  const [major = 0, minor = 0] = parseVersion(version);
  const [minMaj, minMin] = VOICE_PYTHON.min;
  const [belowMaj, belowMin] = VOICE_PYTHON.below;
  const atLeast = major > minMaj || (major === minMaj && minor >= minMin);
  const below = major < belowMaj || (major === belowMaj && minor < belowMin);
  return atLeast && below;
}

export function pythonCandidatesFor(platform: Platform): string[][] {
  return platform === "windows"
    ? [["py", "-3.12"], ["py", "-3.11"], ["py", "-3.10"], ["python"], ["python3"]]
    : [["python3.12"], ["python3.11"], ["python3.10"], ["python3"], ["python"]];
}

export function missingPythonMessage(platform: Platform, found: string[]): string {
  const install =
    platform === "windows"
      ? "  winget install -e --id Python.Python.3.12   (then open a new terminal)"
      : "  sudo apt-get install -y python3.12 python3.12-venv   (Debian/Ubuntu; elsewhere install Python 3.12 with its venv module)";
  return [
    `Local voice needs Python 3.10 to 3.12 (Kokoro does not run on 3.13 yet). ${found.length ? `Found only: ${found.join(", ")}.` : "No Python was found."}`,
    "Install Python 3.12:",
    install,
    "then run the install again, or point it at an interpreter with --python <path>.",
  ].join("\n");
}

export interface PythonDeps {
  run?: VoiceProcRunner;
  platform?: Platform;
  /** `--python <path>`: this interpreter only. */
  explicit?: string;
}

/** The first interpreter of the right version, in the per-OS order; a clear error otherwise. */
export async function findBasePython(
  deps: PythonDeps = {},
): Promise<{ argv: string[]; version: string }> {
  const run = deps.run ?? defaultVoiceRunner;
  const platform = deps.platform ?? currentPlatform();
  const candidates = deps.explicit ? [[deps.explicit]] : pythonCandidatesFor(platform);
  const found: string[] = [];
  for (const argv of candidates) {
    const r = await run({ argv: [...argv, "-c", VERSION_CODE], timeoutMs: 20_000 });
    if (r.error || r.code !== 0 || interpreterDidNotRun(r.code, r.stderr)) continue;
    const version = r.stdout.toString("utf8").trim();
    if (pythonVersionOk(version)) return { argv, version };
    found.push(`${argv.join(" ")} ${version}`);
  }
  throw new ForerunnerError("unavailable", missingPythonMessage(platform, found));
}

// ---------------------------------------------------------------------------------------------
// The setup question
// ---------------------------------------------------------------------------------------------

export function VOICE_PROFILE_QUESTION(recommended: VoiceProfile, gpu: GpuView): string {
  const line = (p: VoiceProfile, n: number) => {
    const i = VOICE_PROFILE_INFO[p];
    return `  ${n}. ${p.padEnd(4)} ${i.disk} on disk, ${i.download} to download. ${i.tradeOff}`;
  };
  return [
    "\nVoice",
    "What: talk to your agent by voice with speech recognition and speech on this PC.",
    `GPU: ${gpu.present ? `${gpu.name ?? "an NVIDIA GPU"}${gpu.driver ? ` (driver ${gpu.driver})` : ""}` : `none found (${gpu.reason})`}.`,
    line("none", 1),
    line("cpu", 2),
    line("gpu", 3),
    "Change it later in Settings -> Voice, or with fr voice install --cpu|--gpu and fr voice remove.",
    `Choose none, cpu or gpu [${recommended}]: `,
  ].join("\n");
}

/** "", a name or 1-3; null when the answer is none of these. */
export function parseVoiceProfileAnswer(
  answer: string,
  fallback: VoiceProfile,
): VoiceProfile | null {
  const a = answer.trim().toLowerCase();
  if (a === "") return fallback;
  const byNumber: Record<string, VoiceProfile> = { "1": "none", "2": "cpu", "3": "gpu" };
  if (byNumber[a]) return byNumber[a] as VoiceProfile;
  return (VOICE_PROFILES as readonly string[]).includes(a) ? (a as VoiceProfile) : null;
}

// ---------------------------------------------------------------------------------------------
// Install and remove
// ---------------------------------------------------------------------------------------------

export interface InstallDeps {
  dirs: AppDirs;
  env: NodeJS.ProcessEnv;
  out: (e: VoiceInstallEvent) => void;
  platform?: Platform;
  run?: VoiceProcRunner;
  clock?: Clock;
  helpersDir?: string;
  /** `--python <path>`: the interpreter that makes the venv. */
  python?: string;
  /** Called once before an old profile's venv is deleted (the daemon stops its helpers). */
  beforeCleanup?: () => Promise<void>;
  /** `fr setup` re-run: nothing to do when this profile is installed, verified and pinned the same. */
  ifChanged?: boolean;
  gpu?: GpuView;
  signal?: AbortSignal;
}

export interface InstallResult {
  ok: boolean;
  /** 0 done, 2 done with the CPU standing in for a failed GPU check, 1 failed. */
  exitCode: 0 | 1 | 2;
  profile: VoiceProfile;
  message: string;
}

interface Marker {
  profile: InstalledProfile;
  requirementsSha256: string;
  pythonVersion: string;
  at: string;
}

const MARKER = "forerunner-voice.json";

function readMarker(venv: string): Marker | null {
  try {
    return JSON.parse(readFileSync(join(venv, MARKER), "utf8")) as Marker;
  } catch {
    return null;
  }
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function modelNames(env: NodeJS.ProcessEnv): { whisper: string; voice: string } {
  return {
    whisper: env.FORERUNNER_WHISPER_MODEL?.trim() || "base",
    voice: env.FORERUNNER_KOKORO_VOICE?.trim() || "af_heart",
  };
}

/** One install at a time per data directory (the CLI and the daemon may both try). */
function takeLock(lock: string): () => void {
  mkdirSync(dirname(lock), { recursive: true });
  const tryOpen = () => {
    const fd = openSync(lock, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    tryOpen();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(lock, "utf8").trim());
    let alive = false;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive)
      throw new ForerunnerError(
        "claim_conflict",
        `another voice install is running (process ${pid}); wait for it to finish`,
      );
    rmSync(lock, { force: true });
    tryOpen();
  }
  return () => rmSync(lock, { force: true });
}

class Failure extends Error {}

/**
 * espeak-ng (Kokoro's phonemizer) copies its data folder's path into a fixed buffer:
 * N_PATH_HOME, 160 bytes on Linux and macOS and 230 on Windows. A longer path is ignored and
 * espeak-ng exits on the first sentence ("Error processing file .../phontab"), so the venv
 * must sit where `<site-packages>/espeakng_loader/espeak-ng-data` stays shorter.
 */
export const ESPEAK_PATH_MAX: Partial<Record<Platform, number>> = {
  linux: 159,
  macos: 159,
  windows: 229,
};

export function espeakDataPath(venv: string, platform: Platform, pythonVersion: string): string {
  const [maj, min] = parseVersion(pythonVersion);
  const site =
    platform === "windows"
      ? join(venv, "Lib", "site-packages")
      : join(venv, "lib", `python${maj}.${min}`, "site-packages");
  return join(site, "espeakng_loader", "espeak-ng-data");
}

function assertEspeakPath(venv: string, platform: Platform, pythonVersion: string): void {
  const p = espeakDataPath(venv, platform, pythonVersion);
  const max = ESPEAK_PATH_MAX[platform] ?? 159;
  if (p.length > max)
    throw new Failure(
      `the voice folder's path is too long for espeak-ng, which Kokoro uses for speech: ${p} is ${p.length} characters and espeak-ng reads at most ${max}. Set FORERUNNER_HOME to a shorter folder (or use the default data directory) and run the install again.`,
    );
}

/** Install (or switch to) a profile; "none" removes. Never throws: the result and the events say what happened. */
export async function installVoice(
  profile: VoiceProfile,
  deps: InstallDeps,
): Promise<InstallResult> {
  if (profile === "none") return removeVoice(deps);
  const out = deps.out;
  const platform = deps.platform ?? currentPlatform();
  const run = deps.run ?? defaultVoiceRunner;
  const clock = deps.clock ?? systemClock;
  const helpersDir = deps.helpersDir ?? DEFAULT_HELPERS_DIR;
  const vd = voiceDirs(deps.dirs);
  const venv = vd.venv(profile);
  const vpy = venvPythonPath(venv, platform);
  const reqFile = requirementsFile(profile, helpersDir);
  const reqSha = sha256(reqFile);
  const current = readVoiceSettings(deps.dirs);
  const finish = (exitCode: 0 | 1 | 2, message: string): InstallResult => {
    out({ type: "result", ok: exitCode !== 1, profile, exitCode, message });
    return { ok: exitCode !== 1, exitCode, profile, message };
  };

  if (
    deps.ifChanged &&
    current?.profile === profile &&
    current.verified &&
    current.install?.requirementsSha256 === reqSha &&
    existsSync(vpy)
  ) {
    out({
      type: "log",
      message: `voice profile ${profile} is installed and verified (${current.verified.at}); nothing to do (${voiceInstallCommand(profile)} checks it again)`,
    });
    return finish(0, `voice profile ${profile}: up to date`);
  }

  let release: (() => void) | null = null;
  try {
    release = takeLock(vd.lock);
    const env: NodeJS.ProcessEnv = {
      ...deps.env,
      HF_HOME: vd.models,
      PIP_NO_INPUT: "1",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    };
    if (deps.env.FORERUNNER_PYTHON?.trim())
      out({
        type: "warning",
        message: `FORERUNNER_PYTHON is set (${deps.env.FORERUNNER_PYTHON}): the voice helpers use that interpreter, not the managed venv this installs. Unset it to use the ${profile} profile.`,
      });

    const gpu = deps.gpu ?? (await detectNvidiaGpu({ run, platform }));
    out({
      type: "step",
      step: "gpu",
      message: gpu.present
        ? `NVIDIA GPU: ${gpu.name ?? "present"}${gpu.driver ? `, driver ${gpu.driver}` : ""}`
        : `no NVIDIA GPU (${gpu.reason})`,
    });
    if (profile === "gpu" && !gpu.present)
      out({
        type: "warning",
        message:
          "The gpu profile needs an NVIDIA GPU and driver, and none was found: the GPU check below will most likely fall back to the CPU.",
      });

    // 1. The venv: reused when its interpreter runs, made again when it does not.
    out({ type: "step", step: "venv", message: `managed Python environment: ${venv}` });
    let pythonVersion: string | null = null;
    if (existsSync(vpy)) {
      const r = await run({ argv: [vpy, "-c", VERSION_CODE], timeoutMs: 30_000, env });
      const v = r.stdout.toString("utf8").trim();
      if (r.code === 0 && pythonVersionOk(v)) {
        assertEspeakPath(venv, platform, v);
        pythonVersion = v;
        out({ type: "log", message: `reusing it (Python ${v})` });
      } else {
        out({ type: "log", message: `the environment at ${venv} does not run; making it again` });
      }
    }
    if (!pythonVersion) {
      const base = await findBasePython({ run, platform, explicit: deps.python });
      assertEspeakPath(venv, platform, base.version);
      rmSync(venv, { recursive: true, force: true });
      out({
        type: "log",
        message: `making it with ${base.argv.join(" ")} (Python ${base.version})`,
      });
      const r = await run({ argv: [...base.argv, "-m", "venv", venv], timeoutMs: 5 * 60_000, env });
      if (r.code !== 0 || !existsSync(vpy)) {
        const why = tail(r.stderr) || r.error || `exit ${r.code}`;
        const [maj, min] = parseVersion(base.version);
        const hint =
          platform === "linux" && /ensurepip|venv/i.test(why)
            ? `\nThe venv module is missing: sudo apt-get install -y python${maj}.${min}-venv`
            : "";
        throw new Failure(`could not make the environment: ${why}${hint}`);
      }
      pythonVersion = base.version;
    }

    // 2. Packages: skipped when the marker says these pins are installed.
    const marker = readMarker(venv);
    if (marker?.profile === profile && marker.requirementsSha256 === reqSha) {
      out({ type: "step", step: "packages", message: "Python packages" });
      out({ type: "log", message: `packages up to date (pins unchanged since ${marker.at})` });
    } else {
      out({
        type: "step",
        step: "packages",
        message: `installing the ${profile} packages (${VOICE_PROFILE_INFO[profile].download} to download; pip resumes an interrupted download)`,
      });
      const pip = await run({
        argv: [vpy, "-m", "pip", "install", "--disable-pip-version-check", `pip==${PIP_VERSION}`],
        timeoutMs: 10 * 60_000,
        env,
        signal: deps.signal,
      });
      if (pip.code !== 0)
        throw new Failure(
          `could not update pip: ${tail(pip.stderr) || pip.error || `exit ${pip.code}`}`,
        );
      const throttle = new Throttle(out);
      let label = "packages";
      const onLine = (line: string) => {
        const t = line.trim();
        const dl = /^Downloading\s+(\S+)/.exec(t);
        if (dl?.[1]) label = decodeURIComponent(dl[1]);
        const pr = /^Progress (\d+) of (\d+)$/.exec(t);
        if (pr) {
          throttle.progress(label, Number(pr[1]), Number(pr[2]));
          return;
        }
        if (/^(Collecting|Downloading|Installing|Successfully|ERROR|WARNING)\b/.test(t))
          out({ type: "log", message: t.slice(0, 300) });
      };
      const lines = new Lines(onLine);
      const errLines = new Lines(onLine);
      const r = await run({
        argv: [
          vpy,
          "-m",
          "pip",
          "install",
          "--disable-pip-version-check",
          "--progress-bar",
          "raw",
          "--resume-retries",
          "5",
          "-r",
          reqFile,
        ],
        timeoutMs: 2 * 60 * 60_000,
        env,
        signal: deps.signal,
        onStdout: (d) => lines.push(d),
        onStderr: (t) => errLines.push(t),
      });
      if (!lines.seen) lines.push(r.stdout);
      lines.end();
      errLines.end();
      if (r.code !== 0)
        throw new Failure(
          `pip could not install the ${profile} packages: ${tail(r.stderr) || r.error || `exit ${r.code}`}\nWhat was downloaded is kept; run it again to resume (${voiceInstallCommand(profile)}).`,
        );
      writeFileSync(
        join(venv, MARKER),
        `${JSON.stringify({ profile, requirementsSha256: reqSha, pythonVersion, at: clock.nowIso() } satisfies Marker, null, 2)}\n`,
      );
    }

    // 3. Models, with progress.
    const names = modelNames(deps.env);
    out({
      type: "step",
      step: "models",
      message: `models: faster-whisper ${names.whisper} and Kokoro-82M with the ${names.voice} voice (cached ones are not fetched again)`,
    });
    {
      const throttle = new Throttle(out);
      const errors: string[] = [];
      const lines = new Lines((line) => {
        let m: {
          type?: string;
          what?: string;
          bytes?: number;
          total?: number | null;
          repo?: string;
          message?: string;
        };
        try {
          m = JSON.parse(line) as typeof m;
        } catch {
          return;
        }
        const what = m.what ?? "model";
        if (m.type === "start") out({ type: "log", message: `fetching ${what} (${m.repo ?? ""})` });
        else if (m.type === "progress" && typeof m.bytes === "number")
          throttle.progress(what, m.bytes, m.total ?? null);
        else if (m.type === "done") {
          const fetched = typeof m.bytes === "number" && m.bytes > 0;
          if (fetched) throttle.progress(what, m.bytes as number, m.bytes as number);
          out({
            type: "log",
            message: fetched ? `${what} ready` : `${what} ready (already downloaded)`,
          });
        } else if (m.type === "error") errors.push(`${what}: ${m.message ?? "failed"}`);
      });
      const r = await run({
        argv: [
          vpy,
          join(helpersDir, "fr_voice_models.py"),
          "--whisper",
          names.whisper,
          "--kokoro-voice",
          names.voice,
        ],
        timeoutMs: 60 * 60_000,
        env,
        signal: deps.signal,
        onStdout: (d) => lines.push(d),
      });
      if (!lines.seen) lines.push(r.stdout);
      lines.end();
      if (r.code !== 0)
        throw new Failure(
          `the models could not be fetched: ${errors.join("; ") || tail(r.stderr) || r.error || `exit ${r.code}`}\nRun it again to resume.`,
        );
    }

    // 4. Verify: both helpers on the profile's device; on gpu a failure falls back loudly.
    out({
      type: "step",
      step: "verify",
      message: `checking speech recognition and speech on the ${profile === "gpu" ? "GPU" : "CPU"}`,
    });
    const verifyStt = (device: string, computeType: string) =>
      sttCheck(run, vpy, join(helpersDir, "fr_stt.py"), names.whisper, device, computeType, env);
    const verifyTts = (device: string) =>
      ttsCheck(run, vpy, join(helpersDir, "fr_tts.py"), names.voice, device, env);
    let exitCode: 0 | 2 = 0;
    const fixHint = `Check the NVIDIA driver (nvidia-smi), then run ${voiceInstallCommand("gpu")} again.`;
    let stt: VoiceDeviceView;
    let tts: VoiceDeviceView;
    if (profile === "gpu") {
      const s = await verifyStt("cuda", "float16");
      if (s.ok)
        stt = {
          device: s.device ?? "cuda",
          computeType: s.computeType ?? "float16",
          fallback: null,
        };
      else {
        out({
          type: "warning",
          message: `GPU check failed for speech recognition: ${s.message}. Speech recognition runs on the CPU (int8) until this is fixed. ${fixHint}`,
        });
        const c = await verifyStt("cpu", "int8");
        if (!c.ok)
          throw new Failure(`speech recognition does not run on the CPU either: ${c.message}`);
        stt = { device: "cpu", computeType: "int8", fallback: s.message };
        exitCode = 2;
      }
      const t = await verifyTts("cuda");
      if (t.ok) tts = { device: t.device ?? "cuda", computeType: null, fallback: null };
      else {
        out({
          type: "warning",
          message: `GPU check failed for speech (Kokoro): ${t.message}. Speech runs on the CPU until this is fixed. ${fixHint}`,
        });
        const c = await verifyTts("cpu");
        if (!c.ok) throw new Failure(`speech does not run on the CPU either: ${c.message}`);
        tts = { device: "cpu", computeType: null, fallback: t.message };
        exitCode = 2;
      }
    } else {
      const s = await verifyStt("cpu", "int8");
      if (!s.ok) throw new Failure(`speech recognition check failed: ${s.message}`);
      stt = { device: s.device ?? "cpu", computeType: s.computeType ?? "int8", fallback: null };
      const t = await verifyTts("cpu");
      if (!t.ok) throw new Failure(`speech check failed: ${t.message}`);
      tts = { device: t.device ?? "cpu", computeType: null, fallback: null };
    }
    out({
      type: "log",
      message: `speech recognition: ${stt.device}${stt.computeType ? ` (${stt.computeType})` : ""}; speech: ${tts.device}`,
    });

    const at = clock.nowIso();
    writeVoiceSettings(deps.dirs, {
      version: 1,
      profile,
      updatedAt: at,
      install: {
        venv,
        python: vpy,
        pythonVersion: pythonVersion ?? "",
        requirementsSha256: reqSha,
        installedAt: readMarker(venv)?.at ?? at,
      },
      verified: { at, stt, tts },
      gpu: gpu.present ? { name: gpu.name, driver: gpu.driver } : null,
    });

    // 5. The other profile's venv goes once this one works.
    const others = (["cpu", "gpu"] as const).filter((p) => p !== profile && existsSync(vd.venv(p)));
    if (others.length) {
      out({
        type: "step",
        step: "cleanup",
        message: `removing the ${others.join(" and ")} environment`,
      });
      await deps.beforeCleanup?.();
      for (const p of others) {
        try {
          rmSync(vd.venv(p), { recursive: true, force: true });
        } catch (e) {
          out({
            type: "warning",
            message: `could not remove ${vd.venv(p)} (${errorMessage(e)}); it may be in use by a running daemon. It is removed at the next install.`,
          });
        }
      }
    }
    return finish(
      exitCode,
      exitCode === 0
        ? `voice profile ${profile} installed: speech recognition on ${stt.device}, speech on ${tts.device}`
        : `voice profile ${profile} installed, but the GPU check failed: speech recognition on ${stt.device}, speech on ${tts.device} (the CPU stands in; see the warning above)`,
    );
  } catch (e) {
    out({ type: "error", message: errorMessage(e) });
    return finish(1, `voice profile ${profile} not installed: ${errorMessage(e).split("\n")[0]}`);
  } finally {
    release?.();
  }
}

/** Delete the venvs and the models, turn local voice off (profile none). */
export async function removeVoice(deps: InstallDeps): Promise<InstallResult> {
  const out = deps.out;
  const clock = deps.clock ?? systemClock;
  const vd = voiceDirs(deps.dirs);
  let release: (() => void) | null = null;
  const finish = (exitCode: 0 | 1, message: string): InstallResult => {
    out({ type: "result", ok: exitCode === 0, profile: "none", exitCode, message });
    return { ok: exitCode === 0, exitCode, profile: "none", message };
  };
  try {
    release = takeLock(vd.lock);
    out({ type: "step", step: "remove", message: "turning local voice off" });
    const previous = readVoiceSettings(deps.dirs);
    writeVoiceSettings(deps.dirs, {
      version: 1,
      profile: "none",
      updatedAt: clock.nowIso(),
      gpu: previous?.gpu ?? null,
    });
    const targets = [vd.venv("cpu"), vd.venv("gpu"), vd.models].filter((p) => existsSync(p));
    if (targets.length) await deps.beforeCleanup?.();
    const left: string[] = [];
    for (const t of targets) {
      try {
        rmSync(t, { recursive: true, force: true });
        out({ type: "log", message: `removed ${t}` });
      } catch (e) {
        left.push(t);
        out({ type: "error", message: `could not remove ${t}: ${errorMessage(e)}` });
      }
    }
    return left.length
      ? finish(
          1,
          `local voice is off, but ${left.length} folder(s) are still there (in use by a running daemon?): stop the app or the daemon and run fr voice remove again`,
        )
      : finish(0, "local voice is off and its packages and models are removed");
  } catch (e) {
    out({ type: "error", message: errorMessage(e) });
    return finish(1, `could not remove local voice: ${errorMessage(e).split("\n")[0]}`);
  } finally {
    release?.();
  }
}

// ---------------------------------------------------------------------------------------------
// The helper checks
// ---------------------------------------------------------------------------------------------

interface CheckResult {
  ok: boolean;
  device: string | null;
  computeType: string | null;
  message: string;
}

/** 0.5 s of silence, end of speech, close: the helper loads, warms, transcribes once, exits. */
async function sttCheck(
  run: VoiceProcRunner,
  python: string,
  helper: string,
  model: string,
  device: string,
  computeType: string,
  env: NodeJS.ProcessEnv,
): Promise<CheckResult> {
  const input = Buffer.concat([
    encodeInFrame(STT_IN.audio, new Uint8Array(16000)),
    encodeInFrame(STT_IN.endOfSpeech),
    encodeInFrame(STT_IN.close),
  ]);
  const r = await run({
    argv: [
      python,
      helper,
      "--model",
      model,
      "--device",
      device,
      "--compute-type",
      computeType,
      "--sample-rate",
      "16000",
    ],
    input,
    env,
    timeoutMs: 10 * 60_000,
  });
  let ready: { device?: string; compute_type?: string } | null = null;
  let final = false;
  let error: string | null = null;
  for (const line of r.stdout.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as {
        type?: string;
        device?: string;
        compute_type?: string;
        message?: string;
      };
      if (m.type === "ready") ready = m;
      else if (m.type === "final") final = true;
      else if (m.type === "error") error = m.message ?? "error";
    } catch {
      // not a protocol line
    }
  }
  if (r.code === 0 && ready && final)
    return {
      ok: true,
      device: ready.device ?? device,
      computeType: ready.compute_type ?? computeType,
      message: "ok",
    };
  return {
    ok: false,
    device: null,
    computeType: null,
    message: error ?? (tail(r.stderr, 3) || r.error || `the helper exited with code ${r.code}`),
  };
}

/** One short sentence, then close: the helper loads Kokoro, speaks, exits. */
async function ttsCheck(
  run: VoiceProcRunner,
  python: string,
  helper: string,
  voice: string,
  device: string,
  env: NodeJS.ProcessEnv,
): Promise<CheckResult> {
  const request = Buffer.from(JSON.stringify({ id: 1, text: "Voice check." }), "utf8");
  const input = Buffer.concat([
    encodeInFrame(TTS_IN.request, request),
    encodeInFrame(TTS_IN.close),
  ]);
  const r = await run({
    argv: [python, helper, "--device", device, "--voice", voice],
    input,
    env,
    timeoutMs: 10 * 60_000,
  });
  const frames = new FrameReader().push(r.stdout);
  let readyDevice: string | null = null;
  let ready = false;
  let audio = 0;
  let done = false;
  let error: string | null = null;
  for (const f of frames) {
    if (f.kind === TTS_OUT.ready) {
      ready = true;
      try {
        readyDevice =
          (JSON.parse(f.payload.toString("utf8")) as { device?: string }).device ?? null;
      } catch {
        readyDevice = null;
      }
    } else if (f.kind === TTS_OUT.audio) audio += f.payload.length;
    else if (f.kind === TTS_OUT.done) done = true;
    else if (f.kind === TTS_OUT.error) error = f.payload.toString("utf8");
  }
  if (r.code === 0 && ready && audio > 0 && done)
    return { ok: true, device: readyDevice ?? device, computeType: null, message: "ok" };
  return {
    ok: false,
    device: null,
    computeType: null,
    message: error ?? (tail(r.stderr, 3) || r.error || `the helper exited with code ${r.code}`),
  };
}
