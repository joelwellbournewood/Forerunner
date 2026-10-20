import { z } from "zod";
import type { Severity } from "./types.ts";

/**
 * The one tool the critic may call: `submit_review`. The schema accepts both the vocabulary of
 * the registry prompt (confidence high/medium/low, severity blocker/major/minor/note) and the
 * state store's (0-1, critical/high/medium/low/info) so prompt authors can use either; the
 * mapping below is the only place they meet.
 */
export const SUBMIT_REVIEW_TOOL = "submit_review";

export const SEVERITY_WORDS = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
  "note",
  "minor",
  "major",
  "blocker",
] as const;
export type SeverityWord = (typeof SEVERITY_WORDS)[number];

export const CONFIDENCE_WORDS = ["high", "medium", "low"] as const;
export type ConfidenceWord = (typeof CONFIDENCE_WORDS)[number];

/**
 * "medium" sits above LOW_CONFIDENCE (ADR 0042): it is the normal confidence of a light read
 * whose checks the runtime ran, and the spec's "low confidence never accepts" (H.4) is about
 * `low`. ADR 0028 had mapped medium to 0.5, which turned every clean tier 1 review the live
 * model answered "medium" into an escalate (the phase 3 live run). `low` stays well under the
 * line, so the code rule still makes H.4 true whatever the prompt says.
 */
export const CONFIDENCE_OF_WORD: Record<ConfidenceWord, number> = {
  high: 0.9,
  medium: 0.7,
  low: 0.2,
};

/**
 * Why the critic escalates (ADR 0042). The rules honour a reason only when the evidence backs
 * it: `unverified_finding` needs a critical or high finding, `evidence_missing` must name an
 * item of the "Evidence not available" section, `limit` needs a limit the runtime recorded.
 */
export const ESCALATION_REASONS = ["unverified_finding", "evidence_missing", "limit"] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export const SubmitEscalationSchema = z.object({
  reason: z.enum(ESCALATION_REASONS),
  /** The finding, the unavailable item or the limit, by name. */
  detail: z.string().min(1),
});
export type SubmitEscalation = z.infer<typeof SubmitEscalationSchema>;

export const SEVERITY_OF_WORD: Record<SeverityWord, Severity> = {
  info: "info",
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical",
  note: "info",
  minor: "low",
  major: "high",
  blocker: "critical",
};

export const SubmitFindingSchema = z.object({
  severity: z.enum(SEVERITY_WORDS),
  /** What is wrong. */
  what: z.string().min(1),
  /** path:line or the output line that shows it. */
  where: z.string().optional(),
  required_action: z.string().optional(),
  how_to_see: z.string().optional(),
});

export const SubmitCriterionSchema = z.object({
  text: z.string().min(1),
  met: z.boolean(),
  evidence: z.string().optional(),
});

export const SubmitReviewSchema = z.object({
  grade: z.number().min(0).max(100),
  confidence: z.union([z.number().min(0).max(1), z.enum(CONFIDENCE_WORDS)]),
  verdict: z.enum(["accept", "revise", "escalate", "human"]),
  summary: z.string().min(1),
  findings: z.array(SubmitFindingSchema).default([]),
  criteria: z.array(SubmitCriterionSchema).default([]),
  doc_drift: z.string().optional(),
  checks_run: z.array(z.string()).default([]),
  /** Evidence links and lines the reviewer relied on. */
  evidence: z.array(z.string()).default([]),
  /** Ids of earlier open findings this change resolved. */
  resolved: z.array(z.string()).default([]),
  /** Required for an `escalate` verdict to stand (ADR 0042); ignored for other verdicts. */
  escalation: SubmitEscalationSchema.optional(),
});

export type SubmitReview = z.infer<typeof SubmitReviewSchema>;
export type SubmitReviewInput = z.input<typeof SubmitReviewSchema>;

export function confidenceOf(value: number | ConfidenceWord): number {
  return typeof value === "number" ? value : CONFIDENCE_OF_WORD[value];
}

export function severityOf(word: SeverityWord): Severity {
  return SEVERITY_OF_WORD[word];
}

export const SUBMIT_REVIEW_DESCRIPTION =
  "Submit the review. Call it exactly once with the grade (0-100), your confidence as the word " +
  "high, medium or low (a number 0-1 is also accepted), the verdict (accept, revise, escalate, " +
  "human), a one-paragraph summary, every finding with its severity, each acceptance criterion " +
  "with met true/false and the evidence, doc_drift, the checks you ran, the ids of earlier " +
  "findings now resolved, and for an escalate verdict the escalation reason " +
  "(unverified_finding, evidence_missing or limit) with the finding, the item listed under " +
  "'Evidence not available' or the limit it names; an escalate without one is recorded as the " +
  "verdict the findings justify.";

/**
 * Fallback for a model that answers in text as the prompt describes ("a single JSON object
 * followed by a rationale"): the first balanced JSON object in the text that parses.
 */
export function parseReviewFromText(text: string): SubmitReview | null {
  const candidates = jsonObjectsIn(text);
  for (const c of candidates) {
    try {
      const parsed = SubmitReviewSchema.safeParse(JSON.parse(c));
      if (parsed.success) return parsed.data;
    } catch {
      // not this one
    }
  }
  return null;
}

function jsonObjectsIn(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}
