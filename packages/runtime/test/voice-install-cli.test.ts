import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli/main.ts";
import { readVoiceSettings } from "../src/voice/install.ts";
import { formatInstallEvent, voiceSetupStep } from "../src/voice/install-cli.ts";
import { fakeRunner, NVIDIA } from "./voice-install-helpers.ts";

/**
 * The voice profile from the command line (ADR 0090): `fr voice install [--cpu|--gpu]`,
 * `fr voice remove`, `fr voice status`, and the voice step of `fr setup` (asked
 * interactively, `--voice none|cpu|gpu` without asking). In process through `buildProgram()`
 * with a fake process runner.
 */

function home() {
  const h = mkdtempSync(join(tmpdir(), "fr-voice-cli-"));
  const env = { FORERUNNER_HOME: h };
  return { env, dirs: appDirs({ env }) };
}

async function fr(
  env: NodeJS.ProcessEnv,
  run: ReturnType<typeof fakeRunner>["run"],
  args: string[],
) {
  const lines: string[] = [];
  await buildProgram({
    env,
    out: (l) => lines.push(l),
    voice: { run, platform: "linux" },
  })
    .exitOverride()
    .parseAsync(["node", "fr", ...args]);
  return lines;
}

afterEach(() => {
  process.exitCode = 0;
});

describe("fr voice", () => {
  it("install --cpu streams the steps and progress, then the result; status shows the devices", async () => {
    const { env, dirs } = home();
    const lines = await fr(env, fakeRunner().run, ["voice", "install", "--cpu"]);
    const text = lines.join("\n");
    expect(text).toMatch(/==> managed Python environment/);
    expect(text).toMatch(/==> installing the cpu packages/);
    expect(text).toMatch(/torch-2\.11\.0\.whl: .* of .* MB/);
    expect(text).toMatch(/kokoro: /);
    expect(text).toMatch(/voice profile cpu installed: speech recognition on cpu, speech on cpu/);
    expect(process.exitCode ?? 0).toBe(0);
    expect(readVoiceSettings(dirs)?.profile).toBe("cpu");
    const status = await fr(env, fakeRunner().run, ["voice", "status", "--json"]);
    const parsed = JSON.parse(status.join("\n")) as { profile: string; stt: { device: string } };
    expect(parsed.profile).toBe("cpu");
    expect(parsed.stt.device).toBe("cpu");
    const plain = (await fr(env, fakeRunner().run, ["voice", "status"])).join("\n");
    expect(plain).toMatch(/profile\s+cpu/);
    expect(plain).toMatch(/speech recognition\s+cpu \(int8\)/);
  });

  it("install without a flag takes gpu when nvidia-smi finds a GPU", async () => {
    const { env, dirs } = home();
    await fr(env, fakeRunner({ nvidiaSmi: NVIDIA }).run, ["voice", "install"]);
    expect(readVoiceSettings(dirs)?.profile).toBe("gpu");
  });

  it("install --gpu whose CUDA check fails: a WARNING, the CPU verified, exit code 2", async () => {
    const { env, dirs } = home();
    const lines = await fr(
      env,
      fakeRunner({
        nvidiaSmi: NVIDIA,
        sttCudaError: "Library cublas64_12.dll is not found or cannot be loaded",
      }).run,
      ["voice", "install", "--gpu"],
    );
    expect(lines.join("\n")).toMatch(/^WARNING: GPU check failed for speech recognition/m);
    expect(process.exitCode).toBe(2);
    expect(readVoiceSettings(dirs)?.verified?.stt.device).toBe("cpu");
  });

  it("refuses --cpu with --gpu", async () => {
    const { env } = home();
    await expect(fr(env, fakeRunner().run, ["voice", "install", "--cpu", "--gpu"])).rejects.toThrow(
      /cannot be used with/,
    );
  });

  it("remove turns local voice off", async () => {
    const { env, dirs } = home();
    await fr(env, fakeRunner().run, ["voice", "install", "--cpu"]);
    const lines = await fr(env, fakeRunner().run, ["voice", "remove"]);
    expect(lines.join("\n")).toMatch(/local voice is off/);
    expect(readVoiceSettings(dirs)?.profile).toBe("none");
  });
});

