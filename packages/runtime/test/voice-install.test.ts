import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type AppDirs, appDirs, dirname, join, SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  buildToolsFile,
  DEFAULT_HELPERS_DIR,
  detectNvidiaGpu,
  findBasePython,
  installVoice,
  PYPI_INDEX,
  parseVoiceProfileAnswer,
  pipFile,
  readVoiceSettings,
  recommendedProfile,
  removeVoice,
  requirementsFile,
  SOURCE_BUILDS,
  torchFile,
  VOICE_PROFILE_QUESTION,
  venvPythonPath,
  voiceDirs,
  writeVoiceSettings,
} from "../src/voice/install.ts";
import type { VoiceInstallEvent } from "../src/voice/install-types.ts";
import { fakeRunner, NVIDIA } from "./voice-install-helpers.ts";

/**
 * `fr voice install` / `fr voice remove` and the Settings → Voice switch (ADR 0090): a managed
 * venv per profile under the data directory, the pinned requirements file of the profile, the
 * models fetched with progress, then the helpers run on the profile's device to verify. Every
 * process goes through a runner; here a fake one answers like Python, pip and the helpers do.
 */

function home(): { dirs: AppDirs; env: NodeJS.ProcessEnv } {
  const h = mkdtempSync(join(tmpdir(), "fr-voice-install-"));
  const env = { FORERUNNER_HOME: h };
  return { dirs: appDirs({ env }), env };
}

const collect = () => {
  const events: VoiceInstallEvent[] = [];
  return { events, out: (e: VoiceInstallEvent) => events.push(e) };
};
const messages = (events: VoiceInstallEvent[], type: VoiceInstallEvent["type"]) =>
  events.filter((e) => e.type === type).map((e) => ("message" in e ? e.message : ""));

