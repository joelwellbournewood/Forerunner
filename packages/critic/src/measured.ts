import type { TriedEvidence, VerificationRecord } from "./types.ts";

/**
 * Findings the runtime measured (ADR 0104, the review of 2026-11-02): a project check that failed
 * ("Check failed: <name>", `findingForFailedCheck`) and a try a person met a problem in ("Tried
 * <page>: <problem>", `buildVerdict`). They state a fact the runtime saw, so only a new
 * measurement closes them: a re-run of the check that passed, or a try of the page without that
 * problem. Never the model's accept, nor its list of resolved findings: on the bench a retry that
 * changed no file ran no check, the model accepted, and the accept resolved a test that still
 * failed; the task was "Done · Reviewed".
 */
export type MeasuredFinding =
  | { kind: "check"; name: string }
  | { kind: "tried"; target: string; problem: string };

/** The words a try's finding ends with when the task's files do not run on the page (ADR 0104). */
export const NOT_CAUSED_BY_TASK = " (not caused by this task)";

/**
 * What a try's finding asks for, in the words of what was tried (ADR 0110): a page is opened, a
 * command is run, a server is started and called. It is shown in the drawer and the retry brief.
 */
export function triedAction(t: Pick<TriedEvidence, "kind" | "target">): string {
  if (t.kind === "command") return `Make ${t.target} work when it is run as a person would run it`;
  if (t.kind === "server") return `Make ${t.target} start and answer as a person would use it`;
  return `Make ${t.target} work when it is opened as a person would use it`;
}

/** The problems of a try as its finding names them: its "problem:" lines, else its first line. */
export function triedProblems(output: string): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const problems = lines
    .filter((l) => /^problem:/i.test(l))
    .map((l) => l.replace(/^problem:\s*/i, "").slice(0, 300));
  if (problems.length) return problems;
  return [(lines[0] ?? "it did not work").slice(0, 300)];
}

/** The measurement a finding states, or null for a finding the model or a rule wrote. */
export function measuredFindingOf(description: string): MeasuredFinding | null {
  const check = /^Check failed: (.+)$/.exec(description);
  if (check?.[1]) return { kind: "check", name: check[1] };
  const tried = /^Tried (.+?): (.+)$/.exec(description);
  if (tried?.[1] && tried[2]) {
    const problem = tried[2].endsWith(NOT_CAUSED_BY_TASK)
      ? tried[2].slice(0, -NOT_CAUSED_BY_TASK.length)
      : tried[2];
    return { kind: "tried", target: tried[1], problem };
  }
  return null;
}

/**
 * Whether this review's own measurements resolve a measured finding: true when the check ran
 * again and passed, or the page was tried again without that problem; false when it was not
 * measured again or failed again (the finding stays open); null for a finding nothing measured,
 * which the verdict decides as before.
 */
export function resolvedByRerun(
  description: string,
  verification: VerificationRecord | undefined,
): boolean | null {
  const m = measuredFindingOf(description);
  if (!m) return null;
  if (!verification) return false;
  if (m.kind === "check") {
    const runs = verification.checks.filter((c) => c.name === m.name);
    return runs.length > 0 && runs.every((c) => c.passed);
  }
  const tries = verification.tried.filter((t) => t.target === m.target);
  return (
    tries.length > 0 && tries.every((t) => t.ok || !triedProblems(t.output).includes(m.problem))
  );
}
