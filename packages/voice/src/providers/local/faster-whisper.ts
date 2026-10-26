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
import {
  describeHelperExit,
  HelperProcess,
  helperExitDetails,
  isAbnormalExit,
} from "./helper-process.ts";
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
  /** The ready line's device as resolved ("cuda", "cpu") and compute type. */
  device: z.string().nullish(),
  compute_type: z.string().nullish(),
});
type HelperMessage = z.infer<typeof HelperMessageSchema>;

const HELPER_RATE = 16000;

/**
 * Audio of one utterance kept in memory for a retry after a helper crash: two minutes of 16 kHz
 * mono PCM (3.84 MB). An utterance longer than that is not retried; its crash fails the turn.
 */
export const STT_RETRY_AUDIO_BYTES = HELPER_RATE * 2 * 120;

/**
 * How the retry of a crashed utterance decodes: greedy at temperature 0 only, no temperature
 * fallback. The same audio with the same settings crashed twice on 2026-10-26, so the retry
 * takes a different path through the decoder (the decode frame, fr_stt.py `parse_decode`).
 */
export const STT_RETRY_DECODE = { beam_size: 1, temperature: [0] } as const;

/** After a crash on the GPU, the retry's one-utterance helper runs here instead. */
export const STT_RETRY_CPU = { device: "cpu", computeType: "int8" } as const;

/** A device name that is not the CPU ("cuda", "cuda:0"); unknown or "auto" counts as the CPU. */
function isGpuDevice(device: string | null): boolean {
  return device?.startsWith("cuda") ?? false;
}

class FasterWhisperSession implements SttSession {
  readonly queue = new AsyncQueue<SttEvent>();
  readonly events: AsyncIterable<SttEvent> = this.queue;
  closed = false;
  ended = false;
  /**
   * The utterance's audio frames as sent, so a helper that dies mid-transcription can be
   * restarted and given the same audio once (`retried`); null once the utterance outgrew
   * `STT_RETRY_AUDIO_BYTES`.
   */
  frames: Buffer[] | null = [];
  private frameBytes = 0;
  retried = false;
  /** The exit and stderr tail of the crash the retry was for: in the error if the retry fails. */
  firstCrash: Record<string, unknown> | null = null;

  constructor(
    private readonly provider: FasterWhisperStt,
    signal?: AbortSignal,
  ) {
    signal?.addEventListener("abort", () => void this.close(), { once: true });
  }

  push(chunk: AudioChunk): void {
    if (this.closed || this.ended) return;
    const mono = toMono16(chunk, HELPER_RATE);
    const frame = encodeInFrame(STT_IN.audio, pcmBytes(mono));
    if (this.frames) {
      this.frameBytes += frame.length;
      if (this.frameBytes > STT_RETRY_AUDIO_BYTES) this.frames = null;
      else this.frames.push(frame);
    }
    this.provider.send(frame);
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
  /**
   * Each helper's own pending ready: settled by its ready line, its exit, its load timer (while
   * it is still the current helper) or its being let go. Never another helper's.
   */
  private readonly readyWaiters = new Map<
    HelperProcess,
    { resolve: () => void; reject: (e: unknown) => void }
  >();
  /** Stops of helpers let go outside dispose() (the retry's CPU helper); dispose() awaits them. */
  private readonly stopping = new Set<Promise<void>>();
  /** dispose() is running: a closing session starts no helper in the background. */
  private disposing = false;
  private isReady = false;
  private pending: Buffer[] = [];
  private current: FasterWhisperSession | null = null;
  private availability: Availability | null = null;
  private pythonExe: string | null = null;
  /** Set by retire(): the helper is never started again (ADR 0090, a voice profile swap). */
  private disposed = false;
  /** The device the current helper's ready line reported ("cuda", "cpu"), if it said. */
  private helperDevice: string | null = null;
  /** The next helper to start runs on the CPU (int8): the retry of an utterance after a GPU crash. */
  private nextOnCpu = false;
  /** A helper started for one retried utterance only (on the CPU); stopped when it ends. */
  private retryOnly: HelperProcess | null = null;

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
        ...(e instanceof ForerunnerError && Object.keys(e.details).length > 0
          ? { details: e.details }
          : {}),
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
    // The CPU helper of a retry after a GPU crash served that one utterance: let it go, so
    // the next utterance starts the usual (GPU) helper.
    const p = this.process;
    if (p && p === this.retryOnly) {
      this.retryOnly = null;
      this.process = null;
      this.isReady = false;
      this.ready = null;
      this.helperDevice = null;
      this.pending = [];
      this.letGo(p, "the retried utterance ended");
      // Load the usual (GPU) helper now, in the background, rather than at the next turn.
      if (!this.disposing && !this.disposed) {
        this.logger.info(
          "stopped the retry's CPU helper; starting the usual helper for the next utterance",
        );
        void this.ensureProcess().catch(() => {
          // reported to the next session by start()
        });
      }
    }
  }

