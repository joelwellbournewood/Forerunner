import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  log,
  run as platformRun,
  type RunResult,
  resolve,
  safeSegment,
  systemClock,
} from "@forerunner/platform";
import { containPath, readWorktreeFile, worktreeFileExists, writeWorktreeFile } from "./contain.ts";
import { type EgressDecision, EgressProxy } from "./egress-proxy.ts";
import type { NetworkPolicy, RunFn, Sandbox, SandboxLimits, SandboxRunOptions } from "./types.ts";

/**
 * Container sandbox: one long-lived `docker run -d ... sleep infinity` (or `podman`) per task
 * with only the worktree bind-mounted at /work, dropped capabilities, no-new-privileges, CPU,
 * memory and pid limits, and a network policy the kernel enforces:
 *
 * - `{ mode: "none" }`: `--network none`.
 * - `{ mode: "allowlist" }`: the container is attached to a per-sandbox `--internal` network
 *   (no route to anything outside its subnet), and the only thing it can reach there is the
 *   task's EgressProxy, which allows the listed hosts and answers 403 for the rest. Two
 *   routes to the proxy exist (see `EgressRoute`): the proxy on the internal network's
 *   gateway address (rootful engines on Linux) or a tiny relay sidecar on both the internal
 *   and the engine's default network (VM-based and rootless engines).
 *
 * Commands run with `exec`. Every engine call is an argv array; there is never a shell string.
 */

/** Fallback image when neither config nor FORERUNNER_RUNNER_IMAGE names one. */
export const DEFAULT_RUNNER_IMAGE = "forerunner-runner:local";

/** Mount point of the worktree inside the container. */
export const CONTAINER_WORKDIR = "/work";

/** Port the egress relay sidecar listens on inside the internal network. */
export const EGRESS_RELAY_PORT = 3128;

/**
 * Environment variables a sandbox owns in allowlist mode. A per-run `env` cannot set them
 * (the container sandbox strips them, the process sandbox overrides them).
 */
export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

/**
 * How a container on the internal network reaches the egress proxy on the host.
 *
 * - `gateway`: the proxy listens on the internal network's gateway address, which the host
 *   owns when the engine runs rootful on native Linux. No extra container.
 * - `sidecar`: a relay container (`node -e <EGRESS_RELAY_SCRIPT>`, same image as the task
 *   unless `sidecarImage` says otherwise) joins the engine's default network, where it can
 *   reach the host as `host.docker.internal` / `host.containers.internal`, and the internal
 *   network, where the task container reaches it. Needed when the engine runs in a VM
 *   (Docker Desktop, podman machine) or rootless (the bridge lives in a user namespace).
 */
export type EgressRoute = "gateway" | "sidecar";

/** TCP relay run by the egress sidecar: everything that reaches it goes to the host proxy. */
export const EGRESS_RELAY_SCRIPT = [
  'const net = require("net");',
  "const host = process.env.FR_EGRESS_UPSTREAM_HOST;",
  "const port = Number(process.env.FR_EGRESS_UPSTREAM_PORT);",
  "const listen = Number(process.env.FR_EGRESS_LISTEN_PORT);",
  "net.createServer((c) => {",
  "  const u = net.connect(port, host);",
  "  const end = () => { c.destroy(); u.destroy(); };",
  '  c.on("error", end); u.on("error", end); c.on("close", end); u.on("close", end);',
  "  c.pipe(u); u.pipe(c);",
  '}).listen(listen, "0.0.0.0");',
].join("\n");

/**
 * Image precedence: the project or app configuration, then `FORERUNNER_RUNNER_IMAGE`, then the
 * locally built `forerunner-runner:local` (`docker build -t forerunner-runner:local -f
 * services/cloud-runner/Dockerfile .`). No registry owner is ever assumed.
 */
export function resolveRunnerImage(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromConfig = configured?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = env.FORERUNNER_RUNNER_IMAGE?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_RUNNER_IMAGE;
}

export function parseEgressRoute(value: string | undefined): EgressRoute | undefined {
  const v = value?.trim().toLowerCase();
  return v === "gateway" || v === "sidecar" ? v : undefined;
}

