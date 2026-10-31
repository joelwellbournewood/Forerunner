import {
  type Clock,
  errorMessage,
  log,
  run as platformRun,
  which as platformWhich,
  systemClock,
} from "@forerunner/platform";
import type { RunFn, SandboxEngineName, WhichFn } from "./types.ts";

/**
 * Finds a container engine. Docker is probed first (`docker info`), then Podman. The answer is
 * cached per process for `ttlMs` (default 60 s) on the injected Clock so a session does not
 * spawn `docker info` before every command. `FORERUNNER_SANDBOX_ENGINE=docker|podman|process`
 * narrows the probe to one engine or skips it. Never throws: an unusable engine is reported as
 * `engine: "none"` with the reason and, for the Settings card's steps (U-079), the `problem`.
 *
 * Docker in Windows-container mode (`docker info` says `OSType` windows) never counts as an
 * engine: it cannot run the Linux runner image (bind mounts to `/work` are refused).
 */
export interface EngineDetection {
  engine: SandboxEngineName;
  version?: string;
  /** Human-readable explanation of the outcome (daemon error text when none was found). */
  reason: string;
  /** True when the engine runs rootless (Podman default, Docker rootless mode). */
  rootless?: boolean;
  /** The FORERUNNER_SANDBOX_ENGINE value that shaped this answer, if any. */
  override?: EngineOverride;
  /**
   * Why no engine is usable, when `engine` is "none" (U-079): no CLI on PATH, a CLI whose
   * daemon does not answer, or Docker running Windows containers. Absent on an older pinned
   * detection, which reads as `not_installed`.
   */
  problem?: EngineProblem;
  checkedAt: string;
}

/** Why no container engine can run the sandbox (U-079), most specific last. */
export type EngineProblem = "not_installed" | "not_running" | "windows_containers";

/** How specific a problem is: the one with the clearest next step wins across engines. */
const PROBLEM_RANK: Record<EngineProblem, number> = {
  not_installed: 0,
  not_running: 1,
  windows_containers: 2,
};

export type EngineOverride = "docker" | "podman" | "process";

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  which?: WhichFn;
  run?: RunFn;
  clock?: Clock;
  /** Cache lifetime in ms; 0 disables the cache. Default 60 000. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;

let cache: { key: string; at: number; value: EngineDetection } | null = null;

/** Drop the cached answer (tests, and after the user installs an engine). */
export function resetSandboxEngineCache(): void {
  cache = null;
}

export function parseEngineOverride(value: string | undefined): EngineOverride | undefined {
  const v = value?.trim().toLowerCase();
  if (v === "docker" || v === "podman" || v === "process") return v;
  return undefined;
}

export async function detectSandboxEngine(opts: DetectOptions = {}): Promise<EngineDetection> {
  const env = opts.env ?? process.env;
  const clock = opts.clock ?? systemClock;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const rawOverride = env.FORERUNNER_SANDBOX_ENGINE;
  const override = parseEngineOverride(rawOverride);
  const key = override ?? "auto";

  if (ttl > 0 && cache && cache.key === key && clock.now() - cache.at < ttl) return cache.value;

  const value = await probe({
    which: opts.which ?? platformWhich,
    run: opts.run ?? platformRun,
    override,
    rawOverride,
    checkedAt: clock.nowIso(),
  });
  if (ttl > 0) cache = { key, at: clock.now(), value };
  return value;
}

interface ProbeDeps {
  which: WhichFn;
  run: RunFn;
  override: EngineOverride | undefined;
  rawOverride: string | undefined;
  checkedAt: string;
}

