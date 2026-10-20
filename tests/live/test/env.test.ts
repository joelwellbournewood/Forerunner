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
  SUBSCRIPTION_VAR,
  WORKSPACE_VAR,
} from "../src/env.ts";

// Fixture credentials: built by concatenation so no credential shape sits in the file. // not-a-secret
const FAKE_KEY = ["sk-ant-", "api03-", "f".repeat(24)].join(""); // not-a-secret
const FAKE_WORKSPACE = ["wrkspc_", "0".repeat(12)].join(""); // not-a-secret
const FAKE_TOKEN = ["sk-", "ant-", "oat01-", "f".repeat(40)].join(""); // not-a-secret
const OAT_PREFIX = ["sk-", "ant-", "oat"].join(""); // not-a-secret

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
    expect(creds).toEqual({
      apiKey: FAKE_KEY,
      workspaceId: FAKE_WORKSPACE,
      subscriptionToken: null,
      source: ".env.build",
    });
  });

  it("reads the subscription token from the file, or from the process environment first, and null when absent", () => {
    const withToken = tempFile(`${KEY_VAR}=${FAKE_KEY}\n${SUBSCRIPTION_VAR}="${FAKE_TOKEN}"\n`);
    expect(loadBuildEnv({ env: {}, file: withToken })).toEqual({
      apiKey: FAKE_KEY,
      workspaceId: null,
      subscriptionToken: FAKE_TOKEN,
      source: ".env.build",
    });
    // The environment wins for the token even when the key comes from the file...
    const fromEnv = ["sk-", "ant-", "oat01-", "e".repeat(40)].join(""); // not-a-secret
    expect(
      loadBuildEnv({ env: { [SUBSCRIPTION_VAR]: fromEnv }, file: withToken })?.subscriptionToken,
    ).toBe(fromEnv);
    // ...and the file's token still applies when the key comes from the environment.
    const keyFromEnv = loadBuildEnv({ env: { [KEY_VAR]: FAKE_KEY }, file: withToken });
    expect(keyFromEnv?.source).toBe("process-env");
    expect(keyFromEnv?.subscriptionToken).toBe(FAKE_TOKEN);
    // Absent or blank: null, never an error (the API-key half runs without one).
    const noToken = tempFile(`${KEY_VAR}=${FAKE_KEY}\n${SUBSCRIPTION_VAR}=\n`);
    expect(loadBuildEnv({ env: {}, file: noToken })?.subscriptionToken).toBeNull();
    expect(
      loadBuildEnv({ env: { [KEY_VAR]: FAKE_KEY, [SUBSCRIPTION_VAR]: "  " }, file: noToken })
        ?.subscriptionToken,
    ).toBeNull();
    // A file with the token but no key is still "no live credentials".
    expect(
      loadBuildEnv({ env: {}, file: tempFile(`${SUBSCRIPTION_VAR}=${FAKE_TOKEN}\n`) }),
    ).toBeNull();
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
    const creds = {
      apiKey: FAKE_KEY,
      workspaceId: FAKE_WORKSPACE,
      subscriptionToken: FAKE_TOKEN,
      source: ".env.build" as const,
    };
    const text = describeCredentials(creds);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain(FAKE_WORKSPACE);
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(OAT_PREFIX);
    expect(text).toContain(".env.build");
    expect(text).toContain("with a subscription token");
    expect(describeCredentials({ ...creds, subscriptionToken: null })).toContain(
      "no subscription token",
    );
    expect(redactCredentials(`key ${FAKE_KEY} ws ${FAKE_WORKSPACE}`, creds)).toBe(
      "key [REDACTED] ws [REDACTED]",
    );
    // The token is redacted too, and a credentials object without one changes nothing else.
    expect(redactCredentials(`CLAUDE_CODE_OAUTH_TOKEN=${FAKE_TOKEN} key ${FAKE_KEY}`, creds)).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN=[REDACTED] key [REDACTED]",
    );
    expect(redactCredentials(`token ${FAKE_TOKEN}`, { ...creds, subscriptionToken: null })).toBe(
      `token ${FAKE_TOKEN}`,
    );
  });
});
