import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "@forerunner/platform";
import { validateBrief } from "@forerunner/runtime";
import { describe, expect, it } from "vitest";
import {
  expectedOutputDriver,
  formatEvalReport,
  loadEvalSet,
  runEvalSet,
  toDelegationBrief,
} from "../src/runner.ts";
import { type EvalTask, EvalTaskSchema } from "../src/types.ts";

const REGISTRY = resolve(import.meta.dirname, "..", "registry");
const SETS = ["coder", "researcher"] as const;

const sets = Object.fromEntries(
  SETS.map((s) => [s, loadEvalSet(join(REGISTRY, "evals", s))]),
) as Record<(typeof SETS)[number], EvalTask[]>;

describe("golden eval sets", () => {
  it("ship 20 tasks each for coder and researcher, with unique ids that match their files", () => {
    for (const name of SETS) {
      const files = readdirSync(join(REGISTRY, "evals", name))
        .filter((f) => f.endsWith(".json"))
        .sort();
      expect(files, name).toHaveLength(20);
      expect(sets[name], name).toHaveLength(20);
      const ids = sets[name].map((t) => t.id);
      expect(new Set(ids).size).toBe(20);
      sets[name].forEach((t, i) => {
        expect(t.id).toBe(`${name}-${String(i + 1).padStart(3, "0")}`);
        expect(files[i]?.startsWith(`${String(i + 1).padStart(3, "0")}-`)).toBe(true);
        expect(t.specialist).toBe(name);
      });
    }
  });

  it("every task file validates against the schema as written, carries an enforceable brief, a reference solution and a seeded defect", () => {
    for (const name of SETS) {
      // the raw JSON, not loadEvalSet's output (which already has defaults applied)
      const dir = join(REGISTRY, "evals", name);
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        const raw: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const parsed = EvalTaskSchema.safeParse(raw);
        expect(parsed.success, `${name}/${f}: ${parsed.error?.message ?? ""}`).toBe(true);
      }
      for (const t of sets[name]) {
        expect(() => validateBrief(toDelegationBrief(t)), t.id).not.toThrow();
        expect(t.brief.acceptanceCriteria.length, t.id).toBeGreaterThanOrEqual(3);
        expect(Object.keys(t.setup.files).length, t.id).toBeGreaterThan(0);
        expect(t.expected_files, t.id).toBeDefined();
        expect(t.seeded_defect?.files, t.id).toBeDefined();
        expect(t.seeded_defect?.how_to_detect, t.id).toBeTruthy();
        expect(t.expected_clean_output, t.id).toBeTruthy();
        expect(t.tags.length, t.id).toBeGreaterThan(0);
        for (const c of t.checks) {
          if (c.kind === "command_exit0") {
            expect(c.argv[0], t.id).toBe("node");
            expect(c.argv.join(" "), t.id).not.toMatch(/[|&;><`$]/);
          }
          if (c.kind === "regex") expect(c.pattern, t.id).not.toMatch(/^\(\?[a-z]+\)/);
        }
      }
    }
  });

  it("coder tasks grade with hidden tests and a rubric-free mechanical verdict", () => {
    for (const t of sets.coder) {
      expect(
        t.checks.some((c) => c.kind === "command_exit0" || c.kind === "json_path"),
        t.id,
      ).toBe(true);
      expect(t.brief.riskTier, t.id).toBeGreaterThanOrEqual(0);
      if (t.grader_files)
        expect(Object.keys(t.grader_files)[0], t.id).toMatch(/^test\/grader\.test\.ts$/);
    }
  });

  it("researcher tasks require citations, uncertainty and a rubric for the critic", () => {
    for (const t of sets.researcher) {
      expect(
        t.checks.some((c) => c.kind === "rubric"),
        t.id,
      ).toBe(true);
      expect(
        t.checks.some((c) => c.kind === "regex" && /^(docs|data|logs)\//.test(c.pattern)),
        t.id,
      ).toBe(true);
      expect(t.expected_files?.["answer.md"], t.id).toMatch(/## Uncertainty/);
      expect(t.expected_files?.["answer.md"], t.id).toMatch(/## Claims/);
      expect(t.brief.constraints.join(" "), t.id).toMatch(/no web access/);
    }
  });

  it("clean coder fixtures pass every mechanical check through the expected-output driver (real node test runs)", async () => {
    const r = await runEvalSet({
      specialist: "coder",
      tasks: sets.coder,
      driver: expectedOutputDriver(),
    });
    expect(r.summary, formatEvalReport(r)).toMatchObject({
      total: 20,
      passed: 20,
      failed: 0,
      errors: 0,
      needsModel: 0,
      passRate: 1,
    });
  }, 120_000);

  it("seeded coder defects are each caught by at least one mechanical check", async () => {
    const r = await runEvalSet({
      specialist: "coder",
      tasks: sets.coder,
      driver: expectedOutputDriver(),
      variant: "seeded_defect",
    });
    expect(r.summary, formatEvalReport(r)).toMatchObject({
      total: 20,
      passed: 0,
      failed: 20,
      errors: 0,
      passRate: 0,
    });
    for (const t of r.results)
      expect(
        t.checks.some((c) => c.status === "fail"),
        t.taskId,
      ).toBe(true);
  }, 120_000);

  it("clean researcher answers pass every mechanical check and wait on the critic for the rubric", async () => {
    const r = await runEvalSet({
      specialist: "researcher",
      tasks: sets.researcher,
      driver: expectedOutputDriver(),
    });
    expect(r.summary, formatEvalReport(r)).toMatchObject({
      total: 20,
      failed: 0,
      errors: 0,
      needsModel: 20,
    });
    for (const t of r.results) {
      expect(
        t.checks.filter((c) => c.status === "fail" || c.status === "error"),
        t.taskId,
      ).toEqual([]);
      expect(t.checks.filter((c) => c.status === "pass").length, t.taskId).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  it("seeded researcher defects are each caught by at least one mechanical check", async () => {
    const r = await runEvalSet({
      specialist: "researcher",
      tasks: sets.researcher,
      driver: expectedOutputDriver(),
      variant: "seeded_defect",
    });
    expect(r.summary, formatEvalReport(r)).toMatchObject({
      total: 20,
      passed: 0,
      failed: 20,
      errors: 0,
      needsModel: 0,
    });
    for (const t of r.results)
      expect(
        t.checks.some((c) => c.status === "fail"),
        t.taskId,
      ).toBe(true);
  });
});
