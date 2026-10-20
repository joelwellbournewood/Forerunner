import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, run, SimulatedClock } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KillFileWatcher, readKillRequest } from "../src/enforcement/killfile.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";

const GOOD_GH = ["ghp_", "goodtoken000000000000000000000000000000"].join(""); // not-a-secret
const CLI = join(process.cwd(), "packages", "runtime", "src", "cli", "main.ts");
const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

function fakeApis(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const auth = req.headers.authorization ?? "";
      const apiKey = req.headers["x-api-key"];
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/user")
        return auth === `Bearer ${GOOD_GH}` ? send(200, { login: "j" }) : send(401, {});
      if (req.url?.startsWith("/repos/o/r"))
        return send(200, { permissions: { pull: true, push: true } });
      if (req.url?.startsWith("/v1/models"))
        return apiKey === "sk-ant-api03-goodkey"
          ? send(200, { data: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }] })
          : send(401, {});
      send(404, {});
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("fr CLI", () => {
  let api: { server: Server; url: string };
  let home: string;
  const env = () => ({
    ...process.env,
    FORERUNNER_HOME: home,
    FORERUNNER_VAULT_BACKEND: "file",
    FORERUNNER_LOG_LEVEL: "error",
  });
  const fr = (...args: string[]) =>
    run([process.execPath, TSX, CLI, ...args], {
      env: env(),
      allowFailure: true,
      timeoutMs: 60_000,
    });

  beforeAll(async () => {
    api = await fakeApis();
    home = mkdtempSync(join(tmpdir(), "fr-cli-"));
  });
  afterAll(() => api.server.close());

  it("prints help and the directories", async () => {
    const h = await fr("--help");
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("setup");
    const d = await fr("dirs");
    expect(d.code).toBe(0);
    expect(d.stdout).toContain(home);
  });

  it("non-interactive setup validates and stores credentials without echoing them", async () => {
    const r = await fr(
      "setup",
      "--non-interactive",
      "--github-token",
      GOOD_GH,
      "--anthropic-key",
      "sk-ant-api03-goodkey",
      "--repos",
      "o/r",
      "--github-api",
      api.url,
      "--anthropic-api",
      api.url,
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Setup complete.");
    expect(r.stdout).not.toContain("goodtoken");
    expect(r.stdout).not.toContain("goodkey");
    const cfg = JSON.parse(readFileSync(join(home, "config", "config.json"), "utf8"));
    expect(cfg.credentials).toEqual({
      github: true,
      anthropic: true,
      anthropicSubscription: false,
    });
    expect(JSON.stringify(cfg)).not.toContain("goodkey");
    const s = await fr("status");
    expect(s.code).toBe(0);
    expect(s.stdout).toContain("github_token");
    expect(s.stdout).toContain("anthropic_api_key");
    expect(s.stdout).not.toContain("goodkey");
  });

  it("rejects a bad token in non-interactive mode with a clear message and no partial store", async () => {
    const home2 = mkdtempSync(join(tmpdir(), "fr-cli-bad-"));
    const r = await run(
      [
        process.execPath,
        TSX,
        CLI,
        "setup",
        "--non-interactive",
        "--github-token",
        ["ghp_", "badtoken0000000000000000000000000000000"].join(""),
        "--github-api",
        api.url,
      ],
      {
        env: { ...env(), FORERUNNER_HOME: home2 },
        allowFailure: true,
        timeoutMs: 60_000,
      },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/GitHub token rejected/);
    expect(r.stderr).not.toContain("badtoken");
    const s = await run([process.execPath, TSX, CLI, "status"], {
      env: { ...env(), FORERUNNER_HOME: home2 },
      allowFailure: true,
      timeoutMs: 60_000,
    });
    expect(s.stdout).not.toContain("github_token");
    expect(existsSync(join(home2, "config", "config.json"))).toBe(false);
  });

  it("setup without credentials still succeeds and says what is missing", async () => {
    const home3 = mkdtempSync(join(tmpdir(), "fr-cli-none-"));
    const r = await run([process.execPath, TSX, CLI, "setup", "--non-interactive"], {
      env: { ...env(), FORERUNNER_HOME: home3 },
      allowFailure: true,
      timeoutMs: 60_000,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Not configured yet: github, anthropic");
  });

  it("doctor reports prerequisites", async () => {
    const r = await fr("doctor", "--json");
    const checks = JSON.parse(r.stdout) as { name: string; ok: boolean }[];
    expect(checks.find((c) => c.name === "node")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "git")?.ok).toBe(true);
  });

  it("kill writes a request that a running runtime picks up", async () => {
    const r = await fr("kill", "--agent", "alice", "--reason", "test");
    expect(r.code).toBe(0);
    const req = readKillRequest(join(home, "runtime"));
    expect(req).toMatchObject({ scope: { agentId: "alice" }, requestedBy: "fr kill" });
    const clock = new SimulatedClock();
    const ks = new KillSwitch();
    const c = new AbortController();
    ks.register({ agentId: "alice", sessionId: "s", controller: c, label: "x" });
    const w = new KillFileWatcher(ks, clock, join(home, "runtime"), 500);
    w.start();
    await clock.advance(500);
    await new Promise((res) => setTimeout(res, 20));
    expect(c.signal.aborted).toBe(true);
    // the same request is not applied twice
    expect(await w.check()).toBe(false);
    w.stop();
  });
});
