import type { RunOptions, RunResult } from "@forerunner/platform";

/**
 * Sandbox layer (ADR 0007). Every coding or test task runs its commands through a Sandbox:
 * a container (Docker or Podman) with only the task worktree mounted and a per-task network
 * policy, a weaker process sandbox when no engine is reachable, or an in-memory fake for tests.
 */
export type SandboxKind = "container" | "process" | "fake";

/** Container engines the adapter can drive. "none" means no engine was found. */
export type SandboxEngineName = "docker" | "podman" | "none";

/**
 * Per-task network policy. "none" disconnects the sandbox entirely; "allowlist" lets only the
 * listed hosts through the egress proxy (exact host or `*.example.com` patterns, the same
 * syntax as a capability token's allowedDomains).
 */
export type NetworkPolicy = { mode: "none" } | { mode: "allowlist"; domains: string[] };

export interface SandboxLimits {
  /** CPU quota, e.g. 2 = two cores. Containers only. */
  cpus?: number;
  /** Memory cap in MiB. Containers only. */
  memoryMb?: number;
  /** Max processes inside the sandbox. Containers only. */
  pidsLimit?: number;
  /** Wall-clock cap per run() call in ms; also the ceiling for SandboxRunOptions.timeoutMs. */
  timeoutMs: number;
}

export interface SandboxRunOptions {
  /** Working directory relative to the worktree root. Absolute paths and ".." are refused. */
  cwd?: string;
  /** Extra environment for this command only. Never the host environment. */
  env?: Record<string, string>;
  /** Wall-clock limit for this command; capped by SandboxLimits.timeoutMs. */
  timeoutMs?: number;
  /** Text written to stdin, then stdin is closed. */
  input?: string;
  /** Max bytes kept per stream; the rest is dropped and `truncated` is set. */
  maxOutputBytes?: number;
  /** Aborting kills the command (the kill switch passes its signal here). */
  signal?: AbortSignal;
}

export interface Sandbox {
  readonly kind: SandboxKind;
  /** Absolute host path of the mounted worktree. */
  readonly worktree: string;
  readonly network: NetworkPolicy;
  /**
   * Run an argv array inside the sandbox. Always resolves with the RunResult (a non-zero exit
   * is a result, not an exception); throws only when the sandbox itself is unusable.
   */
  run(argv: readonly string[], opts?: SandboxRunOptions): Promise<RunResult>;
  /** Write a text file inside the worktree (LF line endings; parents created). */
  writeFile(relPath: string, content: string): Promise<void>;
  readFile(relPath: string): Promise<string>;
  exists(relPath: string): Promise<boolean>;
  /** Stop and remove the sandbox. Idempotent. The worktree on the host stays. */
  destroy(): Promise<void>;
}

/** Signature of `run` from @forerunner/platform, injectable so unit tests never spawn. */
export type RunFn = (argv: readonly string[], opts?: RunOptions) => Promise<RunResult>;

/** Signature of `which` from @forerunner/platform. */
export type WhichFn = (cmd: string) => Promise<string | null>;
