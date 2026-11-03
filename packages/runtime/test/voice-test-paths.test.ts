import { tmpdir } from "node:os";
import { type AppDirs, join, type Platform } from "@forerunner/platform";
import { SystemClock } from "@forerunner/platform/clock";
import { runFolderName, windowsCiTempStandIn } from "@forerunner/testenv/test-tmp";
import { describe, expect, it } from "vitest";
import { DEPENDENCIES_SUBDIR } from "../src/dependencies.ts";
import {
  ESPEAK_PATH_MAX,
  espeakDataPath,
  VOICE_PYTHON,
  type VoiceProcRunner,
  voiceDirs,
  voicePathProblem,
} from "../src/voice/install.ts";
import { voiceInstallWorld, voiceTestDirPath, voiceTestHome } from "./voice-install-helpers.ts";

/**
 * The voice install tests' folders fit the installer's own path limits (U-069) wherever the
 * tests run. Those tests run the real installer with a fake Python, so its checks apply to the
 * folders they make: espeak-ng reads at most 159 characters of its data folder's path (229 on
 * Windows), and Windows without long paths opens nothing of 260 or more (PyTorch's deepest file,
 * about 120 characters below site-packages). Most of them install Linux's layout on every OS,
 * so the 159 applies to Windows' longer temp folder too.
 *
 * The folders are in the test run's temp folder (testenv/src/test-tmp.ts). When 2622e74 put
 * every test path in that run folder (`fr-test-run-<pid>-<start>`, 23 characters on CI's
 * Windows runner), 22 voice tests failed there and nowhere else: a test home's espeak-ng path
 * was 164 characters (`voice-install.test.ts`), the install folder's 182 and its fallback 160
 * (`dependencies.test.ts`, 1 character to spare before the run folder existed), and the
 * installer refused them as it would refuse a person's. This test names the layout and the
 * length before those tests fail with an exit code.
 */

/** Long paths off, as on CI's Windows runner and by default on a person's PC. */
const longPathsOff: VoiceProcRunner = async () => ({
  code: 1,
  stdout: Buffer.alloc(0),
  stderr: "ERROR: The system was unable to find the specified registry key or value.",
});

const VERSION = VOICE_PYTHON.min.join(".");

/** The data folder is never moved: the installer checks only espeak-ng's limit there. */
function dataFolderProblem(dirs: AppDirs, platform: Platform): string | null {
  const p = espeakDataPath(voiceDirs(dirs).venv("gpu"), platform, VERSION);
  const max = ESPEAK_PATH_MAX[platform] ?? 159;
  return p.length > max ? `${p} is ${p.length} characters; espeak-ng reads at most ${max}` : null;
}

/** Every layout the voice install tests make in `base`, with the installer's verdict on it. */
function layouts(base: string): { what: string; problem: () => Promise<string | null> }[] {
  const dir = voiceTestDirPath(base);
  const home = voiceTestHome(dir);
  const world = voiceInstallWorld(dir);
  return [
    {
      what: "a test home's voice, Linux layout (voice-install, -cli, -routes, scripts/voice-install)",
      problem: async () => dataFolderProblem(home.dirs, "linux"),
    },
    {
      what: "a test home's voice, Windows layout (the daemon's routes on the host's platform)",
      problem: async () => dataFolderProblem(home.dirs, "windows"),
    },
    {
      what: "voice beside the install folder, Linux layout (dependencies.test.ts)",
      problem: () =>
        voicePathProblem(
          world.dirs,
          join(world.install, DEPENDENCIES_SUBDIR),
          "linux",
          longPathsOff,
        ),
    },
    {
      what: "the install world's data folder, Linux layout (dependencies.test.ts)",
      problem: async () => dataFolderProblem(world.dirs, "linux"),
    },
    {
      what: `"a folder that fits", Windows without long paths (voice-install.test.ts, U-069)`,
      problem: () =>
        voicePathProblem(home.dirs, join(dir, DEPENDENCIES_SUBDIR), "windows", longPathsOff),
    },
  ];
}

describe("the voice install tests' folders fit the installer's path limits", () => {
  const ci = join(windowsCiTempStandIn(), runFolderName(new SystemClock().now()));
  for (const [where, base] of [
    ["this run's temp folder", tmpdir()],
    ["a run folder in CI's Windows temp folder (its length, on any OS)", ci],
  ] as const)
    it(`in ${where}`, async () => {
      for (const layout of layouts(base))
        expect(await layout.problem(), `${layout.what}, in ${base}`).toBeNull();
    });
});
