/**
 * Cartesia streaming TTS over WebSocket (wss://api.cartesia.ai/tts/websocket).
 * One connection per sentence keeps the implementation simple; the loop's prefetch hides the
 * handshake. Audio arrives as base64 pcm_s16le chunks in JSON messages.
 */
import { type Clock, ForerunnerError, type Logger, log, systemClock } from "@forerunner/platform";
import { AsyncQueue } from "../../queue.ts";
import type { AudioChunk, Availability, TtsOptions, TtsProvider } from "../../types.ts";
import { bytesToPcm } from "../../wav.ts";
import { type SecretResolver, type WsFactory, wsFactory } from "./transport.ts";

export interface CartesiaOptions {
  apiKeyRef: string;
  resolveSecret: SecretResolver;
  ws?: WsFactory;
  clock?: Clock;
  /** Default voice id (required by Cartesia; overridable per call). */
  voice?: string;
  model?: string;
  sampleRate?: number;
  language?: string;
  baseUrl?: string;
  apiVersion?: string;
  /** Put the key in the URL query (what browser clients must do). Default false: header only. */
  keyInQuery?: boolean;
}

interface CartesiaMessage {
  type?: string;
  data?: string;
  done?: boolean;
  error?: string;
  context_id?: string;
}

export class CartesiaTts implements TtsProvider {
  readonly name = "cartesia";
  readonly kind = "cloud" as const;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly ws: WsFactory;
  private contextCounter = 0;

  constructor(private readonly opts: CartesiaOptions) {
    this.clock = opts.clock ?? systemClock;
    this.logger = log("voice:cartesia");
    this.ws = opts.ws ?? wsFactory();
  }

  async isAvailable(): Promise<Availability> {
    try {
      const key = await this.opts.resolveSecret(this.opts.apiKeyRef);
      if (!key) return { ok: false, reason: `no API key configured for ${this.opts.apiKeyRef}` };
      if (!this.opts.voice) return { ok: false, reason: "no Cartesia voice id configured" };
      return {
        ok: true,
        reason: `key ${this.opts.apiKeyRef} configured (live connection not probed)`,
      };
    } catch (e) {
      return { ok: false, reason: `could not read ${this.opts.apiKeyRef}: ${String(e)}` };
    }
  }

  socketUrl(key: string): string {
    const u = new URL(this.opts.baseUrl ?? "wss://api.cartesia.ai/tts/websocket");
    u.searchParams.set("cartesia_version", this.opts.apiVersion ?? "2025-04-16");
    if (this.opts.keyInQuery) u.searchParams.set("api_key", key);
    return u.toString();
  }

  requestBody(text: string, opts: TtsOptions, contextId: string): Record<string, unknown> {
    const voice = opts.voice ?? this.opts.voice;
    if (!voice) throw new ForerunnerError("validation", "cartesia: a voice id is required");
    const sampleRate = opts.sampleRate ?? this.opts.sampleRate ?? 24000;
    return {
      model_id: this.opts.model ?? "sonic-2",
      transcript: text,
      voice: { mode: "id", id: voice },
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: sampleRate },
      language: opts.language ?? this.opts.language ?? "en",
      speed: opts.speed === undefined ? undefined : speedLabel(opts.speed),
      context_id: contextId,
      continue: false,
    };
  }

  async *synthesize(text: string, opts: TtsOptions = {}): AsyncIterable<AudioChunk> {
    if (opts.signal?.aborted) return;
    const key = await this.opts.resolveSecret(this.opts.apiKeyRef);
    if (!key) {
      throw new ForerunnerError(
        "provider_auth",
        `no API key configured for ${this.opts.apiKeyRef}`,
      );
    }
    const contextId = `fr-${this.clock.now().toString(36)}-${++this.contextCounter}`;
    const body = this.requestBody(text, opts, contextId);
    const sampleRate = (body.output_format as { sample_rate: number }).sample_rate;
    const queue = new AsyncQueue<AudioChunk>();
    let samples = 0;
    let finished = false;

    const sock = this.ws(this.socketUrl(key), {
      headers: { "X-API-Key": key, "Cartesia-Version": this.opts.apiVersion ?? "2025-04-16" },
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      queue.close();
      sock.close(1000, "done");
    };
    const onAbort = () => finish();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    sock.onOpen(() => sock.send(JSON.stringify(body)));
    sock.onMessage((data) => {
      if (typeof data !== "string") return;
      let msg: CartesiaMessage;
      try {
        msg = JSON.parse(data) as CartesiaMessage;
      } catch {
        return;
      }
      if (msg.context_id && msg.context_id !== contextId) return;
      if (msg.type === "chunk" && msg.data) {
        const pcm = bytesToPcm(Buffer.from(msg.data, "base64"));
        queue.push({ pcm, sampleRate, channels: 1, timestampMs: (samples / sampleRate) * 1000 });
        samples += pcm.length;
        if (msg.done) finish();
      } else if (msg.type === "done" || msg.done) {
        finish();
      } else if (msg.type === "error") {
        if (!finished) {
          finished = true;
          queue.fail(
            new ForerunnerError("provider_error", `cartesia: ${msg.error ?? "error"}`, {
              retryable: true,
            }),
          );
          sock.close(1000, "error");
        }
      }
    });
    sock.onError((err) => {
      if (finished) return;
      finished = true;
      this.logger.warn("socket error", { message: err.message });
      queue.fail(
        new ForerunnerError("provider_error", `cartesia socket: ${err.message}`, {
          retryable: true,
        }),
      );
    });
    sock.onClose(() => finish());

    try {
      for await (const c of queue) yield c;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      finish();
    }
  }
}

/** Cartesia takes a speed label; map a numeric factor onto it. */
function speedLabel(speed: number): "slowest" | "slow" | "normal" | "fast" | "fastest" {
  if (speed <= 0.6) return "slowest";
  if (speed < 0.95) return "slow";
  if (speed <= 1.05) return "normal";
  if (speed < 1.5) return "fast";
  return "fastest";
}
