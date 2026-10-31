import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";

/**
 * U-024: installing voice ended with "Unable to open file 'model.bin'" for speech recognition
 * although the download said "whisper ready". The model was fetched into the Hugging Face cache,
 * where `snapshots/<rev>/model.bin` is a link to a blob (a copy where Windows allows no links),
 * and a later run skipped a file whose snapshot entry existed, so a link the speech library
 * could not open, or a file an interrupted run left short, stayed broken on every retry.
 *
 * Now the model goes into a plain folder with real files (`download_model(..., output_dir=)`),
 * is checked after the download (no link, not empty, the size the Hub lists), and a broken one
 * is deleted and fetched once more before the install reports a failure; `fr_stt.py` loads it
 * from that folder and, on "Unable to open file", fetches it once more too. The real scripts
 * run here against stand-ins for faster_whisper and huggingface_hub: no network, no model.
 */

const python = ["python3", "python"].find((p) => spawnSync(p, ["-c", "import numpy"]).status === 0);
const helperDir = join(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "python",
);
/** A link that points nowhere can be made here (Windows needs a privilege for links). */
const canLink = (() => {
  const d = mkdtempSync(join(tmpdir(), "fr-link-"));
  try {
    symlinkSync(join(d, "nowhere"), join(d, "probe"));
    return true;
  } catch {
    return false;
  }
})();

/** What the stand-in Hub serves for the model: the bytes of model.bin and config.json. */
const MODEL = "MODEL-BYTES!"; // 12 bytes
const CONFIG = "{}";

const FAKE_UTILS = `
import json, os
_MODELS = {"base": "Systran/faster-whisper-base"}
MODEL = ${JSON.stringify(MODEL)}.encode()

def download_model(size_or_id, output_dir=None, **kwargs):
    count = os.environ["FR_FAKE_COUNT"]
    n = (int(open(count).read()) if os.path.exists(count) else 0) + 1
    open(count, "w").write(str(n))
    plan = os.environ.get("FR_FAKE_BROKEN", "")
    os.makedirs(output_dir, exist_ok=True)
    with open(os.path.join(output_dir, "config.json"), "w") as f:
        f.write(${JSON.stringify(CONFIG)})
    target = os.path.join(output_dir, "model.bin")
    if os.path.lexists(target):
        os.remove(target)
    broken = plan.startswith("always-") or (n == 1 and plan in ("link", "empty", "truncated"))
    kind = plan.replace("always-", "")
    if broken and kind == "link":
        os.symlink(os.path.join(output_dir, "..", "blobs", "gone"), target)
    elif broken and kind == "empty":
        open(target, "wb").close()
    elif broken and kind == "truncated":
        with open(target, "wb") as f:
            f.write(MODEL[:6])
    else:
        with open(target, "wb") as f:
            f.write(MODEL)
    return output_dir
`;

/** Like CTranslate2: a model folder whose model.bin cannot be read is "Unable to open file". */
const FAKE_FASTER_WHISPER = `
import json, os
from .utils import MODEL

class _Info:
    language = "en"

class _Inner:
    def __init__(self, device):
        self.device = device

class WhisperModel:
    def __init__(self, model_size_or_path, device="auto", compute_type="default"):
        with open(os.environ["FR_FAKE_LOADS"], "a") as f:
            f.write(json.dumps(model_size_or_path) + "\\n")
        path = model_size_or_path
        if os.path.isdir(path):
            try:
                with open(os.path.join(path, "model.bin"), "rb") as f:
                    data = f.read()
            except OSError:
                data = None
            if data != MODEL:
                raise RuntimeError("Unable to open file 'model.bin' in model '%s'" % path)
        elif os.environ.get("FR_FAKE_CACHE") == "broken":
            raise RuntimeError("Unable to open file 'model.bin' in model 'hub/snapshots/abc'")
        self.model = _Inner("cpu" if device == "auto" else device)

    def transcribe(self, audio, **kwargs):
        return iter(()), _Info()
`;

const FAKE_HUB = `
import os

class _Sibling:
    def __init__(self, name, size):
        self.rfilename = name
        self.size = size

class _Info:
    def __init__(self, siblings):
        self.siblings = siblings

class HfApi:
    def model_info(self, repo, files_metadata=False):
        if repo == "hexgrad/Kokoro-82M":
            return _Info([_Sibling("config.json", 1), _Sibling("kokoro-v1_0.pth", 1)])
        return _Info([_Sibling("model.bin", ${MODEL.length}), _Sibling("config.json", ${CONFIG.length})])

def hf_hub_download(repo_id, filename):
    path = os.path.join(os.environ["HF_HOME"], "hub", "kokoro", filename)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("k")
    return path
`;

