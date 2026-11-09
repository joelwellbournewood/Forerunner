import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  errorMessage,
  extname,
  ForerunnerError,
  isInside,
  join,
  log,
} from "@forerunner/platform";
import type { GitOps } from "./git.ts";

/**
 * "Local only" (the owner's decision of 2026-11-02, ADR 0113): one folder inside a repository
 * project's copy on this computer whose files never leave it. The copy's `.git/info/exclude`
 * keeps it out of git; each task's run gets it inside its worktree (the Docker sandbox mounts
 * only the worktree), copied in before the run and back after it by the rules below; and every
 * push of a task branch checks in code that the branch tracks nothing under it (`GitOps.push`'s
 * `neverPush`), because `git add -f` gets past an exclude.
 *
 * Copy in: every regular file of the project's folder, never through a link (a link or a
 * Windows junction is skipped with a log line), never a path that resolves outside the folder.
 * A marker in the worktree's `.git` records the copy in (the folder and a hash of each file)
 * before the run starts, so a crash between the copy in and the copy back is recovered at the
 * next run or the daemon's start.
 *
 * Copy back: only the files the run changed or added; a file deleted in the run stays in the
 * project's folder (nothing is lost). A file the person changed in the project's folder since
 * the copy in keeps the person's version, and the agent's is kept beside it as
 * `<name> (from <task title>)<ext>` (the owner question of U-037, built as option (a)); the
 * task's result says so in one sentence. Links are never followed on the way back either. The
 * worktree's copy is removed afterwards, so the review (the critic's diff and files, the
 * project's checks, the page try) never sees it.
 */
export const LOCAL_ONLY_DIR = "Local only";

/** The one line the Files tab shows with the folder (design §3.10). */
export const LOCAL_ONLY_LINE = "Never uploaded. Agents can read and change it.";

/**
 * The sentence for a repository that already has files under `Local only/`: Forerunner makes no
 * such folder there (its files are the repository's, uploaded like any other).
 */
export const LOCAL_ONLY_TRACKED_LINE =
  "No Local only folder here: this repository already has a folder of that name.";

/**
 * Forerunner's own folder of a review's try (`loop/try-plan.ts` `TRY_FOLDER`: samples, a server
 * driver, a build folder). It is never committed or pushed either (W6-26): a daemon that died
 * in the middle of a review left it for the next commit.
 */
export const TRY_DIR = ".forerunner-try";

/** The folders no task branch carries to the host (`GitOpsOptions.neverPush`). */
export const NEVER_PUSHED: readonly string[] = [LOCAL_ONLY_DIR, TRY_DIR];

/** Where the copy in is recorded, inside the worktree's `.git` (never in the work). */
export const LOCAL_ONLY_MARKER = "forerunner-local-only.json";

const logger = log("local-only");

/** The `.git` folder of a clone; null when there is none (or it is a `gitdir:` file). */
function gitDirOf(dir: string): string | null {
  const g = join(dir, ".git");
  try {
    return statSync(g).isDirectory() ? g : null;
  } catch {
    return null;
  }
}

/**
 * The folders in `folders` kept out of git in the clone at `dir`, through its
 * `.git/info/exclude` (whatever `.gitignore` the project has, and without changing it): `git
 * add -A` then never stages them. Idempotent; false when the clone has no `.git` folder.
 *
 * With `dropOthers` (a task's worktree), Forerunner's line for a never-pushed folder that is not
 * in `folders` any more is removed (R-exclude, leftovers7-merge): a reused task worktree kept
 * '/Local only/' after the repository started tracking a folder of that name, so new files the
 * agent wrote there were silently left out of its commit. Without it (this computer's copy,
 * where the person's own files in that folder must stay out of git) lines are only added.
 * Lines the clone's owner wrote are kept as they are.
 */
export function excludeNeverPushed(
  dir: string,
  folders: readonly string[] = NEVER_PUSHED,
  opts: { dropOthers?: boolean } = {},
): boolean {
  const gitDir = gitDirOf(dir);
  if (!gitDir) return false;
  const info = join(gitDir, "info");
  mkdirSync(info, { recursive: true });
  const file = join(info, "exclude");
  const had = existsSync(file) ? readFileSync(file, "utf8") : "";
  const wanted = new Set(folders.map((f) => `/${f}/`));
  const stale = new Set(
    opts.dropOthers ? NEVER_PUSHED.map((f) => `/${f}/`).filter((l) => !wanted.has(l)) : [],
  );
  const kept = had.split(/\r?\n/).filter((l) => !stale.has(l.trim()));
  const keptText = kept.join("\n");
  if (keptText !== had) writeFileSync(file, keptText, "utf8");
  const lines = new Set(kept.map((l) => l.trim()));
  const missing = [...wanted].filter((l) => !lines.has(l));
  if (!missing.length) return true;
  const head = keptText && !keptText.endsWith("\n") ? "\n" : "";
  appendFileSync(
    file,
    `${head}# Forerunner: never committed or uploaded (Local only, a review's try).\n${missing.join("\n")}\n`,
    "utf8",
  );
  return true;
}

