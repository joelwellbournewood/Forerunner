import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import {
  appDirs,
  isAbsolute,
  isForerunnerError,
  join,
  normalize,
  run,
  SimulatedClock,
} from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KillFileWatcher, readKillRequest } from "../src/enforcement/killfile.ts";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import {
  currentInstallRecord,
  INSTALL_RECORD_FILE,
  parseInstallRecord,
  readInstallRecord,
  writeInstallRecord,
} from "../src/setup/install-record.ts";

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
      if (req.url?.startsWith("/v1/models") && apiKey === "sk-ant-usr-wskey")
        return req.headers["anthropic-workspace-id"] === "wrkspc_test"
          ? send(200, { data: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }] })
          : send(400, { error: { type: "invalid_request_error", message: "workspace header" } });
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

// Each case spawns the CLI through tsx, whose cold compile of the runtime can exceed the
// default 20 s on a loaded runner; the spawn itself is capped at 60 s per call.
describe("fr CLI", { timeout: 180_000 }, () => {
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

  it("a user-scoped key is validated and stored with its workspace id, which is sent on every call", async () => {
    const r = await fr(
      "setup",
      "--non-interactive",
      "--anthropic-key",
      "sk-ant-usr-wskey",
      "--anthropic-workspace",
      "wrkspc_test",
      "--anthropic-api",
      api.url,
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(home, "config", "config.json"), "utf8"));
    expect(cfg.anthropicWorkspaceId).toBe("wrkspc_test");
    expect(cfg.credentials.anthropic).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain("wskey");
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
    // The install record is written whether or not a credential was given.
    expect(existsSync(join(home3, "config", INSTALL_RECORD_FILE))).toBe(true);
  });

  it("setup writes the install record the desktop shell reads: schema 1, absolute installDir, node", async () => {
    // Every `fr setup` above wrote it from the running process; nothing about it is configured.
    const path = join(home, "config", INSTALL_RECORD_FILE);
    const rec = parseInstallRecord(readFileSync(path, "utf8"));
    expect(rec.schema).toBe(1);
    expect(isAbsolute(rec.installDir)).toBe(true);
    // The checkout this test runs from (derived from import.meta.url, never a configured path).
    expect(normalize(rec.installDir)).toBe(normalize(realpathSync(process.cwd())));
    // What install.rs checks in the directory before it runs `fr` from it.
    expect(existsSync(join(rec.installDir, "node_modules", "tsx", "dist", "cli.mjs"))).toBe(true);
    expect(existsSync(join(rec.installDir, "packages", "runtime", "src", "cli", "main.ts"))).toBe(
      true,
    );
    // The node binary that ran setup (the CLI was spawned with this process's own).
    expect(rec.node).toBe(process.execPath);
    expect(isAbsolute(rec.node as string)).toBe(true);
    // Atomic write: nothing half-written is left next to the record.
    expect(
      readdirSync(join(home, "config")).filter(
        (n) => n.startsWith(INSTALL_RECORD_FILE) && n !== INSTALL_RECORD_FILE,
      ),
    ).toEqual([]);
    expect(readInstallRecord(appDirs({ env: { FORERUNNER_HOME: home } }))).toEqual(rec);
    // The setup output names it without echoing anything secret.
    const r = await fr("setup", "--non-interactive", "--anthropic-api", api.url);
    expect(r.stdout).toContain(`Install record: ${path}`);
  });

  it("the install record parser mirrors the shell's rules (install.rs parse_install_record)", () => {
    expect(
      parseInstallRecord('{"schema":1,"installDir":"/opt/fr","node":"/usr/bin/node"}'),
    ).toEqual({ schema: 1, installDir: "/opt/fr", node: "/usr/bin/node" });
    // node is optional and an empty string counts as absent, as in the shell.
    expect(parseInstallRecord('{"schema":1,"installDir":"C:\\\\fr"}')).toEqual({
      schema: 1,
      installDir: "C:\\fr",
    });
    expect(parseInstallRecord('{"schema":1,"installDir":"/opt/fr","node":""}')).toEqual({
      schema: 1,
      installDir: "/opt/fr",
    });
    for (const bad of [
      '{"schema":2,"installDir":"/opt/fr"}',
      '{"schema":"1","installDir":"/opt/fr"}',
      '{"schema":1}',
      '{"schema":1,"installDir":""}',
      '{"schema":1,"installDir":7}',
      "nope",
      "[]",
      "null",
    ]) {
      let err: unknown = null;
      try {
        parseInstallRecord(bad);
      } catch (e) {
        err = e;
      }
      expect(isForerunnerError(err, "validation"), bad).toBe(true);
    }
    // From the running process: the checkout root and process.execPath; a node that is not an
    // absolute path is left out rather than written for the shell to fail on.
    const current = currentInstallRecord();
    expect(normalize(current.installDir)).toBe(normalize(realpathSync(process.cwd())));
    expect(current.node).toBe(process.execPath);
    expect(currentInstallRecord({ execPath: "node" }).node).toBeUndefined();
    // The writer refuses what the shell could not resolve.
    const scratch = mkdtempSync(join(tmpdir(), "fr-install-record-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: scratch } });
    let relative: unknown = null;
    try {
      writeInstallRecord(dirs, { schema: 1, installDir: "relative" });
    } catch (e) {
      relative = e;
    }
    expect(isForerunnerError(relative, "validation")).toBe(true);
    expect(existsSync(join(dirs.config, INSTALL_RECORD_FILE))).toBe(false);
    const written = writeInstallRecord(dirs, current);
    expect(written).toBe(join(dirs.config, INSTALL_RECORD_FILE));
    expect(readInstallRecord(dirs)).toEqual(current);
  });

  it("setup --email and --human-id persist the install's identity selector", async () => {
    const r = await fr("setup", "--non-interactive", "--email", "J@Example.test");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Identity: j@example.test");
    const cfg = JSON.parse(readFileSync(join(home, "config", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(cfg.humanEmail).toBe("j@example.test");
    expect(cfg.humanId).toBeUndefined();
    const bound = await fr("setup", "--non-interactive", "--human-id", "h-123");
    expect(bound.code).toBe(0);
    expect(bound.stdout).toContain("Identity: bound to human h-123");
    const again = JSON.parse(readFileSync(join(home, "config", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(again).toMatchObject({ humanEmail: "j@example.test", humanId: "h-123" });
    const bad = await fr("setup", "--non-interactive", "--email", "nope");
    expect(bad.code).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`).toContain("not an email address");
  });

  it("doctor reports prerequisites and the human the install binds to", async () => {
    const r = await fr("doctor", "--json");
    const checks = JSON.parse(r.stdout) as { name: string; ok: boolean; detail: string }[];
    expect(checks.find((c) => c.name === "node")?.ok).toBe(true);
    expect(checks.find((c) => c.name === "git")?.ok).toBe(true);
    // The config from the setups above names human h-123, which the store does not hold yet.
    const identity = checks.find((c) => c.name === "identity");
    expect(identity?.ok).toBe(false);
    expect(identity?.detail).toContain("h-123");
    expect(identity?.detail).toContain("FORERUNNER_HUMAN");
    // The environment override is read the way the daemon reads it.
    const over = await run([process.execPath, TSX, CLI, "doctor", "--json"], {
      env: { ...env(), FORERUNNER_HUMAN: "" },
      allowFailure: true,
      timeoutMs: 60_000,
    });
    expect(
      (JSON.parse(over.stdout) as { name: string; ok: boolean }[]).find(
        (c) => c.name === "identity",
      )?.ok,
    ).toBe(false);
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
