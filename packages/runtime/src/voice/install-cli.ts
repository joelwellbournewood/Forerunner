/**
 * The voice profile from the command line (ADR 0090):
 *
 *   fr voice install [--cpu | --gpu] [--python <path>]   install, repair or switch
 *   fr voice remove                                       local voice off, packages and models deleted
 *   fr voice status [--json]                              the profile, the devices verified, the GPU
 *
 * and the voice step of `fr setup` (`voiceSetupStep`): asked interactively with each profile's
 * size and trade-off, the detected GPU's profile as the default; `--voice none|cpu|gpu` sets it
 * without asking. All of them run `installVoice` / `removeVoice` with the progress printed as it
 * comes. Exit codes: 0 done, 2 done with the CPU standing in for a failed GPU check, 1 failed.
 * A daemon that is running picks the new profile up at its next voice use (voice.json is read
 * every time); on Windows a venv its helpers hold is removed at the next install.
 */
import {
  type AppDirs,
  appDirs,
  dirname,
  ForerunnerError,
  type Platform,
} from "@forerunner/platform";
import type { Command } from "commander";
import {
  detectNvidiaGpu,
  type InstallResult,
  installVoice,
  parseVoiceProfileAnswer,
  readVoiceSettings,
  recommendedProfile,
  recordedVoiceRoot,
  removeVoice,
  VOICE_PROFILE_QUESTION,
  type VoiceProcRunner,
  voiceDirs,
} from "./install.ts";
import { VOICE_PROFILES, type VoiceInstallEvent, type VoiceProfile } from "./install-types.ts";

export interface VoiceCliDeps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  dirs?: AppDirs;
  run?: VoiceProcRunner;
  platform?: Platform;
}

const mb = (n: number) => (n / 1_000_000).toFixed(1);

/** One progress event as a terminal line; null for nothing to print. */
export function formatInstallEvent(e: VoiceInstallEvent): string | null {
  switch (e.type) {
    case "step":
      return `==> ${e.message}`;
    case "log":
      return e.message ? `    ${e.message}` : null;
    case "progress":
      return e.total
        ? `    ${e.what}: ${mb(e.bytes)} of ${mb(e.total)} MB (${Math.min(100, Math.floor((e.bytes / e.total) * 100))}%)`
        : `    ${e.what}: ${mb(e.bytes)} MB`;
    case "warning":
      return `WARNING: ${e.message}`;
    case "error":
      return `ERROR: ${e.message}`;
    case "result":
      return e.message;
  }
}

const printer = (out: (l: string) => void) => (e: VoiceInstallEvent) => {
  const line = formatInstallEvent(e);
  if (line !== null) out(line);
};

function dirsOf(deps: VoiceCliDeps): AppDirs {
  return deps.dirs ?? appDirs({ env: deps.env });
}

export interface VoiceSetupInput {
  /** `--voice`: none, cpu or gpu; anything else is a validation error. */
  voice?: string;
  nonInteractive: boolean;
  prompt?: (question: string) => Promise<string>;
}

/**
 * `fr setup`'s voice step: the flag, else (interactively) the question, else nothing. Runs the
 * install only when the profile changed or is not verified (`ifChanged`); returns null when
 * nothing was chosen.
 */
