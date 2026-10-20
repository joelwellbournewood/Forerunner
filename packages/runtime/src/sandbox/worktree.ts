import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import {
  type Clock,
  dirname,
  ForerunnerError,
  isInside,
  join,
  log,
  normalize,
  run as platformRun,
  resolve,
  safeSegment,
  systemClock,
} from "@forerunner/platform";
import type { RunFn } from "./types.ts";

/**
 * One git worktree per task under `appDirs().worktrees`. The worktree is the only host path a
 * sandbox ever sees. A sidecar `<segment>.json` next to each worktree records which task and
 * repository it belongs to, so `list()` works without a database and `remove()` knows which
 * repository to tell.
 */
export interface WorktreeManagerOptions {
  /** Root directory that holds every worktree; nothing outside it is ever removed. */
  root: string;
  run?: RunFn;
  clock?: Clock;
  /** Command timeout for git calls; default 2 minutes. */
  gitTimeoutMs?: number;
}

export interface CreateWorktreeInput {
  repoDir: string;
  /** Branch created or reset for the task (`git worktree add -B`). */
  branch: string;
  taskId: string;
  /** Commit-ish the branch starts from. Default HEAD of the repository. */
  base?: string;
}

export interface WorktreeInfo {
  path: string;
  repoDir: string;
  branch: string;
  taskId: string;
  createdAt: string;
}

const SIDECAR_SUFFIX = ".worktree.json";

export class WorktreeManager {
  readonly root: string;
  private readonly run: RunFn;
  private readonly clock: Clock;
  private readonly gitTimeoutMs: number;
  private readonly logger = log("sandbox:worktree");

  constructor(opts: WorktreeManagerOptions) {
    this.root = resolve(opts.root);
    this.run = opts.run ?? platformRun;
    this.clock = opts.clock ?? systemClock;
    this.gitTimeoutMs = opts.gitTimeoutMs ?? 120_000;
  }

  /** True when `p` is inside the root (and not the root itself). */
  isInside(p: string): boolean {
    const abs = resolve(p);
    return isInside(this.root, abs) && normalize(abs) !== normalize(this.root);
  }

  pathFor(taskId: string): string {
    return join(this.root, safeSegment(taskId, "task"));
  }

  async create(input: CreateWorktreeInput): Promise<WorktreeInfo> {
    if (!input.branch.trim() || /\s/.test(input.branch) || input.branch.startsWith("-")) {
      throw new ForerunnerError("validation", `invalid branch name: ${input.branch}`);
    }
    const base = input.base ?? "HEAD";
    if (!base.trim() || /\s/.test(base) || base.startsWith("-")) {
      // A base such as "--detach" would reach git as an option.
      throw new ForerunnerError("validation", `invalid base revision: ${base}`);
    }
    const path = this.pathFor(input.taskId);
    await mkdir(this.root, { recursive: true });
    if (await exists(path)) {
      throw new ForerunnerError("validation", `worktree already exists, remove it first: ${path}`, {
        details: { path, taskId: input.taskId },
      });
    }
    const repoDir = resolve(input.repoDir);
    const r = await this.run(
      ["git", "-C", repoDir, "worktree", "add", "-B", input.branch, path, base],
      { allowFailure: true, timeoutMs: this.gitTimeoutMs },
    );
    if (r.code !== 0) {
      throw new ForerunnerError("internal", `git worktree add failed: ${r.stderr.trim()}`, {
        details: { repoDir, path, branch: input.branch, base },
      });
    }
    const info: WorktreeInfo = {
      path,
      repoDir,
      branch: input.branch,
      taskId: input.taskId,
      createdAt: this.clock.nowIso(),
    };
    await writeFile(this.sidecarFor(path), `${JSON.stringify(info, null, 2)}\n`, "utf8");
    this.logger.info("worktree created", { path, branch: input.branch, taskId: input.taskId });
    return info;
  }