export interface ContainerEgressOptions {
  /** Route to the proxy; default "gateway". The factory picks per engine and OS. */
  route?: EgressRoute;
  /**
   * Interface the proxy listens on. Default: the internal network's gateway address (gateway
   * route; falls back to 0.0.0.0 when the host cannot bind it) or 0.0.0.0 (sidecar route).
   */
  bindHost?: string;
  /**
   * Gateway route: host the container uses in the proxy URL instead of the gateway address.
   * Sidecar route: host the relay connects to; default per engine (see hostAlias).
   */
  advertisedHost?: string;
  /** Image for the relay sidecar; default the task image (it needs `node`). */
  sidecarImage?: string;
  onDecision?: (d: EgressDecision) => void;
}

export interface ContainerSandboxOptions {
  engine: "docker" | "podman";
  /** Image name; see resolveRunnerImage. */
  image?: string;
  worktree: string;
  limits: SandboxLimits;
  network: NetworkPolicy;
  /** Environment set for every command in the container. Never the host environment. */
  env?: Record<string, string>;
  /** `--user uid:gid`; keeps worktree files owned by the host user on rootful Docker. */
  user?: string;
  taskId?: string;
  run?: RunFn;
  clock?: Clock;
  egress?: ContainerEgressOptions;
  /**
   * Wrap every command in coreutils `timeout -s KILL <s>` inside the container so a timed-out
   * command dies there too (the exec client alone cannot kill it). Default true; set false for
   * images without coreutils.
   */
  timeoutWrapper?: boolean;
  /** Add `relabel=private` to the mount for SELinux hosts (Fedora with Podman). */
  selinuxRelabel?: boolean;
  /** Extra `run` flags inserted before the image (for example `--platform`). */
  extraArgs?: string[];
}

export interface ContainerRunArgvInput {
  engine: "docker" | "podman";
  image: string;
  name: string;
  worktree: string;
  limits: SandboxLimits;
  network: NetworkPolicy;
  env?: Record<string, string>;
  user?: string;
  taskId?: string;
  /** Proxy URL as seen from inside the container (allowlist mode). */
  proxyUrl?: string;
  /** The sandbox's internal network (required in allowlist mode). */
  networkName?: string;
  selinuxRelabel?: boolean;
  extraArgs?: string[];
}

export interface EgressSidecarArgvInput {
  engine: "docker" | "podman";
  image: string;
  name: string;
  taskId?: string;
  /** Host the relay connects to (the proxy on the host as the engine's network sees it). */
  upstreamHost: string;
  upstreamPort: number;
  listenPort?: number;
  user?: string;
}

/** Host name through which a container reaches services on the host, per engine. */
export function hostAlias(engine: "docker" | "podman"): string {
  return engine === "docker" ? "host.docker.internal" : "host.containers.internal";
}

/** The engine's default (externally connected) network, used only by the egress sidecar. */
export function defaultNetworkName(engine: "docker" | "podman"): string {
  return engine === "docker" ? "bridge" : "podman";
}

export function networkNameFor(containerName: string): string {
  return `${containerName}-net`;
}

export function sidecarNameFor(containerName: string): string {
  return `${containerName}-egress`;
}

