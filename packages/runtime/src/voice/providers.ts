/**
 * The voice providers the daemon composes (spec O.4; ADR 0012 item 5, ADR 0048): the local
 * helpers by default (faster-whisper, Kokoro, Piper when a model is named) and the cloud
 * providers by secret reference (Deepgram, Cartesia, ElevenLabs). Nothing is probed here:
 * availability is asked when a voice session starts or the status route is read, and the
 * registry's policy ("local if available, else cloud if its key is configured") picks. No
 * fake provider is registered in production, so a machine without a helper and without a key
 * reports voice unavailable with the reason instead of transcribing nothing.
 *
 * Which provider is preferred is the Extensions panel's choice (`resolveVoicePreferences`):
 * the enabled `voice-*` rows name their providers through the catalog entry's `voice` field,
 * one STT and one TTS provider are in force at a time, a cloud row needs its provider's key
 * granted on the row and stored in the vault, and every row that is not in force carries the
 * reason the panel shows. Off means off: a cloud provider whose installed row is switched off,
 * or whose row no longer grants its key, is excluded from the registry's fallback, so no
 * audio or text reaches it while its key sits in the vault. The environment variables
 * `FORERUNNER_VOICE_STT` / `FORERUNNER_VOICE_TTS` are an override that wins over the panel
 * (documented in voice.md). Nothing chosen: the registry's policy decides. The preferences
 * are read at every status read and session start, so a toggle in the panel applies at the
 * next voice session without a restart.
 *
 * Keys stay in the vault: a provider gets the reference (`secret:deepgram_api_key`) and a
 * resolver that reads the value right before a connection; the status rows carry the
 * reference and whether it has a value, never the value.
 */
