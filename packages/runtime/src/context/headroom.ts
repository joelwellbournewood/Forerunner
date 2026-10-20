import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  join,
  killTree,
  spawnProcess,
  systemClock,
  which as whichOnPath,
} from "@forerunner/platform";
import type { ModelProvider } from "../provider/types.ts";
import type { CompressionMode } from "./pipeline.ts";

/**
 * Headroom proxy adapter (ADR 0003 section 1). Headroom is an optional external process that
 * Forerunner never depends on: this module only detects it (`GET /health`), reads its savings
 * counter (`GET /stats`) and tells the drivers how to route calls through it. The native
 * pipeline (pipeline.ts) always runs; the proxy is an accelerator used when the project asks
 * for it and the probe passed. Nothing here is assumed: absent, dead or unhealthy all degrade to
 * native with a visible notice.
 */
export const DEFAULT_HEADROOM_PORT = 8787;
export const HEADROOM_PROJECT_HEADER = "X-Headroom-Project";
export const HEADROOM_PROBE_TIMEOUT_MS = 500;

export type HeadroomStatus = "healthy" | "unhealthy" | "not_running" | "not_installed" | "disabled";

export interface HeadroomProbe {
  status: HeadroomStatus;
  /** True only for "healthy": /health answered `{ status: "healthy", ready: true }`. */
  available: boolean;
  url: string;
  detail?: string;
}

/** The port the runtime talks to; HeadroomAdapter is the real one, tests use fakes. */
export interface HeadroomPort {
  readonly url: string;
  probe(): Promise<HeadroomProbe>;
  /** The proxy's lifetime tokens_saved for a project (0 when it has none); null when unreachable. */
  tokensSaved(projectId: string): Promise<number | null>;
}

export function isLoopbackUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * `FORERUNNER_HEADROOM_URL` when set, else `http://127.0.0.1:<FORERUNNER_HEADROOM_PORT ?? 8787>`
 * (Headroom's own default). Loopback only: the proxy sees the API credential, so anything else
 * is a `validation` error. Never a port scan.
 */
export function resolveHeadroomUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.FORERUNNER_HEADROOM_URL?.trim();
  let url: string;
  if (explicit) {
    url = explicit;
  } else {
    const raw = env.FORERUNNER_HEADROOM_PORT?.trim();
    const port = raw ? Number(raw) : DEFAULT_HEADROOM_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ForerunnerError("validation", "FORERUNNER_HEADROOM_PORT must be a port number", {
        details: { port: raw },
      });
    }
    url = `http://127.0.0.1:${port}`;
  }
  if (!/^https?:\/\//i.test(url) || !isLoopbackUrl(url)) {
    throw new ForerunnerError(
      "validation",
      "FORERUNNER_HEADROOM_URL must be a loopback http(s) URL: the proxy sees the API credential",
      { details: { url } },
    );
  }
  return url.replace(/\/+$/, "");
}

/**
 * Argv for a Forerunner-managed proxy (ADR 0003 section 1): loopback bind, cache mode so the
 * provider prefix cache keeps hitting, no CCR and lossless so no tool is injected and no hidden
 * upstream call escapes our hooks, no response cache so every call reaches the model.
 */
export function managedHeadroomArgv(port: number): string[] {
  return [
    "headroom",
    "proxy",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--mode",
    "cache",
    "--no-ccr",
    "--lossless",
    "--no-cache",
  ];
}

/** Request headers that attribute traffic to a project on the proxy side. */
export function headroomHeaders(projectId: string): Record<string, string> {
  return { [HEADROOM_PROJECT_HEADER]: projectId };
}

/** Environment for an SDK subprocess whose calls should go through the proxy. */
export function headroomSdkEnv(url: string, projectId: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_CUSTOM_HEADERS: `${HEADROOM_PROJECT_HEADER}: ${projectId}`,
  };
}

/** A provider that can send the same credential through a local proxy (the Anthropic adapter). */
export interface ProxyableProvider extends ModelProvider {
  viaProxy(baseURL: string, headers: Record<string, string>): ModelProvider;
}

export function isProxyable(p: ModelProvider): p is ProxyableProvider {
  return typeof (p as Partial<ProxyableProvider>).viaProxy === "function";
}

export interface HeadroomAdapterOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  clock?: Clock;
  /** Locates the `headroom` executable; tells "not installed" from "not running". */
  which?: (cmd: string) => Promise<string | null>;
  timeoutMs?: number;
}

