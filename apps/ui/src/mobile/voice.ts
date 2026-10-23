import { toBase64 } from "../api/state-signing.ts";

/**
 * Push-to-talk on the phone (spec R.5, O; ADR 0080). The phone runs no voice loop: a turn is
 * recorded here, sent to the PC as one remote command (`kind: "voice"`), and the PC's voice
 * loop (the one behind its `/voice` routes) transcribes it, answers and speaks; the reply text
 * comes back in the command's result and the phone speaks it with its own speech synthesis.
 *
 * Two ports, both optional in `MobileEnv`:
 * - `VoiceRecorder`: captures one turn as 16 kHz mono 16-bit PCM, the format the PC's
 *   `/voice/sessions/:id/audio` takes. The web implementation uses `getUserMedia` and an
 *   `AudioContext` (MediaRecorder gives compressed audio the PC's loop does not read). The
 *   Android shell offers no microphone command yet, so in the shell the recorder is absent
 *   and the typed line is relayed instead (follow-up: a shell capture command).
 * - `Speaker`: speaks the PC's reply (`speechSynthesis` where the WebView has it).
 */
export const RELAY_SAMPLE_RATE = 16_000;
/** The longest recorded turn the relay carries (the PC's `VOICE_RELAY_MAX_MS`). */
export const VOICE_RELAY_MAX_MS = 5_000;

export interface RecordedTurn {
  /** Mono 16-bit PCM at `sampleRate`. */
  pcm: Int16Array;
  sampleRate: number;
  durationMs: number;
}

export interface VoiceRecorder {
  readonly kind: "web-audio" | "shell" | "fake";
  /** Opens the microphone and starts capturing; rejects when the microphone is refused. */
  start(): Promise<void>;
  /** Stops capturing and returns the turn. */
  stop(): Promise<RecordedTurn>;
  /** Drops the capture without a turn. */
  cancel(): void;
}

export interface Speaker {
  speak(text: string): void;
  stop(): void;
}

/** The envelope's `audio` field: the turn capped at `VOICE_RELAY_MAX_MS`, base64 PCM. */
export function encodeTurn(turn: RecordedTurn): {
  pcm: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
} {
  const maxSamples = Math.floor((turn.sampleRate * VOICE_RELAY_MAX_MS) / 1000);
  const pcm = turn.pcm.length > maxSamples ? turn.pcm.subarray(0, maxSamples) : turn.pcm;
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i] ?? 0, true);
  return {
    pcm: toBase64(bytes),
    sampleRate: turn.sampleRate,
    channels: 1,
    durationMs: Math.round((pcm.length / turn.sampleRate) * 1000),
  };
}

/** Float samples at `fromRate` to 16-bit PCM at `RELAY_SAMPLE_RATE` (linear interpolation). */
export function toRelayPcm(samples: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / RELAY_SAMPLE_RATE;
  const length = Math.floor(samples.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const at = i * ratio;
    const lo = Math.floor(at);
    const hi = Math.min(samples.length - 1, lo + 1);
    const frac = at - lo;
    const v = (samples[lo] ?? 0) * (1 - frac) + (samples[hi] ?? 0) * frac;
    const clamped = Math.max(-1, Math.min(1, v));
    out[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return out;
}

interface AudioCtx {
  sampleRate: number;
  createMediaStreamSource(stream: MediaStream): { connect(n: unknown): void; disconnect(): void };
  createScriptProcessor(
    size: number,
    inputs: number,
    outputs: number,
  ): {
    onaudioprocess:
      | ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void)
      | null;
    connect(n: unknown): void;
    disconnect(): void;
  };
  destination: unknown;
  close(): Promise<void>;
}

/** The browser recorder; null when the page has no microphone API. */
export function webRecorder(): VoiceRecorder | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  const Ctor =
    (window as unknown as { AudioContext?: new () => AudioCtx }).AudioContext ??
    (window as unknown as { webkitAudioContext?: new () => AudioCtx }).webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !Ctor) return null;
  let stream: MediaStream | null = null;
  let ctx: AudioCtx | null = null;
  let chunks: Float32Array[] = [];
  const release = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    void ctx?.close().catch(() => {});
    stream = null;
    ctx = null;
  };
  return {
    kind: "web-audio",
    async start() {
      chunks = [];
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      ctx = new Ctor();
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(node);
      node.connect(ctx.destination);
    },
    async stop() {
      const rate = ctx?.sampleRate ?? RELAY_SAMPLE_RATE;
      release();
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Float32Array(total);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      chunks = [];
      const pcm = toRelayPcm(all, rate);
      return {
        pcm,
        sampleRate: RELAY_SAMPLE_RATE,
        durationMs: Math.round((pcm.length / RELAY_SAMPLE_RATE) * 1000),
      };
    },
    cancel() {
      chunks = [];
      release();
    },
  };
}

/** The browser's speech synthesis; null when the WebView has none. */
export function webSpeaker(): Speaker | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const synth = window.speechSynthesis;
  const Utterance = (
    window as unknown as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }
  ).SpeechSynthesisUtterance;
  if (!synth || !Utterance) return null;
  return {
    speak(text) {
      synth.cancel();
      synth.speak(new Utterance(text));
    },
    stop() {
      synth.cancel();
    },
  };
}