/** Pure argv builder for `docker|podman run`; snapshot-tested. */
export function buildContainerRunArgv(input: ContainerRunArgvInput): string[] {
  const { engine, limits, network } = input;
  if (input.worktree.includes(",")) {
    throw new ForerunnerError("validation", "worktree path must not contain a comma (mount spec)", {
      details: { worktree: input.worktree },
    });
  }
  const argv: string[] = [engine, "run", "-d", "--rm", "--name", input.name];
  argv.push("--label", "forerunner.sandbox=1");
  if (input.taskId) argv.push("--label", `forerunner.task=${input.taskId}`);
  let mount = `type=bind,src=${input.worktree},dst=${CONTAINER_WORKDIR}`;
  if (input.selinuxRelabel) mount += ",relabel=private";
  argv.push("--mount", mount, "--workdir", CONTAINER_WORKDIR);
  if (network.mode === "none") {
    argv.push("--network", "none");
  } else {
    if (!input.networkName) {
      throw new ForerunnerError(
        "validation",
        "allowlist mode needs the sandbox's internal network (networkName)",
      );
    }
    argv.push("--network", input.networkName);
  }
  if (limits.cpus !== undefined) argv.push("--cpus", String(limits.cpus));
  if (limits.memoryMb !== undefined) argv.push("--memory", `${Math.round(limits.memoryMb)}m`);
  if (limits.pidsLimit !== undefined) argv.push("--pids-limit", String(limits.pidsLimit));
  argv.push("--security-opt", "no-new-privileges", "--cap-drop", "ALL");
  if (input.user) argv.push("--user", input.user);
  if (network.mode === "allowlist" && input.proxyUrl) {
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"]) {
      argv.push("-e", `${k}=${input.proxyUrl}`);
    }
    argv.push("-e", "NO_PROXY=", "-e", "no_proxy=");
  }
  for (const [k, v] of Object.entries(input.env ?? {})) {
    assertEnvKey(k);
    argv.push("-e", `${k}=${v}`);
  }
  argv.push("-e", "FORERUNNER_SANDBOX=container");
  if (input.extraArgs?.length) argv.push(...input.extraArgs);
  argv.push(input.image, "sleep", "infinity");
  return argv;
}

/** `docker|podman network create --internal ...` for the sandbox's private network. */
export function buildNetworkCreateArgv(
  engine: "docker" | "podman",
  networkName: string,
  taskId?: string,
): string[] {
  const argv = [engine, "network", "create", "--internal", "--label", "forerunner.sandbox=1"];
  if (taskId) argv.push("--label", `forerunner.task=${taskId}`);
  argv.push(networkName);
  return argv;
}

/** `docker|podman run` for the egress relay sidecar on the engine's default network. */
export function buildEgressSidecarArgv(input: EgressSidecarArgvInput): string[] {
  const { engine } = input;
  const argv = [engine, "run", "-d", "--rm", "--name", input.name];
  argv.push("--label", "forerunner.sandbox=1", "--label", "forerunner.role=egress");
  if (input.taskId) argv.push("--label", `forerunner.task=${input.taskId}`);
  argv.push("--network", defaultNetworkName(engine));
  if (engine === "docker") argv.push("--add-host", `${hostAlias(engine)}:host-gateway`);
  argv.push("--security-opt", "no-new-privileges", "--cap-drop", "ALL");
  argv.push("--memory", "128m", "--pids-limit", "64");
  if (input.user) argv.push("--user", input.user);
  argv.push("-e", `FR_EGRESS_UPSTREAM_HOST=${input.upstreamHost}`);
  argv.push("-e", `FR_EGRESS_UPSTREAM_PORT=${input.upstreamPort}`);
  argv.push("-e", `FR_EGRESS_LISTEN_PORT=${input.listenPort ?? EGRESS_RELAY_PORT}`);
  argv.push(input.image, "node", "-e", EGRESS_RELAY_SCRIPT);
  return argv;
}

/**
 * IPv4 gateway of a network from `<engine> network inspect <name>`. Docker prints
 * `[{IPAM:{Config:[{Subnet,Gateway}]}}]`, Podman `[{subnets:[{subnet,gateway}]}]`.
 */
export function parseNetworkGateway(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first !== "object") return null;
  const rec = first as {
    IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
    subnets?: { subnet?: string; gateway?: string }[];
  };
  const candidates = [
    ...(rec.IPAM?.Config ?? []).map((c) => c.Gateway),
    ...(rec.subnets ?? []).map((s) => s.gateway),
  ];
  return (
    candidates.find((g): g is string => typeof g === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(g)) ??
    null
  );
}

/** A container's address on one network from `inspect --format {{json .NetworkSettings.Networks}}`. */
export function parseContainerAddress(json: string, networkName: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const entry = (parsed as Record<string, { IPAddress?: string }>)[networkName];
  const ip = entry?.IPAddress;
  return typeof ip === "string" && ip.length > 0 ? ip : null;
}

