import {
  type Clock,
  currentPlatform,
  errorMessage,
  ForerunnerError,
  log,
  newId,
  type Platform,
  run as platformRun,
  which as platformWhich,
} from "@forerunner/platform";
import {
  type DetectOptions,
  detectSandboxEngine,
  type EngineDetection,
  resetSandboxEngineCache,
} from "./detect.ts";
import type { SandboxImageChoice } from "./image.ts";
import {
  SANDBOX_WHY,
  type SandboxPullEntryView,
  type SandboxPullEvent,
  type SandboxPullJobView,
  type SandboxState,
  type SandboxStatusView,
  sandboxNextStep,
  sandboxWords,
} from "./readiness-types.ts";
import type { RunFn, WhichFn } from "./types.ts";

/**
 * Whether full-review tasks can run now (U-079, ADR 0101): a container engine that answers and
 * runs Linux containers, and the runner image on this computer. One of
 * `not_installed`, `not_running`, `windows_containers`, `image_missing`, `pulling`, `ready`.
 *
 * The service keeps the last answer, re-checks when asked (Settings' Check again, and before
 * every session plans) and downloads the image with `docker pull` as a background job whose
 * progress is replayable, like the voice install (ADR 0090). A build-named image is tried at
 * the app's version first and at `latest` when the registry has no image for that version.
 */
export interface SandboxReadiness {
  state: SandboxState;
  /** The engine as the factory needs it: `engine: "none"` unless the state is `ready`. */
  detection: EngineDetection;
  /** The engine found, whatever the state ("none" when none answers). */
  engine: "docker" | "podman" | "none";
  engineVersion: string | null;
  /** The image tasks run in: the choice's image, or its fallback once the version tag was not found. */
  image: string;
  choice: SandboxImageChoice;
  /** Download size in bytes as the registry listed it; null when unknown. */
  downloadBytes: number | null;
  /** What the check saw, in the engine's words. */
  reason: string;
  checkedAt: string;
  /** Pinned by the composition's test-only option: every tier may use the process stand-in. */
  pinned: boolean;
}

export interface SandboxReadinessDeps {
  env: NodeJS.ProcessEnv;
  clock: Clock;
  image: SandboxImageChoice;
  run?: RunFn;
  which?: WhichFn;
  /** A fixed engine detection (tests); the image is still inspected through `run`. */
  detection?: EngineDetection;
  /**
   * Tests only, never from a setting a person can change: the state is pinned `ready` and the
   * port lets every risk tier use the process stand-in.
   */
  pinnedProcess?: boolean;
  platform?: Platform;
  /** CPU architecture for the download size (`process.arch`). */
  arch?: string;
}

/** `details.reason` of the error a tier 2+ lease gets while the sandbox is not ready. */
export const SANDBOX_NOT_READY = "sandbox_not_ready";

/** The refusal a full-review task meets while the sandbox is not ready: it waits, it never fails. */
export function sandboxNotReadyError(
  r: Pick<SandboxReadiness, "state" | "image" | "choice" | "reason">,
  task: { id: string; risk_tier: number },
  platform: Platform = currentPlatform(),
): ForerunnerError {
  const input = { state: r.state, platform, image: r.image, pullable: r.choice.pullable };
  const { headline } = sandboxWords(input);
  const step = sandboxNextStep(input);
  return new ForerunnerError(
    "not_supported",
    `task at risk tier ${task.risk_tier} runs in the Docker sandbox, which is not ready: ${headline} It waits; next: ${step}.`,
    {
      details: {
        reason: SANDBOX_NOT_READY,
        state: r.state,
        headline,
        step,
        riskTier: task.risk_tier,
        taskId: task.id,
        engine: r.reason,
      },
    },
  );
}

/** True for the refusal above: the task goes back to ready with its attempt count unchanged. */
export function isSandboxNotReady(e: unknown): e is ForerunnerError {
  return (
    e instanceof ForerunnerError &&
    (e.details as { reason?: unknown } | undefined)?.reason === SANDBOX_NOT_READY
  );
}

