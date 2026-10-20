/**
 * Optional audio storage. Off by default: transcripts are kept, audio is not (spec O.10).
 * When turned on, each turn's PCM is written as WAV under <data>/voice/<session>/ next to a
 * retention note.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { appDirs, join, safeSegment } from "@forerunner/platform";
import { encodeWav } from "./wav.ts";

export const RETENTION_NOTE = `Forerunner voice audio
======================

These WAV files exist only because "store audio" was turned on for this session.
They are not synced, not sent anywhere, and not read by any agent. Delete this folder at any
time; transcripts live in session history independently of these files. Nothing in Forerunner
depends on them.
`;

export interface AudioStoreOptions {
  /** Target directory; default <appDirs().data>/voice/<session>. */
  dir?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
}

export function defaultAudioDir(sessionId: string, env?: NodeJS.ProcessEnv): string {
  return join(appDirs(env ? { env } : {}).data, "voice", safeSegment(sessionId, "session"));
}

export class AudioStore {
  readonly dir: string;
  private prepared = false;

  constructor(opts: AudioStoreOptions = {}) {
    this.dir = opts.dir ?? defaultAudioDir(opts.sessionId ?? "session", opts.env);
  }

  private async prepare(): Promise<void> {
    if (this.prepared) return;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "RETENTION.md"), RETENTION_NOTE, "utf8");
    this.prepared = true;
  }

  /** Write one side of a turn. Returns the file path. */
  async writeTurn(
    turn: number,
    role: "user" | "assistant",
    pcm: Int16Array,
    sampleRate: number,
  ): Promise<string> {
    await this.prepare();
    const file = join(this.dir, `turn-${String(turn).padStart(4, "0")}-${role}.wav`);
    await writeFile(file, encodeWav(pcm, sampleRate, 1));
    return file;
  }
}
