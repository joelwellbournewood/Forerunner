import { existsSync } from "node:fs";
import {
  errorMessage,
  ForerunnerError,
  join,
  type RunOptions,
  type RunResult,
  run,
} from "@forerunner/platform";

/**
 * Local git operations through argv arrays (never shell strings). Branch and PR flow (spec F):
 * agents work on branches, rebase before PR; conflicts they cannot resolve become a human
 * request (the caller decides; this module reports the conflicting files).
 */
export interface GitAuth {
  /**
   * Token for HTTPS remotes. It reaches git as an `http.extraheader` entry
   * `AUTHORIZATION: basic base64("x-access-token:<token>")` through the process environment
   * (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, git 2.31+): never on the
   * command line, where a process listing would show it, never in a URL, and never written to
   * the clone's config. Basic, not bearer: GitHub's git endpoint answers a bearer header with
   * 401 "invalid credentials" even for a fine-grained PAT its REST API accepts.
   */
  token?: string;
  /**
   * The origin (`scheme://host[:port]`) the token belongs to. When set, the entry is
   * `http.<origin>/.extraheader`, which git attaches only to URLs under that origin: a remote
   * on another host, or a `url.*.insteadOf` rewrite in the user's git config, gets no header.
   * Without it the header goes to every http(s) remote the command reaches.
   */
  origin?: string;
}

/**
 * The config key that carries the token: scoped to `origin` (normalised to its URL origin)
 * when one is given, else the global `http.extraheader`. A non-http(s) origin is `validation`.
 */
export function tokenHeaderKey(origin?: string): string {
  if (origin === undefined) return "http.extraheader";
  let scope: URL | null = null;
  try {
    scope = new URL(origin);
  } catch {
    scope = null;
  }
  if (!scope || (scope.protocol !== "http:" && scope.protocol !== "https:")) {
    throw new ForerunnerError(
      "validation",
      `a token's origin must be an http(s) URL: ${origin.slice(0, 80)}`,
      { details: { origin: origin.slice(0, 80) } },
    );
  }
  return `http.${scope.origin}/.extraheader`;
}

/** The header value git sends for `token`: Basic with GitHub's `x-access-token` user. */
export function tokenAuthHeader(token: string): string {
  return `AUTHORIZATION: basic ${basicCredential(token)}`;
}

function basicCredential(token: string): string {
  return Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitOpsOptions {
  cwd: string;
  auth?: GitAuth;
  identity?: GitIdentity;
  timeoutMs?: number;
  /** Process runner (tests record argv and env); default the platform's `run`. */
  runner?: (argv: readonly string[], opts?: RunOptions) => Promise<RunResult>;
}

/**
 * One more `GIT_CONFIG_*` entry on top of what `base` already carries, so a caller's own
 * entries stay and git reads ours after them. A malformed count starts at 0.
 */
export function gitConfigEnv(
  base: NodeJS.ProcessEnv,
  key: string,
  value: string,
): NodeJS.ProcessEnv {
  const parsed = Number.parseInt(base.GIT_CONFIG_COUNT ?? "", 10);
  const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: key,
    [`GIT_CONFIG_VALUE_${n}`]: value,
  };
}

export interface RebaseResult {
  ok: boolean;
  conflicts: string[];
  detail: string;
}

export class GitOps {
  constructor(private readonly opts: GitOpsOptions) {}

  private base(): string[] {
    const argv = ["git"];
    if (this.opts.identity)
      argv.push(
        "-c",
        `user.name=${this.opts.identity.name}`,
        "-c",
        `user.email=${this.opts.identity.email}`,
      );
    // Keep output stable and non-interactive on both platforms. `credential.helper=` empties
    // the helper list from every config level (Git Credential Manager from Git for Windows'
    // system config included): git never offers the human's cached credential in place of
    // ours, never stores ours, and never erases theirs when a request fails.
    argv.push(
      "-c",
      "credential.helper=",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      "-c",
      "advice.detachedHead=false",
    );
    return argv;
  }