export async function voiceSetupStep(
  input: VoiceSetupInput,
  deps: VoiceCliDeps,
): Promise<InstallResult | null> {
  const dirs = dirsOf(deps);
  let profile: VoiceProfile | null = null;
  if (input.voice !== undefined) {
    const v = input.voice.trim().toLowerCase();
    if (!(VOICE_PROFILES as readonly string[]).includes(v))
      throw new ForerunnerError(
        "validation",
        `--voice must be none, cpu or gpu (got ${JSON.stringify(input.voice)})`,
      );
    profile = v as VoiceProfile;
  }
  const current = readVoiceSettings(dirs)?.profile ?? null;
  if (!profile && (input.nonInteractive || !input.prompt)) {
    deps.out(
      current
        ? `Voice: ${current} (change it with fr setup --voice none|cpu|gpu or fr voice install)`
        : "Voice: not chosen yet (fr setup --voice none|cpu|gpu, or fr voice install --cpu|--gpu)",
    );
    return null;
  }
  const gpu = await detectNvidiaGpu({ run: deps.run, platform: deps.platform });
  if (!profile && input.prompt) {
    const fallback = current ?? recommendedProfile(gpu);
    for (let i = 0; i < 3 && !profile; i++) {
      profile = parseVoiceProfileAnswer(
        await input.prompt(VOICE_PROFILE_QUESTION(fallback, gpu)),
        fallback,
      );
      if (!profile) deps.out("Please answer none, cpu or gpu.");
    }
    profile ??= fallback;
  }
  if (!profile) return null;
  return installVoice(profile, {
    dirs,
    env: deps.env,
    out: printer(deps.out),
    gpu,
    ifChanged: true,
    ...(deps.run ? { run: deps.run } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
  });
}

export function registerVoiceCli(program: Command, deps: VoiceCliDeps): void {
  const voice = program
    .command("voice")
    .description(
      "Local voice: install, switch or remove the speech packages and models (ADR 0090)",
    );

  voice
    .command("install")
    .description(
      "Install or repair local voice: a managed Python venv, the pinned packages, the models, then a check on the CPU or GPU",
    )
    .option("--cpu", "faster-whisper int8 and Kokoro on the CPU (about 2.3 GB; works anywhere)")
    .option("--gpu", "NVIDIA only: faster-whisper and Kokoro on CUDA (about 8 GB; fastest)")
    .option("--python <path>", "the Python 3.12 interpreter that makes the venv")
    .action(async (opts: { cpu?: boolean; gpu?: boolean; python?: string }) => {
      if (opts.cpu && opts.gpu)
        throw new ForerunnerError("validation", "option --cpu cannot be used with --gpu");
      const dirs = dirsOf(deps);
      const gpu = await detectNvidiaGpu({ run: deps.run, platform: deps.platform });
      const current = readVoiceSettings(dirs)?.profile;
      const profile: VoiceProfile = opts.cpu
        ? "cpu"
        : opts.gpu
          ? "gpu"
          : current === "cpu" || current === "gpu"
            ? current
            : recommendedProfile(gpu);
      const r = await installVoice(profile, {
        dirs,
        env: deps.env,
        out: printer(deps.out),
        gpu,
        ...(opts.python ? { python: opts.python } : {}),
        ...(deps.run ? { run: deps.run } : {}),
        ...(deps.platform ? { platform: deps.platform } : {}),
      });
      process.exitCode = r.exitCode;
    });

  voice
    .command("remove")
    .description("Turn local voice off and delete its venvs and models (profile none)")
    .action(async () => {
      const r = await removeVoice({
        dirs: dirsOf(deps),
        env: deps.env,
        out: printer(deps.out),
        ...(deps.platform ? { platform: deps.platform } : {}),
      });
      process.exitCode = r.exitCode;
    });

  voice
    .command("status")
    .description("The voice profile, the devices the last check verified, the GPU")
    .option("--json", "machine readable", false)
    .action(async (opts: { json?: boolean }) => {
      const dirs = dirsOf(deps);
      const s = readVoiceSettings(dirs);
      const gpu = await detectNvidiaGpu({ run: deps.run, platform: deps.platform });
      const view = {
        profile: s?.profile ?? null,
        stt: s?.verified?.stt ?? null,
        tts: s?.verified?.tts ?? null,
        verifiedAt: s?.verified?.at ?? null,
        venv: s?.install?.venv ?? null,
        // Where the install was made (voice.json, U-011); 1.0.2's data folder without one.
        models: voiceDirs(dirs, dirname(recordedVoiceRoot(s) ?? voiceDirs(dirs).root)).models,
        pythonOverride: deps.env.FORERUNNER_PYTHON?.trim() || null,
        gpu,
      };
      if (opts.json) {
        deps.out(JSON.stringify(view, null, 2));
        return;
      }
      const dev = (d: typeof view.stt) =>
        d
          ? `${d.device}${d.computeType ? ` (${d.computeType})` : ""}${d.fallback ? `, CPU standing in: ${d.fallback}` : ""}`
          : "not checked";
      deps.out(
        `profile             ${view.profile ?? "not chosen (fr voice install --cpu|--gpu)"}`,
      );
      deps.out(`speech recognition  ${dev(view.stt)}`);
      deps.out(`speech              ${dev(view.tts)}`);
      deps.out(`verified            ${view.verifiedAt ?? "never"}`);
      deps.out(`venv                ${view.venv ?? "none"}`);
      deps.out(`models              ${view.models}`);
      deps.out(
        `gpu                 ${gpu.present ? `${gpu.name ?? "NVIDIA"}${gpu.driver ? `, driver ${gpu.driver}` : ""}` : `none (${gpu.reason})`}`,
      );
      if (view.pythonOverride)
        deps.out(`note: FORERUNNER_PYTHON=${view.pythonOverride} is used instead of the venv`);
    });
}
