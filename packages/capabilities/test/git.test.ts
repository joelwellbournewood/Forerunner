import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, type RunOptions, type RunResult, run } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  GitOps,
  gitAuthFor,
  gitConfigEnv,
  redactToken,
  tokenHeaderKey,
} from "../src/githost/git.ts";

const identity = { name: "Test", email: "test@example.test" };

/** The `*.extraheader` entries a recorded env passes through GIT_CONFIG_*, in order. */
function headerEntries(env: NodeJS.ProcessEnv): [string, string][] {
  return [...Array(Number(env.GIT_CONFIG_COUNT ?? 0)).keys()]
    .map((i): [string, string] => [
      env[`GIT_CONFIG_KEY_${i}`] ?? "",
      env[`GIT_CONFIG_VALUE_${i}`] ?? "",
    ])
    .filter(([k]) => k.startsWith("http.") && k.endsWith(".extraheader"));
}

async function bareRepo(): Promise<{ bare: string; url: string }> {
  const root = mkdtempSync(join(tmpdir(), "fr-git-"));
  const bare = join(root, "remote.git");
  await run(["git", "init", "--bare", "-b", "main", bare]);
  // Seed main through a scratch clone.
  const seed = join(root, "seed");
  const g = new GitOps({ cwd: seed, identity });
  await g.clone(bare);
  writeFileSync(join(seed, "README.md"), "# seed\n");
  await g.commitAll("seed");
  await g.push("main");
  return { bare, url: bare };
}

