/**
 * Voice turns relayed from the phone (spec R.5, O; ADR 0080). The phone has no voice loop of
 * its own: a push-to-talk turn travels to the PC as one remote command (`kind: "voice"`), the
 * daemon's `RemoteCommandWatcher` hands it here, and the turn runs through the same voice
 * sessions that serve the `/voice` routes (the loop, the conversation agent, the read-back
 * rules, the `voice.turn` rows). A recorded turn is pushed as 20 ms frames between a press
 * and a release, exactly as `POST /voice/sessions/:id/press|audio` would; a typed line goes
 * through the loop's text fallback (`POST /voice/sessions/:id/text`). The reply text (what
 * the PC's TTS spoke) goes back in the command's result; the phone shows it and speaks it.
 *
 * One session per issuing device is kept open between turns, so a spoken "yes" in the next
 * relayed turn answers a card the previous turn read back; it is stopped after `idleMs`
 * without a turn (checked lazily on the next relay and on `close`).
 */
import { type Clock, ForerunnerError } from "@forerunner/platform";
import type { VoiceTurn } from "./bridge.ts";
import { type AudioChunk, bytesToPcm } from "./pkg.ts";
import type { VoiceSession, VoiceSessions } from "./sessions.ts";

/**
 * The longest recorded turn the phone relays (ADR 0080): checked as a duration from the
 * bytes, the rate and the channels (`VoiceEnvelope` in `remote/watcher.ts`, `toFrames`).
 */
export const VOICE_RELAY_MAX_MS = 5_000;
/**
 * The byte bound on a recording: 5 s of 16 kHz mono 16-bit PCM, the phone's format. A higher
 * rate or a second channel fits fewer seconds under it; the duration bound applies as well.
 */
export const VOICE_RELAY_MAX_PCM_BYTES = 16_000 * 2 * (VOICE_RELAY_MAX_MS / 1000);
/** Base64 length of `VOICE_RELAY_MAX_PCM_BYTES` (what fits the state service's JSON body cap). */
export const VOICE_RELAY_MAX_PCM_BASE64 = Math.ceil(VOICE_RELAY_MAX_PCM_BYTES / 3) * 4;
/**
 * A relayed turn older than this when the PC picks it up is refused, never run (ADR 0080
 * item 7): the phone stops waiting for the reply after about two minutes.
 */
export const VOICE_RELAY_MAX_AGE_MS = 2 * 60_000;
export const DEFAULT_VOICE_RELAY_IDLE_MS = 5 * 60_000;
/** A relayed turn that has not ended after this long fails (the watcher must not hang). */
export const DEFAULT_VOICE_RELAY_TURN_TIMEOUT_MS = 60_000;
const FRAME_MS = 20;

export interface VoiceRelayAudio {
  /** 16-bit signed little-endian PCM, base64. */
  pcm: string;
  sampleRate: number;
  channels: number;
}

export interface VoiceRelayRequest {
  /** The issuing device: its relay session is reused for the next turn. */
  deviceId: string;
  projectId?: string | null;
  language?: string;
  /** Exactly one of `audio` and `transcript`. */
  audio?: VoiceRelayAudio;
  transcript?: string;
}

export interface VoiceRelayResult {
  source: "audio" | "text";
  sessionId: string;
  turn: number;
  said: string;
  /** What the PC spoke: the reply line or the read-back. */
  heard: string;
  pending: { id: string; readback: string; commands: string[]; decision: string | null } | null;
  /** When this turn answered a card read back earlier: whether it confirmed it; else null. */
  approved: boolean | null;
  error: { code: string; message: string } | null;
  audioChunks: number;
  totalToFirstAudioMs: number | null;
}

export interface VoiceRelayOptions {
  clock: Clock;
  idleMs?: number;
  turnTimeoutMs?: number;
}

interface Held {
  session: VoiceSession;
  projectId: string | null;
  lastUsed: number;
}

export class VoiceRelay {
  private readonly held = new Map<string, Held>();
  private readonly idleMs: number;
  private readonly turnTimeoutMs: number;

  constructor(
    private readonly voice: Pick<VoiceSessions, "start" | "stop">,
    private readonly opts: VoiceRelayOptions,
  ) {
    this.idleMs = opts.idleMs ?? DEFAULT_VOICE_RELAY_IDLE_MS;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_VOICE_RELAY_TURN_TIMEOUT_MS;
  }

  /** Sessions the relay holds open (tests, the health view). */
  get openSessions(): number {
    return [...this.held.values()].filter((h) => !h.session.bridge.ended).length;
  }

