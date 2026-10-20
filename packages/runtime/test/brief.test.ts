import { describe, expect, it } from "vitest";
import { renderBrief, validateBrief } from "../src/brief.ts";

const good = {
  goal: "Add a /health endpoint returning build info",
  contextLinks: ["docs/architecture.md"],
  constraints: ["no new dependencies"],
  acceptanceCriteria: ["GET /health returns 200 with version"],
  budgetUsdMicro: 500_000,
  riskTier: 1,
  specialist: "coder",
};

describe("delegation brief", () => {
  it("accepts a complete brief", () => {
    expect(validateBrief(good).specialist).toBe("coder");
    expect(renderBrief(validateBrief(good))).toContain("Acceptance criteria");
  });

  it("rejects briefs missing any field, naming them", () => {
    const { acceptanceCriteria: _a, budgetUsdMicro: _b, ...missing } = good;
    expect(() => validateBrief(missing)).toThrow(/brief_incomplete|acceptanceCriteria/);
    try {
      validateBrief(missing);
    } catch (e) {
      const issues = (e as { details: { issues: string[] } }).details.issues.join("\n");
      expect(issues).toMatch(/acceptanceCriteria/);
      expect(issues).toMatch(/budgetUsdMicro/);
    }
    expect(() => validateBrief({ ...good, riskTier: 4 })).toThrow();
    expect(() => validateBrief({ ...good, goal: "fix it" })).toThrow(/goal/);
    expect(() => validateBrief({ ...good, budgetUsdMicro: 0 })).toThrow(/budget/);
  });
});
