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

export class HelperProcess {
  readonly child: ChildProcess;
  private readonly clock: Clock;
  private exited = false;

  constructor(opts: HelperProcessOptions) {
    this.clock = opts.clock ?? systemClock;
    this.child = spawnProcess(opts.argv, { env: opts.env, cwd: opts.cwd });
    this.child.stdout?.on("data", (d: Buffer) => opts.onStdout(d));
    this.child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
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
