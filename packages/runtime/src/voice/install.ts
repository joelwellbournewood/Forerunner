/**
 * The local voice stack's installer (ADR 0090): `fr voice install [--cpu|--gpu]`,
 * `fr voice remove`, `fr setup --voice`, and the daemon's `POST /voice/install` all run this.
 *
 * A profile is a managed venv under the dependencies folder (`<deps>/voice/venv-<profile>`, one
 * per profile, so a switch never rewrites the interpreter a running helper uses; `<deps>` is
 * `<install folder>/dependencies` by default and the data folder when the install folder cannot
 * be written, `dependencies.ts`, U-011), the pinned hashed pins of `packages/voice/python`
 * (torch-<profile>.txt alone from the PyTorch index, requirements-<profile>.txt from PyPI only,
 * pip.txt), the models in `<deps>/voice/models` (HF_HOME for the helpers), pip's cache and
 * temporary files in `<deps>/voice/pip-cache` and `<deps>/voice/tmp` (a GPU install unpacks
 * several GB, which a full C: refused), and a verify run of both helpers on the profile's
 * device. What is
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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  type AppDirs,
  basename,
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
import { type DependenciesDir, resolveDependenciesDir } from "../dependencies.ts";
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
/**
 * Python 3.12 only: numpy 2.5.4 declares `>=3.12` and kokoro 0.9.4 `<3.13`
 * (packages/voice/python/pin-metadata.json has every pin's, test/voice-pins.test.ts checks).
 */
export const VOICE_PYTHON = { min: [3, 12], below: [3, 13] } as const;
/** Everything but PyTorch comes from here, hashed (the lock). */
export const PYPI_INDEX = "https://pypi.org/simple";
/** PyTorch per profile: installed alone, hashed, with --no-deps, from its own index. */
export const TORCH = {
  cpu: { version: "2.11.0+cpu", index: "https://download.pytorch.org/whl/cpu" },
  gpu: { version: "2.11.0+cu128", index: "https://download.pytorch.org/whl/cu128" },
} as const;
/** packages/voice/python: the helpers, the model fetcher and the requirements files. */
export const DEFAULT_HELPERS_DIR = dirname(DEFAULT_STT_HELPER);

export type InstalledProfile = Exclude<VoiceProfile, "none">;

// ---------------------------------------------------------------------------------------------
// Paths and the settings file
// ---------------------------------------------------------------------------------------------

export interface VoiceDirs {
  root: string;
  models: string;
  /** pip's download cache (PIP_CACHE_DIR), kept for a re-run. */
  pipCache: string;
  /** TMP, TEMP and TMPDIR of the install's processes; removed after the install. */
  tmp: string;
  venv(profile: InstalledProfile): string;
  /** `<config>/voice.json`: the profile and what was installed and verified. */
  settings: string;
  lock: string;
}

/**
 * The voice folders under `dependenciesDir` (`resolveDependenciesDir`; the data folder by
 * default, where 1.0.2 put them). `settings` stays in the config folder.
 */
export function voiceDirs(dirs: AppDirs, dependenciesDir: string = dirs.data): VoiceDirs {
  const root = join(dependenciesDir, "voice");
  return {
    root,
    models: join(root, "models"),
    pipCache: join(root, "pip-cache"),
    tmp: join(root, "tmp"),
    venv: (profile) => join(root, `venv-${profile}`),
    settings: join(dirs.config, "voice.json"),
    lock: join(root, "install.lock"),
  };
}

export function venvPythonPath(venv: string, platform: Platform = currentPlatform()): string {
  return platform === "windows" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
}

/** The hashed lock of everything but PyTorch (generated by scripts/voice-lock.ts). */
export function requirementsFile(
  profile: InstalledProfile,
  helpersDir = DEFAULT_HELPERS_DIR,
): string {
  return join(helpersDir, `requirements-${profile}.txt`);
}

/** What the lock is generated from (the exact top-level pins and torch's own dependencies). */
export function requirementsSource(
  profile: InstalledProfile,
  helpersDir = DEFAULT_HELPERS_DIR,
): string {
  return join(helpersDir, `requirements-${profile}.in`);
}

