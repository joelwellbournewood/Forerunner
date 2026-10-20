import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  describeCredentials,
  findRepoRoot,
  KEY_VAR,
  loadBuildEnv,
  parseDotEnv,
  redactCredentials,
  WORKSPACE_VAR,
} from "../src/env.ts";

// Fixture credentials: built by concatenation so no credential shape sits in the file. // not-a-secret
const FAKE_KEY = ["sk-ant-", "api03-", "f".repeat(24)].join(""); // not-a-secret
const FAKE_WORKSPACE = ["wrkspc_", "0".repeat(12)].join(""); // not-a-secret

const temps: string[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fr-live-env-"));
  temps.push(dir);
  const file = join(dir, ".env.build");
  writeFileSync(file, content, "utf8");
  return file;
}

describe(".env.build parser", () => {
  it("reads KEY=value lines, ignores comments and blanks, strips quotes and export", () => {
    const parsed = parseDotEnv(
      [
        "# a comment",
        "",
        "PLAIN=one",
        'DOUBLE="two words"',
        "SINGLE='three'",
        "export EXPORTED=four",
        "TRAILING=five # a trailing comment",
        "SPACED =  six  ",
        "=novalue",
        "lower-case=ignored",
        "EQUALS=a=b=c",
      ].join("\r\n"),
    );
    expect(parsed).toEqual({
      PLAIN: "one",
      DOUBLE: "two words",
      SINGLE: "three",
      EXPORTED: "four",
      TRAILING: "five",
      SPACED: "six",
      EQUALS: "a=b=c",
    });
  });

  it("a quoted value takes a trailing comment after its closing quote and keeps a hash inside", () => {
    const parsed = parseDotEnv(
      [
        'DOUBLE_COMMENT="x" # trailing',
        "SINGLE_COMMENT='y' #c",
        'INNER_HASH="a #1"',
        "INNER_HASH_SINGLE='b # c' # d",
        'UNTERMINATED="a" b',
        'EMPTY="" # nothing',
      ].join("\n"),
    );
    expect(parsed).toEqual({
      DOUBLE_COMMENT: "x",
      SINGLE_COMMENT: "y",
      INNER_HASH: "a #1",
      INNER_HASH_SINGLE: "b # c",
      // not a quoted value (text after the closing quote that is not a comment): kept as written
      UNTERMINATED: '"a" b',
      EMPTY: "",
    });
  });

  it("loads the key and the workspace id from the file", () => {
    const file = tempFile(`${KEY_VAR}=${FAKE_KEY}\n${WORKSPACE_VAR}="${FAKE_WORKSPACE}"\n`);
    const creds = loadBuildEnv({ env: {}, file });
    expect(creds).toEqual({ apiKey: FAKE_KEY, workspaceId: FAKE_WORKSPACE, source: ".env.build" });
  });

  it("the process environment wins over the file", () => {
    const file = tempFile(`${KEY_VAR}=${FAKE_KEY}\n`);
    const fromEnv = ["sk-ant-", "api03-", "e".repeat(24)].join(""); // not-a-secret
    const creds = loadBuildEnv({ env: { [KEY_VAR]: fromEnv }, file });
    expect(creds?.apiKey).toBe(fromEnv);
    expect(creds?.source).toBe("process-env");
    expect(creds?.workspaceId).toBeNull();
  });

  it("is null without a key, and null for a missing file", () => {
    expect(loadBuildEnv({ env: {}, file: tempFile("OTHER=1\n") })).toBeNull();
    expect(
      loadBuildEnv({ env: {}, file: join(tmpdir(), "does-not-exist", ".env.build") }),
    ).toBeNull();
  });

  it("finds the repository root from this package and describes credentials without values", () => {
    const root = findRepoRoot();
    expect(root).not.toBeNull();
    const creds = { apiKey: FAKE_KEY, workspaceId: FAKE_WORKSPACE, source: ".env.build" as const };
    const text = describeCredentials(creds);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain(FAKE_WORKSPACE);
    expect(text).toContain(".env.build");
    expect(redactCredentials(`key ${FAKE_KEY} ws ${FAKE_WORKSPACE}`, creds)).toBe(
      "key [REDACTED] ws [REDACTED]",
    );
  });
});
