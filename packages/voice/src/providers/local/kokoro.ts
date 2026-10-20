/**
 * Local TTS through the bundled Python helper (packages/voice/python/fr_tts.py) running
 * Kokoro. One long-lived helper per provider instance; sentences are queued with ids so the
 * loop can synthesise sentence i+1 while sentence i plays, and cancelled on barge-in.
 */
import { fileURLToPath } from "node:url";
import { type Clock, ForerunnerError, type Logger, log, systemClock } from "@forerunner/platform";
import { AsyncQueue } from "../../queue.ts";
import type { AudioChunk, Availability, TtsOptions, TtsProvider } from "../../types.ts";
import { bytesToPcm } from "../../wav.ts";
import { encodeInFrame, FrameReader, TTS_IN, TTS_OUT } from "./framing.ts";
import { HelperProcess } from "./helper-process.ts";
import { probePythonModule } from "./python.ts";

export const DEFAULT_TTS_HELPER = fileURLToPath(
  new URL("../../../python/fr_tts.py", import.meta.url),
);

export interface KokoroOptions {
  clock?: Clock;
  python?: string;
  helperPath?: string;
  /** Kokoro language code: a (American English), b (British), e, f, h, i, j, p, z. Default "a". */
  lang?: string;
  /** Default voice, e.g. af_heart. */
  voice?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
}

interface Request {
  queue: AsyncQueue<AudioChunk>;
  samples: number;
}

export class KokoroTts implements TtsProvider {
  readonly name = "kokoro";
  readonly kind = "local" as const;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private process: HelperProcess | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: unknown) => void) | null = null;
  private isReady = false;
  private sampleRate = 24000;
  private nextId = 1;
  private readonly requests = new Map<number, Request>();
  private availability: Availability | null = null;
  private pythonExe: string | null = null;
  private readonly frames = new FrameReader();

  constructor(private readonly opts: KokoroOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.logger = log("voice:kokoro");
  }

  async isAvailable(): Promise<Availability> {
    if (this.availability) return this.availability;
    const probe = await probePythonModule("kokoro", {
      python: this.opts.python,
      env: this.opts.env,
    });
    this.pythonExe = probe.python;
    this.availability = { ok: probe.ok, reason: probe.reason };
    return this.availability;
  }

  refresh(): void {
    this.availability = null;
  }

  get outputSampleRate(): number {
    return this.sampleRate;
  }

  /** Requests the helper is still working on (diagnostics and tests). */
  get pendingRequests(): number {
    return this.requests.size;
  }

  async *synthesize(text: string, opts: TtsOptions = {}): AsyncIterable<AudioChunk> {
    await this.ensureProcess();
    // A sentence already cancelled (barge-in while it was queued) must not leave a request behind.
    if (opts.signal?.aborted) return;
    const id = this.nextId++;
    const req: Request = { queue: new AsyncQueue<AudioChunk>(), samples: 0 };
    this.requests.set(id, req);
    const onAbort = () => {
      this.process?.write(
        encodeInFrame(TTS_IN.cancel, Buffer.from(JSON.stringify({ id }), "utf8")),
      );
      req.queue.close();
      this.requests.delete(id);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const payload = Buffer.from(
      JSON.stringify({
        id,
        text,
        voice: opts.voice ?? this.opts.voice,
        speed: opts.speed ?? 1,
        lang: opts.language ?? this.opts.lang,
      }),
      "utf8",
    );
    try {
      if (!this.process?.write(encodeInFrame(TTS_IN.request, payload))) {
        throw new ForerunnerError("unavailable", "kokoro helper is not running");
      }
      for await (const chunk of req.queue) yield chunk;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      this.requests.delete(id);
    }
  }

  async dispose(): Promise<void> {
    const p = this.process;
    this.process = null;
    this.isReady = false;
    this.ready = null;
    for (const r of this.requests.values()) r.queue.close();
    this.requests.clear();
    if (p) await p.stop(encodeInFrame(TTS_IN.close));
  }

  private helperArgv(python: string): string[] {
    const argv = [
      python,
      this.opts.helperPath ?? DEFAULT_TTS_HELPER,
      "--lang",
      this.opts.lang ?? "a",
    ];
    if (this.opts.voice) argv.push("--voice", this.opts.voice);
    if (this.opts.extraArgs) argv.push(...this.opts.extraArgs);
    return argv;
  }

  private ensureProcess(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      let python = this.opts.python ?? this.pythonExe;
      if (!python) {
        const probe = await probePythonModule("kokoro", { env: this.opts.env });
        python = probe.python;
        if (!python) throw new ForerunnerError("unavailable", probe.reason);
      }
      const readyPromise = new Promise<void>((res, rej) => {
        this.readyResolve = res;
        this.readyReject = rej;
      });
      const proc = new HelperProcess({
        argv: this.helperArgv(python),
        env: this.opts.env,
        clock: this.clock,
        log: this.logger,
        onStdout: (d) => this.onStdout(d),
        onExit: (code, signal) => this.onExit(code, signal),
        onSpawnError: (err) => this.readyReject?.(err),
      });
      this.process = proc;
      const cancel = this.clock.setTimeout(() => {
        this.readyReject?.(new ForerunnerError("timeout", "kokoro helper did not become ready"));
        proc.kill();
      }, this.opts.readyTimeoutMs ?? 120_000);
      try {
        await readyPromise;
      } finally {
        cancel();
      }
    })();
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  private onStdout(data: Buffer): void {
    for (const frame of this.frames.push(data)) {
      switch (frame.kind) {
        case TTS_OUT.ready: {
          try {
            const info = JSON.parse(frame.payload.toString("utf8")) as { sample_rate?: number };
            if (info.sample_rate) this.sampleRate = info.sample_rate;
          } catch {
            // keep the default rate
          }
          this.isReady = true;
          this.readyResolve?.();
          break;
        }
        case TTS_OUT.audio: {
          const req = this.requests.get(frame.id);
          if (!req) break;
          const pcm = bytesToPcm(frame.payload);
          req.queue.push({
            pcm,
            sampleRate: this.sampleRate,
            channels: 1,
            timestampMs: (req.samples / this.sampleRate) * 1000,
          });
          req.samples += pcm.length;
          break;
        }
        case TTS_OUT.done:
          this.requests.get(frame.id)?.queue.close();
          break;
        case TTS_OUT.error: {
          const message = frame.payload.toString("utf8");
          if (!this.isReady) this.readyReject?.(new ForerunnerError("unavailable", message));
          const req = this.requests.get(frame.id);
          req?.queue.fail(
            new ForerunnerError("provider_error", `kokoro: ${message}`, { retryable: true }),
          );
          break;
        }
        default:
          this.logger.debug("ignored helper frame", { kind: frame.kind });
      }
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.logger.info("helper exited", { code, signal });
    const wasReady = this.isReady;
    this.process = null;
    this.isReady = false;
    this.ready = null;
    const err = new ForerunnerError(
      "provider_error",
      `kokoro helper exited (code ${code}, signal ${signal})`,
      { retryable: true },
    );
    if (!wasReady) this.readyReject?.(err);
    for (const r of this.requests.values()) r.queue.fail(err);
    this.requests.clear();
  }
}
