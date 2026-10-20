import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckRunner } from "../src/checks.ts";
import {
  type EvalDriver,
  expectedOutputDriver,
  formatEvalReport,
  loadEvalSet,
  loadEvalTask,
  runEvalSet,
  summarize,
  taskStatusOf,
  toDelegationBrief,
} from "../src/runner.ts";
import {
  type EvalTask,
  type EvalTaskInput,
  type EvalTaskResult,
  EvalTaskSchema,
} from "../src/types.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tempDir(prefix = "fr-runner-"): string {
  const d = mkdtempSync(join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}

function task(over: Partial<EvalTaskInput> & { id: string }): EvalTask {
  return EvalTaskSchema.parse({
    specialist: "coder",
    title: `Task ${over.id}`,
    brief: {
      goal: "write out.txt saying done",
      contextLinks: ["in.txt"],
      constraints: ["none stated"],
      acceptanceCriteria: ["out.txt contains done"],
      budgetUsdMicro: 1000,
      riskTier: 0,
    },
    setup: { files: { "in.txt": "input\n" } },
    checks: [{ kind: "file_contains", path: "out.txt", text: "done" }],
    expected_files: { "out.txt": "done\n" },
    seeded_defect: {
      description: "writes the wrong word",
      how_to_detect: "out.txt says nope",
      files: { "out.txt": "nope\n" },
    },
    ...over,
  });
}

const resultOf = (status: EvalTaskResult["status"], cost = 0): EvalTaskResult => ({
  taskId: "t",
  title: "t",
  variant: "clean",
  status,
  checks: [],
  evidence: [],
  finalText: "",
  costUsdMicro: cost,
  durationMs: 0,
});

describe("summary math", () => {
  it("counts passed, failed (including errors), needs_model and the pass rate over decided tasks", () => {
    const s = summarize(
      [
        resultOf("pass", 10),
        resultOf("fail", 20),
        resultOf("needs_model", 5),
        resultOf("error", 1),
        resultOf("pass", 4),
      ],
      123,
    );
    expect(s).toEqual({
      total: 5,
      passed: 2,
      failed: 2,
      needsModel: 1,
      errors: 1,
      passRate: 0.5,
      costUsdMicro: 40,
      durationMs: 123,
    });
    expect(summarize([]).passRate).toBe(0);
    expect(summarize([resultOf("needs_model")]).passRate).toBe(0);
    expect(summarize([resultOf("pass"), resultOf("pass"), resultOf("fail")]).passRate).toBeCloseTo(
      2 / 3,
    );
  });

  it("derives a task status from its checks", () => {
    const c = (status: "pass" | "fail" | "needs_model" | "error") => ({
      kind: "regex" as const,
      label: "",
      status,
      evidence: "",
      durationMs: 0,
    });
    expect(taskStatusOf([c("pass"), c("pass")])).toBe("pass");
    expect(taskStatusOf([c("pass"), c("needs_model")])).toBe("needs_model");
    expect(taskStatusOf([c("needs_model"), c("fail")])).toBe("fail");
    expect(taskStatusOf([c("pass"), c("error")])).toBe("error");
    expect(taskStatusOf([c("error"), c("fail")])).toBe("fail");
    expect(taskStatusOf([])).toBe("pass");
  });
});

