import { describe, expect, it } from "vitest";
import { fingerprintOf, normaliseFindingText } from "../src/fingerprint.ts";

describe("finding fingerprints", () => {
  it("is stable across paths, line numbers, case, quotes and numbers", () => {
    const a = fingerprintOf('Test "clamp" weakened in test/math.test.ts:12 (expected 3 asserts)');
    const b = fingerprintOf(
      "test 'clamp' weakened in packages/x/test/other.test.ts:40 (expected 7 asserts)",
    );
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(normaliseFindingText("Fix src/a.ts:3 and https://x.invalid/y 0x1f")).toBe(
      "fix <file> and <url> <n>",
    );
  });

  it("differs for a different defect and is empty for empty text", () => {
    expect(fingerprintOf("Tests were weakened")).not.toBe(
      fingerprintOf("Scope widened beyond the brief"),
    );
    expect(fingerprintOf("   ")).toBe("");
    expect(fingerprintOf("12 34")).toBe(fingerprintOf("56 78"));
  });
});