/** Drop the proxy variables a sandbox owns from a per-run environment. */
export function stripProxyEnv(env: Record<string, string> = {}): Record<string, string> {
  const owned = new Set<string>(PROXY_ENV_KEYS);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (!owned.has(k)) out[k] = v;
  return out;
}

function assertEnvKey(k: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
    throw new ForerunnerError("validation", `invalid environment variable name: ${k}`);
  }
}

interface EgressSetup {
  proxy: EgressProxy;
  route: EgressRoute;
  /** Proxy address as the task container sees it. */
  address: { host: string; port: number };
  sidecarName: string | null;
}

export class ContainerSandbox implements Sandbox {
  readonly kind = "container" as const;
  readonly engine: "docker" | "podman";
  readonly image: string;
  readonly name: string;
  readonly worktree: string;
  readonly network: NetworkPolicy;
  readonly limits: SandboxLimits;
  /** The egress proxy in allowlist mode, for stats and tests. */
  readonly proxy: EgressProxy | null;
  /** The sandbox's internal network in allowlist mode. */
  readonly networkName: string | null;
  /** The relay sidecar's container name (sidecar route only). */
  readonly sidecarName: string | null;
  readonly egressRoute: EgressRoute | null;
  /** Where the task container reaches the proxy (allowlist mode). */
  readonly proxyAddress: { host: string; port: number } | null;
  private readonly run_: RunFn;
  private readonly timeoutWrapper: boolean;
  private readonly logger = log("sandbox:container");
  private destroyed = false;

  private constructor(
    opts: ContainerSandboxOptions,
    name: string,
    image: string,
    networkName: string | null,
    egress: EgressSetup | null,
  ) {
    this.engine = opts.engine;
    this.image = image;
    this.name = name;
    this.worktree = resolve(opts.worktree);
    this.network = opts.network;
    this.limits = opts.limits;
    this.proxy = egress?.proxy ?? null;
    this.networkName = networkName;
    this.sidecarName = egress?.sidecarName ?? null;
    this.egressRoute = egress?.route ?? null;
    this.proxyAddress = egress?.address ?? null;
    this.run_ = opts.run ?? platformRun;
    this.timeoutWrapper = opts.timeoutWrapper ?? true;
  }

  static containerName(taskId?: string): string {
    return `forerunner-${safeSegment(taskId ?? "task", "task")}-${randomBytes(4).toString("hex")}`;
  }

