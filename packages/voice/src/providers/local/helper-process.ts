/**
 * A long-lived helper subprocess (Python STT/TTS helper, or a test double) spoken to over
 * stdin/stdout. Spawned through the platform runner with an argv array, never a shell.
 */
import type { ChildProcess } from "node:child_process";
import { type Clock, killTree, type Logger, spawnProcess, systemClock } from "@forerunner/platform";

export interface HelperProcessOptions {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Times the kill grace period in stop(); tests pass a SimulatedClock. Default: system clock. */
  clock?: Clock;
  log: Logger;
  onStdout: (data: Buffer) => void;
  onStderr?: (text: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onSpawnError?: (err: Error) => void;
}

/** How a helper's exit reads in a log line: the code in hex (Windows statuses) and a plain cause. */
export interface HelperExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The exit code as an unsigned 32-bit hex number (`0xC0000005`); null for a signal. */
  hex: string | null;
  /** What the code or signal usually means, in plain words. */
  cause: string;
  /** One line for a log or an error message: `exit code 3221225477 (0xC0000005): access ...`. */
  text: string;
}

/** Windows NTSTATUS codes a crashed native helper exits with (the process's exit code). */
const WINDOWS_STATUS = new Map<number, string>([
  [
    0xc0000005,
    "access violation: native code in the helper (faster-whisper, CTranslate2, onnxruntime) read or wrote memory it does not own and Windows ended the process",
  ],
  [0xc00000fd, "stack overflow in the helper's native code"],
  [0xc0000409, "stack buffer overrun (fail-fast) in the helper's native code"],
  [0xc000001d, "illegal instruction: a native library uses a CPU instruction this machine lacks"],
  [0xc0000374, "heap corruption in the helper's native code"],
  [0xc0000017, "out of memory"],
  [0xc000013a, "stopped by Ctrl+C or the console closing"],
  [0xc0000142, "a DLL failed to initialise when the helper started"],
]);

const SIGNAL_CAUSE: Partial<Record<NodeJS.Signals, string>> = {
  SIGSEGV: "segmentation fault: native code in the helper touched memory it does not own",
  SIGBUS: "bus error in the helper's native code",
  SIGILL: "illegal instruction: a native library uses a CPU instruction this machine lacks",
  SIGABRT: "the helper aborted (a native library gave up on a failed check)",
  SIGKILL: "killed from outside (the out-of-memory killer, or a forced stop)",
  SIGTERM: "asked to stop from outside",
};

/** The exit code in hex with a plain cause, for the log line of a helper that died. */
export function describeHelperExit(code: number | null, signal: NodeJS.Signals | null): HelperExit {
  if (code === null) {
    const cause = signal ? (SIGNAL_CAUSE[signal] ?? "ended by a signal") : "ended without a code";
    return { code, signal, hex: null, cause, text: `signal ${signal ?? "none"}: ${cause}` };
  }
  const unsigned = code >>> 0;
  const hex = `0x${unsigned.toString(16).toUpperCase().padStart(8, "0")}`;
  const cause =
    WINDOWS_STATUS.get(unsigned) ??
    (unsigned >= 0xc0000000
      ? "a Windows error status: the helper crashed in native code"
      : code === 0
        ? "a normal exit"
        : "the helper exited with an error (its log on stderr says why)");
  return { code, signal, hex, cause, text: `exit code ${code} (${hex}): ${cause}` };
}

/** Any exit but a clean exit code 0: a crash, an error exit, a signal, a failed spawn. */
export function isAbnormalExit(code: number | null, signal: NodeJS.Signals | null): boolean {
  return code !== 0 || signal !== null;
}

/**
 * A helper exit as the details of an error (`ForerunnerError.details`, an STT error event):
 * the code, in hex, the cause, and the stderr tail when there is one.
 */
export function helperExitDetails(exit: HelperExit, stderrTail: string): Record<string, unknown> {
  return {
    exitCode: exit.code,
    exitCodeHex: exit.hex,
    signal: exit.signal,
    cause: exit.cause,
    ...(stderrTail ? { stderrTail } : {}),
  };
}

/** How much of a helper's stderr a crash report carries: the last 40 lines, at most 4000 chars. */
export const STDERR_TAIL_LINES = 40;
export const STDERR_TAIL_CHARS = 4000;

/**
 * The last lines a helper wrote to stderr, kept for the report of a crash: Python's
 * faulthandler (on in fr_stt.py and fr_tts.py) writes the traceback of every thread there when
 * native code faults, just before the process dies. Chunks may split lines anywhere; an
 * unfinished last line is part of the tail. The text is capped to its newest `maxChars`.
 */
export class StderrTail {
  private lines: string[] = [];
  private partial = "";

  constructor(
    private readonly maxLines = STDERR_TAIL_LINES,
    private readonly maxChars = STDERR_TAIL_CHARS,
  ) {}

  push(text: string): void {
    const parts = (this.partial + text).split("\n");
    this.partial = (parts.pop() ?? "").slice(-this.maxChars);
    for (const p of parts) this.lines.push(p.replace(/\r$/, "").slice(-this.maxChars));
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }

  /** The tail as one string, lines joined with "\n", at most `maxLines` lines and `maxChars`. */
  text(): string {
    const all = this.partial ? [...this.lines, this.partial] : this.lines;
    const text = all.slice(-this.maxLines).join("\n");
    return text.length > this.maxChars ? text.slice(-this.maxChars) : text;
  }
}

export class HelperProcess {
  readonly child: ChildProcess;
  private readonly clock: Clock;
  private exited = false;
  private readonly tail = new StderrTail();

  constructor(opts: HelperProcessOptions) {
    this.clock = opts.clock ?? systemClock;
    this.child = spawnProcess(opts.argv, { env: opts.env, cwd: opts.cwd });
    this.child.stdout?.on("data", (d: Buffer) => opts.onStdout(d));
    this.child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      this.tail.push(text);
      opts.log.debug("helper stderr", { text: text.slice(0, 500) });
      opts.onStderr?.(text);
    });
    this.child.stdin?.on("error", () => {
      // EPIPE after the helper died: the exit handler reports it.
    });
    this.child.on("error", (err) => {
      if (this.exited) return;
      this.exited = true;
      opts.onSpawnError?.(err);
      opts.onExit(null, null);
    });
    this.child.on("close", (code, signal) => {
      if (this.exited) return;
      this.exited = true;
      opts.onExit(code, signal);
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  /**
   * The helper's last stderr lines (`StderrTail`). Complete once onExit has run: the child's
   * "close" event comes after its stdio streams closed.
   */
  stderrTail(): string {
    return this.tail.text();
  }

  write(data: Buffer): boolean {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(data);
    return true;
  }

  /** Send an optional goodbye frame, close stdin, wait for exit, kill after `timeoutMs`. */
  stop(goodbye?: Buffer, timeoutMs = 2000): Promise<void> {
    if (this.exited) return Promise.resolve();
    if (goodbye) this.write(goodbye);
    try {
      this.child.stdin?.end();
    } catch {
      // already closed
    }
    return new Promise((resolveStop) => {
      const cancelKill = this.clock.setTimeout(() => {
        killTree(this.child);
      }, timeoutMs);
      const done = () => {
        cancelKill();
        resolveStop();
      };
      if (this.exited) return done();
      this.child.once("close", done);
      this.child.once("error", done);
    });
  }

  kill(): void {
    if (this.exited) return;
    killTree(this.child);
  }
}
