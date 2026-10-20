import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MemoryGitHost } from "@forerunner/capabilities/githost/memory";
import { join } from "@forerunner/platform";
import { openStore, silenceSqliteExperimentalWarning } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertStartable, readConfig } from "../src/config.ts";
import { envSecretResolver, resolveAdminToken, startService } from "../src/main.ts";

silenceSqliteExperimentalWarning();

const TOKEN = ["smoke", "admin", "token", "value"].join("-"); // not-a-secret

describe("configuration", () => {
  it("reads every setting from FORERUNNER_* variables with the documented defaults", () => {
    const cfg = readConfig({ FORERUNNER_HOME: join(tmpdir(), "fr-cfg") });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(8788);
    expect(cfg.rateLimitPerMinute).toBe(60);
    expect(cfg.sessionTokenTtlMs).toBe(30 * 24 * 3600 * 1000);
    expect(cfg.signatureWindowMs).toBe(5 * 60 * 1000);
    expect(cfg.pollIntervalMs).toBe(2000);
    expect(cfg.heartbeatMs).toBe(15000);
    expect(cfg.uploadsDir).toBe(join(tmpdir(), "fr-cfg", "data", "uploads"));
    expect(cfg.serviceStateDir).toBe(join(tmpdir(), "fr-cfg", "data", "state-api"));
    expect(cfg.adminToken).toBeUndefined();
    const custom = readConfig({
      FORERUNNER_STATE_API_HOST: "0.0.0.0",
      FORERUNNER_STATE_API_PORT: "9000",
      FORERUNNER_STATE_API_RATE_LIMIT: "120",
      FORERUNNER_STATE_API_CORS_ORIGIN: "https://approvals.example.test",
    });
    expect(custom.host).toBe("0.0.0.0");
    expect(custom.port).toBe(9000);
    expect(custom.rateLimitPerMinute).toBe(120);
    expect(custom.corsOrigin).toBe("https://approvals.example.test");
    expect(() => readConfig({ FORERUNNER_STATE_API_PORT: "abc" })).toThrow(
      /FORERUNNER_STATE_API_PORT/,
    );
  });

  it("refuses to start without a store URL or an admin token source", () => {
    expect(() => assertStartable(readConfig({}))).toThrow(/FORERUNNER_STATE_URL/);
    expect(() => assertStartable(readConfig({ FORERUNNER_STATE_URL: "sqlite::memory:" }))).toThrow(
      /ADMIN_TOKEN/,
    );
    expect(() =>
      assertStartable(
        readConfig({
          FORERUNNER_STATE_URL: "sqlite::memory:",
          FORERUNNER_STATE_API_ADMIN_TOKEN_REF: "secret:state_api_admin",
        }),
      ),
    ).not.toThrow();
  });

  it("resolves the admin token from the env var or from an injected secret reference", async () => {
    const direct = readConfig({ FORERUNNER_STATE_API_ADMIN_TOKEN: TOKEN });
    expect(await resolveAdminToken(direct, async () => undefined)).toBe(TOKEN);
    const byRef = readConfig({ FORERUNNER_STATE_API_ADMIN_TOKEN_REF: "secret:state_api_admin" });
    const resolver = envSecretResolver({ FORERUNNER_SECRET_STATE_API_ADMIN: TOKEN });
    expect(await resolveAdminToken(byRef, resolver)).toBe(TOKEN);
    await expect(resolveAdminToken(byRef, async () => undefined)).rejects.toThrow(
      /resolved to nothing/,
    );
  });
});

describe("startService", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fr-state-api-main-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("boots on a random port, migrates an empty database, serves /health and stops cleanly", async () => {
    const service = await startService({
      FORERUNNER_HOME: home,
      FORERUNNER_STATE_URL: `sqlite:${join(home, "state.sqlite")}`,
      FORERUNNER_STATE_API_PORT: "0",
      FORERUNNER_STATE_API_ADMIN_TOKEN: TOKEN,
    });
    try {
      expect(service.config.adminToken).toBe("[set]");
      const health = (await (await fetch(`${service.url}/health`)).json()) as {
        ok: boolean;
        schema: { state: string };
      };
      expect(health.ok).toBe(true);
      expect(health.schema.state).toBe("current");
      const me = await fetch(`${service.url}/me`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(me.status).toBe(200);
    } finally {
      await service.stop();
    }
    await expect(fetch(`${service.url}/health`)).rejects.toThrow();
  });

  it("refuses a database whose schema is newer than the code", async () => {
    const url = `sqlite:${join(home, "ahead.sqlite")}`;
    const env = {
      FORERUNNER_HOME: home,
      FORERUNNER_STATE_URL: url,
      FORERUNNER_STATE_API_PORT: "0",
      FORERUNNER_STATE_API_ADMIN_TOKEN: TOKEN,
    };
    const first = await startService(env);
    await first.stop();
    const { openStore } = await import("@forerunner/state");
    const store = await openStore({ url, migrate: false });
    await store.db.query(
      'INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (?, ?, ?)',
      [99, "from-the-future", "2027-01-01T00:00:00.000Z"],
    );
    await store.close();
    await expect(startService(env)).rejects.toThrow(/newer than this service/);
  });
});

