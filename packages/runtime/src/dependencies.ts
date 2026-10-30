import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AppDirs, dirname, errorMessage, join, resolve } from "@forerunner/platform";
import { BUNDLED_RUNTIME_MARKER } from "./registry/loader.ts";

/**
 * Where downloaded dependencies go (U-011 in docs/status/UPDATE-LOG.md): the local voice
 * packages and models today, several GB with the GPU profile. The owner's rule: by default a
 * dedicated subfolder of the folder the app is installed in, so installing on another drive to
 * spare C: spares it for these too. In order:
 *
 * 1. `FORERUNNER_DEPENDENCIES_DIR`, as given.
 * 2. `<install folder>/dependencies`, when the runtime is the one an installer carries (its
 *    payload root holds `runtime.json`; the install folder is that root's parent) and the
 *    folder can be written. An update or uninstall replaces what the installer put there and
 *    leaves this folder alone.
 *    An AppImage runs from a read-only mount (or a temporary extraction): its install folder is
 *    the one holding the `.AppImage` file (`APPIMAGE`), and the subfolder is named
 *    `Forerunner-dependencies` there, since that folder is not Forerunner's own.
 * 3. The data folder (`appDirs().data`), when the app runs from a checkout or the install folder
 *    cannot be written (Program Files for a normal user, /usr/lib); `note` then says why.
 */
export const DEPENDENCIES_SUBDIR = "dependencies";
/** The subfolder beside an AppImage file (`APPIMAGE`), whose folder may hold anything. */
export const APPIMAGE_DEPENDENCIES_SUBDIR = "Forerunner-dependencies";

export interface DependenciesDir {
  dir: string;
  source: "env" | "install" | "data";
  /** Why the data folder was used although the app is installed; null otherwise. */
  note: string | null;
}

export interface DependenciesOptions {
  /** The install folder; default: found from this file's location (`installedAppDir`). */
  installDir?: string | null;
  /** Whether a folder can be created and written; default: a probe file. */
  writable?: (dir: string) => true | string;
}

/**
 * The folder the app is installed in: the parent of the runtime payload root (the directory
 * holding `runtime.json`), searched upward from `startDir`. Null in a repository checkout.
 */
export function installedAppDir(
  startDir: string = dirname(fileURLToPath(import.meta.url)),
  exists: (p: string) => boolean = existsSync,
  maxDepth = 8,
): string | null {
  let current = startDir;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (exists(join(current, BUNDLED_RUNTIME_MARKER))) return dirname(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** Create `dir` and write a probe file in it: true, or the reason it cannot be written. */
export function probeWritable(dir: string): true | string {
  const probe = join(dir, `.write-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch (e) {
    return errorMessage(e);
  }
}

export function resolveDependenciesDir(
  env: NodeJS.ProcessEnv,
  dirs: Pick<AppDirs, "data">,
  opts: DependenciesOptions = {},
): DependenciesDir {
  const override = env.FORERUNNER_DEPENDENCIES_DIR?.trim();
  if (override) return { dir: resolve(override), source: "env", note: null };
  const appImage = env.APPIMAGE?.trim();
  const installDir =
    opts.installDir !== undefined
      ? opts.installDir
      : appImage
        ? dirname(appImage)
        : installedAppDir();
  if (!installDir) return { dir: dirs.data, source: "data", note: null };
  const candidate = join(
    installDir,
    appImage && opts.installDir === undefined ? APPIMAGE_DEPENDENCIES_SUBDIR : DEPENDENCIES_SUBDIR,
  );
  const ok = (opts.writable ?? probeWritable)(candidate);
  if (ok === true) return { dir: candidate, source: "install", note: null };
  return {
    dir: dirs.data,
    source: "data",
    note: `The install folder ${installDir} cannot be written (${ok.split("\n")[0]}), so dependencies go to the data folder ${dirs.data}. Install Forerunner into a folder you can write to, or set FORERUNNER_DEPENDENCIES_DIR, to keep them elsewhere.`,
  };
}