describe("runEvalSet", () => {
  it("prepares fixtures, runs the driver, writes grader files after it, runs checks and cleans up", async () => {
    const clock = new SimulatedClock("2026-10-20T12:00:00Z");
    const seen: { workDir: string; hadIn: boolean; hadGrader: boolean; brief: string }[] = [];
    const driver: EvalDriver = async ({ workDir, brief }) => {
      seen.push({
        workDir,
        hadIn: existsSync(join(workDir, "in.txt")),
        hadGrader: existsSync(join(workDir, "grader.txt")),
        brief: brief.specialist,
      });
      writeFileSync(join(workDir, "out.txt"), "done\n");
      clock.tickMonotonic(50);
      return {
        outputDir: workDir,
        finalText: "wrote out.txt",
        cost: { usdMicro: 1234 },
        notes: ["ran 1 turn"],
      };
    };
    const t = task({
      id: "coder-001",
      grader_files: { "grader.txt": "hidden" },
      checks: [
        { kind: "file_contains", path: "out.txt", text: "done" },
        { kind: "file_exists", path: "grader.txt" },
      ],
    });
    const r = await runEvalSet({
      specialist: "coder",
      tasks: [t],
      driver,
      clock,
      promptVersion: "coder@1.0.0+deadbeef",
    });
    expect(r.summary).toMatchObject({ total: 1, passed: 1, failed: 0, costUsdMicro: 1234 });
    expect(r.promptVersion).toBe("coder@1.0.0+deadbeef");
    expect(r.startedAt).toBe("2026-10-20T12:00:00.000Z");
    expect(seen[0]).toMatchObject({ hadIn: true, hadGrader: false, brief: "coder" });
    expect(r.results[0]?.durationMs).toBe(50);
    expect(r.results[0]?.evidence).toEqual([
      expect.stringMatching(/^fixture: 1 file\(s\)/),
      "ran 1 turn",
      "grader files: grader.txt",
      expect.stringMatching(/^\[pass\] out\.txt contains "done"/),
      expect.stringMatching(/^\[pass\] grader\.txt is present/),
    ]);
    expect(existsSync(seen[0]?.workDir ?? "")).toBe(false);
    expect(r.results[0]?.workDir).toBeUndefined();
  });

  it("keeps work directories under a given root when asked, and names them by task and variant", async () => {
    const root = tempDir();
    const r = await runEvalSet({
      specialist: "coder",
      tasks: [task({ id: "coder-002" })],
      driver: expectedOutputDriver(),
      workRoot: root,
      keepWorkDirs: true,
    });
    expect(r.results[0]?.status).toBe("pass");
    expect(r.results[0]?.workDir).toBe(join(root, "coder-002-clean-0"));
    expect(readFileSync(join(root, "coder-002-clean-0", "out.txt"), "utf8")).toBe("done\n");
  });

  it("the expected-output driver produces the clean and the seeded-defect variant", async () => {
    const t = task({ id: "coder-003" });
    const clean = await runEvalSet({
      specialist: "coder",
      tasks: [t],
      driver: expectedOutputDriver({ costUsdMicro: 7 }),
    });
    expect(clean.results[0]?.status).toBe("pass");
    expect(clean.summary.costUsdMicro).toBe(7);
    const seeded = await runEvalSet({
      specialist: "coder",
      tasks: [t],
      driver: expectedOutputDriver(),
      variant: "seeded_defect",
    });
    expect(seeded.variant).toBe("seeded_defect");
    expect(seeded.results[0]?.status).toBe("fail");
    expect(seeded.results[0]?.evidence.at(-1)).toMatch(
      /\[fail\] out\.txt contains "done": out\.txt: "done" not found/,
    );
    const noDefect = task({ id: "coder-004", seeded_defect: undefined });
    const missing = await runEvalSet({
      specialist: "coder",
      tasks: [noDefect],
      driver: expectedOutputDriver(),
      variant: "seeded_defect",
    });
    expect(missing.results[0]?.status).toBe("error");
    expect(missing.results[0]?.error?.code).toBe("not_found");
  });

  it("turns a driver failure into an error result that counts as failed, and keeps going", async () => {
    let n = 0;
    const driver: EvalDriver = async (input) => {
      n++;
      if (n === 1) throw new Error("provider down");
      return expectedOutputDriver()(input);
    };
    const r = await runEvalSet({
      specialist: "coder",
      tasks: [task({ id: "coder-005" }), task({ id: "coder-006" })],
      driver,
    });
    expect(r.results.map((x) => x.status)).toEqual(["error", "pass"]);
    expect(r.results[0]?.error).toEqual({ code: "internal", message: "provider down" });
    expect(r.summary).toMatchObject({ total: 2, passed: 1, failed: 1, errors: 1, passRate: 0.5 });
    const report = formatEvalReport(r);
    expect(report).toMatch(
      /^eval coder \(clean\): 1 passed, 1 failed, 0 need the critic, pass rate 50%/,
    );
    expect(report).toMatch(/\[error\] internal: provider down/);
  });

  it("uses an injected checks runner, reports needs_model for rubric tasks and rejects tasks of another specialist", async () => {
    const calls: string[] = [];
    const checksRunner: CheckRunner = async (check) => {
      calls.push(check.kind);
      return {
        kind: check.kind,
        label: check.kind,
        status: check.kind === "rubric" ? "needs_model" : "pass",
        evidence: "stub",
        durationMs: 0,
      };
    };
    const t = task({
      id: "coder-007",
      checks: [
        { kind: "file_exists", path: "out.txt" },
        { kind: "rubric", criteria: ["is correct"] },
      ],
    });
    const r = await runEvalSet({
      specialist: "coder",
      tasks: [t],
      driver: expectedOutputDriver(),
      checksRunner,
    });
    expect(calls).toEqual(["file_exists", "rubric"]);
    expect(r.results[0]?.status).toBe("needs_model");
    expect(r.summary).toMatchObject({ passed: 0, failed: 0, needsModel: 1, passRate: 0 });
    await expect(
      runEvalSet({ specialist: "researcher", tasks: [t], driver: expectedOutputDriver() }),
    ).rejects.toThrow(/is for "coder", not "researcher"/);
  });

  it("stops when the signal is aborted", async () => {
    const ac = new AbortController();
    const driver: EvalDriver = async (input) => {
      ac.abort();
      return expectedOutputDriver()(input);
    };
    const r = await runEvalSet({
      specialist: "coder",
      tasks: [task({ id: "coder-008" }), task({ id: "coder-009" })],
      driver,
      signal: ac.signal,
    });
    expect(r.results).toHaveLength(1);
  });

  it("builds the enforced delegation brief from a task", () => {
    const b = toDelegationBrief(task({ id: "coder-010" }));
    expect(b).toMatchObject({
      specialist: "coder",
      taskId: "coder-010",
      riskTier: 0,
      budgetUsdMicro: 1000,
    });
  });
});