  /**
   * Stop a helper the provider no longer uses: its pending ready (if it was still loading) is
   * rejected, and the stop is kept in `stopping` until the process has exited.
   */
  private letGo(p: HelperProcess, why: string): void {
    this.readyWaiters
      .get(p)
      ?.reject(new ForerunnerError("unavailable", `faster-whisper helper let go: ${why}`));
    const stop = p.stop(encodeInFrame(STT_IN.close)).finally(() => this.stopping.delete(stop));
    this.stopping.add(stop);
  }

  /**
   * Stop the helper for good (ADR 0090): a voice profile swap lets this provider go, and a
   * session still holding it must not start a helper from the old venv. dispose() alone only
   * stops the current helper; the next utterance may start a new one.
   */
  async retire(): Promise<void> {
    this.disposed = true;
    await this.dispose();
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    try {
      // An utterance still open ends here: the helper's exit, once it comes, belongs to a helper
      // already let go and only logs (a new utterance may be on a new helper by then). Ending
      // it may let go of the retry's CPU helper (sessionClosed); that stop is awaited below.
      if (this.current && !this.current.closed)
        this.current.deliver({
          type: "error",
          code: "provider_error",
          message: "faster-whisper helper stopped",
          retryable: true,
        });
      const p = this.process;
      this.process = null;
      this.isReady = false;
      this.ready = null;
      this.pending = [];
      this.helperDevice = null;
      this.nextOnCpu = false;
      this.retryOnly = null;
      if (p) this.letGo(p, "stopped");
      // Every helper this provider let go has exited when dispose() (and retire()) resolves.
      await Promise.all([...this.stopping]);
    } finally {
      this.disposing = false;
    }
  }

