import { describe, expect, it } from "vitest";
import {
  ACCEPT_MIN_GRADE,
  applyVerdictRules,
  CONFIDENCE_FLOOR_FROM,
  deterministicEvidence,
  isBlocking,
  LOW_CONFIDENCE,
  maxSeverity,
} from "../src/rules.ts";
import type { CheckResultEvidence, ReviewFinding, Severity } from "../src/types.ts";

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

describe("the confidence floor (ADR 0041): deterministic evidence carries a medium-confidence accept", () => {
  const check = (over: Partial<CheckResultEvidence> = {}): CheckResultEvidence => ({
    name: "node --test test/cli.test.ts",
    passed: true,
    output: "ok 5 tests",
    ...over,
  });

  it("lifts a medium-confidence accept to the accept line when every required check passed and nothing medium or above is open", () => {
    // The live run's miss: the model accepts at 0.5 because it did not run the tests itself.
    const r = applyVerdictRules(
      { grade: 85, confidence: 0.5, verdict: "accept", findings: [finding("low")] },
      1,
      { checkResults: [check(), check({ name: "lint", required: false, passed: false })] },
    );
    expect(r.verdict).toBe("accept");
    expect(r.confidence).toBe(LOW_CONFIDENCE);
    expect(r.adjustments).toEqual([
      expect.objectContaining({ rule: "confidence_floor", from: "0.50", to: "0.60" }),
    ]);
    expect(CONFIDENCE_FLOOR_FROM).toBe(0.5);
    // Anything from the floor's lower bound up to the line is lifted; the line itself needs no help.
    expect(
      applyVerdictRules({ grade: 85, confidence: 0.59, verdict: "accept", findings: [] }, 2, {
        checkResults: [check()],
      }),
    ).toMatchObject({ verdict: "accept", confidence: LOW_CONFIDENCE });
    expect(
      applyVerdictRules({ grade: 85, confidence: 0.9, verdict: "accept", findings: [] }, 1, {
        checkResults: [check()],
      }).adjustments,
    ).toEqual([]);
  });

  it("never lifts low confidence, a result with a failed or no required check, optional checks only, a blocking finding, or a verdict other than accept", () => {
    const cases: {
      name: string;
      confidence?: number;
      verdict?: "accept" | "revise";
      findings?: ReviewFinding[];
      checks?: CheckResultEvidence[];
      expectVerdict: string;
      expectRules: string[];
      expectConfidence: number;
    }[] = [
      {
        name: "low confidence: the critic could not verify (H.4)",
        confidence: 0.2,
        checks: [check()],
        expectVerdict: "escalate",
        expectRules: ["low_confidence"],
        expectConfidence: 0.2,
      },
      {
        name: "just under the floor's lower bound",
        confidence: 0.49,
        checks: [check()],
        expectVerdict: "escalate",
        expectRules: ["low_confidence"],
        expectConfidence: 0.49,
      },
      {
        name: "no check results given",
        expectVerdict: "escalate",
        expectRules: ["low_confidence"],
        expectConfidence: 0.5,
      },
      {
        name: "no check ran",
        checks: [],
        expectVerdict: "escalate",
        expectRules: ["low_confidence"],
        expectConfidence: 0.5,
      },
      {
        name: "optional checks only",
        checks: [check({ required: false })],
        expectVerdict: "escalate",
        expectRules: ["low_confidence"],
        expectConfidence: 0.5,
      },
      {
        name: "a required check failed",
        checks: [check(), check({ name: "typecheck", passed: false })],
        expectVerdict: "escalate",
        expectRules: ["low_confidence"],
        expectConfidence: 0.5,
      },
      {
        name: "a medium finding is open",
        findings: [finding("medium")],
        checks: [check()],
        expectVerdict: "revise",
        expectRules: ["blocking_finding"],
        expectConfidence: 0.5,
      },
      {
        name: "the model did not accept",
        verdict: "revise",
        checks: [check()],
        expectVerdict: "revise",
        expectRules: [],
        expectConfidence: 0.5,
      },
    ];
    for (const c of cases) {
      const r = applyVerdictRules(
        {
          grade: 85,
          confidence: c.confidence ?? 0.5,
          verdict: c.verdict ?? "accept",
          findings: c.findings ?? [],
        },
        1,
        c.checks === undefined ? {} : { checkResults: c.checks },
      );
      expect(r.verdict, c.name).toBe(c.expectVerdict);
      expect(
        r.adjustments.map((a) => a.rule),
        c.name,
      ).toEqual(c.expectRules);
      expect(r.confidence, c.name).toBe(c.expectConfidence);
    }
  });

  it("deterministicEvidence: at least one required check, all required passed, nothing medium or above", () => {
    expect(deterministicEvidence([check()], [])).toBe(true);
    expect(deterministicEvidence([check(), check({ required: false, passed: false })], [])).toBe(
      true,
    );
    expect(deterministicEvidence([check()], [finding("low"), finding("info")])).toBe(true);
    expect(deterministicEvidence(undefined, [])).toBe(false);
    expect(deterministicEvidence([], [])).toBe(false);
    expect(deterministicEvidence([check({ required: false })], [])).toBe(false);
    expect(deterministicEvidence([check({ passed: false })], [])).toBe(false);
    expect(deterministicEvidence([check()], [finding("medium")])).toBe(false);
  });
});
