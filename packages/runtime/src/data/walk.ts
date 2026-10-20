import { lstatSync, readdirSync } from "node:fs";
import { extname, join, relative, toPosix } from "@forerunner/platform";

/**
 * A bounded, symlink-free walk of a folder. Used to describe linked folders, to copy small
 * ones and to import. It never follows symlinks (Windows and Linux alike) and stops at the
 * entry, byte and depth limits so a mounted drive cannot stall the daemon.
 */
export interface WalkLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxDepth: number;
}

export interface WalkEntry {
  /** Absolute path. */
  path: string;
  /** Path relative to the root, forward slashes. */
  rel: string;
  sizeBytes: number;
}

export interface WalkResult {
  files: WalkEntry[];
  dirs: number;
  totalBytes: number;
  skipped: { rel: string; reason: string }[];
  /** True when a limit stopped the walk before the end. */
  truncated: boolean;
  /** Which limit stopped it. */
  limit: "entries" | "bytes" | "depth" | null;
  /** File count per lower-cased extension ("" for none). */
  extensions: Record<string, number>;
}

/** Directory names never walked: VCS internals and dependency trees. */
export const WALK_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".hg",
  ".svn",
  "__pycache__",
]);

export function walkFolder(
  root: string,
  limits: WalkLimits,
  opts: { ignoreDirs?: ReadonlySet<string> } = {},
): WalkResult {
  const ignore = opts.ignoreDirs ?? WALK_IGNORED_DIRS;
  const res: WalkResult = {
    files: [],
    dirs: 0,
    totalBytes: 0,
    skipped: [],
    truncated: false,
    limit: null,
    extensions: {},
  };
  let entries = 0;
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && !res.truncated) {
    const cur = stack.pop();
    if (!cur) break;
    let names: string[];
    try {
      names = readdirSync(cur.dir).sort();
    } catch (e) {
      res.skipped.push({
        rel: toPosix(relative(root, cur.dir)) || ".",
        reason: `unreadable: ${msg(e)}`,
      });
      continue;
    }
    for (const name of names) {
      const p = join(cur.dir, name);
      const rel = toPosix(relative(root, p));
      entries++;
      if (entries > limits.maxEntries) {
        res.truncated = true;
        res.limit = "entries";
        break;
      }
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch (e) {
        res.skipped.push({ rel, reason: `unreadable: ${msg(e)}` });
        continue;
      }
      if (st.isSymbolicLink()) {
        res.skipped.push({ rel, reason: "symlink" });
        continue;
      }
      if (st.isDirectory()) {
        if (ignore.has(name)) {
          res.skipped.push({ rel, reason: "ignored directory" });
          continue;
        }
        res.dirs++;
        if (cur.depth + 1 >= limits.maxDepth) {
          res.truncated = true;
          res.limit = "depth";
          res.skipped.push({ rel, reason: "deeper than the walk limit" });
          continue;
        }
        stack.push({ dir: p, depth: cur.depth + 1 });
        continue;
      }
      if (!st.isFile()) {
        res.skipped.push({ rel, reason: "not a regular file" });
        continue;
      }
      if (res.totalBytes + st.size > limits.maxTotalBytes) {
        res.truncated = true;
        res.limit = "bytes";
        break;
      }
      res.totalBytes += st.size;
      res.files.push({ path: p, rel, sizeBytes: st.size });
      const ext = extname(name).toLowerCase();
      res.extensions[ext] = (res.extensions[ext] ?? 0) + 1;
    }
  }
  res.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return res;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
