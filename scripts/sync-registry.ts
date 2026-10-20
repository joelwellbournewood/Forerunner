#!/usr/bin/env -S pnpm exec tsx
/**
 * sync-registry: keep evals/registry/ (the mirror used by tests) and the forerunner-registry
 * repository (the source of truth once it exists) in step. No network: both sides are
 * directories on this machine.
 *
 *   tsx scripts/sync-registry.ts                 dry run: what would change (target from
 *                                                FORERUNNER_REGISTRY_DIR, else ../forerunner-registry)
 *   tsx scripts/sync-registry.ts --apply         copy evals/registry/** into FORERUNNER_REGISTRY_DIR
 *   tsx scripts/sync-registry.ts --apply --pull  copy the registry checkout into evals/registry/
 *   --to <dir>     target instead of FORERUNNER_REGISTRY_DIR
 *   --prune        also delete files that exist only in the target
 *   --force        overwrite a target that changed since the last sync (see .sync.json)
 *
 * evals/registry/.sync.json records the hash of the registry after the last sync; a push refuses
 * to overwrite a registry whose hash moved since then, so edits made on the wrong side are
 * noticed rather than lost.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Clock,
  dirname,
  fromPosix,
  join,
  normalizeNewlines,
  resolve,
  systemClock,
  toPosix,
} from "@forerunner/platform";

export const SYNC_STATE_FILE = ".sync.json";
export const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  SYNC_STATE_FILE,
  ".DS_Store",
  "Thumbs.db",
]);

export interface SyncState {
  lastSyncedHash: string;
  syncedAt: string;
  target: string;
}

export interface Diff {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
}

export interface SyncOptions {
  /** The repository mirror, evals/registry. */
  mirror: string;
  /** The forerunner-registry checkout. */
  registry: string;
  /** Copy registry -> mirror instead of mirror -> registry. */
  pull?: boolean;
  dryRun?: boolean;
  prune?: boolean;
  force?: boolean;
  clock?: Clock;
  log?: (line: string) => void;
}

export interface SyncResult {
  direction: "push" | "pull";
  source: string;
  target: string;
  diff: Diff;
  applied: boolean;
  refused?: string;
}

/** Relative POSIX paths of every file under dir (sorted), ignoring git, node_modules and state. */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs, relPath);
      else out.push(relPath);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** sha256 of the newline-normalised content, so Windows and Linux checkouts agree. */
export function fileHash(file: string): string {
  const raw = readFileSync(file);
  const text = raw.toString("utf8");
  const isText = !raw.includes(0);
  return createHash("sha256")
    .update(isText ? normalizeNewlines(text) : raw)
    .digest("hex");
}

/** One hash for the whole tree: sorted "path hash" lines. */
export function treeHash(dir: string): string {
  const h = createHash("sha256");
  for (const rel of listFiles(dir)) {
    h.update(`${rel} ${fileHash(join(dir, fromPosix(rel)))}\n`);
  }
  return h.digest("hex");
}

export function diffTrees(source: string, target: string): Diff {
  const src = new Set(listFiles(source));
  const dst = new Set(listFiles(target));
  const diff: Diff = { added: [], changed: [], removed: [], unchanged: [] };
  for (const rel of src) {
    if (!dst.has(rel)) diff.added.push(rel);
    else if (fileHash(join(source, fromPosix(rel))) !== fileHash(join(target, fromPosix(rel))))
      diff.changed.push(rel);
    else diff.unchanged.push(rel);
  }
  for (const rel of dst) if (!src.has(rel)) diff.removed.push(rel);
  return diff;
}

export function readSyncState(mirror: string): SyncState | null {
  const p = join(mirror, SYNC_STATE_FILE);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<SyncState>;
    if (typeof parsed.lastSyncedHash !== "string") return null;
    return {
      lastSyncedHash: parsed.lastSyncedHash,
      syncedAt: typeof parsed.syncedAt === "string" ? parsed.syncedAt : "",
      target: typeof parsed.target === "string" ? parsed.target : "",
    };
  } catch {
    return null;
  }
}

