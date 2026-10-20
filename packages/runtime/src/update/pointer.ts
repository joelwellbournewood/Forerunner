import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import {
  type AppDirs,
  ForerunnerError,
  isInside,
  join,
  newId,
  safeSegment,
} from "@forerunner/platform";
import { z } from "zod";

/**
 * The install layout (ADR 0015): every release lives in its own directory under
 * `<data>/versions/<version>/`, and one small pointer file `current.json` next to them names
 * the version to launch and the one to fall back to. The pointer is written as a temp file in
 * the same directory, fsynced and renamed over the old one, so a crash at any moment leaves
 * either the old or the new pointer, never a torn file. No symlinks or junctions: the shells
 * read the pointer and launch the named directory, which works the same on Windows and Linux.
 */
export const POINTER_FILE = "current.json";
export const VERSIONS_DIR = "versions";
const TEMP_SUFFIX = ".tmp";

export const POINTER_STATES = [
  "installed",
  "pending_health_check",
  "rolled_back",
  "failed",
] as const;
export type PointerState = (typeof POINTER_STATES)[number];

export const CurrentPointer = z.object({
  schema: z.literal(1),
  /** Version to launch; null before the first staged install (the packaged build runs). */
  current: z.string().nullable(),
  /** Known-good version to fall back to, if any. */
  previous: z.string().nullable(),
  state: z.enum(POINTER_STATES),
  updatedAt: z.string(),
  lastRollback: z
    .object({
      from: z.string(),
      to: z.string().nullable(),
      reason: z.string(),
      at: z.string(),
      automatic: z.boolean(),
    })
    .nullable(),
});
export type CurrentPointer = z.infer<typeof CurrentPointer>;

export function versionsRoot(dirs: AppDirs): string {
  return join(dirs.data, VERSIONS_DIR);
}

export function pointerPath(dirs: AppDirs): string {
  return join(versionsRoot(dirs), POINTER_FILE);
}

/** Directory of one installed version; the version is sanitised to a single path segment. */
export function versionDir(dirs: AppDirs, version: string): string {
  const seg = safeSegment(version, "");
  if (!seg || seg !== version.replace(/^v/, "")) {
    throw new ForerunnerError("validation", `version is not a safe directory name: ${version}`, {
      details: { version },
    });
  }
  return join(versionsRoot(dirs), seg);
}

/** The install may write only under <data>/versions; config, memory and the rest of data never. */
export function assertInsideVersions(dirs: AppDirs, p: string): string {
  const root = versionsRoot(dirs);
  if (!isInside(root, p) || isInside(dirs.config, p)) {
    throw new ForerunnerError("path_not_allowed", `update may not write outside ${root}`, {
      details: { path: p, root },
    });
  }
  return p;
}

/** Null when no pointer exists yet. A corrupt pointer is an error, never silently ignored. */
export function readPointer(dirs: AppDirs): CurrentPointer | null {
  const p = pointerPath(dirs);
  if (!existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new ForerunnerError("validation", `${POINTER_FILE} is not valid JSON`, {
      details: { path: p },
      cause: e,
    });
  }
  const parsed = CurrentPointer.safeParse(raw);
  if (!parsed.success) {
    throw new ForerunnerError("validation", `${POINTER_FILE} has an unknown shape`, {
      details: { path: p, issues: parsed.error.issues.slice(0, 3).map((i) => i.message) },
    });
  }
  return parsed.data;
}

/** Remove temp files left by a crash between the temp write and the rename. */
export function cleanStalePointerTemps(dirs: AppDirs): string[] {
  const root = versionsRoot(dirs);
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(`${POINTER_FILE}.`) && name.endsWith(TEMP_SUFFIX)) {
      const p = join(root, name);
      rmSync(p, { force: true });
      removed.push(p);
    }
  }
  return removed;
}

export interface WritePointerHooks {
  /** Test hook: called after the temp file is durable and before the rename. */
  beforeRename?: () => void;
}

/** Atomic write: temp file in the same directory, fsync, rename over current.json. */
export function writePointer(
  dirs: AppDirs,
  pointer: CurrentPointer,
  hooks: WritePointerHooks = {},
): string {
  const root = versionsRoot(dirs);
  mkdirSync(root, { recursive: true });
  const checked = CurrentPointer.parse(pointer);
  const final = pointerPath(dirs);
  const temp = assertInsideVersions(dirs, join(root, `${POINTER_FILE}.${newId()}${TEMP_SUFFIX}`));
  const fd = openSync(temp, "w");
  try {
    writeSync(fd, `${JSON.stringify(checked, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  hooks.beforeRename?.();
  renameSync(temp, final);
  return final;
}

/** Version directories present on disk (temp and staging entries excluded). */
export function listVersionDirs(dirs: AppDirs): string[] {
  const root = versionsRoot(dirs);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}
