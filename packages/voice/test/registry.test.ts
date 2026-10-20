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
    const missing = await reg.selectStt({ preferred: "whisper-cpp", hasSecret: () => true });
    expect(missing.name).toBe("faster-whisper");
    expect(missing.reason).toContain('preferred "whisper-cpp" is not registered');
    const down = await reg.selectStt({ preferred: "deepgram", hasSecret: () => false });
    expect(down.name).toBe("faster-whisper");
    expect(down.reason).toContain('preferred "deepgram" unavailable');
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
