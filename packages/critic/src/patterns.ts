import type { PatternStats, StateStore } from "@forerunner/state";
import type { LessonProposal, ReviewFinding } from "./types.ts";

/**
 * Repeat findings (H.5): a fingerprint seen in at least MIN_PATTERN_SESSIONS distinct sessions
 * is a pattern. The critic turns each into a lesson proposal for the memory package; it never
 * writes lessons itself (memory decides scope, storage and promotion).
 */
export const MIN_PATTERN_SESSIONS = 2;

export interface PatternsResult {
  patterns: PatternStats[];
  lessonProposals: LessonProposal[];
}

export function lessonProposalFor(f: ReviewFinding, stats: PatternStats): LessonProposal {
  return {
    fingerprint: stats.fingerprint,
    text:
      `Repeated critic finding (${stats.total} times in ${stats.sessions} sessions, ` +
      `${stats.tasks} task(s)): ${f.description}. Required action: ${f.requiredAction}`,
    tags: ["critic", "pattern", f.severity],
    scope: "critic",
    source: `critic:pattern:${stats.fingerprint}`,
    confidence: Math.min(0.95, 0.5 + 0.1 * stats.sessions),
    occurrences: stats,
  };
}

/** Patterns and lesson proposals for the findings of one review, after they were persisted. */
export async function patternsFor(
  store: StateStore,
  findings: readonly ReviewFinding[],
  minSessions = MIN_PATTERN_SESSIONS,
): Promise<PatternsResult> {
  const patterns: PatternStats[] = [];
  const lessonProposals: LessonProposal[] = [];
  const fingerprints = [...new Set(findings.map((f) => f.fingerprint).filter(Boolean))];
  for (const fp of fingerprints) {
    const stats = await store.finding.patterns(fp);
    if (stats.sessions < minSessions) continue;
    patterns.push(stats);
    const f = findings.find((x) => x.fingerprint === fp);
    if (f) lessonProposals.push(lessonProposalFor(f, stats));
  }
  return { patterns, lessonProposals };
}