describe("fr voice install", () => {
  it("cpu: makes the venv, installs the cpu list, fetches the models, verifies on the CPU", async () => {
    const { dirs, env } = home();
    const fake = fakeRunner();
    const { events, out } = collect();
    const r = await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run: fake.run,
      out,
      clock: new SimulatedClock("2026-10-26T10:00:00Z"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(true);
    const vd = voiceDirs(dirs);
    const venvPy = venvPythonPath(vd.venv("cpu"), "linux");
    const pipRun = (file: string) => fake.calls.find((c) => c.argv.includes(file));
    // pip itself from its hashed pin, then torch alone from the PyTorch index without its
    // dependencies, then the hashed lock from PyPI only, then pip check.
    const pipSelf = pipRun(pipFile(DEFAULT_HELPERS_DIR));
    expect(pipSelf?.argv).toEqual(
      expect.arrayContaining(["--require-hashes", "--index-url", PYPI_INDEX]),
    );
    const torch = pipRun(torchFile("cpu", DEFAULT_HELPERS_DIR));
    expect(torch?.argv[0]).toBe(venvPy);
    expect(torch?.argv).toEqual(
      expect.arrayContaining([
        "--no-deps",
        "--require-hashes",
        "--index-url",
        "https://download.pytorch.org/whl/cpu",
        "--progress-bar",
        "raw",
      ]),
    );
    expect(torch?.argv).not.toContain("--extra-index-url");
    const rest = pipRun(requirementsFile("cpu", DEFAULT_HELPERS_DIR));
    expect(rest?.argv).toEqual(
      expect.arrayContaining(["--no-deps", "--require-hashes", "--index-url", PYPI_INDEX]),
    );
    expect(rest?.argv).not.toContain("--extra-index-url");
    // Only wheels, so no build step fetches anything unhashed; the one source-only package
    // (docopt) is built against the hashed setuptools installed before, without isolation.
    const build = pipRun(buildToolsFile(DEFAULT_HELPERS_DIR));
    expect(build?.argv).toEqual(
      expect.arrayContaining(["--no-deps", "--require-hashes", "--only-binary", ":all:"]),
    );
    for (const c of [pipSelf, build, torch])
      expect(c?.argv).toEqual(expect.arrayContaining(["--only-binary", ":all:"]));
    expect(rest?.argv).toEqual(
      expect.arrayContaining([
        "--only-binary",
        ":all:",
        "--no-binary",
        SOURCE_BUILDS.join(","),
        "--no-build-isolation",
      ]),
    );
    expect(SOURCE_BUILDS).toEqual(["docopt"]);
    const order = [pipSelf, build, torch, rest].map((c) => fake.calls.indexOf(c as never));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const check = fake.calls.find((c) => c.argv[3] === "check");
    expect(fake.calls.indexOf(check as never)).toBeGreaterThan(order[3] as number);
    // Models land in the managed folder, never the user's global Hugging Face cache.
    const models = fake.calls.find((c) => c.argv[1]?.endsWith("fr_voice_models.py"));
    expect(models?.env?.HF_HOME).toBe(vd.models);
    const stt = fake.calls.find((c) => c.argv[1]?.endsWith("fr_stt.py"));
    expect(stt?.argv).toEqual(
      expect.arrayContaining(["--device", "cpu", "--compute-type", "int8"]),
    );
    const tts = fake.calls.find((c) => c.argv[1]?.endsWith("fr_tts.py"));
    expect(tts?.argv).toEqual(expect.arrayContaining(["--device", "cpu"]));
    const s = readVoiceSettings(dirs);
    expect(s?.profile).toBe("cpu");
    expect(s?.verified?.stt).toEqual({ device: "cpu", computeType: "int8", fallback: null });
    expect(s?.verified?.tts).toEqual({ device: "cpu", computeType: null, fallback: null });
    expect(s?.install?.python).toBe(venvPy);
    // Progress is visible: pip's raw progress and the model bytes.
    expect(events.some((e) => e.type === "progress" && e.what.startsWith("torch"))).toBe(true);
    expect(events.some((e) => e.type === "progress" && e.what === "kokoro")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "result", ok: true, profile: "cpu", exitCode: 0 });
  });

  it("gpu: the gpu list, then STT on cuda float16 and Kokoro on cuda, verified as cuda", async () => {
    const { dirs, env } = home();
    const fake = fakeRunner({
      nvidiaSmi: NVIDIA,
      pythons: { "py -3.12": "3.12.7", python: "3.13.0" },
    });
    const r = await installVoice("gpu", {
      dirs,
      env,
      platform: "windows",
      run: fake.run,
      out: () => {},
    });
    expect(r.exitCode).toBe(0);
    const torch = fake.calls.find((c) => c.argv.includes(torchFile("gpu", DEFAULT_HELPERS_DIR)));
    expect(torch?.argv).toEqual(
      expect.arrayContaining([
        "--index-url",
        "https://download.pytorch.org/whl/cu128",
        "--no-deps",
      ]),
    );
    const rest = fake.calls.find((c) =>
      c.argv.includes(requirementsFile("gpu", DEFAULT_HELPERS_DIR)),
    );
    expect(rest?.argv[0]).toBe(venvPythonPath(voiceDirs(dirs).venv("gpu"), "windows"));
    // Windows: the venv is made with the py launcher's 3.12 when there is one.
    const venv = fake.calls.find((c) => c.argv.includes("venv"));
    expect(venv?.argv.slice(0, 2)).toEqual(["py", "-3.12"]);
    const stt = fake.calls.find((c) => c.argv[1]?.endsWith("fr_stt.py"));
    expect(stt?.argv).toEqual(
      expect.arrayContaining(["--device", "cuda", "--compute-type", "float16"]),
    );
    // The check runs without --cpu-fallback: a CUDA failure must show, not hide.
    expect(stt?.argv).not.toContain("--cpu-fallback");
    const s = readVoiceSettings(dirs);
    expect(s?.verified?.stt.device).toBe("cuda");
    expect(s?.verified?.tts.device).toBe("cuda");
    expect(s?.gpu?.name).toBe("NVIDIA GeForce RTX 4070");
  });

  it("gpu: a failing CUDA check falls back to the CPU loudly, records why, exits 2", async () => {
    const { dirs, env } = home();
    const fake = fakeRunner({
      nvidiaSmi: NVIDIA,
      sttCudaError: "Library cublas64_12.dll is not found or cannot be loaded",
    });
    const { events, out } = collect();
    const r = await installVoice("gpu", { dirs, env, platform: "windows", run: fake.run, out });
    expect(r.exitCode).toBe(2);
    expect(r.ok).toBe(true);
    const warnings = messages(events, "warning").join("\n");
    expect(warnings).toMatch(/GPU check failed for speech recognition/);
    expect(warnings).toMatch(/cublas64_12\.dll/);
    expect(warnings).toMatch(/runs on the CPU/);
    // The CPU run happened after the cuda one.
    const sttRuns = fake.calls.filter((c) => c.argv[1]?.endsWith("fr_stt.py"));
    expect(sttRuns.map((c) => c.argv[c.argv.indexOf("--device") + 1])).toEqual(["cuda", "cpu"]);
    const s = readVoiceSettings(dirs);
    expect(s?.profile).toBe("gpu");
    expect(s?.verified?.stt).toEqual({
      device: "cpu",
      computeType: "int8",
      fallback: "model load failed: Library cublas64_12.dll is not found or cannot be loaded",
    });
    expect(s?.verified?.tts.device).toBe("cuda");
    const result = events.at(-1);
    expect(result).toMatchObject({ type: "result", exitCode: 2 });
    expect(result && "message" in result ? result.message : "").toMatch(/CPU/);
  });

  it("is idempotent: a second run reuses the venv and skips pip when the pins have not changed", async () => {
    const { dirs, env } = home();
    const first = fakeRunner();
    await installVoice("cpu", { dirs, env, platform: "linux", run: first.run, out: () => {} });
    const second = fakeRunner();
    const { events, out } = collect();
    const r = await installVoice("cpu", { dirs, env, platform: "linux", run: second.run, out });
    expect(r.exitCode).toBe(0);
    expect(second.calls.some((c) => c.argv.includes("venv"))).toBe(false);
    expect(second.calls.some((c) => c.argv.includes("-r"))).toBe(false);
    expect(messages(events, "log").join("\n")).toMatch(/packages up to date/);
    // It still verifies (that is the repair path).
    expect(second.calls.some((c) => c.argv[1]?.endsWith("fr_stt.py"))).toBe(true);
    // With ifChanged (fr setup re-run, same profile) nothing runs at all.
    const third = fakeRunner();
    const quiet = await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run: third.run,
      out: () => {},
      ifChanged: true,
    });
    expect(quiet.exitCode).toBe(0);
    expect(third.calls.filter((c) => c.argv[0] !== "nvidia-smi")).toHaveLength(0);
  });

  it("resumes after a failed pip run: the marker is written only on success", async () => {
    const { dirs, env } = home();
    const broken = fakeRunner({ pipError: "ERROR: Connection reset by peer" });
    const { events, out } = collect();
    const r = await installVoice("cpu", { dirs, env, platform: "linux", run: broken.run, out });
    expect(r.exitCode).toBe(1);
    expect(messages(events, "error").join("\n")).toMatch(/Connection reset by peer/);
    expect(messages(events, "error").join("\n")).toMatch(/run it again/);
    expect(readVoiceSettings(dirs)?.profile ?? null).toBeNull();
    const again = fakeRunner();
    const ok = await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run: again.run,
      out: () => {},
    });
    expect(ok.exitCode).toBe(0);
    expect(again.calls.some((c) => c.argv.includes("venv"))).toBe(false);
    expect(again.calls.some((c) => c.argv.includes("-r"))).toBe(true);
  });

  it("repairs a venv whose interpreter no longer runs", async () => {
    const { dirs, env } = home();
    await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run: fakeRunner().run,
      out: () => {},
    });
    const fake = fakeRunner({ brokenVenv: true });
    const { events, out } = collect();
    const r = await installVoice("cpu", { dirs, env, platform: "linux", run: fake.run, out });
    expect(r.exitCode).toBe(0);
    expect(fake.calls.some((c) => c.argv.includes("venv"))).toBe(true);
    expect(messages(events, "log").join("\n")).toMatch(/does not run; making it again/);
  });

  it("without Python 3.12: a clear message with the install line, nothing written", async () => {
    for (const platform of ["windows", "linux"] as const) {
      const { dirs, env } = home();
      const fake = fakeRunner({
        pythons: {
          python3: "3.13.1",
          python: "3.11.9",
          "py -3.11": "3.11.9",
          "python3.11": "3.11.9",
        },
      });
      const { events, out } = collect();
      const r = await installVoice("cpu", { dirs, env, platform, run: fake.run, out });
      expect(r.exitCode).toBe(1);
      const err = messages(events, "error").join("\n");
      expect(err).toMatch(/needs Python 3\.12/);
      expect(err).toMatch(/numpy 2\.5/);
      expect(err).toMatch(/3\.13\.1/);
      expect(err).toMatch(/3\.11\.9/);
      expect(err).toContain(
        platform === "windows"
          ? "winget install -e --id Python.Python.3.12"
          : "sudo apt-get install -y python3.12 python3.12-venv",
      );
      expect(existsSync(voiceDirs(dirs).venv("cpu"))).toBe(false);
      expect(readVoiceSettings(dirs)).toBeNull();
    }
  });

  it("refuses a data folder whose path is too long for espeak-ng, before downloading anything", async () => {
    // Kokoro's phonemizer passes espeak-ng the data folder inside the venv; espeak-ng keeps at
    // most 159 characters of it (230 on Windows) and otherwise exits on the first sentence.
    const h = mkdtempSync(join(tmpdir(), `fr-${"x".repeat(80)}-`));
    const env = { FORERUNNER_HOME: h };
    const dirs = appDirs({ env });
    const fake = fakeRunner();
    const { events, out } = collect();
    const r = await installVoice("cpu", { dirs, env, platform: "linux", run: fake.run, out });
    expect(r.exitCode).toBe(1);
    const err = messages(events, "error").join("\n");
    expect(err).toMatch(/too long for espeak-ng/);
    expect(err).toMatch(/FORERUNNER_HOME/);
    expect(fake.calls.some((c) => c.argv.includes("venv"))).toBe(false);
    expect(fake.calls.some((c) => c.argv.includes("-r"))).toBe(false);
  });

  it("refuses up front on a platform the pinned wheels do not cover", async () => {
    for (const [platform, arch] of [
      ["linux", "arm64"],
      ["windows", "arm64"],
      ["macos", "arm64"],
      ["linux", "ia32"],
    ] as const) {
      const { dirs, env } = home();
      const fake = fakeRunner();
      const { events, out } = collect();
      const r = await installVoice("cpu", { dirs, env, platform, arch, run: fake.run, out });
      expect(r.exitCode).toBe(1);
      const err = messages(events, "error").join("\n");
      expect(err).toContain("Windows x64 and Linux x86_64 only");
      expect(err).toContain(`${platform} ${arch}`);
      expect(fake.calls).toHaveLength(0);
      expect(readVoiceSettings(dirs)).toBeNull();
    }
    // Removing works anywhere.
    const { dirs, env } = home();
    const removed = await installVoice("none", {
      dirs,
      env,
      platform: "macos",
      arch: "arm64",
      out: () => {},
    });
    expect(removed.exitCode).toBe(0);
  });

  it("fails when pip check finds a broken requirement, without writing the marker", async () => {
    const { dirs, env } = home();
    const fake = fakeRunner({
      pipCheckError: "kokoro 0.9.4 requires torch, which is not installed.",
    });
    const { events, out } = collect();
    const r = await installVoice("cpu", { dirs, env, platform: "linux", run: fake.run, out });
    expect(r.exitCode).toBe(1);
    expect(messages(events, "error").join("\n")).toMatch(/kokoro 0\.9\.4 requires torch/);
    const again = fakeRunner();
    await installVoice("cpu", { dirs, env, platform: "linux", run: again.run, out: () => {} });
    expect(
      again.calls.some((c) => c.argv.includes(requirementsFile("cpu", DEFAULT_HELPERS_DIR))),
    ).toBe(true);
  });

  it("pip never sees an extra index or find-links from the environment", async () => {
    const { dirs, env } = home();
    const fake = fakeRunner();
    await installVoice("cpu", {
      dirs,
      env: { ...env, PIP_EXTRA_INDEX_URL: "https://evil.example/simple", PIP_FIND_LINKS: "/tmp/x" },
      platform: "linux",
      run: fake.run,
      out: () => {},
    });
    for (const c of fake.calls.filter((c) => c.argv[2] === "pip" || c.argv[1] === "-m")) {
      expect(c.env?.PIP_EXTRA_INDEX_URL).toBeUndefined();
      expect(c.env?.PIP_FIND_LINKS).toBeUndefined();
    }
  });

  it("stops when cancelled: the running step is aborted, nothing is recorded, the lock is freed", async () => {
    const { dirs, env } = home();
    const controller = new AbortController();
    const fake = fakeRunner();
    const run: typeof fake.run = async (req) => {
      if (req.argv.includes(torchFile("cpu", DEFAULT_HELPERS_DIR))) {
        expect(req.signal).toBeDefined();
        controller.abort();
        return { code: null, stdout: Buffer.alloc(0), stderr: "killed" };
      }
      return fake.run(req);
    };
    const { events, out } = collect();
    const r = await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run,
      out,
      signal: controller.signal,
    });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/cancelled/);
    expect(messages(events, "error").join("\n")).toMatch(/cancelled/);
    expect(fake.calls.some((c) => c.argv[1]?.endsWith("fr_voice_models.py"))).toBe(false);
    expect(readVoiceSettings(dirs)).toBeNull();
    expect(existsSync(voiceDirs(dirs).lock)).toBe(false);
  });

  it("names the lock file when another install holds it", async () => {
    const { dirs, env } = home();
    const lock = voiceDirs(dirs).lock;
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, String(process.ppid));
    const { events, out } = collect();
    const r = await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run: fakeRunner().run,
      out,
    });
    expect(r.exitCode).toBe(1);
    const err = messages(events, "error").join("\n");
    expect(err).toContain(lock);
    expect(err).toMatch(new RegExp(`process ${process.ppid}`));
  });

  it("writes voice.json atomically: a temporary file renamed over it, none left behind", () => {
    const { dirs } = home();
    const target = voiceDirs(dirs).settings;
    writeVoiceSettings(dirs, { version: 1, profile: "cpu", updatedAt: "t" });
    writeVoiceSettings(dirs, { version: 1, profile: "gpu", updatedAt: "t2" });
    expect(readdirSync(dirname(target)).filter((f) => f.startsWith("voice.json"))).toEqual([
      "voice.json",
    ]);
    expect(readVoiceSettings(dirs)?.profile).toBe("gpu");
    // A torn temporary file from a crash is never what is read.
    writeFileSync(`${target}.tmp-123`, "{ torn");
    expect(readVoiceSettings(dirs)?.profile).toBe("gpu");
  });

  it("switching profiles removes the other venv after the new one is verified", async () => {
    const { dirs, env } = home();
    await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run: fakeRunner().run,
      out: () => {},
    });
    expect(existsSync(voiceDirs(dirs).venv("cpu"))).toBe(true);
    let released = 0;
    const r = await installVoice("gpu", {
      dirs,
      env,
      platform: "linux",
      run: fakeRunner({ nvidiaSmi: NVIDIA }).run,
      out: () => {},
      beforeCleanup: async () => {
        released++;
      },
    });
    expect(r.exitCode).toBe(0);
    expect(released).toBe(1);
    expect(existsSync(voiceDirs(dirs).venv("cpu"))).toBe(false);
    expect(existsSync(voiceDirs(dirs).venv("gpu"))).toBe(true);
    expect(readVoiceSettings(dirs)?.profile).toBe("gpu");
  });

  it("says so when FORERUNNER_PYTHON overrides the managed venv", async () => {
    const { dirs, env } = home();
    const { events, out } = collect();
    await installVoice("cpu", {
      dirs,
      env: { ...env, FORERUNNER_PYTHON: "/opt/py/bin/python" },
      platform: "linux",
      run: fakeRunner().run,
      out,
    });
    expect(messages(events, "warning").join("\n")).toMatch(/FORERUNNER_PYTHON is set/);
  });

  it("fr voice remove: deletes the venvs and the models and turns local voice off", async () => {
    const { dirs, env } = home();
    await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run: fakeRunner().run,
      out: () => {},
    });
    mkdirSync(voiceDirs(dirs).models, { recursive: true });
    const r = await removeVoice({ dirs, env, platform: "linux", out: () => {} });
    expect(r.exitCode).toBe(0);
    expect(existsSync(voiceDirs(dirs).venv("cpu"))).toBe(false);
    expect(existsSync(voiceDirs(dirs).models)).toBe(false);
    expect(readVoiceSettings(dirs)?.profile).toBe("none");
    // Installing "none" is the same as removing.
    const again = await installVoice("none", {
      dirs,
      env,
      platform: "linux",
      run: fakeRunner().run,
      out: () => {},
    });
    expect(again.exitCode).toBe(0);
  });
});

