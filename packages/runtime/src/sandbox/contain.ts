import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, realpath, stat } from "node:fs/promises";
import {
  dirname,
  ForerunnerError,
  fromPosix,
  isAbsolute,
  isInside,
  join,
  normalizeNewlines,
  relative,
  resolve,
  toPosix,
} from "@forerunner/platform";

/**
 * Path containment shared by every sandbox adapter: a relative path from a tool or a caller
 * must stay inside the worktree.
 *
 * Two checks exist because the host-side file helpers of the container and process sandboxes
 * operate on a directory that model-controlled code can change at the same time:
 *
 * - `containPath` is lexical: absolute paths, drive letters, UNC prefixes and any ".." that
 *   climbs out are refused with `path_not_allowed`. It is enough for a cwd that is resolved
 *   inside the container's own mount namespace and for the in-memory fake.
 * - `containPathReal` additionally walks the path on disk and refuses any symlink (or junction
 *   on Windows) that leaves the real worktree root, so a `ln -s /home/user link` planted by a
 *   sandboxed command or committed in a cloned repository cannot turn `readFile("link/x")`
 *   or `writeFile("link/x")` into host access. Every host-side read, write and exists check
 *   goes through it.
 */
export interface ContainedPath {
  /** Absolute host path. After `containPathReal` this is the real (symlink-resolved) path. */
  host: string;
  /** Forward-slash path relative to the worktree ("" for the root). */
  rel: string;
}

/** Longest chain of symlinks followed before the walk gives up (matches the kernel's limit). */
const MAX_SYMLINK_DEPTH = 40;

export function containPath(worktree: string, relPath: string): ContainedPath {
  const raw = relPath ?? "";
  if (raw.includes("\0")) throw refuse(raw, "contains NUL");
  const native = fromPosix(raw);
  if (isAbsolute(native) || /^[A-Za-z]:/.test(raw) || /^[\\/]{2}/.test(raw)) {
    throw refuse(raw, "absolute paths are not allowed; use a path relative to the worktree");
  }
  const root = resolve(worktree);
  const host = resolve(join(root, native));
  if (!isInside(root, host)) throw refuse(raw, "escapes the worktree");
  const rel = toPosix(relative(root, host));
  return { host, rel: rel === "." ? "" : rel };
}

/**
 * Lexical containment followed by a symlink-aware walk on disk. The returned `host` is the
 * real path to use for I/O: every existing component has been checked with `lstat`, every
 * symlink resolved and re-checked against the real worktree root, and the walk stops at the
 * first component that does not exist yet (nothing below it can be a link). A dangling link
 * is resolved lexically against its own directory and checked the same way, so a write
 * through it cannot land outside either.
 */
export async function containPathReal(worktree: string, relPath: string): Promise<ContainedPath> {
  const lex = containPath(worktree, relPath);
  const root = resolve(worktree);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (e) {
    throw new ForerunnerError("not_found", `worktree does not exist: ${root}`, { cause: e });
  }
  const parts = lex.rel === "" ? [] : lex.rel.split("/");
  const host = await walk(realRoot, realRoot, parts, relPath, 0);
  return { host, rel: lex.rel };
}

async function walk(
  realRoot: string,
  start: string,
  parts: string[],
  raw: string,
  depth: number,
): Promise<string> {
  let cur = start;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    const next = join(cur, part);
    const st = await lstat(next).catch(() => null);
    if (!st) {
      // Nothing beyond this point exists, so nothing beyond it can be a link.
      return join(next, ...parts.slice(i + 1));
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (depth >= MAX_SYMLINK_DEPTH) throw refuse(raw, "too many levels of symbolic links");
    const sofar = parts.slice(0, i + 1).join("/");
    let target = await realpath(next).catch(() => null);
    if (target === null) {
      // Dangling link: resolve its text against its own directory, then walk that lexically
      // contained path from the root so links inside it are checked too.
      const text = await readlink(next).catch(() => null);
      if (text === null) throw refuse(raw, `symlink ${sofar} cannot be read`);
      const lexical = resolve(dirname(next), fromPosix(text));
      if (!isInside(realRoot, lexical)) throw refuse(raw, `symlink ${sofar} leaves the worktree`);
      const relParts = toPosix(relative(realRoot, lexical));
      target = await walk(
        realRoot,
        realRoot,
        relParts === "" ? [] : relParts.split("/"),
        raw,
        depth + 1,
      );
    }
    if (!isInside(realRoot, target)) throw refuse(raw, `symlink ${sofar} leaves the worktree`);
    cur = target;
  }
  return cur;
}

/** Read a text file inside the worktree (symlink-aware containment). */
export async function readWorktreeFile(worktree: string, relPath: string): Promise<string> {
  const { host } = await containPathReal(worktree, relPath);
  try {
    return await readFile(host, "utf8");
  } catch (e) {
    throw new ForerunnerError("not_found", `file not found in worktree: ${relPath}`, { cause: e });
  }
}

/**
 * Write a text file inside the worktree with LF endings, creating parents. The final open
 * uses O_NOFOLLOW where the OS has it (Linux, macOS) so a link planted between the walk and
 * the write cannot redirect it; Windows has no equivalent flag and relies on the walk.
 */
export async function writeWorktreeFile(
  worktree: string,
  relPath: string,
  content: string,
): Promise<void> {
  const { host } = await containPathReal(worktree, relPath);
  await mkdir(dirname(host), { recursive: true });
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(host, flags, 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw refuse(relPath, "target became a symbolic link during the write");
    }
    throw e;
  }
  try {
    await fh.writeFile(normalizeNewlines(content), "utf8");
  } finally {
    await fh.close();
  }
}

/** True when the path exists inside the worktree; throws `path_not_allowed` for escapes. */
export async function worktreeFileExists(worktree: string, relPath: string): Promise<boolean> {
  const { host } = await containPathReal(worktree, relPath);
  return (await stat(host).catch(() => null)) !== null;
}

function refuse(p: string, why: string): ForerunnerError {
  return new ForerunnerError("path_not_allowed", `sandbox path refused (${why}): ${p}`, {
    details: { path: p },
  });
}
