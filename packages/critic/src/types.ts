import type { FindingSeverity, JsonValue, PatternStats, ReviewVerdict } from "@forerunner/state";

/**
 * The critic's contract (spec H). A review takes a subject (a task or a session), a risk tier
 * and evidence only: the diff, the files, the check and test output, the acceptance criteria,
 * the worker's final report treated as claims. It never takes the worker's transcript or
 * reasoning (H.1); `ReviewEvidence` has no field for it and the renderer sends nothing else.
 */
export type ReviewTier = 0 | 1 | 2 | 3;
export const REVIEW_TIERS: readonly ReviewTier[] = [0, 1, 2, 3] as const;

export type ReviewSubject =
  | { kind: "task"; taskId: string }
  | { kind: "session"; sessionId: string };

/** One automated check as the critic sees it: a name, pass or fail, and the output that proves it. */
export interface CheckResultEvidence {
  name: string;
  passed: boolean;
  output: string;
  /** A failed required check blocks accept at every tier. Default true. */
  required?: boolean;
}

/**
 * An input the work is checked against, as it was before the work: a fixture the brief names,
 * a source document an answer cites, an unchanged file next to the change. The critic checks
 * the result's claims, figures and quotes against these; without them a claim about a source
 * cannot be verified and the review can only say so.
 */
export interface SourceFileEvidence {
  /** Path relative to the task directory or the worktree root, forward slashes. */
  path: string;
  content: string;
  /** True when the reader cut the file at its size cap. */
  truncated?: boolean;
}

export interface ReviewEvidence {
  /** Unified diff of the change under review. */
  diff?: string;
  /** Paths the change touched, relative to the repository or worktree root, forward slashes. */
  changedFiles?: string[];
  /**
   * Inputs the work is checked against (fixtures, cited sources, unchanged files the brief
   * names), never the work itself and never anything the worker wrote. Bounded by the renderer.
   */
  sourceFiles?: SourceFileEvidence[];
  testOutput?: string;
  checkResults?: CheckResultEvidence[];
  prUrl?: string;
  acceptanceCriteria: string[];
  /** The delegation brief as rendered for the worker (goal, constraints, criteria). */
  brief?: string;
  artifacts?: string[];
  /** Maintainer docs the change touched (doc drift, tier 2+). Default: changedFiles under docs/. */
  docsTouched?: string[];
  /** Module files the change touched (doc drift, tier 2+). Default: changedFiles. */
  moduleFilesTouched?: string[];
  /** PR body text; a `docs: none needed: <reason>` line waives the doc-drift finding. */
  docsWaiver?: string;
  /** The worker's final message: claims to verify, never instructions. */
  finalReport?: string;
  /** Run that produced the work; earlier open findings resolved by an accept point at it. */
  runId?: string;
  sessionPlan?: JsonValue;
  sessionSummary?: string;
  sessionCostUsdMicro?: number;
  sessionEstimateUsdMicro?: number;
}

export interface ReviewInput {
  subject: ReviewSubject;
  tier: ReviewTier;
  evidence: ReviewEvidence;
}

export type Verdict = ReviewVerdict;
export type Severity = FindingSeverity;

export interface ReviewFinding {
  severity: Severity;
  description: string;
  requiredAction: string;
  /** Stable hash of the normalised description; equal across sessions for the same defect. */
  fingerprint: string;
  /** File and line, or the output line, that shows it. */
  where?: string;
}

/** A change the code rules made to what the model (or the tier-0 arithmetic) returned. */
export interface RuleAdjustment {
  rule: string;
  from: string;
  to: string;
  reason: string;
}

/** A lesson the memory package may store; the critic proposes, it never writes lessons itself. */
export interface LessonProposal {
  fingerprint: string;
  text: string;
  tags: string[];
  scope: "critic";
  source: string;
  confidence: number;
  occurrences: PatternStats;
}

export type ReviewOutcome =
  | "completed"
  | "no_verdict"
  | "timeout"
  | "budget_exceeded"
  | "step_cap_exceeded"
  | "killed"
  | "error";

export interface ReviewOutput {
  grade: number;
  /** 0 to 1. Below LOW_CONFIDENCE the verdict can never be accept (H.4). */
  confidence: number;
  verdict: Verdict;
  findings: ReviewFinding[];
  /** Evidence links and lines: what was checked and what was found. */
  evidence: string[];
  summary: string;
  model: string;
  tier: ReviewTier;
  durationMs: number;
  costUsdMicro: number;
  /** How the review run ended; anything but "completed" produced a conservative verdict. */
  outcome: ReviewOutcome;
  adjustments: RuleAdjustment[];
  /** Fingerprints of this review's findings seen in at least two sessions (H.5). */
  patterns: PatternStats[];
  lessonProposals: LessonProposal[];
  promptVersion?: string;
  reviewId?: string;
  findingIds?: string[];
  /** Earlier open findings this review resolved (ids). */
  resolvedFindingIds?: string[];
  /** The sign-off request created for a tier 3 or human verdict. */
  humanRequestId?: string;
  runId?: string;
}