/** The paths under the folders, relative and with forward slashes (`Local only/a.txt`). */
export function underNeverPushed(paths: readonly string[], folders = NEVER_PUSHED): string[] {
  return paths.filter((p) => folders.some((f) => p === f || p.startsWith(`${f}/`)));
}

/** Why a push was refused: the branch tracks a path that never leaves this computer. */
export const NEVER_PUSHED_CAUSE = "never_pushed";

/**
 * A task's branch as a person may read it (C-59, polish-words; design §5.3, no ids): without the
 * task-id part `taskBranchName` puts first, "fr/1a2b3c4d-write-the-guide" reads
 * "write-the-guide". The stored name keeps it, so two tasks of one title keep two branches.
 */
export function branchWords(branch: string): string {
  return branch.replace(/^fr\/[0-9a-f]{8}-/i, "") || branch;
}

/** The refusal's sentence (design §5.8: what went wrong and what to do). */
export function neverPushedWords(branch: string, paths: readonly string[]): string {
  const first = paths[0] ?? LOCAL_ONLY_DIR;
  const more = paths.length > 1 ? ` and ${paths.length - 1} more` : "";
  const what = first.startsWith(`${TRY_DIR}/`)
    ? "Forerunner's own files of a review"
    : "files of Local only, which never leave this computer";
  return `Forerunner did not upload the branch ${branchWords(branch)}: it holds "${first}"${more}, ${what}. Press Try again to redo the work without them.`;
}

/** Whether an error is the push guard's refusal (`neverPushedWords`). */
export function isNeverPushed(e: unknown): boolean {
  return (
    e instanceof ForerunnerError &&
    (e.details as { cause?: unknown } | undefined)?.cause === NEVER_PUSHED_CAUSE
  );
}

function hashOf(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The regular files under `root`, by relative path with forward slashes, never through a link:
 * a link (a Windows junction is one to `lstat`) is skipped and named in `skipped`, and so is a
 * path whose real location is outside `root`. A `root` that is itself a link holds nothing.
 */
export function regularFilesUnder(root: string): { files: Map<string, string>; skipped: string[] } {
  const files = new Map<string, string>();
  const skipped: string[] = [];
  let rootReal: string;
  try {
    const st = lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      if (st.isSymbolicLink()) skipped.push(".");
      return { files, skipped };
    }
    rootReal = realpathSync(root);
  } catch {
    return { files, skipped };
  }
  const walk = (dir: string, prefix: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push(rel);
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 32) walk(full, rel, depth + 1);
        continue;
      }
      if (!st.isFile()) {
        skipped.push(rel);
        continue;
      }
      try {
        // A folder swapped for a link between the listing and the read lands outside: refused.
        if (!isInside(rootReal, realpathSync(full))) {
          skipped.push(rel);
          continue;
        }
      } catch {
        continue;
      }
      files.set(rel, full);
    }
  };
  walk(root, "", 0);
  return { files, skipped };
}

/** The copy in, as the marker records it. */
interface CopyInMarker {
  /** The project's Local only folder the files came from and go back to. */
  source: string;
  taskTitle: string;
  /** `copying` until every file is in the worktree; `in` while the run may change them. */
  state: "copying" | "in";
  /** Each file's hash at the copy in (the project's version, which the worktree got). */
  files: Record<string, string>;
  at: string;
}

function markerFile(worktree: string): string | null {
  const gitDir = gitDirOf(worktree);
  return gitDir ? join(gitDir, LOCAL_ONLY_MARKER) : null;
}

function readMarker(worktree: string): CopyInMarker | null {
  const file = markerFile(worktree);
  if (!file || !existsSync(file)) return null;
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as CopyInMarker;
    return typeof m.source === "string" && m.files && typeof m.files === "object" ? m : null;
  } catch {
    return null;
  }
}

function writeMarker(worktree: string, m: CopyInMarker): void {
  const file = markerFile(worktree);
  if (!file) throw new ForerunnerError("not_found", `not a git worktree: ${worktree}`);
  writeFileSync(`${file}.tmp`, JSON.stringify(m), "utf8");
  renameSync(`${file}.tmp`, file);
}