/** `docker manifest inspect --verbose` output: the compressed size of the layers for `arch`. */
export function parseManifestSize(json: string, arch: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  type Entry = {
    Descriptor?: { platform?: { os?: string; architecture?: string } };
    SchemaV2Manifest?: { layers?: { size?: number }[] };
    OCIManifest?: { layers?: { size?: number }[] };
  };
  const sum = (e: Entry): number | null => {
    const layers = e.SchemaV2Manifest?.layers ?? e.OCIManifest?.layers;
    if (!Array.isArray(layers) || layers.length === 0) return null;
    const total = layers.reduce((s, l) => s + (typeof l.size === "number" ? l.size : 0), 0);
    return total > 0 ? total : null;
  };
  if (Array.isArray(parsed)) {
    const entries = parsed as Entry[];
    const match =
      entries.find(
        (e) =>
          e.Descriptor?.platform?.os === "linux" && e.Descriptor.platform.architecture === arch,
      ) ?? entries.find((e) => e.Descriptor?.platform?.os === "linux");
    return match ? sum(match) : null;
  }
  return parsed && typeof parsed === "object" ? sum(parsed as Entry) : null;
}

/** A pull that failed because the registry has no image of that name or tag. */
export function pullSaysNotFound(text: string): boolean {
  return /manifest unknown|manifest for \S+ not found|not found: manifest|no such manifest|name unknown/i.test(
    text,
  );
}

/** A pull the registry refused for want of a login (a private package). */
export function pullSaysDenied(text: string): boolean {
  return /\bdenied\b|unauthorized|authentication required|requested access to the resource is denied/i.test(
    text,
  );
}

/** Layer progress from `docker pull` (non-TTY lines) or `podman pull` ("Copying blob"). */
export class PullProgress {
  private readonly layers = new Map<string, boolean>();

  /** Feed one output line; true when the counts changed. */
  line(text: string): boolean {
    const docker = /^([0-9a-f]{12}): (.+)$/.exec(text.trim());
    if (docker?.[1] && docker[2]) {
      const done = /^(Pull complete|Already exists)/.test(docker[2]);
      return this.set(docker[1], done);
    }
    const podman = /^Copying blob (?:sha256:)?([0-9a-f]{6,})(.*)$/.exec(text.trim());
    if (podman?.[1]) {
      const done = /done|skipped|already exists/i.test(podman[2] ?? "");
      return this.set(podman[1].slice(0, 12), done);
    }
    return false;
  }

  private set(id: string, done: boolean): boolean {
    const before = this.layers.get(id);
    if (before === true || before === done) return false;
    this.layers.set(id, done);
    return true;
  }

  get done(): number {
    return [...this.layers.values()].filter(Boolean).length;
  }

  get total(): number {
    return this.layers.size;
  }
}

interface PullJob {
  id: string;
  image: string;
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  entries: SandboxPullEntryView[];
  progress: PullProgress;
  abort: AbortController;
  done: Promise<void>;
}

const RECENT = 40;
const PROBE_TIMEOUT_MS = 20_000;
const PULL_TIMEOUT_MS = 2 * 60 * 60_000;

function dockerArch(arch: string): string {
  return arch === "x64" ? "amd64" : arch === "ia32" ? "386" : arch;
}

export class SandboxReadinessService {
  private last: SandboxReadiness | null = null;
  private checking: Promise<SandboxReadiness> | null = null;
  private job: PullJob | null = null;
  /** Images a pull said the registry does not have (this process): the fallback is used. */
  private readonly unpublished = new Set<string>();
  private readonly sizes = new Map<string, number | null>();
  private readonly listeners = new Set<
    (next: SandboxReadiness, prev: SandboxReadiness | null) => void
  >();
  private readonly pullListeners = new Set<(e: SandboxPullEntryView | null) => void>();
  private readonly logger = log("sandbox:readiness");

  constructor(private readonly deps: SandboxReadinessDeps) {}

  get platform(): Platform {
    return this.deps.platform ?? currentPlatform();
  }

  /** The last answer without probing; null before the first check. */
  current(): SandboxReadiness | null {
    return this.last;
  }

  /** The last answer, or a first check. */
  async ensureChecked(): Promise<SandboxReadiness> {
    return this.last ?? (await this.check());
  }