  /** Worktrees under the root, from their sidecars (worktrees without one are reported too). */
  async list(): Promise<WorktreeInfo[]> {
    if (!(await exists(this.root))) return [];
    const entries = await readdir(this.root, { withFileTypes: true });
    const out: WorktreeInfo[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(SIDECAR_SUFFIX)) continue;
      try {
        const info = JSON.parse(await readFile(join(this.root, e.name), "utf8")) as WorktreeInfo;
        if (typeof info.path !== "string" || !this.isInside(info.path)) continue;
        if (!(await exists(info.path))) continue;
        out.push(info);
        seen.add(normalize(info.path));
      } catch {
        // a corrupt sidecar is skipped; the directory scan below still lists the worktree
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(this.root, e.name);
      if (seen.has(normalize(path))) continue;
      const repoDir = await repoDirOf(path);
      if (!repoDir) continue;
      out.push({ path, repoDir, branch: "", taskId: e.name, createdAt: "" });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Remove a worktree: `git worktree remove` (with --force when asked, which also drops
   * uncommitted changes), then `git worktree prune`. Refuses any path outside the root and
   * reports `not_found` for a path that is not a worktree (no sidecar, no `.git` file) rather
   * than touching it.
   */
  async remove(path: string, opts: { force?: boolean } = {}): Promise<void> {
    const abs = resolve(path);
    if (!this.isInside(abs)) {
      throw new ForerunnerError(
        "path_not_allowed",
        `refusing to remove outside the worktree root: ${abs}`,
        {
          details: { path: abs, root: this.root },
        },
      );
    }
    const sidecar = this.sidecarFor(abs);
    let repoDir: string | null = null;
    try {
      const info = JSON.parse(await readFile(sidecar, "utf8")) as WorktreeInfo;
      if (typeof info.repoDir === "string") repoDir = info.repoDir;
    } catch {
      // no sidecar: derive the repository from the .git file
    }
    repoDir ??= await repoDirOf(abs);
    if (!repoDir) {
      throw new ForerunnerError(
        "not_found",
        `not a worktree (no sidecar and no .git file): ${abs}`,
        {
          details: { path: abs, root: this.root },
        },
      );
    }
    const argv = ["git", "-C", repoDir, "worktree", "remove"];
    if (opts.force) argv.push("--force");
    argv.push(abs);
    const r = await this.run(argv, { allowFailure: true, timeoutMs: this.gitTimeoutMs });
    if (r.code !== 0 && !opts.force) {
      throw new ForerunnerError("validation", `git worktree remove failed: ${r.stderr.trim()}`, {
        details: { path: abs, repoDir },
      });
    }
    await this.run(["git", "-C", repoDir, "worktree", "prune"], {
      allowFailure: true,
      timeoutMs: this.gitTimeoutMs,
    });
    if (opts.force && (await exists(abs))) {
      await rm(abs, { recursive: true, force: true, maxRetries: 3 });
    }
    await unlink(sidecar).catch(() => undefined);
    this.logger.info("worktree removed", { path: abs, force: opts.force === true });
  }

  private sidecarFor(path: string): string {
    return join(dirname(path), `${basenameOf(path)}${SIDECAR_SUFFIX}`);
  }
}

function basenameOf(p: string): string {
  const n = normalize(p);
  const idx = Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\"));
  return idx >= 0 ? n.slice(idx + 1) : n;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Read `<worktree>/.git` ("gitdir: <repo>/.git/worktrees/<name>") and return `<repo>`. */
async function repoDirOf(worktree: string): Promise<string | null> {
  try {
    const text = await readFile(join(worktree, ".git"), "utf8");
    const m = text.match(/^gitdir:\s*(.+)$/m);
    if (!m?.[1]) return null;
    const gitdir = resolve(worktree, m[1].trim());
    // <repo>/.git/worktrees/<name> -> <repo>
    return dirname(dirname(dirname(gitdir)));
  } catch {
    return null;
  }
}
