import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { evaluate } from "./docs-check.mjs";

describe("docs-check", () => {
  it("passes when the module doc is touched", () => {
    const r = evaluate(["packages/runtime/src/hooks.ts", "docs/maintainers/runtime.md"], "");
    expect(r.ok).toBe(true);
  });
  it("fails when a module changes without its doc", () => {
    const r = evaluate(["packages/billing/src/router.ts"], "");
    expect(r.ok).toBe(false);
    expect(r.missing[0].docs).toContain("docs/maintainers/billing.md");
  });
  it("ignores test-only changes", () => {
    expect(evaluate(["packages/billing/test/router.test.ts"], "").ok).toBe(true);
  });
  it("accepts an explicit waiver with a reason", () => {
    expect(evaluate(["packages/billing/src/router.ts"], "docs: none needed: comment typo").ok).toBe(
      true,
    );
    expect(evaluate(["packages/billing/src/router.ts"], "docs: none needed").ok).toBe(false);
  });
});
