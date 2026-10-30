import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type AppDirs, appDirs, join, SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  DEPENDENCIES_SUBDIR,
  type DependenciesDir,
  installedAppDir,
  resolveDependenciesDir,
} from "../src/dependencies.ts";
import { BUNDLED_RUNTIME_MARKER } from "../src/registry/loader.ts";
import {
  installVoice,
  readVoiceSettings,
  recordedVoiceRoot,
  removeVoice,
  venvPythonPath,
  voiceDirs,
  writeVoiceSettings,
} from "../src/voice/install.ts";
import { localVoiceSettings } from "../src/voice/local-profile.ts";
import { fakeRunner } from "./voice-install-helpers.ts";

/**
 * Downloaded dependencies beside the install (U-011 in docs/status/UPDATE-LOG.md): the owner
 * installed Forerunner on D: because C: was full, and the GPU voice install still went to
 * %LOCALAPPDATA%. They now go to `<install folder>/dependencies` by default, with pip's cache
 * and temporary files, and to the data folder only when the install folder cannot be written.
 */

function world(): { dirs: AppDirs; env: NodeJS.ProcessEnv; install: string } {
  const root = mkdtempSync(join(tmpdir(), "fr-deps-"));
  const env = { FORERUNNER_HOME: join(root, "home") };
  const install = join(root, "D", "AGENT", "Forerunner");
  mkdirSync(install, { recursive: true });
  return { dirs: appDirs({ env }), env, install };
}

const beside = (install: string): DependenciesDir => ({
  dir: join(install, DEPENDENCIES_SUBDIR),
  source: "install",
  note: null,
});

const quiet = () => undefined;

