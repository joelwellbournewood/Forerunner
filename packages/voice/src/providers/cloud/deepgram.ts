/**
 * Deepgram streaming STT over WebSocket (wss://api.deepgram.com/v1/listen).
 * The API key is resolved from a secret reference right before connecting, sent only in the
 * Authorization header, and never logged. The WebSocket factory is injected so tests replay
 * captured-shaped messages without the network.
 */
import { type Clock, type Logger, log, systemClock } from "@forerunner/platform";
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
import { type SecretResolver, type WsFactory, type WsSocket, wsFactory } from "./transport.ts";

export interface DeepgramOptions {
  /** Secret reference name, e.g. "secret:deepgram_api_key". */
  apiKeyRef: string;
  resolveSecret: SecretResolver;
  ws?: WsFactory;
  clock?: Clock;
  model?: string;
  /** Base URL; override for a proxy. Default wss://api.deepgram.com/v1/listen */
  baseUrl?: string;
  /** Deepgram's own end-pointing silence, ms. Default 200. */
  endpointingMs?: number;
  /** Give up waiting for the finalised transcript after this long. Default 1500 ms. */
  finalizeTimeoutMs?: number;
  /** Rate the audio is sent at (chunks are converted). Default 16000. */
  sampleRate?: number;
}

interface DeepgramResult {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
  description?: string;
  message?: string;
  detected_language?: string;
}

class DeepgramSession implements SttSession {
  readonly queue = new AsyncQueue<SttEvent>();
  readonly events: AsyncIterable<SttEvent> = this.queue;
  private socket: WsSocket | null = null;
  private open = false;
  private closed = false;
  private ended = false;
  private finalSent = false;
  private readonly buffered: Uint8Array[] = [];
  private readonly finals: string[] = [];
  private lastPartial = "";
  private confidence: number | undefined;
  private language: string | undefined;
  private speechStart: number | undefined;
  private speechEnd: number | undefined;
  private cancelFinalizeTimer: (() => void) | null = null;

  constructor(
    private readonly provider: DeepgramStt,
    private readonly opts: SttStartOptions,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    opts.signal?.addEventListener("abort", () => void this.close(), { once: true });
    void this.connect();
  }

  private async connect(): Promise<void> {
    let key: string | undefined;
    try {
      key = await this.provider.resolveKey();
    } catch (e) {
      this.fail("provider_auth", `could not resolve ${this.provider.keyRef}: ${String(e)}`, false);
      return;
    }
    if (!key) {
      this.fail("provider_auth", `no API key configured for ${this.provider.keyRef}`, false);
      return;
    }
    if (this.closed) return;
    const url = this.provider.listenUrl(this.opts.language);
    this.logger.debug("connecting", { url });
    const sock = this.provider.wsConnect(url, { headers: { Authorization: `Token ${key}` } });
    this.socket = sock;
    sock.onOpen(() => {
      this.open = true;
      for (const b of this.buffered.splice(0)) sock.send(b);
      if (this.ended) this.sendFinalize();
    });
    sock.onMessage((data) => this.onMessage(data));
    sock.onError((err) => {
      this.fail("provider_error", `deepgram socket error: ${err.message}`, true);
    });
    sock.onClose((code, reason) => {
      this.logger.debug("socket closed", { code, reason });
      if (!this.finalSent && (this.finals.length > 0 || this.lastPartial)) {
        this.emitFinal();
      } else if (!this.finalSent && this.ended) {
        this.emitFinal();
      }
      void this.close();
    });
  }

  private onMessage(data: string | Uint8Array): void {
    if (typeof data !== "string") return;
    let msg: DeepgramResult;
    try {
      msg = JSON.parse(data) as DeepgramResult;
    } catch {
      return;
    }
    switch (msg.type) {
      case "Results": {
        const alt = msg.channel?.alternatives?.[0];
        const text = (alt?.transcript ?? "").trim();
        if (msg.detected_language) this.language = msg.detected_language;
        if (msg.is_final) {
          if (text) {
            this.finals.push(text);
            if (alt?.confidence !== undefined) this.confidence = alt.confidence;
            if (msg.start !== undefined) {
              this.speechStart ??= msg.start * 1000;
              this.speechEnd = (msg.start + (msg.duration ?? 0)) * 1000;
            }
          }
          this.lastPartial = "";
          if (this.ended && (msg.from_finalize || msg.speech_final)) this.emitFinal();
        } else if (text) {
          this.lastPartial = text;
          const sofar = [...this.finals, text].join(" ");
          this.queue.push({ type: "partial", text: sofar, atMs: this.clock.monotonic() });
        }
        break;
      }
      case "UtteranceEnd":
        if (this.ended) this.emitFinal();
        break;
      case "Error":
        this.fail("provider_error", msg.description ?? msg.message ?? "deepgram error", true);
        break;
      default:
        break; // Metadata, SpeechStarted, ...
    }
  }

