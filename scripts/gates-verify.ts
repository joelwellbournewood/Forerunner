#!/usr/bin/env -S pnpm exec tsx
/**
 * gates-verify: no check is "passed" without evidence.
 *
 * Parses docs/status/gates.md (milestone check tables and the release-criteria table) and
 * docs/requirements.md (requirement tables), prints a table of every gate with its status and
 * whether the evidence is complete, and exits 1 when
 *   - a milestone check says passed without command, date, result and CI link,
 *   - a release criterion says passed without a command, a date and a CI link in its evidence,
 *   - any release criterion is passed while a requirement is not done,
 *   - a requirement is done without a test path, or carries an unknown status.
 *
 * Usage: pnpm gates:verify [--gates docs/status/gates.md] [--requirements docs/requirements.md] [--json]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalizeNewlines, resolve } from "@forerunner/platform";

export interface TableRow {
  cells: string[];
  line: number;
}

export interface Table {
  /** Nearest preceding "## " heading. */
  section: string;
  header: string[];
  rows: TableRow[];
}

export interface GateRow {
  section: string;
  check: string;
  status: string;
  passed: boolean;
  command: string;
  date: string;
  result: string;
  ci: string;
  line: number;
}

export interface CriterionRow {
  section: string;
  number: string;
  criterion: string;
  status: string;
  passed: boolean;
  evidence: string;
  line: number;
}

export interface RequirementRow {
  id: string;
  requirement: string;
  milestone: string;
  status: string;
  test: string;
  line: number;
}

export interface Gates {
  checks: GateRow[];
  criteria: CriterionRow[];
}

export interface Problem {
  file: "gates" | "requirements";
  line: number;
  message: string;
}

export interface Verification {
  ok: boolean;
  problems: Problem[];
  summary: {
    checks: number;
    checksPassed: number;
    criteria: number;
    criteriaPassed: number;
    requirements: number;
    done: number;
    inProgress: number;
    todo: number;
  };
}

export const REQUIREMENT_STATUSES = new Set(["todo", "in progress", "done"]);
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const LINK_RE = /https?:\/\/\S+/;
const COMMAND_RE = /`[^`]+`/;

function splitCells(line: string): string[] {
  // "| a | b |" -> ["a", "b"]; "\|" inside a cell stays a pipe.
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

function isSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line.trim());
}

/** Every Markdown table in the document, with its section heading. */
export function parseTables(markdown: string): Table[] {
  const lines = normalizeNewlines(markdown).split("\n");
  const tables: Table[] = [];
  let section = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) section = (heading[1] ?? "").trim();
    const next = lines[i + 1] ?? "";
    if (line.trim().startsWith("|") && isSeparator(next)) {
      const header = splitCells(line);
      const rows: TableRow[] = [];
      let j = i + 2;
      while (j < lines.length && (lines[j] ?? "").trim().startsWith("|")) {
        rows.push({ cells: splitCells(lines[j] ?? ""), line: j + 1 });
        j++;
      }
      tables.push({ section, header, rows });
      i = j;
      continue;
    }
    i++;
  }
  return tables;
}

/** Strip bold, code and surrounding punctuation from a status cell and lower-case it. */
export function normalizeStatus(cell: string): string {
  return cell.replace(/[*_`]/g, "").trim().toLowerCase();
}

/** "passed", "**passed** (continuous)" -> true; "partial: ..." and "pending" -> false. */
export function isPassed(cell: string): boolean {
  return /^passed\b/.test(normalizeStatus(cell));
}

function col(header: string[], name: string): number {
  return header.findIndex((h) => h.trim().toLowerCase() === name);
}

