import { SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { FakeStt, FakeTts } from "../src/providers/fake.ts";
import { VoiceProviderRegistry } from "../src/registry.ts";
import type { Availability, SttProvider, SttSession, SttStartOptions } from "../src/types.ts";

class StubStt implements SttProvider {
  constructor(
    readonly name: string,
    readonly kind: "local" | "cloud" | "fake",
    private readonly avail: Availability,
  ) {}
  async isAvailable(): Promise<Availability> {
    return this.avail;
  }
  start(_opts: SttStartOptions): SttSession {
    throw new Error("not used");
  }
}

const clock = new SimulatedClock(0);
const fake = new FakeStt({ clock, scripts: [{ final: "" }] });

describe("VoiceProviderRegistry", () => {
  it("nothing can run: the error keeps each provider's own reason (U-075)", async () => {
    // Talk on a PC without voice installed said only "no STT provider available"; the reason
    // that says what to do (local voice is off, run the install) was dropped here.
    const off =
      "local voice is off (voice profile none); turn it on in Settings -> Voice or with fr voice install --cpu (or --gpu)";
    const reg = new VoiceProviderRegistry()
      .registerStt(new StubStt("faster-whisper", "local", { ok: false, reason: off }))
      .registerStt(new StubStt("deepgram", "cloud", { ok: true, reason: "would be fine" }), {
        secretRef: "secret:deepgram_api_key",
      });
    const failed = await reg.selectStt({ hasSecret: () => false }).catch((e: unknown) => e);
    expect(failed).toMatchObject({ code: "unavailable" });
    const message = (failed as Error).message;
    expect(message).toContain("no STT provider available");
    expect(message).toContain(`faster-whisper: ${off}`);
    expect(message).toContain("deepgram: no value for secret:deepgram_api_key");
    // With nothing registered there is no reason to keep.
    await expect(new VoiceProviderRegistry().selectTts()).rejects.toThrow(
      /^no TTS provider available$/,
    );
  });

  it("prefers a local provider when it is available", async () => {
    const reg = new VoiceProviderRegistry()
      .registerStt(new StubStt("faster-whisper", "local", { ok: true, reason: "importable" }))
      .registerStt(new StubStt("deepgram", "cloud", { ok: true, reason: "key" }), {
        secretRef: "secret:deepgram",
      })
      .registerStt(fake);
    const sel = await reg.selectStt({ hasSecret: () => true });
    expect(sel.name).toBe("faster-whisper");
    expect(sel.policy).toBe("local");
    expect(sel.reason).toContain("importable");
    expect(sel.statuses.find((s) => s.name === "faster-whisper")?.selected).toBe(true);
  });

  it("falls back to cloud when local is unavailable and the key is configured", async () => {
    const reg = new VoiceProviderRegistry()
      .registerStt(new StubStt("faster-whisper", "local", { ok: false, reason: "no module" }))
      .registerStt(new StubStt("deepgram", "cloud", { ok: true, reason: "key configured" }), {
        secretRef: "secret:deepgram",
      })
      .registerStt(fake);
    const sel = await reg.selectStt({ hasSecret: (ref) => ref === "secret:deepgram" });
    expect(sel.name).toBe("deepgram");
    expect(sel.policy).toBe("cloud");
    expect(sel.reason).toMatch(/no local STT provider available/);
  });

  it("falls back to fake when there is no local provider and no key", async () => {
    const reg = new VoiceProviderRegistry()
      .registerStt(new StubStt("faster-whisper", "local", { ok: false, reason: "no module" }))
      .registerStt(new StubStt("deepgram", "cloud", { ok: true, reason: "would be fine" }), {
        secretRef: "secret:deepgram",
      })
      .registerStt(fake);
    const sel = await reg.selectStt({ hasSecret: () => false });
    expect(sel.name).toBe("fake-stt");
    expect(sel.policy).toBe("fake");
    expect(sel.reason).toMatch(/no cloud key configured/);
    const dg = sel.statuses.find((s) => s.name === "deepgram");
    expect(dg).toMatchObject({
      available: false,
      secretConfigured: false,
      reason: "no value for secret:deepgram",
    });
  });

  it("honours the Extensions choice when available and explains when it is not", async () => {
    const reg = new VoiceProviderRegistry()
      .registerStt(new StubStt("faster-whisper", "local", { ok: true, reason: "ok" }))
      .registerStt(new StubStt("deepgram", "cloud", { ok: true, reason: "ok" }), {
        secretRef: "secret:deepgram",
      });
    const chosen = await reg.selectStt({ preferred: "deepgram", hasSecret: () => true });
    expect(chosen).toMatchObject({ name: "deepgram", policy: "preferred" });
    expect(chosen.reason).toBe('"deepgram" selected in Extensions');
    // The caller names where the choice came from (the panel row, or an environment override).
    const byRow = await reg.selectStt({
      preferred: "deepgram",
      preferredBy: "selected in Extensions (voice-deepgram)",
      hasSecret: () => true,
    });
    expect(byRow.reason).toBe('"deepgram" selected in Extensions (voice-deepgram)');
    const missing = await reg.selectStt({ preferred: "whisper-cpp", hasSecret: () => true });
    expect(missing.name).toBe("faster-whisper");
    expect(missing.reason).toContain('preferred "whisper-cpp" is not registered');
    const down = await reg.selectStt({ preferred: "deepgram", hasSecret: () => false });
    expect(down.name).toBe("faster-whisper");
    expect(down.reason).toContain('preferred "deepgram" unavailable');
  });

  it("a provider the panel excludes is not probed, never picked by the fallback, and its status says why", async () => {
    // Spec O.4: a cloud row switched off in Extensions must not be reached for by the policy,
    // whatever key sits in the vault, and its key is never read (not even for the probe).
    let probed = 0;
    let asked = 0;
    const deepgram = new StubStt("deepgram", "cloud", { ok: true, reason: "key" });
    deepgram.isAvailable = async () => {
      probed += 1;
      return { ok: true, reason: "key" };
    };
    const hasSecret = () => {
      asked += 1;
      return true;
    };
    const excluded = [{ name: "deepgram", reason: "switched off in Extensions" }];
    const reg = new VoiceProviderRegistry()
      .registerStt(new StubStt("faster-whisper", "local", { ok: false, reason: "no module" }))
      .registerStt(deepgram, { secretRef: "secret:deepgram" })
      .registerStt(fake);
    const sel = await reg.selectStt({ excluded, hasSecret });
    expect(sel.name).toBe("fake-stt");
    expect(sel.policy).toBe("fake");
    expect(probed).toBe(0);
    expect(asked).toBe(0);
    expect(sel.statuses.find((s) => s.name === "deepgram")).toEqual({
      name: "deepgram",
      kind: "cloud",
      available: false,
      reason: "switched off in Extensions",
      secretRef: "secret:deepgram",
      selected: false,
    });
    // Without a fake nothing can serve: the excluded provider is not a way out.
    const strict = new VoiceProviderRegistry()
      .registerStt(new StubStt("faster-whisper", "local", { ok: false, reason: "no module" }))
      .registerStt(deepgram, { secretRef: "secret:deepgram" });
    await expect(strict.selectStt({ excluded, hasSecret })).rejects.toMatchObject({
      code: "unavailable",
    });
    const rows = await strict.statusStt({ excluded, hasSecret });
    expect(rows.find((s) => s.name === "deepgram")?.reason).toBe("switched off in Extensions");
    expect(probed).toBe(0);
    // Not excluded: the same registry falls back to it as before.
    const back = await strict.selectStt({ hasSecret });
    expect(back).toMatchObject({ name: "deepgram", policy: "cloud" });
    expect(probed).toBe(1);
  });

  it("throws unavailable when nothing can serve, and survives a throwing probe", async () => {
    const throwing = new StubStt("broken", "local", { ok: true, reason: "x" });
    throwing.isAvailable = async () => {
      throw new Error("boom");
    };
    const reg = new VoiceProviderRegistry().registerStt(throwing);
    await expect(reg.selectStt()).rejects.toMatchObject({ code: "unavailable" });
    const rows = await reg.statusStt();
    expect(rows[0]).toMatchObject({
      name: "broken",
      available: false,
      reason: "probe threw: boom",
    });
  });

  it("registers TTS the same way and replaces a provider by name", async () => {
    const reg = new VoiceProviderRegistry();
    reg.registerTts(new FakeTts({ clock, name: "fake-tts" }));
    reg.registerTts(new FakeTts({ clock, name: "fake-tts", available: false }));
    expect(reg.ttsNames()).toEqual(["fake-tts"]);
    await expect(reg.selectTts()).rejects.toMatchObject({ code: "unavailable" });
    reg.registerTts(new FakeTts({ clock, name: "fake-tts" }));
    expect((await reg.selectTts()).policy).toBe("fake");
    expect(reg.getTts("fake-tts")?.name).toBe("fake-tts");
  });
});
