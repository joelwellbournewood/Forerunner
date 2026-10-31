import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "@forerunner/platform";
import {
  type VoiceProcRequest,
  type VoiceProcResult,
  venvPythonPath,
} from "../src/voice/install.ts";

/**
 * A process runner that answers like Python, pip, nvidia-smi and the voice helpers do, for
 * the voice install tests (voice-install.test.ts, voice-install-routes.test.ts).
 */
export const NVIDIA = "NVIDIA GeForce RTX 4070, 572.83, 12282\n";

const outFrame = (kind: number, id: number, payload: Buffer = Buffer.alloc(0)) => {
  const head = Buffer.alloc(9);
  head.writeUInt8(kind, 0);
  head.writeUInt32LE(id, 1);
  head.writeUInt32LE(payload.length, 5);
  return Buffer.concat([head, payload]);
};

export interface FakeOptions {
  /** Base interpreters that exist, by their first argv words joined, with their version. */
  pythons?: Record<string, string>;
  /** The STT helper fails on cuda with this message. */
  sttCudaError?: string;
  /** The TTS helper fails on cuda with this message. */
  ttsCudaError?: string;
  nvidiaSmi?: string | null;
  /** What `sysconfig.get_platform()` prints in every interpreter (default linux-x86_64). */
  pyPlatform?: string;
  /** The venv python of an existing venv does not run (a broken venv). */
  brokenVenv?: boolean;
  /** pip -r fails with this stderr. */
  pipError?: string;
  /** `pip check` reports this broken requirement. */
  pipCheckError?: string;
  /**
   * The model fetcher found the first speech model download broken with this reason and fetched
   * it once more (its `retry` line, U-024), then succeeded.
   */
  modelsRetry?: string;
}

export function fakeRunner(opts: FakeOptions = {}) {
  const calls: VoiceProcRequest[] = [];
  const pythons = opts.pythons ?? { python3: "3.12.7", "python3.12": "3.12.7" };
  let brokenVenv = opts.brokenVenv ?? false;
  const run = async (req: VoiceProcRequest): Promise<VoiceProcResult> => {
    calls.push(req);
    const [cmd, ...args] = req.argv;
    const ok = (stdout: string | Buffer = "", stderr = ""): VoiceProcResult => ({
      code: 0,
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
      stderr,
    });
    const fail = (code: number, stdout = "", stderr = ""): VoiceProcResult => ({
      code,
      stdout: Buffer.from(stdout),
      stderr,
    });
    const notFound: VoiceProcResult = {
      code: null,
      stdout: Buffer.alloc(0),
      stderr: "",
      error: `spawn ${cmd} ENOENT`,
    };
    if (cmd === "nvidia-smi") {
      if (!opts.nvidiaSmi) return notFound;
      req.onStdout?.(Buffer.from(opts.nvidiaSmi));
      return ok(opts.nvidiaSmi);
    }
    const isVenvPython = cmd?.includes("venv-");
    if (!isVenvPython) {
      // A base interpreter: `py -3.12 ...` or `python3.12 ...`.
      const key = cmd === "py" ? `py ${args[0]}` : (cmd as string);
      const rest = cmd === "py" ? args.slice(1) : args;
      const version = pythons[key];
      if (!version) return notFound;
      if (rest[0] === "-c")
        return ok(
          (rest[1] ?? "").includes("sysconfig")
            ? `${opts.pyPlatform ?? "linux-x86_64"}\n`
            : `${version}\n`,
        );
      if (rest[0] === "-m" && rest[1] === "venv") {
        const dir = rest[2] as string;
        for (const platform of ["linux", "windows"] as const) {
          const py = venvPythonPath(dir, platform);
          mkdirSync(dirname(py), { recursive: true });
          writeFileSync(py, "");
        }
        brokenVenv = false;
        return ok();
      }
      return fail(2, "", `unexpected ${req.argv.join(" ")}`);
    }
    if (brokenVenv) return fail(1, "", "error while loading shared libraries");
    if (args[0] === "-c")
      return ok(
        (args[1] ?? "").includes("sysconfig")
          ? `${opts.pyPlatform ?? "linux-x86_64"}\n`
          : "3.12.7\n",
      );
    if (args[0] === "-m" && args[1] === "pip") {
      if (args[2] === "check") {
        if (opts.pipCheckError) return fail(1, opts.pipCheckError);
        return ok("No broken requirements found.\n");
      }
      if (args.includes("-r") && !args.some((a) => a.endsWith("pip.txt"))) {
        if (opts.pipError && args.some((a) => a.includes("requirements-")))
          return fail(1, "", opts.pipError);
        const text =
          "Collecting torch==2.11.0\n  Downloading torch-2.11.0.whl (114.5 MB)\nProgress 0 of 1000\nProgress 500 of 1000\nProgress 1000 of 1000\nSuccessfully installed torch-2.11.0\n";
        req.onStdout?.(Buffer.from(text));
        return ok(text);
      }
      return ok("Requirement already satisfied: pip\n");
    }
    const script = args[0] ?? "";
    if (script.endsWith("fr_voice_models.py")) {
      const lines = [
        { type: "start", what: "whisper", repo: "Systran/faster-whisper-base", total: 100 },
        ...(opts.modelsRetry
          ? [{ type: "retry", what: "whisper", message: opts.modelsRetry }]
          : []),
        { type: "progress", what: "whisper", bytes: 50, total: 100 },
        { type: "done", what: "whisper", bytes: 100 },
        { type: "start", what: "kokoro", repo: "hexgrad/Kokoro-82M", total: 300 },
        { type: "done", what: "kokoro", bytes: 300 },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n");
      req.onStdout?.(Buffer.from(`${lines}\n`));
      return ok(`${lines}\n`);
    }
    if (script.endsWith("fr_stt.py")) {
      const device = args[args.indexOf("--device") + 1];
      const compute = args[args.indexOf("--compute-type") + 1];
      if (device === "cuda" && opts.sttCudaError)
        return fail(
          4,
          `${JSON.stringify({ type: "error", message: `model load failed: ${opts.sttCudaError}` })}\n`,
        );
      const out = [
        { type: "ready", model: "base", device, compute_type: compute },
        { type: "final", text: "", start_ms: 0, end_ms: 0, language: "en" },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n");
      return ok(`${out}\n`);
    }
    if (script.endsWith("fr_tts.py")) {
      const device = args[args.indexOf("--device") + 1];
      if (device === "cuda" && opts.ttsCudaError)
        return {
          code: 4,
          stdout: outFrame(2, 0, Buffer.from(`model load failed: ${opts.ttsCudaError}`)),
          stderr: "",
        };
      return ok(
        Buffer.concat([
          outFrame(
            3,
            0,
            Buffer.from(JSON.stringify({ sample_rate: 24000, engine: "kokoro", device })),
          ),
          outFrame(0, 1, Buffer.alloc(4800)),
          outFrame(1, 1),
        ]),
      );
    }
    return fail(2, "", `unexpected ${req.argv.join(" ")}`);
  };
  return { run, calls };
}
