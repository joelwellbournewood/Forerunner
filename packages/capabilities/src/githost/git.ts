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
   * The origin (`scheme://host[:port]`) the token belongs to. The header is only ever given to
   * a remote under this origin: a remote on another host, or one a `url.*.insteadOf` rewrite
   * sends elsewhere, gets no header. Without it, any http(s) remote may receive the token.
   * Callers derive it from the clone URL with `gitAuthFor()`.
   */
  origin?: string;
}

/**
 * The auth for a clone URL: the token scoped to that URL's origin, or undefined when there is
 * no token or the URL is not http(s) (a local path or SSH remote needs no header).
 */
export function gitAuthFor(
  token: string | undefined,
  cloneUrl: string,
): { token: string; origin: string } | undefined {
  if (!token) return undefined;
  let url: URL;
  try {
    url = new URL(cloneUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return { token, origin: url.origin };
}

/**
 * Where the token goes for one network command against `remoteUrl`. Git's urlmatch lets the
 * most specific matching `http.<url>.extraheader` entry win (host, then path length), so a
 * header scoped to the origin loses to a human's entry for the repository path. Ours sits on
 * the repository URL itself (credentials, query and fragment dropped, trailing slash added)
 * and empty entries first reset every level that could carry an older header: the unscoped
 * key, the origin, and the repository path with and without its trailing slash. Null when the
 * remote is not http(s) or lies outside `origin`: then no header is sent at all.
 */
export function tokenScope(
  remoteUrl: string,
  origin?: string,
): { resets: string[]; key: string } | null {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (origin !== undefined && tokenHeaderKey(origin) !== tokenHeaderKey(url.origin)) return null;
  const path = url.pathname.replace(/\/+$/, "");
  const key = `http.${url.origin}${path}/.extraheader`;
  const resets = ["http.extraheader", `http.${url.origin}/.extraheader`];
  if (path) resets.push(`http.${url.origin}${path}.extraheader`, key);
  return { resets, key };
}

/**
 * The config key for a token scoped to `origin` (normalised to its URL origin), else the
 * global `http.extraheader`. A non-http(s) origin is `validation`.
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

  /**
   * Run git. `remoteUrl` is the URL a network command talks to (clone, fetch, push); only
   * then does the token header reach the process, scoped by `tokenScope()`. Local commands
   * never carry it.
   */
  private async git(
    args: string[],
    extra: Partial<RunOptions> = {},
    remoteUrl?: string | null,
  ): Promise<RunResult> {
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
    const scope =
      this.opts.auth?.token && remoteUrl ? tokenScope(remoteUrl, this.opts.auth.origin) : null;
    if (scope && this.opts.auth?.token) {
      // An empty value resets a multi-valued key. With the resets at every level and ours on
      // the most specific one, a header from the human's own config is never sent: ours is
      // the only Authorization git sends.
      for (const k of scope.resets) Object.assign(env, gitConfigEnv(env, k, ""));
      Object.assign(env, gitConfigEnv(env, scope.key, tokenAuthHeader(this.opts.auth.token)));
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
      // Credential helpers are off, so a remote that wants credentials we did not give fails
      // here rather than falling back to the human's store: name what is missing.
      const wanted = /(?:could not read Username for|Authentication failed for) '([^']+)'/.exec(
        r.stderr,
      );
      if (wanted && !this.opts.auth?.token) {
        let origin = wanted[1] ?? "";
        try {
          origin = new URL(origin).origin;
        } catch {
          // keep git's spelling
        }
        throw new ForerunnerError(
          "provider_auth",
          `git ${what} failed: no token configured for ${origin} (the remote asked for credentials; Forerunner never uses the human's git credential helper)`,
          { details: { code: r.code, origin } },
        );
      }
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
    this.must(await this.git(args, { cwd: undefined }, url), "clone");
  }

  async init(defaultBranch = "main"): Promise<void> {
    this.must(
      await this.git(["init", "-b", defaultBranch, this.opts.cwd], { cwd: undefined }),
      "init",
    );
  }

  async fetch(remote = "origin"): Promise<void> {
    const url = this.opts.auth?.token ? await this.remoteUrl(remote) : null;
    this.must(await this.git(["fetch", "--prune", remote], {}, url), "fetch");
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

  /** True when `ref` names a commit in this checkout (`origin/<branch>`, a local branch, a sha). */
  async hasRef(ref: string): Promise<boolean> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    this.must(r, `rev-parse --verify ${ref}`);
    return false;
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
    return {
      ok: false,
      conflicts,
      detail: redactToken(r.stderr.trim(), this.opts.auth?.token).slice(-800),
    };
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
    const remote = opts.remote ?? "origin";
    const args = ["push", "-u", remote, branch];
    if (opts.force) args.splice(1, 0, "--force-with-lease");
    // The push URL as git will use it (pushurl and insteadOf / pushInsteadOf applied).
    let url: string | null = null;
    if (this.opts.auth?.token) {
      const r = await this.git(["remote", "get-url", "--push", remote]);
      url = r.code === 0 ? r.stdout.trim() : null;
    }
    this.must(await this.git(args, {}, url), `push ${branch}`);
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
