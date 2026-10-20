/**
 * Local STT through the bundled Python helper (packages/voice/python/fr_stt.py) running
 * faster-whisper. One helper process per provider instance, started lazily and reused across
 * sessions; a session is one utterance (reset -> audio... -> end of speech -> final).
 */
import { fileURLToPath } from "node:url";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  type Logger,
  log,
  systemClock,
} from "@forerunner/platform";
import { z } from "zod";
import { AsyncQueue } from "../../queue.ts";
import type {
  AudioChunk,
  Availability,
  SttEvent,
  SttProvider,
  SttSession,
  SttStartOptions,
} from "../../types.ts";
import { pcmBytes, toMono16 } from "../../wav.ts";
import { encodeInFrame, LineReader, STT_IN } from "./framing.ts";
import { HelperProcess } from "./helper-process.ts";
import { probePythonModule } from "./python.ts";

export const DEFAULT_STT_HELPER = fileURLToPath(
  new URL("../../../python/fr_stt.py", import.meta.url),
);

export interface FasterWhisperOptions {
  clock?: Clock;
  /** Interpreter path or command; default: FORERUNNER_PYTHON, then python3/python (python/py on Windows). */
  python?: string;
  /** Helper script; default: the bundled fr_stt.py. */
  helperPath?: string;
  /** faster-whisper model name or path. Default "base". */
  model?: string;
  device?: string;
  computeType?: string;
  language?: string;
  beamSize?: number;
  partialIntervalMs?: number;
  /** Extra argv appended to the helper command (tests pass --selftest). */
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Model load (and first-time download) can be slow. Default 120 s. */
  readyTimeoutMs?: number;
}

/**
 * One JSON line from fr_stt.py (see its docstring). Unknown keys are ignored and `null` stands
 * for absent, so a helper from a newer or older package version still parses; a line that does
 * not fit (a non-string `text`, a missing `type`) is logged and dropped rather than delivered.
 */
export const HelperMessageSchema = z.object({
  type: z.string(),
  text: z.string().nullish(),
  message: z.string().nullish(),
  start_ms: z.number().nullish(),
  end_ms: z.number().nullish(),
  language: z.string().nullish(),
  model: z.string().nullish(),
});
type HelperMessage = z.infer<typeof HelperMessageSchema>;

const HELPER_RATE = 16000;

class FasterWhisperSession implements SttSession {
  readonly queue = new AsyncQueue<SttEvent>();
  readonly events: AsyncIterable<SttEvent> = this.queue;
  closed = false;
  ended = false;

  constructor(
    private readonly provider: FasterWhisperStt,
    signal?: AbortSignal,
  ) {
    signal?.addEventListener("abort", () => void this.close(), { once: true });
  }

  push(chunk: AudioChunk): void {
    if (this.closed || this.ended) return;
    const mono = toMono16(chunk, HELPER_RATE);
    this.provider.send(encodeInFrame(STT_IN.audio, pcmBytes(mono)));
  }

  endOfSpeech(): void {
    if (this.closed || this.ended) return;
    this.ended = true;
    this.provider.send(encodeInFrame(STT_IN.endOfSpeech));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
    this.provider.sessionClosed(this);
  }

  deliver(ev: SttEvent): void {
    if (this.closed) return;
    this.queue.push(ev);
    if (ev.type === "final" || ev.type === "error") {
      this.closed = true;
      this.queue.close();
      this.provider.sessionClosed(this);
    }
  }
}

