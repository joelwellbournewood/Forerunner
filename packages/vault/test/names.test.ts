import { isForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  assertSecretName,
  assertSecretValue,
  isValidSecretName,
  MAX_SECRET_VALUE_LENGTH,
} from "../src/types.ts";

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
