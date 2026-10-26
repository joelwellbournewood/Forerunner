/**
 * Git over HTTPS uses exactly the token GitOps was given (live failure on Windows, 2026-10-26:
 * the REST API accepted a fine-grained PAT, every clone answered "remote: invalid credentials").
 *
 * A real `git http-backend` behind a small Node server that, like GitHub's git endpoint, accepts
 * only `Authorization: Basic <user>:<token>` with a non-empty user and the right token, and
 * answers anything else (a `bearer` header, a stale password) with 401 "invalid credentials".
 * The human's git config is simulated through GIT_CONFIG_GLOBAL: a credential helper that would
 * offer a stale credential (and records being asked) and a stale global `http.extraheader`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, type RunOptions, run } from "@forerunner/platform";
import { locateHttpBackend } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitAuth, GitOps, gitAuthFor } from "../src/githost/git.ts";

const httpBackend = await locateHttpBackend();
const skipReason = httpBackend ? false : "git http-backend not found next to git --exec-path";

const TOKEN = "github_pat_11TESTONLY0abcdefghijklmnop_qrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345"; // not-a-secret
const STALE = "stale-cached-password"; // not-a-secret
const identity = { name: "Forerunner", email: "agent@example.test" };

function accepted(header: string | undefined): boolean {
  // Exactly one Basic credential: two headers joined with " | " never match.
  const m = /^basic ([A-Za-z0-9+/=]+)$/i.exec(header ?? "");
  if (!m) return false;
  const decoded = Buffer.from(m[1] ?? "", "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon > 0 && decoded.slice(colon + 1) === TOKEN;
}

/** Run one request through `git http-backend` (CGI) and copy its answer back. */
function backend(projectRoot: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.replace(/^\?/, ""),
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
      REMOTE_USER: "agent",
      REMOTE_ADDR: "127.0.0.1",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  req.pipe(child.stdin);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  child.on("close", () => {
    const out = Buffer.concat(chunks);
    const end = out.indexOf("\r\n\r\n");
    const head = out.subarray(0, end).toString("utf8");
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.split("\r\n")) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const name = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.end(out.subarray(end + 4));
  });
}

// The reason is part of the suite name so a skipped run says why in the reporter.
const suite = `GitOps over HTTP with a token${skipReason ? ` (skipped: ${skipReason})` : ""}`;

