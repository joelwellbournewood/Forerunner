import type { ReviewFinding, ReviewTier, RuleAdjustment, Severity, Verdict } from "./types.ts";

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
 * Every change is recorded as an adjustment so the review shows what the model said and what
 * the code made of it.
 */
export const LOW_CONFIDENCE = 0.6;
export const ACCEPT_MIN_GRADE = 70;
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

export function applyVerdictRules(raw: RawVerdict, tier: ReviewTier): RuledVerdict {
  const adjustments: RuleAdjustment[] = [];
  const grade = clampGrade(raw.grade);
  const confidence = clampConfidence(raw.confidence);
  let verdict: Verdict = raw.verdict;
  const change = (rule: string, to: Verdict, reason: string) => {
    if (verdict === to) return;
    adjustments.push({ rule, from: verdict, to, reason });
    verdict = to;
  };

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
