import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  formatTable,
  isPassed,
  parseGates,
  parseRequirements,
  parseTables,
  verify,
} from "./gates-verify.ts";

const repoRoot = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);

const GATES_OK = `# Gates

## Phase 0 — Foundations

| Check | Status | Command | Date | Result | CI |
| --- | --- | --- | --- | --- | --- |
| CI green | **passed** | \`pnpm check\` | 2026-10-20 | both runners green | https://ci.example.invalid/runs/1 |
| Fresh install | pending | \`scripts/fresh-install.sh\` | | | |
| Keys never in logs | **passed** (continuous) | \`pnpm secrets:scan\` | 2026-10-20 | clean | CI run 42 |

## Release 1.0 criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Every requirement done | pending | \`docs/requirements.md\` |
| 2 | Checks pass | pending | |
`;

const REQ = (status: string, test: string) => `# Requirements

## A. Projects

| ID | Requirement | Milestone | Status | Test |
| --- | --- | --- | --- | --- |
| A.1 | Create a project with a \\| pipe in the text. | 1 | ${status} | ${test} |
| A.2 | Second one. | 1 | done | packages/x/test/a.test.ts |

## Counts

| Module | Area | Count |
| --- | --- | --- |
| A | Projects | 2 |
`;

describe("gates-verify parsing", () => {
  it("parses tables with their section heading and escaped pipes", () => {
    const tables = parseTables(REQ("todo", ""));
    expect(tables).toHaveLength(2);
    expect(tables[0]?.section).toBe("A. Projects");
    expect(tables[0]?.header).toEqual(["ID", "Requirement", "Milestone", "Status", "Test"]);
    expect(tables[0]?.rows[0]?.cells[1]).toBe("Create a project with a | pipe in the text.");
    expect(tables[0]?.rows[0]?.line).toBe(7);
  });

  it("recognises passed in its written forms only", () => {
    expect(isPassed("passed")).toBe(true);
    expect(isPassed("**passed**")).toBe(true);
    expect(isPassed("**passed** (continuous)")).toBe(true);
    expect(isPassed("**partial**: measured under simulated latency")).toBe(false);
    expect(isPassed("pending")).toBe(false);
    expect(isPassed("blocked")).toBe(false);
    expect(isPassed("failed (see fix task)")).toBe(false);
  });

  it("separates milestone checks from release criteria", () => {
    const gates = parseGates(GATES_OK);
    expect(gates.checks.map((c) => c.check)).toEqual([
      "CI green",
      "Fresh install",
      "Keys never in logs",
    ]);
    expect(gates.checks[0]).toMatchObject({
      passed: true,
      date: "2026-10-20",
      ci: "https://ci.example.invalid/runs/1",
    });
    expect(gates.checks[2]?.passed).toBe(true);
    expect(gates.criteria.map((c) => c.number)).toEqual(["1", "2"]);
    expect(gates.criteria[0]?.passed).toBe(false);
  });

  it("parses requirement rows and skips other tables", () => {
    const rows = parseRequirements(REQ("in progress", "packages/x/test/a.test.ts"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "A.1", status: "in progress", milestone: "1" });
    expect(rows[1]?.test).toBe("packages/x/test/a.test.ts");
  });

  it("parses the real status files", () => {
    const gates = parseGates(readFileSync(join(repoRoot, "docs", "status", "gates.md"), "utf8"));
    const reqs = parseRequirements(readFileSync(join(repoRoot, "docs", "requirements.md"), "utf8"));
    expect(gates.checks.length).toBeGreaterThan(0);
    expect(gates.criteria.length).toBe(9);
    expect(reqs.length).toBeGreaterThan(200);
    expect(reqs.every((r) => /^[A-Z]\.\d+$/.test(r.id))).toBe(true);
  });
});

describe("gates-verify verification", () => {
  it("accepts passed rows with complete evidence and pending rows without", () => {
    const res = verify(parseGates(GATES_OK), parseRequirements(REQ("todo", "")));
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.summary).toMatchObject({
      checks: 3,
      checksPassed: 2,
      criteria: 2,
      criteriaPassed: 0,
      todo: 1,
      done: 1,
    });
  });

  it("fails a passed check that lacks any evidence field", () => {
    const noCi = GATES_OK.replace("| https://ci.example.invalid/runs/1 |", "| |");
    const res = verify(parseGates(noCi), parseRequirements(REQ("todo", "")));
    expect(res.ok).toBe(false);
    expect(res.problems[0]?.message).toContain('"CI green" is passed without CI link');
    const noDate = GATES_OK.replace(
      "| 2026-10-20 | both runners green |",
      "| soon | both runners green |",
    );
    expect(verify(parseGates(noDate), []).problems[0]?.message).toContain("without date");
    const noCommand = GATES_OK.replace("| `pnpm check` |", "| |");
    expect(verify(parseGates(noCommand), []).problems[0]?.message).toContain("without command");
    const noResult = GATES_OK.replace("| both runners green |", "| |");
    expect(verify(parseGates(noResult), []).problems[0]?.message).toContain("without result");
  });

  it("fails a passed release criterion without command, date and CI link in its evidence", () => {
    const partial = GATES_OK.replace(
      "| 2 | Checks pass | pending | |",
      "| 2 | Checks pass | passed | all green |",
    );
    const res = verify(parseGates(partial), parseRequirements(REQ("done", "t.test.ts")));
    expect(res.ok).toBe(false);
    expect(res.problems.map((p) => p.message).join("\n")).toContain(
      'release criterion 2 "Checks pass" is passed without command (in backticks), date, CI link',
    );
  });

  it("fails passed release criteria while any requirement is not done", () => {
    const full = GATES_OK.replace(
      "| 2 | Checks pass | pending | |",
      "| 2 | Checks pass | passed | `pnpm check` 2026-12-01 green https://ci.example.invalid/runs/9 |",
    );
    const ok = verify(parseGates(full), parseRequirements(REQ("done", "t.test.ts")));
    expect(ok.ok).toBe(true);
    const bad = verify(parseGates(full), parseRequirements(REQ("in progress", "t.test.ts")));
    expect(bad.ok).toBe(false);
    expect(bad.problems[0]?.message).toContain("1 requirement(s) are not done (first: A.1)");
  });

  it("fails a requirement marked done without a test path or with an unknown status", () => {
    const noTest = verify(parseGates(GATES_OK), parseRequirements(REQ("done", "")));
    expect(noTest.ok).toBe(false);
    expect(noTest.problems[0]?.message).toBe("A.1 is done without a test path");
    const unknown = verify(parseGates(GATES_OK), parseRequirements(REQ("finished", "x")));
    expect(unknown.problems[0]?.message).toContain('unknown status "finished"');
  });

  it("prints a table with the evidence state of every row", () => {
    const table = formatTable(parseGates(GATES_OK));
    expect(table).toContain("CI green");
    expect(table).toMatch(/CI green\s+passed\s+complete/);
    expect(table).toMatch(/Fresh install\s+pending\s+partial/);
    expect(table).toMatch(/2\. Checks pass\s+pending\s+-/);
    const broken = formatTable(
      parseGates(GATES_OK.replace("| https://ci.example.invalid/runs/1 |", "| |")),
    );
    expect(broken).toMatch(/CI green\s+passed\s+MISSING CI link/);
  });
});
