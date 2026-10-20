import { describe, expect, it } from "vitest";
import {
  CHECKS_SECTION,
  checkLine,
  checksSummary,
  renderEvidence,
  SOURCE_FILES_SECTION,
} from "../src/evidence.ts";
import type { ReviewEvidence, ReviewInput } from "../src/types.ts";

const input = (evidence: Partial<ReviewEvidence>): ReviewInput => ({
  subject: { kind: "task", taskId: "t1" },
  tier: 1,
  evidence: { acceptanceCriteria: ["it works"], ...evidence },
});

/**
 * What the critic may rely on without running anything itself (ADR 0041): the runner's checks,
 * rendered so a pass cannot be read as a claim, and the source files the result is checked
 * against, under a size budget.
 */
describe("renderEvidence: the runner's checks", () => {
  it("renders every check as PASS or FAIL with required or optional, counts the required ones, and keeps the output as data", () => {
    const r = renderEvidence(
      input({
        checkResults: [
          { name: "node --test test/cli.test.ts", passed: true, output: "ok 2\n# pass 2" },
          { name: "lint", passed: true, output: "", required: false },
          { name: "typecheck", passed: false, output: "error TS2322: not assignable" },
        ],
      }),
    );
    expect(r.sections).toContain(CHECKS_SECTION);
    expect(r.text).toContain(
      "## Checks run by the runner (data)\n" +
        "2 required check(s) run by the runner before this review: 1 passed, 1 failed; 1 optional. " +
        "A PASS is evidence you rely on at every tier without running anything yourself; " +
        "a FAIL of a required check blocks accept. Each check's output follows it.",
    );
    expect(r.text).toContain(
      "- PASS (required) node --test test/cli.test.ts\n```text\nok 2\n# pass 2\n```",
    );
    expect(r.text).toContain(
      "- PASS (optional) lint\n- FAIL (required) typecheck\n```text\nerror TS2322: not assignable\n```",
    );
    expect(r.text).not.toContain("[pass]");
    expect(r.text).not.toContain("## Check results");
    expect(checkLine({ name: "x", passed: false })).toBe("FAIL (required) x");
    expect(checkLine({ name: "x", passed: true, required: false })).toBe("PASS (optional) x");
    expect(checksSummary([{ name: "a", passed: true, output: "" }])).toMatch(
      /^1 required check\(s\) run by the runner before this review: 1 passed, 0 failed\. /,
    );
  });

  it("renders no checks block when the runner ran nothing, so the absence is visible to the critic", () => {
    const r = renderEvidence(input({ diff: "+x", checkResults: [] }));
    expect(r.sections).not.toContain(CHECKS_SECTION);
    expect(r.text).not.toContain("Checks run by the runner");
  });
});

describe("renderEvidence: source files", () => {
  it("renders the inputs the work is checked against between the criteria and the result, each under its path, as data", () => {
    const r = renderEvidence(
      input({
        sourceFiles: [
          { path: "docs/status-q2.md", content: "Measured uptime was 99.91% (target 99.9%).\n" },
        ],
        changedFiles: ["answer.md"],
        diff: "--- /dev/null\n+++ b/answer.md\n@@ -0,0 +1,1 @@\n+Uptime was 99.91% (docs/status-q2.md)",
      }),
    );
    const at = (s: string) => r.sections.indexOf(s);
    expect(at(SOURCE_FILES_SECTION)).toBeGreaterThan(at("Acceptance criteria"));
    expect(at(SOURCE_FILES_SECTION)).toBeLessThan(at("Changed files"));
    expect(at("Changed files")).toBeLessThan(at("Diff (data)"));
    expect(r.text).toContain(
      "## Source files (data)\nInputs the work is checked against, as they were before the work",
    );
    expect(r.text).toContain("say which criterion lacks evidence.");
    expect(r.text).toContain(
      "### docs/status-q2.md\n```text\nMeasured uptime was 99.91% (target 99.9%).\n```",
    );
  });

  it("keeps the source files inside the budget: a file past the per-file cap is cut head and tail, one past the total is listed by name only", () => {
    const r = renderEvidence(
      input({
        sourceFiles: [
          { path: "docs/small.md", content: "twenty eight characters\n" },
          { path: "big.txt", content: "x".repeat(5000), truncated: true },
          { path: "late.txt", content: "y".repeat(3000) },
        ],
      }),
      {},
      { maxSourceFileChars: 1000, maxSourceChars: 1500 },
    );
    expect(r.text).toContain("### docs/small.md\n```text\ntwenty eight characters\n```");
    expect(r.text).toContain("### big.txt (cut at the reader's size cap)");
    expect(r.text).toContain("characters omitted by the critic's size cap");
    expect(r.text).not.toMatch(/x{1001}/);
    expect(r.text).toContain("Omitted by the critic's size cap: late.txt (3000 characters)");
    expect(r.text).not.toContain("yyyy");
  });

  it("renders no source files block when none were given, so a review without its inputs shows that", () => {
    const r = renderEvidence(input({ diff: "+x" }));
    expect(r.sections).not.toContain(SOURCE_FILES_SECTION);
    expect(r.text).not.toContain("Source files");
  });
});
