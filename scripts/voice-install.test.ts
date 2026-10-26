import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { readVoiceSettings } from "../packages/runtime/src/voice/install.ts";
import { fakeRunner, NVIDIA } from "../packages/runtime/test/voice-install-helpers.ts";
import { runVoiceInstall } from "./voice-install.ts";

/**
 * scripts/voice-install.ts: the voice-run launcher's install step (`pnpm voice:install --gpu`)
 * in its dedicated FORERUNNER_HOME, the same installer as `fr voice install`.
 */
const temps: string[] = [];
const home = () => {
  const d = mkdtempSync(join(tmpdir(), "fr-voice-install-script-"));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("voice-install script", () => {
  it("refuses without a dedicated FORERUNNER_HOME", async () => {
    const lines: string[] = [];
    const code = await runVoiceInstall(["--cpu"], { env: {}, out: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/refusing to run without FORERUNNER_HOME/);
  });

  it("installs the profile named, gpu by detection without a flag, and removes with --none", async () => {
    const h = home();
    const env = { FORERUNNER_HOME: h };
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    const opts = { env, out, platform: "linux" as const };
    // A fresh home without a flag: gpu, because nvidia-smi finds one.
    expect(await runVoiceInstall([], { ...opts, run: fakeRunner({ nvidiaSmi: NVIDIA }).run })).toBe(
      0,
    );
    expect(readVoiceSettings(appDirs({ env }))?.profile).toBe("gpu");
    expect(lines.join("\n")).toMatch(/voice profile gpu installed/);
    expect(await runVoiceInstall(["--cpu"], { ...opts, run: fakeRunner().run })).toBe(0);
    expect(readVoiceSettings(appDirs({ env }))?.profile).toBe("cpu");
    // Without a flag the installed profile is kept (checked again), whatever the GPU.
    expect(await runVoiceInstall([], { ...opts, run: fakeRunner({ nvidiaSmi: NVIDIA }).run })).toBe(
      0,
    );
    expect(readVoiceSettings(appDirs({ env }))?.profile).toBe("cpu");
    expect(await runVoiceInstall(["--none"], { ...opts, run: fakeRunner().run })).toBe(0);
    expect(readVoiceSettings(appDirs({ env }))?.profile).toBe("none");
  });

  it("refuses an unknown argument", async () => {
    const lines: string[] = [];
    const code = await runVoiceInstall(["--tpu"], {
      env: { FORERUNNER_HOME: home() },
      out: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/usage: pnpm voice:install/);
  });
});