interface World {
  models: string;
  /** The plain folder the speech model goes to. */
  dir: string;
  /** The old Hugging Face cache folder of the model (1.0.4's layout). */
  hubCache: string;
  env: NodeJS.ProcessEnv;
  downloads(): number;
  loads(): string[];
}

function world(env: Record<string, string> = {}): World {
  const root = mkdtempSync(join(tmpdir(), "fr-models-"));
  const site = join(root, "site");
  for (const [file, text] of [
    [join(site, "faster_whisper", "__init__.py"), FAKE_FASTER_WHISPER],
    [join(site, "faster_whisper", "utils.py"), FAKE_UTILS],
    [join(site, "huggingface_hub", "__init__.py"), FAKE_HUB],
    [join(site, "huggingface_hub", "constants.py"), 'import os\nHF_HOME = os.environ["HF_HOME"]\n'],
  ] as const) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const models = join(root, "voice", "models");
  mkdirSync(models, { recursive: true });
  const count = join(root, "downloads");
  const loads = join(root, "loads");
  writeFileSync(loads, "");
  return {
    models,
    dir: join(models, "faster-whisper", "base"),
    hubCache: join(models, "hub", "models--Systran--faster-whisper-base"),
    env: {
      ...process.env,
      PYTHONPATH: site,
      PYTHONDONTWRITEBYTECODE: "1",
      HF_HOME: models,
      FR_FAKE_COUNT: count,
      FR_FAKE_LOADS: loads,
      ...env,
    },
    downloads: () => (existsSync(count) ? Number(readFileSync(count, "utf8")) : 0),
    loads: () =>
      readFileSync(loads, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string),
  };
}

const lines = (stdout: string) =>
  stdout
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as { type: string; what?: string; message?: string });

function fetchModels(w: World) {
  return spawnSync(
    python as string,
    [
      join(helperDir, "fr_voice_models.py"),
      "--whisper",
      "base",
      "--whisper-dir",
      w.dir,
      "--kokoro-voice",
      "af_heart",
    ],
    { env: w.env, encoding: "utf8", timeout: 60_000 },
  );
}

