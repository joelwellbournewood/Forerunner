/**
 * Voice profiles (ADR 0089): which local speech stack this install has. Browser-safe (no
 * node imports) so the Settings → Voice card, the CLI and the daemon show the same catalog.
 *
 *   none  no Python speech packages; local voice is off (cloud voice still works with a key)
 *   cpu   faster-whisper int8 on the CPU + Kokoro on CPU PyTorch
 *   gpu   NVIDIA only: faster-whisper float16 on CUDA + Kokoro on CUDA PyTorch
 *
 * The sizes are measured, not guessed: the CPU profile's venv and models on Linux (2026-10-26:
 * 1.8 GB venv + 0.45 GB models), the GPU profile from the pinned wheels' unpacked sizes (torch
 * 2.11.0+cu128 is 4.4 GB unpacked on Windows, 1.6 GB on Linux plus about 4 GB of CUDA wheels;
 * cuBLAS 0.8 GB, cuDNN 1 GB). They change with the pins in
 * packages/voice/python/requirements-*.txt.
 */
import { z } from "zod";

export const VOICE_PROFILES = ["none", "cpu", "gpu"] as const;
export const VoiceProfileSchema = z.enum(VOICE_PROFILES);
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

export interface VoiceProfileInfo {
  profile: VoiceProfile;
  label: string;
  /** Disk used once installed (packages and models), in words. */
  disk: string;
  /** What is downloaded, in words. */
  download: string;
  /** The trade-off in one sentence. */
  tradeOff: string;
  /** Only with an NVIDIA GPU and driver. */
  needsNvidia: boolean;
}

export const VOICE_PROFILE_INFO: Record<VoiceProfile, VoiceProfileInfo> = {
  none: {
    profile: "none",
    label: "None",
    disk: "0 GB",
    download: "nothing",
    tradeOff:
      "No local speech: voice is off unless a cloud voice provider (Deepgram, Cartesia, ElevenLabs) is set up in Extensions.",
    needsNvidia: false,
  },
  cpu: {
    profile: "cpu",
    label: "CPU",
    disk: "about 2.3 GB",
    download: "about 1 GB",
    tradeOff:
      "Works on any PC. Replies start slower: about 1 s before the first spoken word on a desktop CPU.",
    needsNvidia: false,
  },
  gpu: {
    profile: "gpu",
    label: "GPU (NVIDIA)",
    disk: "about 8 GB",
    download: "about 4.5 GB",
    tradeOff:
      "Fastest replies. Needs an NVIDIA GPU with a current driver; falls back to the CPU, with a warning, when CUDA cannot be used.",
    needsNvidia: true,
  },
};

/** The device a helper was verified on; `fallback` says why the CPU took over from CUDA. */
export const VoiceDeviceView = z.object({
  device: z.string(),
  computeType: z.string().nullable(),
  fallback: z.string().nullable(),
});
export type VoiceDeviceView = z.infer<typeof VoiceDeviceView>;

export const GpuView = z.object({
  present: z.boolean(),
  name: z.string().nullable(),
  driver: z.string().nullable(),
  memoryMb: z.number().nullable(),
  /** How it was found, or why not ("nvidia-smi not found"). */
  reason: z.string(),
});
export type GpuView = z.infer<typeof GpuView>;

/** One progress event of an install or a remove, in order. */
export const VoiceInstallEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("step"), step: z.string(), message: z.string() }),
  z.object({ type: z.literal("log"), message: z.string() }),
  z.object({
    type: z.literal("progress"),
    what: z.string(),
    bytes: z.number(),
    total: z.number().nullable(),
  }),
  z.object({ type: z.literal("warning"), message: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({
    type: z.literal("result"),
    ok: z.boolean(),
    profile: VoiceProfileSchema,
    /** 0 done, 2 done with the CPU standing in for a failed GPU, 1 failed. */
    exitCode: z.number().int(),
    message: z.string(),
  }),
]);
export type VoiceInstallEvent = z.infer<typeof VoiceInstallEvent>;

export const VoiceInstallEntryView = z.object({ seq: z.number().int(), event: VoiceInstallEvent });
export type VoiceInstallEntryView = z.infer<typeof VoiceInstallEntryView>;

export const VoiceInstallJobView = z.object({
  id: z.string(),
  profile: VoiceProfileSchema,
  state: z.enum(["running", "done", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  /** The last events (the whole stream is on the events route). */
  recent: z.array(VoiceInstallEntryView),
});
export type VoiceInstallJobView = z.infer<typeof VoiceInstallJobView>;

/** `GET /voice/install`: the profile in force, the catalog, the GPU, the last install. */
export const VoiceInstallView = z.object({
  /** null: never chosen (an install from before profiles; local voice uses whatever Python finds). */
  profile: VoiceProfileSchema.nullable(),
  profiles: z.array(
    z.object({
      profile: VoiceProfileSchema,
      label: z.string(),
      disk: z.string(),
      download: z.string(),
      tradeOff: z.string(),
      needsNvidia: z.boolean(),
    }),
  ),
  /** The profile setup offers first: gpu with an NVIDIA GPU, cpu otherwise. */
  recommended: VoiceProfileSchema,
  gpu: GpuView,
  installedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  stt: VoiceDeviceView.nullable(),
  tts: VoiceDeviceView.nullable(),
  /** FORERUNNER_PYTHON is set: the helpers use that interpreter, not the managed venv. */
  pythonOverride: z.string().nullable(),
  job: VoiceInstallJobView.nullable(),
  /** The same change from a terminal. */
  cli: z.string(),
});
export type VoiceInstallView = z.infer<typeof VoiceInstallView>;

export const VoiceInstallBody = z.object({ profile: VoiceProfileSchema }).strict();
export type VoiceInstallBody = z.infer<typeof VoiceInstallBody>;

export const VOICE_INSTALL_ROUTES = {
  voiceInstall:
    "GET /voice/install (VoiceInstallView: the voice profile in force, the catalog with sizes and trade-offs, the GPU found, the devices the last install verified, the running or last install)",
  startVoiceInstall:
    "POST /voice/install (VoiceInstallBody { profile } -> 202 VoiceInstallView: installs, switches or removes the local voice stack in the background, the same steps as fr voice install / remove; 409 conflict while an install runs or a voice session is open)",
  voiceInstallEvents:
    "GET /voice/install/events?afterSeq= (VoiceInstallEntryView[] as JSON) | Accept: text/event-stream (SSE `voice.install` frames, bearer header; ends with the job)",
} as const;

/** The CLI command for a profile (shown by the card and in errors). */
export function voiceInstallCommand(profile: VoiceProfile): string {
  return profile === "none" ? "fr voice remove" : `fr voice install --${profile}`;
}
