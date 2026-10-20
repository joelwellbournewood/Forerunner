/**
 * Finding a Python interpreter and probing importable modules without ever throwing.
 * Local providers (faster-whisper, Kokoro) run bundled helper scripts through it.
 */
import { currentPlatform, run } from "@forerunner/platform";
import type { Availability } from "../../types.ts";

export interface PythonLookupOptions {
  /** Explicit interpreter (path or command). Overrides everything else. */
  python?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Candidate interpreter names per OS; FORERUNNER_PYTHON wins when set. */
export function pythonCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.FORERUNNER_PYTHON) out.push(env.FORERUNNER_PYTHON);
  if (currentPlatform() === "windows") out.push("python", "py", "python3");
  else out.push("python3", "python");
  return out;
}

/** Run `python -c <code>` for the first interpreter that starts. Never throws. */
export async function pythonRun(
  code: string,
  opts: PythonLookupOptions = {},
): Promise<{ python: string | null; code: number | null; stdout: string; stderr: string }> {
  const candidates = opts.python ? [opts.python] : pythonCandidates(opts.env);
  let lastErr = "";
  for (const py of candidates) {
    try {
      const r = await run([py, "-c", code], {
        allowFailure: true,
        timeoutMs: opts.timeoutMs ?? 20_000,
        env: opts.env,
      });
      // A missing interpreter rejects with ENOENT; any exit code means it ran.
      return { python: py, code: r.code, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { python: null, code: null, stdout: "", stderr: lastErr || "no python interpreter found" };
}

/** Locate a working interpreter (prints its version). */
export async function findPython(opts: PythonLookupOptions = {}): Promise<string | null> {
  const r = await pythonRun("import sys; print(sys.version.split()[0])", opts);
  return r.code === 0 ? r.python : null;
}

/** True with the interpreter when `import <module>` succeeds; a reason otherwise. */
export async function probePythonModule(
  module: string,
  opts: PythonLookupOptions = {},
): Promise<Availability & { python: string | null }> {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(module)) {
    return { ok: false, reason: `invalid module name ${JSON.stringify(module)}`, python: null };
  }
  const r = await pythonRun(`import ${module}`, opts);
  if (r.python === null) {
    return { ok: false, reason: `no python interpreter found (${r.stderr.trim()})`, python: null };
  }
  if (r.code === 0)
    return { ok: true, reason: `${module} importable with ${r.python}`, python: r.python };
  const lastLine = r.stderr.trim().split(/\r?\n/).pop() ?? "";
  return {
    ok: false,
    reason: `${r.python}: import ${module} failed: ${lastLine || `exit ${r.code}`}`,
    python: r.python,
  };
}
