import { describe, expect, it } from "vitest";
import {
  ACCEPT_MIN_GRADE,
  applyVerdictRules,
  isBlocking,
  LOW_CONFIDENCE,
  maxSeverity,
} from "../src/rules.ts";
import type { ReviewFinding, Severity } from "../src/types.ts";

const finding = (severity: Severity): ReviewFinding => ({
  severity,
  description: `a ${severity} problem`,
  requiredAction: "fix it",
  fingerprint: "abc",
});

describe("verdict rules in code", () => {
  it("low confidence never accepts: it becomes escalate (H.4)", () => {
    const r = applyVerdictRules(
      { grade: 95, confidence: LOW_CONFIDENCE - 0.01, verdict: "accept", findings: [] },
      1,
    );
    expect(r.verdict).toBe("escalate");
    expect(r.adjustments).toEqual([
      expect.objectContaining({ rule: "low_confidence", from: "accept", to: "escalate" }),
    ]);
    expect(
      applyVerdictRules(
        { grade: 95, confidence: LOW_CONFIDENCE, verdict: "accept", findings: [] },
        1,
      ).verdict,
    ).toBe("accept");
  });

  it("a critical, high or medium finding keeps a verdict from being accept (B.4)", () => {
    for (const s of ["critical", "high", "medium"] as const) {
      const r = applyVerdictRules(
        { grade: 95, confidence: 0.9, verdict: "accept", findings: [finding(s)] },
        1,
      );
      expect(r.verdict, s).toBe("revise");
      expect(r.adjustments[0]?.rule).toBe("blocking_finding");
    }
    for (const s of ["low", "info"] as const) {
      expect(
        applyVerdictRules(
          { grade: 95, confidence: 0.9, verdict: "accept", findings: [finding(s)] },
          1,
        ).verdict,
        s,
      ).toBe("accept");
    }
    expect(isBlocking([finding("low"), finding("medium")])).toBe(true);
    expect(maxSeverity([finding("low"), finding("critical"), finding("high")])).toBe("critical");
    expect(maxSeverity([])).toBeNull();
  });

  it("grade and verdict agree: accept needs at least the minimum grade", () => {
    const low = applyVerdictRules(
      { grade: ACCEPT_MIN_GRADE - 1, confidence: 0.9, verdict: "accept", findings: [] },
      2,
    );
    expect(low.verdict).toBe("revise");
    expect(low.adjustments[0]?.rule).toBe("grade_verdict_consistency");
    const ok = applyVerdictRules(
      { grade: ACCEPT_MIN_GRADE, confidence: 0.9, verdict: "accept", findings: [] },
      2,
    );
    expect(ok.verdict).toBe("accept");
    expect(ok.adjustments).toEqual([]);
  });

  it("tier 3 always ends in a human verdict", () => {
    for (const verdict of ["accept", "revise", "escalate"] as const) {
      const r = applyVerdictRules({ grade: 100, confidence: 1, verdict, findings: [] }, 3);
      expect(r.verdict).toBe("human");
      expect(r.adjustments.at(-1)?.rule).toBe("tier3_human_signoff");
    }
    const already = applyVerdictRules(
      { grade: 100, confidence: 1, verdict: "human", findings: [] },
      3,
    );
    expect(already.adjustments).toEqual([]);
  });

  it("clamps the grade to 0-100 and the confidence to 0-1; non-numbers become 0", () => {
    const r = applyVerdictRules({ grade: 140, confidence: -1, verdict: "revise", findings: [] }, 1);
    expect(r.grade).toBe(100);
    expect(r.confidence).toBe(0);
    const n = applyVerdictRules(
      { grade: Number.NaN, confidence: Number.NaN, verdict: "revise", findings: [] },
      1,
    );
    expect(n.grade).toBe(0);
    expect(n.confidence).toBe(0);
  });

  it("the rules only tighten: a revise or escalate verdict is never turned into accept", () => {
    expect(
      applyVerdictRules({ grade: 100, confidence: 1, verdict: "revise", findings: [] }, 1).verdict,
    ).toBe("revise");
    expect(
      applyVerdictRules({ grade: 100, confidence: 0.1, verdict: "escalate", findings: [] }, 1)
        .verdict,
    ).toBe("escalate");
  });
});