  /**
   * Probe now. `force` drops the engine detection's cache (Check again, before a session plans,
   * after a download). Concurrent calls share one probe.
   */
  async check(opts: { force?: boolean } = {}): Promise<SandboxReadiness> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try {
        // The first check of this service never trusts a cached detection (another
        // composition in the same process may have cached its own engine).
        const next = await this.probe(opts.force === true || this.last === null);
        this.publish(next);
        return next;
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  /** Called with every answer whose state or image differs from the one before. */
  onChange(listener: (next: SandboxReadiness, prev: SandboxReadiness | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(next: SandboxReadiness): void {
    const prev = this.last;
    this.last = next;
    if (prev && prev.state === next.state && prev.image === next.image) return;
    this.logger.info("sandbox readiness", {
      state: next.state,
      image: next.image,
      engine: next.engine,
      reason: next.reason,
    });
    for (const l of [...this.listeners]) {
      try {
        l(next, prev);
      } catch (e) {
        this.logger.warn("readiness listener failed", { error: errorMessage(e) });
      }
    }
  }

  private run(): RunFn {
    return this.deps.run ?? platformRun;
  }

  private async probe(force: boolean): Promise<SandboxReadiness> {
    const { clock, image: choice } = this.deps;
    const checkedAt = clock.nowIso();
    const base = {
      choice,
      image: this.imageInUse(),
      downloadBytes: null,
      checkedAt,
      pinned: false,
    };
    if (this.deps.pinnedProcess) {
      return {
        ...base,
        state: "ready",
        detection: {
          engine: "none",
          reason: "pinned for tests: every task runs in the process stand-in",
          checkedAt,
        },
        engine: "none",
        engineVersion: null,
        reason: "pinned for tests: every task runs in the process stand-in",
        pinned: true,
      };
    }
    let detection = this.deps.detection;
    if (!detection) {
      if (force) resetSandboxEngineCache();
      const opts: DetectOptions = { env: this.deps.env, clock };
      opts.run = this.run();
      opts.which = this.deps.which ?? platformWhich;
      detection = await detectSandboxEngine(opts);
    }
    if (detection.engine === "none") {
      return {
        ...base,
        state: detection.problem ?? "not_installed",
        detection,
        engine: "none",
        engineVersion: null,
        reason: detection.reason,
      };
    }
    const engine = detection.engine;
    const found = { engine, engineVersion: detection.version ?? null };
    const image = this.imageInUse();
    if (await this.present(engine, image)) {
      return { ...base, ...found, image, state: "ready", detection, reason: detection.reason };
    }
    const notReady: EngineDetection = {
      ...detection,
      engine: "none",
      reason: `${detection.reason}; image ${image} is not on this computer`,
    };
    if (this.job?.state === "running") {
      return {
        ...base,
        ...found,
        image,
        state: "pulling",
        detection: notReady,
        reason: notReady.reason,
      };
    }
    return {
      ...base,
      ...found,
      image,
      state: "image_missing",
      detection: notReady,
      reason: notReady.reason,
      // The size is a registry call: only what is cached here; `withSize()` asks the registry.
      downloadBytes: choice.pullable ? (this.sizes.get(image) ?? null) : null,
    };
  }

  /**
   * The last answer with the download size of a missing image, asked from the registry once
   * per image (`docker manifest inspect`): for the Settings card and the notice, never on the
   * daemon's start or before a plan, where a slow registry would hold them up.
   */
  async withSize(): Promise<SandboxReadiness> {
    const r = await this.ensureChecked();
    if (r.state !== "image_missing" || !r.choice.pullable || r.engine === "none") return r;
    if (r.downloadBytes !== null) return r;
    const downloadBytes = await this.downloadSize(r.engine, r.image);
    const next = { ...r, downloadBytes };
    if (this.last === r) this.last = next;
    return next;
  }

  /** The version tag, or the fallback once a pull said the registry has no such tag. */
  private imageInUse(): string {
    const c = this.deps.image;
    return c.fallback && this.unpublished.has(c.image) ? c.fallback : c.image;
  }

  private async present(engine: "docker" | "podman", image: string): Promise<boolean> {
    try {
      const r = await this.run()([engine, "image", "inspect", "--format", "{{.Id}}", image], {
        allowFailure: true,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      return r.code === 0 && !r.timedOut;
    } catch {
      return false;
    }
  }

  private async downloadSize(engine: "docker" | "podman", image: string): Promise<number | null> {
    if (engine !== "docker") return null;
    if (this.sizes.has(image)) return this.sizes.get(image) ?? null;
    let size: number | null = null;
    try {
      const r = await this.run()(["docker", "manifest", "inspect", "--verbose", image], {
        allowFailure: true,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (r.code === 0)
        size = parseManifestSize(r.stdout, dockerArch(this.deps.arch ?? process.arch));
    } catch {
      size = null;
    }
    this.sizes.set(image, size);
    return size;
  }

  // ------------------------------------------------------------------------------------------
  // The download
  // ------------------------------------------------------------------------------------------

  get pulling(): boolean {
    return this.job?.state === "running";
  }

  /** The running download's promise (tests and close() wait on it). */
  get settled(): Promise<void> {
    return this.job?.done ?? Promise.resolve();
  }

  pullJob(): SandboxPullJobView | null {
    const j = this.job;
    if (!j) return null;
    return {
      id: j.id,
      image: j.image,
      state: j.state,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      layersDone: j.progress.done,
      layersTotal: j.progress.total,
      recent: j.entries.slice(-RECENT),
    };
  }

  /**
   * Start the download (idempotent: a running one is returned). Refused (`claim_conflict`) while
   * no engine runs Linux containers, and for a local image, which is built, never pulled.
   */
  async startPull(): Promise<SandboxPullJobView> {
    if (this.job?.state === "running") return this.pullJob() as SandboxPullJobView;
    const r = await this.ensureChecked();
    if (r.state === "ready") {
      throw new ForerunnerError("claim_conflict", `the sandbox is ready already (${r.image})`);
    }
    if (r.engine === "none" || this.deps.pinnedProcess) {
      const words = sandboxWords({
        state: r.state,
        platform: this.platform,
        image: r.image,
        pullable: r.choice.pullable,
      });
      throw new ForerunnerError(
        "claim_conflict",
        `the sandbox cannot be downloaded yet: ${words.headline} ${words.steps.join(" ")}`,
      );
    }
    if (!r.choice.pullable) {
      throw new ForerunnerError(
        "claim_conflict",
        `${r.image} is a local image: it is built, not downloaded (${sandboxWords({ state: "image_missing", platform: this.platform, image: r.image, pullable: false }).steps[0]})`,
      );
    }
    const engine = r.engine;
    const job: PullJob = {
      id: newId(this.deps.clock.now()),
      image: r.image,
      state: "running",
      startedAt: this.deps.clock.nowIso(),
      finishedAt: null,
      entries: [],
      progress: new PullProgress(),
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.job = job;
    const out = (event: SandboxPullEvent) => {
      const entry = { seq: job.entries.length + 1, event };
      job.entries.push(entry);
      for (const l of [...this.pullListeners]) l(entry);
    };
    this.publish({ ...r, state: "pulling" });
    job.done = (async () => {
      const result = await this.pullWithFallback(engine, job, out);
      job.state = result.ok ? "done" : "failed";
      job.image = result.image;
      job.finishedAt = this.deps.clock.nowIso();
      out({ type: "result", ok: result.ok, image: result.image, message: result.message });
    })()
      .catch((e: unknown) => {
        job.state = "failed";
        job.finishedAt = this.deps.clock.nowIso();
        out({ type: "error", message: errorMessage(e) });
      })
      .finally(async () => {
        for (const l of [...this.pullListeners]) l(null);
        await this.check({ force: true }).catch(() => undefined);
      });
    return this.pullJob() as SandboxPullJobView;
  }

  private async pullWithFallback(
    engine: "docker" | "podman",
    job: PullJob,
    out: (e: SandboxPullEvent) => void,
  ): Promise<{ ok: boolean; image: string; message: string }> {
    const choice = this.deps.image;
    const first = await this.pullOne(engine, job.image, job, out);
    if (first.ok)
      return { ok: true, image: job.image, message: `the sandbox ${job.image} is downloaded` };
    const fallback = choice.fallback && job.image === choice.image ? choice.fallback : null;
    if (fallback && pullSaysNotFound(first.error)) {
      // A development build: the registry has no image for this version yet.
      this.unpublished.add(choice.image);
      out({
        type: "step",
        message: `the registry has no ${job.image}; downloading ${fallback} instead`,
      });
      job.image = fallback;
      job.progress = new PullProgress();
      const second = await this.pullOne(engine, fallback, job, out);
      if (second.ok)
        return { ok: true, image: fallback, message: `the sandbox ${fallback} is downloaded` };
      return { ok: false, image: fallback, message: this.failureWords(fallback, second.error) };
    }
    if (fallback && !pullSaysDenied(first.error) && (await this.present(engine, fallback))) {
      // Offline, or the registry does not answer: the fallback already here stands in.
      this.unpublished.add(choice.image);
      out({
        type: "warning",
        message: `${job.image} could not be downloaded (${first.error.split("\n")[0]}); the ${fallback} already on this computer is used`,
      });
      return { ok: true, image: fallback, message: `the sandbox ${fallback} is used` };
    }
    return { ok: false, image: job.image, message: this.failureWords(job.image, first.error) };
  }

  private failureWords(image: string, error: string): string {
    const first = error.trim().split("\n").at(-1) ?? error;
    if (pullSaysDenied(error))
      return `the registry refused the download of ${image} (${first}): the package must be public, or sign in with docker login`;
    if (pullSaysNotFound(error)) return `the registry has no ${image} (${first})`;
    return `the download of ${image} failed (${first}); check the internet connection and Download again`;
  }

  private async pullOne(
    engine: "docker" | "podman",
    image: string,
    job: PullJob,
    out: (e: SandboxPullEvent) => void,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    out({ type: "step", message: `downloading ${image}` });
    let pending = "";
    const onLine = (line: string) => {
      const text = line.trim();
      if (!text) return;
      if (job.progress.line(text)) {
        out({ type: "layers", done: job.progress.done, total: job.progress.total });
      } else if (!/^[0-9a-f]{12}: /.test(text)) {
        out({ type: "log", message: text.slice(0, 300) });
      }
    };
    const onChunk = (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const l of lines) onLine(l);
    };
    try {
      const r = await this.run()([engine, "pull", image], {
        allowFailure: true,
        timeoutMs: PULL_TIMEOUT_MS,
        onStdout: onChunk,
        signal: job.abort.signal,
      });
      if (pending) onLine(pending);
      if (r.code === 0 && !r.timedOut) return { ok: true };
      const error = (
        r.stderr.trim() ||
        r.stdout.trim().split("\n").at(-1) ||
        `exit ${r.code}`
      ).slice(-1000);
      if (job.abort.signal.aborted) return { ok: false, error: "cancelled" };
      out({ type: "error", message: error.split("\n").at(-1) ?? error });
      return { ok: false, error: r.timedOut ? `timed out; ${error}` : error };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  eventsAfter(seq: number): SandboxPullEntryView[] {
    return (this.job?.entries ?? []).filter((e) => e.seq > seq);
  }

  subscribe(listener: (e: SandboxPullEntryView | null) => void): () => void {
    this.pullListeners.add(listener);
    return () => this.pullListeners.delete(listener);
  }

  /** A timer on the daemon's clock (the stream's heartbeat); returns its cancel. */
  timer(ms: number, fn: () => void): () => void {
    return this.deps.clock.setTimeout(fn, ms);
  }

  /** Stops a running download (the daemon's stop); what was downloaded stays with the engine. */
  async close(): Promise<void> {
    const job = this.job;
    if (job?.state !== "running") return;
    job.abort.abort();
    await job.done;
  }

  /** `GET /sandbox`: the last answer in the person's words. */
  view(r: SandboxReadiness, waiting: number): SandboxStatusView {
    const words = sandboxWords({
      state: r.state,
      platform: this.platform,
      image: r.image,
      pullable: r.choice.pullable,
      engine: r.engine,
      engineVersion: r.engineVersion,
      downloadBytes: r.downloadBytes,
    });
    return {
      state: r.state,
      ready: r.state === "ready",
      engine: r.pinned ? "none" : r.engine,
      engineVersion: r.engineVersion,
      platform: this.platform,
      image: r.image,
      imageSource: r.choice.source,
      pullable: r.choice.pullable,
      downloadBytes: r.downloadBytes,
      reason: r.reason,
      headline: r.pinned
        ? "Ready (pinned for tests): every task runs in the process stand-in."
        : words.headline,
      steps: words.steps,
      why: SANDBOX_WHY,
      waiting,
      checkedAt: r.checkedAt,
      pull: this.pullJob(),
    };
  }
}