describe("GitHub mirror wiring", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fr-state-api-mirror-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const GITHUB_TOKEN = ["ghp", "unit", "test", "mirror", "token"].join("_"); // not-a-secret

  it("builds the mirror from FORERUNNER_MIRROR_* with the token by reference, reports it on /health and syncs on the interval", async () => {
    const url = `sqlite:${join(home, "mirror.sqlite")}`;
    const host = new MemoryGitHost("forerunner-bot");
    await host.createRepo({ owner: "acme", name: "demo", private: true });
    const seen: { token: string; apiUrl: string | undefined }[] = [];
    const service = await startService(
      {
        FORERUNNER_HOME: home,
        FORERUNNER_STATE_URL: url,
        FORERUNNER_STATE_API_PORT: "0",
        FORERUNNER_STATE_API_ADMIN_TOKEN: TOKEN,
        FORERUNNER_MIRROR_REPO: "acme/demo",
        FORERUNNER_MIRROR_TOKEN_REF: "secret:github_token",
        FORERUNNER_MIRROR_INTERVAL_MS: "40",
        FORERUNNER_SECRET_GITHUB_TOKEN: GITHUB_TOKEN,
      },
      undefined,
      {
        mirrorHost: (opts) => {
          seen.push({ token: opts.token, apiUrl: opts.apiUrl });
          return host;
        },
      },
    );
    try {
      expect(seen).toEqual([{ token: GITHUB_TOKEN, apiUrl: undefined }]);
      expect(service.mirror?.repo).toBe("acme/demo");
      const health = (await (await fetch(`${service.url}/health`)).json()) as {
        mirror: { enabled: boolean; repo: string | null };
      };
      expect(health.mirror).toEqual({ enabled: true, repo: "acme/demo" });
      // A runtime writes a project and a task straight into the database.
      const store = await openStore({ url, migrate: false });
      const project = await store.project.insert({ name: "Wired", goal: "prove the loop" });
      await store.human.insert({ name: "Ada", email: "ada@example.test" });
      await store.task.insert({
        project_id: project.id,
        title: "Mirrored by the service",
        outcome: "o",
        status: "ready",
      });
      await store.close();
      // The scheduler runs on the system clock every 40 ms.
      const deadline = Date.now() + 5_000;
      let issues: { title: string }[] = [];
      while (Date.now() < deadline) {
        issues = await host.listIssues({ owner: "acme", name: "demo" }, { state: "all" });
        if (issues.length > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(issues.map((i) => i.title)).toEqual(["Mirrored by the service"]);
      expect(service.mirror?.runs ?? 0).toBeGreaterThan(0);
      const report = await service.mirror?.runOnce();
      expect(report?.push).toEqual({ created: 0, updated: 0, unchanged: 1 });
    } finally {
      await service.stop();
    }
    const runsAtStop = service.mirror?.runs ?? 0;
    await new Promise((r) => setTimeout(r, 100));
    expect(service.mirror?.runs).toBe(runsAtStop);
  });

  it("refuses to start when the mirror token reference resolves to nothing or the repo is malformed", async () => {
    const base = {
      FORERUNNER_HOME: home,
      FORERUNNER_STATE_URL: `sqlite:${join(home, "bad.sqlite")}`,
      FORERUNNER_STATE_API_PORT: "0",
      FORERUNNER_STATE_API_ADMIN_TOKEN: TOKEN,
    };
    await expect(
      startService({
        ...base,
        FORERUNNER_MIRROR_REPO: "acme/demo",
        FORERUNNER_MIRROR_TOKEN_REF: "secret:github_token",
      }),
    ).rejects.toThrow(/github_token/);
    await expect(
      startService({
        ...base,
        FORERUNNER_MIRROR_REPO: "not-a-repo",
        FORERUNNER_MIRROR_TOKEN_REF: "secret:github_token",
        FORERUNNER_SECRET_GITHUB_TOKEN: GITHUB_TOKEN,
      }),
    ).rejects.toThrow(/FORERUNNER_MIRROR_REPO/);
    // Without a repo the service runs with the mirror off.
    const off = await startService(base);
    try {
      expect(off.mirror).toBeUndefined();
    } finally {
      await off.stop();
    }
  });
});