describe("loading task files", () => {
  it("validates file names, ids, specialist directories and duplicate ids", () => {
    const root = tempDir();
    const dir = join(root, "coder");
    const write = (name: string, t: unknown) => writeFileSync(join(dir, name), JSON.stringify(t));
    mkdirSync(dir, { recursive: true });
    write("001-good.json", task({ id: "coder-001" }));
    write("002-good.json", task({ id: "coder-002" }));
    write("README.md", "ignored");
    expect(loadEvalSet(dir).map((t) => t.id)).toEqual(["coder-001", "coder-002"]);

    write("003-wrong-id.json", task({ id: "coder-004" }));
    expect(() => loadEvalSet(dir)).toThrow(
      /003-wrong-id\.json: id: id "coder-004" must end with the file number 003/,
    );
    rmSync(join(dir, "003-wrong-id.json"));

    write("002-dupe.json", task({ id: "coder-002" }));
    expect(() => loadEvalSet(dir)).toThrow(/duplicate task id "coder-002"/);
    rmSync(join(dir, "002-dupe.json"));

    write("003-bad-specialist.json", { ...task({ id: "coder-003" }), specialist: "tester" });
    expect(() => loadEvalSet(dir)).toThrow(/specialist: "tester" must match the directory "coder"/);
    rmSync(join(dir, "003-bad-specialist.json"));

    write("003-no-defect-files.json", {
      ...task({ id: "coder-003" }),
      seeded_defect: { description: "something wrong", how_to_detect: "look closely" },
    });
    expect(() => loadEvalSet(dir)).toThrow(/seeded_defect: needs files or final_text/);
    rmSync(join(dir, "003-no-defect-files.json"));

    write("003-schema.json", { ...task({ id: "coder-003" }), checks: [] });
    expect(() => loadEvalTask(join(dir, "003-schema.json"))).toThrow(/003-schema\.json: checks:/);
    writeFileSync(join(dir, "004-broken.json"), "{");
    expect(() => loadEvalTask(join(dir, "004-broken.json"))).toThrow(/not valid JSON/);
    expect(() => loadEvalTask(join(dir, "nope.json"))).toThrow(/named NNN-<slug>\.json/);
    expect(() => loadEvalSet(join(root, "missing"))).toThrow(/not found/);
  });
});