  push(chunk: AudioChunk): void {
    if (this.closed || this.ended) return;
    const bytes = pcmBytes(toMono16(chunk, this.provider.sampleRate));
    if (this.open && this.socket) this.socket.send(bytes);
    else this.buffered.push(bytes);
  }

  endOfSpeech(): void {
    if (this.closed || this.ended) return;
    this.ended = true;
    if (this.open) this.sendFinalize();
    this.cancelFinalizeTimer = this.clock.setTimeout(() => {
      if (!this.finalSent) this.emitFinal();
    }, this.provider.finalizeTimeoutMs);
  }

  private sendFinalize(): void {
    this.socket?.send(JSON.stringify({ type: "Finalize" }));
  }

  private emitFinal(): void {
    if (this.finalSent) return;
    this.finalSent = true;
    this.cancelFinalizeTimer?.();
    const text = [...this.finals, this.lastPartial].filter((t) => t).join(" ");
    this.queue.push({
      type: "final",
      text,
      atMs: this.clock.monotonic(),
      startMs: this.speechStart,
      endMs: this.speechEnd,
      language: this.language,
      confidence: this.confidence,
    });
    this.queue.close();
    void this.close();
  }

  private fail(code: string, message: string, retryable: boolean): void {
    if (this.finalSent) return;
    this.finalSent = true;
    this.cancelFinalizeTimer?.();
    this.queue.push({ type: "error", code, message, retryable });
    this.queue.close();
    void this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelFinalizeTimer?.();
    if (this.socket) {
      if (this.open) {
        try {
          this.socket.send(JSON.stringify({ type: "CloseStream" }));
        } catch {
          // socket already gone
        }
      }
      this.socket.close(1000, "done");
    }
    this.queue.close();
  }
}

export class DeepgramStt implements SttProvider {
  readonly name = "deepgram";
  readonly kind = "cloud" as const;
  readonly keyRef: string;
  readonly sampleRate: number;
  readonly finalizeTimeoutMs: number;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly ws: WsFactory;

  constructor(private readonly opts: DeepgramOptions) {
    this.keyRef = opts.apiKeyRef;
    this.clock = opts.clock ?? systemClock;
    this.logger = log("voice:deepgram");
    this.ws = opts.ws ?? wsFactory();
    this.sampleRate = opts.sampleRate ?? 16000;
    this.finalizeTimeoutMs = opts.finalizeTimeoutMs ?? 1500;
  }

  async isAvailable(): Promise<Availability> {
    try {
      const key = await this.opts.resolveSecret(this.keyRef);
      return key
        ? { ok: true, reason: `key ${this.keyRef} configured (live connection not probed)` }
        : { ok: false, reason: `no API key configured for ${this.keyRef}` };
    } catch (e) {
      return { ok: false, reason: `could not read ${this.keyRef}: ${String(e)}` };
    }
  }

  resolveKey(): Promise<string | undefined> {
    return this.opts.resolveSecret(this.keyRef);
  }

  wsConnect(url: string, opts: { headers: Record<string, string> }): WsSocket {
    return this.ws(url, opts);
  }

  listenUrl(language?: string): string {
    const u = new URL(this.opts.baseUrl ?? "wss://api.deepgram.com/v1/listen");
    u.searchParams.set("model", this.opts.model ?? "nova-3");
    u.searchParams.set("encoding", "linear16");
    u.searchParams.set("sample_rate", String(this.sampleRate));
    u.searchParams.set("channels", "1");
    u.searchParams.set("interim_results", "true");
    u.searchParams.set("smart_format", "true");
    u.searchParams.set("endpointing", String(this.opts.endpointingMs ?? 200));
    u.searchParams.set("utterance_end_ms", "1000");
    if (language) u.searchParams.set("language", language);
    return u.toString();
  }

  start(opts: SttStartOptions): SttSession {
    return new DeepgramSession(this, opts, this.clock, this.logger);
  }
}
