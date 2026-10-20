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
 * "medium" maps below LOW_CONFIDENCE on purpose: the prompt says accept needs high confidence
 * and medium escalates; the code rule makes that true whatever the prompt says.
 */
export const CONFIDENCE_OF_WORD: Record<ConfidenceWord, number> = {
  high: 0.9,
  medium: 0.5,
  low: 0.2,
};

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
  "Submit the review. Call it exactly once with the grade (0-100), your confidence (0-1 or " +
  "high/medium/low), the verdict (accept, revise, escalate, human), a one-paragraph summary, " +
  "every finding with its severity, each acceptance criterion with met true/false and the " +
  "evidence, doc_drift, the checks you ran, and the ids of earlier findings now resolved.";

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