/** Milestone checks and release criteria from gates.md. */
export function parseGates(markdown: string): Gates {
  const checks: GateRow[] = [];
  const criteria: CriterionRow[] = [];
  for (const table of parseTables(markdown)) {
    const h = table.header.map((x) => x.toLowerCase());
    if (h.includes("check") && h.includes("status")) {
      const idx = {
        check: col(h, "check"),
        status: col(h, "status"),
        command: col(h, "command"),
        date: col(h, "date"),
        result: col(h, "result"),
        ci: col(h, "ci"),
      };
      for (const row of table.rows) {
        const get = (i: number) => (i >= 0 ? (row.cells[i] ?? "") : "");
        const status = get(idx.status);
        checks.push({
          section: table.section,
          check: get(idx.check),
          status,
          passed: isPassed(status),
          command: get(idx.command),
          date: get(idx.date),
          result: get(idx.result),
          ci: get(idx.ci),
          line: row.line,
        });
      }
    } else if (h.includes("criterion") && h.includes("status")) {
      const idx = {
        number: col(h, "#"),
        criterion: col(h, "criterion"),
        status: col(h, "status"),
        evidence: col(h, "evidence"),
      };
      for (const row of table.rows) {
        const get = (i: number) => (i >= 0 ? (row.cells[i] ?? "") : "");
        const status = get(idx.status);
        criteria.push({
          section: table.section,
          number: get(idx.number),
          criterion: get(idx.criterion),
          status,
          passed: isPassed(status),
          evidence: get(idx.evidence),
          line: row.line,
        });
      }
    }
  }
  return { checks, criteria };
}

/** Requirement rows (ID, Requirement, Milestone, Status, Test) from requirements.md. */
export function parseRequirements(markdown: string): RequirementRow[] {
  const out: RequirementRow[] = [];
  for (const table of parseTables(markdown)) {
    const h = table.header.map((x) => x.toLowerCase());
    if (h[0] !== "id" || !h.includes("status") || !h.includes("test")) continue;
    const idx = {
      requirement: col(h, "requirement"),
      milestone: col(h, "milestone"),
      status: col(h, "status"),
      test: col(h, "test"),
    };
    for (const row of table.rows) {
      const id = row.cells[0] ?? "";
      if (!/^[A-Z]+\.\d+$/.test(id)) continue;
      const get = (i: number) => (i >= 0 ? (row.cells[i] ?? "") : "");
      out.push({
        id,
        requirement: get(idx.requirement),
        milestone: get(idx.milestone),
        status: normalizeStatus(get(idx.status)),
        test: get(idx.test),
        line: row.line,
      });
    }
  }
  return out;
}

/** Which evidence fields a passed milestone check is missing. */
export function missingCheckEvidence(row: GateRow): string[] {
  const missing: string[] = [];
  if (!row.command.trim()) missing.push("command");
  if (!DATE_RE.test(row.date)) missing.push("date");
  if (!row.result.trim()) missing.push("result");
  if (!row.ci.trim()) missing.push("CI link");
  return missing;
}

/** Which evidence parts a passed release criterion is missing (command, date, CI link). */
export function missingCriterionEvidence(row: CriterionRow): string[] {
  const missing: string[] = [];
  if (!COMMAND_RE.test(row.evidence)) missing.push("command (in backticks)");
  if (!DATE_RE.test(row.evidence)) missing.push("date");
  if (!LINK_RE.test(row.evidence)) missing.push("CI link");
  return missing;
}

