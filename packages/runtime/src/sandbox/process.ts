import { stat } from "node:fs/promises";
import {
  type Clock,
  ForerunnerError,
  log,
  run as platformRun,
  type RunResult,
  resolve,
  systemClock,
} from "@forerunner/platform";
import { scrubEnv } from "../agent/sdk.ts";
import {
  containPathReal,
  readWorktreeFile,
  worktreeFileExists,
  writeWorktreeFile,
} from "./contain.ts";
import { type EgressDecision, EgressProxy } from "./egress-proxy.ts";
import type { NetworkPolicy, RunFn, Sandbox, SandboxLimits, SandboxRunOptions } from "./types.ts";

/**
 * Process sandbox: the stand-in when no container engine is reachable (ADR 0007). A child
 * process with a scrubbed environment (no credential-looking variables, PATH kept), cwd pinned
 * inside the worktree, wall-clock and output caps from the platform runner, and HTTP(S)_PROXY
 * pointing at an EgressProxy that enforces the task allowlist for well-behaved clients (and
 * denies everything for `{ mode: "none" }`). It is weaker than a container and says so: the
 * session log gets PROCESS_SANDBOX_WARNING, and `createSandbox` refuses it for risk tier >= 2
 * unless the project setting `allowProcessSandbox` is on.
 */
export const PROCESS_SANDBOX_WARNING = "sandbox: process (no container engine)";

export interface ProcessSandboxOptions {
  worktree: string;
  limits: SandboxLimits;
  network: NetworkPolicy;
  /** Environment set for every command. Never the host environment. */
  env?: Record<string, string>;
  /** Environment to scrub and inherit from; default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  run?: RunFn;
  clock?: Clock;
  egress?: { onDecision?: (d: EgressDecision) => void };
}

export class ProcessSandbox implements Sandbox {
  readonly kind = "process" as const;
  readonly worktree: string;
  readonly network: NetworkPolicy;
  readonly limits: SandboxLimits;
  readonly proxy: EgressProxy;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly run_: RunFn;
  private readonly logger = log("sandbox:process");
  private destroyed = false;

  private constructor(opts: ProcessSandboxOptions, proxy: EgressProxy) {
    this.worktree = resolve(opts.worktree);
    this.network = opts.network;
    this.limits = opts.limits;
    this.proxy = proxy;
    this.run_ = opts.run ?? platformRun;
    this.baseEnv = { ...scrubEnv(opts.baseEnv ?? process.env), ...(opts.env ?? {}) };
  }

  static async create(opts: ProcessSandboxOptions): Promise<ProcessSandbox> {
    const worktree = resolve(opts.worktree);
    const st = await stat(worktree).catch(() => null);
    if (!st?.isDirectory()) {
      throw new ForerunnerError("not_found", `worktree does not exist: ${worktree}`, {
        details: { worktree },
      });
    }
    const proxy = await EgressProxy.start({
      allow: opts.network.mode === "allowlist" ? opts.network.domains : [],
      bindHost: "127.0.0.1",
      token: EgressProxy.newToken(),
      onDecision: opts.egress?.onDecision,
      clock: opts.clock ?? systemClock,
    });
    const sandbox = new ProcessSandbox(opts, proxy);
    sandbox.logger.warn(PROCESS_SANDBOX_WARNING, {
      worktree,
      network: opts.network.mode,
      egressProxyPort: proxy.port,
    });
    return sandbox;
  }

  /** The environment a command receives (scrubbed base, sandbox env, run env, proxy, marker). */
  envFor(runEnv: Record<string, string> = {}): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.baseEnv)) if (v !== undefined) out[k] = v;
    Object.assign(out, runEnv, this.proxy.envFor("127.0.0.1"), {
      FORERUNNER_SANDBOX: "process",
    });
    return out;
  }

  async run(argv: readonly string[], opts: SandboxRunOptions = {}): Promise<RunResult> {
    this.assertAlive();
    if (argv.length === 0) throw new ForerunnerError("validation", "empty argv");
    // The child runs on the host, so the cwd walk is symlink-aware: a link that leaves the
    // worktree is refused rather than followed.
    const { host: cwd } = await containPathReal(this.worktree, opts.cwd ?? "");
    const st = await stat(cwd).catch(() => null);
    if (!st?.isDirectory()) {
      throw new ForerunnerError("not_found", `cwd does not exist in the worktree: ${opts.cwd}`);
    }
    const timeoutMs = Math.max(
      1,
      Math.min(opts.timeoutMs ?? this.limits.timeoutMs, this.limits.timeoutMs),
    );
    return this.run_(argv, {
      cwd,
      env: this.envFor(opts.env),
      timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
      input: opts.input,
      signal: opts.signal,
      allowFailure: true,
    });
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    this.assertAlive();
    await writeWorktreeFile(this.worktree, relPath, content);
  }

  async readFile(relPath: string): Promise<string> {
    this.assertAlive();
    return readWorktreeFile(this.worktree, relPath);
  }

  async exists(relPath: string): Promise<boolean> {
    this.assertAlive();
    return worktreeFileExists(this.worktree, relPath);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.proxy.close();
  }

  private assertAlive(): void {
    if (this.destroyed) throw new ForerunnerError("unavailable", "process sandbox was destroyed");
  }
}
