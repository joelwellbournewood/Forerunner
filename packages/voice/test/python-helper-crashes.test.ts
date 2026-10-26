import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";

const python = ["python3", "python"].find((p) => spawnSync(p, ["-c", "import numpy"]).status === 0);
const helperDir = join(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "python",
);

/** A Python module that faults in native code: reading address 0 through ctypes. */
const FAULT = "import ctypes\n        ctypes.string_at(0)";
/** What Python's faulthandler writes when native code faults: POSIX, then Windows. */
const FAULT_HEADER =
  /Fatal Python error: Segmentation fault|Windows fatal exception: access violation/;

function stubDir(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-fault-"));
  writeFileSync(join(dir, name), source);
  return dir;
}

function runHelper(script: string, args: string[], stubs: string, input: Buffer) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: stubs,
    PYTHONDONTWRITEBYTECODE: "1",
  };
  // The helper must turn faulthandler on itself, not rely on the environment.
  delete env.PYTHONFAULTHANDLER;
  return spawnSync(python as string, [join(helperDir, script), ...args], {
    input,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function frame(kind: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(kind, 0);
  head.writeUInt32LE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/**
 * The GPU run of 2026-10-26: fr_stt.py died with 0xC0000005 twice on the first utterance and
 * left no stack at all. With faulthandler on, a fault in native code writes the Python
 * traceback of every thread to stderr before the process dies, which the Node side now keeps
 * (the stderr tail in the crash warning and the turn's error details).
 */
describe.skipIf(!python)("the Python helpers write a traceback when native code faults", () => {
  it("fr_stt.py: a fault inside transcribe() names the helper's frames on stderr", () => {
    const stubs = stubDir(
      "faster_whisper.py",
      `
class WhisperModel:
    def __init__(self, name, device="auto", compute_type="default"):
        self.device = device
    def transcribe(self, audio, **kw):
        ${FAULT}
`,
    );
    const input = Buffer.concat([frame(3), frame(0, Buffer.alloc(3200)), frame(1), frame(2)]);
    const r = runHelper("fr_stt.py", ["--device", "cpu", "--model", "stub"], stubs, input);
    expect(r.stdout).toContain('"type": "ready"');
    expect(r.status === 0, r.stderr).toBe(false);
    expect(r.stderr).toMatch(FAULT_HEADER);
    expect(r.stderr).toMatch(/fr_stt\.py", line \d+ in _run/);
    expect(r.stderr).toMatch(/fr_stt\.py", line \d+ in main/);
  });

  it("fr_tts.py: a fault while the Kokoro pipeline loads names the helper's frames on stderr", () => {
    const stubs = stubDir(
      "kokoro.py",
      `
class KPipeline:
    def __init__(self, lang_code=None, repo_id=None, device=None):
        ${FAULT}
`,
    );
    const r = runHelper("fr_tts.py", ["--device", "cpu"], stubs, frame(2));
    expect(r.status === 0, r.stderr).toBe(false);
    expect(r.stderr).toMatch(FAULT_HEADER);
    expect(r.stderr).toMatch(/fr_tts\.py", line \d+ in _pipeline/);
  });
});

/**
 * What fr_stt.py hands to native code, checked so a later change cannot quietly break it: the
 * candidates for an access violation that live in the helper itself are a buffer native code
 * reads while Python changes or frees it, and two native calls at once. Every transcription
 * runs on the main thread, and each gets its own float32 array, which later audio never
 * touches (a view onto the growing utterance buffer would be changed under it).
 */
describe.skipIf(!python)("fr_stt.py: what native code is handed", () => {
  it("one thread for every transcription, each on its own array that later audio leaves alone", () => {
    const stubs = stubDir(
      "faster_whisper.py",
      `
import json, os, threading
CALLS = []
class _Info:
    language = "en"
class WhisperModel:
    def __init__(self, name, device="auto", compute_type="default"):
        pass
    def transcribe(self, audio, **kw):
        CALLS.append((audio, audio.copy(), threading.current_thread() is threading.main_thread()))
        with open(os.environ["FR_STUB_OUT"], "w") as f:
            json.dump([
                {"main": main, "unchanged": bool((a == c).all()), "own": a.base is None,
                 "dtype": a.dtype.name, "samples": int(a.shape[0])}
                for a, c, main in CALLS
            ], f)
        return iter(()), _Info()
`,
    );
    const out = join(stubs, "calls.json");
    const ramp = (n: number, offset: number) => {
      const b = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) b.writeInt16LE(((i + offset) % 2000) - 1000, i * 2);
      return b;
    };
    // Two utterances: a final each (and partials when the reader has nothing queued).
    const input = Buffer.concat([
      frame(3),
      frame(0, ramp(16000, 0)),
      frame(0, ramp(16000, 7)),
      frame(1),
      frame(3),
      frame(0, ramp(8000, 3)),
      frame(1),
      frame(2),
    ]);
    const env: NodeJS.ProcessEnv = { ...process.env, FR_STUB_OUT: out };
    const r = spawnSync(
      python as string,
      [join(helperDir, "fr_stt.py"), "--device", "cpu", "--model", "stub"],
      { input, env: { ...env, PYTHONPATH: stubs, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    const calls = JSON.parse(readFileSync(out, "utf8")) as Array<{
      main: boolean;
      unchanged: boolean;
      own: boolean;
      dtype: string;
      samples: number;
    }>;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // The finals: the whole first utterance, then only the second (the reset dropped the first).
    expect(calls.map((c) => c.samples).slice(-2)).toEqual([32000, 8000]);
    for (const c of calls)
      expect(c).toEqual({ ...c, main: true, unchanged: true, own: true, dtype: "float32" });
  });
});

/**
 * The retry of a crashed utterance decodes differently (the same audio with the same settings
 * crashed twice on 2026-10-26): the Node side sends a decode frame (kind 4, JSON) after the
 * reset, and fr_stt.py uses it for that utterance only, partials and final.
 */
describe.skipIf(!python)("fr_stt.py: a decode frame sets the options of one utterance", () => {
  it("greedy at temperature 0 for the retried utterance; the next utterance decodes as usual", () => {
    const stubs = stubDir(
      "faster_whisper.py",
      `
import json, os
CALLS = []
class _Info:
    language = "en"
class WhisperModel:
    def __init__(self, name, device="auto", compute_type="default"):
        pass
    def transcribe(self, audio, **kw):
        CALLS.append({"samples": int(audio.shape[0]), "beam_size": kw.get("beam_size"),
                      "temperature": kw.get("temperature", "default")})
        with open(os.environ["FR_STUB_OUT"], "w") as f:
            json.dump(CALLS, f)
        return iter(()), _Info()
`,
    );
    const out = join(stubs, "calls.json");
    const decode = Buffer.from(JSON.stringify({ beam_size: 1, temperature: [0] }), "utf8");
    const input = Buffer.concat([
      frame(3),
      frame(4, decode),
      frame(0, Buffer.alloc(3200)),
      frame(1),
      frame(3),
      frame(0, Buffer.alloc(1600)),
      frame(1),
      frame(2),
    ]);
    const r = spawnSync(
      python as string,
      [join(helperDir, "fr_stt.py"), "--device", "cpu", "--model", "stub", "--beam-size", "5"],
      {
        input,
        env: { ...process.env, FR_STUB_OUT: out, PYTHONPATH: stubs, PYTHONDONTWRITEBYTECODE: "1" },
        encoding: "utf8",
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const calls = JSON.parse(readFileSync(out, "utf8")) as unknown[];
    expect(calls).toEqual([
      { samples: 1600, beam_size: 1, temperature: [0] },
      { samples: 800, beam_size: 5, temperature: "default" },
    ]);
  });

  it("parse_decode refuses temperatures that are not finite numbers >= 0", () => {
    // Python's json reads NaN, Infinity and -Infinity; none is a temperature.
    const cases = [
      '{"temperature": NaN}',
      '{"temperature": [0, Infinity]}',
      '{"temperature": -Infinity}',
      '{"temperature": [-0.5]}',
      '{"temperature": []}',
      '{"temperature": [true]}',
      '{"beam_size": 0}',
      '{"beam_size": 1.5}',
      '{"best_of": 2}',
      "[1]",
    ];
    const r = spawnSync(
      python as string,
      [
        "-c",
        [
          "import json, sys",
          `sys.path.insert(0, ${JSON.stringify(helperDir)})`,
          "import fr_stt",
          `cases = json.loads(${JSON.stringify(JSON.stringify(cases))})`,
          "out = []",
          "for c in cases:",
          "    try:",
          "        fr_stt.parse_decode(c.encode('utf-8'))",
          "        out.append('accepted')",
          "    except ValueError:",
          "        out.append('refused')",
          'out.append(json.dumps(fr_stt.parse_decode(b\'{"beam_size": 1, "temperature": [0, 0.2]}\')))',
          "out.append(json.dumps(fr_stt.parse_decode(b'{\"temperature\": 0}')))",
          "print(json.dumps(out))",
        ].join("\n"),
      ],
      { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
    );
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as string[];
    expect(out.slice(0, cases.length)).toEqual(cases.map(() => "refused"));
    expect(out.slice(cases.length)).toEqual([
      '{"beam_size": 1, "temperature": [0.0, 0.2]}',
      '{"temperature": 0.0}',
    ]);
  });
});