  private helperArgv(python: string, onCpu: boolean): string[] {
    const o = this.opts;
    const argv = [
      python,
      o.helperPath ?? DEFAULT_STT_HELPER,
      "--sample-rate",
      String(HELPER_RATE),
      "--model",
      o.model ?? "base",
      "--device",
      onCpu ? STT_RETRY_CPU.device : (o.device ?? "auto"),
      "--compute-type",
      onCpu ? STT_RETRY_CPU.computeType : (o.computeType ?? "default"),
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
    if (this.disposed)
      return Promise.reject(
        new ForerunnerError("unavailable", "faster-whisper provider was disposed (retired)"),
      );
    if (this.ready) return this.ready;
    const ready = (async () => {
      let python = this.opts.python ?? this.pythonExe;
      if (!python) {
        const probe = await probePythonModule("faster_whisper", { env: this.opts.env });
        python = probe.python;
        if (!python) throw new ForerunnerError("unavailable", probe.reason);
      }
      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const readyPromise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // One line reader per helper process: a helper that dies in the middle of a line leaves
      // its half line behind with it, never in front of the next helper's ready line.
      const lines = new LineReader();
      const onCpu = this.nextOnCpu;
      this.nextOnCpu = false;
      const proc: HelperProcess = new HelperProcess({
        argv: this.helperArgv(python, onCpu),
        env: this.opts.env,
        clock: this.clock,
        log: this.logger,
        onStdout: (d) => {
          // A helper already let go speaks for nobody.
          if (this.process === proc) this.onStdout(lines, d);
        },
        onExit: (code, signal) => this.onExit(proc, code, signal),
        onSpawnError: (err) => reject(err),
      });
      const settled = () => this.readyWaiters.delete(proc);
      this.readyWaiters.set(proc, {
        resolve: () => {
          settled();
          resolve();
        },
        reject: (e) => {
          settled();
          reject(e);
        },
      });
      this.process = proc;
      this.helperDevice = null;
      if (onCpu) this.retryOnly = proc;
      const cancel = this.clock.setTimeout(() => {
        // Only the current helper's own load times out here; one let go was settled then.
        if (this.process !== proc) return;
        this.readyWaiters
          .get(proc)
          ?.reject(new ForerunnerError("timeout", "faster-whisper helper did not become ready"));
        proc.kill();
      }, this.opts.readyTimeoutMs ?? 120_000);
      try {
        await readyPromise;
      } finally {
        cancel();
        settled();
      }
    })();
    this.ready = ready;
    // A failed load forgets itself, never a newer helper's load started meanwhile.
    ready.catch(() => {
      if (this.ready === ready) this.ready = null;
    });
    return ready;
  }

  private onStdout(lines: LineReader, data: Buffer): void {
    for (const line of lines.push(data)) {
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
        this.helperDevice = msg.device ?? null;
        if (this.process) this.readyWaiters.get(this.process)?.resolve();
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
          if (this.process)
            this.readyWaiters
              .get(this.process)
              ?.reject(new ForerunnerError("unavailable", message));
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

  /**
   * The helper died. A crash in the middle of an utterance (the real-audio run of 2026-10-26:
   * exit code 3221225477, 0xC0000005, an access violation inside faster-whisper on Windows
   * under heavy CPU load) costs nothing the human notices: the helper is restarted and the
   * utterance's audio, still in memory, is sent again once. Only a second crash, a restart that
   * fails, or an utterance too long to keep fails the session. The exit code is logged in hex
   * with a plain cause.
   */
  private onExit(proc: HelperProcess, code: number | null, signal: NodeJS.Signals | null): void {
    const exit = describeHelperExit(code, signal);
    const abnormal = isAbnormalExit(code, signal);
    // A crash's last stderr lines (faulthandler's traceback) go with every report of it.
    const stderrTail = abnormal ? proc.stderrTail() : "";
    const fields = {
      code,
      codeHex: exit.hex,
      signal,
      cause: exit.cause,
      ...(stderrTail ? { stderrTail } : {}),
    };
    const details = helperExitDetails(exit, stderrTail);
    if (this.process !== proc) {
      // A helper already let go (disposed): neither the provider's state nor the current
      // utterance (on a new helper, if any) is its own any more.
      if (abnormal) this.logger.warn("helper exited", fields);
      else this.logger.info("helper exited", fields);
      return;
    }
    const wasReady = this.isReady;
    // Where the helper that died ran: its ready line, else the configured device.
    const onGpu = isGpuDevice(this.helperDevice ?? this.opts.device ?? null);
    this.process = null;
    this.isReady = false;
    this.ready = null;
    this.pending = [];
    this.helperDevice = null;
    if (this.retryOnly === proc) this.retryOnly = null;
    if (!wasReady) {
      this.logger.warn("helper exited before it was ready", fields);
      this.readyWaiters.get(proc)?.reject(
        new ForerunnerError("unavailable", `faster-whisper helper exited, ${exit.text}`, {
          details,
        }),
      );
    }
    const session = this.current && !this.current.closed ? this.current : null;
    if (wasReady && session && !session.retried && session.frames) {
      session.retried = true;
      session.firstCrash = details;
      // The retry decodes differently (the same audio with the same settings crashed twice on
      // 2026-10-26), and after a GPU crash on a CPU helper kept for this utterance only.
      this.nextOnCpu = onGpu;
      const retryMode = onGpu
        ? `greedy at temperature 0 on the CPU (${STT_RETRY_CPU.computeType})`
        : "greedy at temperature 0";
      this.logger.warn(
        "helper crashed mid-transcription; restarting it and retrying the utterance",
        { ...fields, retryMode },
      );
      this.replay(session, exit.text);
      return;
    }
    if (wasReady) {
      if (session) this.logger.warn("helper crashed mid-transcription; the turn fails", fields);
      else if (abnormal) this.logger.warn("helper exited", fields);
      else this.logger.info("helper exited", fields);
    }
    session?.deliver({
      type: "error",
      code: "provider_error",
      message: `faster-whisper helper exited, ${exit.text}${session.retried ? " (after one retry of the utterance)" : ""}`,
      retryable: true,
      details: { ...details, ...(session.firstCrash ? { firstCrash: session.firstCrash } : {}) },
    });
  }

  /**
   * Send the utterance again to a fresh helper: reset, the retry's decode options
   * (`STT_RETRY_DECODE`), its audio, and its end if it was said.
   */
  private replay(session: FasterWhisperSession, crash: string): void {
    this.pending.push(
      encodeInFrame(STT_IN.reset),
      encodeInFrame(STT_IN.decode, Buffer.from(JSON.stringify(STT_RETRY_DECODE), "utf8")),
      ...(session.frames ?? []),
    );
    if (session.ended) this.pending.push(encodeInFrame(STT_IN.endOfSpeech));
    this.ensureProcess().catch((e: unknown) => {
      session.deliver({
        type: "error",
        code: "provider_error",
        message: `faster-whisper helper exited, ${crash}, and did not restart: ${errorMessage(e)}`,
        retryable: true,
        details: {
          ...(e instanceof ForerunnerError ? e.details : {}),
          ...(session.firstCrash ? { firstCrash: session.firstCrash } : {}),
        },
      });
    });
  }
}
