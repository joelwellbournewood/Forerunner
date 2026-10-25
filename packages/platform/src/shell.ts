import { type ChildProcess, spawn } from "node:child_process";
import { currentPlatform } from "./os.ts";

/**
 * Cross-platform process runner. Callers pass argv arrays, never shell strings,
 * so quoting is identical on Windows and Linux and injection through arguments
 * is impossible. Output is captured with a size cap and a wall-clock timeout.
 */
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Wall-clock limit in ms. Default 10 minutes. */
  timeoutMs?: number;
  /** Max bytes kept per stream. Default 4 MiB; the rest is dropped and flagged. */
  maxOutputBytes?: number;
  input?: string;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Resolve instead of throwing on a non-zero exit. */
  allowFailure?: boolean;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export class ShellError extends Error {
  constructor(
    readonly command: string[],
    readonly result: RunResult,
  ) {
    super(
      `Command failed (${result.timedOut ? "timeout" : `exit ${result.code}`}): ${command.join(" ")}\n${result.stderr.slice(-2000)}`,
    );
    this.name = "ShellError";
  }
}

const WINDOWS_SCRIPT_EXT = /\.(cmd|bat)$/i;

function resolveWindowsCommand(cmd: string): { file: string; argsPrefix: string[] } {
  // npm, pnpm, npx, etc. are .cmd shims on Windows. Run them through cmd.exe
  // without shell string interpolation of our own arguments.
  if (
    WINDOWS_SCRIPT_EXT.test(cmd) ||
    ["npm", "pnpm", "npx", "yarn", "tsx", "corepack"].includes(cmd)
  ) {
    return { file: process.env.ComSpec ?? "cmd.exe", argsPrefix: ["/d", "/s", "/c", cmd] };
  }
  return { file: cmd, argsPrefix: [] };
}

export function spawnProcess(argv: readonly string[], opts: RunOptions = {}): ChildProcess {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("spawnProcess: empty argv");
  const win = currentPlatform() === "windows";
  const { file, argsPrefix } = win ? resolveWindowsCommand(cmd) : { file: cmd, argsPrefix: [] };
  return spawn(file, [...argsPrefix, ...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // never a shell: arguments are passed verbatim
    shell: false,
  });
}

export async function run(argv: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const maxBytes = opts.maxOutputBytes ?? 4 * 1024 * 1024;
  const started = performance.now();
  const child = spawnProcess(argv, opts);

  let stdout = "";
  let stderr = "";
  let outBytes = 0;
  let errBytes = 0;
  let truncated = false;
  let timedOut = false;

  const collect = (
    which: "stdout" | "stderr",
    chunk: Buffer,
    cb: ((c: string) => void) | undefined,
  ) => {
    const text = chunk.toString("utf8");
    cb?.(text);
    if (which === "stdout") {
      if (outBytes + chunk.length <= maxBytes) stdout += text;
      else truncated = true;
      outBytes += chunk.length;
    } else {
      if (errBytes + chunk.length <= maxBytes) stderr += text;
      else truncated = true;
      errBytes += chunk.length;
    }
  };

  child.stdout?.on("data", (c: Buffer) => collect("stdout", c, opts.onStdout));
  child.stderr?.on("data", (c: Buffer) => collect("stderr", c, opts.onStderr));

  if (opts.input !== undefined) child.stdin?.end(opts.input);
  else child.stdin?.end();

  let killed = false;
  const kill = () => {
    killed = true;
    killTree(child);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const onAbort = () => kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, reject) => {
    child.on("error", reject);
    // `close` waits for the stdio streams, which a grandchild that inherited them (git's remote
    // helper, a runtime inside a sandbox) keeps open after the process we killed is gone. A
    // killed command therefore resolves at `exit`: the limit bounds the caller, not the tree.
    child.on("exit", (c, s) => {
      if (!killed) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveExit({ code: c, signal: s });
    });
    child.on("close", (c, s) => resolveExit({ code: c, signal: s }));
  }).finally(() => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  });

  const result: RunResult = {
    code,
    signal,
    stdout,
    stderr,
    truncated,
    timedOut,
    durationMs: Math.round(performance.now() - started),
  };
  if ((code !== 0 || timedOut) && !opts.allowFailure) throw new ShellError([...argv], result);
  return result;
}

/** Kill a process and its children on both platforms. Used by the kill switch. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (child.pid === undefined) return;
  if (currentPlatform() === "windows") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    // Negative pid targets the process group when the child was detached;
    // otherwise fall back to the direct pid.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Locate an executable on PATH without spawning a shell. */
export async function which(cmd: string): Promise<string | null> {
  const win = currentPlatform() === "windows";
  const r = await run(win ? ["where", cmd] : ["sh", "-c", `command -v "$1"`, "sh", cmd], {
    allowFailure: true,
    timeoutMs: 10_000,
  });
  if (r.code !== 0) return null;
  const first = r.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  return first ? first.trim() : null;
}