describe("the GPU and the default profile", () => {
  it("nvidia-smi present: the GPU with its driver; absent: none, and cpu is recommended", async () => {
    const gpu = await detectNvidiaGpu({
      run: fakeRunner({ nvidiaSmi: NVIDIA }).run,
      platform: "windows",
    });
    expect(gpu).toMatchObject({
      present: true,
      name: "NVIDIA GeForce RTX 4070",
      driver: "572.83",
      memoryMb: 12282,
    });
    expect(recommendedProfile(gpu)).toBe("gpu");
    const none = await detectNvidiaGpu({
      run: fakeRunner({ nvidiaSmi: null }).run,
      platform: "linux",
      procVersionFile: join(tmpdir(), "no-such-nvidia-version"),
    });
    expect(none.present).toBe(false);
    expect(none.reason).toMatch(/nvidia-smi/);
    expect(recommendedProfile(none)).toBe("cpu");
  });

  it("the setup question shows each profile's size and trade-off and parses the answer", () => {
    const q = VOICE_PROFILE_QUESTION("gpu", {
      present: true,
      name: "RTX 4070",
      driver: "572.83",
      memoryMb: 1,
      reason: "",
    });
    expect(q).toMatch(/none/);
    expect(q).toMatch(/about 2\.3 GB/);
    expect(q).toMatch(/about 8 GB/);
    expect(q).toMatch(/RTX 4070/);
    expect(q).toMatch(/\[gpu\]/);
    expect(parseVoiceProfileAnswer("", "gpu")).toBe("gpu");
    expect(parseVoiceProfileAnswer(" CPU ", "gpu")).toBe("cpu");
    expect(parseVoiceProfileAnswer("1", "gpu")).toBe("none");
    expect(parseVoiceProfileAnswer("3", "cpu")).toBe("gpu");
    expect(parseVoiceProfileAnswer("maybe", "cpu")).toBeNull();
  });

  it("finds a 3.12 interpreter in the per-OS order, never 3.10 or 3.11", async () => {
    const linux = await findBasePython({
      run: fakeRunner({ pythons: { "python3.11": "3.11.9", python3: "3.12.4" } }).run,
      platform: "linux",
    });
    expect(linux).toEqual({ argv: ["python3"], version: "3.12.4" });
    const win = await findBasePython({
      run: fakeRunner({
        pythons: { "py -3.11": "3.11.9", "py -3.10": "3.10.11", python: "3.12.1" },
      }).run,
      platform: "windows",
    });
    expect(win).toEqual({ argv: ["python"], version: "3.12.1" });
    const launcher = await findBasePython({
      run: fakeRunner({ pythons: { "py -3.12": "3.12.7", python: "3.13.0" } }).run,
      platform: "windows",
    });
    expect(launcher.argv).toEqual(["py", "-3.12"]);
    const explicit = await findBasePython({
      run: fakeRunner({ pythons: { "/opt/python3.12/bin/python3": "3.12.2" } }).run,
      platform: "linux",
      explicit: "/opt/python3.12/bin/python3",
    });
    expect(explicit.argv).toEqual(["/opt/python3.12/bin/python3"]);
  });
});