// Dozens of git subprocesses: the Windows runner needs well over the 20 s default under load.
describe("GitOps", { timeout: 120_000 }, () => {
  it("clones, branches, commits, rebases and pushes; conflicts are reported and aborted", async () => {
    const { url } = await bareRepo();
    const root = mkdtempSync(join(tmpdir(), "fr-wt-"));
    const a = new GitOps({ cwd: join(root, "a"), identity });
    const b = new GitOps({ cwd: join(root, "b"), identity });
    await a.clone(url);
    await b.clone(url);
    expect(await a.currentBranch()).toBe("main");

    // b changes main.
    writeFileSync(join(root, "b", "README.md"), "# seed\nfrom b\n");
    await b.commitAll("b: edit readme");
    await b.push("main");

    // a works on a branch with a non-conflicting file, rebases before the PR.
    await a.createBranch("feat/x");
    writeFileSync(join(root, "a", "x.txt"), "x\n");
    const c = await a.commitAll("a: add x");
    expect(c.committed).toBe(true);
    await a.fetch();
    // The base moved: origin/main is no longer an ancestor of the branch until the rebase.
    expect(await a.isAncestor("origin/main", "HEAD")).toBe(false);
    const rb = await a.rebaseOnto("origin/main");
    expect(rb.ok).toBe(true);
    expect(await a.isAncestor("origin/main", "HEAD")).toBe(true);
    expect(await a.changedFiles("origin/main")).toEqual(["x.txt"]);
    await a.push("feat/x");
    expect((await b.log(1))[0]?.subject).toBe("b: edit readme");

    // a conflicting change is reported with the file and the tree is left clean.
    await a.createBranch("feat/y", "origin/main");
    writeFileSync(join(root, "a", "README.md"), "# seed\nfrom a\n");
    await a.commitAll("a: conflicting readme");
    writeFileSync(join(root, "b", "README.md"), "# seed\nfrom b again\n");
    await b.commitAll("b: readme again");
    await b.push("main");
    await a.fetch();
    const conflict = await a.rebaseOnto("origin/main");
    expect(conflict.ok).toBe(false);
    expect(conflict.conflicts).toEqual(["README.md"]);
    expect((await a.status()).dirty).toBe(false);
    expect(await a.currentBranch()).toBe("feat/y");
  });

  it("passes the token to git through the environment, never on the command line", async () => {
    const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
    const runner = async (argv: readonly string[], opts: RunOptions = {}): Promise<RunResult> => {
      calls.push({ argv: [...argv], env: opts.env ?? {} });
      return {
        code: 0,
        signal: null,
        stdout: "main\n",
        stderr: "",
        truncated: false,
        timedOut: false,
        durationMs: 1,
      };
    };
    const token = "ghp_testtokenvalueXXXXXXXXXXXXXXXXXXXXXXXX"; // not-a-secret
    const g = new GitOps({ cwd: join(tmpdir(), "nope"), auth: { token }, identity, runner });
    await g.clone("http://127.0.0.1:1/acme/service.git");
    expect(calls).toHaveLength(1);
    const [clone] = calls;
    if (!clone) throw new Error("no git call recorded");
    expect(clone.argv.join(" ")).not.toContain(token);
    expect(clone.argv).not.toContain("http.extraheader");
    // Git's urlmatch lets a more specific `http.<url>.*` entry win over a less specific one, so
    // the header is scoped to the repository URL itself. Empty entries first reset the
    // unscoped key, the origin key and the repository keys: whatever header the human's config
    // has at any of those levels is dropped, and ours, last and most specific, is the only one.
    const repoKey = "http.http://127.0.0.1:1/acme/service.git/.extraheader";
    expect(headerEntries(clone.env)).toEqual([
      ["http.extraheader", ""],
      ["http.http://127.0.0.1:1/.extraheader", ""],
      ["http.http://127.0.0.1:1/acme/service.git.extraheader", ""],
      [repoKey, ""],
      [
        repoKey,
        `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      ],
    ]);
    // GitHub's git endpoint authenticates Basic only: `bearer` answers 401 "invalid credentials"
    // even for a fine-grained PAT the REST API accepts (seen live on 2026-10-26).
    expect(Object.values(clone.env).some((v) => /bearer/i.test(v ?? ""))).toBe(false);
    // The raw token is in neither argv nor env.
    expect(Object.values(clone.env).some((v) => (v ?? "").includes(token))).toBe(false);
    // Every credential helper is off (Git Credential Manager on Windows included): git neither
    // offers a cached credential from the human's store nor writes ours to it.
    const helperAt = clone.argv.indexOf("credential.helper=");
    expect(helperAt).toBeGreaterThan(0);
    expect(clone.argv[helperAt - 1]).toBe("-c");
    expect(helperAt).toBeLessThan(clone.argv.indexOf("clone"));
    expect(clone.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(clone.env.GIT_ASKPASS).toBe("");
    expect(clone.env.SSH_ASKPASS).toBe("");
    expect(clone.env.GCM_INTERACTIVE).toBe("never");
    // Without a token nothing about http.extraheader reaches git, and helpers are still off.
    calls.length = 0;
    await new GitOps({ cwd: join(tmpdir(), "nope"), identity, runner }).clone("http://x/y.git");
    const bare = calls[0]?.env ?? {};
    expect(Object.values(bare).some((v) => v === "http.extraheader")).toBe(false);
    expect(Object.values(bare).some((v) => /bearer|basic/i.test(v ?? ""))).toBe(false);
    expect(calls[0]?.argv).toContain("credential.helper=");
    // A caller's own GIT_CONFIG_* entries are kept; ours is appended after them.
    const env = gitConfigEnv(
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" },
      "http.extraheader",
      "AUTHORIZATION: bearer x",
    );
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "http.extraheader",
      GIT_CONFIG_VALUE_1: "AUTHORIZATION: bearer x",
    });
    expect(gitConfigEnv({ GIT_CONFIG_COUNT: "junk" }, "a.b", "c")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "c",
    });
  });

  it("scopes the token header to the remote's origin when one is given and reports a killed command as a timeout", async () => {
    const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
    const ok: RunResult = {
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      durationMs: 1,
    };
    let reply: RunResult = ok;
    const runner = async (argv: readonly string[], opts: RunOptions = {}): Promise<RunResult> => {
      calls.push({ argv: [...argv], env: opts.env ?? {} });
      return reply;
    };
    const token = "ghp_scopedtokenvalueXXXXXXXXXXXXXXXXXXXXXXXX"; // not-a-secret
    // With an origin the entry is `http.<origin>/.extraheader`: git attaches it to URLs under
    // that origin only, so an `insteadOf` rewrite or a remote on another host gets no token.
    const scoped = new GitOps({
      cwd: join(tmpdir(), "nope"),
      auth: { token, origin: "http://127.0.0.1:1/ignored/path?x=1" },
      runner,
      timeoutMs: 1500,
    });
    await scoped.clone("http://user:pw@127.0.0.1:1/acme/service.git?q=1#f");
    const env = calls[0]?.env ?? {};
    const basic = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    // The token sits on the repository URL's key only (credentials, query and fragment
    // dropped); the unscoped and origin keys are only ever reset, so no other host or
    // repository receives it.
    const withToken = headerEntries(env).filter(([, v]) => v !== "");
    expect(withToken).toEqual([["http.http://127.0.0.1:1/acme/service.git/.extraheader", basic]]);
    expect(calls[0]?.argv.join(" ")).not.toContain(token);
    // A remote outside the token's origin gets no header at all (and no reset either).
    calls.length = 0;
    await scoped.clone("http://other.example/acme/service.git");
    expect(headerEntries(calls[0]?.env ?? {})).toEqual([]);
    expect(tokenHeaderKey("https://github.com")).toBe("http.https://github.com/.extraheader");
    expect(tokenHeaderKey("HTTPS://GitHub.com:443/")).toBe("http.https://github.com/.extraheader");
    expect(tokenHeaderKey(undefined)).toBe("http.extraheader");
    for (const bad of ["github.com", "ssh://git@github.com", "", "not a url"]) {
      expect(() => tokenHeaderKey(bad)).toThrow(/http\(s\)/);
    }
    // A command the runner killed at the wall-clock limit is `timeout`, naming the limit.
    reply = { ...ok, code: null, signal: "SIGKILL", timedOut: true, durationMs: 1500 };
    await expect(scoped.clone("http://127.0.0.1:1/acme/service.git")).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringMatching(/clone timed out after 1500 ms/),
      details: { timeoutMs: 1500 },
    });
  });

  it("scopes fetch and push to the remote's own URL, keeps local commands token-free and names a missing token", async () => {
    const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
    const remote = "https://github.com/acme/service.git";
    let fail: RunResult | null = null;
    const runner = async (argv: readonly string[], opts: RunOptions = {}): Promise<RunResult> => {
      calls.push({ argv: [...argv], env: opts.env ?? {} });
      const base = {
        code: 0,
        signal: null,
        stderr: "",
        truncated: false,
        timedOut: false,
        durationMs: 1,
      } as const;
      if (argv.includes("get-url")) return { ...base, stdout: `${remote}\n` };
      if (fail && (argv.includes("fetch") || argv.includes("clone"))) return fail;
      return { ...base, stdout: "" };
    };
    const token = "github_pat_scopedfetchXXXXXXXXXXXXXXXXXXXXXXXX"; // not-a-secret
    const cwd = mkdtempSync(join(tmpdir(), "fr-git-scope-"));
    mkdirSync(join(cwd, ".git"));
    const g = new GitOps({
      cwd,
      auth: gitAuthFor(token, remote),
      runner,
    });
    await g.fetch();
    const fetch = calls.find((c) => c.argv.includes("fetch"));
    const basic = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    expect(headerEntries(fetch?.env ?? {}).filter(([, v]) => v !== "")).toEqual([
      ["http.https://github.com/acme/service.git/.extraheader", basic],
    ]);
    // Reading the remote URL is local: it carries no token.
    const getUrl = calls.find((c) => c.argv.includes("get-url"));
    expect(headerEntries(getUrl?.env ?? {})).toEqual([]);
    calls.length = 0;
    await g.push("forerunner/x");
    const push = calls.find((c) => c.argv.includes("push"));
    expect(headerEntries(push?.env ?? {}).filter(([, v]) => v !== "")).toEqual([
      ["http.https://github.com/acme/service.git/.extraheader", basic],
    ]);
    // Local commands never see the header.
    calls.length = 0;
    await g.status();
    expect(headerEntries(calls[0]?.env ?? {})).toEqual([]);

    // gitAuthFor: http(s) clone URLs only, origin taken from the URL.
    expect(gitAuthFor(token, remote)).toEqual({ token, origin: "https://github.com" });
    expect(gitAuthFor(token, "git@github.com:acme/service.git")).toBeUndefined();
    expect(gitAuthFor(undefined, remote)).toBeUndefined();

    // Without a token a private remote fails with a clear error naming the origin; git never
    // falls back to the human's credential helper.
    fail = {
      code: 128,
      signal: null,
      stdout: "",
      stderr:
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      truncated: false,
      timedOut: false,
      durationMs: 1,
    };
    const tokenless = new GitOps({ cwd, runner });
    await expect(tokenless.fetch()).rejects.toMatchObject({
      code: "provider_auth",
      message: expect.stringContaining("no token configured for https://github.com"),
    });
    await expect(
      new GitOps({ cwd: join(cwd, "fresh"), runner }).clone(remote),
    ).rejects.toMatchObject({
      code: "provider_auth",
      message: expect.stringContaining("no token configured for https://github.com"),
    });
  });

  it("redacts the token from a failed merge's detail", async () => {
    const token = "github_pat_mergeleakXXXXXXXXXXXXXXXXXXXXXXXX"; // not-a-secret
    const cwd = mkdtempSync(join(tmpdir(), "fr-git-merge-"));
    mkdirSync(join(cwd, ".git"));
    const runner = async (argv: readonly string[]): Promise<RunResult> => ({
      code: argv.includes("merge") && !argv.includes("--abort") ? 1 : 0,
      signal: null,
      stdout: "",
      stderr: `fatal: unable to access 'https://x-access-token:${token}@github.com/a/b.git/'`,
      truncated: false,
      timedOut: false,
      durationMs: 1,
    });
    const r = await new GitOps({ cwd, auth: { token }, runner }).mergeFrom("origin/main");
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain(token);
    expect(r.detail).toContain("[REDACTED]");
  });

  it("reads the remote default branch, the remote URL and lists local branches by prefix", async () => {
    const { url } = await bareRepo();
    const root = mkdtempSync(join(tmpdir(), "fr-wt-"));
    const g = new GitOps({ cwd: join(root, "c"), identity });
    await g.clone(url);
    expect(await g.remoteDefaultBranch()).toBe("main");
    expect(await g.remoteUrl()).toBe(url);
    expect(await g.remoteUrl("upstream")).toBeNull();
    await g.createBranch("forerunner/migration-2026-01-01", "origin/main");
    await g.createBranch("forerunner/migration-2026-02-01", "origin/main");
    await g.createBranch("other/branch", "origin/main");
    expect(await g.localBranches("forerunner/migration-")).toEqual([
      "forerunner/migration-2026-01-01",
      "forerunner/migration-2026-02-01",
    ]);
    expect(await g.localBranches("nothing/")).toEqual([]);
  });

  it("never force-pushes the default branch and redacts tokens from errors", async () => {
    const g = new GitOps({ cwd: join(tmpdir(), "nope"), auth: { token: "secret-token" } });
    await expect(g.push("main", { force: true, defaultBranch: "main" })).rejects.toMatchObject({
      code: "autonomy_insufficient",
    });
    expect(redactToken("fatal: Authorization: bearer secret-token failed", "secret-token")).toBe(
      "fatal: Authorization: bearer [REDACTED] failed",
    );
    // The Basic form is redacted too (GIT_TRACE / GIT_CURL_VERBOSE print the header).
    const b64 = Buffer.from("x-access-token:secret-token").toString("base64");
    expect(redactToken(`> Authorization: Basic ${b64}`, "secret-token")).toBe(
      "> Authorization: Basic [REDACTED]",
    );
    expect(GitOps.worktreePath(join("r"), "task/1:ä")).toBe(join("r", "task-1--"));
  });

  it("commits on a machine where git has no identity, and never overrides one that is set", async () => {
    // Windows CI (U-037): a commit failed with "unable to auto-detect email address" on a runner
    // whose git had no user.email. Run git as on such a machine: no global or system config.
    const home = mkdtempSync(join(tmpdir(), "fr-git-noid-home-"));
    const bare = (argv: readonly string[], opts: RunOptions = {}): Promise<RunResult> =>
      run(argv, {
        ...opts,
        env: {
          ...opts.env,
          HOME: home,
          USERPROFILE: home,
          GIT_CONFIG_GLOBAL: join(home, "none"),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
    const cwd = mkdtempSync(join(tmpdir(), "fr-git-noid-"));
    const g = new GitOps({ cwd, runner: bare });
    await g.init("main");
    writeFileSync(join(cwd, "a.txt"), "a\n");
    await g.commitAll("first", { allowEmpty: false });
    expect(await g.hasCommits()).toBe(true);
    // Author and committer, name and address: Linux CI (a container whose user has no name)
    // failed with "empty ident name not allowed" once the address had a fallback.
    const who = async () =>
      (await bare(["git", "log", "-1", "--format=%an <%ae> / %cn <%ce>"], { cwd })).stdout.trim();
    expect(await who()).toBe(
      "Forerunner <forerunner@localhost> / Forerunner <forerunner@localhost>",
    );

    // A merge makes a commit too, under the same fallback.
    await bare(["git", "checkout", "-q", "-b", "side"], { cwd });
    writeFileSync(join(cwd, "side.txt"), "s\n");
    await g.commitAll("side", { allowEmpty: false });
    await bare(["git", "checkout", "-q", "main"], { cwd });
    writeFileSync(join(cwd, "main.txt"), "m\n");
    await g.commitAll("main", { allowEmpty: false });
    expect((await g.mergeFrom("side")).ok).toBe(true);
    expect(await who()).toBe(
      "Forerunner <forerunner@localhost> / Forerunner <forerunner@localhost>",
    );

    // A repository whose person set a name and an address keeps them.
    await bare(["git", "config", "user.email", "person@example.test"], { cwd });
    await bare(["git", "config", "user.name", "Pat Person"], { cwd });
    writeFileSync(join(cwd, "b.txt"), "b\n");
    await g.commitAll("second", { allowEmpty: false });
    expect(await who()).toBe("Pat Person <person@example.test> / Pat Person <person@example.test>");
  });

  it("commitFile puts one file's content on top of HEAD without touching the worktree; a set-aside then holds only the rest (phase C review)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fr-git-commit-file-"));
    const g = new GitOps({ cwd, identity });
    const git = async (...args: string[]) => (await run(["git", ...args], { cwd })).stdout;
    await g.init("main");
    writeFileSync(join(cwd, "index.html"), "<h1>Club</h1>\n");
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "decisions.md"), "# Decisions\n");
    await g.commitAll("Workspace before the run");
    const before = (await git("rev-parse", "HEAD")).trim();
    // A run changes index.html and the record; the app then records the person's answers.
    writeFileSync(join(cwd, "index.html"), "<h1>Club</h1>\n<a href=about.html>About</a>\n");
    writeFileSync(join(cwd, "about.html"), "<h1>About</h1>\n");
    writeFileSync(join(cwd, "docs", "decisions.md"), "# Decisions\n\nRun's note.\n\nAnswers.\n");
    expect(await g.fileAt("HEAD", "docs/decisions.md")).toBe("# Decisions\n");
    expect(await g.fileAt("HEAD", "docs/none.md")).toBeNull();
    const commit = await g.commitFile(
      "docs/decisions.md",
      "# Decisions\n\nAnswers.\n",
      "Answers recorded",
    );
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await git("rev-parse", "HEAD~1")).trim()).toBe(before);
    // The worktree's files are as the run left them.
    expect(await g.fileAt("HEAD", "docs/decisions.md")).toBe("# Decisions\n\nAnswers.\n");
    expect(await git("show", "--stat", "--format=", "HEAD")).toContain("docs/decisions.md");
    expect((await git("status", "--porcelain")).split("\n").filter(Boolean).sort()).toEqual([
      " M docs/decisions.md",
      " M index.html",
      "?? about.html",
    ]);
    // The same content again commits nothing.
    expect(await g.commitFile("docs/decisions.md", "# Decisions\n\nAnswers.\n", "again")).toBe(
      null,
    );
    // A cancel's set-aside takes the run's changes and leaves the answers.
    const files = await g.setAside("refs/forerunner/set-aside/t1", "set aside");
    expect(files.sort()).toEqual(["about.html", "docs/decisions.md", "index.html"]);
    expect((await git("show", "HEAD:docs/decisions.md")).trim()).toBe("# Decisions\n\nAnswers.");
    expect(await git("status", "--porcelain")).toBe("");
    expect(await g.bringBack("refs/forerunner/set-aside/t1")).toMatchObject({
      result: "restored",
    });
    expect(await git("diff", "HEAD", "--", "docs/decisions.md")).toContain("+Run's note.");
  });

  it("a person whose git colours everything (color.ui=always) still gets a set-aside run back: the patch is plain", async () => {
    // Sibling of the FORCE_COLOR finding (CI on c8c16fb): with colour forced in the person's
    // git config, `git diff --binary` wrote escape sequences into the patch and `git apply`
    // refused it, so a cancelled run's work could not be brought back ("conflict").
    const cwd = mkdtempSync(join(tmpdir(), "fr-git-colour-"));
    const g = new GitOps({ cwd, identity });
    const git = async (...args: string[]) => (await run(["git", ...args], { cwd })).stdout;
    await g.init("main");
    writeFileSync(join(cwd, "index.html"), "<h1>Club</h1>\n");
    await g.commitAll("Workspace before the run");
    // The repository's config stands in for the person's own (global) one.
    await git("config", "color.ui", "always");
    await git("config", "color.diff", "always");
    writeFileSync(join(cwd, "index.html"), "<h1>Club</h1>\n<p>Run's change.</p>\n");
    writeFileSync(join(cwd, "about.html"), "<h1>About</h1>\n");
    expect((await g.setAside("refs/forerunner/set-aside/t1", "set aside")).sort()).toEqual([
      "about.html",
      "index.html",
    ]);
    expect(await g.bringBack("refs/forerunner/set-aside/t1")).toEqual({
      result: "restored",
      files: ["about.html", "index.html"],
    });
    expect(await g.changedFiles("HEAD")).toEqual([]);
    expect((await run(["git", "status", "--porcelain"], { cwd })).stdout).toBe(
      " M index.html\n?? about.html\n",
    );
  });
});
