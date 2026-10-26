import { readFileSync } from "node:fs";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HELPERS_DIR,
  parseRequirements,
  pipFile,
  pythonSpecAdmits,
  requirementsFile,
  requirementsSource,
  TORCH,
  torchFile,
  VOICE_PYTHON,
} from "../src/voice/install.ts";

/**
 * The voice profiles' pins (ADR 0090): PyTorch alone in torch-<profile>.txt, installed with
 * --no-deps from the PyTorch index; everything else, PyTorch's own dependencies included, in a
 * hashed universal lock from PyPI only; pip itself hashed. And every pinned distribution's
 * Requires-Python admits the Python the installer accepts (the table is recorded from the
 * index metadata by scripts/voice-lock.ts, so this runs offline).
 */
const read = (p: string) => readFileSync(p, "utf8");
const locks = {
  cpu: parseRequirements(read(requirementsFile("cpu", DEFAULT_HELPERS_DIR))),
  gpu: parseRequirements(read(requirementsFile("gpu", DEFAULT_HELPERS_DIR))),
};
const pin = (list: ReturnType<typeof parseRequirements>, name: string) =>
  list.find((r) => r.name === name);

describe("voice pins", () => {
  it("PyTorch alone per profile, exact and hashed for Windows and Linux", () => {
    for (const profile of ["cpu", "gpu"] as const) {
      const text = read(torchFile(profile, DEFAULT_HELPERS_DIR));
      expect(text).not.toMatch(/^\s*--(extra-)?index-url/m);
      const reqs = parseRequirements(text);
      expect(reqs).toHaveLength(1);
      expect(reqs[0]).toMatchObject({ name: "torch", version: TORCH[profile].version });
      expect(reqs[0]?.hashes.length).toBeGreaterThanOrEqual(2);
    }
    expect(TORCH.cpu).toEqual({
      version: "2.11.0+cpu",
      index: "https://download.pytorch.org/whl/cpu",
    });
    expect(TORCH.gpu).toEqual({
      version: "2.11.0+cu128",
      index: "https://download.pytorch.org/whl/cu128",
    });
  });

  it("the rest is a hashed lock from PyPI only, without torch, with torch's own dependencies", () => {
    for (const profile of ["cpu", "gpu"] as const) {
      const text = read(requirementsFile(profile, DEFAULT_HELPERS_DIR));
      expect(text).not.toMatch(/^\s*--(extra-index-url|index-url|find-links|trusted-host)/m);
      const list = locks[profile];
      expect(list.length).toBeGreaterThan(50);
      for (const r of list) {
        expect(r.hashes.length, r.name).toBeGreaterThan(0);
        expect(r.version ?? r.url, r.name).toBeTruthy();
      }
      expect(pin(list, "torch")).toBeUndefined();
      for (const [name, version] of [
        ["faster-whisper", "1.2.1"],
        ["ctranslate2", "4.8.3"],
        ["kokoro", "0.9.4"],
        ["misaki", "0.9.4"],
        ["numpy", "2.5.4"],
        ["soundfile", "0.14.0"],
        ["transformers", "5.20.2"],
        ["huggingface-hub", "2.3.0"],
      ])
        expect(pin(list, name as string)?.version, name).toBe(version);
      // torch's own Requires-Dist, which --no-deps leaves to the lock.
      for (const name of ["sympy", "networkx", "jinja2", "fsspec", "filelock", "setuptools"])
        expect(pin(list, name), name).toBeDefined();
      const spacy = pin(list, "en-core-web-sm");
      expect(spacy?.url).toMatch(/en_core_web_sm-3\.8\.0-py3-none-any\.whl#sha256=[0-9a-f]{64}$/);
    }
    const cpuCuda = locks.cpu.filter((r) => /^(nvidia-|cuda-|triton$)/.test(r.name));
    expect(cpuCuda).toEqual([]);
    expect(pin(locks.gpu, "nvidia-cublas-cu12")?.version).toBe("12.8.4.1");
    expect(pin(locks.gpu, "nvidia-cudnn-cu12")?.version).toBe("9.19.0.56");
    expect(pin(locks.gpu, "triton")?.marker).toMatch(/linux/);
  });

  it("every exact pin of the sources is in its lock at that version", () => {
    for (const profile of ["cpu", "gpu"] as const) {
      const sources = parseRequirements(read(requirementsSource(profile, DEFAULT_HELPERS_DIR)));
      for (const s of sources.filter((r) => r.exact))
        expect(pin(locks[profile], s.name)?.version, s.name).toBe(s.version);
    }
  });

  it("pip itself is pinned and hashed", () => {
    const reqs = parseRequirements(read(pipFile(DEFAULT_HELPERS_DIR)));
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ name: "pip", version: "26.2.2" });
    expect(reqs[0]?.hashes.length).toBeGreaterThan(0);
  });

  it("every pinned distribution admits the Python the installer accepts (3.12)", () => {
    expect(VOICE_PYTHON).toEqual({ min: [3, 12], below: [3, 13] });
    const table = JSON.parse(read(join(DEFAULT_HELPERS_DIR, "requires-python.json"))) as Record<
      string,
      string | null
    >;
    const all = [
      ...locks.cpu,
      ...locks.gpu,
      ...parseRequirements(read(torchFile("cpu", DEFAULT_HELPERS_DIR))),
      ...parseRequirements(read(torchFile("gpu", DEFAULT_HELPERS_DIR))),
      ...parseRequirements(read(pipFile(DEFAULT_HELPERS_DIR))),
    ].filter((r) => r.version);
    expect(all.length).toBeGreaterThan(100);
    const refused: string[] = [];
    for (const r of all) {
      const key = `${r.name}==${r.version}`;
      expect(table, key).toHaveProperty([key]);
      const spec = table[key] ?? "";
      for (const v of ["3.12.0", "3.12.12"])
        if (!pythonSpecAdmits(spec, v)) refused.push(`${key} (${spec}) ${v}`);
    }
    expect(refused).toEqual([]);
    // The reason the minimum is 3.12: numpy 2.5 needs it.
    expect(table["numpy==2.5.4"]).toBe(">=3.12");
  });

  it("evaluates Requires-Python specifiers", () => {
    expect(pythonSpecAdmits(">=3.12", "3.11.9")).toBe(false);
    expect(pythonSpecAdmits(">=3.12", "3.12.0")).toBe(true);
    expect(pythonSpecAdmits("<3.13,>=3.10", "3.12.3")).toBe(true);
    expect(pythonSpecAdmits("<3.13,>=3.10", "3.13.0")).toBe(false);
    expect(pythonSpecAdmits(">=3.10.0", "3.12.1")).toBe(true);
    expect(pythonSpecAdmits("!=3.12.*,>=3.9", "3.12.4")).toBe(false);
    expect(pythonSpecAdmits("~=3.12", "3.12.7")).toBe(true);
    expect(pythonSpecAdmits("~=3.11.0", "3.12.0")).toBe(false);
    expect(pythonSpecAdmits("", "3.12.0")).toBe(true);
    expect(pythonSpecAdmits(">=3", "3.12.0")).toBe(true);
  });
});