  private async git(args: string[], extra: Partial<RunOptions> = {}): Promise<RunResult> {
    // Every command runs inside opts.cwd; only clone/init may run before it exists. Never fall
    // back to the process working directory (that could touch an unrelated repository).
    const creates = args[0] === "clone" || args[0] === "init";
    if (!creates && !existsSync(join(this.opts.cwd, ".git"))) {
      throw new ForerunnerError("not_found", `not a git worktree: ${this.opts.cwd}`);
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GCM_INTERACTIVE: "never",
    };
    if (this.opts.auth?.token) {
      // An empty value resets a multi-valued key: a header from the human's own config (global
      // or scoped to our origin) is dropped, so ours is the only Authorization git sends.
      const key = tokenHeaderKey(this.opts.auth.origin);
      const resets = key === "http.extraheader" ? [key] : ["http.extraheader", key];
      for (const k of resets) Object.assign(env, gitConfigEnv(env, k, ""));
      Object.assign(env, gitConfigEnv(env, key, tokenAuthHeader(this.opts.auth.token)));
    }
    const runner = this.opts.runner ?? run;
    try {
      return await runner([...this.base(), ...args], {
        cwd: creates ? undefined : this.opts.cwd,
        timeoutMs: this.timeoutMs(),
        env,
        allowFailure: true,
        ...extra,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ForerunnerError("unavailable", "git is not installed or not on PATH", {
          cause: e,
        });
      }
      throw new ForerunnerError(
        "provider_error",
        `git ${args[0] ?? ""} could not run: ${redactToken(errorMessage(e), this.opts.auth?.token)}`,
        { cause: e },
      );
    }
  }

  private timeoutMs(): number {
    return this.opts.timeoutMs ?? 5 * 60 * 1000;
  }

  private must(r: RunResult, what: string): RunResult {
    if (r.timedOut) {
      // The runner killed the process tree at the wall-clock limit (a clone that never answers).
      throw new ForerunnerError("timeout", `git ${what} timed out after ${this.timeoutMs()} ms`, {
        details: { timeoutMs: this.timeoutMs() },
      });
    }
    if (r.code !== 0) {
      const detail = redactToken(`${r.stderr}\n${r.stdout}`.trim(), this.opts.auth?.token);
      throw new ForerunnerError("provider_error", `git ${what} failed: ${detail.slice(-800)}`, {
        details: { code: r.code },
      });
    }
    return r;
  }

  /** Clone into opts.cwd (created). */
  async clone(url: string, opts: { depth?: number; branch?: string } = {}): Promise<void> {
    const args = ["clone", "--no-tags"];
    if (opts.depth) args.push("--depth", String(opts.depth));
    if (opts.branch) args.push("--branch", opts.branch);
    args.push(url, this.opts.cwd);
    this.must(await this.git(args, { cwd: undefined }), "clone");
  }

  async init(defaultBranch = "main"): Promise<void> {
    this.must(
      await this.git(["init", "-b", defaultBranch, this.opts.cwd], { cwd: undefined }),
      "init",
    );
  }

  async fetch(remote = "origin"): Promise<void> {
    this.must(await this.git(["fetch", "--prune", remote]), "fetch");
  }

  async currentBranch(): Promise<string> {
    return this.must(
      await this.git(["rev-parse", "--abbrev-ref", "HEAD"]),
      "rev-parse",
    ).stdout.trim();
  }

  async headSha(): Promise<string> {
    return this.must(await this.git(["rev-parse", "HEAD"]), "rev-parse HEAD").stdout.trim();
  }

  /** The remote's default branch as the clone recorded it (`refs/remotes/origin/HEAD`). */
  async remoteDefaultBranch(remote = "origin"): Promise<string> {
    const r = await this.git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
    const ref = r.stdout.trim();
    if (r.code !== 0 || !ref.startsWith(`${remote}/`)) {
      throw new ForerunnerError(
        "validation",
        `the repository has no default branch at ${remote} (an empty repository?)`,
        { details: { remote } },
      );
    }
    return ref.slice(remote.length + 1);
  }

  /** The URL of `remote` as the checkout's config has it; null when there is no such remote. */
  async remoteUrl(remote = "origin"): Promise<string | null> {
    const r = await this.git(["remote", "get-url", remote]);
    if (r.code !== 0 && !r.timedOut) return null;
    return this.must(r, `remote get-url ${remote}`).stdout.trim();
  }

  /** Local branch names under `prefix`, sorted by name. */
  async localBranches(prefix = ""): Promise<string[]> {
    const r = this.must(
      await this.git([
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/heads/${prefix.replace(/^\/+/, "")}*`,
      ]),
      "for-each-ref",
    );
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.startsWith(prefix))
      .sort();
  }

  async createBranch(name: string, from = "HEAD"): Promise<void> {
    this.must(await this.git(["checkout", "-B", name, from]), `checkout -B ${name}`);
  }

  async checkout(ref: string): Promise<void> {
    this.must(await this.git(["checkout", ref]), `checkout ${ref}`);
  }

  async status(): Promise<{ dirty: boolean; files: string[] }> {
    const r = this.must(await this.git(["status", "--porcelain"]), "status");
    const files = r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
    return { dirty: files.length > 0, files };
  }

  async commitAll(message: string): Promise<{ sha: string; committed: boolean }> {
    this.must(await this.git(["add", "-A"]), "add");
    const st = await this.status();
    if (!st.dirty) return { sha: await this.headSha(), committed: false };
    this.must(await this.git(["commit", "-q", "-m", message]), "commit");
    return { sha: await this.headSha(), committed: true };
  }

  /** Rebase the current branch onto `base`; on conflicts, abort and report the files. */
  async rebaseOnto(base: string): Promise<RebaseResult> {
    const r = await this.git(["rebase", base]);
    if (r.code === 0) return { ok: true, conflicts: [], detail: r.stdout.trim() };
    const conflicts = (await this.git(["diff", "--name-only", "--diff-filter=U"])).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    await this.git(["rebase", "--abort"]);
    return {
      ok: false,
      conflicts,
      detail: redactToken(r.stderr.trim(), this.opts.auth?.token).slice(-800),
    };
  }

  async mergeFrom(ref: string): Promise<RebaseResult> {
    const r = await this.git(["merge", "--no-edit", ref]);
    if (r.code === 0) return { ok: true, conflicts: [], detail: r.stdout.trim() };
    const conflicts = (await this.git(["diff", "--name-only", "--diff-filter=U"])).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    await this.git(["merge", "--abort"]);
    return { ok: false, conflicts, detail: r.stderr.trim().slice(-800) };
  }

  /**
   * Push the branch; never force unless explicitly asked, and never to the default branch. A
   * force push without `defaultBranch` is refused rather than attempted: the rule could not be
   * applied, and a caller that forgot the branch would otherwise force-push `main`.
   */
  async push(
    branch: string,
    opts: { remote?: string; force?: boolean; defaultBranch?: string } = {},
  ): Promise<void> {
    if (opts.force && !opts.defaultBranch) {
      throw new ForerunnerError(
        "autonomy_insufficient",
        `force-pushing ${branch} needs the repository's default branch declared (defaultBranch), so a default branch is never forced`,
      );
    }
    if (opts.force && opts.defaultBranch && branch === opts.defaultBranch) {
      throw new ForerunnerError("autonomy_insufficient", `force-pushing ${branch} needs a human`);
    }
    const args = ["push", "-u", opts.remote ?? "origin", branch];
    if (opts.force) args.splice(1, 0, "--force-with-lease");
    this.must(await this.git(args), `push ${branch}`);
  }

  /** True when `ancestor` is reachable from `of` (the base has not moved past the branch). */
  async isAncestor(ancestor: string, of = "HEAD"): Promise<boolean> {
    const r = await this.git(["merge-base", "--is-ancestor", ancestor, of]);
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    // Any other exit is git failing (an unknown ref): reported, never read as "not an ancestor".
    this.must(r, `merge-base --is-ancestor ${ancestor} ${of}`);
    return false;
  }

  async changedFiles(base: string): Promise<string[]> {
    return this.must(await this.git(["diff", "--name-only", `${base}...HEAD`]), "diff")
      .stdout.split(/\r?\n/)
      .filter(Boolean);
  }

  async log(n = 10): Promise<{ sha: string; subject: string }[]> {
    const r = this.must(await this.git(["log", `-n${n}`, "--pretty=format:%H%x09%s"]), "log");
    return r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [sha, ...rest] = l.split("\t");
        return { sha: sha ?? "", subject: rest.join("\t") };
      });
  }

  /** Where a worktree for a task should live under a root. */
  static worktreePath(root: string, taskId: string): string {
    return join(root, taskId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60));
  }
}

/** Remove the token, raw or in its Basic form, from text bound for an error or a log. */
export function redactToken(text: string, token?: string): string {
  if (!token) return text;
  let out = text;
  for (const form of [basicCredential(token), token]) out = out.split(form).join("[REDACTED]");
  return out;
}