function frame(kind: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(kind, 0);
  head.writeUInt32LE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/** The install's speech check: 0.5 s of silence, end of speech, close. */
function sttCheck(w: World) {
  return spawnSync(
    python as string,
    [
      join(helperDir, "fr_stt.py"),
      "--model",
      "base",
      "--model-dir",
      w.dir,
      "--device",
      "cpu",
      "--compute-type",
      "int8",
    ],
    {
      env: w.env,
      encoding: "utf8",
      timeout: 60_000,
      input: Buffer.concat([frame(0, Buffer.alloc(16000)), frame(1), frame(2)]),
    },
  );
}

const isPlainModel = (dir: string) => {
  const stat = lstatSync(join(dir, "model.bin"));
  return stat.isFile() && !stat.isSymbolicLink() && readFileSync(join(dir, "model.bin"), "utf8");
};

describe.skipIf(!python)("fr_voice_models.py: the speech model in a plain folder (U-024)", () => {
  for (const broken of ["link", "empty", "truncated"] as const) {
    it.skipIf(broken === "link" && !canLink)(
      `${broken === "link" ? "a link to nothing" : broken === "empty" ? "an empty file" : "a truncated file"} as model.bin: deleted, fetched once more, then ready`,
      () => {
        const w = world({ FR_FAKE_BROKEN: broken });
        const r = fetchModels(w);
        expect(r.status, r.stderr).toBe(0);
        const out = lines(r.stdout);
        const retry = out.filter((l) => l.type === "retry");
        expect(retry).toHaveLength(1);
        expect(retry[0]).toMatchObject({ what: "whisper" });
        expect(retry[0]?.message).toContain("model.bin");
        expect(out.some((l) => l.type === "done" && l.what === "whisper")).toBe(true);
        expect(out.some((l) => l.type === "error")).toBe(false);
        expect(w.downloads()).toBe(2);
        expect(isPlainModel(w.dir)).toBe(MODEL);
      },
    );
  }

  it("a good download is fetched once, recorded, and replaces 1.0.4's cache copy of the model", () => {
    const w = world();
    mkdirSync(join(w.hubCache, "snapshots", "abc"), { recursive: true });
    writeFileSync(join(w.hubCache, "snapshots", "abc", "model.bin"), MODEL);
    const r = fetchModels(w);
    expect(r.status, r.stderr).toBe(0);
    expect(lines(r.stdout).some((l) => l.type === "retry")).toBe(false);
    expect(w.downloads()).toBe(1);
    expect(isPlainModel(w.dir)).toBe(MODEL);
    // What the check found is kept beside it, so a later start can tell a short file offline.
    const manifest = JSON.parse(readFileSync(join(w.dir, "forerunner-model.json"), "utf8"));
    expect(manifest.files).toMatchObject({ "model.bin": MODEL.length, "config.json": 2 });
    expect(existsSync(w.hubCache)).toBe(false);
  });

  it("still broken after the second fetch: the install fails with the reason, after two fetches only", () => {
    const w = world({ FR_FAKE_BROKEN: "always-empty" });
    const r = fetchModels(w);
    expect(r.status).toBe(1);
    const error = lines(r.stdout).find((l) => l.type === "error" && l.what === "whisper");
    expect(error?.message).toContain("model.bin is empty");
    expect(w.downloads()).toBe(2);
  });
});

describe.skipIf(!python)(
  "fr_stt.py: loads the plain folder, and fetches it once more when it cannot be opened (U-024)",
  () => {
    const ready = (stdout: string) => lines(stdout).find((l) => l.type === "ready");
    const final = (stdout: string) => lines(stdout).find((l) => l.type === "final");

    it("loads the model from the plain folder", () => {
      const w = world();
      expect(fetchModels(w).status).toBe(0);
      const r = sttCheck(w);
      expect(r.status, r.stderr).toBe(0);
      expect(ready(r.stdout)).toBeDefined();
      expect(final(r.stdout)).toBeDefined();
      expect(w.loads()).toEqual([w.dir]);
      expect(w.downloads()).toBe(1);
    });

    for (const broken of ["link", "truncated"] as const) {
      it.skipIf(broken === "link" && !canLink)(
        `a ${broken === "link" ? "link to nothing" : "short file"} in the folder: fetched once more, then ready`,
        () => {
          const w = world();
          expect(fetchModels(w).status).toBe(0);
          const target = join(w.dir, "model.bin");
          writeFileSync(target, "");
          if (broken === "link") {
            rmSync(target);
            symlinkSync(join(w.dir, "nowhere"), target);
          } else writeFileSync(target, MODEL.slice(0, 6));
          const r = sttCheck(w);
          expect(r.status, r.stderr).toBe(0);
          expect(ready(r.stdout)).toBeDefined();
          expect(final(r.stdout)).toBeDefined();
          expect(r.stderr).toContain("fetching it once more");
          expect(w.downloads()).toBe(2);
          expect(isPlainModel(w.dir)).toBe(MODEL);
        },
      );
    }

    it("an install from before the plain folder keeps working from its good cache", () => {
      const w = world();
      const r = sttCheck(w);
      expect(r.status, r.stderr).toBe(0);
      expect(w.loads()).toEqual(["base"]);
      expect(w.downloads()).toBe(0);
    });

    it("an old cache that cannot be opened: fetched into the plain folder once, the broken copy dropped", () => {
      const w = world({ FR_FAKE_CACHE: "broken" });
      mkdirSync(join(w.hubCache, "snapshots", "abc"), { recursive: true });
      const r = sttCheck(w);
      expect(r.status, r.stderr).toBe(0);
      expect(ready(r.stdout)).toBeDefined();
      expect(w.loads()).toEqual(["base", w.dir]);
      expect(w.downloads()).toBe(1);
      expect(isPlainModel(w.dir)).toBe(MODEL);
      expect(existsSync(w.hubCache)).toBe(false);
    });

    it("a folder that still cannot be opened after the second fetch is reported, not fetched again", () => {
      const w = world({ FR_FAKE_BROKEN: "always-truncated" });
      mkdirSync(w.dir, { recursive: true });
      writeFileSync(join(w.dir, "model.bin"), "");
      writeFileSync(join(w.dir, "config.json"), CONFIG);
      const r = sttCheck(w);
      expect(r.status).toBe(4);
      const error = lines(r.stdout).find((l) => l.type === "error");
      expect(error?.message).toMatch(/^model load failed: /);
      expect(w.downloads()).toBe(1);
    });
  },
);