/** PyTorch alone, hashed. */
export function torchFile(profile: InstalledProfile, helpersDir = DEFAULT_HELPERS_DIR): string {
  return join(helpersDir, `torch-${profile}.txt`);
}

/** pip itself, hashed. */
/** setuptools, hashed: what the source builds are built against (no isolated build env). */
export function buildToolsFile(helpersDir = DEFAULT_HELPERS_DIR): string {
  return join(helpersDir, "build-tools.txt");
}

/**
 * The only locked packages without a wheel on PyPI (docopt, via num2words): built from their
 * hashed sdist with `--no-build-isolation` against build-tools.txt. Everything else is
 * `--only-binary :all:`; scripts/voice-lock.ts fails when another sdist-only pin appears.
 */
export const SOURCE_BUILDS = ["docopt"] as const;

/** Where the pinned wheels exist (cp312 win_amd64 and manylinux x86_64). */
export const SUPPORTED_TARGETS = [
  { platform: "windows", arch: "x64" },
  { platform: "linux", arch: "x64" },
] as const;

/**
 * `sysconfig.get_platform()` of an interpreter the wheels fit. What decides is the Python
 * that installs the wheels, not Node: a 32-bit Node can drive a 64-bit Python, and an x64
 * Node can find a 32-bit or ARM Python.
 */
export const SUPPORTED_PYTHON_PLATFORMS = ["win-amd64", "linux-x86_64"] as const;

const PLATFORM_CODE = "import sysconfig; print(sysconfig.get_platform())";

const unsupportedMessage = (where: string) =>
  `Local voice installs on Windows x64 and Linux x86_64 only: the pinned wheels (PyTorch, ctranslate2, the NVIDIA libraries) are those two. This is ${where}. Voice can still use a cloud provider (Extensions).`;

const TORCH_BLOCK_BEGIN = "# BEGIN torch-dependencies";
const TORCH_BLOCK_END = "# END torch-dependencies";

/** "req; marker" as "req ; marker" (one spelling for comparing and for the .in). */
function normalizeRequirement(line: string): string {
  const [req, marker] = line.split(";", 2).map((x) => x.trim());
  return marker ? `${req} ; ${marker}` : (req as string);
}

/**
 * torch's own Requires-Dist for the .in, from its Windows and Linux wheels' metadata: a
 * dependency both declare (same text) stays bare; one only a platform declares gets that
 * platform's marker unless it carries one.
 */
export function torchDependencyLines(windows: string[], linux: string[]): string[] {
  const win = windows.map(normalizeRequirement);
  const lin = linux.map(normalizeRequirement);
  const out: string[] = [];
  for (const w of win)
    out.push(lin.includes(w) || w.includes(";") ? w : `${w} ; platform_system == "Windows"`);
  for (const l of lin) {
    if (win.includes(l)) continue;
    out.push(l.includes(";") ? l : `${l} ; platform_system == "Linux"`);
  }
  return out;
}

/** The lines between the torch-dependencies markers of a .in file. */
export function torchBlock(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const a = lines.indexOf(TORCH_BLOCK_BEGIN);
  const b = lines.indexOf(TORCH_BLOCK_END);
  if (a < 0 || b < a) throw new Error(`no ${TORCH_BLOCK_BEGIN} ... ${TORCH_BLOCK_END} block`);
  return lines.slice(a + 1, b).filter((l) => l.trim() && !l.trim().startsWith("#"));
}

/** A .in file with its torch-dependencies block replaced. */
export function withTorchBlock(source: string, lines: string[]): string {
  const all = source.split(/\r?\n/);
  const a = all.indexOf(TORCH_BLOCK_BEGIN);
  const b = all.indexOf(TORCH_BLOCK_END);
  if (a < 0 || b < a) throw new Error(`no ${TORCH_BLOCK_BEGIN} ... ${TORCH_BLOCK_END} block`);
  return [...all.slice(0, a + 1), ...lines, ...all.slice(b)].join("\n");
}

export function pipFile(helpersDir = DEFAULT_HELPERS_DIR): string {
  return join(helpersDir, "pip.txt");
}

