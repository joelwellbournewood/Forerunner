import { appDirs, ForerunnerError, join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMAND_POLL_MS,
  DEFAULT_HEALTH_PORT,
  DEFAULT_INBOX_POLL_MS,
  DEFAULT_MAIL_CHECK_MS,
  DEFAULT_PC_ONLINE_MS,
  defaultRunnerId,
  describeConfig,
  readRunnerConfig,
  redactStoreUrl,
} from "../src/config.ts";

const HOME = join("/tmp", "fr-config-test");
// appDirs resolves the override, which on Windows adds the drive letter; expect the same.
const DIRS = appDirs({ env: { FORERUNNER_HOME: HOME } });
const PG = "postgres://user:hunter2@db.internal:5432/forerunner"; // not-a-secret

describe("runner configuration", () => {
  it("needs the shared state URL and nothing else; every other value has a default", () => {
    const cfg = readRunnerConfig({ FORERUNNER_HOME: HOME, FORERUNNER_STATE_URL: PG });
    expect(cfg.stateUrl).toBe(PG);
    expect(cfg.runnerId).toBe(defaultRunnerId());
    expect(cfg.runnerId).toMatch(/^runner-[a-z0-9._-]+$/);
    expect(cfg.human).toBeUndefined();
    expect(cfg.agent).toBeUndefined();
    expect(cfg.vaultPath).toBe(join(DIRS.config, "vault.runner.json"));
    expect(cfg.unlock).toMatchObject({ policy: "window", pollMs: 2_000, idleLockMs: 0 });
    expect(cfg.personal).toBe(false);
    expect(cfg.mail).toMatchObject({
      checkIntervalMs: DEFAULT_MAIL_CHECK_MS,
      push: true,
      verifier: "mailauth",
      trustedAuthservIds: [],
    });
    expect(cfg.health).toEqual({
      host: "127.0.0.1",
      port: DEFAULT_HEALTH_PORT,
      readyFile: join(DIRS.runtime, "runner-ready.json"),
    });
    expect(cfg.pcOnlineMs).toBe(DEFAULT_PC_ONLINE_MS);
    expect(cfg.commandPollMs).toBe(DEFAULT_COMMAND_POLL_MS);
    expect(cfg.inboxPollMs).toBe(DEFAULT_INBOX_POLL_MS);
  });

  it("inbox triggers can be turned off with 0 but not polled faster than once a second", () => {
    const off = readRunnerConfig({
      FORERUNNER_HOME: HOME,
      FORERUNNER_STATE_URL: PG,
      FORERUNNER_RUNNER_INBOX_POLL_MS: "0",
    });
    expect(off.inboxPollMs).toBe(0);
    expect(() =>
      readRunnerConfig({
        FORERUNNER_HOME: HOME,
        FORERUNNER_STATE_URL: PG,
        FORERUNNER_RUNNER_INBOX_POLL_MS: "500",
      }),
    ).toThrow(/inboxPollMs/);
  });

  it("refuses a missing or malformed state URL with every issue listed", () => {
    expect(() => readRunnerConfig({ FORERUNNER_HOME: HOME })).toThrowError(ForerunnerError);
    try {
      readRunnerConfig({
        FORERUNNER_HOME: HOME,
        FORERUNNER_STATE_URL: "mysql://x",
        FORERUNNER_RUNNER_HEALTH_PORT: "70000",
        FORERUNNER_RUNNER_COMMAND_POLL_MS: "5000",
      });
      throw new Error("unreachable");
    } catch (e) {
      const err = e as ForerunnerError;
      expect(err.code).toBe("validation");
      const issues = (err.details as { issues: string[] }).issues.join("\n");
      expect(issues).toContain("stateUrl");
      expect(issues).toContain("health.port");
      expect(issues).toContain("commandPollMs");
    }
  });

  it("reads overrides, lists and booleans from the environment", () => {
    const cfg = readRunnerConfig({
      FORERUNNER_HOME: HOME,
      FORERUNNER_STATE_URL: "sqlite::memory:",
      FORERUNNER_STATE_SCHEMA: "fr_a",
      FORERUNNER_RUNNER_ID: "box-1",
      FORERUNNER_RUNNER_HUMAN: "j@example.test",
      FORERUNNER_RUNNER_AGENT: "Alice",
      FORERUNNER_RUNNER_UNLOCK: "ask",
      FORERUNNER_RUNNER_PERSONAL: "yes",
      FORERUNNER_RUNNER_MAIL_VERIFIER: "header",
      FORERUNNER_RUNNER_MAIL_AUTHSERV_IDS: "mx.google.com, mx.example.test",
      FORERUNNER_RUNNER_MAIL_PUSH: "0",
      FORERUNNER_RUNNER_MAIL_CHECK_MS: "60000",
      FORERUNNER_RUNNER_HEALTH_PORT: "0",
      FORERUNNER_VERSION: "1.2.3",
    });
    expect(cfg).toMatchObject({
      stateSchema: "fr_a",
      runnerId: "box-1",
      human: "j@example.test",
      agent: "Alice",
      unlock: { policy: "ask" },
      personal: true,
      mail: {
        verifier: "header",
        trustedAuthservIds: ["mx.google.com", "mx.example.test"],
        push: false,
        checkIntervalMs: 60_000,
      },
      health: { port: 0 },
      version: "1.2.3",
    });
  });

  it("refuses a header verifier without trusted authserv-ids and a mail interval under 10 s", () => {
    expect(() =>
      readRunnerConfig({
        FORERUNNER_HOME: HOME,
        FORERUNNER_STATE_URL: PG,
        FORERUNNER_RUNNER_MAIL_VERIFIER: "header",
      }),
    ).toThrow(/AUTHSERV_IDS/);
    expect(() =>
      readRunnerConfig({
        FORERUNNER_HOME: HOME,
        FORERUNNER_STATE_URL: PG,
        FORERUNNER_RUNNER_MAIL_CHECK_MS: "5000",
      }),
    ).toThrow(/checkIntervalMs/);
  });

  it("never echoes the store credential in its description", () => {
    const cfg = readRunnerConfig({ FORERUNNER_HOME: HOME, FORERUNNER_STATE_URL: PG });
    const described = JSON.stringify(describeConfig(cfg));
    expect(described).not.toContain("hunter2");
    expect(described).toContain("[REDACTED]");
    expect(redactStoreUrl(PG)).toBe("postgres://[REDACTED]@db.internal:5432/forerunner");
    expect(redactStoreUrl("sqlite::memory:")).toBe("sqlite::memory:");
    // A password with a literal "@" (not percent-encoded) must not leak its tail.
    const atSign = ["postgres://u:p", "ss@db.internal/forerunner?sslmode=require"].join("@"); // not-a-secret
    expect(redactStoreUrl(atSign)).toBe(
      "postgres://[REDACTED]@db.internal/forerunner?sslmode=require",
    );
    expect(redactStoreUrl("postgres://u:p@h")).toBe("postgres://[REDACTED]@h");
    expect(redactStoreUrl("postgres://u:p@h?x=a@b")).toBe("postgres://[REDACTED]@h?x=a@b");
    expect(redactStoreUrl("postgres://db.internal/forerunner")).toBe(
      "postgres://db.internal/forerunner",
    );
  });

  it("refuses a health host off the loopback interface together with the other issues", () => {
    try {
      readRunnerConfig({
        FORERUNNER_HOME: HOME,
        FORERUNNER_STATE_URL: PG,
        FORERUNNER_RUNNER_HEALTH_HOST: "0.0.0.0",
        FORERUNNER_RUNNER_COMMAND_POLL_MS: "5000",
      });
      throw new Error("unreachable");
    } catch (e) {
      const err = e as ForerunnerError;
      expect(err.code).toBe("validation");
      const issues = (err.details as { issues: string[] }).issues.join("\n");
      expect(issues).toContain("health.host");
      expect(issues).toContain("commandPollMs");
    }
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "127.1.2.3"]) {
      expect(
        readRunnerConfig({
          FORERUNNER_HOME: HOME,
          FORERUNNER_STATE_URL: PG,
          FORERUNNER_RUNNER_HEALTH_HOST: host,
        }).health.host,
      ).toBe(host);
    }
  });
});