type ProbeResponse =
  | { kind: "ok"; body: unknown }
  | { kind: "error"; detail: string }
  | { kind: "unreachable"; detail: string };

export class HeadroomAdapter implements HeadroomPort {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly which: (cmd: string) => Promise<string | null>;
  private readonly timeoutMs: number;

  constructor(opts: HeadroomAdapterOptions = {}) {
    this.url = resolveHeadroomUrl(opts.env ?? process.env);
    const f = opts.fetch;
    this.fetchImpl = f ? (input, init) => f(input, init) : (input, init) => fetch(input, init);
    this.clock = opts.clock ?? systemClock;
    this.which = opts.which ?? whichOnPath;
    this.timeoutMs = opts.timeoutMs ?? HEADROOM_PROBE_TIMEOUT_MS;
  }

  async probe(): Promise<HeadroomProbe> {
    const res = await this.get("/health");
    if (res.kind === "unreachable") {
      let installed: string | null = null;
      try {
        installed = await this.which("headroom");
      } catch {
        installed = null;
      }
      return {
        status: installed ? "not_running" : "not_installed",
        available: false,
        url: this.url,
        detail: res.detail,
      };
    }
    if (res.kind === "error") {
      return { status: "unhealthy", available: false, url: this.url, detail: res.detail };
    }
    const body = res.body as { status?: unknown; ready?: unknown } | null;
    if (body && typeof body === "object" && body.status === "healthy" && body.ready === true) {
      return { status: "healthy", available: true, url: this.url };
    }
    return {
      status: "unhealthy",
      available: false,
      url: this.url,
      detail: `health: ${JSON.stringify(body ?? null).slice(0, 200)}`,
    };
  }

  async tokensSaved(projectId: string): Promise<number | null> {
    const res = await this.get("/stats");
    if (res.kind !== "ok") return null;
    const projects = (
      res.body as { projects?: Record<string, { tokens_saved?: unknown } | undefined> } | null
    )?.projects;
    const n = projects?.[projectId]?.tokens_saved;
    return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }

