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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitOps } from "../src/githost/git.ts";

const TOKEN = "github_pat_11TESTONLY0abcdefghijklmnop_qrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345"; // not-a-secret
const STALE = "stale-cached-password"; // not-a-secret
const identity = { name: "Forerunner", email: "agent@example.test" };

function accepted(header: string | undefined): boolean {
  if (!header) return false;
  const [scheme, value = ""] = header.split(" ", 2);
  if (scheme?.toLowerCase() !== "basic") return false;
  const decoded = Buffer.from(value, "base64").toString("utf8");
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

describe("GitOps over HTTP with a token", { timeout: 120_000 }, () => {
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
      seen.push(req.headers.authorization);
      if (!accepted(req.headers.authorization)) {
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
    const staleBasic = Buffer.from(`someone:${STALE}`).toString("base64");
    globalConfig = join(root, "human.gitconfig");
    writeFileSync(
      globalConfig,
      [
        "[credential]",
        `\thelper = "!f() { echo \\"$1\\" >> '${logPath}'; echo username=someone; echo password=${STALE}; }; f"`,
        "[http]",
        `\textraheader = AUTHORIZATION: basic ${staleBasic}`,
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

    for (const origin of [undefined, base]) {
      seen.length = 0;
      const cwd = join(root, `clone-${origin ? "scoped" : "global"}`);
      const g = new GitOps({ cwd, identity, auth: { token: TOKEN, origin }, runner: asHuman });
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
    const stale = Buffer.from(`someone:${STALE}`).toString("base64");
    expect(seen.some((h) => h?.includes(stale))).toBe(false);
  });
});
