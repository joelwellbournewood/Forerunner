import { createContext, useContext } from "react";

/**
 * Microphone capture for a push-to-talk turn (spec O.3): 16-bit little-endian mono PCM in
 * chunks, base64-encoded for `POST /voice/sessions/:id/audio`. The browser implementation uses
 * getUserMedia and a ScriptProcessorNode (WebView2 and WebKitGTK both have it; an AudioWorklet
 * would need a separate module file served from the bundle). Nothing is stored here; the
 * daemon decides about audio storage. Tests provide their own capture through
 * `VoiceCaptureContext`.
 */

export interface CapturedChunk {
  pcm: string;
  sampleRate: number;
  channels: number;
  /** Position of the first sample on the capture timeline, ms. */
  timestampMs: number;
}

export interface MicCapture {
  /** Starts capturing; rejects when the microphone is denied or missing. */
  start(onChunk: (chunk: CapturedChunk) => void): Promise<void>;
  stop(): void;
}

/** Float samples in [-1, 1] to 16-bit little-endian PCM, base64. */
export function floatToPcmBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** The webview's microphone, or null when this page cannot capture audio at all. */
export function browserMicCapture(): MicCapture | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  const AudioContextCtor =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AudioContextCtor) return null;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  return {
    async start(onChunk) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      context = new AudioContextCtor();
      const source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      const rate = context.sampleRate;
      let samples = 0;
      processor.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0);
        onChunk({
          pcm: floatToPcmBase64(data),
          sampleRate: rate,
          channels: 1,
          timestampMs: (samples / rate) * 1000,
        });
        samples += data.length;
      };
      source.connect(processor);
      processor.connect(context.destination);
    },
    stop() {
      processor?.disconnect();
      if (processor) processor.onaudioprocess = null;
      for (const track of stream?.getTracks() ?? []) track.stop();
      void context?.close().catch(() => {});
      processor = null;
      stream = null;
      context = null;
    },
  };
}

/** A factory for one turn's capture; `null` in the context means the browser's. */
export type CaptureFactory = () => MicCapture | null;

export const VoiceCaptureContext = createContext<CaptureFactory | null>(null);

export function useCaptureFactory(): CaptureFactory {
  return useContext(VoiceCaptureContext) ?? browserMicCapture;
}
