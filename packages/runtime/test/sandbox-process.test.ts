import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isForerunnerError, join, Logger, type LogRecord } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROCESS_SANDBOX_WARNING, ProcessSandbox } from "../src/sandbox/process.ts";

const NODE = process.execPath;
// Built by concatenation so the secret scanner never sees a key shape. // not-a-secret
const FAKE_KEY = ["sk-ant", "api03", "x".repeat(24)].join("-"); // not-a-secret

describe("ProcessSandbox", () => {
  let worktree: string;
  const records: LogRecord[] = [];
  let removeSink: () => void;

  beforeEach(async () => {
    worktree = await realpath(await mkdtemp(join(tmpdir(), "fr-psb-")));
    removeSink = Logger.addSink((r) => records.push(r));
  });
  afterEach(async () => {
    removeSink();
    await rm(worktree, { recursive: true, force: true });
  });

  it("scrubs credentials from the environment, keeps PATH, routes through the egress proxy and warns visibly", async () => {
    const sb = await ProcessSandbox.create({
      worktree,
      limits: { timeoutMs: 20_000 },
      network: { mode: "allowlist", domains: ["github.com"] },
      env: { TASK_VAR: "1" },
      baseEnv: {
        PATH: process.env.PATH,
        HOME: "/home/someone",
        ANTHROPIC_API_KEY: FAKE_KEY,
        GITHUB_TOKEN: "ghp_notreal",
        MY_SECRET: "hunter2",
        SAFE_VAR: "ok",
      },
    });
    try {
      expect(records.some((r) => r.level === "warn" && r.msg === PROCESS_SANDBOX_WARNING)).toBe(
        true,
      );
      const r = await sb.run([NODE, "-e", "console.log(JSON.stringify(process.env))"], {
        env: { RUN_VAR: "2" },
      });
      expect(r.code).toBe(0);
      const env = JSON.parse(r.stdout) as Record<string, string>;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.MY_SECRET).toBeUndefined();
      expect(env.SAFE_VAR).toBe("ok");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.TASK_VAR).toBe("1");
      expect(env.RUN_VAR).toBe("2");
      expect(env.FORERUNNER_SANDBOX).toBe("process");
      expect(env.HTTP_PROXY).toBe(
        `http://forerunner:${encodeURIComponent(sb.proxy.token ?? "")}@127.0.0.1:${sb.proxy.port}`,
      );
      expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
      // A run cannot override the proxy.
      const r2 = await sb.run([NODE, "-e", "console.log(process.env.HTTPS_PROXY)"], {
        env: { HTTPS_PROXY: "http://evil:1" },
      });
      expect(r2.stdout.trim()).toBe(env.HTTPS_PROXY);
    } finally {
      await sb.destroy();
    }
  });

  it("pins cwd inside the worktree and refuses escapes", async () => {
    await mkdir(join(worktree, "sub"));
    const sb = await ProcessSandbox.create({
      worktree,
      limits: { timeoutMs: 20_000 },
      network: { mode: "none" },
    });
    try {
      const root = await sb.run([NODE, "-p", "process.cwd()"]);
      expect(await realpath(root.stdout.trim())).toBe(worktree);
      const sub = await sb.run([NODE, "-p", "process.cwd()"], { cwd: "sub" });
      expect(await realpath(sub.stdout.trim())).toBe(join(worktree, "sub"));
      for (const bad of ["..", "../x", "/", "sub/../.."]) {
        let err: unknown;
        try {
          await sb.run([NODE, "-p", "1"], { cwd: bad });
        } catch (e) {
          err = e;
        }
        expect(isForerunnerError(err, "path_not_allowed"), bad).toBe(true);
      }
      await expect(sb.run([NODE, "-p", "1"], { cwd: "missing" })).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      await sb.destroy();
    }
  });

  it("enforces the wall-clock timeout and the output cap, and reports non-zero exits as results", async () => {
    const sb = await ProcessSandbox.create({
      worktree,
      limits: { timeoutMs: 60_000 },
      network: { mode: "none" },
    });
    try {
      const t0 = performance.now();
      const r = await sb.run([NODE, "-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 400 });
      expect(r.timedOut).toBe(true);
      expect(performance.now() - t0).toBeLessThan(10_000);

      const big = await sb.run([NODE, "-e", "process.stdout.write('x'.repeat(200000))"], {
        maxOutputBytes: 1024,
      });
      expect(big.truncated).toBe(true);
      expect(big.stdout.length).toBeLessThanOrEqual(1024);

      const fail = await sb.run([NODE, "-e", "process.exit(3)"]);
      expect(fail.code).toBe(3);
    } finally {
      await sb.destroy();
    }
  });

  it("network none denies every proxied request (deny-all egress proxy)", async () => {
    const decisions: { host: string; allowed: boolean }[] = [];
    const sb = await ProcessSandbox.create({
      worktree,
      limits: { timeoutMs: 20_000 },
      network: { mode: "none" },
      egress: { onDecision: (d) => decisions.push({ host: d.host, allowed: d.allowed }) },
    });
    try {
      const script = [
        "const u = new URL(process.env.HTTP_PROXY);",
        "const auth = 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64');",
        "require('http').request({ host: u.hostname, port: u.port, path: 'http://example.com/', headers: { 'proxy-authorization': auth } }, (res) => { console.log(res.statusCode); process.exit(0); }).on('error', (e) => { console.error(e.message); process.exit(2); }).end();",
      ].join("\n");
      const r = await sb.run([NODE, "-e", script]);
      expect(r.stdout.trim()).toBe("403");
      expect(decisions).toEqual([{ host: "example.com", allowed: false }]);
    } finally {
      await sb.destroy();
    }
  });

  it("writes files with LF endings inside the worktree and refuses escapes", async () => {
    const sb = await ProcessSandbox.create({
      worktree,
      limits: { timeoutMs: 20_000 },
      network: { mode: "none" },
    });
    try {
      await sb.writeFile("a/b.txt", "x\r\ny\r\n");
      expect(await sb.readFile("a/b.txt")).toBe("x\ny\n");
      expect(await sb.exists("a")).toBe(true);
      await expect(sb.writeFile("../b.txt", "x")).rejects.toMatchObject({
        code: "path_not_allowed",
      });
    } finally {
      await sb.destroy();
    }
    await expect(sb.run([NODE, "-p", "1"])).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses file access and cwd through a symlink that leaves the worktree", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "fr-psb-out-")));
    try {
      await writeFile(join(outside, "secret.txt"), "HOST SECRET");
      await mkdir(join(worktree, "inner"));
      const dirType = process.platform === "win32" ? "junction" : "dir";
      let linked = true;
      try {
        await symlink(outside, join(worktree, "link"), dirType);
        await symlink(join(worktree, "inner"), join(worktree, "stay"), dirType);
      } catch {
        linked = false;
      }
      if (!linked) return;
      const sb = await ProcessSandbox.create({
        worktree,
        limits: { timeoutMs: 20_000 },
        network: { mode: "none" },
      });
      try {
        await expect(sb.readFile("link/secret.txt")).rejects.toMatchObject({
          code: "path_not_allowed",
        });
        await expect(sb.writeFile("link/pwned.txt", "x")).rejects.toMatchObject({
          code: "path_not_allowed",
        });
        await expect(sb.exists("link/secret.txt")).rejects.toMatchObject({
          code: "path_not_allowed",
        });
        await expect(sb.run([NODE, "-p", "1"], { cwd: "link" })).rejects.toMatchObject({
          code: "path_not_allowed",
        });
        // A link that stays inside is followed and the real directory is used.
        const r = await sb.run([NODE, "-p", "process.cwd()"], { cwd: "stay" });
        expect(await realpath(r.stdout.trim())).toBe(join(worktree, "inner"));
        await sb.writeFile("stay/ok.txt", "inside");
        expect(await readFile(join(worktree, "inner", "ok.txt"), "utf8")).toBe("inside");
      } finally {
        await sb.destroy();
      }
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("HOST SECRET");
      await expect(readFile(join(outside, "pwned.txt"))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
