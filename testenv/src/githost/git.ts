/**
 * Bare-repository operations for the fake git host. Everything is git plumbing driven through
 * `@forerunner/platform` process spawning with argv arrays (no shell, no worktree for the
 * common paths), so it behaves the same with Git for Windows and Linux git. Commits are built
 * through a temporary index file; merges go through `git merge-tree --write-tree` (git >= 2.40)
 * with a temporary-clone fallback for older git.
 */
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ForerunnerError, join, spawnProcess, toPosix } from "@forerunner/platform";

export const ZERO_SHA = "0000000000000000000000000000000000000000";

const GIT_BASE_ARGS = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.quotepath=false",
];

export interface GitExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Uint8Array | string;
  timeoutMs?: number;
}

export interface GitExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Environment for git subprocesses: the parent's, minus variables that would redirect git. */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
  ]) {
    delete env[k];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";
  return { ...env, ...extra };
}

/** Run git with binary-safe stdout. Never throws on a non-zero exit. */
export async function execGit(
  args: readonly string[],
  opts: GitExecOptions = {},
): Promise<GitExecResult> {
  const child = spawnProcess(["git", ...GIT_BASE_ARGS, ...args], {
    cwd: opts.cwd,
    env: gitEnv(opts.env),
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout?.on("data", (c: Buffer) => out.push(c));
  child.stderr?.on("data", (c: Buffer) => err.push(c));
  child.stdin?.on("error", () => {
    // the process exited before reading its input; the exit code tells the story
  });
  if (opts.input !== undefined) child.stdin?.end(opts.input);
  else child.stdin?.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolveExit(c));
  }).finally(() => clearTimeout(timer));
  return { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") };
}

/** Run git and return trimmed text; throws `ForerunnerError("internal")` on failure. */
export async function git(args: readonly string[], opts: GitExecOptions = {}): Promise<string> {
  const r = await execGit(args, opts);
  if (r.code !== 0) {
    throw new ForerunnerError("internal", `git ${args[0] ?? ""} failed: ${r.stderr.trim()}`, {
      details: { args: [...args], code: r.code },
    });
  }
  return r.stdout.toString("utf8").replace(/\r?\n$/, "");
}

let versionProbe: Promise<{ major: number; minor: number }> | null = null;

/** Parsed `git version`, cached for the process. */
export function gitVersion(): Promise<{ major: number; minor: number }> {
  if (!versionProbe) {
    versionProbe = git(["version"]).then((text) => {
      const m = /(\d+)\.(\d+)/.exec(text);
      return { major: Number(m?.[1] ?? 0), minor: Number(m?.[2] ?? 0) };
    });
  }
  return versionProbe;
}

async function supportsMergeTree(): Promise<boolean> {
  const v = await gitVersion();
  return v.major > 2 || (v.major === 2 && v.minor >= 40);
}

export interface Signature {
  name: string;
  email: string;
  date: string;
}

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: Signature;
  committer: Signature;
}

export interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size: number;
  name: string;
}

export interface DiffFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  previous_filename?: string;
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  patch?: string;
}

export type MergeTreeResult = { ok: true; tree: string } | { ok: false; conflicts: string[] };
export type MergeMethod = "merge" | "squash" | "rebase";

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CommitFilesOptions {
  /** Commit to build on; null for a root commit. */
  parent: string | null;
  /** POSIX paths to content; null deletes the path. */
  files: Record<string, string | Uint8Array | null>;
  message: string;
  author: CommitAuthor;
  committer?: CommitAuthor;
  /** ISO timestamp used for author and committer dates. */
  date: string;
}

export function authorEnv(
  author: CommitAuthor,
  committer: CommitAuthor,
  date: string,
): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    GIT_COMMITTER_DATE: date,
  };
}

const COMMIT_FORMAT = "%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B";

function parseCommitRecord(rec: string): CommitInfo | null {
  const f = rec.split("\0");
  if (f.length < 10 || !f[0]) return null;
  return {
    sha: f[0],
    tree: f[1] ?? "",
    parents: (f[2] ?? "").split(" ").filter((p) => p.length > 0),
    author: { name: f[3] ?? "", email: f[4] ?? "", date: f[5] ?? "" },
    committer: { name: f[6] ?? "", email: f[7] ?? "", date: f[8] ?? "" },
    message: (f.slice(9).join("\0") ?? "").replace(/\n+$/, ""),
  };
}