export class FasterWhisperStt implements SttProvider {
  readonly name = "faster-whisper";
  readonly kind = "local" as const;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private process: HelperProcess | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: unknown) => void) | null = null;
  private isReady = false;
  private pending: Buffer[] = [];
  private current: FasterWhisperSession | null = null;
  private availability: Availability | null = null;
  private pythonExe: string | null = null;
  private readonly lines = new LineReader();

  constructor(private readonly opts: FasterWhisperOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.logger = log("voice:faster-whisper");
  }

  async isAvailable(): Promise<Availability> {
    if (this.availability) return this.availability;
    const probe = await probePythonModule("faster_whisper", {
      python: this.opts.python,
      env: this.opts.env,
    });
    this.pythonExe = probe.python;
    this.availability = { ok: probe.ok, reason: probe.reason };
    return this.availability;
  }

  /** Forget the cached probe (after the user installs the package). */
  refresh(): void {
    this.availability = null;
  }

  start(opts: SttStartOptions): SttSession {
    if (this.current) void this.current.close();
    const session = new FasterWhisperSession(this, opts.signal);
    this.current = session;
    // The reset precedes any audio; it is queued until the helper reports ready.
    this.send(encodeInFrame(STT_IN.reset));
    this.ensureProcess().catch((e: unknown) => {
      session.deliver({
        type: "error",
        code: "unavailable",
        message: `faster-whisper helper failed to start: ${errorMessage(e)}`,
        retryable: false,
      });
    });
    return session;
  }

  /** Queue a frame until the helper is ready, then write directly. */
  send(frame: Buffer): void {
    if (this.isReady && this.process?.alive) {
      this.process.write(frame);
      return;
    }
    this.pending.push(frame);
    void this.ensureProcess().catch(() => {
      // reported to the session by start()
    });
  }

  sessionClosed(s: FasterWhisperSession): void {
    if (this.current === s) this.current = null;
  }

  async dispose(): Promise<void> {
    const p = this.process;
    this.process = null;
    this.isReady = false;
    this.ready = null;
    this.pending = [];
    if (p) await p.stop(encodeInFrame(STT_IN.close));
  }

  private helperArgv(python: string): string[] {
    const o = this.opts;
    const argv = [
      python,
      o.helperPath ?? DEFAULT_STT_HELPER,
      "--sample-rate",
      String(HELPER_RATE),
      "--model",
      o.model ?? "base",
      "--device",
      o.device ?? "auto",
      "--compute-type",
      o.computeType ?? "default",
      "--beam-size",
      String(o.beamSize ?? 5),
      "--partial-interval-ms",
      String(o.partialIntervalMs ?? 1000),
    ];
    if (o.language) argv.push("--language", o.language);
    if (o.extraArgs) argv.push(...o.extraArgs);
    return argv;
  }

  private ensureProcess(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      let python = this.opts.python ?? this.pythonExe;
      if (!python) {
        const probe = await probePythonModule("faster_whisper", { env: this.opts.env });
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
        this.readyReject?.(
          new ForerunnerError("timeout", "faster-whisper helper did not become ready"),
        );
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
    for (const line of this.lines.push(data)) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        this.logger.warn("unparseable helper line", { line: line.slice(0, 200) });
        continue;
      }
      const parsed = HelperMessageSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn("malformed helper message", { line: line.slice(0, 200) });
        continue;
      }
      this.onMessage(parsed.data);
    }
  }

  private onMessage(msg: HelperMessage): void {
    switch (msg.type) {
      case "ready": {
        this.isReady = true;
        this.readyResolve?.();
        const frames = this.pending.splice(0);
        for (const f of frames) this.process?.write(f);
        break;
      }
      case "partial":
        this.current?.deliver({
          type: "partial",
          text: msg.text ?? "",
          atMs: this.clock.monotonic(),
        });
        break;
      case "final":
        this.current?.deliver({
          type: "final",
          text: msg.text ?? "",
          atMs: this.clock.monotonic(),
          startMs: msg.start_ms ?? undefined,
          endMs: msg.end_ms ?? undefined,
          language: msg.language ?? undefined,
        });
        break;
      case "error": {
        const message = msg.message ?? "helper error";
        if (!this.isReady) {
          this.readyReject?.(new ForerunnerError("unavailable", message));
        } else {
          this.current?.deliver({
            type: "error",
            code: "provider_error",
            message,
            retryable: true,
          });
        }
        break;
      }
      default:
        this.logger.debug("ignored helper message", { type: msg.type });
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.logger.info("helper exited", { code, signal });
    const wasReady = this.isReady;
    this.process = null;
    this.isReady = false;
    this.ready = null;
    this.pending = [];
    if (!wasReady) {
      this.readyReject?.(
        new ForerunnerError("unavailable", `faster-whisper helper exited with code ${code}`),
      );
    }
    this.current?.deliver({
      type: "error",
      code: "provider_error",
      message: `faster-whisper helper exited (code ${code}, signal ${signal})`,
      retryable: true,
    });
  }
}
