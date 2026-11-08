import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import {
  dropKeptSame,
  excludeNeverPushed,
  isNeverPushed,
  keepLocalOnlyFromCheckout,
  NEVER_PUSHED,
} from "../src/githost/local-only.ts";

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

  it("mergeFrom with noFastForward always makes a merge commit; rebaseOntoFrom replays only the commits after a marker (dependent-branches)", async () => {
    const { url } = await bareRepo();
    const root = mkdtempSync(join(tmpdir(), "fr-wt-"));
    const a = new GitOps({ cwd: join(root, "a"), identity });
    await a.clone(url);
    // A dependency's branch one commit ahead of main: a plain merge fast-forwards (no merge
    // commit, so nothing showed the branch brought other work in), --no-ff makes one.
    await a.createBranch("dep");
    writeFileSync(join(root, "a", "dep.txt"), "dep\n");
    await a.commitAll("dep: add dep.txt");
    await a.checkout("main");
    await a.createBranch("ff", "main");
    expect((await a.mergeFrom("dep")).ok).toBe(true);
    expect(await a.parentsOf("HEAD")).toHaveLength(1);
    await a.createBranch("base", "main");
    expect((await a.mergeFrom("dep", "Build on dep", { noFastForward: true })).ok).toBe(true);
    expect(await a.parentsOf("HEAD")).toHaveLength(2);
    expect(await a.hasMergesSince("main")).toBe(true);
    const marker = await a.headSha();
    // The task's own commit on top of the marker; rebuilt onto main, only it is replayed.
    writeFileSync(join(root, "a", "own.txt"), "own\n");
    await a.commitAll("own: add own.txt");
    const rebuilt = await a.rebaseOntoFrom("main", marker);
    expect(rebuilt.ok).toBe(true);
    expect((await a.log(5)).map((c) => c.subject)).toEqual(["own: add own.txt", "seed"]);
    expect(await a.changedFiles("main")).toEqual(["own.txt"]);
    // A replay that conflicts is aborted, the files named, the branch as it was.
    await a.createBranch("own2", marker);
    writeFileSync(join(root, "a", "dep.txt"), "dep, changed by the task\n");
    await a.commitAll("own2: change dep.txt");
    const head = await a.headSha();
    await a.checkout("main");
    writeFileSync(join(root, "a", "dep.txt"), "main's own dep.txt\n");
    await a.commitAll("main: a different dep.txt");
    const conflict = await a.rebaseOntoFrom("main", marker, "own2");
    expect(conflict).toMatchObject({ ok: false, conflicts: ["dep.txt"] });
    expect(await a.currentBranch()).toBe("own2");
    expect(await a.headSha()).toBe(head);
    expect((await a.status()).dirty).toBe(false);
    // The refs under a prefix, with their commits.
    await a.setRef("refs/forerunner/deps/t1", marker);
    expect(await a.refsUnder("refs/forerunner/deps/")).toEqual([
      { ref: "refs/forerunner/deps/t1", sha: marker },
    ]);
  });

  it("a push never carries Local only or a try folder: excluded from `git add -A`, and a forced add is refused at the push with one sentence (merged-copy, ADR 0113)", async () => {
    const { url, bare } = await bareRepo();
    const root = mkdtempSync(join(tmpdir(), "fr-wt-"));
    const dir = join(root, "a");
    const a = new GitOps({ cwd: dir, identity, neverPush: NEVER_PUSHED });
    await a.clone(url);
    expect(excludeNeverPushed(dir)).toBe(true);
    // Idempotent: a second call adds no line.
    excludeNeverPushed(dir);
    await a.createBranch("fr/task");
    mkdirSync(join(dir, "Local only"), { recursive: true });
    mkdirSync(join(dir, ".forerunner-try"), { recursive: true });
    writeFileSync(join(dir, "Local only", "notes ä.txt"), "mine\n");
    writeFileSync(join(dir, ".forerunner-try", "sample-1.txt"), "try\n");
    writeFileSync(join(dir, "page.html"), "<h1>work</h1>\n");
    await a.commitAll("work");
    expect(await a.changedFiles("origin/main")).toEqual(["page.html"]);
    await a.push("fr/task", { defaultBranch: "main" });
    // An agent's forced add gets past the exclude; the push refuses it, and nothing moves.
    await run(["git", "add", "-f", "Local only/notes ä.txt"], { cwd: dir });
    await a.commitAll("forced");
    const refused = await a.push("fr/task", { defaultBranch: "main" }).catch((e: unknown) => e);
    expect(isNeverPushed(refused)).toBe(true);
    expect((refused as Error).message).toBe(
      'Forerunner did not upload the branch fr/task: it holds "Local only/notes ä.txt", files of Local only, which never leave this computer. Press Try again to redo the work without them.',
    );
    const onHost = await run(["git", "--git-dir", bare, "ls-tree", "-r", "--name-only", "fr/task"]);
    expect(onHost.stdout.trim().split(/\r?\n/)).toEqual(["README.md", "page.html"]);
    // Removed again by a later commit: the history would still upload it, so it is refused too.
    await run(["git", "rm", "-q", "--cached", "Local only/notes ä.txt"], { cwd: dir });
    await a.commitAll("taken out again");
    expect(await a.neverPushedIn("fr/task", "main")).toEqual(["Local only/notes ä.txt"]);
    await expect(a.push("fr/task", { defaultBranch: "main" })).rejects.toThrow(
      /did not upload the branch fr\/task/,
    );
    // A repository that already tracks a folder of that name is not refused for it.
    const tracked = new GitOps({ cwd: join(root, "b"), identity, neverPush: NEVER_PUSHED });
    const plain = new GitOps({ cwd: join(root, "seed2"), identity });
    await plain.clone(url);
    mkdirSync(join(root, "seed2", "Local only"), { recursive: true });
    writeFileSync(join(root, "seed2", "Local only", "readme.md"), "the repository's own\n");
    await plain.commitAll("a folder of that name");
    await plain.push("main");
    await tracked.clone(url);
    await tracked.createBranch("fr/other");
    writeFileSync(join(root, "b", "Local only", "readme.md"), "changed by a task\n");
    await tracked.commitAll("change it");
    await tracked.push("fr/other", { defaultBranch: "main" });
    expect(await tracked.neverPushedIn("fr/other", "main")).toEqual([]);
  });

  it("a checkout never replaces the person's ignored file: Local only's in the way are kept as '(yours)' first, and with keepIgnored anything else stops the checkout (review of merged-copy)", async () => {
    // Before: `checkout -B main origin/main` replaced the ignored `Local only/notes.txt` with
    // the repository's new file without a word (git's default for ignored files).
    const { url } = await bareRepo();
    const root = mkdtempSync(join(tmpdir(), "fr-wt-"));
    const dir = join(root, "copy");
    const copy = new GitOps({ cwd: dir, identity });
    await copy.clone(url);
    excludeNeverPushed(dir);
    mkdirSync(join(dir, "Local only"), { recursive: true });
    writeFileSync(join(dir, "Local only", "notes.txt"), "mine\n");
    writeFileSync(join(dir, "Local only", "same.txt"), "shared\n");
    // The repository's .gitignore leaves out secrets.env; the person keeps one in the copy.
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    await seed.clone(url);
    writeFileSync(join(root, "seed", ".gitignore"), "secrets.env\n");
    await seed.commitAll("ignore secrets.env");
    await seed.push("main");
    await copy.fetch();
    await copy.createBranch("main", "origin/main", { keepIgnored: true });
    writeFileSync(join(dir, "secrets.env"), "MINE=1\n");
    // A collaborator commits files at both paths.
    mkdirSync(join(root, "seed", "Local only"), { recursive: true });
    writeFileSync(join(root, "seed", "Local only", "notes.txt"), "the team's\n");
    writeFileSync(join(root, "seed", "Local only", "same.txt"), "shared\n");
    writeFileSync(join(root, "seed", "secrets.env"), "TEAM=1\n");
    await run(["git", "add", "-f", "secrets.env"], { cwd: join(root, "seed") });
    await seed.commitAll("the team's files");
    await seed.push("main");
    await copy.fetch();
    const before = await copy.headSha();
    // Local only's are moved out of the way; secrets.env is not Local only's to move.
    const kept = await keepLocalOnlyFromCheckout(copy, dir, "origin/main");
    expect(kept).toEqual([
      { path: "Local only/notes.txt", kept: "Local only/notes (yours).txt" },
      { path: "Local only/same.txt", kept: "Local only/same (yours).txt" },
    ]);
    // So the checkout that keeps ignored files stops on secrets.env, and nothing is replaced.
    await expect(copy.createBranch("main", "origin/main", { keepIgnored: true })).rejects.toThrow(
      /checkout -B main/,
    );
    expect(await copy.headSha()).toBe(before);
    expect(readFileSync(join(dir, "secrets.env"), "utf8")).toBe("MINE=1\n");
    // Once the person moves theirs, it goes through; a kept file the repository's matches
    // byte for byte is dropped, the other stays beside.
    renameSync(join(dir, "secrets.env"), join(root, "secrets.env"));
    await copy.createBranch("main", "origin/main", { keepIgnored: true });
    expect(dropKeptSame(dir, kept)).toEqual([kept[0]]);
    expect(readFileSync(join(dir, "Local only", "notes.txt"), "utf8")).toBe("the team's\n");
    expect(readFileSync(join(dir, "Local only", "notes (yours).txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(dir, "Local only", "same (yours).txt"))).toBe(false);
    expect(readFileSync(join(dir, "Local only", "same.txt"), "utf8")).toBe("shared\n");
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

  it("applyCommitted works in a git worktree, where .git is a file (review of budget-resume)", async () => {
    // It wrote its patch to `<cwd>/.git/forerunner-apply.patch`, which fails with ENOTDIR in a
    // linked worktree; the patch now goes to the system's temp folder.
    const root = mkdtempSync(join(tmpdir(), "fr-git-wt-apply-"));
    const main = join(root, "main");
    const g = new GitOps({ cwd: main, identity });
    const git = async (cwd: string, ...args: string[]) =>
      (await run(["git", ...args], { cwd })).stdout.trim();
    await g.init("main");
    writeFileSync(join(main, "README.md"), "# Club\n");
    await g.commitAll("Workspace before");
    const before = await g.headSha();
    writeFileSync(join(main, "guide.md"), "# Guide\n\nPart 1.\n");
    await g.commitAll("Work in progress: Write the guide (paused at its budget)");
    const wip = await g.headSha();
    const wt = join(root, "wt");
    await git(main, "worktree", "add", "-q", "-b", "side", wt, before);
    expect(readFileSync(join(wt, ".git"), "utf8")).toMatch(/^gitdir: /);
    const w = new GitOps({ cwd: wt, identity });
    expect(await w.applyCommitted(wip, "Work in progress: Write the guide (brought back)")).toEqual(
      { ok: true, files: ["guide.md"] },
    );
    expect(readFileSync(join(wt, "guide.md"), "utf8")).toBe("# Guide\n\nPart 1.\n");
    expect(await git(wt, "log", "-1", "--format=%s")).toBe(
      "Work in progress: Write the guide (brought back)",
    );
    // And back out again (`reverse`), as a cancel sets it aside.
    expect(await w.applyCommitted(wip, "Set aside", { reverse: true })).toEqual({
      ok: true,
      files: ["guide.md"],
    });
    expect(existsSync(join(wt, "guide.md"))).toBe(false);
  });

  it("a clone and a new repository say our line endings in their own config, so the person's git with Git for Windows' default puts a file back as ours reads it; pinLineEndings writes a folder made before once (R-copystuck)", async () => {
    // Desktop app run 42525106539 (Windows): the person's git (core.autocrlf=true, Git for
    // Windows' system default) put a file back in this computer's copy with CRLF, and ours
    // (`-c core.autocrlf=false`) read it as still changed. Their git is set up the same way here,
    // through a global config: a `-c` would beat the folder's own config.
    const { url } = await bareRepo();
    const root = mkdtempSync(join(tmpdir(), "fr-git-eol-"));
    const windowsGit = join(root, "git-for-windows.gitconfig");
    writeFileSync(windowsGit, "[core]\n\tautocrlf = true\n");
    const persons = (cwd: string, ...args: string[]) =>
      run(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: windowsGit } });
    const setting = async (cwd: string) =>
      (
        await run(["git", "config", "--local", "--get", "core.autocrlf"], {
          cwd,
          allowFailure: true,
        })
      ).stdout.trim();
    const dir = join(root, "copy");
    const copy = new GitOps({ cwd: dir, identity });
    await copy.clone(url);
    expect(await setting(dir)).toBe("false");
    const folder = join(root, "folder");
    await new GitOps({ cwd: folder, identity }).init("main");
    expect(await setting(folder)).toBe("false");
    // The person changes README.md and puts it back with their own git: as committed, and ours
    // reads nothing changed.
    writeFileSync(join(dir, "README.md"), "# mine\n");
    await persons(dir, "checkout", "--", "README.md");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# seed\n");
    expect((await copy.status()).files).toEqual([]);
    // Already said: the config file is not written again.
    const config = join(dir, ".git", "config");
    const text = readFileSync(config, "utf8");
    const at = statSync(config).mtimeMs;
    expect(await copy.pinLineEndings()).toBe(false);
    expect(readFileSync(config, "utf8")).toBe(text);
    expect(statSync(config).mtimeMs).toBe(at);
    // A folder made before (no setting): the person's git writes CRLF there, which ours reads
    // as a change. Pinned once, and again over a config that says true, never twice.
    await run(["git", "config", "--local", "--unset", "core.autocrlf"], { cwd: dir });
    writeFileSync(join(dir, "README.md"), "# mine\n");
    await persons(dir, "checkout", "--", "README.md");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# seed\r\n");
    expect(await copy.pinLineEndings()).toBe(true);
    expect(await setting(dir)).toBe("false");
    expect(await copy.pinLineEndings()).toBe(false);
    await run(["git", "config", "--local", "core.autocrlf", "true"], { cwd: dir });
    expect(await copy.pinLineEndings()).toBe(true);
    expect(readFileSync(config, "utf8").match(/autocrlf/g)).toHaveLength(1);
    expect(await setting(dir)).toBe("false");
    writeFileSync(join(dir, "README.md"), "# mine\n");
    await persons(dir, "checkout", "--", "README.md");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# seed\n");
    expect((await copy.status()).files).toEqual([]);
  });
});
