import os from "node:os";
import path from "node:path";
import { currentPlatform } from "./os.ts";

/**
 * All path handling goes through this module. Nothing else in Forerunner may
 * concatenate paths with "/" or "\\" by hand (the lint rule in CI checks this).
 */

export const sep = path.sep;

export function join(...parts: string[]): string {
  return path.join(...parts);
}

export function resolve(...parts: string[]): string {
  return path.resolve(...parts);
}

export function dirname(p: string): string {
  return path.dirname(p);
}

export function basename(p: string, ext?: string): string {
  return path.basename(p, ext);
}

export function extname(p: string): string {
  return path.extname(p);
}

export function isAbsolute(p: string): boolean {
  return path.isAbsolute(p);
}

export function relative(from: string, to: string): string {
  return path.relative(from, to);
}

/** Convert any path to forward slashes, for display, URLs and git. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/").replace(/\\/g, "/");
}

/** Convert a forward-slash path (from config, git or URLs) to the native form. */
export function fromPosix(p: string): string {
  return p.split("/").join(path.sep);
}

/** Normalise and strip trailing separators; keeps roots intact. */
export function normalize(p: string): string {
  const n = path.normalize(p);
  if (n.length > 1 && (n.endsWith(path.sep) || n.endsWith("/"))) {
    const stripped = n.replace(/[\\/]+$/, "");
    return stripped.length === 0 ? n : stripped;
  }
  return n;
}

/** True when `child` is inside `parent` (or equal). Case-insensitive on Windows. */
export function isInside(parent: string, child: string): boolean {
  let rel = path.relative(path.resolve(parent), path.resolve(child));
  if (currentPlatform() === "windows") rel = rel.toLowerCase();
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface AppDirs {
  /** Config: settings, device identity, pairing. */
  config: string;
  /** Data: SQLite state, memory, docs cache, audit log. */
  data: string;
  /** Cache: compressed context, model lists, downloads. */
  cache: string;
  /** Logs. */
  logs: string;
  /** Working trees for sandboxed tasks. */
  worktrees: string;
  /** Runtime sockets / pid files. */
  runtime: string;
}

export interface AppDirsOptions {
  appName?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: ReturnType<typeof currentPlatform>;
}

/**
 * Per-OS application directories, following the Windows known-folder layout and the
 * XDG base directory spec on Linux. FORERUNNER_HOME overrides everything (used by
 * tests and by the two-install test environment).
 */
export function appDirs(opts: AppDirsOptions = {}): AppDirs {
  const appName = opts.appName ?? "forerunner";
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  const platform = opts.platform ?? currentPlatform();

  const override = env.FORERUNNER_HOME;
  if (override) {
    const root = path.resolve(override);
    return {
      config: path.join(root, "config"),
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      logs: path.join(root, "logs"),
      worktrees: path.join(root, "worktrees"),
      runtime: path.join(root, "runtime"),
    };
  }

  if (platform === "windows") {
    const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return {
      config: path.join(appData, appName, "config"),
      data: path.join(localAppData, appName, "data"),
      cache: path.join(localAppData, appName, "cache"),
      logs: path.join(localAppData, appName, "logs"),
      worktrees: path.join(localAppData, appName, "worktrees"),
      runtime: path.join(localAppData, appName, "runtime"),
    };
  }

  if (platform === "macos") {
    const lib = path.join(home, "Library");
    return {
      config: path.join(lib, "Application Support", appName, "config"),
      data: path.join(lib, "Application Support", appName, "data"),
      cache: path.join(lib, "Caches", appName),
      logs: path.join(lib, "Logs", appName),
      worktrees: path.join(lib, "Application Support", appName, "worktrees"),
      runtime: path.join(lib, "Application Support", appName, "runtime"),
    };
  }

  // Linux and anything else: XDG.
  const xdgConfig = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  const xdgData = env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  const xdgCache = env.XDG_CACHE_HOME ?? path.join(home, ".cache");
  const xdgState = env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
  const xdgRuntime = env.XDG_RUNTIME_DIR ?? path.join(xdgCache, appName, "runtime");
  return {
    config: path.join(xdgConfig, appName),
    data: path.join(xdgData, appName),
    cache: path.join(xdgCache, appName),
    logs: path.join(xdgState, appName, "logs"),
    worktrees: path.join(xdgData, appName, "worktrees"),
    runtime: path.join(xdgRuntime, appName),
  };
}

/** Make a string safe to use as a single path segment on every OS. */
export function safeSegment(name: string, fallback = "item"): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (!cleaned || reserved.test(cleaned)) return fallback;
  return cleaned;
}

/** Normalise line endings to LF. Used for everything we write to git or compare. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