export interface RequirementLine {
  name: string;
  /** The exact version of a `==` pin; null for a range or a URL. */
  version: string | null;
  exact: boolean;
  url: string | null;
  marker: string | null;
  hashes: string[];
}

/** The requirement lines of a requirements file (continuations joined, comments and options dropped). */
export function parseRequirements(text: string): RequirementLine[] {
  const joined = text.replace(/\\\r?\n/g, " ");
  const out: RequirementLine[] = [];
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const hashes = [...line.matchAll(/--hash=sha256:([0-9a-f]{64})/g)].map((m) => m[1] as string);
    const body = line.replace(/--hash=\S+/g, "").trim();
    const [reqPart, markerPart] = body.split(/\s*;\s*/, 2);
    const req = (reqPart ?? "").trim();
    const marker = markerPart?.trim() || null;
    const url = /@\s*(\S+)/.exec(req)?.[1] ?? null;
    const name = (/^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req)?.[1] ?? "")
      .toLowerCase()
      .replace(/[._]+/g, "-");
    const exactMatch = /==\s*([^\s,;]+)\s*$/.exec(req.replace(/\[[^\]]*\]/, ""));
    out.push({
      name,
      version: exactMatch?.[1] ?? null,
      exact: !!exactMatch,
      url,
      marker,
      hashes,
    });
  }
  return out;
}

const verTuple = (v: string): number[] =>
  v
    .split(".")
    .map((x) => Number.parseInt(x, 10))
    .map((x) => (Number.isFinite(x) ? x : 0));

function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Whether a Requires-Python specifier (`>=3.10,<3.13`, `!=3.12.*`, `~=3.11`) admits `version`. */
export function pythonSpecAdmits(spec: string, version: string): boolean {
  const v = verTuple(version);
  for (const clause of spec
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)) {
    const m = /^(~=|===|==|!=|<=|>=|<|>)\s*(.+)$/.exec(clause);
    if (!m) return false;
    const op = m[1] as string;
    const target = (m[2] as string).trim();
    if (target.endsWith(".*")) {
      const prefix = verTuple(target.slice(0, -2));
      const same = prefix.every((x, i) => v[i] === x);
      if ((op === "==" && !same) || (op === "!=" && same)) return false;
      continue;
    }
    const t = verTuple(target);
    const c = cmpVersion(v, t);
    const ok =
      op === ">="
        ? c >= 0
        : op === ">"
          ? c > 0
          : op === "<="
            ? c <= 0
            : op === "<"
              ? c < 0
              : op === "==" || op === "==="
                ? c === 0
                : op === "!="
                  ? c !== 0
                  : // ~=X.Y(.Z): >= X.Y(.Z) and the same release up to the second-to-last part
                    c >= 0 && t.slice(0, -1).every((x, i) => v[i] === x);
    if (!ok) return false;
  }
  return true;
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

/**
 * The voice folder an install recorded in voice.json (the parent of its venv), so an install
 * keeps working where it was made whatever the default is now; null without a record. Only a
 * path of the shape this installer writes (`.../voice/venv-cpu|gpu`) counts: the folders under
 * it are deleted on a move or a remove, so an edited file never names another folder.
 */