  /**
   * Start the container; in allowlist mode first the internal network, the egress proxy and,
   * on the sidecar route, the relay container. Everything created before a failure is removed
   * again before the error is thrown.
   */
  static async create(opts: ContainerSandboxOptions): Promise<ContainerSandbox> {
    const worktree = resolve(opts.worktree);
    const st = await stat(worktree).catch(() => null);
    if (!st?.isDirectory()) {
      throw new ForerunnerError("not_found", `worktree does not exist: ${worktree}`, {
        details: { worktree },
      });
    }
    const image = resolveRunnerImage(opts.image);
    const name = ContainerSandbox.containerName(opts.taskId);
    const run = opts.run ?? platformRun;
    const clock = opts.clock ?? systemClock;
    const logger = log("sandbox:container");
    const engineRun = async (argv: string[], timeoutMs = 120_000): Promise<string> => {
      const r = await run(argv, { allowFailure: true, timeoutMs });
      if (r.code !== 0 || r.timedOut) {
        throw new ForerunnerError(
          "unavailable",
          `${argv[0]} ${argv[1]} ${argv[1] === "network" ? argv[2] : ""} failed${r.timedOut ? " (timeout)" : ` (exit ${r.code})`}: ${r.stderr.trim().slice(-1000)}`.replace(
            /\s+failed/,
            " failed",
          ),
          { details: { engine: opts.engine, image, name, argv: argv.slice(0, 4) } },
        );
      }
      return r.stdout;
    };

    let networkName: string | null = null;
    let egress: EgressSetup | null = null;
    let proxy: EgressProxy | null = null;
    const cleanup = async (): Promise<void> => {
      if (egress?.sidecarName) {
        await run([opts.engine, "rm", "-f", egress.sidecarName], {
          allowFailure: true,
          timeoutMs: 60_000,
        }).catch(() => undefined);
      }
      if (networkName) {
        await run([opts.engine, "network", "rm", networkName], {
          allowFailure: true,
          timeoutMs: 60_000,
        }).catch(() => undefined);
      }
      await proxy?.close();
    };

    try {
      let proxyUrl: string | undefined;
      if (opts.network.mode === "allowlist") {
        networkName = networkNameFor(name);
        await engineRun(buildNetworkCreateArgv(opts.engine, networkName, opts.taskId));
        const route = opts.egress?.route ?? "gateway";
        const proxyOpts = {
          allow: opts.network.domains,
          token: EgressProxy.newToken(),
          onDecision: opts.egress?.onDecision,
          clock,
        };
        if (route === "gateway") {
          const gateway = parseNetworkGateway(
            await engineRun([opts.engine, "network", "inspect", networkName]),
          );
          if (!gateway) {
            throw new ForerunnerError(
              "unavailable",
              `cannot determine the gateway address of network ${networkName}; set FORERUNNER_EGRESS_ROUTE=sidecar`,
              { details: { engine: opts.engine, networkName } },
            );
          }
          proxy = await startProxy(proxyOpts, opts.egress?.bindHost ?? gateway, "0.0.0.0", logger);
          const host = opts.egress?.advertisedHost ?? gateway;
          egress = { proxy, route, address: { host, port: proxy.port }, sidecarName: null };
        } else {
          proxy = await startProxy(proxyOpts, opts.egress?.bindHost ?? "0.0.0.0", null, logger);
          const sidecarName = sidecarNameFor(name);
          await engineRun(
            buildEgressSidecarArgv({
              engine: opts.engine,
              image: opts.egress?.sidecarImage ?? image,
              name: sidecarName,
              taskId: opts.taskId,
              upstreamHost: opts.egress?.advertisedHost ?? hostAlias(opts.engine),
              upstreamPort: proxy.port,
              listenPort: EGRESS_RELAY_PORT,
              user: opts.user,
            }),
            10 * 60_000,
          );
          egress = {
            proxy,
            route,
            address: { host: "", port: EGRESS_RELAY_PORT },
            sidecarName,
          };
          await engineRun([opts.engine, "network", "connect", networkName, sidecarName]);
          const address = parseContainerAddress(
            await engineRun([
              opts.engine,
              "inspect",
              "--format",
              "{{json .NetworkSettings.Networks}}",
              sidecarName,
            ]),
            networkName,
          );
          if (!address) {
            throw new ForerunnerError(
              "unavailable",
              `cannot determine the address of ${sidecarName} on ${networkName}`,
              { details: { engine: opts.engine, networkName, sidecarName } },
            );
          }
          egress.address = { host: address, port: EGRESS_RELAY_PORT };
        }
        proxyUrl = proxy.url(egress.address.host, egress.address.port);
      }
      const argv = buildContainerRunArgv({
        engine: opts.engine,
        image,
        name,
        worktree,
        limits: opts.limits,
        network: opts.network,
        env: opts.env,
        user: opts.user,
        taskId: opts.taskId,
        proxyUrl,
        networkName: networkName ?? undefined,
        selinuxRelabel: opts.selinuxRelabel,
        extraArgs: opts.extraArgs,
      });
      await engineRun(argv, 10 * 60_000);
    } catch (e) {
      await cleanup();
      throw e;
    }
    const sandbox = new ContainerSandbox(opts, name, image, networkName, egress);
    sandbox.logger.info("container sandbox started", {
      engine: opts.engine,
      image,
      name,
      network: opts.network.mode,
      networkName,
      egressRoute: egress?.route ?? null,
      worktree,
    });
    return sandbox;
  }

