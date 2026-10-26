import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";

const python = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);
const helperDir = join(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "python",
);

/**
 * faster-whisper with device "auto" picks CUDA wherever ctranslate2 sees an NVIDIA GPU, then
 * fails at the first transcription when cuBLAS is not installed ("Library cublas64_12.dll is
 * not found", the real-audio run of 2026-10-26 on Windows). The helper falls back to the CPU.
 */
describe.skipIf(!python)("fr_stt.py: a missing CUDA runtime falls back to the CPU", () => {
  const stub = (failAt: "load" | "transcribe") => {
    const dir = mkdtempSync(join(tmpdir(), "fr-stt-stub-"));
    writeFileSync(
      join(dir, "faster_whisper.py"),
      `
LOADS = []
class _Seg:
    text = " hello"
    start = 0.0
    end = 0.5
class _Info:
    language = "en"
class WhisperModel:
    def __init__(self, name, device="auto", compute_type="default"):
        LOADS.append((device, compute_type))
        self.device = device
        if device != "cpu" and ${JSON.stringify(failAt)} == "load":
            raise RuntimeError("CUDA failed with error no CUDA-capable device is detected")
    def transcribe(self, audio, **kw):
        def gen():
            if self.device != "cpu":
                raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
            yield _Seg()
        return gen(), _Info()
`,
    );
    return dir;
  };
  const run = (dir: string) =>
    spawnSync(
      python as string,
      [
        "-c",
        [
          "import sys, numpy",
          `sys.path.insert(0, ${JSON.stringify(dir)})`,
          `sys.path.insert(0, ${JSON.stringify(helperDir)})`,
          "import fr_stt, faster_whisper",
          "t = fr_stt.Transcriber('base', 'auto', 'default', None, 5)",
          "print(repr(t.run(numpy.zeros(1600, dtype=numpy.float32), 16000, True)))",
          "print(repr(faster_whisper.LOADS))",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

  it("at the first transcription: retried once on the CPU, the text comes back", () => {
    const r = run(stub("transcribe"));
    if (r.stderr.includes("No module named 'numpy'")) return; // numpy is the helper's own dependency
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("'hello'");
    expect(r.stdout).toContain("[('auto', 'default'), ('cpu', 'int8')]");
    expect(r.stderr).toMatch(/falling back to the CPU/);
  });

  it("at load: the CPU from the start", () => {
    const r = run(stub("load"));
    if (r.stderr.includes("No module named 'numpy'")) return;
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("'hello'");
    expect(r.stdout).toContain("[('auto', 'default'), ('cpu', 'int8')]");
  });
});
