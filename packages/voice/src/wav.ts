/**
 * PCM helpers: WAV encode/decode, resampling, downmix, and signal generators for tests.
 * Everything is 16-bit signed little-endian; nothing here touches a device.
 */
import { ForerunnerError } from "@forerunner/platform";
import { type AudioChunk, toInt16 } from "./types.ts";

export interface DecodedWav {
  pcm: Int16Array;
  sampleRate: number;
  channels: number;
}

/** Encode PCM samples as a 16-bit PCM WAV file. */
export function encodeWav(pcm: Int16Array | Buffer, sampleRate: number, channels = 1): Buffer {
  const samples = toInt16(pcm);
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16); // fmt chunk size
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  out.writeUInt16LE(channels * 2, 32); // block align
  out.writeUInt16LE(16, 34); // bits per sample
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i] ?? 0, 44 + i * 2);
  return out;
}

/** Decode a 16-bit PCM WAV file. Throws ForerunnerError("validation") on anything else. */
export function decodeWav(file: Buffer): DecodedWav {
  if (file.length < 12 || file.toString("ascii", 0, 4) !== "RIFF") {
    throw new ForerunnerError("validation", "not a RIFF file");
  }
  if (file.toString("ascii", 8, 12) !== "WAVE") {
    throw new ForerunnerError("validation", "not a WAVE file");
  }
  let pos = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  let data: Buffer | null = null;
  while (pos + 8 <= file.length) {
    const id = file.toString("ascii", pos, pos + 4);
    const size = file.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      format = file.readUInt16LE(body);
      channels = file.readUInt16LE(body + 2);
      sampleRate = file.readUInt32LE(body + 4);
      bits = file.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = file.subarray(body, Math.min(file.length, body + size));
      break;
    }
    pos = body + size + (size % 2);
  }
  if (format !== 1 || bits !== 16) {
    throw new ForerunnerError("validation", "only 16-bit PCM WAV is supported", {
      details: { format, bits },
    });
  }
  if (!data || sampleRate === 0 || channels === 0) {
    throw new ForerunnerError("validation", "WAV file has no fmt or data chunk");
  }
  const pcm = new Int16Array(data.length >> 1);
  for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2);
  return { pcm, sampleRate, channels };
}

/** A sine tone. amplitude is 0..1 of full scale. */
export function synth(toneHz: number, ms: number, sampleRate = 16000, amplitude = 0.5): Int16Array {
  const n = Math.round((ms / 1000) * sampleRate);
  const out = new Int16Array(n);
  const scale = Math.max(0, Math.min(1, amplitude)) * 32767;
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * toneHz * i) / sampleRate) * scale);
  }
  return out;
}

/** Digital silence. */
export function silence(ms: number, sampleRate = 16000): Int16Array {
  return new Int16Array(Math.round((ms / 1000) * sampleRate));
}

/** Deterministic low-level noise (a tiny LCG), for "quiet room" fixtures. */
export function noise(ms: number, sampleRate = 16000, amplitude = 0.005, seed = 1): Int16Array {
  const n = Math.round((ms / 1000) * sampleRate);
  const out = new Int16Array(n);
  let s = seed >>> 0;
  const scale = amplitude * 32767;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = Math.round(((s / 0xffffffff) * 2 - 1) * scale);
  }
  return out;
}

export function concatPcm(...parts: Int16Array[]): Int16Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Split PCM into fixed-size chunks with running timestamps, the way a capture device delivers it. */
export function chunkify(
  pcm: Int16Array,
  frameMs: number,
  sampleRate = 16000,
  startMs = 0,
  channels = 1,
): AudioChunk[] {
  const frame = Math.max(1, Math.round((frameMs / 1000) * sampleRate)) * channels;
  const out: AudioChunk[] = [];
  for (let i = 0; i < pcm.length; i += frame) {
    const slice = pcm.subarray(i, Math.min(pcm.length, i + frame));
    out.push({
      pcm: slice,
      sampleRate,
      channels,
      timestampMs: startMs + ((i / channels) * 1000) / sampleRate,
    });
  }
  return out;
}

/** Average interleaved channels down to mono. */
export function downmix(pcm: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / channels);
  const out = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[f * channels + c] ?? 0;
    out[f] = Math.round(sum / channels);
  }
  return out;
}

/** Linear-interpolation resampler for mono PCM. Good enough for speech to 16 kHz. */
export function resample(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || pcm.length === 0) return pcm;
  const ratio = fromRate / toRate;
  const n = Math.max(1, Math.round(pcm.length / ratio));
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(pcm.length - 1, i0 + 1);
    const frac = pos - i0;
    const a = pcm[i0] ?? 0;
    const b = pcm[i1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/** Normalise any chunk to mono PCM at `rate`. */
export function toMono16(chunk: AudioChunk, rate = 16000): Int16Array {
  const mono = downmix(toInt16(chunk.pcm), chunk.channels);
  return resample(mono, chunk.sampleRate, rate);
}

/** Int16Array -> little-endian bytes (a view when possible). */
export function pcmBytes(pcm: Int16Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/** Little-endian bytes -> Int16Array copy (safe for odd offsets). */
export function bytesToPcm(bytes: Uint8Array): Int16Array {
  const even = bytes.byteLength - (bytes.byteLength % 2);
  const out = new Int16Array(even / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, even);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}
