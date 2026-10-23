import { describe, expect, it } from "vitest";
import {
  resolveVoicePreferences,
  VOICE_PREFERENCE_ENV,
  type VoiceExtensionRow,
  voicePreferences,
} from "../src/voice/providers.ts";

/**
 * The voice providers the Extensions panel chose (spec O.4): `resolveVoicePreferences` reads
 * the enabled `voice-*` rows, one preferred provider per side, with the environment variables
 * as a documented override and a visible reason for every row that is not in force.
 */
const local: VoiceExtensionRow = {
  extensionId: "ext-local",
  name: "voice-local",
  catalogId: "voice-local",
  providers: { stt: ["faster-whisper"], tts: ["kokoro", "piper"] },
  secrets: [],
};
const deepgram: VoiceExtensionRow = {
  extensionId: "ext-deepgram",
  name: "voice-deepgram",
  catalogId: "voice-deepgram",
  providers: { stt: ["deepgram"] },
  secrets: ["deepgram_api_key"],
};
const cartesia: VoiceExtensionRow = {
  extensionId: "ext-cartesia",
  name: "voice-cartesia",
  catalogId: "voice-cartesia",
  providers: { tts: ["cartesia"] },
  secrets: ["cartesia_api_key"],
};
const elevenlabs: VoiceExtensionRow = {
  extensionId: "ext-elevenlabs",
  name: "voice-elevenlabs",
  catalogId: "voice-elevenlabs",
  providers: { tts: ["elevenlabs"] },
  secrets: ["elevenlabs_api_key"],
};
const registered = {
  stt: ["faster-whisper", "deepgram"],
  tts: ["kokoro", "cartesia", "elevenlabs"],
};
const allKeys = async () => true;
const resolve = (
  rows: VoiceExtensionRow[],
  over: Partial<Parameters<typeof resolveVoicePreferences>[0]> = {},
) =>
  resolveVoicePreferences({
    env: {},
    extensions: async () => rows,
    hasSecret: allKeys,
    registered,
    ...over,
  });

describe("voice preferences from the Extensions panel", () => {
  it("nothing enabled: no preference on either side, the registry's policy decides", async () => {
    expect(await resolve([])).toEqual({ stt: null, tts: null, skipped: [] });
    // A daemon without the panel (a CLI one-shot) reads the environment only.
    expect(await resolveVoicePreferences({ env: {} })).toEqual({
      stt: null,
      tts: null,
      skipped: [],
    });
  });

  it("the local row prefers the first of its providers this daemon registers", async () => {
    const prefs = await resolve([local]);
    expect(prefs.stt).toEqual({
      name: "faster-whisper",
      source: "extension",
      extensionId: "ext-local",
      extension: "voice-local",
    });
    expect(prefs.tts?.name).toBe("kokoro");
    expect(prefs.skipped).toEqual([]);
    // With Piper the only local TTS registered, the same row prefers Piper.
    const piper = await resolve([local], { registered: { stt: [], tts: ["piper"] } });
    expect(piper.tts?.name).toBe("piper");
    expect(piper.stt).toBeNull();
    expect(piper.skipped).toEqual([
      expect.objectContaining({
        extension: "voice-local",
        side: "stt",
        provider: null,
        reason: expect.stringContaining("faster-whisper is not registered"),
      }),
    ]);
  });

  it("an enabled cloud row with its key wins over the local row; the local row says why it is not in force", async () => {
    const prefs = await resolve([local, deepgram, elevenlabs]);
    expect(prefs.stt).toMatchObject({ name: "deepgram", extension: "voice-deepgram" });
    expect(prefs.tts).toMatchObject({ name: "elevenlabs", extension: "voice-elevenlabs" });
    expect(prefs.skipped).toEqual([
      expect.objectContaining({
        extensionId: "ext-local",
        side: "stt",
        provider: "faster-whisper",
        reason: expect.stringContaining('"deepgram" (voice-deepgram) is preferred'),
      }),
      expect.objectContaining({
        extensionId: "ext-local",
        side: "tts",
        provider: "kokoro",
        reason: expect.stringContaining('"elevenlabs" (voice-elevenlabs) is preferred'),
      }),
    ]);
  });

  it("a cloud row without its key is skipped with the reference in the reason and the next row is preferred", async () => {
    const hasSecret = async (ref: string) => ref !== "secret:deepgram_api_key";
    const prefs = await resolve([local, deepgram], { hasSecret });
    expect(prefs.stt).toMatchObject({ name: "faster-whisper", extension: "voice-local" });
    expect(prefs.skipped).toEqual([
      {
        extensionId: "ext-deepgram",
        extension: "voice-deepgram",
        side: "stt",
        provider: "deepgram",
        reason: "no value for secret:deepgram_api_key; store the key with fr setup",
      },
    ]);
    // Without the local row nothing is preferred: the policy decides.
    const alone = await resolve([deepgram], { hasSecret });
    expect(alone.stt).toBeNull();
    expect(alone.skipped).toHaveLength(1);
    // A vault that throws counts as no value, never as a value.
    const broken = await resolve([deepgram], {
      hasSecret: async () => {
        throw new Error("vault locked");
      },
    });
    expect(broken.stt).toBeNull();
    expect(broken.skipped[0]?.reason).toContain("no value for secret:deepgram_api_key");
  });

  it("two cloud rows for the same side: the first by name is preferred, the other is reported", async () => {
    const prefs = await resolve([elevenlabs, cartesia]);
    expect(prefs.tts).toMatchObject({ name: "cartesia", extension: "voice-cartesia" });
    expect(prefs.skipped).toEqual([
      expect.objectContaining({
        extension: "voice-elevenlabs",
        side: "tts",
        provider: "elevenlabs",
        reason: '"cartesia" (voice-cartesia) is preferred; one TTS provider is in force at a time',
      }),
    ]);
    // The preferred row without its key: the other one takes over.
    const next = await resolve([elevenlabs, cartesia], {
      hasSecret: async (ref) => ref !== "secret:cartesia_api_key",
    });
    expect(next.tts?.name).toBe("elevenlabs");
    expect(next.skipped.map((s) => s.extension)).toEqual(["voice-cartesia"]);
  });

  it("the environment variables override the panel, and every row they override says so", async () => {
    const env = { [VOICE_PREFERENCE_ENV.stt]: " fake-stt ", [VOICE_PREFERENCE_ENV.tts]: "" };
    const prefs = await resolve([local, deepgram], { env });
    expect(prefs.stt).toEqual({
      name: "fake-stt",
      source: "env",
      extensionId: null,
      extension: null,
    });
    expect(prefs.tts).toMatchObject({ name: "kokoro", source: "extension" });
    expect(prefs.skipped).toEqual([
      expect.objectContaining({
        extension: "voice-deepgram",
        side: "stt",
        reason: `overridden by ${VOICE_PREFERENCE_ENV.stt}=fake-stt`,
      }),
      expect.objectContaining({
        extension: "voice-local",
        side: "stt",
        reason: `overridden by ${VOICE_PREFERENCE_ENV.stt}=fake-stt`,
      }),
    ]);
    expect(voicePreferences(env)).toEqual({
      stt: { name: "fake-stt", source: "env", extensionId: null, extension: null },
      tts: null,
      skipped: [],
    });
  });

  it("a panel that cannot be read leaves the environment's choice and the policy", async () => {
    const prefs = await resolve([], {
      extensions: async () => {
        throw new Error("store closed");
      },
    });
    expect(prefs).toEqual({ stt: null, tts: null, skipped: [] });
  });
});