function dropMarker(worktree: string): void {
  const file = markerFile(worktree);
  if (file) rmSync(file, { force: true });
}

/** Whether the worktree holds a copy in that was never copied back (a crash, a kill). */
export function hasLocalOnlyCopy(worktree: string): boolean {
  return readMarker(worktree) !== null;
}

export interface LocalOnlyCopyIn {
  /** The files copied into the worktree's Local only folder. */
  files: number;
  /** Links and paths outside the folder that were not copied. */
  skipped: string[];
}

/**
 * The project's Local only folder (`source`) copied into `<worktree>/Local only` before a run,
 * with the marker written first (`copying`, then `in`). A worktree copy left from before (a run
 * that never copied back) must be recovered first (`copyLocalOnlyBack`); this replaces it.
 */
export function copyLocalOnlyIn(opts: {
  source: string;
  worktree: string;
  taskTitle: string;
  now: string;
}): LocalOnlyCopyIn {
  const { source, worktree } = opts;
  const dest = join(worktree, LOCAL_ONLY_DIR);
  const { files, skipped } = regularFilesUnder(source);
  for (const s of skipped)
    logger.info("Local only: a link or an outside path was not copied into the run", {
      path: `${LOCAL_ONLY_DIR}/${s}`,
    });
  const hashes: Record<string, string> = {};
  for (const [rel, abs] of files) hashes[rel] = hashOf(abs);
  const marker: CopyInMarker = {
    source,
    taskTitle: opts.taskTitle,
    state: "copying",
    files: hashes,
    at: opts.now,
  };
  writeMarker(worktree, marker);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const [rel, abs] of files) {
    const to = join(dest, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(abs, to);
    // A file that changed while it was copied: the worktree has what was copied.
    hashes[rel] = hashOf(to);
    copied++;
  }
  writeMarker(worktree, { ...marker, state: "in", files: hashes });
  return { files: copied, skipped };
}

/** A file the person changed during the run: theirs stayed, the agent's is beside it. */
export interface KeptBeside {
  /** `notes.txt`, relative to the Local only folder. */
  path: string;
  /** `notes (from Write the notes).txt`, relative to the Local only folder. */
  beside: string;
}

export interface LocalOnlyCopyBack {
  /** The files written back into the project's Local only folder. */
  written: string[];
  /** The person's changes kept, with the agent's version beside each. */
  kept: KeptBeside[];
  /** Links and paths outside the folder that were not copied back. */
  skipped: string[];
  /** The task title the marker recorded (the beside names carry it). */
  taskTitle: string;
}

/** `<task title>` as a part of a file name on Windows and Linux: no `<>:"/\|?*`, at most 50. */
function titlePart(title: string): string {
  const cleaned = title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters name no file
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50)
    .replace(/[.\s]+$/, "");
  return cleaned || "a task";
}

/**
 * `notes (from Write the notes).txt`, or `... 2.txt` when that name is taken. A folder holds
 * finitely many names, so the count ends (no clock: AGENTS.md keeps `Date.now` in platform).
 */
export function besideName(name: string, taskTitle: string, taken: (n: string) => boolean): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const base = `${stem} (from ${titlePart(taskTitle)})`;
  for (let i = 1; ; i++) {
    const n = `${base}${i === 1 ? "" : ` ${i}`}${ext}`;
    if (!taken(n)) return n;
  }
}

/**
 * `notes (yours).txt`, `data (yours)` for a folder, or `notes (yours 2).txt` when the name is
 * taken: the name a file or folder of the person's gets when the repository's would replace it.
 */
export function yoursName(name: string, folder: boolean, taken: (n: string) => boolean): string {
  const ext = folder ? "" : extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; ; i++) {
    const n = `${stem} (yours${i === 1 ? "" : ` ${i}`})${ext}`;
    if (!taken(n)) return n;
  }
}

/** A file or folder of the person's moved out of the way of the repository's. */
export interface KeptYours {
  /** Where it was, relative to the copy with forward slashes: `Local only/notes.txt`. */
  path: string;
  /** Where it is now: `Local only/notes (yours).txt`. */
  kept: string;
}

/**
 * Before a checkout of `ref` in this computer's copy of a repository (review of merged-copy,
 * ADR 0113): every file or folder of the person's under `Local only/` that a file `ref` tracks
 * would replace is renamed `<name> (yours)<ext>` first. git replaces ignored files without a
 * word, and the person's Local only files are ignored ones: a repository that started tracking
 * `Local only/notes.txt` (a collaborator's commit on GitHub) took the person's own notes.txt.
 * A path the copy's HEAD tracks is the repository's own and is left to git (a change the person
 * made to one stops the checkout). Links are moved as links, never followed. The checkout then
 * runs with `keepIgnored`, so anything still in the way stops it instead of being lost.
 */
