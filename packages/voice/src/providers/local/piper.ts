/**
 * Local TTS through the `piper` binary: one process per sentence, `--output-raw` streams
 * 16-bit PCM to stdout as it is produced. Piper starts in well under a second, so the loop's
 * sentence prefetch hides the start-up time.
 */
import { access, readFile } from "node:fs/promises";
import {
  ForerunnerError,
  isAbsolute,
  killTree,
  type Logger,
  log,
  sep,
  spawnProcess,
  which,
} from "@forerunner/platform";
import { AsyncQueue } from "../../queue.ts";
import type { AudioChunk, Availability, TtsOptions, TtsProvider } from "../../types.ts";
import { bytesToPcm } from "../../wav.ts";

export interface PiperOptions {
  /** Binary name on PATH or a full path. Default "piper". */
  binary?: string;
  /** Arguments inserted before --model, for launchers and wrappers (tests use a node script). */
  argvPrefix?: string[];
  /** Path to the .onnx voice model. Its sibling `<model>.json` gives the sample rate. */
  modelPath: string;
  /** Used when the model config cannot be read. Default 22050. */
  sampleRate?: number;
  speaker?: string | number;
  env?: NodeJS.ProcessEnv;
  /** Split stdout into chunks of about this many ms. Default 100. */
  chunkMs?: number;
}

export class PiperTts implements TtsProvider {
  readonly name = "piper";
  readonly kind = "local" as const;
  private readonly logger: Logger;
  private availability: Availability | null = null;
  private sampleRate: number;
  private configRead = false;

  constructor(private readonly opts: PiperOptions) {
    this.logger = log("voice:piper");
    this.sampleRate = opts.sampleRate ?? 22050;
  }

  async isAvailable(): Promise<Availability> {
    if (this.availability) return this.availability;
    const binary = this.opts.binary ?? "piper";
    try {
      const looksLikePath = isAbsolute(binary) || binary.includes(sep) || binary.includes("/");
      if (looksLikePath) {
        await access(binary);
      } else {
        const found = await which(binary);
        if (!found) {
          this.availability = { ok: false, reason: `${binary} not found on PATH` };
          return this.availability;
        }
      }
      await access(this.opts.modelPath);
      await this.readConfig();
      this.availability = { ok: true, reason: `${binary} and model present` };
    } catch (e) {
      this.availability = {
        ok: false,
        reason: `piper unavailable: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return this.availability;
  }

  refresh(): void {
    this.availability = null;
  }

  private async readConfig(): Promise<void> {
    if (this.configRead) return;
    this.configRead = true;
    try {
      const text = await readFile(`${this.opts.modelPath}.json`, "utf8");
      const cfg = JSON.parse(text) as { audio?: { sample_rate?: number } };
      if (cfg.audio?.sample_rate) this.sampleRate = cfg.audio.sample_rate;
    } catch {
      // keep the configured default
    }
  }

  async *synthesize(text: string, opts: TtsOptions = {}): AsyncIterable<AudioChunk> {
    await this.readConfig();
    if (opts.signal?.aborted) return;
    const argv = [
      this.opts.binary ?? "piper",
      ...(this.opts.argvPrefix ?? []),
      "--model",
      this.opts.modelPath,
      "--output-raw",
      "--length_scale",
      (1 / Math.max(0.25, Math.min(4, opts.speed ?? 1))).toFixed(3),
    ];
    if (this.opts.speaker !== undefined) argv.push("--speaker", String(this.opts.speaker));

    const queue = new AsyncQueue<AudioChunk>();
    const rate = this.sampleRate;
    const chunkBytes = Math.max(2, Math.round(((this.opts.chunkMs ?? 100) / 1000) * rate) * 2);
    let carry: Buffer = Buffer.alloc(0);
    let samples = 0;
    const flush = (buf: Buffer) => {
      const pcm = bytesToPcm(buf);
      if (pcm.length === 0) return;
      queue.push({ pcm, sampleRate: rate, channels: 1, timestampMs: (samples / rate) * 1000 });
      samples += pcm.length;
    };

    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(argv, { env: this.opts.env });
    } catch (e) {
      throw new ForerunnerError("unavailable", `piper failed to start: ${String(e)}`, { cause: e });
    }
    const onAbort = () => {
      killTree(child);
      queue.close();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.stdout?.on("data", (d: Buffer) => {
      let buf = carry.length ? Buffer.concat([carry, d]) : d;
      while (buf.length >= chunkBytes) {
        flush(buf.subarray(0, chunkBytes));
        buf = buf.subarray(chunkBytes);
      }
      carry = Buffer.from(buf);
    });
    child.on("error", (err) => {
      queue.fail(
        new ForerunnerError("unavailable", `piper failed to start: ${err.message}`, { cause: err }),
      );
    });
    child.on("close", (code) => {
      if (carry.length >= 2) flush(carry);
      if (code !== 0 && !opts.signal?.aborted) {
        this.logger.warn("piper exited with error", { code, stderr: stderr.slice(-500) });
        queue.fail(
          new ForerunnerError("provider_error", `piper exited with code ${code}`, {
            details: { stderr: stderr.slice(-500) },
            retryable: true,
          }),
        );
      } else {
        queue.close();
      }
    });
    child.stdin?.on("error", () => {
      // EPIPE when piper died early; reported by the close handler.
    });
    child.stdin?.end(`${text.replace(/\r?\n/g, " ")}\n`);

    try {
      for await (const c of queue) yield c;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) killTree(child);
    }
  }
}
