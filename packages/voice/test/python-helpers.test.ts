import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, run } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { DEFAULT_STT_HELPER } from "../src/providers/local/faster-whisper.ts";
import { FrameReader, TTS_OUT } from "../src/providers/local/framing.ts";
import { DEFAULT_TTS_HELPER } from "../src/providers/local/kokoro.ts";
import { findPython } from "../src/providers/local/python.ts";

const python = await findPython();

describe("bundled Python helpers", () => {
  it("resolve to files inside the package", () => {
    expect(DEFAULT_STT_HELPER).toBe(fileURLToPath(new URL("../python/fr_stt.py", import.meta.url)));
    expect(DEFAULT_TTS_HELPER).toBe(fileURLToPath(new URL("../python/fr_tts.py", import.meta.url)));
  });

  it.skipIf(python === null)("compile with py_compile", async () => {
    const py = python as string;
    // py_compile with an explicit cache file in a temp dir, so no __pycache__ lands in the repo.
    const dir = await mkdtemp(join(tmpdir(), "fr-pyc-"));
    const code = [
      "import py_compile, sys",
      "for i, f in enumerate(sys.argv[2:]):",
      '    py_compile.compile(f, cfile=sys.argv[1] + str(i) + ".pyc", doraise=True)',
    ].join("\n");
    const r = await run(
      [
        py,
        "-c",
        code,
        join(dir, "helper"),
        DEFAULT_STT_HELPER,
        DEFAULT_TTS_HELPER,
        // The voice install's model fetcher (ADR 0090) runs in the same interpreter.
        fileURLToPath(new URL("../python/fr_voice_models.py", import.meta.url)),
      ],
      { allowFailure: true, timeoutMs: 30_000 },
    );
    await rm(dir, { recursive: true, force: true });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  it.skipIf(python === null)("answer --selftest without loading a model", async () => {
    const py = python as string;
    const stt = await run([py, DEFAULT_STT_HELPER, "--selftest"], { timeoutMs: 30_000 });
    expect(JSON.parse(stt.stdout.trim())).toMatchObject({ type: "ready", selftest: true });

    const tts = await run([py, DEFAULT_TTS_HELPER, "--selftest"], { timeoutMs: 30_000 });
    const frames = new FrameReader().push(Buffer.from(tts.stdout, "utf8"));
    expect(frames[0]?.kind).toBe(TTS_OUT.ready);
    expect(JSON.parse(frames[0]?.payload.toString("utf8") ?? "{}")).toMatchObject({
      sample_rate: 24000,
    });
  });
});
