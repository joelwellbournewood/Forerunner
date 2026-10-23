import type { FindingSeverity, JsonValue, PatternStats, ReviewVerdict } from "@forerunner/state";

/**
 * The critic's contract (spec H). A review takes a subject (a task, a session, or a lesson
 * proposed for the shared store), a risk tier and evidence only: the diff, the files, the
 * check and test output, the acceptance criteria, the worker's final report treated as claims.
 * It never takes the worker's transcript or reasoning (H.1); `ReviewEvidence` has no field for
 * it and the renderer sends nothing else.
 */
export type ReviewTier = 0 | 1 | 2 | 3;
export const REVIEW_TIERS: readonly ReviewTier[] = [0, 1, 2, 3] as const;

/**
 * What is reviewed. A `lesson` subject is a memory lesson proposed for cross-project
 * promotion (spec G.6): the review row carries no task, the token's session, and a `human`
 * verdict files no sign-off request (nothing to sign off; the proposal stays pending).
 */
export type ReviewSubject =
  | { kind: "task"; taskId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "lesson"; lessonId: string };

/** One automated check as the critic sees it: a name, pass or fail, and the output that proves it. */
export interface CheckResultEvidence {
  name: string;
  passed: boolean;
  output: string;
  /** A failed required check blocks accept at every tier. Default true. */
  required?: boolean;
}

/** A file the worker was given (a fixture, a source document), rendered to the critic in full up to the cap. */
export interface InputFileEvidence {
  /** Relative path, forward slashes. */
  path: string;
  content: string;
}

/**
 * Material the evidence builder could not provide, by name (ADR 0042). The renderer lists it
 * under "Evidence not available"; an `escalate` for missing evidence qualifies only when it
 * names one of these. Everything not listed counts as complete.
 */
export interface UnavailableEvidence {
  name: string;
  reason: string;
}

export interface ReviewEvidence {
  /** Unified diff of the change under review. */
  diff?: string;
  /** Paths the change touched, relative to the repository or worktree root, forward slashes. */
  changedFiles?: string[];
  /** Files the worker was given: the researcher's sources, the coder's starting files. */
  inputFiles?: InputFileEvidence[];
  testOutput?: string;
  checkResults?: CheckResultEvidence[];
  /** Check commands the tier did not run (tier 1 light read); by design, never missing evidence. */
  checksNotRun?: string[];
  /** Evidence the builder could not provide, by name; the only grounds for an evidence_missing escalate. */
  unavailable?: UnavailableEvidence[];
  /**
   * Limit conditions the runtime recorded for the work under review (the worker's run ended
   * with budget_exceeded or a timeout, a ceiling reached); grounds for a `limit` escalate.
   */
  limits?: string[];
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