  async turn(req: VoiceRelayRequest): Promise<VoiceRelayResult> {
    const hasAudio = !!req.audio;
    const line = req.transcript?.trim() ?? "";
    if (hasAudio === line.length > 0) {
      throw new ForerunnerError("validation", "a relayed voice turn carries audio or a transcript");
    }
    await this.sweep();
    const session = await this.sessionFor(req);
    const bridge = session.bridge;
    let record: VoiceTurn;
    if (req.audio) {
      const frames = toFrames(req.audio);
      bridge.press(true);
      const turn = bridge.currentTurn;
      const done = bridge.turnEnded(turn);
      for (const frame of frames) bridge.push(frame);
      bridge.press(false);
      record = await this.within(done);
    } else {
      record = await this.within(bridge.text(line));
    }
    const held = this.held.get(req.deviceId);
    if (held) held.lastUsed = this.opts.clock.now();
    const pending = record.pending;
    return {
      source: record.source,
      sessionId: session.id,
      turn: record.turn,
      said: record.said,
      heard: record.heard,
      pending: pending
        ? {
            id: pending.id,
            readback: pending.readback,
            commands: pending.commands,
            decision: pending.decision ?? null,
          }
        : null,
      approved: record.approval ? record.approval.approved : null,
      error: record.error,
      audioChunks: record.audioChunks,
      totalToFirstAudioMs: record.latency.totalToFirstAudioMs ?? null,
    };
  }

  /** Stop every session the relay holds (the daemon's close). */
  async close(): Promise<void> {
    for (const [key, h] of this.held) {
      this.held.delete(key);
      await this.voice.stop(h.session.id).catch(() => undefined);
    }
  }

  private async sessionFor(req: VoiceRelayRequest): Promise<VoiceSession> {
    const projectId = req.projectId ?? null;
    const current = this.held.get(req.deviceId);
    if (current && !current.session.bridge.ended && current.projectId === projectId) {
      return current.session;
    }
    if (current) {
      this.held.delete(req.deviceId);
      await this.voice.stop(current.session.id).catch(() => undefined);
    }
    const session = await this.voice.start({
      ...(projectId ? { projectId } : {}),
      ...(req.language ? { language: req.language } : {}),
      mode: "push_to_talk",
    });
    this.held.set(req.deviceId, { session, projectId, lastUsed: this.opts.clock.now() });
    return session;
  }

  private async sweep(): Promise<void> {
    const now = this.opts.clock.now();
    for (const [key, h] of this.held) {
      if (h.session.bridge.ended || now - h.lastUsed > this.idleMs) {
        this.held.delete(key);
        await this.voice.stop(h.session.id).catch(() => undefined);
      }
    }
  }

  private within<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = this.opts.clock.setTimeout(() => {
        reject(new ForerunnerError("timeout", "the relayed voice turn did not end in time"));
      }, this.turnTimeoutMs);
      p.then(
        (v) => {
          cancel();
          resolve(v);
        },
        (e: unknown) => {
          cancel();
          reject(e);
        },
      );
    });
  }
}

/** The recorded turn as 20 ms frames on the capture timeline (what a shell would push). */
export function toFrames(audio: VoiceRelayAudio): AudioChunk[] {
  if (audio.pcm.length > VOICE_RELAY_MAX_PCM_BASE64) {
    throw new ForerunnerError(
      "validation",
      `the relayed recording is longer than ${VOICE_RELAY_MAX_MS / 1000} s`,
    );
  }
  const bytes = Buffer.from(audio.pcm, "base64");
  const channels = Math.max(1, audio.channels);
  if ((bytes.byteLength / (2 * channels * audio.sampleRate)) * 1000 > VOICE_RELAY_MAX_MS + 20) {
    throw new ForerunnerError(
      "validation",
      `the relayed recording is longer than ${VOICE_RELAY_MAX_MS / 1000} s`,
    );
  }
  const frameSamples = Math.max(1, Math.round((audio.sampleRate * FRAME_MS) / 1000)) * channels;
  const pcm = bytesToPcm(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const frames: AudioChunk[] = [];
  for (let start = 0; start < pcm.length; start += frameSamples) {
    frames.push({
      pcm: pcm.subarray(start, Math.min(pcm.length, start + frameSamples)),
      sampleRate: audio.sampleRate,
      channels,
      timestampMs: (start / channels / audio.sampleRate) * 1000,
    });
  }
  return frames;
}