describe("where dependencies go", () => {
  it("finds the install folder as the parent of the runtime payload", () => {
    const { install } = world();
    const payload = join(install, "runtime");
    const src = join(payload, "packages", "runtime", "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(payload, BUNDLED_RUNTIME_MARKER), "{}");
    expect(installedAppDir(src)).toBe(install);
    // A repository checkout has no payload marker.
    expect(installedAppDir(join(install, "..", "elsewhere"))).toBeNull();
  });

  it("is the install folder's dependencies subfolder when it can be written", () => {
    const { dirs, env, install } = world();
    const d = resolveDependenciesDir(env, dirs, { installDir: install });
    expect(d).toEqual({ dir: join(install, "dependencies"), source: "install", note: null });
    expect(existsSync(join(install, "dependencies"))).toBe(true);
  });

  it("falls back to the data folder, saying why, when the install folder cannot be written", () => {
    const { dirs, env, install } = world();
    const d = resolveDependenciesDir(env, dirs, {
      installDir: install,
      writable: () => "EPERM: operation not permitted",
    });
    expect(d.dir).toBe(dirs.data);
    expect(d.source).toBe("data");
    expect(d.note).toContain(`The install folder ${install} cannot be written`);
    expect(d.note).toContain("EPERM");
    // A checkout (no install folder): the data folder, nothing to explain.
    expect(resolveDependenciesDir(env, dirs, { installDir: null })).toEqual({
      dir: dirs.data,
      source: "data",
      note: null,
    });
  });

  it("beside an AppImage: the folder holding the .AppImage file, in a subfolder named for the app", () => {
    const { dirs, env, install } = world();
    const d = resolveDependenciesDir(
      { ...env, APPIMAGE: join(install, "Forerunner.AppImage") },
      dirs,
    );
    expect(d).toEqual({
      dir: join(install, "Forerunner-dependencies"),
      source: "install",
      note: null,
    });
  });

  it("FORERUNNER_DEPENDENCIES_DIR wins", () => {
    const { dirs, env, install } = world();
    const chosen = join(install, "..", "deps");
    const d = resolveDependenciesDir({ ...env, FORERUNNER_DEPENDENCIES_DIR: chosen }, dirs, {
      installDir: install,
    });
    expect(d).toEqual({ dir: join(install, "..", "deps"), source: "env", note: null });
  });
});

describe("voice beside the install (U-011)", () => {
  it("puts the venv, the models, pip's cache and its temporary files under the install folder", async () => {
    const { dirs, env, install } = world();
    const fake = fakeRunner();
    const r = await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run: fake.run,
      out: quiet,
      clock: new SimulatedClock("2026-10-30T10:00:00Z"),
      dependencies: beside(install),
    });
    expect(r.exitCode).toBe(0);
    const vd = voiceDirs(dirs, join(install, "dependencies"));
    expect(vd.root).toBe(join(install, "dependencies", "voice"));
    expect(existsSync(venvPythonPath(vd.venv("cpu"), "linux"))).toBe(true);
    expect(readVoiceSettings(dirs)?.install?.venv).toBe(vd.venv("cpu"));
    // Every process the install ran wrote only below the dependencies folder.
    const pip = fake.calls.find((c) => c.argv.includes("pip") && c.argv.includes("-r"));
    expect(pip?.env).toMatchObject({
      HF_HOME: vd.models,
      PIP_CACHE_DIR: vd.pipCache,
      TMP: vd.tmp,
      TEMP: vd.tmp,
      TMPDIR: vd.tmp,
    });
    // The temporary folder goes when the install ends; nothing went to the data folder.
    expect(existsSync(vd.tmp)).toBe(false);
    expect(existsSync(voiceDirs(dirs).root)).toBe(false);
    // The helpers run from where it was installed.
    const local = localVoiceSettings({ dirs, env, platform: "linux" });
    expect(local?.python).toBe(venvPythonPath(vd.venv("cpu"), "linux"));
    expect(local?.env.HF_HOME).toBe(vd.models);
  });

  it("keeps a 1.0.2 install in the data folder working, and moves it on the next install", async () => {
    const { dirs, env, install } = world();
    await installVoice("cpu", { dirs, env, platform: "linux", run: fakeRunner().run, out: quiet });
    const old = voiceDirs(dirs);
    expect(existsSync(old.venv("cpu"))).toBe(true);
    mkdirSync(old.models, { recursive: true });
    // Read where voice.json recorded it, whatever the default is now.
    expect(localVoiceSettings({ dirs, env, platform: "linux" })?.python).toBe(
      venvPythonPath(old.venv("cpu"), "linux"),
    );
    // `fr setup` never moves a working install.
    const setup = fakeRunner();
    const same = await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run: setup.run,
      out: quiet,
      ifChanged: true,
      dependencies: beside(install),
    });
    expect(same.message).toContain("up to date");
    expect(existsSync(old.venv("cpu"))).toBe(true);
    // An install from Settings moves it: the new copy is verified, then the old one goes.
    let cleaned = 0;
    const moved = await installVoice("gpu", {
      dirs,
      env,
      platform: "linux",
      run: fakeRunner().run,
      out: quiet,
      dependencies: beside(install),
      beforeCleanup: async () => {
        cleaned++;
      },
    });
    expect(moved.ok).toBe(true);
    const now = voiceDirs(dirs, join(install, "dependencies"));
    expect(existsSync(now.venv("gpu"))).toBe(true);
    expect(existsSync(old.venv("cpu"))).toBe(false);
    expect(existsSync(old.models)).toBe(false);
    expect(cleaned).toBe(1);
    expect(recordedVoiceRoot(readVoiceSettings(dirs))).toBe(now.root);
  });

  it("removes voice wherever it is, and never trusts a voice.json naming another folder", async () => {
    const { dirs, env, install } = world();
    await installVoice("cpu", {
      dirs,
      env,
      platform: "linux",
      run: fakeRunner().run,
      out: quiet,
      dependencies: beside(install),
    });
    const vd = voiceDirs(dirs, join(install, "dependencies"));
    expect(existsSync(vd.venv("cpu"))).toBe(true);
    const r = await removeVoice({ dirs, env, out: quiet, dependencies: beside(install) });
    expect(r.ok).toBe(true);
    expect(existsSync(vd.venv("cpu"))).toBe(false);
    expect(readVoiceSettings(dirs)?.profile).toBe("none");

    // A hand-edited voice.json pointing at someone's own folder: nothing under it is touched.
    const work = join(install, "..", "work");
    mkdirSync(join(work, "models"), { recursive: true });
    writeVoiceSettings(dirs, {
      version: 1,
      profile: "cpu",
      updatedAt: "2026-10-30T10:00:00Z",
      install: {
        venv: join(work, "myenv"),
        python: "",
        pythonVersion: "3.12.7",
        requirementsSha256: "x",
        installedAt: "2026-10-30T10:00:00Z",
      },
    });
    expect(recordedVoiceRoot(readVoiceSettings(dirs))).toBeNull();
    await removeVoice({ dirs, env, out: quiet, dependencies: beside(install) });
    expect(existsSync(join(work, "models"))).toBe(true);
  });
});
