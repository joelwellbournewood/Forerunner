import { describe, expect, it } from "vitest";
import { Logger, type LogRecord, redact, redactDeep } from "../src/log.ts";

// Fixtures are assembled at runtime so the repository secret scan never sees a credential shape.
const fake = {
  anthropic: ["sk-ant-", "api03-", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
  github: ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].join(""),
  githubPat: ["github_", "pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"].join(""),
  jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "abcdefghij"].join("."),
  aws: ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
  pem: ["-----BEGIN ", "PRIVATE KEY-----\nMIIabc\n-----END ", "PRIVATE KEY-----"].join(""),
};

describe("redaction", () => {
  it("masks known credential shapes", () => {
    const samples = [
      `key ${fake.anthropic}`,
      `token ${fake.github}`,
      fake.githubPat,
      `Authorization: Bearer ${fake.jwt}`,
      "password=hunter2hunter2",
      fake.aws,
      fake.pem,
    ];
    for (const s of samples) {
      const r = redact(s);
      expect(r).toContain("[REDACTED]");
      for (const needle of [
        "abcdefghijklmnop",
        "hunter2",
        "ABCDEFGHIJKLMNOP",
        "MIIabc",
        "11ABCDEFG",
      ]) {
        expect(r).not.toContain(needle);
      }
    }
  });

  it("leaves ordinary text alone", () => {
    expect(redact("Raised tonight's budget from CHF 5 to CHF 20.")).toBe(
      "Raised tonight's budget from CHF 5 to CHF 20.",
    );
  });

  it("redacts by key name in objects", () => {
    const out = redactDeep({
      apiKey: "plain-but-sensitive",
      nested: { authorization: "x", ok: "y" },
    });
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.nested.authorization).toBe("[REDACTED]");
    expect(out.nested.ok).toBe("y");
  });

  it("logger applies redaction before sinks see the record", () => {
    const seen: LogRecord[] = [];
    Logger.setSinks([(r) => seen.push(r)]);
    Logger.setLevel("debug");
    const l = new Logger("test");
    l.info(`using ${fake.anthropic} now`, { token: fake.github });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain("abcdefghijklmnop");
    expect(seen[0]?.data?.token).toBe("[REDACTED]");
  });
});
