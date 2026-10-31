import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ForerunnerError } from "./errors.ts";
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
/** Bare names that are batch shims on a usual Windows install (npm's, corepack's, tsx's). */
const WINDOWS_SHIMS = ["npm", "pnpm", "npx", "yarn", "tsx", "corepack"];
/** What cmd.exe reads specially, escaped with `^` (cross-spawn's set; a space and `,;` too). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * The path of the batch file as `cmd /c` reads it: every metacharacter, spaces included,
 * escaped once with `^` (U-068).
 */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

/**
 * One argument for a batch file run through `cmd /d /s /c "..."`, so that it arrives unchanged
 * (U-068): quoted with the C runtime's rules (a quote becomes `\"`, the backslashes before it
 * and at the end are doubled), then every cmd metacharacter escaped with `^` twice: once for
 * cmd's own parse of the /c line, and once for the batch file's parse of the line its `%*` or
 * `%1` lands in (npm's, npx's and pnpm's shims hand `%*` to node), so `&`, `|`, `%PATH%` and a
 * quote are never read by either.
 */
export function escapeCmdArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/**
 * cmd.exe's arguments that run the batch file `script` with `args`, to be passed verbatim
 * (`windowsVerbatimArguments`). A line break cannot be carried through cmd (it would end the
 * command there), so such an argument is refused.
 */
export function cmdArgv(script: string, args: readonly string[]): string[] {
  for (const a of args) {
    if (/[\r\n]/.test(a))
      throw new ForerunnerError(
        "validation",
        `an argument with a line break cannot be passed to ${script} through cmd.exe`,
        { details: { reason: "line_break_for_cmd" } },
      );
  }
  const line = [escapeCmdCommand(script), ...args.map(escapeCmdArgument)].join(" ");
  return ["/d", "/s", "/c", `"${line}"`];
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/**
 * How a command runs on Windows. A `.cmd` or `.bat` file runs through cmd.exe. The bare shim
 * names are looked up as cmd would (the working folder, then `PATH`, each with `PATHEXT`): a
 * batch file runs through cmd, an `.exe` found first (a standalone `pnpm.exe`) runs directly,
 * since cmd's escaping would reach it as carets. Anything else is spawned directly.
 */
export function resolveWindowsCommand(
  cmd: string,
  opts: { env: NodeJS.ProcessEnv; cwd: string; isFile?: (p: string) => boolean },
): { file: string; viaCmd: boolean } {
  if (WINDOWS_SCRIPT_EXT.test(cmd)) return { file: cmd, viaCmd: true };
  if (!WINDOWS_SHIMS.includes(cmd)) return { file: cmd, viaCmd: false };
  const isFile = opts.isFile ?? ((p: string) => existsSync(p) && statSync(p).isFile());
  const dirs = [opts.cwd, ...(envValue(opts.env, "PATH") ?? "").split(";")].filter(Boolean);
  const exts = (envValue(opts.env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.win32.join(dir, `${cmd}${ext}`);
      if (isFile(candidate)) return { file: candidate, viaCmd: WINDOWS_SCRIPT_EXT.test(ext) };
    }
  }
  return { file: cmd, viaCmd: true };
}

export function spawnProcess(argv: readonly string[], opts: RunOptions = {}): ChildProcess {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("spawnProcess: empty argv");
  const env = opts.env ?? process.env;
  const common = {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"] as ("pipe" | "ignore")[],
    windowsHide: true,
    // never a shell: arguments are passed as an argv
    shell: false,
  };
  if (currentPlatform() === "windows") {
    const target = resolveWindowsCommand(cmd, { env, cwd: opts.cwd ?? process.cwd() });
    if (target.viaCmd) {
      // The line is escaped for cmd here (U-068), so Node must not quote it again.
      return spawn(process.env.ComSpec ?? "cmd.exe", cmdArgv(target.file, args), {
        ...common,
        windowsVerbatimArguments: true,
      });
    }
    return spawn(target.file, args, common);
  }
  return spawn(cmd, args, common);
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