export async function keepLocalOnlyFromCheckout(
  git: GitOps,
  dir: string,
  ref: string,
): Promise<KeptYours[]> {
  const incoming = (await git.trackedUnder(ref, [LOCAL_ONLY_DIR])) ?? [];
  if (!incoming.length) return [];
  const own = new Set((await git.trackedUnder("HEAD", [LOCAL_ONLY_DIR])) ?? []);
  const ownUnder = (q: string) => [...own].some((p) => p.startsWith(`${q}/`));
  const wanted = (q: string) => incoming.some((p) => p === q || p.startsWith(`${q}/`));
  const kept: KeptYours[] = [];
  for (const path of incoming) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const q = parts.slice(0, i).join("/");
      const abs = join(dir, ...parts.slice(0, i));
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        break; // nothing of the person's on the way
      }
      // The repository's own file here: git replaces it (or stops on the person's change).
      if (own.has(q)) break;
      const folder = st.isDirectory() && !st.isSymbolicLink();
      // A folder the repository's file goes into: look further down.
      if (i < parts.length && folder) continue;
      // A folder that holds files of the repository's: the checkout stops if it would lose one.
      if (folder && ownUnder(q)) break;
      const parent = parts.slice(0, i - 1).join("/");
      const name = yoursName(parts[i - 1] as string, folder, (n) => {
        const rel = parent ? `${parent}/${n}` : n;
        return wanted(rel) || existsSync(join(dir, ...rel.split("/")));
      });
      const to = parent ? `${parent}/${name}` : name;
      renameSync(abs, join(dir, ...to.split("/")));
      // The folder itself out of the way (the repository tracks a file named "Local only"):
      // its new name stays out of git too.
      if (i === 1) excludeNeverPushed(dir, [to]);
      kept.push({ path: q, kept: to });
      logger.info("Local only: a file of the person's kept out of the repository's way", {
        path: q,
        kept: to,
      });
      break;
    }
  }
  return kept;
}

/**
 * After the checkout: a kept file the repository's now matches byte for byte is removed (the
 * person shared it as it was), so only real differences stay beside. Returns what is left.
 */
export function dropKeptSame(dir: string, kept: readonly KeptYours[]): KeptYours[] {
  return kept.filter((k) => {
    const was = join(dir, ...k.path.split("/"));
    const now = join(dir, ...k.kept.split("/"));
    try {
      const a = lstatSync(was);
      const b = lstatSync(now);
      if (!a.isFile() || !b.isFile() || a.size !== b.size) return true;
      if (!readFileSync(was).equals(readFileSync(now))) return true;
      rmSync(now, { force: true });
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * The sentence for a repository that started tracking a folder named Local only after the copy
 * made one, while the person's own files are still in it: they stay on this computer (never
 * staged, never uploaded), and the ones the repository's would have replaced carry "(yours)".
 * `kept` names them relative to the folder (`notes (yours).txt`).
 */
export function localOnlyTakenLine(kept: readonly string[]): string {
  const head = "No Local only folder here any more: this repository now has a folder of that name.";
  if (!kept.length) return `${head} Your files in it stay on this computer.`;
  const which =
    kept.length === 1
      ? `the one named like the repository's is now ${namesText(kept)}`
      : `the ones named like the repository's are now ${namesText(kept)}`;
  return `${head} Your files in it stay on this computer; ${which}.`;
}

/**
 * The file at `rel` under `root` when every folder on the way is a real folder inside `root`
 * (no link, no junction); null when a part of the way is a link, or is not a folder.
 */
function safeTarget(root: string, rel: string): string | null {
  const parts = rel.split("/");
  let dir = root;
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return null;
  }
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    } catch {
      // A folder the person removed during the run: made again below.
      return join(root, ...parts);
    }
  }
  try {
    if (!isInside(rootReal, realpathSync(dir))) return null;
  } catch {
    return null;
  }
  return join(root, ...parts);
}

/** The hash of a regular file at `file`, null when there is none; "link" for a link. */
function currentHash(file: string): string | null {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) return "link";
    if (!st.isFile()) return "other";
    return hashOf(file);
  } catch {
    return null;
  }
}

/** Write `from` to `to` through a temporary file beside it, so a crash leaves either file whole. */
function writeWhole(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const tmp = `${to}.forerunner-tmp`;
  copyFileSync(from, tmp);
  renameSync(tmp, to);
}

