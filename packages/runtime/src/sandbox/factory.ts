import { type Clock, currentPlatform, ForerunnerError, log } from "@forerunner/platform";
import {
  type ContainerEgressOptions,
  ContainerSandbox,
  type EgressRoute,
  parseEgressRoute,
  resolveRunnerImage,
} from "./container.ts";
import { type DetectOptions, detectSandboxEngine, type EngineDetection } from "./detect.ts";
import type { EgressDecision } from "./egress-proxy.ts";
import { PROCESS_SANDBOX_WARNING, ProcessSandbox } from "./process.ts";
import type { NetworkPolicy, RunFn, Sandbox, SandboxLimits, WhichFn } from "./types.ts";

/**
 * Picks the sandbox for a task: a container when an engine is reachable (and
 * FORERUNNER_SANDBOX_ENGINE is not "process"), else the process sandbox, which tasks at risk
 * tier >= 2 may only use when the project setting `allowProcessSandbox` is on. That rule is
 * enforced here, in code, not in a prompt.
 */
export interface CreateSandboxOptions {
  taskId: string;
  worktree: string;
  limits: SandboxLimits;
  network: NetworkPolicy;
  /** Task risk tier (0-3). Tier 2+ refuses the process sandbox unless allowProcessSandbox. */
  riskTier: number;
  /** Project setting. Default false. */
  allowProcessSandbox?: boolean;
  env?: Record<string, string>;
  /** Image from project/app configuration; falls back to FORERUNNER_RUNNER_IMAGE, then local. */
  image?: string;
  /** `--user` for containers; default on rootful Docker on Linux is the host uid:gid. */
  user?: string;
  /** Environment used for FORERUNNER_* settings; default process.env. */
  processEnv?: NodeJS.ProcessEnv;
  /** Pre-computed detection (skips the probe). */
  detection?: EngineDetection;
  run?: RunFn;
  which?: WhichFn;
  clock?: Clock;
  /** Egress options; `route`, `bindHost`, `advertisedHost` and `sidecarImage` default from the environment. */
  egress?: ContainerEgressOptions & { onDecision?: (d: EgressDecision) => void };
  timeoutWrapper?: boolean;
  /** Host uid/gid source for the default --user on Linux; default process.getuid/getgid. */
  hostIds?: () => { uid: number; gid: number } | null;
}

export interface CreatedSandbox {
  sandbox: Sandbox;
  engine: "docker" | "podman" | "process";
  /** Lines for the session log (the process-sandbox warning, image fallback notes). */
  warnings: string[];
  detection: EngineDetection;
}

/**
 * The gateway route needs the host to own the internal network's bridge, which is true for
 * rootful engines on native Linux. VM-based engines (Docker Desktop and podman machine on
 * Windows and macOS) and rootless engines (the bridge lives in a user namespace) reach the
 * host only through `host.docker.internal` / `host.containers.internal`, so they get the
 * relay sidecar. `FORERUNNER_EGRESS_ROUTE` overrides the choice.
 */
export function defaultEgressRoute(
  detection: Pick<EngineDetection, "rootless">,
  platform = currentPlatform(),
): EgressRoute {
  return platform === "linux" && !detection.rootless ? "gateway" : "sidecar";
}

export async function createSandbox(opts: CreateSandboxOptions): Promise<CreatedSandbox> {
  const logger = log("sandbox");
  const env = opts.processEnv ?? process.env;
  const warnings: string[] = [];
  const detectOpts: DetectOptions = { env };
  if (opts.which) detectOpts.which = opts.which;
  if (opts.run) detectOpts.run = opts.run;
  if (opts.clock) detectOpts.clock = opts.clock;
  const detection = opts.detection ?? (await detectSandboxEngine(detectOpts));

  if (detection.engine !== "none") {
    const engine = detection.engine;
    const user = opts.user ?? defaultUser(engine, detection, opts.hostIds);
    const containerEnv = { ...(opts.env ?? {}) };
    if (user && !containerEnv.HOME) containerEnv.HOME = "/tmp";
    const route =
      opts.egress?.route ??
      parseEgressRoute(env.FORERUNNER_EGRESS_ROUTE) ??
      defaultEgressRoute(detection);
    const sandbox = await ContainerSandbox.create({
      engine,
      image: resolveRunnerImage(opts.image, env),
      worktree: opts.worktree,
      limits: opts.limits,
      network: opts.network,
      env: containerEnv,
      user,
      taskId: opts.taskId,
      run: opts.run,
      clock: opts.clock,
      egress: {
        route,
        bindHost: opts.egress?.bindHost ?? env.FORERUNNER_EGRESS_BIND,
        advertisedHost: opts.egress?.advertisedHost ?? env.FORERUNNER_EGRESS_HOST,
        sidecarImage: opts.egress?.sidecarImage ?? env.FORERUNNER_EGRESS_IMAGE,
        onDecision: opts.egress?.onDecision,
      },
      timeoutWrapper: opts.timeoutWrapper,
      selinuxRelabel: env.FORERUNNER_SANDBOX_SELINUX === "1",
    });
    if (!opts.image && !env.FORERUNNER_RUNNER_IMAGE) {
      warnings.push(`sandbox: image not configured, using ${sandbox.image}`);
    }
    return { sandbox, engine, warnings, detection };
  }

  if (opts.riskTier >= 2 && !opts.allowProcessSandbox) {
    throw new ForerunnerError(
      "not_supported",
      `task at risk tier ${opts.riskTier} needs a container sandbox and none is reachable (${detection.reason}); enable the project setting allowProcessSandbox to run it in a process sandbox`,
      { details: { riskTier: opts.riskTier, taskId: opts.taskId, reason: detection.reason } },
    );
  }
  const warning = `${PROCESS_SANDBOX_WARNING}: ${detection.reason}`;
  warnings.push(warning);
  logger.warn(warning, { taskId: opts.taskId, riskTier: opts.riskTier });
  const sandbox = await ProcessSandbox.create({
    worktree: opts.worktree,
    limits: opts.limits,
    network: opts.network,
    env: opts.env,
    baseEnv: env,
    run: opts.run,
    clock: opts.clock,
    egress: { onDecision: opts.egress?.onDecision },
  });
  return { sandbox, engine: "process", warnings, detection };
}

/**
 * On rootful Docker on Linux, files a container writes as root land in the worktree as root;
 * running as the host uid:gid keeps them owned by the user. Rootless engines and Windows map
 * users already.
 */
function defaultUser(
  engine: "docker" | "podman",
  detection: EngineDetection,
  hostIds: CreateSandboxOptions["hostIds"],
): string | undefined {
  if (engine !== "docker" || detection.rootless || currentPlatform() !== "linux") return undefined;
  const ids = hostIds ? hostIds() : processIds();
  if (!ids) return undefined;
  return `${ids.uid}:${ids.gid}`;
}

function processIds(): { uid: number; gid: number } | null {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return null;
  return { uid: process.getuid(), gid: process.getgid() };
}
