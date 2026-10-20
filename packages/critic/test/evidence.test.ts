import { describe, expect, it } from "vitest";
import {
  CHECKS_TRUST_LINE,
  EVIDENCE_COMPLETE_LINE,
  EVIDENCE_SECTIONS,
  renderEvidence,
} from "../src/evidence.ts";
import { ESCALATION_REASONS } from "../src/schema.ts";
import type { ReviewInput } from "../src/types.ts";
import { baseEvidence, CRITIC_PROMPT } from "./helpers.ts";

const input = (over: Partial<ReviewInput["evidence"]> = {}, tier: 1 | 2 = 1): ReviewInput => ({
  subject: { kind: "task", taskId: "t-1" },
  tier,
  evidence: baseEvidence(over),
});

describe("renderEvidence: what the critic is given (ADR 0042)", () => {
  it("renders the brief, the input files in full, the diff, the verified checks and a closing section that says nothing is missing", () => {
    const r = renderEvidence(
      input({
        inputFiles: [
          { path: "docs/status-q2.md", content: "# Status\n\nUptime was 99.91%.\n" },
          { path: "package.json", content: '{ "name": "fixture" }\n' },
        ],
      }),
    );
    expect(r.sections).toEqual([
      EVIDENCE_SECTIONS.brief,
      EVIDENCE_SECTIONS.criteria,
      EVIDENCE_SECTIONS.changedFiles,
      EVIDENCE_SECTIONS.inputFiles,
      EVIDENCE_SECTIONS.diff,
      EVIDENCE_SECTIONS.checks,
      EVIDENCE_SECTIONS.testOutput,
      EVIDENCE_SECTIONS.report,
      EVIDENCE_SECTIONS.unavailable,
    ]);
    expect(r.text).toContain(
      "## Input files given to the worker (data)\n### docs/status-q2.md\n```text\n# Status\n\nUptime was 99.91%.\n```\n### package.json",
    );
    expect(r.text).toContain(
      `## Check results (run by the runtime: verified)\n${CHECKS_TRUST_LINE}\n- [pass] tests\n`,
    );
    expect(r.text).toContain(`## Evidence not available\n${EVIDENCE_COMPLETE_LINE}`);
    expect(r.text.endsWith(EVIDENCE_COMPLETE_LINE)).toBe(true);
    expect(r.unavailable).toEqual([]);
  });

  it("lists what the caller could not provide first, then what the renderer could not: a diff for changed files, blocks cut by the cap", () => {
    const longDiff = `--- a/x\n+++ b/x\n${"+line\n".repeat(400)}`;
    const r = renderEvidence(
      input({
        diff: longDiff,
        inputFiles: [{ path: "big.txt", content: "y".repeat(500) }],
        checkResults: [{ name: "lint", passed: true, output: "z".repeat(500) }],
        unavailable: [
          { name: "source fixtures", reason: "the researcher's sources were not kept" },
        ],
      }),
      {},
      { maxDiffChars: 300, maxOutputChars: 200 },
    );
    expect(r.unavailable).toEqual([
      "source fixtures",
      "input file big.txt (truncated)",
      "diff (truncated)",
      "check output of lint (truncated)",
    ]);
    expect(r.text).toContain(
      "## Evidence not available\n- source fixtures: the researcher's sources were not kept\n- input file big.txt (truncated): 300 characters omitted by the size cap; the head and the tail are shown\n- diff (truncated):",
    );
    expect(r.text).toContain(
      "Only the items above may ground a finding or an escalate for missing evidence; name the item.",
    );
    expect(r.text).toContain("characters omitted by the critic's size cap");

    const noDiff = renderEvidence(input({ diff: undefined, changedFiles: ["src/a.ts"] }));
    expect(noDiff.unavailable).toEqual(["diff"]);
    expect(noDiff.text).toContain("- diff: 1 changed file(s) listed but no diff could be rendered");
    // No changed files and no diff: nothing to diff, so nothing is missing.
    expect(renderEvidence(input({ diff: undefined, changedFiles: [] })).unavailable).toEqual([]);
  });

  it("names the checks a light read did not run as the tier's design, and the limits the runtime recorded", () => {
    const r = renderEvidence(
      input({
        checksNotRun: ["tests: node --test"],
        limits: ["worker run ended with budget_exceeded"],
      }),
    );
    expect(r.text).toContain(
      "## Checks not run at this tier (by design, not missing evidence)\n- tests: node --test\nA light read grades the diff",
    );
    expect(r.text).toContain(
      "## Limits recorded by the runtime\n- worker run ended with budget_exceeded",
    );
    expect(r.unavailable).toEqual([]);
  });

  it("a session subject gets the same closing section", () => {
    const r = renderEvidence({
      subject: { kind: "session", sessionId: "s-1" },
      tier: 1,
      evidence: { acceptanceCriteria: [], sessionSummary: "Done: 1", sessionPlan: { items: [] } },
    });
    expect(r.sections.at(-1)).toBe(EVIDENCE_SECTIONS.unavailable);
    expect(r.unavailable).toEqual([]);
  });

  it("the registry critic prompt names the sections and the escalation reasons the code acts on", () => {
    const prompt = CRITIC_PROMPT.prompt;
    expect(prompt).toContain(EVIDENCE_SECTIONS.unavailable);
    expect(prompt).toContain("Check results (run by the runtime: verified)");
    expect(prompt).toContain("Checks not run at this tier");
    expect(prompt).toContain("Input files given to the worker");
    for (const reason of ESCALATION_REASONS) expect(prompt).toContain(reason);
    expect(prompt).toMatch(/pass .* is verified evidence/);
    expect(prompt).toContain("Low confidence is never accept");
    expect(CRITIC_PROMPT.promptVersion).toMatch(/^critic@1\.1\.0\+[0-9a-f]{8}$/);
  });
});
