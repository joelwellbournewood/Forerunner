import type {
  CheckResultEvidence,
  ReviewFinding,
  ReviewTier,
  RuleAdjustment,
  Severity,
  Verdict,
} from "./types.ts";

/**
 * The verdict rules, in code (spec H, B.4, open decision "mandatory critic review"). A prompt
 * may ask the model for a careful verdict; only these rules decide what a verdict can be:
 *
 *   1. a finding of severity medium or above means the task cannot close (B.4), so accept
 *      becomes revise;
 *   2. accept needs a grade of at least ACCEPT_MIN_GRADE (grade and verdict agree);
 *   3. confidence below LOW_CONFIDENCE never accepts: it escalates (H.4);
 *   4. tier 3 always ends with a human sign-off (H.2).
 *
 * Before the rules, one floor (ADR 0041): a model that accepts at medium confidence a result
 * whose required checks all passed, with nothing medium or above found, is saying it did not
 * run the checks itself. The runner did, so confidence from CONFIDENCE_FLOOR_FROM up is lifted
 * to LOW_CONFIDENCE and the accept stands. Nothing else is lifted: not low confidence (the
 * critic could not verify), not a result with a failed or no required check, not one with a
 * blocking finding, not a verdict other than accept. Rule 3 itself is unchanged.
 *
 * Every change is recorded as an adjustment so the review shows what the model said and what
 * the code made of it.
 */
export const LOW_CONFIDENCE = 0.6;
export const ACCEPT_MIN_GRADE = 70;
/** The lowest confidence the floor lifts: "medium" in the prompt's vocabulary (schema.ts). */
export const CONFIDENCE_FLOOR_FROM = 0.5;
export const SEVERITY_ORDER: readonly Severity[] = ["info", "low", "medium", "high", "critical"];
/** Severities that block accept and keep a task from closing. */
export const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  "medium",
  "high",
  "critical",
]);

export function severityIndex(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export function maxSeverity(findings: readonly { severity: Severity }[]): Severity | null {
  let max: Severity | null = null;
  for (const f of findings) {
    if (max === null || severityIndex(f.severity) > severityIndex(max)) max = f.severity;
  }
  return max;
}

export function isBlocking(findings: readonly { severity: Severity }[]): boolean {
  return findings.some((f) => BLOCKING_SEVERITIES.has(f.severity));
}

/**
 * Whether the evidence decides the result on its own: at least one required check ran, every
 * required check passed, and no finding (the model's or the code's) is medium or above.
 */
export function deterministicEvidence(
  checks: readonly CheckResultEvidence[] | undefined,
  findings: readonly { severity: Severity }[],
): boolean {
  const required = (checks ?? []).filter((c) => c.required !== false);
  return required.length > 0 && required.every((c) => c.passed) && !isBlocking(findings);
}

export interface VerdictRuleOptions {
  /** The runner's check results, for the confidence floor. Absent: no floor. */
  checkResults?: readonly CheckResultEvidence[];
}

export interface RawVerdict {
  grade: number;
  confidence: number;
  verdict: Verdict;
  findings: readonly ReviewFinding[];
}

export interface RuledVerdict {
  grade: number;
  confidence: number;
  verdict: Verdict;
  adjustments: RuleAdjustment[];
}

export function clampGrade(grade: number): number {
  if (!Number.isFinite(grade)) return 0;
  return Math.min(100, Math.max(0, Math.round(grade)));
}

export function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.min(1, Math.max(0, confidence));
}

export function applyVerdictRules(
  raw: RawVerdict,
  tier: ReviewTier,
  opts: VerdictRuleOptions = {},
): RuledVerdict {
  const adjustments: RuleAdjustment[] = [];
  const grade = clampGrade(raw.grade);
  let confidence = clampConfidence(raw.confidence);
  let verdict: Verdict = raw.verdict;
  const change = (rule: string, to: Verdict, reason: string) => {
    if (verdict === to) return;
    adjustments.push({ rule, from: verdict, to, reason });
    verdict = to;
  };

  if (
    verdict === "accept" &&
    confidence < LOW_CONFIDENCE &&
    confidence >= CONFIDENCE_FLOOR_FROM &&
    deterministicEvidence(opts.checkResults, raw.findings)
  ) {
    adjustments.push({
      rule: "confidence_floor",
      from: confidence.toFixed(2),
      to: LOW_CONFIDENCE.toFixed(2),
      reason:
        "every required check the runner ran passed and no finding is medium or above; " +
        `confidence is floored at ${LOW_CONFIDENCE} (ADR 0041)`,
    });
    confidence = LOW_CONFIDENCE;
  }

  if (verdict === "accept" && isBlocking(raw.findings)) {
    const worst = maxSeverity(raw.findings) ?? "medium";
    change(
      "blocking_finding",
      "revise",
      `a ${worst} finding is open; a task cannot close with open findings (B.4)`,
    );
  }
  if (verdict === "accept" && grade < ACCEPT_MIN_GRADE) {
    change(
      "grade_verdict_consistency",
      "revise",
      `grade ${grade} is below ${ACCEPT_MIN_GRADE}; accept needs at least ${ACCEPT_MIN_GRADE}`,
    );
  }
  if (verdict === "accept" && confidence < LOW_CONFIDENCE) {
    change(
      "low_confidence",
      "escalate",
      `confidence ${confidence.toFixed(2)} is below ${LOW_CONFIDENCE}; low confidence never accepts (H.4)`,
    );
  }
  if (tier === 3) {
    change("tier3_human_signoff", "human", "tier 3 is a deep review plus human sign-off (H.2)");
  }
  return { grade, confidence, verdict, adjustments };
}