  async run(argv: readonly string[], opts: SandboxRunOptions = {}): Promise<RunResult> {
    this.assertAlive();
    if (argv.length === 0) throw new ForerunnerError("validation", "empty argv");
    const exec = this.execArgvFor(argv, opts);
    const innerSeconds = this.innerSeconds(opts);
    const r = await this.run_(exec, {
      allowFailure: true,
      timeoutMs: this.timeoutWrapper ? innerSeconds * 1000 + 5_000 : this.timeoutMs(opts),
      maxOutputBytes: opts.maxOutputBytes,
      input: opts.input,
      signal: opts.signal,
    });
    const killedByWrapper =
      this.timeoutWrapper &&
      (r.code === 124 || r.code === 137) &&
      r.durationMs >= innerSeconds * 1000 - 100;
    if (killedByWrapper || r.timedOut) return { ...r, timedOut: true };
    return r;
  }

  /**
   * The exec argv for a command (also used by tests). The cwd is resolved inside the
   * container's own mount namespace, so lexical containment is the right check here; the
   * proxy variables the sandbox owns are stripped from the per-run environment.
   */
  execArgvFor(argv: readonly string[], opts: SandboxRunOptions = {}): string[] {
    const { rel } = containPath(this.worktree, opts.cwd ?? "");
    const exec: string[] = [this.engine, "exec"];
    if (opts.input !== undefined) exec.push("-i");
    exec.push("--workdir", rel ? `${CONTAINER_WORKDIR}/${rel}` : CONTAINER_WORKDIR);
    for (const [k, v] of Object.entries(stripProxyEnv(opts.env))) {
      assertEnvKey(k);
      exec.push("-e", `${k}=${v}`);
    }
    exec.push(this.name);
    if (this.timeoutWrapper) exec.push("timeout", "-s", "KILL", String(this.innerSeconds(opts)));
    exec.push(...argv);
    return exec;
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

  /** Remove the container, the relay sidecar and the internal network; close the proxy. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const remove = async (argv: string[], what: string): Promise<void> => {
      try {
        const r = await this.run_(argv, { allowFailure: true, timeoutMs: 60_000 });
        if (r.code !== 0) {
          this.logger.warn(`${what} remove returned non-zero`, {
            name: argv.at(-1),
            code: r.code,
            stderr: r.stderr.trim().slice(-300),
          });
        }
      } catch (e) {
        this.logger.warn(`${what} remove failed`, { name: argv.at(-1), error: errorMessage(e) });
      }
    };
    await remove([this.engine, "rm", "-f", this.name], "container");
    if (this.sidecarName) await remove([this.engine, "rm", "-f", this.sidecarName], "sidecar");
    if (this.networkName) {
      await remove([this.engine, "network", "rm", this.networkName], "network");
    }
    await this.proxy?.close();
    this.logger.info("container sandbox destroyed", { name: this.name });
  }

  private timeoutMs(opts: SandboxRunOptions): number {
    return Math.max(1, Math.min(opts.timeoutMs ?? this.limits.timeoutMs, this.limits.timeoutMs));
  }

  private innerSeconds(opts: SandboxRunOptions): number {
    return Math.max(1, Math.ceil(this.timeoutMs(opts) / 1000));
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new ForerunnerError("unavailable", `sandbox ${this.name} was destroyed`);
    }
  }
}

/**
 * Start the proxy on `bindHost`; when the host cannot bind that address (the engine's bridge
 * has no address yet, or lives in another namespace) and a fallback is given, listen there
 * instead and say so.
 */
async function startProxy(
  opts: Omit<Parameters<typeof EgressProxy.start>[0], "bindHost">,
  bindHost: string,
  fallback: string | null,
  logger: ReturnType<typeof log>,
): Promise<EgressProxy> {
  try {
    return await EgressProxy.start({ ...opts, bindHost });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (fallback && fallback !== bindHost && (code === "EADDRNOTAVAIL" || code === "EINVAL")) {
      logger.warn("egress proxy cannot bind the network gateway; listening on the fallback", {
        bindHost,
        fallback,
        error: errorMessage(e),
      });
      return EgressProxy.start({ ...opts, bindHost: fallback });
    }
    throw e;
  }
}