describe("fr setup: the voice step", () => {
  it("lists --voice with its three values", () => {
    const setup = buildProgram({ env: {} }).commands.find((c) => c.name() === "setup");
    const opt = setup?.options.find((o) => o.long === "--voice");
    expect(opt?.argChoices).toEqual(["none", "cpu", "gpu"]);
  });

  it("--non-interactive --voice cpu installs without asking; without --voice nothing runs", async () => {
    const { env, dirs } = home();
    const fake = fakeRunner();
    const lines: string[] = [];
    let asked = 0;
    const r = await voiceSetupStep(
      { voice: "cpu", nonInteractive: true, prompt: async () => `${asked++}` },
      { env, dirs, out: (l) => lines.push(l), run: fake.run, platform: "linux" },
    );
    expect(asked).toBe(0);
    expect(r?.exitCode).toBe(0);
    expect(readVoiceSettings(dirs)?.profile).toBe("cpu");
    const idle = fakeRunner();
    const none = await voiceSetupStep(
      { nonInteractive: true },
      {
        env: home().env,
        dirs: home().dirs,
        out: (l) => lines.push(l),
        run: idle.run,
        platform: "linux",
      },
    );
    expect(none).toBeNull();
    expect(idle.calls).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/Voice: not chosen yet/);
  });

  it("interactive: asks with the sizes, Enter takes the detected default, a re-run with the same answer does nothing", async () => {
    const { env, dirs } = home();
    const questions: string[] = [];
    const prompt = async (q: string) => {
      questions.push(q);
      return "";
    };
    const r = await voiceSetupStep(
      { nonInteractive: false, prompt },
      { env, dirs, out: () => {}, run: fakeRunner({ nvidiaSmi: NVIDIA }).run, platform: "linux" },
    );
    expect(questions[0]).toMatch(/about 8 GB/);
    expect(questions[0]).toMatch(/\[gpu\]/);
    expect(r?.profile).toBe("gpu");
    const again = fakeRunner({ nvidiaSmi: NVIDIA });
    const lines: string[] = [];
    await voiceSetupStep(
      { nonInteractive: false, prompt },
      { env, dirs, out: (l) => lines.push(l), run: again.run, platform: "linux" },
    );
    // The second question defaults to what is installed, and nothing is reinstalled.
    expect(questions[1]).toMatch(/\[gpu\]/);
    expect(again.calls.filter((c) => c.argv[0] !== "nvidia-smi")).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/nothing to do/);
  });

  it("an answer that is not a profile is asked again", async () => {
    const { env, dirs } = home();
    const answers = ["tpu", "cpu"];
    const r = await voiceSetupStep(
      { nonInteractive: false, prompt: async () => answers.shift() ?? "" },
      { env, dirs, out: () => {}, run: fakeRunner().run, platform: "linux" },
    );
    expect(r?.profile).toBe("cpu");
  });

  it("an unknown --voice is a validation error", async () => {
    const { env, dirs } = home();
    await expect(
      voiceSetupStep(
        { voice: "tpu", nonInteractive: true },
        { env, dirs, out: () => {}, run: fakeRunner().run },
      ),
    ).rejects.toThrow(/--voice must be none, cpu or gpu/);
  });
});

describe("formatInstallEvent", () => {
  it("prints progress in MB with a percentage, and marks warnings and errors", () => {
    expect(
      formatInstallEvent({
        type: "progress",
        what: "kokoro",
        bytes: 163_869_001,
        total: 327_738_002,
      }),
    ).toBe("    kokoro: 163.9 of 327.7 MB (50%)");
    expect(formatInstallEvent({ type: "progress", what: "x", bytes: 5_000_000, total: null })).toBe(
      "    x: 5.0 MB",
    );
    expect(formatInstallEvent({ type: "warning", message: "w" })).toBe("WARNING: w");
    expect(formatInstallEvent({ type: "error", message: "e" })).toBe("ERROR: e");
    expect(formatInstallEvent({ type: "step", step: "venv", message: "m" })).toBe("==> m");
  });
});
