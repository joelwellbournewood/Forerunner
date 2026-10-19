import { describe, expect, it } from "vitest";
import { Logger, type LogRecord, redact, redactDeep } from "../src/log.ts";

describe("redaction", () => {
  it("masks known credential shapes", () => {
    const samples = [
      "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij",
      "password=hunter2hunter2",
      "AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----",
    ];
    for (const s of samples) {
      const r = redact(s);
      expect(r).toContain("[REDACTED]");
      expect(r).not.toMatch(
        /sk-ant-api03-abcdefghij|ghp_abcdefghij|github_pat_11ABC|hunter2|AKIAABCDEFGHIJKLMNOP|MIIabc/,
      );
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
    l.info("using sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 now", {
      token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain("abcdefghijklmnop");
    expect(seen[0]?.data?.token).toBe("[REDACTED]");
  });
});