async function probe(deps: ProbeDeps): Promise<EngineDetection> {
  const logger = log("sandbox:detect");
  const { override, rawOverride, checkedAt } = deps;
  if (override === "process") {
    return {
      engine: "none",
      reason: "FORERUNNER_SANDBOX_ENGINE=process: container engines skipped",
      override,
      problem: "not_installed",
      checkedAt,
    };
  }
  if (rawOverride && !override) {
    logger.warn("unknown FORERUNNER_SANDBOX_ENGINE value ignored", { value: rawOverride });
  }
  const order: ("docker" | "podman")[] = override ? [override] : ["docker", "podman"];
  const reasons: string[] = [];
  let problem: EngineProblem = "not_installed";
  for (const engine of order) {
    const r = engine === "docker" ? await probeDocker(deps) : await probePodman(deps);
    if (r.ok) {
      const found: EngineDetection = {
        engine,
        version: r.version,
        rootless: r.rootless,
        reason: `${engine} ${r.version}${r.rootless ? " (rootless)" : ""} reachable`,
        checkedAt,
      };
      if (override) found.override = override;
      logger.info("container engine detected", {
        engine,
        version: r.version,
        rootless: r.rootless,
      });
      return found;
    }
    reasons.push(`${engine}: ${r.reason}`);
    if (PROBLEM_RANK[r.problem] > PROBLEM_RANK[problem]) problem = r.problem;
  }
  const none: EngineDetection = { engine: "none", reason: reasons.join("; "), problem, checkedAt };
  if (override) none.override = override;
  logger.warn("no container engine reachable", { reason: none.reason });
  return none;
}

type ProbeResult =
  | { ok: true; version: string; rootless: boolean }
  | { ok: false; reason: string; problem: EngineProblem };

/** The `docker info` template: version, security options, and the OS of the containers it runs. */
export const DOCKER_INFO_FORMAT = "{{.ServerVersion}}|{{.SecurityOptions}}|{{.OSType}}";

async function probeDocker(deps: ProbeDeps): Promise<ProbeResult> {
  try {
    if ((await deps.which("docker")) === null)
      return { ok: false, reason: "docker not on PATH", problem: "not_installed" };
    const r = await deps.run(["docker", "info", "--format", DOCKER_INFO_FORMAT], {
      allowFailure: true,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (r.timedOut) return { ok: false, reason: "docker info timed out", problem: "not_running" };
    const [version = "", security = "", osType = ""] = r.stdout.trim().split("|");
    if (r.code !== 0 || !version) {
      return {
        ok: false,
        reason: tail(r.stderr) || `docker info exited ${r.code}`,
        problem: "not_running",
      };
    }
    // Docker Desktop on Windows can run Windows containers instead of Linux ones; the runner
    // image is a Linux image, so that engine is not usable (U-079). An older engine that does
    // not report OSType is taken as Linux.
    const os = osType.trim().toLowerCase();
    if (os && os !== "linux") {
      return {
        ok: false,
        reason: `docker ${version} runs ${os} containers; the sandbox needs Linux containers (Docker Desktop: Switch to Linux containers)`,
        problem: "windows_containers",
      };
    }
    return { ok: true, version, rootless: /rootless/i.test(security) };
  } catch (e) {
    return { ok: false, reason: errorMessage(e), problem: "not_running" };
  }
}

async function probePodman(deps: ProbeDeps): Promise<ProbeResult> {
  try {
    if ((await deps.which("podman")) === null)
      return { ok: false, reason: "podman not on PATH", problem: "not_installed" };
    const r = await deps.run(
      ["podman", "info", "--format", "{{.Version.Version}}|{{.Host.Security.Rootless}}"],
      { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (r.timedOut) return { ok: false, reason: "podman info timed out", problem: "not_running" };
    const [version = "", rootless = ""] = r.stdout.trim().split("|");
    if (r.code !== 0 || !version) {
      return {
        ok: false,
        reason: tail(r.stderr) || `podman info exited ${r.code}`,
        problem: "not_running",
      };
    }
    return { ok: true, version, rootless: rootless.trim() !== "false" };
  } catch (e) {
    return { ok: false, reason: errorMessage(e), problem: "not_running" };
  }
}

function tail(text: string, max = 300): string {
  const t = text.trim();
  return t.length > max ? t.slice(-max) : t;
}
