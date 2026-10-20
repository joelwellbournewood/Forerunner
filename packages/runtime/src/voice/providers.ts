/**
 * The voice providers the daemon composes (spec O.4; ADR 0012 item 5, ADR 0048): the local
 * helpers by default (faster-whisper, Kokoro, Piper when a model is named) and the cloud
 * providers by secret reference (Deepgram, Cartesia, ElevenLabs). Nothing is probed here:
 * availability is asked when a voice session starts or the status route is read, and the
 * registry's policy ("local if available, else cloud if its key is configured") picks. No
 * fake provider is registered in production, so a machine without a helper and without a key
 * reports voice unavailable with the reason instead of transcribing nothing.
 *
 * Keys stay in the vault: a provider gets the reference (`secret:deepgram_api_key`) and a
 * resolver that reads the value right before a connection; the status rows carry the
 * reference and whether it has a value, never the value.
 */
import type { Clock } from "@forerunner/platform";
import { parseSecretRef, type Vault } from "@forerunner/vault";
import {
  CartesiaTts,
  DeepgramStt,
  ElevenLabsTts,
  FasterWhisperStt,
  KokoroTts,
  PiperTts,
  VoiceProviderRegistry,
} from "./pkg.ts";

/** The secret references the cloud providers read from the vault (`fr setup` stores them). */
export const VOICE_SECRET_REFS = {
  deepgram: "secret:deepgram_api_key",
  cartesia: "secret:cartesia_api_key",
  elevenlabs: "secret:elevenlabs_api_key",
} as const;

export interface VoiceRegistryOptions {
  env: NodeJS.ProcessEnv;
  vault: Vault;
  clock: Clock;
}

/** The providers' names, from the environment until the Extensions panel carries the choice. */
export interface VoicePreferences {
  stt?: string;
  tts?: string;
}

export function voicePreferences(env: NodeJS.ProcessEnv): VoicePreferences {
  const stt = env.FORERUNNER_VOICE_STT?.trim();
  const tts = env.FORERUNNER_VOICE_TTS?.trim();
  return { ...(stt ? { stt } : {}), ...(tts ? { tts } : {}) };
}

/** Whether a secret reference has a value in the vault (never the value). */
export function vaultHasSecret(vault: Vault): (ref: string) => Promise<boolean> {
  return async (ref) => {
    try {
      return await vault.has(parseSecretRef(ref));
    } catch {
      return false;
    }
  };
}

export function buildVoiceRegistry(opts: VoiceRegistryOptions): VoiceProviderRegistry {
  const { env, vault, clock } = opts;
  const resolveSecret = async (ref: string): Promise<string | undefined> =>
    (await vault.get(parseSecretRef(ref))) ?? undefined;
  const registry = new VoiceProviderRegistry();
  // Local by default (free, private); each probes its interpreter or binary when asked.
  const whisperModel = env.FORERUNNER_WHISPER_MODEL?.trim();
  registry.registerStt(
    new FasterWhisperStt({ clock, env, ...(whisperModel ? { model: whisperModel } : {}) }),
  );
  const kokoroVoice = env.FORERUNNER_KOKORO_VOICE?.trim();
  registry.registerTts(
    new KokoroTts({ clock, env, ...(kokoroVoice ? { voice: kokoroVoice } : {}) }),
  );
  const piperModel = env.FORERUNNER_PIPER_MODEL?.trim();
  if (piperModel) registry.registerTts(new PiperTts({ modelPath: piperModel, env }));
  // Cloud for the lowest latency, each behind its key by reference.
  registry.registerStt(
    new DeepgramStt({ apiKeyRef: VOICE_SECRET_REFS.deepgram, resolveSecret, clock }),
    { secretRef: VOICE_SECRET_REFS.deepgram },
  );
  const cartesiaVoice = env.FORERUNNER_CARTESIA_VOICE?.trim();
  registry.registerTts(
    new CartesiaTts({
      apiKeyRef: VOICE_SECRET_REFS.cartesia,
      resolveSecret,
      clock,
      ...(cartesiaVoice ? { voice: cartesiaVoice } : {}),
    }),
    { secretRef: VOICE_SECRET_REFS.cartesia },
  );
  const elevenVoice = env.FORERUNNER_ELEVENLABS_VOICE?.trim();
  registry.registerTts(
    new ElevenLabsTts({
      apiKeyRef: VOICE_SECRET_REFS.elevenlabs,
      resolveSecret,
      ...(elevenVoice ? { voice: elevenVoice } : {}),
    }),
    { secretRef: VOICE_SECRET_REFS.elevenlabs },
  );
  return registry;
}
