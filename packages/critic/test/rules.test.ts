import { describe, expect, it } from "vitest";
import {
  ACCEPT_MIN_GRADE,
  applyVerdictRules,
  ESCALATE_RULE,
  type EscalationGrounds,
  isBlocking,
  LOW_CONFIDENCE,
  maxSeverity,
  namesUnavailable,
  type RawVerdict,
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

  it("the rules only tighten a revise; an escalate stands on its ground or falls to what the findings justify", () => {
    expect(
      applyVerdictRules({ grade: 100, confidence: 1, verdict: "revise", findings: [] }, 1).verdict,
    ).toBe("revise");
    expect(
      applyVerdictRules({ grade: 100, confidence: 0.1, verdict: "escalate", findings: [] }, 1)
        .verdict,
    ).toBe("escalate");
  });

  describe("an escalate needs a named ground (ADR 0042)", () => {
    const grounds = (over: Partial<EscalationGrounds> = {}): EscalationGrounds => ({
      unavailable: [],
      limits: [],
      outcome: "completed",
      ...over,
    });
    const cases: {
      name: string;
      raw: Omit<RawVerdict, "verdict">;
      verdict: "accept" | "revise" | "escalate";
      adjusted: boolean;
      ground?: string;
    }[] = [
      {
        name: "clean work, medium confidence, no reason: accept",
        raw: { grade: 86, confidence: 0.7, findings: [], grounds: grounds() },
        verdict: "accept",
        adjusted: true,
      },
      {
        name: "clean work with a low finding, no reason: accept (low never blocks)",
        raw: { grade: 86, confidence: 0.9, findings: [finding("low")], grounds: grounds() },
        verdict: "accept",
        adjusted: true,
      },
      {
        name: "a medium finding, no reason: revise (B.4)",
        raw: { grade: 80, confidence: 0.9, findings: [finding("medium")], grounds: grounds() },
        verdict: "revise",
        adjusted: true,
      },
      {
        name: "a high finding: escalate stands (the seeded-defect case)",
        raw: { grade: 30, confidence: 0.9, findings: [finding("high")], grounds: grounds() },
        verdict: "escalate",
        adjusted: false,
        ground: "a high finding is open",
      },
      {
        name: "a critical finding: escalate stands",
        raw: { grade: 10, confidence: 0.9, findings: [finding("critical")], grounds: grounds() },
        verdict: "escalate",
        adjusted: false,
        ground: "a critical finding is open",
      },
      {
        name: "low confidence: escalate stands (H.4)",
        raw: { grade: 90, confidence: 0.2, findings: [], grounds: grounds() },
        verdict: "escalate",
        adjusted: false,
        ground: "confidence 0.20 is below 0.6; low confidence never accepts (H.4)",
      },
      {
        name: "the review run itself hit a limit: escalate stands",
        raw: {
          grade: 0,
          confidence: 0,
          findings: [],
          grounds: grounds({ outcome: "timeout" }),
        },
        verdict: "escalate",
        adjusted: false,
        ground: "the review run ended with timeout",
      },
      {
        name: "evidence_missing naming a listed item: escalate stands",
        raw: {
          grade: 80,
          confidence: 0.7,
          findings: [],
          escalation: {
            reason: "evidence_missing",
            detail: "the source fixtures were not provided",
          },
          grounds: grounds({ unavailable: ["source fixtures"] }),
        },
        verdict: "escalate",
        adjusted: false,
        ground: "evidence not available: source fixtures",
      },
      {
        name: "evidence_missing naming a truncated block by its base name: escalate stands",
        raw: {
          grade: 80,
          confidence: 0.7,
          findings: [],
          escalation: { reason: "evidence_missing", detail: "diff" },
          grounds: grounds({ unavailable: ["diff (truncated)"] }),
        },
        verdict: "escalate",
        adjusted: false,
        ground: "evidence not available: diff (truncated)",
      },
      {
        name: "evidence_missing naming material the evidence holds: accept",
        raw: {
          grade: 85,
          confidence: 0.7,
          findings: [],
          escalation: { reason: "evidence_missing", detail: "the fixture text" },
          grounds: grounds(),
        },
        verdict: "accept",
        adjusted: true,
      },
      {
        name: "evidence_missing naming the wrong item when another is listed: accept",
        raw: {
          grade: 85,
          confidence: 0.7,
          findings: [],
          escalation: { reason: "evidence_missing", detail: "test output" },
          grounds: grounds({ unavailable: ["diff"] }),
        },
        verdict: "accept",
        adjusted: true,
      },
      {
        name: "evidence_missing with a detail too short to name anything: accept",
        raw: {
          grade: 85,
          confidence: 0.7,
          findings: [],
          escalation: { reason: "evidence_missing", detail: "the" },
          grounds: grounds({ unavailable: ["diff", "test output"] }),
        },
        verdict: "accept",
        adjusted: true,
      },
      {
        name: "unverified_finding with only a medium finding: revise",
        raw: {
          grade: 70,
          confidence: 0.7,
          findings: [finding("medium")],
          escalation: { reason: "unverified_finding", detail: "a medium problem" },
          grounds: grounds(),
        },
        verdict: "revise",
        adjusted: true,
      },
      {
        name: "limit when the runtime recorded one: escalate stands",
        raw: {
          grade: 60,
          confidence: 0.7,
          findings: [],
          escalation: { reason: "limit", detail: "the worker ran out of budget" },
          grounds: grounds({ limits: ["worker run ended with budget_exceeded"] }),
        },
        verdict: "escalate",
        adjusted: false,
        ground: "limit recorded: worker run ended with budget_exceeded",
      },
      {
        name: "limit when the runtime recorded none: accept",
        raw: {
          grade: 85,
          confidence: 0.7,
          findings: [],
          escalation: { reason: "limit", detail: "probably too hard for this model" },
          grounds: grounds(),
        },
        verdict: "accept",
        adjusted: true,
      },
      {
        name: "no grounds object at all behaves as complete evidence: accept",
        raw: { grade: 85, confidence: 0.7, findings: [] },
        verdict: "accept",
        adjusted: true,
      },
      {
        name: "downgraded to accept but under the accept grade: revise by the grade rule",
        raw: { grade: 40, confidence: 0.7, findings: [], grounds: grounds() },
        verdict: "revise",
        adjusted: true,
      },
    ];
    for (const c of cases) {
      it(c.name, () => {
        const r = applyVerdictRules({ ...c.raw, verdict: "escalate" }, 1);
        expect(r.verdict).toBe(c.verdict);
        if (c.adjusted) {
          expect(r.adjustments[0]).toMatchObject({ rule: ESCALATE_RULE, from: "escalate" });
          expect(r.escalation?.qualifies).toBe(false);
        } else {
          expect(r.adjustments).toEqual([]);
          expect(r.escalation).toEqual({ qualifies: true, ground: c.ground });
        }
      });
    }

    it("never fires for a verdict other than escalate, and tier 3 still ends with the human", () => {
      const accept = applyVerdictRules(
        { grade: 90, confidence: 0.9, verdict: "accept", findings: [], grounds: grounds() },
        1,
      );
      expect(accept.adjustments).toEqual([]);
      expect(accept.escalation).toBeUndefined();
      const t3 = applyVerdictRules(
        { grade: 90, confidence: 0.7, verdict: "escalate", findings: [], grounds: grounds() },
        3,
      );
      expect(t3.verdict).toBe("human");
      expect(t3.adjustments.map((a) => a.rule)).toEqual([ESCALATE_RULE, "tier3_human_signoff"]);
    });

    it("namesUnavailable matches by containment either way, never on a short detail", () => {
      expect(namesUnavailable("source fixtures", "the source fixtures were not given")).toBe(true);
      expect(namesUnavailable("input file docs/a.md (truncated)", "docs/a.md")).toBe(true);
      expect(namesUnavailable("diff (truncated)", "the diff")).toBe(true);
      expect(namesUnavailable("diff", "the")).toBe(false);
      expect(namesUnavailable("diff", "test output")).toBe(false);
    });
  });
});