export function writeSyncState(mirror: string, state: SyncState): void {
  mkdirSync(mirror, { recursive: true });
  writeFileSync(join(mirror, SYNC_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** Where the registry checkout is: FORERUNNER_REGISTRY_DIR, else a sibling of the repo. */
export function resolveRegistryDir(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): { dir: string; source: "env" | "sibling" | "none" } {
  if (env.FORERUNNER_REGISTRY_DIR)
    return { dir: resolve(env.FORERUNNER_REGISTRY_DIR), source: "env" };
  const sibling = resolve(repoRoot, "..", "forerunner-registry");
  if (existsSync(sibling)) return { dir: sibling, source: "sibling" };
  return { dir: sibling, source: "none" };
}

export function formatDiff(diff: Diff): string {
  const lines: string[] = [];
  for (const f of diff.added) lines.push(`  + ${f}`);
  for (const f of diff.changed) lines.push(`  ~ ${f}`);
  for (const f of diff.removed) lines.push(`  - ${f} (only in target)`);
  lines.push(
    `  ${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} only in target, ${diff.unchanged.length} unchanged`,
  );
  return lines.join("\n");
}

/** Copy one tree into the other; dry run by default. */
export function syncRegistry(opts: SyncOptions): SyncResult {
  const log = opts.log ?? ((line: string) => console.log(line));
  const clock = opts.clock ?? systemClock;
  const direction: "push" | "pull" = opts.pull ? "pull" : "push";
  const source = opts.pull ? opts.registry : opts.mirror;
  const target = opts.pull ? opts.mirror : opts.registry;
  const diff = diffTrees(source, target);
  log(
    `sync-registry: ${direction} ${toPosix(source)} -> ${toPosix(target)}${opts.dryRun ? " (dry run)" : ""}`,
  );
  log(formatDiff(diff));
  const result: SyncResult = { direction, source, target, diff, applied: false };
  if (opts.dryRun) return result;

  if (direction === "push" && !opts.force && listFiles(target).length > 0) {
    const state = readSyncState(opts.mirror);
    const current = treeHash(target);
    if (state && state.lastSyncedHash !== current) {
      result.refused = `the registry at ${target} changed since the last sync (${state.syncedAt || "unknown"}); pull first (--pull) or pass --force`;
      log(`sync-registry: refused: ${result.refused}`);
      return result;
    }
    if (!state && (diff.changed.length > 0 || diff.removed.length > 0)) {
      result.refused = `the registry at ${target} has content that differs from the mirror and no .sync.json records a previous sync; pass --force to overwrite or --pull to take its content`;
      log(`sync-registry: refused: ${result.refused}`);
      return result;
    }
  }

  for (const rel of [...diff.added, ...diff.changed]) {
    const from = join(source, fromPosix(rel));
    const to = join(target, fromPosix(rel));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  if (opts.prune) {
    for (const rel of diff.removed) rmSync(join(target, fromPosix(rel)), { force: true });
  }
  result.applied = true;
  const registryHash = treeHash(opts.registry);
  writeSyncState(opts.mirror, {
    lastSyncedHash: registryHash,
    syncedAt: clock.nowIso(),
    target: toPosix(opts.registry),
  });
  log(
    `sync-registry: copied ${diff.added.length + diff.changed.length} file(s)${opts.prune ? `, removed ${diff.removed.length}` : ""}; registry hash ${registryHash.slice(0, 12)}`,
  );
  return result;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "\u0000");
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const mirror = join(repoRoot, "evals", "registry");
  const explicit = arg("--to");
  const resolved = explicit
    ? { dir: resolve(explicit), source: "env" as const }
    : resolveRegistryDir(process.env, repoRoot);
  const apply = process.argv.includes("--apply");
  const pull = process.argv.includes("--pull");
  if (resolved.source === "none") {
    console.log(
      `sync-registry: no registry checkout found (set FORERUNNER_REGISTRY_DIR or pass --to <dir>; looked for ${toPosix(resolved.dir)}).`,
    );
    console.log("sync-registry: files that would be copied from evals/registry:");
    for (const f of listFiles(mirror)) console.log(`  + ${f}`);
    process.exit(apply ? 2 : 0);
  }
  if (!existsSync(mirror) && !pull) {
    console.error(`sync-registry: mirror ${toPosix(mirror)} does not exist`);
    process.exit(2);
  }
  const result = syncRegistry({
    mirror,
    registry: resolved.dir,
    pull,
    dryRun: !apply,
    prune: process.argv.includes("--prune"),
    force: process.argv.includes("--force"),
  });
  if (!apply) console.log("sync-registry: dry run; pass --apply to copy");
  process.exit(result.refused ? 1 : 0);
}
