import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { FasterWhisperStt } from "../src/providers/local/faster-whisper.ts";
import { KokoroTts } from "../src/providers/local/kokoro.ts";
import type { SttEvent } from "../src/types.ts";

/**
 * A disposed local provider never starts its helper again (ADR 0090): the voice profile swap
 * disposes the old pair, and a session still holding the old provider must not respawn a
 * helper from the old venv. The "helper" here only records that it ran.
 */
const node = process.execPath;

function spyHelper(): { path: string; ran: string } {
  const dir = mkdtempSync(join(tmpdir(), "fr-disposed-"));
  const ran = join(dir, "ran");
  const path = join(dir, "helper.mjs");
  writeFileSync(
    path,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ran)}, "1");`,
  );
  return { path, ran };
}

describe("disposed local providers", () => {
  it("faster-whisper: a session started after dispose ends with an error and spawns nothing", async () => {
    const helper = spyHelper();
    const stt = new FasterWhisperStt({
      python: node,
      helperPath: helper.path,
      readyTimeoutMs: 2000,
    });
    await stt.dispose();
    const session = stt.start({ sampleRate: 16000 });
    const events: SttEvent[] = [];
    for await (const e of session.events) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "unavailable" });
    expect(events[0]?.type === "error" ? events[0].message : "").toMatch(/disposed/);
    session.push({ pcm: new Int16Array(160), sampleRate: 16000, channels: 1, timestampMs: 0 });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(helper.ran)).toBe(false);
  });

  it("kokoro: synthesize after dispose fails and spawns nothing", async () => {
    const helper = spyHelper();
    const tts = new KokoroTts({ python: node, helperPath: helper.path, readyTimeoutMs: 2000 });
    await tts.dispose();
    const run = async () => {
      for await (const _ of tts.synthesize("Hello.")) {
        // no audio expected
      }
    };
    await expect(run()).rejects.toThrow(/disposed/);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(helper.ran)).toBe(false);
  });
});
