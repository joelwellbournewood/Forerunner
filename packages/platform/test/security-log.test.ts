import { describe, expect, it } from "vitest";
import { Logger, type LogRecord, redact, redactDeep } from "../src/log.ts";

/**
 * Security review of the redacting logger (spec S.4 "logs are scanned and redacted"). What
 * goes through `Logger` must come out without a credential, whatever the shape of the data.
 * A test marked `it.fails` is a finding on the current code (comment above it).
 */

// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const ANTHROPIC = ["sk-ant-api03-", "fixture", "0".repeat(40)].join(""); // not-a-secret
const GITHUB = ["ghp_", "fixture", "A".repeat(30)].join(""); // not-a-secret
const PASSWORD = ["corr", "ect-horse-battery-", "staple-9"].join(""); // not-a-secret
const RAW32 = ["Qm9", "yaW5nIGZpeHR1cmUgdmFsdWUgZm9yIHRlc3Rz", "AAAA"].join(""); // not-a-secret

function capture(): { records: LogRecord[]; restore: () => void } {
  const records: LogRecord[] = [];
  Logger.setSinks([(r) => records.push(r)]);
  Logger.setLevel("debug");
  return {
    records,
    restore: () => {
      Logger.setSinks([]);
      Logger.setLevel("info");
    },
  };
}

describe("logger: known shapes anywhere in a record", () => {
  it("a token in the message, in nested data, in an array and in an error string is masked before any sink", () => {
    const c = capture();
    try {
      const log = new Logger("sec");
      log.info(`provider said ${ANTHROPIC}`, {
        nested: { deeper: { err: `Error: bad token ${GITHUB}` } },
        list: [ANTHROPIC, { k: GITHUB }],
        headers: {
          Authorization: `Bearer ${ANTHROPIC}`,
          cookie: "session=abc",
          "x-api-key": ANTHROPIC,
        },
        password: PASSWORD,
        apiKey: PASSWORD,
        client_secret: PASSWORD,
        access_token: PASSWORD,
      });
      const text = JSON.stringify(c.records);
      expect(text).not.toContain(ANTHROPIC);
      expect(text).not.toContain(GITHUB);
      expect(text).not.toContain(PASSWORD);
      expect(text).toContain("[REDACTED]");
    } finally {
      c.restore();
    }
  });

  it("a sink that throws never stops the others or the caller", () => {
    const seen: LogRecord[] = [];
    Logger.setSinks([
      () => {
        throw new Error("sink down");
      },
      (r) => seen.push(r),
    ]);
    try {
      expect(() => new Logger("sec").warn("still logged")).not.toThrow();
      expect(seen).toHaveLength(1);
    } finally {
      Logger.setSinks([]);
    }
  });
});

describe("logger: gaps", () => {
  // security finding (low): a connection string with user-info is the most common way a
  // database password reaches a log line (`FORERUNNER_STATE_URL`, `FORERUNNER_TEST_PG`,
  // migration errors that echo the URL). No pattern in `SECRET_PATTERNS` matches
  // `scheme://user:password@host`. Fix: add `/(\w+:\/\/[^\s:@/]+:)([^\s@/]+)@/g` keeping the user.
  it("security finding: the password of a connection string is masked", () => {
    const line = `cannot connect to postgres://forerunner:${PASSWORD}@db.internal:5432/forerunner`;
    const out = redact(line);
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain("db.internal");
  });

  // security finding (low): `redactDeep` masks values by key name for secret|token|password|
  // api[_-]?key|authorization|cookie. `private_key`, `signing_key`, `vault_key`,
  // `credentials`, `passwd`, `passphrase` and a bare `key` are not in the list, and a raw
  // 32-byte base64 value under them has no shape the patterns know (the lookahead wants the
  // keyword *after* the value). Fix: widen the key regex (`key$`, `credential`, `pass(wd|phrase)?$`).
  it("security finding: values under other credential-like key names are masked", () => {
    const out = redactDeep({
      private_key: RAW32,
      signing_key: RAW32,
      vault_key: RAW32,
      credentials: RAW32,
      passwd: PASSWORD,
      passphrase: PASSWORD,
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(RAW32);
    expect(text).not.toContain(PASSWORD);
  });

  // security finding (low): `redactDeep` stops at depth 8 and returns the subtree as is, so a
  // token nested nine objects deep (an error's `cause` chain, an SDK response echoed into
  // `data`) is serialised by the console sink in clear. Fix: redact the serialised string at
  // the sink, or recurse without a depth cap and guard against cycles with a `WeakSet`.
  it("security finding: a token nested deeper than eight levels is still masked", () => {
    const c = capture();
    try {
      let data: Record<string, unknown> = { token: GITHUB, msg: `key ${ANTHROPIC}` };
      for (let i = 0; i < 10; i++) data = { level: data };
      new Logger("sec").error("deep", data);
      const text = JSON.stringify(c.records);
      expect(text).not.toContain(GITHUB);
      expect(text).not.toContain(ANTHROPIC);
    } finally {
      c.restore();
    }
  });
});
