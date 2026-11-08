import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  errorMessage,
  ForerunnerError,
  join,
  type RunOptions,
  type RunResult,
  run,
} from "@forerunner/platform";
import { NEVER_PUSHED_CAUSE, neverPushedWords, underNeverPushed } from "./local-only.ts";

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
 * Where a git step takes the person's token: the token itself, or a function that reads it
 * when the step runs. The daemon passes a function that reads the vault, so a token replaced in
 * the app is used by the next clone, fetch or push (U-082), as the GitHub API client already
 * does (U-049); a token read once at start kept pushing as the old token's owner.
 */
export type GitTokenSource =
  | string
  | undefined
  | (() => Promise<string | null | undefined> | string | null | undefined);

/** The token a git step uses now (`GitTokenSource`); undefined when there is none. */
export async function resolveGitToken(source: GitTokenSource): Promise<string | undefined> {
  const token = typeof source === "function" ? await source() : source;
  return token || undefined;
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
  /**
   * Folders a push never carries to the host (`local-only.ts` `NEVER_PUSHED`: Local only and a
   * review's try folder, ADR 0113): before every push the branch is checked in code, since
   * `git add -f` gets past `.git/info/exclude`, and a branch that tracks a path under one that
   * the remote's default branch does not is refused with one sentence (`neverPushedWords`).
   */
  neverPush?: readonly string[];
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

/** The git commands that write a commit, so need an author and a committer. */
const COMMIT_MAKERS = new Set([
  "commit",
  "commit-tree",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "am",
  "stash",
]);
/** The name git commits under when the person never set one (the address is `EMAIL`'s). */
const FALLBACK_NAME = "Forerunner";

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
      // Git's own fallback, used only when no user.email is configured anywhere: without it a
      // commit fails with "unable to auto-detect email address" on a machine whose person never
      // set up git (Windows CI found it in the U-037 workspace commits). It never overrides a
      // configured address.
      EMAIL: process.env.EMAIL || "forerunner@localhost",
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
    const name = await this.fallbackName(args);
    try {
      return await runner([...this.base(), ...name, ...args], {
        cwd: creates ? undefined : this.opts.cwd,
        timeoutMs: this.timeoutMs(),
        allowFailure: true,
        ...extra,
        // A caller's variables (a temporary index, `commitFile`) add to ours, never drop them.
        env: extra.env ? { ...env, ...extra.env } : env,
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

  /**
   * `-c user.name=Forerunner` for a command that makes a commit, when no user.name is set at
   * any level and no identity was given. Git takes the name from the account otherwise, and an
   * account without one (a container user, Linux CI) makes every commit fail with "empty ident
   * name not allowed". Unlike the address (`EMAIL` above), git has no low-priority setting for
   * the name, so the setting is passed only when nothing is configured: a person's own
   * user.name is never overridden.
   */
  private async fallbackName(args: readonly string[]): Promise<string[]> {
    if (this.opts.identity || !COMMIT_MAKERS.has(args[0] ?? "")) return [];
    const set = await this.git(["config", "--get", "user.name"]);
    return set.code === 0 && set.stdout.trim() ? [] : ["-c", `user.name=${FALLBACK_NAME}`];
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

  /** The branches `remote` has as this checkout last fetched them, without `HEAD`, sorted. */
  async remoteBranches(remote = "origin"): Promise<string[]> {
    const r = this.must(
      await this.git(["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/`]),
      "for-each-ref",
    );
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith(`${remote}/`) && l !== `${remote}/HEAD`)
      .map((l) => l.slice(remote.length + 1))
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

  /**
   * `checkout -B name from`. With `keepIgnored` (merged-copy, ADR 0113) an ignored file the
   * checkout would replace stops it instead (`--no-overwrite-ignore`): by default git overwrites
   * ignored files without a word, and the person's Local only files are ignored ones.
   */
  async createBranch(
    name: string,
    from = "HEAD",
    opts: { keepIgnored?: boolean } = {},
  ): Promise<void> {
    const keep = opts.keepIgnored ? ["--no-overwrite-ignore"] : [];
    this.must(await this.git(["checkout", ...keep, "-B", name, from]), `checkout -B ${name}`);
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

  async commitAll(
    message: string,
    opts: { allowEmpty?: boolean } = {},
  ): Promise<{ sha: string; committed: boolean }> {
    this.must(await this.git(["add", "-A"]), "add");
    const st = await this.status();
    if (!st.dirty && !opts.allowEmpty) return { sha: await this.headSha(), committed: false };
    this.must(
      await this.git(["commit", "-q", ...(st.dirty ? [] : ["--allow-empty"]), "-m", message]),
      "commit",
    );
    return { sha: await this.headSha(), committed: true };
  }

  /** Whether the repository has a commit yet (a fresh `init` has none). */
  async hasCommits(): Promise<boolean> {
    return (await this.git(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
  }

  /** Stage every change, new and deleted files included (`git add -A`). */
  async stageAll(): Promise<void> {
    this.must(await this.git(["add", "-A"]), "add");
  }

  /** The files the index changes against `base` (default HEAD): what `stageAll` staged. */
  async stagedFiles(base = "HEAD"): Promise<string[]> {
    return this.must(await this.git(["diff", "--cached", "--name-only", base]), "diff --cached")
      .stdout.split(/\r?\n/)
      .filter(Boolean);
  }

  /** Add a remote, or point an existing one at `url`. */
  async setRemote(name: string, url: string): Promise<void> {
    const has = (await this.git(["remote", "get-url", name])).code === 0;
    this.must(
      await this.git(has ? ["remote", "set-url", name, url] : ["remote", "add", name, url]),
      `remote ${has ? "set-url" : "add"} ${name}`,
    );
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

  /**
   * Replay the commits of `branch` (default the current one) that are not in `upstream` onto
   * `onto` (`git rebase --onto <onto> <upstream> [<branch>]`): a dependent branch rebuilt from
   * its dependencies' marker (`DEPS_BASE_REF`) onto a new base replays only the task's own
   * commits (merge commits are dropped, as a plain rebase drops them). On conflicts, abort and
   * report the files; the branch is then as it was.
   */
  async rebaseOntoFrom(onto: string, upstream: string, branch?: string): Promise<RebaseResult> {
    const r = await this.git(["rebase", "--onto", onto, upstream, ...(branch ? [branch] : [])]);
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

  /**
   * Merge `ref` into the current branch (a fast-forward when it can be, unless
   * `noFastForward`: then always a merge commit, so a branch that brought other work in shows
   * it; `message` names the merge commit); on conflicts, abort and report the files.
   */
  async mergeFrom(
    ref: string,
    message?: string,
    opts: { noFastForward?: boolean } = {},
  ): Promise<RebaseResult> {
    const r = await this.git([
      "merge",
      "--no-edit",
      ...(opts.noFastForward ? ["--no-ff"] : []),
      ...(message ? ["-m", message] : []),
      ref,
    ]);
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
    if (this.opts.neverPush?.length) {
      const held = await this.neverPushedIn(branch, opts.defaultBranch, remote);
      if (held.length)
        throw new ForerunnerError("path_not_allowed", neverPushedWords(branch, held), {
          details: { cause: NEVER_PUSHED_CAUSE, paths: held.slice(0, 20) },
        });
    }
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

  /**
   * The paths under the `neverPush` folders that a push of `ref` would upload: tracked at its
   * tip, or touched by any of its commits no remote branch has yet (an agent's own commit that
   * added a file and a later one that removed it still carry it). A folder the remote's default
   * branch already tracks is the repository's own and is not checked. Tip names are read raw
   * (`-z`) and the log's unquoted, so names with spaces or non-ASCII letters compare as they are.
   */
  async neverPushedIn(ref: string, defaultBranch?: string, remote = "origin"): Promise<string[]> {
    const guarded: string[] = [];
    for (const f of this.opts.neverPush ?? []) {
      const onBase = defaultBranch
        ? await this.trackedUnder(`${remote}/${defaultBranch}`, [f])
        : null;
      if (!onBase?.length) guarded.push(f);
    }
    if (!guarded.length) return [];
    const atTip = await this.trackedUnder(ref, guarded);
    if (atTip === null) {
      // A branch that cannot be read is never pushed unchecked.
      this.must(await this.git(["rev-parse", "--verify", `${ref}^{commit}`]), `ls-tree ${ref}`);
      return [];
    }
    const log = this.must(
      await this.git([
        "-c",
        "core.quotePath=false",
        "log",
        "--format=",
        "--name-only",
        ref,
        "--not",
        `--remotes=${remote}`,
        "--",
        ...guarded,
      ]),
      `log ${ref}`,
    );
    const touched = underNeverPushed(
      log.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
      guarded,
    );
    return [...new Set([...atTip, ...touched])];
  }

  /**
   * The files `rev` tracks under the folders (relative, forward slashes, read raw with `-z`);
   * null when `rev` names no commit here.
   */
  async trackedUnder(rev: string, folders: readonly string[]): Promise<string[] | null> {
    if (!folders.length) return [];
    const r = await this.git(["ls-tree", "-r", "-z", "--name-only", rev, "--", ...folders]);
    if (r.code !== 0) return null;
    return underNeverPushed(r.stdout.split("\0").filter(Boolean), folders);
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

  /** Point `ref` (`refs/...`) at `rev`; null removes it (nothing when it does not exist). */
  async setRef(ref: string, rev: string | null): Promise<void> {
    if (rev !== null) {
      this.must(await this.git(["update-ref", ref, rev]), `update-ref ${ref}`);
      return;
    }
    if (await this.hasRef(ref))
      this.must(await this.git(["update-ref", "-d", ref]), "update-ref -d");
  }

  /**
   * The refs under `prefix` (`refs/forerunner/deps/`) with the commit each names, sorted by
   * name: the dependencies a dependent branch's marker holds.
   */
  async refsUnder(prefix: string): Promise<{ ref: string; sha: string }[]> {
    const r = this.must(
      await this.git(["for-each-ref", "--format=%(refname) %(objectname)", prefix]),
      "for-each-ref",
    );
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
      .map(([ref, sha]) => ({ ref, sha }))
      .sort((a, b) => a.ref.localeCompare(b.ref));
  }

  /** How many commits `to` has that `from` has not, merge commits left out (`rev-list --count`). */
  async commitCount(from: string, to = "HEAD"): Promise<number> {
    const r = this.must(
      await this.git(["rev-list", "--count", "--no-merges", `${from}..${to}`]),
      "rev-list --count",
    );
    return Number(r.stdout.trim()) || 0;
  }

  /** Whether `base..head` holds a merge commit (a branch that brought other work in by merging). */
  async hasMergesSince(base: string, head = "HEAD"): Promise<boolean> {
    const r = this.must(
      await this.git(["rev-list", "--merges", "--max-count=1", `${base}..${head}`]),
      "rev-list --merges",
    );
    return r.stdout.trim() !== "";
  }

  /** The commit `ref` names in this checkout, or null when it names none. */
  async resolveRef(ref: string): Promise<string | null> {
    const r = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (r.code === 0) return r.stdout.trim() || null;
    if (r.code === 1) return null;
    this.must(r, `rev-parse --verify ${ref}`);
    return null;
  }

  /** The best common ancestor of `a` and `b`, or null when they share none. */
  async mergeBase(a: string, b = "HEAD"): Promise<string | null> {
    const r = await this.git(["merge-base", a, b]);
    if (r.code === 0) return r.stdout.trim() || null;
    if (r.code === 1) return null;
    this.must(r, `merge-base ${a} ${b}`);
    return null;
  }

  /**
   * The tree a merge of `a` and `b` would make, written to the object store without touching
   * the worktree or any ref (`git merge-tree --write-tree`, git 2.38 or later). Null when the
   * two conflict, or when this git cannot do it.
   */
  async mergeTree(a: string, b: string): Promise<string | null> {
    const r = await this.git(["merge-tree", "--write-tree", "--no-messages", a, b]);
    if (r.code !== 0) return null;
    return r.stdout.split(/\r?\n/)[0]?.trim() || null;
  }

  /**
   * The files a merge of `a` and `b` would conflict in, worked out without touching the
   * worktree (`git merge-tree --write-tree --name-only`); empty when they merge cleanly or
   * when this git cannot tell.
   */
  async conflictFiles(a: string, b: string): Promise<string[]> {
    const r = await this.git(["merge-tree", "--write-tree", "--name-only", "--no-messages", a, b]);
    if (r.code !== 1) return [];
    return r.stdout
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /**
   * The patch id (`git patch-id --stable`) of the change from `from` (a commit or a tree) to
   * `to`, diffed without context lines so the id names the changed lines alone; "empty" for no
   * change. Two ways of making the same change (a rebase, a merge of other work in) share it.
   */
  async patchId(from: string, to = "HEAD"): Promise<string> {
    const diff = this.must(
      await this.git([
        "diff",
        "-U0",
        "--binary",
        "--full-index",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        from,
        to,
        "--",
      ]),
      "diff",
    ).stdout;
    if (!diff.trim()) return "empty";
    const id = this.must(
      await this.git(["patch-id", "--stable"], { input: diff }),
      "patch-id",
    ).stdout.trim();
    return id.split(/\s+/)[0] || "empty";
  }

  /** The parents of a commit, first parent first (a merge commit has two or more). */
  async parentsOf(rev = "HEAD"): Promise<string[]> {
    const line = this.must(
      await this.git(["rev-list", "--parents", "-n", "1", rev]),
      `rev-list --parents ${rev}`,
    ).stdout.trim();
    return line.split(/\s+/).slice(1);
  }

  /** The files whose content differs between the commits `from` and `to` (tree to tree). */
  async filesBetween(from: string, to = "HEAD"): Promise<string[]> {
    return this.must(await this.git(["diff", "--name-only", from, to]), "diff")
      .stdout.split(/\r?\n/)
      .filter(Boolean);
  }

  /** The files `head` (default HEAD) changes since it left `base`. */
  async changedFiles(base: string, head = "HEAD"): Promise<string[]> {
    return this.must(await this.git(["diff", "--name-only", `${base}...${head}`]), "diff")
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

  /**
   * Sets the work since HEAD aside (a cancelled task's run, phase C): every change, new and
   * deleted files included, is kept as one commit under `ref` (HEAD does not move), then the
   * worktree goes back to HEAD. Ignored files stay as they are. Returns the files set aside;
   * with none, nothing changes and an older commit under `ref` is dropped, so a later
   * `bringBack` never brings back work from before.
   */
  async setAside(ref: string, message: string): Promise<string[]> {
    await this.stageAll();
    const files = await this.stagedFiles();
    if (files.length === 0) {
      if (await this.hasRef(ref))
        this.must(await this.git(["update-ref", "-d", ref]), "update-ref -d");
      return [];
    }
    const tree = this.must(await this.git(["write-tree"]), "write-tree").stdout.trim();
    const commit = this.must(
      await this.git(["commit-tree", tree, "-p", "HEAD", "-m", message]),
      "commit-tree",
    ).stdout.trim();
    this.must(await this.git(["update-ref", ref, commit]), "update-ref");
    this.must(await this.git(["reset", "--hard", "-q", "HEAD"]), "reset --hard");
    return files;
  }

  /**
   * Brings back the work set aside under `ref` (`setAside`), on top of the worktree as it is
   * now, uncommitted; the ref is removed. `missing` when nothing is set aside there;
   * `conflict` when the folder changed since in the same places: nothing is applied then (git
   * apply is all or nothing) and the ref stays.
   */
  async bringBack(
    ref: string,
  ): Promise<{ result: "restored"; files: string[] } | { result: "missing" | "conflict" }> {
    if (!(await this.hasRef(ref))) return { result: "missing" };
    const files = this.must(
      await this.git(["diff", "--name-only", `${ref}~1`, ref]),
      "diff --name-only",
    )
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    // git's own patch, plain: a person's `color.ui=always` or external diff tool would make
    // `git apply` refuse it, and the work would not come back.
    const patch = this.must(
      await this.git(["diff", "--binary", "--no-color", "--no-ext-diff", `${ref}~1`, ref]),
      "diff --binary",
    ).stdout;
    const file = join(this.opts.cwd, ".git", "forerunner-bring-back.patch");
    writeFileSync(file, patch.endsWith("\n") ? patch : `${patch}\n`);
    try {
      const applied = await this.git(["apply", "--binary", "--whitespace=nowarn", file]);
      if (applied.code !== 0) return { result: "conflict" };
    } finally {
      rmSync(file, { force: true });
    }
    this.must(await this.git(["update-ref", "-d", ref]), "update-ref -d");
    return { result: "restored", files };
  }

  /**
   * `commitAll`, except that `keepOut.files` go into the commit as `keepOut.rev` has them (the
   * worktree keeps its own versions, uncommitted): a project folder's snapshot before a task's
   * next run keeps the task's own work in progress out of it, so that run's change set (what the
   * critic reads, `git diff HEAD`) is the task's whole work (budget-resume). A file `rev` lacks
   * is left out of the commit. Empty when nothing else changed.
   */
  async commitAllExcept(
    message: string,
    keepOut: { rev: string; files: readonly string[] },
  ): Promise<{ sha: string; committed: boolean }> {
    this.must(await this.git(["add", "-A"]), "add");
    if (keepOut.files.length)
      this.must(
        await this.git(["reset", "-q", keepOut.rev, "--", ...keepOut.files]),
        "reset (keep out)",
      );
    this.must(await this.git(["commit", "-q", "--allow-empty", "-m", message]), "commit");
    return { sha: await this.headSha(), committed: true };
  }

  /**
   * The change of commit `rev` (against its first parent) applied to the folder, or taken back
   * (`reverse`), and committed as `message` with only those files (other changes in the folder
   * stay as they are): a cancelled task's work in progress set aside and brought back
   * (budget-resume). `ok` false, with nothing changed, when the same files changed since.
   */
  async applyCommitted(
    rev: string,
    message: string,
    opts: { reverse?: boolean } = {},
  ): Promise<{ ok: boolean; files: string[] }> {
    const files = await this.filesBetween(`${rev}~1`, rev);
    if (!files.length) return { ok: true, files };
    const patch = this.must(
      await this.git(["diff", "--binary", "--no-color", "--no-ext-diff", `${rev}~1`, rev]),
      "diff --binary",
    ).stdout;
    // In the system's temp folder, never under `<cwd>/.git`: in a linked worktree `.git` is a
    // file, and writing there failed (the review of budget-resume).
    const file = join(tmpdir(), `forerunner-apply-${randomUUID()}.patch`);
    writeFileSync(file, patch.endsWith("\n") ? patch : `${patch}\n`);
    try {
      const applied = await this.git([
        "apply",
        "--index",
        "--binary",
        "--whitespace=nowarn",
        ...(opts.reverse ? ["-R"] : []),
        file,
      ]);
      if (applied.code !== 0) return { ok: false, files };
    } finally {
      rmSync(file, { force: true });
    }
    this.must(await this.git(["commit", "-q", "-m", message, "--", ...files]), "commit");
    return { ok: true, files };
  }

  /** `reset --hard <rev>`: the checked-out branch and the folder as `rev` has them. */
  async resetHard(rev: string): Promise<void> {
    this.must(await this.git(["reset", "--hard", "-q", rev]), `reset --hard ${rev}`);
  }

  /** The subjects of the commits in `from..to`, newest first. */
  async subjectsBetween(from: string, to = "HEAD"): Promise<string[]> {
    return this.must(await this.git(["log", "--format=%s", `${from}..${to}`]), "log")
      .stdout.split(/\r?\n/)
      .filter(Boolean);
  }

  /**
   * Removes `branch` from the remote (a cancelled task's pushed work in progress,
   * budget-resume). Never the default branch: refused like a force-push of it. False when the
   * remote has no such branch or refused.
   */
  async deleteRemoteBranch(
    branch: string,
    opts: { remote?: string; defaultBranch: string },
  ): Promise<boolean> {
    if (!opts.defaultBranch || branch === opts.defaultBranch)
      throw new ForerunnerError("autonomy_insufficient", `deleting ${branch} needs a human`);
    const remote = opts.remote ?? "origin";
    let url: string | null = null;
    if (this.opts.auth?.token) {
      const r = await this.git(["remote", "get-url", "--push", remote]);
      url = r.code === 0 ? r.stdout.trim() : null;
    }
    const r = await this.git(["push", remote, "--delete", branch], {}, url);
    if (r.code !== 0) return false;
    await this.git(["update-ref", "-d", `refs/remotes/${remote}/${branch}`]);
    return true;
  }

  /** The file `path` (relative, `/`-separated) as the commit `rev` holds it; null when absent. */
  async fileAt(rev: string, path: string): Promise<string | null> {
    const r = await this.git(["cat-file", "blob", `${rev}:${path}`]);
    return r.code === 0 ? r.stdout : null;
  }

  /**
   * Commits `content` as the file `path` (relative, `/`-separated) on top of HEAD, leaving the
   * files in the worktree as they are: an app's own write to a folder a run may be changing at
   * the same time (the person's answers in the decision record, phase C) joins the baseline the
   * run's change set is measured against, so that set (`git diff HEAD`, the critic's evidence;
   * `setAside`, a cancel) holds only the run's own changes. The commit is built in a temporary
   * index, and HEAD moves only if nothing moved it meanwhile; the worktree's index then takes
   * the file's new entry. Returns the commit, or null when HEAD already holds that content.
   */
  async commitFile(path: string, content: string, message: string): Promise<string | null> {
    const head = this.must(await this.git(["rev-parse", "HEAD"]), "rev-parse HEAD").stdout.trim();
    const blob = this.must(
      await this.git(["hash-object", "-w", "--stdin"], { input: content }),
      "hash-object",
    ).stdout.trim();
    const entry = `100644,${blob},${path}`;
    const index = join(tmpdir(), `forerunner-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      this.must(await this.git(["read-tree", head], { env }), "read-tree");
      this.must(
        await this.git(["update-index", "--add", "--cacheinfo", entry], { env }),
        "update-index",
      );
      const tree = this.must(await this.git(["write-tree"], { env }), "write-tree").stdout.trim();
      const before = this.must(
        await this.git(["rev-parse", `${head}^{tree}`]),
        "rev-parse tree",
      ).stdout.trim();
      if (tree === before) return null;
      const commit = this.must(
        await this.git(["commit-tree", tree, "-p", head, "-m", message]),
        "commit-tree",
      ).stdout.trim();
      this.must(await this.git(["update-ref", "HEAD", commit, head]), "update-ref");
      // Best effort: without it `git status` reads the file as staged back to its old content.
      await this.git(["update-index", "--add", "--cacheinfo", entry]);
      return commit;
    } finally {
      rmSync(index, { force: true });
    }
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