describe.skipIf(skipReason)(suite, { timeout: 120_000 }, () => {
  let root: string;
  let server: Server;
  let base: string;
  let helperLog: string;
  let globalConfig: string;
  const seen: (string | undefined)[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fr-git-auth-"));
    const projects = join(root, "srv");
    const bare = join(projects, "acme", "service.git");
    await run(["git", "init", "--bare", "-q", "-b", "main", bare]);
    // Seed main from a scratch clone over the filesystem.
    const seed = join(root, "seed");
    const g = new GitOps({ cwd: seed, identity });
    await g.clone(bare);
    writeFileSync(join(seed, "README.md"), "# seed\n");
    await g.commitAll("seed");
    await g.push("main");

    server = createServer((req, res) => {
      // Every Authorization header as sent (Node keeps only the first in req.headers).
      const all: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]?.toLowerCase() === "authorization")
          all.push(req.rawHeaders[i + 1] ?? "");
      }
      const one = all.length === 1 ? all[0] : all.length === 0 ? undefined : all.join(" | ");
      seen.push(one);
      if (!accepted(one)) {
        res.writeHead(401, {
          "WWW-Authenticate": 'Basic realm="GitHub"',
          "Content-Type": "text/plain",
        });
        res.end("invalid credentials");
        return;
      }
      backend(projects, req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The human's own git config: a helper with a stale credential, and a stale header.
    helperLog = join(root, "helper-called.log");
    const logPath = helperLog.replace(/\\/g, "/");
    // A stale header at every level git's urlmatch knows: unscoped, the origin, a parent path,
    // and the repository URL with and without a trailing slash. A more specific entry beats a
    // less specific one, so ours has to sit at (and reset) the most specific level.
    const header = (who: string) =>
      `AUTHORIZATION: basic ${Buffer.from(`${who}:${STALE}`).toString("base64")}`;
    globalConfig = join(root, "human.gitconfig");
    writeFileSync(
      globalConfig,
      [
        "[credential]",
        `\thelper = "!f() { echo \\"$1\\" >> '${logPath}'; echo username=someone; echo password=${STALE}; }; f"`,
        "[http]",
        `\textraheader = ${header("global")}`,
        `[http "${base}/"]`,
        `\textraheader = ${header("origin")}`,
        `[http "${base}/acme/"]`,
        `\textraheader = ${header("parent")}`,
        `[http "${base}/acme/service.git"]`,
        `\textraheader = ${header("repo")}`,
        `[http "${base}/acme/service.git/"]`,
        `\textraheader = ${header("repo-slash")}`,
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** The platform runner with the simulated human config in place. */
  const asHuman = (argv: readonly string[], opts: RunOptions = {}) =>
    run(argv, { ...opts, env: { ...opts.env, GIT_CONFIG_GLOBAL: globalConfig } });

  it("clones, fetches and pushes with exactly our token, never asking a credential helper", async () => {
    // The simulated human config really is in effect for git run this way.
    const probe = await asHuman(["git", "config", "--global", "--get", "credential.helper"]);
    expect(probe.stdout).toContain("password=");

    // Without an origin, and with the one every caller now passes (gitAuthFor).
    const variants: GitAuth[] = [
      { token: TOKEN },
      gitAuthFor(TOKEN, `${base}/acme/service.git`) ?? {},
    ];
    for (const auth of variants) {
      const origin = auth.origin;
      seen.length = 0;
      const cwd = join(root, `clone-${origin ? "scoped" : "global"}`);
      const g = new GitOps({ cwd, identity, auth, runner: asHuman });
      await g.clone(`${base}/acme/service.git`);
      expect(existsSync(join(cwd, "README.md"))).toBe(true);
      await g.createBranch(`forerunner/${origin ? "scoped" : "global"}`);
      writeFileSync(join(cwd, "x.txt"), "x\n");
      await g.commitAll("add x");
      await g.push(`forerunner/${origin ? "scoped" : "global"}`);
      await g.fetch();
      // Every request carried our token and nothing else; the stale header was never sent.
      expect(seen.length).toBeGreaterThan(0);
      for (const h of seen) expect(accepted(h)).toBe(true);
    }
    expect(existsSync(helperLog)).toBe(false);
  });

  it("fails cleanly on a wrong token: no helper asked, no stale credential, token redacted", async () => {
    seen.length = 0;
    const wrong = "github_pat_11WRONGTOKEN0zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"; // not-a-secret
    const g = new GitOps({
      cwd: join(root, "clone-wrong"),
      identity,
      auth: { token: wrong, origin: base },
      runner: asHuman,
      timeoutMs: 60_000,
    });
    const err = await g.clone(`${base}/acme/service.git`).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/clone failed/);
    expect(err?.message).not.toContain(wrong);
    expect(existsSync(helperLog) ? readFileSync(helperLog, "utf8") : "").toBe("");
    // Only the wrong token was offered: no stale header, no helper credential.
    expect(seen.length).toBeGreaterThan(0);
    for (const h of seen) {
      expect(h).toBe(`basic ${Buffer.from(`x-access-token:${wrong}`).toString("base64")}`);
    }
  });

  it("names the missing token for a private clone without one, never asking a helper", async () => {
    seen.length = 0;
    const g = new GitOps({ cwd: join(root, "clone-tokenless"), identity, runner: asHuman });
    await expect(g.clone(`${base}/acme/service.git`)).rejects.toMatchObject({
      code: "provider_auth",
      message: expect.stringContaining(`no token configured for ${base}`),
    });
    expect(existsSync(helperLog) ? readFileSync(helperLog, "utf8") : "").toBe("");
  });
});