export function recordedVoiceRoot(settings: VoiceSettings | null): string | null {
  const venv = settings?.install?.venv;
  if (!venv || !/^venv-(cpu|gpu)$/.test(basename(venv))) return null;
  const root = dirname(venv);
  return basename(root) === "voice" ? root : null;
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

/** Write a file whole or not at all: a temporary file beside it, then a rename over it. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** voice.json is read by a running daemon at every voice use: never seen half written. */
export function writeVoiceSettings(dirs: AppDirs, settings: VoiceSettings): void {
  writeAtomic(voiceDirs(dirs).settings, `${JSON.stringify(settings, null, 2)}\n`);
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
    ? [["py", "-3.12"], ["python"], ["python3"]]
    : [["python3.12"], ["python3"], ["python"]];
}

export function missingPythonMessage(platform: Platform, found: string[]): string {
  const install =
    platform === "windows"
      ? "  winget install -e --id Python.Python.3.12   (then open a new terminal)"
      : "  sudo apt-get install -y python3.12 python3.12-venv   (Debian/Ubuntu; elsewhere install Python 3.12 with its venv module)";
  return [
    `Local voice needs Python 3.12 (the pinned numpy 2.5 needs 3.12, and Kokoro does not run on 3.13 yet). ${found.length ? `Found only: ${found.join(", ")}.` : "No Python was found."}`,
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
  /** `process.arch` by default; with `platform`, checked against SUPPORTED_TARGETS. */
  arch?: string;
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
  /** Where the packages and models go; `resolveDependenciesDir(env, dirs)` by default (U-011). */
  dependencies?: DependenciesDir;
}

/** The voice folders of every place an install may have put them: now, recorded, 1.0.2's. */
function voiceRootsOf(deps: InstallDeps, current: VoiceSettings | null, root: string): string[] {
  const roots = [root, recordedVoiceRoot(current), voiceDirs(deps.dirs).root];
  return [...new Set(roots.filter((r): r is string => !!r))];
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

/** One hash over the files pip installs from, so a change to any of them reinstalls. */
function sha256(...files: string[]): string {
  const h = createHash("sha256");
  for (const f of files) h.update(readFileSync(f));
  return h.digest("hex");
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
        `another voice install is running (process ${pid}, lock ${lock}); wait for it to finish, or delete the lock file if that process is not an install`,
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
  const arch = deps.arch ?? process.arch;
  // The operating system is refused at once; the architecture is the Python's to decide
  // (checked with sysconfig once the interpreter is known), Node's is only a hint.
  const os = deps.platform ?? currentPlatform();
  if (!SUPPORTED_TARGETS.some((t) => t.platform === os)) {
    const message = unsupportedMessage(`${os} ${arch}`);
    deps.out({ type: "error", message });
    deps.out({ type: "result", ok: false, profile, exitCode: 1, message });
    return { ok: false, exitCode: 1, profile, message };
  }
  const out = deps.out;
  const platform = deps.platform ?? currentPlatform();
  const run = deps.run ?? defaultVoiceRunner;
  const clock = deps.clock ?? systemClock;
  const helpersDir = deps.helpersDir ?? DEFAULT_HELPERS_DIR;
  const dependencies = deps.dependencies ?? resolveDependenciesDir(deps.env, deps.dirs);
  const vd = voiceDirs(deps.dirs, dependencies.dir);
  const venv = vd.venv(profile);
  const vpy = venvPythonPath(venv, platform);
  const reqFile = requirementsFile(profile, helpersDir);
  const torchReq = torchFile(profile, helpersDir);
  const pipReq = pipFile(helpersDir);
  const buildReq = buildToolsFile(helpersDir);
  const reqSha = sha256(pipReq, buildReq, torchReq, reqFile);
  const signal = deps.signal;
  /** Between steps and after each process: a cancel (the route, a daemon stop) ends the run. */
  const checkCancelled = () => {
    if (signal?.aborted) throw new Failure("cancelled");
  };
  const current = readVoiceSettings(deps.dirs);
  const finish = (exitCode: 0 | 1 | 2, message: string): InstallResult => {
    out({ type: "result", ok: exitCode !== 1, profile, exitCode, message });
    return { ok: exitCode !== 1, exitCode, profile, message };
  };

  // Up to date where it was installed: `fr setup` never moves a working install.
  if (
    deps.ifChanged &&
    current?.profile === profile &&
    current.verified &&
    current.install?.requirementsSha256 === reqSha &&
    existsSync(venvPythonPath(current.install.venv, platform))
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
    // pip gets its indexes from the command line only: an extra index or find-links from the
    // environment could otherwise offer a same-named package (the hashes would refuse it, but
    // nothing else is ever consulted).
    const { PIP_EXTRA_INDEX_URL: _extra, PIP_FIND_LINKS: _links, ...inherited } = deps.env;
    // Everything the install writes stays in the dependencies folder, temporary files and
    // pip's cache included (U-011: with C: full, pip failed unpacking into %TEMP%).
    mkdirSync(vd.tmp, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...inherited,
      HF_HOME: vd.models,
      PIP_CACHE_DIR: vd.pipCache,
      TMP: vd.tmp,
      TEMP: vd.tmp,
      TMPDIR: vd.tmp,
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

    checkCancelled();
    if (arch !== "x64")
      out({
        type: "log",
        message: `Node is ${arch}; the Python decides whether the x64 wheels fit (sysconfig)`,
      });
    const assertPythonPlatform = async (python: string[]) => {
      const r = await run({ argv: [...python, "-c", PLATFORM_CODE], timeoutMs: 30_000, env });
      const pyPlatform = r.stdout.toString("utf8").trim();
      if (!(SUPPORTED_PYTHON_PLATFORMS as readonly string[]).includes(pyPlatform))
        throw new Failure(
          unsupportedMessage(
            `a Python for ${pyPlatform || "an unknown platform"} (${python.join(" ")}); install the 64-bit x86 Python 3.12`,
          ),
        );
    };
    out({ type: "log", message: `dependencies folder: ${vd.root}` });
    if (dependencies.note) out({ type: "warning", message: dependencies.note });
    // 1. The venv: reused when its interpreter runs, made again when it does not.
    out({ type: "step", step: "venv", message: `managed Python environment: ${venv}` });
    let pythonVersion: string | null = null;
    if (existsSync(vpy)) {
      const r = await run({ argv: [vpy, "-c", VERSION_CODE], timeoutMs: 30_000, env });
      const v = r.stdout.toString("utf8").trim();
      if (r.code === 0 && pythonVersionOk(v)) {
        await assertPythonPlatform([vpy]);
        assertEspeakPath(venv, platform, v);
        pythonVersion = v;
        out({ type: "log", message: `reusing it (Python ${v})` });
      } else {
        out({ type: "log", message: `the environment at ${venv} does not run; making it again` });
      }
    }
    if (!pythonVersion) {
      const base = await findBasePython({ run, platform, explicit: deps.python });
      await assertPythonPlatform(base.argv);
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

    checkCancelled();
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
      // pip itself, hashed, from PyPI.
      const pip = await run({
        argv: [
          vpy,
          "-m",
          "pip",
          "install",
          "--disable-pip-version-check",
          "--require-hashes",
          "--only-binary",
          ":all:",
          "--index-url",
          PYPI_INDEX,
          "-r",
          pipReq,
        ],
        timeoutMs: 10 * 60_000,
        env,
        signal,
      });
      checkCancelled();
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
      // The hashed setuptools first (the one source build is built against it, without an
      // isolated build environment, so nothing unhashed is fetched for a build), then PyTorch
      // alone from its index (hashed, no dependencies: those are in the lock), then the lock
      // from PyPI only. Wheels only, except the named source builds. Every file is checked
      // against its hash.
      const pipInstall = async (
        index: string,
        file: string,
        what: string,
        extra: string[] = [],
      ) => {
        const lines = new Lines(onLine);
        const errLines = new Lines(onLine);
        const r = await run({
          argv: [
            vpy,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-deps",
            "--require-hashes",
            "--only-binary",
            ":all:",
            ...extra,
            "--index-url",
            index,
            "--progress-bar",
            "raw",
            "--resume-retries",
            "5",
            "-r",
            file,
          ],
          timeoutMs: 2 * 60 * 60_000,
          env,
          signal,
          onStdout: (d) => lines.push(d),
          onStderr: (t) => errLines.push(t),
        });
        if (!lines.seen) lines.push(r.stdout);
        lines.end();
        errLines.end();
        checkCancelled();
        if (r.code !== 0)
          throw new Failure(
            `pip could not install ${what}: ${tail(r.stderr) || r.error || `exit ${r.code}`}\nWhat was downloaded is kept; run it again to resume (${voiceInstallCommand(profile)}).`,
          );
      };
      await pipInstall(PYPI_INDEX, buildReq, "the build tools (setuptools)");
      await pipInstall(TORCH[profile].index, torchReq, `PyTorch ${TORCH[profile].version}`);
      await pipInstall(PYPI_INDEX, reqFile, `the ${profile} packages`, [
        "--no-binary",
        SOURCE_BUILDS.join(","),
        "--no-build-isolation",
      ]);
      const check = await run({
        argv: [vpy, "-m", "pip", "check", "--disable-pip-version-check"],
        timeoutMs: 5 * 60_000,
        env,
        signal,
      });
      checkCancelled();
      if (check.code !== 0)
        throw new Failure(
          `the installed packages do not fit together (pip check): ${tail(check.stdout.toString("utf8")) || tail(check.stderr) || `exit ${check.code}`}`,
        );
      writeAtomic(
        join(venv, MARKER),
        `${JSON.stringify({ profile, requirementsSha256: reqSha, pythonVersion, at: clock.nowIso() } satisfies Marker, null, 2)}\n`,
      );
    }

    checkCancelled();
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
        signal,
        onStdout: (d) => lines.push(d),
      });
      if (!lines.seen) lines.push(r.stdout);
      lines.end();
      checkCancelled();
      if (r.code !== 0)
        throw new Failure(
          `the models could not be fetched: ${errors.join("; ") || tail(r.stderr) || r.error || `exit ${r.code}`}\nRun it again to resume.`,
        );
    }

    checkCancelled();
    // 4. Verify: both helpers on the profile's device; on gpu a failure falls back loudly.
    out({
      type: "step",
      step: "verify",
      message: `checking speech recognition and speech on the ${profile === "gpu" ? "GPU" : "CPU"}`,
    });
    const verifyStt = async (device: string, computeType: string) => {
      const r = await sttCheck(
        run,
        vpy,
        join(helpersDir, "fr_stt.py"),
        names.whisper,
        device,
        computeType,
        env,
        signal,
      );
      checkCancelled();
      return r;
    };
    const verifyTts = async (device: string) => {
      const r = await ttsCheck(
        run,
        vpy,
        join(helpersDir, "fr_tts.py"),
        names.voice,
        device,
        env,
        signal,
      );
      checkCancelled();
      return r;
    };
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

    // 5. The other profile's venv goes once this one works, and so does a copy of the voice
    // folders in another place (recorded by an earlier install, or 1.0.2's data folder).
    const stale = [
      ...(["cpu", "gpu"] as const).filter((p) => p !== profile).map((p) => vd.venv(p)),
      ...voiceRootsOf(deps, current, vd.root)
        .filter((r) => r !== vd.root)
        .flatMap((r) => {
          const old = voiceDirs(deps.dirs, dirname(r));
          return [old.venv("cpu"), old.venv("gpu"), old.models, old.pipCache, old.tmp];
        }),
    ].filter((p) => existsSync(p));
    if (stale.length) {
      out({
        type: "step",
        step: "cleanup",
        message: `removing what this install replaces: ${stale.join(", ")}`,
      });
      await deps.beforeCleanup?.();
      for (const p of stale) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch (e) {
          out({
            type: "warning",
            message: `could not remove ${p} (${errorMessage(e)}); it may be in use by a running daemon. It is removed at the next install.`,
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
    const message = signal?.aborted
      ? `cancelled; what was downloaded is kept, ${voiceInstallCommand(profile)} finishes it`
      : errorMessage(e);
    out({ type: "error", message });
    return finish(1, `voice profile ${profile} not installed: ${message.split("\n")[0]}`);
  } finally {
    rmSync(vd.tmp, { recursive: true, force: true });
    release?.();
  }
}

/** Delete the venvs and the models, turn local voice off (profile none). */
export async function removeVoice(deps: InstallDeps): Promise<InstallResult> {
  const out = deps.out;
  const clock = deps.clock ?? systemClock;
  const dependencies = deps.dependencies ?? resolveDependenciesDir(deps.env, deps.dirs);
  const vd = voiceDirs(deps.dirs, dependencies.dir);
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
    // Every place an install may have put them: now, recorded in voice.json, 1.0.2's.
    const targets = voiceRootsOf(deps, previous, vd.root)
      .flatMap((r) => {
        const d = voiceDirs(deps.dirs, dirname(r));
        return [d.venv("cpu"), d.venv("gpu"), d.models, d.pipCache, d.tmp];
      })
      .filter((p) => existsSync(p));
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
  signal?: AbortSignal,
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
    signal,
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
  signal?: AbortSignal,
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
    signal,
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