export function verify(gates: Gates, requirements: RequirementRow[]): Verification {
  const problems: Problem[] = [];
  for (const row of gates.checks) {
    if (!row.passed) continue;
    const missing = missingCheckEvidence(row);
    if (missing.length)
      problems.push({
        file: "gates",
        line: row.line,
        message: `"${row.check}" is passed without ${missing.join(", ")}`,
      });
  }
  for (const row of gates.criteria) {
    if (!row.passed) continue;
    const missing = missingCriterionEvidence(row);
    if (missing.length)
      problems.push({
        file: "gates",
        line: row.line,
        message: `release criterion ${row.number} "${row.criterion}" is passed without ${missing.join(", ")} in its evidence`,
      });
  }
  const notDone = requirements.filter((r) => r.status !== "done");
  const criteriaPassed = gates.criteria.filter((r) => r.passed);
  if (criteriaPassed.length > 0 && notDone.length > 0) {
    problems.push({
      file: "gates",
      line: criteriaPassed[0]?.line ?? 0,
      message: `${criteriaPassed.length} release criterion/criteria passed while ${notDone.length} requirement(s) are not done (first: ${notDone
        .slice(0, 5)
        .map((r) => r.id)
        .join(", ")})`,
    });
  }
  for (const r of requirements) {
    if (!REQUIREMENT_STATUSES.has(r.status)) {
      problems.push({
        file: "requirements",
        line: r.line,
        message: `${r.id} has unknown status "${r.status}" (todo, in progress or done)`,
      });
    } else if (r.status === "done" && !r.test.trim()) {
      problems.push({
        file: "requirements",
        line: r.line,
        message: `${r.id} is done without a test path`,
      });
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    summary: {
      checks: gates.checks.length,
      checksPassed: gates.checks.filter((r) => r.passed).length,
      criteria: gates.criteria.length,
      criteriaPassed: criteriaPassed.length,
      requirements: requirements.length,
      done: requirements.filter((r) => r.status === "done").length,
      inProgress: requirements.filter((r) => r.status === "in progress").length,
      todo: requirements.filter((r) => r.status === "todo").length,
    },
  };
}

function pad(text: string, width: number): string {
  const t = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  return t.padEnd(width);
}

/** Human-readable table: section, check, status, evidence completeness. */
export function formatTable(gates: Gates): string {
  const lines: string[] = [];
  lines.push(`${pad("section", 22)} ${pad("check", 60)} ${pad("status", 12)} evidence`);
  for (const row of gates.checks) {
    const missing = missingCheckEvidence(row);
    const evidence = row.passed
      ? missing.length
        ? `MISSING ${missing.join(", ")}`
        : "complete"
      : missing.length === 4
        ? "-"
        : "partial";
    lines.push(
      `${pad(row.section, 22)} ${pad(row.check, 60)} ${pad(normalizeStatus(row.status).split(/[\s(:]/)[0] ?? "", 12)} ${evidence}`,
    );
  }
  for (const row of gates.criteria) {
    const missing = missingCriterionEvidence(row);
    const evidence = row.passed
      ? missing.length
        ? `MISSING ${missing.join(", ")}`
        : "complete"
      : row.evidence.trim()
        ? "partial"
        : "-";
    lines.push(
      `${pad(row.section, 22)} ${pad(`${row.number}. ${row.criterion}`, 60)} ${pad(normalizeStatus(row.status).split(/[\s(:]/)[0] ?? "", 12)} ${evidence}`,
    );
  }
  return lines.join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "\u0000");
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const gatesPath = arg("--gates") ?? join(repoRoot, "docs", "status", "gates.md");
  const requirementsPath = arg("--requirements") ?? join(repoRoot, "docs", "requirements.md");
  const gates = parseGates(readFileSync(gatesPath, "utf8"));
  const requirements = parseRequirements(readFileSync(requirementsPath, "utf8"));
  const result = verify(gates, requirements);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ gates, requirements: result.summary, result }, null, 2));
  } else {
    console.log(formatTable(gates));
    const s = result.summary;
    console.log(
      `\nchecks: ${s.checksPassed}/${s.checks} passed; release criteria: ${s.criteriaPassed}/${s.criteria} passed; requirements: ${s.done} done, ${s.inProgress} in progress, ${s.todo} todo of ${s.requirements}`,
    );
    for (const p of result.problems) {
      console.error(
        `gates-verify: ${p.file === "gates" ? gatesPath : requirementsPath}:${p.line}: ${p.message}`,
      );
    }
    console.log(
      result.ok ? "gates-verify: ok" : `gates-verify: ${result.problems.length} problem(s)`,
    );
  }
  process.exit(result.ok ? 0 : 1);
}