export function cleanPath(p: string): string {
  return toPosix(p).replace(/^\/+/, "").replace(/\/+$/, "");
}

/** A bare repository on disk. */
export class BareRepo {
  constructor(readonly dir: string) {}

  static async init(dir: string, defaultBranch: string): Promise<BareRepo> {
    await mkdir(dir, { recursive: true });
    await git(["init", "--bare", "--quiet", dir]);
    const repo = new BareRepo(dir);
    await repo.setHead(defaultBranch);
    return repo;
  }

  private run(args: readonly string[], opts: GitExecOptions = {}): Promise<string> {
    return git(args, { ...opts, cwd: this.dir });
  }

  private exec(args: readonly string[], opts: GitExecOptions = {}): Promise<GitExecResult> {
    return execGit(args, { ...opts, cwd: this.dir });
  }

  async setHead(branch: string): Promise<void> {
    await this.run(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  }

  async headBranch(): Promise<string> {
    const ref = await this.run(["symbolic-ref", "HEAD"]);
    return ref.replace(/^refs\/heads\//, "");
  }

  /** Resolve a ref, branch, tag or sha to a commit sha; null when it does not exist. */
  async revParse(ref: string): Promise<string | null> {
    if (!ref || ref.startsWith("-")) return null;
    const r = await this.exec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.toString("utf8").trim() : null;
  }

  async refs(): Promise<Array<{ ref: string; sha: string }>> {
    const out = await this.run([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/tags",
    ]);
    return out
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .map((l) => {
        const [ref = "", sha = ""] = l.split(" ");
        return { ref, sha };
      });
  }

  async branches(): Promise<Array<{ name: string; sha: string }>> {
    return (await this.refs())
      .filter((r) => r.ref.startsWith("refs/heads/"))
      .map((r) => ({ name: r.ref.slice("refs/heads/".length), sha: r.sha }));
  }

  /** Update a ref; when `oldSha` is given the update is compare-and-swap (null = must not exist). */
  async updateRef(ref: string, newSha: string, oldSha?: string | null): Promise<void> {
    const args = ["update-ref", ref, newSha];
    if (oldSha !== undefined) args.push(oldSha ?? ZERO_SHA);
    await this.run(args);
  }

  async deleteRef(ref: string): Promise<void> {
    await this.run(["update-ref", "-d", ref]);
  }

  async hashObject(content: Uint8Array | string): Promise<string> {
    return this.run(["hash-object", "-w", "--stdin"], { input: content });
  }

  async objectType(sha: string): Promise<string | null> {
    const r = await this.exec(["cat-file", "-t", sha]);
    return r.code === 0 ? r.stdout.toString("utf8").trim() : null;
  }

  async commitTree(
    tree: string,
    parents: string[],
    message: string,
    author: CommitAuthor,
    committer: CommitAuthor,
    date: string,
  ): Promise<string> {
    const args = ["commit-tree", tree];
    for (const p of parents) args.push("-p", p);
    args.push("-m", message.length > 0 ? message : "(no message)");
    return this.run(args, { env: authorEnv(author, committer, date) });
  }

  /** Build a commit from file changes without a worktree (temporary index). */
  async commitFiles(opts: CommitFilesOptions): Promise<string> {
    const tmpDir = join(this.dir, "fr-tmp");
    await mkdir(tmpDir, { recursive: true });
    const index = join(tmpDir, `index-${randomBytes(6).toString("hex")}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      if (opts.parent) await this.run(["read-tree", opts.parent], { env });
      else await this.run(["read-tree", "--empty"], { env });
      for (const [rawPath, content] of Object.entries(opts.files)) {
        const p = cleanPath(rawPath);
        if (!p) continue;
        if (content === null) {
          await this.run(["update-index", "--force-remove", "--", p], { env });
        } else {
          const blob = await this.hashObject(content);
          await this.run(["update-index", "--add", "--cacheinfo", `100644,${blob},${p}`], { env });
        }
      }
      const tree = await this.run(["write-tree"], { env });
      return await this.commitTree(
        tree,
        opts.parent ? [opts.parent] : [],
        opts.message,
        opts.author,
        opts.committer ?? opts.author,
        opts.date,
      );
    } finally {
      await rm(index, { force: true });
    }
  }

  async entryType(ref: string, path: string): Promise<"blob" | "tree" | null> {
    const p = cleanPath(path);
    const r = await this.exec([
      "rev-parse",
      "--verify",
      "--quiet",
      p ? `${ref}:${p}` : `${ref}^{tree}`,
    ]);
    if (r.code !== 0) return null;
    const type = await this.objectType(r.stdout.toString("utf8").trim());
    return type === "blob" || type === "tree" ? type : null;
  }

  async readBlob(
    ref: string,
    path: string,
  ): Promise<{ sha: string; size: number; content: Buffer } | null> {
    const p = cleanPath(path);
    const r = await this.exec(["rev-parse", "--verify", "--quiet", `${ref}:${p}`]);
    if (r.code !== 0) return null;
    const sha = r.stdout.toString("utf8").trim();
    if ((await this.objectType(sha)) !== "blob") return null;
    const blob = await this.exec(["cat-file", "blob", sha]);
    if (blob.code !== 0) return null;
    return { sha, size: blob.stdout.length, content: blob.stdout };
  }

  async listTree(ref: string, path: string): Promise<TreeEntry[] | null> {
    const p = cleanPath(path);
    const r = await this.exec(["ls-tree", "-l", "-z", p ? `${ref}:${p}` : `${ref}^{tree}`]);
    if (r.code !== 0) return null;
    const entries: TreeEntry[] = [];
    for (const rec of r.stdout.toString("utf8").split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      const meta = rec.slice(0, tab).split(/\s+/);
      const type = meta[1];
      if (type !== "blob" && type !== "tree" && type !== "commit") continue;
      entries.push({
        mode: meta[0] ?? "100644",
        type,
        sha: meta[2] ?? "",
        size: meta[3] === "-" ? 0 : Number(meta[3] ?? 0),
        name: rec.slice(tab + 1),
      });
    }
    return entries;
  }

  async treeOf(commit: string): Promise<string> {
    return this.run(["rev-parse", `${commit}^{tree}`]);
  }

  async commit(sha: string): Promise<CommitInfo | null> {
    const r = await this.exec(["show", "-s", `--format=${COMMIT_FORMAT}`, sha, "--"]);
    if (r.code !== 0) return null;
    return parseCommitRecord(r.stdout.toString("utf8"));
  }

  /** Commits reachable from `revs` in log order (newest first); `revs` may contain `^x` exclusions. */
  async log(revs: string[], max = 250): Promise<CommitInfo[]> {
    const r = await this.exec([
      "log",
      `--max-count=${max}`,
      `--format=${COMMIT_FORMAT}%x1e`,
      ...revs,
      "--",
    ]);
    if (r.code !== 0) return [];
    return r.stdout
      .toString("utf8")
      .split("\x1e")
      .map((rec) => parseCommitRecord(rec.replace(/^\r?\n/, "")))
      .filter((c): c is CommitInfo => c !== null);
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const r = await this.exec(["merge-base", a, b]);
    return r.code === 0 ? r.stdout.toString("utf8").trim() : null;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.exec(["merge-base", "--is-ancestor", ancestor, descendant]);
    return r.code === 0;
  }

  /** Files changed between the merge base of `base`..`head` and `head`, GitHub "pull files" style. */
  async diffFiles(base: string, head: string, withPatch = true): Promise<DiffFile[]> {
    const from = (await this.mergeBase(base, head)) ?? base;
    const numstat = await this.run(["diff", "--numstat", "-M", "-z", from, head, "--"]);
    const nameStatus = await this.run(["diff", "--name-status", "-M", "-z", from, head, "--"]);
    const counts = new Map<string, { additions: number; deletions: number }>();
    const parts = numstat.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const rec = parts[i];
      if (!rec) continue;
      const [add = "0", del = "0", name] = rec.split("\t");
      let file = name ?? "";
      if (name === undefined || name === "") {
        // rename: "adds\tdels\t" then old and new names follow as separate records
        file = parts[i + 2] ?? "";
        i += 2;
      }
      counts.set(file, {
        additions: add === "-" ? 0 : Number(add),
        deletions: del === "-" ? 0 : Number(del),
      });
    }
    const files: DiffFile[] = [];
    const st = nameStatus.split("\0");
    for (let i = 0; i < st.length; i++) {
      const code = st[i];
      if (!code) continue;
      const first = st[i + 1] ?? "";
      let filename = first;
      let previous: string | undefined;
      let status: DiffFile["status"] = "modified";
      if (code.startsWith("R") || code.startsWith("C")) {
        previous = first;
        filename = st[i + 2] ?? "";
        i += 2;
        status = "renamed";
      } else {
        i += 1;
        status = code === "A" ? "added" : code === "D" ? "removed" : "modified";
      }
      const c = counts.get(filename) ?? { additions: 0, deletions: 0 };
      const blobRef = status === "removed" ? `${from}:${filename}` : `${head}:${filename}`;
      const blob = await this.exec(["rev-parse", "--verify", "--quiet", blobRef]);
      const f: DiffFile = {
        filename,
        status,
        additions: c.additions,
        deletions: c.deletions,
        changes: c.additions + c.deletions,
        sha: blob.code === 0 ? blob.stdout.toString("utf8").trim() : "",
      };
      if (previous !== undefined) f.previous_filename = previous;
      files.push(f);
    }
    if (withPatch && files.length > 0) {
      const patch = await this.run(["diff", "-M", "--no-color", from, head, "--"]);
      const chunks = patch.split(/^(?=diff --git )/m);
      for (const chunk of chunks) {
        const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(chunk);
        if (!m) continue;
        const target = files.find((f) => f.filename === m[2]);
        if (!target) continue;
        const headerEnd = chunk.indexOf("\n@@");
        if (headerEnd !== -1) target.patch = chunk.slice(headerEnd + 1).replace(/\n$/, "");
      }
    }
    return files;
  }

  /** Merge `head` into `base` in memory. Falls back to a temporary clone on old git. */
  async mergeTree(base: string, head: string, mergeBase?: string): Promise<MergeTreeResult> {
    if (!(await supportsMergeTree())) {
      return this.mergeTreeViaClone(base, head);
    }
    const args = ["merge-tree", "--write-tree", "--name-only", "-z"];
    if (mergeBase) args.push("--merge-base", mergeBase);
    args.push(base, head);
    const r = await this.exec(args);
    const parts = r.stdout.toString("utf8").split("\0");
    if (r.code === 0) return { ok: true, tree: (parts[0] ?? "").trim() };
    if (r.code === 1) {
      const conflicts: string[] = [];
      for (const p of parts.slice(1)) {
        if (p === "") break;
        conflicts.push(p);
      }
      return { ok: false, conflicts };
    }
    throw new ForerunnerError("internal", `git merge-tree failed: ${r.stderr.trim()}`, {
      details: { code: r.code },
    });
  }

  private async mergeTreeViaClone(base: string, head: string): Promise<MergeTreeResult> {
    const tmp = await mkdtemp(join(tmpdir(), "fr-githost-merge-"));
    try {
      await git(["clone", "--quiet", "--no-checkout", this.dir, tmp]);
      await git(["checkout", "--quiet", "--detach", base], { cwd: tmp });
      const r = await execGit(["merge", "--no-commit", "--no-ff", head], {
        cwd: tmp,
        env: authorEnv(
          { name: "fake-git-host", email: "noreply@localhost" },
          { name: "fake-git-host", email: "noreply@localhost" },
          "2000-01-01T00:00:00Z",
        ),
      });
      if (r.code !== 0) {
        const names = await execGit(["diff", "--name-only", "--diff-filter=U"], { cwd: tmp });
        return {
          ok: false,
          conflicts: names.stdout.toString("utf8").split(/\r?\n/).filter(Boolean),
        };
      }
      // The tree lives in the temporary clone only; on this path callers use `ok`, and
      // merges themselves go through mergeViaClone.
      const tree = await git(["write-tree"], { cwd: tmp });
      return { ok: true, tree };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Rebase the commits of `head` not in `base` onto `base` by cherry-picking each through
   * merge-tree. Returns the new tip, or null on conflict.
   */
  async rebaseOnto(
    base: string,
    head: string,
    committer: CommitAuthor,
    date: string,
  ): Promise<string | null> {
    if (!(await supportsMergeTree()))
      return this.mergeViaClone("rebase", base, head, "", committer, date);
    const commits = (await this.log([head, `^${base}`], 1000)).reverse();
    let tip = base;
    for (const c of commits) {
      if (c.parents.length > 1) continue; // merge commits are dropped, like git rebase
      const parent = c.parents[0];
      const res = parent
        ? await this.mergeTree(tip, c.sha, parent)
        : await this.mergeTree(tip, c.sha);
      if (!res.ok) return null;
      if (res.tree === (await this.treeOf(tip))) continue; // became empty
      tip = await this.commitTree(res.tree, [tip], c.message, c.author, committer, date);
    }
    return tip;
  }

  /**
   * Perform a merge of `head` into branch `base` with the given method and update the branch.
   * Returns the new tip, or null when the merge conflicts.
   */
  async mergeInto(
    method: MergeMethod,
    baseBranch: string,
    head: string,
    message: string,
    committer: CommitAuthor,
    date: string,
    author: CommitAuthor = committer,
  ): Promise<string | null> {
    const baseSha = await this.revParse(`refs/heads/${baseBranch}`);
    if (!baseSha) return null;
    if (!(await supportsMergeTree())) {
      return this.mergeViaClone(method, baseBranch, head, message, committer, date);
    }
    let tip: string | null;
    if (method === "rebase") {
      tip = await this.rebaseOnto(baseSha, head, committer, date);
    } else {
      const res = await this.mergeTree(baseSha, head);
      if (!res.ok) return null;
      tip =
        method === "merge"
          ? await this.commitTree(res.tree, [baseSha, head], message, author, committer, date)
          : await this.commitTree(res.tree, [baseSha], message, author, committer, date);
    }
    if (!tip) return null;
    await this.updateRef(`refs/heads/${baseBranch}`, tip, baseSha);
    return tip;
  }

  private async mergeViaClone(
    method: MergeMethod,
    baseBranch: string,
    head: string,
    message: string,
    committer: CommitAuthor,
    date: string,
  ): Promise<string | null> {
    const tmp = await mkdtemp(join(tmpdir(), "fr-githost-merge-"));
    const env = authorEnv(committer, committer, date);
    try {
      await git(["clone", "--quiet", "--branch", baseBranch, this.dir, tmp]);
      let r: GitExecResult;
      if (method === "merge") {
        r = await execGit(["merge", "--no-ff", "--no-edit", "-m", message, head], {
          cwd: tmp,
          env,
        });
      } else if (method === "squash") {
        r = await execGit(["merge", "--squash", head], { cwd: tmp, env });
        if (r.code === 0)
          r = await execGit(["commit", "--quiet", "-m", message], { cwd: tmp, env });
      } else {
        await git(["checkout", "--quiet", "-b", "fr-rebase", head], { cwd: tmp, env });
        r = await execGit(["rebase", "--quiet", baseBranch], { cwd: tmp, env });
        if (r.code === 0) {
          await git(["checkout", "--quiet", baseBranch], { cwd: tmp, env });
          await git(["merge", "--ff-only", "--quiet", "fr-rebase"], { cwd: tmp, env });
        }
      }
      if (r.code !== 0) return null;
      const tip = await git(["rev-parse", "HEAD"], { cwd: tmp });
      await git(["push", "--quiet", "origin", `HEAD:refs/heads/${baseBranch}`], { cwd: tmp, env });
      return tip;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

/** Locate `git-http-backend` (with or without `.exe`) next to git's other helpers. */
export async function locateHttpBackend(): Promise<string | null> {
  const r = await execGit(["--exec-path"]);
  if (r.code !== 0) return null;
  const dir = r.stdout.toString("utf8").trim();
  if (!dir) return null;
  for (const name of ["git-http-backend", "git-http-backend.exe"]) {
    const candidate = join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next spelling
    }
  }
  return null;
}
