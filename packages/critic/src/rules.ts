import type { SubmitEscalation } from "./schema.ts";
import type { ReviewFinding, ReviewTier, RuleAdjustment, Severity, Verdict } from "./types.ts";

/**
 * The verdict rules, in code (spec H, B.4, open decision "mandatory critic review"). A prompt
 * may ask the model for a careful verdict; only these rules decide what a verdict can be:
 *
 *   0. an escalate needs a named ground (ADR 0042): a critical or high finding, a limit the
 *      runtime recorded (the review run itself ending early counts), an item the evidence
 *      lists as unavailable and the model names, or low confidence (H.4); without one it is
 *      downgraded to the verdict the findings justify (revise with a blocking finding, else
 *      accept) and the later rules apply to that;
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
export const ESCALATE_RULE = "escalate_needs_reason";
export const SEVERITY_ORDER: readonly Severity[] = ["info", "low", "medium", "high", "critical"];
/** Severities that block accept and keep a task from closing. */
export const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  "medium",
  "high",
  "critical",
]);
/** Severities that ground an escalate on their own (a finding the critic could not verify). */
export const ESCALATING_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(["high", "critical"]);

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

/** What the code knows that can ground an escalate (ADR 0042). */
export interface EscalationGrounds {
  /** Names listed under "Evidence not available" (from the renderer and the caller). */
  unavailable: readonly string[];
  /** Limit conditions the runtime recorded for the work under review. */
  limits: readonly string[];
  /** How the review run itself ended; anything but "completed" is a limit. */
  outcome?: string;
}

export const NO_GROUNDS: EscalationGrounds = { unavailable: [], limits: [] };

export interface RawVerdict {
  grade: number;
  confidence: number;
  verdict: Verdict;
  findings: readonly ReviewFinding[];
  /** The model's stated reason for an escalate, when it gave one. */
  escalation?: SubmitEscalation | null;
  grounds?: EscalationGrounds;
}

export type EscalationCheck =
  | { qualifies: true; ground: string }
  | { qualifies: false; why: string };

export interface RuledVerdict {
  grade: number;
  confidence: number;
  verdict: Verdict;
  adjustments: RuleAdjustment[];
  /** The ground an escalate stood on, or why the model's escalate did not qualify. */
  escalation?: EscalationCheck;
}

export function clampGrade(grade: number): number {
  if (!Number.isFinite(grade)) return 0;
  return Math.min(100, Math.max(0, Math.round(grade)));
}

export function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.min(1, Math.max(0, confidence));
}

const norm = (s: string): string => s.trim().toLowerCase();
const MIN_NAME_CHARS = 4;

/**
 * Whether the model's `detail` names an unavailable item: the item's name contains the detail
 * or the detail contains the item's name (its base, without a "(truncated)" suffix). Short
 * details never match, so "the" cannot name everything.
 */
export function namesUnavailable(item: string, detail: string): boolean {
  const d = norm(detail);
  if (d.length < MIN_NAME_CHARS) return false;
  const full = norm(item);
  const base = norm(item.replace(/\s*\(truncated\)\s*$/i, ""));
  return full.includes(d) || (base.length >= MIN_NAME_CHARS && d.includes(base));
}

/** Does this escalate stand on a ground the code can see (ADR 0042)? */
export function escalationCheck(raw: RawVerdict): EscalationCheck {
  const grounds = raw.grounds ?? NO_GROUNDS;
  const worst = maxSeverity(raw.findings);
  if (worst !== null && ESCALATING_SEVERITIES.has(worst)) {
    return { qualifies: true, ground: `a ${worst} finding is open` };
  }
  if (grounds.outcome !== undefined && grounds.outcome !== "completed") {
    return { qualifies: true, ground: `the review run ended with ${grounds.outcome}` };
  }
  const confidence = clampConfidence(raw.confidence);
  if (confidence < LOW_CONFIDENCE) {
    return {
      qualifies: true,
      ground: `confidence ${confidence.toFixed(2)} is below ${LOW_CONFIDENCE}; low confidence never accepts (H.4)`,
    };
  }
  const esc = raw.escalation;
  if (!esc) {
    return {
      qualifies: false,
      why: "no escalation reason was given and no critical or high finding is open",
    };
  }
  const quoted = JSON.stringify(esc.detail.slice(0, 120));
  switch (esc.reason) {
    case "unverified_finding":
      return {
        qualifies: false,
        why: `the escalation names an unverified finding (${quoted}) but no critical or high finding is open`,
      };
    case "evidence_missing": {
      const hit = grounds.unavailable.find((u) => namesUnavailable(u, esc.detail));
      if (hit) return { qualifies: true, ground: `evidence not available: ${hit}` };
      return {
        qualifies: false,
        why: grounds.unavailable.length
          ? `the escalation names ${quoted} as missing, but only ${grounds.unavailable.map((u) => JSON.stringify(u)).join(", ")} ${grounds.unavailable.length === 1 ? "is" : "are"} listed as unavailable`
          : `the escalation names ${quoted} as missing, but the evidence is complete`,
      };
    }
    case "limit": {
      const limit = grounds.limits[0];
      if (limit !== undefined) return { qualifies: true, ground: `limit recorded: ${limit}` };
      return {
        qualifies: false,
        why: `the escalation names a limit (${quoted}) but the runtime recorded none`,
      };
    }
  }
}

export function applyVerdictRules(raw: RawVerdict, tier: ReviewTier): RuledVerdict {
  const adjustments: RuleAdjustment[] = [];
  const grade = clampGrade(raw.grade);
  const confidence = clampConfidence(raw.confidence);
  let verdict: Verdict = raw.verdict;
  let escalation: EscalationCheck | undefined;
  const change = (rule: string, to: Verdict, reason: string) => {
    if (verdict === to) return;
    adjustments.push({ rule, from: verdict, to, reason });
    verdict = to;
  };

  if (verdict === "escalate") {
    escalation = escalationCheck({ ...raw, confidence });
    if (!escalation.qualifies) {
      const to: Verdict = isBlocking(raw.findings) ? "revise" : "accept";
      change(
        ESCALATE_RULE,
        to,
        `an escalate needs a named ground (a critical or high finding, a recorded limit, an item listed as unavailable, or low confidence); ${escalation.why}; the findings justify ${to}`,
      );
    }
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
  return { grade, confidence, verdict, adjustments, ...(escalation ? { escalation } : {}) };
}
