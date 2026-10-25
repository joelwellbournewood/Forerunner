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
  enabled: true,
  providers: { stt: ["faster-whisper"], tts: ["kokoro", "piper"] },
  secrets: [],
};
const deepgram: VoiceExtensionRow = {
  extensionId: "ext-deepgram",
  name: "voice-deepgram",
  catalogId: "voice-deepgram",
  enabled: true,
  providers: { stt: ["deepgram"] },
  secrets: ["deepgram_api_key"],
};
const cartesia: VoiceExtensionRow = {
  extensionId: "ext-cartesia",
  name: "voice-cartesia",
  catalogId: "voice-cartesia",
  enabled: true,
  providers: { tts: ["cartesia"] },
  secrets: ["cartesia_api_key"],
};
const elevenlabs: VoiceExtensionRow = {
  extensionId: "ext-elevenlabs",
  name: "voice-elevenlabs",
  catalogId: "voice-elevenlabs",
  enabled: true,
  providers: { tts: ["elevenlabs"] },
  secrets: ["elevenlabs_api_key"],
};
const off = (row: VoiceExtensionRow): VoiceExtensionRow => ({ ...row, enabled: false });
const none = { stt: [], tts: [] };
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
    expect(await resolve([])).toEqual({ stt: null, tts: null, skipped: [], excluded: none });
    // A daemon without the panel (a CLI one-shot) reads the environment only.
    expect(await resolveVoicePreferences({ env: {} })).toEqual({
      stt: null,
      tts: null,
      skipped: [],
      excluded: none,
    });
  });

  it("the local row prefers the first of its providers this daemon registers", async () => {
    const prefs = await resolve([local]);
    expect(prefs.stt).toEqual({
      name: "faster-whisper",
      source: "extension",
      extensionId: "ext-local",
      extension: "voice-local",
      providers: ["faster-whisper"],
    });
    // The preference carries every provider the row stands for that is registered here, so
    // the panel counts the row in force when the registry picked any of them (Piper after a
    // Kokoro that does not import).
    expect(prefs.tts).toMatchObject({ name: "kokoro", providers: ["kokoro"] });
    expect(prefs.skipped).toEqual([]);
    const both = await resolve([local], { registered: { stt: [], tts: ["kokoro", "piper"] } });
    expect(both.tts).toMatchObject({ name: "kokoro", providers: ["kokoro", "piper"] });
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
      providers: ["fake-stt"],
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
      stt: {
        name: "fake-stt",
        source: "env",
        extensionId: null,
        extension: null,
        providers: ["fake-stt"],
      },
      tts: null,
      skipped: [],
      excluded: none,
    });
  });

  it("a panel that cannot be read leaves the environment's choice and the policy", async () => {
    const prefs = await resolve([], {
      extensions: async () => {
        throw new Error("store closed");
      },
    });
    expect(prefs).toEqual({ stt: null, tts: null, skipped: [], excluded: none });
  });

  it("a switched-off row prefers nothing and says so; its cloud providers are excluded from the policy's fallback", async () => {
    // Off must mean off (review finding 1 of w3-o4-voice-prefs): a cloud row switched off in
    // the panel is not reached for by the registry's fallback, whatever key is in the vault.
    const prefs = await resolve([local, off(deepgram), off(elevenlabs)]);
    expect(prefs.stt).toMatchObject({ name: "faster-whisper", extension: "voice-local" });
    expect(prefs.tts).toMatchObject({ name: "kokoro", extension: "voice-local" });
    expect(prefs.skipped).toEqual([
      {
        extensionId: "ext-deepgram",
        extension: "voice-deepgram",
        side: "stt",
        provider: "deepgram",
        reason: "switched off in Extensions",
      },
      {
        extensionId: "ext-elevenlabs",
        extension: "voice-elevenlabs",
        side: "tts",
        provider: "elevenlabs",
        reason: "switched off in Extensions",
      },
    ]);
    expect(prefs.excluded).toEqual({
      stt: [{ name: "deepgram", reason: "switched off in Extensions" }],
      tts: [{ name: "elevenlabs", reason: "switched off in Extensions" }],
    });
    // The local row switched off removes the preference only: the local helpers are free and
    // private and stay the policy's default, so voice does not go dark.
    const localOff = await resolve([off(local), deepgram]);
    expect(localOff.stt).toMatchObject({ name: "deepgram" });
    expect(localOff.tts).toBeNull();
    expect(localOff.excluded).toEqual(none);
    expect(localOff.skipped.map((s) => [s.side, s.reason])).toEqual([
      ["stt", "switched off in Extensions"],
      ["tts", "switched off in Extensions"],
    ]);
    // A switched-off row whose provider this daemon does not register excludes nothing.
    const unknown = await resolve([off(deepgram)], {
      registered: { stt: ["faster-whisper"], tts: [] },
    });
    expect(unknown.excluded).toEqual(none);
    expect(unknown.skipped[0]?.reason).toBe("switched off in Extensions");
  });

  it("a provider in force through the environment or an enabled row is never excluded by a switched-off row", async () => {
    const env = { [VOICE_PREFERENCE_ENV.stt]: "deepgram" };
    const prefs = await resolve([off(deepgram)], { env });
    expect(prefs.stt).toMatchObject({ name: "deepgram", source: "env" });
    expect(prefs.excluded).toEqual(none);
    expect(prefs.skipped[0]?.reason).toBe("switched off in Extensions");
    // Two rows that stand for the same provider, one on and one off: the enabled one decides.
    const twin: VoiceExtensionRow = { ...deepgram, extensionId: "ext-twin", name: "voice-twin" };
    const twins = await resolve([off(twin), deepgram]);
    expect(twins.stt).toMatchObject({ name: "deepgram", extension: "voice-deepgram" });
    expect(twins.excluded).toEqual(none);
  });

  it("a cloud row whose grant lacks its provider's key is skipped as not granted, excluded, and the vault is never asked", async () => {
    // Review finding 3 of w3-o4-voice-prefs: a narrowed grant (the human removed the secret
    // from the row) is the human saying no to the key; the row must neither be preferred nor
    // make the daemon read the key, and the policy must not fall back to the provider either.
    let asked = 0;
    const hasSecret = async () => {
      asked += 1;
      return true;
    };
    const narrowed: VoiceExtensionRow = { ...deepgram, secrets: [] };
    const prefs = await resolve([local, narrowed], { hasSecret });
    expect(asked).toBe(0);
    expect(prefs.stt).toMatchObject({ name: "faster-whisper", extension: "voice-local" });
    expect(prefs.skipped).toEqual([
      {
        extensionId: "ext-deepgram",
        extension: "voice-deepgram",
        side: "stt",
        provider: "deepgram",
        reason: "key not granted: secret:deepgram_api_key is not in the row's permissions",
      },
    ]);
    expect(prefs.excluded).toEqual({
      stt: [{ name: "deepgram", reason: "key not granted in Extensions" }],
      tts: [],
    });
    // The grant restored: the key is checked and the row is preferred again.
    const granted = await resolve([local, deepgram], { hasSecret });
    expect(asked).toBe(1);
    expect(granted.stt).toMatchObject({ name: "deepgram" });
    expect(granted.excluded).toEqual(none);
    // A row granted a secret that is not its provider's key still needs a value for it.
    const extra: VoiceExtensionRow = {
      ...local,
      providers: { stt: ["whisper-x"] },
      secrets: ["whisper_x_key"],
    };
    const custom = await resolve([extra], {
      registered: { stt: ["whisper-x"], tts: [] },
      hasSecret: async () => false,
    });
    expect(custom.stt).toBeNull();
    expect(custom.skipped[0]?.reason).toBe(
      "no value for secret:whisper_x_key; store the key with fr setup",
    );
  });
});
