import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";

const python = ["python3", "python"].find((p) => spawnSync(p, ["-c", "import numpy"]).status === 0);
const helperDir = join(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "python",
);

const py = (lines: string[], extraPath: string[] = []) =>
  spawnSync(
    python as string,
    [
      "-c",
      [
        "import sys",
        ...[...extraPath, helperDir].map((d) => `sys.path.insert(0, ${JSON.stringify(d)})`),
        ...lines,
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );

/** A fake site-packages with the NVIDIA wheels' layout (bin on Windows, lib on Linux). */
function fakeSite(): string {
  const site = mkdtempSync(join(tmpdir(), "fr-site-"));
  for (const pkg of ["cublas", "cudnn"]) {
    mkdirSync(join(site, "nvidia", pkg, "bin"), { recursive: true });
    mkdirSync(join(site, "nvidia", pkg, "lib"), { recursive: true });
  }
  writeFileSync(join(site, "nvidia", "cublas", "bin", "cublas64_12.dll"), "");
  writeFileSync(join(site, "nvidia", "cublas", "lib", "libcublas.so.12"), "");
  writeFileSync(join(site, "nvidia", "cublas", "lib", "libcublasLt.so.12"), "");
  writeFileSync(join(site, "nvidia", "cudnn", "lib", "libcudnn.so.9"), "");
  writeFileSync(join(site, "nvidia", "cudnn", "lib", "libcudnn_ops.so.9"), "");
  writeFileSync(join(site, "nvidia", "cudnn", "lib", "README.txt"), "");
  return site;
}

/**
 * pip puts the CUDA 12 libraries of nvidia-cublas-cu12 / nvidia-cudnn-cu12 under
 * site-packages/nvidia/<pkg>/bin (Windows) or /lib (Linux), on no search path: ctranslate2 then
 * fails with "Library cublas64_12.dll is not found or cannot be loaded" (the human's PC,
 * 2026-10-26). fr_stt.py makes them loadable before faster_whisper is imported.
 */
describe.skipIf(!python)("fr_stt.py: the NVIDIA wheels' libraries are made loadable", () => {
  it("Windows: every nvidia/*/bin folder goes to add_dll_directory and first on PATH", () => {
    const site = fakeSite();
    const r = py([
      "import fr_stt",
      "added = []",
      "env = {'PATH': 'system32'}",
      `dirs = fr_stt.setup_cuda_libraries(site_dirs=[${JSON.stringify(site)}], platform='win32', add_dll_directory=added.append, environ=env)`,
      "import json, os",
      "print(json.dumps({'dirs': dirs, 'added': added, 'path': env['PATH'].split(os.pathsep)}))",
    ]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as { dirs: string[]; added: string[]; path: string[] };
    const bins = [join(site, "nvidia", "cublas", "bin"), join(site, "nvidia", "cudnn", "bin")];
    expect(out.dirs).toEqual(bins);
    expect(out.added).toEqual(bins);
    expect(out.path).toEqual([...bins, "system32"]);
  });

  it("Linux: cuBLAS and the cuDNN loader are preloaded by absolute path", () => {
    const site = fakeSite();
    const r = py([
      "import fr_stt, json",
      "loaded = []",
      `fr_stt.setup_cuda_libraries(site_dirs=[${JSON.stringify(site)}], platform='linux', preload=loaded.append)`,
      "print(json.dumps(loaded))",
    ]);
    expect(r.status, r.stderr).toBe(0);
    const loaded = JSON.parse(r.stdout.trim()) as string[];
    expect(loaded.map((p) => p.slice(site.length + 1).replace(/\\/g, "/")).sort()).toEqual([
      "nvidia/cublas/lib/libcublas.so.12",
      "nvidia/cublas/lib/libcublasLt.so.12",
      "nvidia/cudnn/lib/libcudnn.so.9",
    ]);
  });

  it("does nothing without the wheels", () => {
    const empty = mkdtempSync(join(tmpdir(), "fr-site-empty-"));
    const r = py([
      "import fr_stt",
      "env = {'PATH': 'x'}",
      `print(fr_stt.setup_cuda_libraries(site_dirs=[${JSON.stringify(empty)}], platform='win32', add_dll_directory=lambda d: 1/0, environ=env), env['PATH'])`,
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("[] x");
  });
});

/** A stub faster_whisper whose non-CPU devices fail like a missing cuBLAS. */
function whisperStub(): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-stt-gpu-stub-"));
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
class _Inner:
    def __init__(self, device):
        self.device = device
class WhisperModel:
    def __init__(self, name, device="auto", compute_type="default"):
        LOADS.append((device, compute_type))
        self.model = _Inner(device)
    def transcribe(self, audio, **kw):
        def gen():
            if self.model.device != "cpu":
                raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
            yield _Seg()
        return gen(), _Info()
`,
  );
  return dir;
}

describe.skipIf(!python)("fr_stt.py: the gpu profile's device handling", () => {
  it("an explicit cuda with cpu_fallback falls back loudly, at load when warmed", () => {
    const r = py(
      [
        "import fr_stt, faster_whisper",
        "t = fr_stt.Transcriber('base', 'cuda', 'float16', None, 5, cpu_fallback=True, warm=True)",
        "print(faster_whisper.LOADS)",
        "print(t.resolved_device(), t.compute_type)",
        "print(t.fallback)",
      ],
      [whisperStub()],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n").slice(0, 3)).toEqual([
      "[('cuda', 'float16'), ('cpu', 'int8')]",
      "cpu int8",
      "Library cublas64_12.dll is not found or cannot be loaded",
    ]);
    expect(r.stderr).toMatch(/CUDA failed on device cuda: .*falling back to the CPU/);
  });

  it("an explicit cuda without cpu_fallback still raises (the install's GPU check)", () => {
    const r = py(
      [
        "import fr_stt",
        "try:\n    fr_stt.Transcriber('base', 'cuda', 'float16', None, 5, warm=True)\n    print('no error')\nexcept RuntimeError as e:\n    print('raised', e)",
      ],
      [whisperStub()],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("raised Library cublas64_12.dll is not found or cannot be loaded");
  });

  it("the CPU is never warmed and reports its device", () => {
    const r = py(
      [
        "import fr_stt, faster_whisper",
        "t = fr_stt.Transcriber('base', 'cpu', 'int8', None, 5, warm=True)",
        "print(faster_whisper.LOADS, t.resolved_device(), t.fallback)",
      ],
      [whisperStub()],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("[('cpu', 'int8')] cpu None");
  });
});

/** A stub kokoro whose KPipeline fails on cuda as Kokoro does on a CPU-only torch. */
function kokoroStub(): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-tts-gpu-stub-"));
  writeFileSync(
    join(dir, "kokoro.py"),
    `
CALLS = []
class _Param:
    def __init__(self, device):
        class _D:
            pass
        self.device = _D()
        self.device.type = device
class _Model:
    def __init__(self, device):
        self._device = device
    def parameters(self):
        yield _Param(self._device)
class KPipeline:
    def __init__(self, lang_code, repo_id=None, device=None):
        CALLS.append((lang_code, repo_id, device))
        if device == "cuda":
            raise RuntimeError("CUDA requested but not available")
        self.model = _Model(device or "cpu")
`,
  );
  return dir;
}

describe.skipIf(!python)("fr_tts.py: the device Kokoro runs on", () => {
  it("cuda with cpu_fallback falls back loudly and reports the CPU", () => {
    const r = py(
      [
        "import fr_tts, kokoro",
        "e = fr_tts.KokoroEngine('a', 'af_heart', device='cuda', cpu_fallback=True)",
        "print(kokoro.CALLS)",
        "print(e.device, e.fallback)",
      ],
      [kokoroStub()],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n").slice(0, 2)).toEqual([
      "[('a', 'hexgrad/Kokoro-82M', 'cuda'), ('a', 'hexgrad/Kokoro-82M', 'cpu')]",
      "cpu CUDA requested but not available",
    ]);
    expect(r.stderr).toMatch(/CUDA failed.*falling back to the CPU/);
  });

  it("cuda without cpu_fallback raises; auto leaves the choice to Kokoro", () => {
    const r = py(
      [
        "import fr_tts, kokoro",
        "try:\n    fr_tts.KokoroEngine('a', 'af_heart', device='cuda')\n    print('no error')\nexcept RuntimeError as e:\n    print('raised', e)",
        "e = fr_tts.KokoroEngine('a', 'af_heart')",
        "print(kokoro.CALLS[-1], e.device, e.fallback)",
      ],
      [kokoroStub()],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n").slice(0, 2)).toEqual([
      "raised CUDA requested but not available",
      "('a', 'hexgrad/Kokoro-82M', None) cpu None",
    ]);
  });
});

/**
 * A stub kokoro that loads on cuda but fails at the first synthesis there, as a GPU without a
 * usable cuBLAS does (torch loads it lazily at the first matmul).
 */
function kokoroSynthStub(): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-tts-synth-stub-"));
  writeFileSync(
    join(dir, "kokoro.py"),
    `
CALLS = []
SYNTHS = []
class _Param:
    def __init__(self, device):
        class _D:
            pass
        self.device = _D()
        self.device.type = device
class _Model:
    def __init__(self, device):
        self._device = device
    def parameters(self):
        yield _Param(self._device)
class KPipeline:
    def __init__(self, lang_code, repo_id=None, device=None):
        CALLS.append(device)
        self.device = device or "cpu"
        self.model = _Model(self.device)
    def __call__(self, text, voice=None, speed=1.0):
        SYNTHS.append((self.device, text))
        if self.device == "cuda":
            raise RuntimeError("CUBLAS_STATUS_NOT_INITIALIZED when calling cublasCreate(handle)")
        yield None, None, [0.0, 0.1, -0.1]
`,
  );
  return dir;
}

describe.skipIf(!python)("fr_tts.py: warming Kokoro on the GPU", () => {
  it("a CUDA error at the first synthesis falls back loudly with --cpu-fallback when warmed", () => {
    const r = py(
      [
        "import fr_tts, kokoro",
        "e = fr_tts.KokoroEngine('a', 'af_heart', device='cuda', cpu_fallback=True, warm=True)",
        "print(kokoro.CALLS)",
        "print(e.device, e.fallback)",
        "print(len(kokoro.SYNTHS))",
      ],
      [kokoroSynthStub()],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n").slice(0, 3)).toEqual([
      "['cuda', 'cpu']",
      "cpu CUBLAS_STATUS_NOT_INITIALIZED when calling cublasCreate(handle)",
      "1",
    ]);
    expect(r.stderr).toMatch(/CUDA failed.*falling back to the CPU/);
  });

  it("without --cpu-fallback the warm-up error is raised; the CPU is never warmed", () => {
    const r = py(
      [
        "import fr_tts, kokoro",
        "try:\n    fr_tts.KokoroEngine('a', 'af_heart', device='cuda', warm=True)\n    print('no error')\nexcept RuntimeError as e:\n    print('raised', e)",
        "kokoro.SYNTHS.clear()",
        "e = fr_tts.KokoroEngine('a', 'af_heart', device='cpu', warm=True)",
        "print(e.device, len(kokoro.SYNTHS))",
      ],
      [kokoroSynthStub()],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n").slice(0, 2)).toEqual([
      "raised CUBLAS_STATUS_NOT_INITIALIZED when calling cublasCreate(handle)",
      "cpu 0",
    ]);
  });
});