/**
 * The run's changes copied back into the project's Local only folder by the rules above, then
 * the worktree's copy and the marker removed. Null when the worktree holds no copy in. A copy
 * in that never finished (`copying`) only has its partial copy removed: no run used it.
 */
export function copyLocalOnlyBack(worktree: string): LocalOnlyCopyBack | null {
  const marker = readMarker(worktree);
  if (!marker) return null;
  const local = join(worktree, LOCAL_ONLY_DIR);
  const out: LocalOnlyCopyBack = {
    written: [],
    kept: [],
    skipped: [],
    taskTitle: marker.taskTitle,
  };
  if (marker.state === "in") {
    const { files, skipped } = regularFilesUnder(local);
    out.skipped = skipped;
    for (const s of skipped)
      logger.info("Local only: a link or an outside path was not copied back", {
        path: `${LOCAL_ONLY_DIR}/${s}`,
      });
    for (const [rel, abs] of files) {
      const agent = hashOf(abs);
      const atCopyIn = marker.files[rel] ?? null;
      if (agent === atCopyIn) continue; // not changed in the run
      const target = safeTarget(marker.source, rel);
      if (!target) {
        out.skipped.push(rel);
        logger.info("Local only: a path through a link in the project's folder was not written", {
          path: `${LOCAL_ONLY_DIR}/${rel}`,
        });
        continue;
      }
      const person = currentHash(target);
      // Already there (a copy back a crash interrupted wrote it): nothing to do.
      if (person === agent) continue;
      try {
        if (person === atCopyIn) {
          writeWhole(abs, target);
          out.written.push(rel);
          continue;
        }
      } catch (e) {
        logger.warn("Local only: a file could not be replaced; the agent's is kept beside it", {
          path: `${LOCAL_ONLY_DIR}/${rel}`,
          error: errorMessage(e),
        });
      }
      // The person changed it (or made, removed or locked it) since the copy in: theirs stays.
      const dir = dirname(target);
      const name = besideName(basename(target), marker.taskTitle, (n) => existsSync(join(dir, n)));
      try {
        writeWhole(abs, join(dir, name));
        const relDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
        out.kept.push({ path: rel, beside: `${relDir}${name}` });
      } catch (e) {
        out.skipped.push(rel);
        logger.warn("Local only: the agent's version could not be kept", {
          path: `${LOCAL_ONLY_DIR}/${rel}`,
          error: errorMessage(e),
        });
      }
    }
  }
  rmSync(local, { recursive: true, force: true });
  dropMarker(worktree);
  return out;
}

/** Up to three names in quotes, then "and N more" (design §5 rule 5). */
function namesText(names: readonly string[]): string {
  const q = names.map((n) => `"${n}"`);
  const shown = q.slice(0, 3);
  const more = q.length - shown.length;
  const list =
    shown.length <= 1
      ? (shown[0] ?? "")
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return more > 0 ? `${list} and ${more} more` : list;
}

/**
 * The one sentence a task's result carries when the person changed Local only files during its
 * run (design §5: names, not paths to internals); null when nothing was kept beside.
 */
export function keptBesideSentence(back: LocalOnlyCopyBack | null): string | null {
  if (!back?.kept.length) return null;
  if (back.kept.length === 1) {
    const k = back.kept[0] as KeptBeside;
    return `You changed "${k.path}" in Local only during this run, so your version stays and the agent's is beside it as "${k.beside}".`;
  }
  return `You changed ${namesText(back.kept.map((k) => k.path))} in Local only during this run, so your versions stay and the agent's are beside them, each named "(from ${titlePart(back.taskTitle)})".`;
}

/**
 * At the daemon's start: every worktree under `worktreeRoot` that holds a copy in (the app was
 * closed or crashed during a run) is copied back by the same rules. Returns how many were.
 */
export function recoverLocalOnlyCopies(worktreeRoot: string): number {
  let names: string[];
  try {
    names = readdirSync(worktreeRoot);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const dir = join(worktreeRoot, name);
    try {
      if (!hasLocalOnlyCopy(dir)) continue;
      const back = copyLocalOnlyBack(dir);
      n++;
      logger.info("Local only: a run's copy recovered at the start", {
        worktree: name,
        written: back?.written.length ?? 0,
        keptBeside: back?.kept.length ?? 0,
      });
    } catch (e) {
      logger.warn("Local only: a run's copy not recovered", {
        worktree: name,
        error: errorMessage(e),
      });
    }
  }
  return n;
}
