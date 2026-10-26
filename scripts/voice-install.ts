#!/usr/bin/env -S pnpm exec tsx
/**
 * voice-install: the install step of a real-audio voice run (the launcher outside the repo runs
 * it before `pnpm voice:run check`), in the run's dedicated FORERUNNER_HOME. The same installer
 * as `fr voice install` (ADR 0089): a managed venv under the home's data directory, the pinned
 * packages of the profile, the models with progress, and a check of both helpers on the
 * profile's device.
 *
 *   pnpm voice:install [--cpu | --gpu | --none]
 *
 * Without a flag: the profile already installed in the home, else gpu when nvidia-smi finds an
 * NVIDIA GPU and cpu otherwise. Exit 0 done, 2 done with the CPU standing in for a failed GPU
 * check, 1 failed or refused. Like voice-run it refuses without FORERUNNER_HOME, so the
 * everyday install is never changed by a run. Takes no secret.
 */
import { pathToFileURL } from "node:url";
import { appDirs, currentPlatform, type Platform } from "@forerunner/platform";
import {
  detectNvidiaGpu,
  installVoice,
  readVoiceSettings,
  recommendedProfile,
  type VoiceProcRunner,
} from "../packages/runtime/src/voice/install.ts";
import { formatInstallEvent } from "../packages/runtime/src/voice/install-cli.ts";
import type { VoiceProfile } from "../packages/runtime/src/voice/install-types.ts";
import { dedicatedHome, type Out } from "./voice-run.ts";

const USAGE = "usage: pnpm voice:install [--cpu | --gpu | --none]";

export interface VoiceInstallScriptDeps {
  env: NodeJS.ProcessEnv;
  out: Out;
  run?: VoiceProcRunner;
  platform?: Platform;
}

export async function runVoiceInstall(
  argv: string[],
  deps: VoiceInstallScriptDeps,
): Promise<number> {
  const { env, out } = deps;
  if (!dedicatedHome(env)) {
    out(
      "voice-install: refusing to run without FORERUNNER_HOME. Set it to the directory of this voice run (the one voice-run uses).",
    );
    return 1;
  }
  const flags: Record<string, VoiceProfile> = { "--cpu": "cpu", "--gpu": "gpu", "--none": "none" };
  const chosen = argv.map((a) => flags[a]);
  if (argv.length > 1 || chosen.some((p) => !p)) {
    out(USAGE);
    return 1;
  }
  const platform = deps.platform ?? currentPlatform();
  const dirs = appDirs({ env });
  const gpu = await detectNvidiaGpu({ run: deps.run, platform });
  const current = readVoiceSettings(dirs)?.profile;
  const profile: VoiceProfile =
    chosen[0] ?? (current === "cpu" || current === "gpu" ? current : recommendedProfile(gpu));
  const r = await installVoice(profile, {
    dirs,
    env,
    platform,
    gpu,
    out: (e) => {
      const line = formatInstallEvent(e);
      if (line !== null) out(line);
    },
    ...(deps.run ? { run: deps.run } : {}),
  });
  return r.exitCode;
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  runVoiceInstall(process.argv.slice(2), { env: process.env, out: (l) => console.log(l) }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}