import type { Clock } from "@forerunner/platform";
import { parseSecretRef, type Vault } from "@forerunner/vault";
import type { InstalledCatalogExtension } from "../extensions/registry.ts";
import {
  CartesiaTts,
  DeepgramStt,
  ElevenLabsTts,
  type ExcludedProvider,
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

export type VoiceSide = "stt" | "tts";
export const VOICE_SIDES: readonly VoiceSide[] = ["stt", "tts"];

/** The environment override per side: the named provider wins over the panel's rows. */
export const VOICE_PREFERENCE_ENV: Record<VoiceSide, string> = {
  stt: "FORERUNNER_VOICE_STT",
  tts: "FORERUNNER_VOICE_TTS",
};

/** The reason a switched-off row (and its excluded cloud provider) carries. */
export const SWITCHED_OFF_REASON = "switched off in Extensions";
/** The status reason of a cloud provider whose row no longer grants its key. */
export const KEY_NOT_GRANTED_REASON = "key not granted in Extensions";

export interface VoiceRegistryOptions {
  env: NodeJS.ProcessEnv;
  vault: Vault;
  clock: Clock;
}

/** One side's preferred provider and where the choice came from. */
export interface VoicePreference {
  name: string;
  source: "env" | "extension";
  extensionId: string | null;
  /** The row's name (its catalog id, `voice-deepgram`); null for the environment override. */
  extension: string | null;
  /**
   * Every provider the row stands for on this side that this daemon registers, in the row's
   * order (`name` is the first); the panel counts the row in force when the registry picked
   * any of them (Piper after a Kokoro that does not import). The environment names one.
   */
  providers: string[];
}

/** A voice row that is not in force for a side, with the reason the panel shows. */
export interface VoicePreferenceSkip {
  extensionId: string;
  extension: string;
  side: VoiceSide;
  /** The provider the row would have preferred; null when none of its providers is registered. */
  provider: string | null;
  reason: string;
}

/** The providers' names the panel (or the environment) prefers, read per voice session. */
export interface VoicePreferences {
  stt: VoicePreference | null;
  tts: VoicePreference | null;
  skipped: VoicePreferenceSkip[];
  /**
   * Cloud providers the registry's policy must not fall back to, per side, each with the
   * reason its status row shows: the installed row that stands for it is switched off, or the
   * row's grant no longer lists its key. A provider in force (an enabled row, the environment)
   * is never on this list.
   */
  excluded: Record<VoiceSide, ExcludedProvider[]>;
}

/** No preference on either side and nothing excluded: the registry's policy decides. */
export function noVoicePreferences(): VoicePreferences {
  return { stt: null, tts: null, skipped: [], excluded: { stt: [], tts: [] } };
}

/** An installed `voice-*` row of the Extensions panel, as the registry hands it over. */
export interface VoiceExtensionRow {
  extensionId: string;
  name: string;
  catalogId: string;
  /**
   * On or off in the panel. A switched-off row prefers nothing, is reported with the reason,
   * and its cloud providers are excluded from the policy's fallback (off means off).
   */
  enabled: boolean;
  /** The provider names the catalog entry stands for, per side, in order of preference. */
  providers: { stt?: readonly string[]; tts?: readonly string[] };
  /** Secret names the row is granted; a cloud provider's own key must be among them. */
  secrets: readonly string[];
}

export interface VoicePreferenceDeps {
  env: NodeJS.ProcessEnv;
  /** The installed `voice-*` rows, on or off; absent (a composition without the panel) means none. */
  extensions?: () => Promise<VoiceExtensionRow[]>;
  /** Whether a secret reference has a value, never the value; absent: taken as configured. */
  hasSecret?: (ref: string) => Promise<boolean>;
  /** The provider names this daemon registered; absent: every declared name counts. */
  registered?: Record<VoiceSide, readonly string[]>;
  /** The cloud providers' own secret references by provider name; default `VOICE_SECRET_REFS`. */
  secretRefs?: Readonly<Record<string, string>>;
}

/** The environment's choice alone (`FORERUNNER_VOICE_STT` / `FORERUNNER_VOICE_TTS`). */
export function voicePreferences(env: NodeJS.ProcessEnv): VoicePreferences {
  const fromEnv = (side: VoiceSide): VoicePreference | null => {
    const name = env[VOICE_PREFERENCE_ENV[side]]?.trim();
    return name
      ? { name, source: "env", extensionId: null, extension: null, providers: [name] }
      : null;
  };
  return { ...noVoicePreferences(), stt: fromEnv("stt"), tts: fromEnv("tts") };
}

/**
 * The panel's choice: per side, the first enabled row in force. Rows that need a key (the
 * cloud providers) come before the local row, because enabling a cloud entry is the choice
 * for the lowest latency while local is the policy's default anyway; then by name, so two
 * rows for one side resolve the same way every time. A row is skipped, with the reason, when
 * it is switched off, when the environment overrides the side, when its provider's key is not
 * granted on the row or has no value, when another row is already in force for the side, or
 * when none of its providers is registered here. Off means off: the cloud providers of a
 * switched-off row, and a cloud provider whose row does not grant its key, go on `excluded`
 * so the registry's fallback never reaches them and never reads their key; the local helpers
 * (free, private, the policy's default) are never excluded. A provider the environment or an
 * enabled row put in force is not excluded by another row that stands for it. A panel that
 * cannot be read leaves the environment's choice and the policy.
 */
export async function resolveVoicePreferences(
  deps: VoicePreferenceDeps,
): Promise<VoicePreferences> {
  const prefs = voicePreferences(deps.env);
  if (!deps.extensions) return prefs;
  let rows: VoiceExtensionRow[];
  try {
    rows = await deps.extensions();
  } catch {
    return prefs;
  }
  const secretRefs: Readonly<Record<string, string>> = deps.secretRefs ?? VOICE_SECRET_REFS;
  const isCloud = (name: string) => secretRefs[name] !== undefined;
  const needsKey = (row: VoiceExtensionRow) =>
    row.secrets.length > 0 || VOICE_SIDES.some((side) => (row.providers[side] ?? []).some(isCloud))
      ? 0
      : 1;
  const ordered = [...rows].sort(
    (a, b) => needsKey(a) - needsKey(b) || a.name.localeCompare(b.name),
  );
  for (const side of VOICE_SIDES) {
    for (const row of ordered) {
      const declared = row.providers[side] ?? [];
      if (declared.length === 0) continue;
      const registered = deps.registered
        ? declared.filter((n) => deps.registered?.[side].includes(n))
        : [...declared];
      const provider = registered[0] ?? null;
      const skip = (reason: string) =>
        prefs.skipped.push({
          extensionId: row.extensionId,
          extension: row.name,
          side,
          provider,
          reason,
        });
      const exclude = (name: string, reason: string) => prefs.excluded[side].push({ name, reason });
      if (!row.enabled) {
        skip(SWITCHED_OFF_REASON);
        for (const name of registered) if (isCloud(name)) exclude(name, SWITCHED_OFF_REASON);
        continue;
      }
      const chosen = prefs[side];
      if (chosen?.source === "env") {
        skip(`overridden by ${VOICE_PREFERENCE_ENV[side]}=${chosen.name}`);
        continue;
      }
      if (provider) {
        const ownRef = secretRefs[provider];
        if (ownRef) {
          // The row is the grant: without its provider's key on it, the key is never read.
          if (!row.secrets.includes(parseSecretRef(ownRef))) {
            skip(`key not granted: ${ownRef} is not in the row's permissions`);
            exclude(provider, KEY_NOT_GRANTED_REASON);
            continue;
          }
          if (await missingSecret([parseSecretRef(ownRef)], deps.hasSecret)) {
            skip(`no value for ${ownRef}; store the key with fr setup`);
            continue;
          }
        } else {
          const missing = await missingSecret(row.secrets, deps.hasSecret);
          if (missing) {
            skip(`no value for ${missing}; store the key with fr setup`);
            continue;
          }
        }
      }
      if (chosen) {
        skip(
          `"${chosen.name}" (${chosen.extension}) is preferred; one ${side.toUpperCase()} provider is in force at a time`,
        );
        continue;
      }
      if (!provider) {
        skip(
          declared.length === 1
            ? `${declared[0]} is not registered in this daemon`
            : `none of ${declared.join(", ")} is registered in this daemon`,
        );
        continue;
      }
      prefs[side] = {
        name: provider,
        source: "extension",
        extensionId: row.extensionId,
        extension: row.name,
        providers: registered,
      };
    }
    // What is in force (an enabled row, the environment) stays usable whatever another row
    // standing for the same provider says.
    const inForce = prefs[side]?.name;
    if (inForce) prefs.excluded[side] = prefs.excluded[side].filter((e) => e.name !== inForce);
  }
  return prefs;
}

/** The first granted secret without a value, as a reference; a vault that throws is "no value". */
async function missingSecret(
  secrets: readonly string[],
  hasSecret: VoicePreferenceDeps["hasSecret"],
): Promise<string | null> {
  if (!hasSecret) return null;
  for (const name of secrets) {
    const ref = `secret:${name}`;
    let has = false;
    try {
      has = await hasSecret(ref);
    } catch {
      has = false;
    }
    if (!has) return ref;
  }
  return null;
}

/** The text after the provider's name in the registry's reason for a preferred pick. */
export function preferredBy(p: VoicePreference, side: VoiceSide): string {
  return p.source === "env"
    ? `set by ${VOICE_PREFERENCE_ENV[side]}`
    : `selected in Extensions (${p.extension})`;
}

/**
 * The `voice-*` rows of the panel from the extension registry's installed catalog entries,
 * switched on or off (a switched-off row excludes its cloud providers from the fallback).
 */
export function voiceExtensionRows(registry: {
  installedCatalogEntries(kind: "capability"): Promise<InstalledCatalogExtension[]>;
}): () => Promise<VoiceExtensionRow[]> {
  return async () => {
    const rows: VoiceExtensionRow[] = [];
    for (const e of await registry.installedCatalogEntries("capability")) {
      if (!e.entry.voice) continue;
      rows.push({
        extensionId: e.extensionId,
        name: e.name,
        catalogId: e.catalogId,
        enabled: e.enabled,
        providers: e.entry.voice,
        secrets: e.permissions.secrets,
      });
    }
    return rows;
  };
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