  private async get(path: string): Promise<ProbeResponse> {
    const controller = new AbortController();
    const cancel = this.clock.setTimeout(
      () => controller.abort(new ForerunnerError("timeout", "headroom probe timed out")),
      this.timeoutMs,
    );
    try {
      const r = await this.fetchImpl(`${this.url}${path}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      const text = await r.text();
      if (!r.ok) return { kind: "error", detail: `HTTP ${r.status}` };
      try {
        return { kind: "ok", body: JSON.parse(text) as unknown };
      } catch {
        return { kind: "error", detail: "non-JSON body" };
      }
    } catch (e) {
      // A listening proxy that does not answer in time is unhealthy, not absent.
      if (controller.signal.aborted)
        return { kind: "error", detail: `no answer within ${this.timeoutMs} ms` };
      return { kind: "unreachable", detail: errorMessage(e) };
    } finally {
      cancel();
    }
  }
}

/** The port when no proxy is configured or its URL was rejected: always "disabled", never silent. */
export class NoHeadroom implements HeadroomPort {
  readonly url = "";
  constructor(private readonly reason = "not configured") {}
  async probe(): Promise<HeadroomProbe> {
    return { status: "disabled", available: false, url: "", detail: this.reason };
  }
  async tokensSaved(): Promise<number | null> {
    return null;
  }
}

/** The adapter from `FORERUNNER_HEADROOM_*`; a rejected URL yields NoHeadroom with the reason. */
export function headroomFromEnv(
  env: NodeJS.ProcessEnv,
  opts: Omit<HeadroomAdapterOptions, "env"> = {},
): { port: HeadroomPort; error: ForerunnerError | null } {
  try {
    return { port: new HeadroomAdapter({ ...opts, env }), error: null };
  } catch (e) {
    const error =
      e instanceof ForerunnerError ? e : new ForerunnerError("validation", errorMessage(e));
    return { port: new NoHeadroom(error.message), error };
  }
}

export interface CompressionSelection {
  /** What the project asked for (settings.context.compression). */
  policy: CompressionMode;
  /** What is in effect: "headroom" only when the probe passed. */
  mode: CompressionMode;
  headroomUsed: boolean;
  headroom: HeadroomProbe | null;
  /** Set whenever the policy asked for Headroom and it is not in use. Shown and logged. */
  notice: string | null;
}

export function headroomNotice(probe: HeadroomProbe): string {
  switch (probe.status) {
    case "not_installed":
      return "Headroom: not installed; using native compression";
    case "not_running":
      return "Headroom: not running; using native compression";
    case "unhealthy":
      return `Headroom: not ready${probe.detail ? ` (${probe.detail})` : ""}; using native compression`;
    case "disabled":
      return `Headroom: ${probe.detail ?? "disabled"}; using native compression`;
    case "healthy":
      return "Headroom: in use";
  }
}

/**
 * Policy to effective mode. "headroom" means native plus the proxy when the probe passes and
 * falls back to native with a notice; it is never silently off. "native" and "off" never probe.
 */
export async function selectCompression(
  policy: CompressionMode,
  headroom: HeadroomPort,
): Promise<CompressionSelection> {
  if (policy !== "headroom") {
    return { policy, mode: policy, headroomUsed: false, headroom: null, notice: null };
  }
  let probe: HeadroomProbe;
  try {
    probe = await headroom.probe();
  } catch (e) {
    probe = { status: "unhealthy", available: false, url: headroom.url, detail: errorMessage(e) };
  }
  if (probe.available) {
    return { policy, mode: "headroom", headroomUsed: true, headroom: probe, notice: null };
  }
  return {
    policy,
    mode: "native",
    headroomUsed: false,
    headroom: probe,
    notice: headroomNotice(probe),
  };
}

/** The slice of a child process the managed runner needs, so tests can inject a stub. */
export interface ManagedChild {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  once(event: "exit", listener: (code: number | null) => void): unknown;
}

export interface ManagedHeadroomOptions {
  port: number;
  /** Directory for headroom.log (appDirs().logs). */
  logDir: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (argv: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => ManagedChild;
  kill?: (child: ManagedChild) => void;
}

/** The slice of the kill switch the managed proxy listens to (enforcement/killswitch.ts). */
export interface StopSource {
  onStop(fn: (report: { scope: unknown }) => void): () => void;
}

/**
 * Forerunner-managed proxy (`FORERUNNER_HEADROOM_MANAGED=1`): spawns `headroom proxy` with the
 * argv above, logs to <logs>/headroom.log, stops it on app exit and on the kill switch
 * (`bindKillSwitch`: a global stop kills the proxy tree; a scoped stop of one agent or session
 * leaves the shared proxy alone). The adapter still probes; a managed start that fails is just
 * "not running".
 */
export class ManagedHeadroomProcess {
  private child: ManagedChild | null = null;
  private log: WriteStream | null = null;
  private readonly argv: string[];
  private unbind: (() => void) | null = null;

  constructor(private readonly opts: ManagedHeadroomOptions) {
    this.argv = managedHeadroomArgv(opts.port);
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Stops the proxy on a global kill-switch stop. Returns the unbind function. */
  bindKillSwitch(kill: StopSource): () => void {
    this.unbind?.();
    const off = kill.onStop((report) => {
      if (report.scope === "all") this.stop();
    });
    this.unbind = () => {
      off();
      this.unbind = null;
    };
    return this.unbind;
  }

  start(): boolean {
    if (this.child) return true;
    const env = { ...(this.opts.env ?? process.env) };
    // Telemetry stays at Headroom's off default; never pass --log-messages.
    delete env.HEADROOM_TELEMETRY;
    try {
      const child = (this.opts.spawn ?? spawnProcess)(this.argv, { env });
      try {
        mkdirSync(this.opts.logDir, { recursive: true });
        const out = createWriteStream(join(this.opts.logDir, "headroom.log"), { flags: "a" });
        out.on("error", () => undefined); // logging is best effort
        child.stdout?.pipe(out, { end: false });
        child.stderr?.pipe(out, { end: false });
        this.log = out;
      } catch {
        this.log = null;
      }
      child.once("exit", () => {
        if (this.child === child) this.forget();
      });
      this.child = child;
      return true;
    } catch {
      this.child = null;
      return false;
    }
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.forget();
    if (this.opts.kill) this.opts.kill(child);
    else killTree(child as Parameters<typeof killTree>[0]);
  }

  private forget(): void {
    this.child = null;
    this.log?.end();
    this.log = null;
  }
}
