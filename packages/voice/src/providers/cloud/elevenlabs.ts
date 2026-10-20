/**
 * ElevenLabs streaming TTS over HTTP (POST /v1/text-to-speech/{voice}/stream with a PCM
 * output format). The response body is raw 16-bit PCM streamed as it is generated.
 */
import { ForerunnerError, type Logger, log } from "@forerunner/platform";
import type { AudioChunk, Availability, TtsOptions, TtsProvider } from "../../types.ts";
import { bytesToPcm } from "../../wav.ts";
import { fetchStream, type HttpStreamFn, readBodyText, type SecretResolver } from "./transport.ts";

export interface ElevenLabsOptions {
  apiKeyRef: string;
  resolveSecret: SecretResolver;
  http?: HttpStreamFn;
  /** Default voice id (required by ElevenLabs; overridable per call). */
  voice?: string;
  model?: string;
  /** One of 16000, 22050, 24000, 44100. Default 24000. */
  sampleRate?: number;
  baseUrl?: string;
  /** Minimum bytes per emitted chunk (keeps chunks around 20 ms or more). Default 1600. */
  minChunkBytes?: number;
}

const PCM_RATES = new Set([16000, 22050, 24000, 44100]);

export class ElevenLabsTts implements TtsProvider {
  readonly name = "elevenlabs";
  readonly kind = "cloud" as const;
  private readonly logger: Logger;
  private readonly http: HttpStreamFn;

  constructor(private readonly opts: ElevenLabsOptions) {
    this.logger = log("voice:elevenlabs");
    this.http = opts.http ?? fetchStream();
  }

  async isAvailable(): Promise<Availability> {
    try {
      const key = await this.opts.resolveSecret(this.opts.apiKeyRef);
      if (!key) return { ok: false, reason: `no API key configured for ${this.opts.apiKeyRef}` };
      if (!this.opts.voice) return { ok: false, reason: "no ElevenLabs voice id configured" };
      return {
        ok: true,
        reason: `key ${this.opts.apiKeyRef} configured (live connection not probed)`,
      };
    } catch (e) {
      return { ok: false, reason: `could not read ${this.opts.apiKeyRef}: ${String(e)}` };
    }
  }

  streamUrl(voice: string, sampleRate: number): string {
    const base = this.opts.baseUrl ?? "https://api.elevenlabs.io";
    const u = new URL(`/v1/text-to-speech/${encodeURIComponent(voice)}/stream`, base);
    u.searchParams.set("output_format", `pcm_${sampleRate}`);
    return u.toString();
  }

  async *synthesize(text: string, opts: TtsOptions = {}): AsyncIterable<AudioChunk> {
    if (opts.signal?.aborted) return;
    const voice = opts.voice ?? this.opts.voice;
    if (!voice) throw new ForerunnerError("validation", "elevenlabs: a voice id is required");
    const sampleRate = opts.sampleRate ?? this.opts.sampleRate ?? 24000;
    if (!PCM_RATES.has(sampleRate)) {
      throw new ForerunnerError("validation", `elevenlabs: unsupported pcm rate ${sampleRate}`);
    }
    const key = await this.opts.resolveSecret(this.opts.apiKeyRef);
    if (!key) {
      throw new ForerunnerError(
        "provider_auth",
        `no API key configured for ${this.opts.apiKeyRef}`,
      );
    }
    const body: Record<string, unknown> = {
      text,
      model_id: this.opts.model ?? "eleven_flash_v2_5",
    };
    if (opts.language) body.language_code = opts.language;
    if (opts.speed !== undefined) body.voice_settings = { speed: opts.speed };

    const res = await this.http(this.streamUrl(voice, sampleRate), {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "content-type": "application/json",
        accept: "application/octet-stream",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      const detail = await readBodyText(res.body);
      this.logger.warn("request failed", { status: res.status });
      throw new ForerunnerError(
        res.status === 401 || res.status === 403 ? "provider_auth" : "provider_error",
        `elevenlabs: HTTP ${res.status}`,
        {
          details: { status: res.status, body: detail.slice(0, 300) },
          retryable: res.status >= 500,
        },
      );
    }

    const minBytes = this.opts.minChunkBytes ?? 1600;
    let carry: Buffer = Buffer.alloc(0);
    let samples = 0;
    const toChunk = (buf: Buffer): AudioChunk => {
      const pcm = bytesToPcm(buf);
      const chunk: AudioChunk = {
        pcm,
        sampleRate,
        channels: 1,
        timestampMs: (samples / sampleRate) * 1000,
      };
      samples += pcm.length;
      return chunk;
    };
    for await (const piece of res.body) {
      if (opts.signal?.aborted) return;
      carry = carry.length ? Buffer.concat([carry, Buffer.from(piece)]) : Buffer.from(piece);
      if (carry.length < minBytes) continue;
      const even = carry.length - (carry.length % 2);
      yield toChunk(carry.subarray(0, even));
      carry = Buffer.from(carry.subarray(even));
    }
    if (carry.length >= 2 && !opts.signal?.aborted) yield toChunk(carry);
  }
}
