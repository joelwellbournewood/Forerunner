import { isForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  assertSecretName,
  assertSecretValue,
  assertStorableSecretName,
  isReservedSecretName,
  isValidSecretName,
  MAX_SECRET_VALUE_LENGTH,
  RESERVED_SECRET_PREFIX,
} from "../src/types.ts";
import { INSTALL_WRAP_KEY_NAME } from "../src/wrap.ts";

describe("secret names", () => {
  it.each([
    "a",
    "github_pat",
    "anthropic.api-key",
    "org:deploy_token",
    "secret:github_pat",
    `a${"b".repeat(127)}`,
  ])("accepts %s", (name) => {
    expect(isValidSecretName(name)).toBe(true);
    expect(assertSecretName(name)).toBe(name);
  });

  it.each([
    "",
    "A",
    "GitHub_PAT",
    "1abc",
    "_index",
    "__index__",
    "has space",
    "slash/name",
    "hash#0",
    `a${"b".repeat(128)}`,
    "ünïcode",
  ])("rejects %j", (name) => {
    expect(isValidSecretName(name)).toBe(false);
    try {
      assertSecretName(name);
      throw new Error("should have thrown");
    } catch (e) {
      expect(isForerunnerError(e, "validation")).toBe(true);
    }
  });

  it("rejects non-strings without crashing", () => {
    expect(isValidSecretName(42)).toBe(false);
    expect(isValidSecretName(null)).toBe(false);
    expect(() => assertSecretName(undefined)).toThrow(/invalid secret name/);
  });
});

describe("reserved names (the install wrapping key)", () => {
  it("names under the forerunner. prefix are reserved: valid syntax, never a user secret", () => {
    expect(RESERVED_SECRET_PREFIX).toBe("forerunner.");
    expect(INSTALL_WRAP_KEY_NAME.startsWith(RESERVED_SECRET_PREFIX)).toBe(true);
    expect(isReservedSecretName(INSTALL_WRAP_KEY_NAME)).toBe(true);
    expect(isReservedSecretName("forerunner.anything_else")).toBe(true);
    expect(isValidSecretName(INSTALL_WRAP_KEY_NAME)).toBe(true);
    for (const plain of ["forerunner_x", "forerunner", "github_token", "org:forerunner.x", 7, null])
      expect(isReservedSecretName(plain)).toBe(false);
  });

  it("assertSecretName refuses a reserved name with secret_reserved; the storage check takes it", () => {
    for (const name of [INSTALL_WRAP_KEY_NAME, "forerunner.future_key"]) {
      try {
        assertSecretName(name);
        throw new Error("should have thrown");
      } catch (e) {
        expect(isForerunnerError(e, "secret_reserved")).toBe(true);
        expect((e as Error).message).toMatch(/reserved/);
        expect((e as { details: { name: string } }).details.name).toBe(name);
      }
      expect(assertStorableSecretName(name)).toBe(name);
    }
    // The storage check still enforces the syntax rule.
    for (const bad of ["Bad Name", "", "__index__"]) {
      try {
        assertStorableSecretName(bad);
        throw new Error("should have thrown");
      } catch (e) {
        expect(isForerunnerError(e, "validation")).toBe(true);
      }
    }
  });
});

describe("secret values", () => {
  it("accepts non-empty strings up to the cap", () => {
    expect(assertSecretValue("x")).toBe("x");
    expect(assertSecretValue("y".repeat(MAX_SECRET_VALUE_LENGTH))).toHaveLength(
      MAX_SECRET_VALUE_LENGTH,
    );
  });

  it("rejects empty, oversized and non-string values without echoing them", () => {
    for (const bad of ["", "z".repeat(MAX_SECRET_VALUE_LENGTH + 1), 7, null, { a: 1 }]) {
      try {
        assertSecretValue(bad);
        throw new Error("should have thrown");
      } catch (e) {
        expect(isForerunnerError(e, "validation")).toBe(true);
        expect((e as Error).message).not.toContain("zzzz");
      }
    }
  });
});
