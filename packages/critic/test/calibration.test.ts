import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { type EvalTask, EvalTaskSchema, expectedOutputDriver, runEvalSet } from "@forerunner/evals";
import { join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALIBRATION_THRESHOLDS,
  type CalibrationTaskRow,
  calibrate,
  calibrationRates,
  evidenceFor,
  formatCalibrationReport,
  renderFilesAsDiff,
} from "../src/calibration.ts";
import { closingReply, submitReply, world } from "./helpers.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(os.tmpdir(), "fr-critic-cal-test-"));
  temps.push(d);
  return d;
};

/** A tiny eval task: write out.txt saying done; the seeded variant says nope (fails the check). */
function evalTask(
  n: number,
  over: Partial<Parameters<typeof EvalTaskSchema.parse>[0]> = {},
): EvalTask {
  return EvalTaskSchema.parse({
    id: `coder-${String(n).padStart(3, "0")}`,
    specialist: "coder",
    title: `Task ${n}: write done`,
    brief: {
      goal: "Write out.txt containing the word done",
      contextLinks: ["in.txt"],
      constraints: ["none stated"],
      acceptanceCriteria: ["out.txt contains done"],
      budgetUsdMicro: 1000,
      riskTier: 1,
    },
    setup: { files: { "in.txt": "input\n" } },
    checks: [{ kind: "file_contains", path: "out.txt", text: "done" }],
    expected_files: { "out.txt": "done\n" },
    expected_final_text: "Wrote out.txt with done.",
    seeded_defect: {
      description: "writes the wrong word",
      how_to_detect: "out.txt says nope",
      files: { "out.txt": "nope\n" },
    },
    ...over,
  });
}

const row = (
  clean: "accept" | "revise",
  seeded: "accept" | "revise" | null,
  id = "t",
): CalibrationTaskRow => {
  const v = (verdict: "accept" | "revise") => ({
    verdict,
    grade: 80,
    confidence: 0.9,
    outcome: "completed" as const,
    findings: 0,
    costUsdMicro: 1,
    durationMs: 1,
    mechanical: "pass" as const,
    summary: "",
  });
  return {
    taskId: id,
    title: id,
    specialist: "coder",
    clean: v(clean),
    seeded: seeded ? v(seeded) : null,
    cleanPassed: clean === "accept",
    defectCaught: seeded ? seeded !== "accept" : null,
  };
};

describe("calibration against the eval set (H.7, phase 3 gate)", () => {
  it("computes catch rate over seeded variants, pass rate over clean ones, and the 0.8 / 0.9 gate", () => {
    const r = calibrationRates([
      row("accept", "revise"),
      row("accept", "revise"),
      row("revise", "accept"),
      row("accept", null),
    ]);
    expect(r.counts).toEqual({
      tasks: 4,
      cleanReviewed: 4,
      cleanAccepted: 3,
      seededReviewed: 3,
      defectsCaught: 2,
    });
    expect(r.catchRate).toBeCloseTo(2 / 3);
    expect(r.passRate).toBe(0.75);
    expect(r.gate).toEqual({ catchOk: false, passOk: false, ok: false });
    expect(CALIBRATION_THRESHOLDS).toEqual({ catchRate: 0.8, passRate: 0.9 });
    const ok = calibrationRates(
      Array.from({ length: 10 }, (_, i) => row("accept", i < 8 ? "revise" : "accept", `t${i}`)),
    );
    expect(ok.catchRate).toBe(0.8);
    expect(ok.gate).toEqual({ catchOk: true, passOk: true, ok: true });
    expect(calibrationRates([]).gate.ok).toBe(false);
  });

  it("reviews every task's clean output and seeded defect through the critic, writes the report and evaluates the gate", async () => {
    // The model accepts everything; mechanical checks catch three defects, the fourth only
    // changes the final text and goes through, so the catch rate lands under the gate.
    const w = await world({
      replies: [
        submitReply(
          { grade: 91 },
          { when: { lastUserIncludes: "# Review request" }, times: Number.POSITIVE_INFINITY },
        ),
        closingReply(),
      ],
    });
    const outDir = tempDir();
    try {
      const tasks = [
        evalTask(1),
        evalTask(2),
        evalTask(3),
        evalTask(4, {
          seeded_defect: {
            description: "claims a test ran that did not",
            how_to_detect: "final text",
            final_text: "Wrote out.txt and ran the full suite.",
          },
        }),
      ];
      const seen: string[] = [];
      const report = await calibrate({
        evalSet: tasks,
        tier: 1,
        critic: w.critic,
        ctx: w.ctx(),
        evals: { runEvalSet, expectedOutputDriver },
        clock: w.clock,
        outDir,
        onTask: (r) => seen.push(r.taskId),
      });
      expect(seen).toEqual(tasks.map((t) => t.id));
      expect(report.counts).toEqual({
        tasks: 4,
        cleanReviewed: 4,
        cleanAccepted: 4,
        seededReviewed: 4,
        defectsCaught: 3,
      });
      expect(report.catchRate).toBe(0.75);
      expect(report.passRate).toBe(1);
      expect(report.gate).toEqual({ catchOk: false, passOk: true, ok: false });
      expect(report.tier).toBe(1);
      expect(report.model).toBe("fake-sonnet");
      expect(report.promptVersion).toMatch(/^critic@/);
      expect(report.cost.reviews).toBe(8);
      expect(report.cost.usdMicro).toBeGreaterThan(0);
      expect(report.date).toBe("2026-10-20");
      const caught = report.tasks.filter((t) => t.defectCaught);
      expect(caught.map((t) => t.taskId)).toEqual(["coder-001", "coder-002", "coder-003"]);
      expect(caught[0]?.seeded).toMatchObject({ verdict: "revise", mechanical: "fail" });
      expect(report.tasks[3]).toMatchObject({
        defectCaught: false,
        seeded: { verdict: "accept", mechanical: "pass" },
      });
      // Report on disk under <outDir>/calibration-<date>.json, and nothing persisted in the store.
      expect(report.file).toBe(join(outDir, "calibration-2026-10-20.json"));
      expect(existsSync(report.file as string)).toBe(true);
      const parsed = JSON.parse(readFileSync(report.file as string, "utf8")) as typeof report;
      expect(parsed.catchRate).toBe(0.75);
      expect(parsed.tasks).toHaveLength(4);
      expect(await w.store.review.count()).toBe(0);
      expect(await w.store.finding.count()).toBe(0);
      // A second run the same day does not overwrite the first.
      const again = await calibrate({
        evalSet: [tasks[0] as EvalTask],
        tier: 1,
        critic: w.critic,
        ctx: w.ctx(),
        evals: { runEvalSet, expectedOutputDriver },
        clock: w.clock,
        outDir,
      });
      expect(again.file).not.toBe(report.file);
      expect(
        readdirSync(outDir).filter((f) => f.startsWith("calibration-2026-10-20")),
      ).toHaveLength(2);
      expect(formatCalibrationReport(report)).toContain("defects caught 3/4 (75%, gate 80% FAIL)");
      expect(formatCalibrationReport(report)).toContain("clean accepted 4/4 (100%, gate 90% ok)");
    } finally {
      await w.close();
    }
  });

  it("passes the gate when the critic catches every seeded defect, and loads the eval runner itself", async () => {
    const w = await world({
      replies: [
        submitReply(
          { grade: 90 },
          { when: { lastUserIncludes: "# Review request" }, times: Number.POSITIVE_INFINITY },
        ),
        closingReply(),
      ],
    });
    try {
      const report = await calibrate({
        evalSet: [evalTask(1), evalTask(2)],
        tier: 2,
        critic: w.critic,
        ctx: w.ctx(),
        clock: w.clock,
        write: false,
      });
      expect(report.file).toBeNull();
      expect(report.gate).toEqual({ catchOk: true, passOk: true, ok: true });
      expect(report.model).toBe("fake-opus");
      // The critic saw the actual file content and the check result, never a transcript.
      const user = w.provider.calls[0]?.request.messages[0]?.content as string;
      expect(user).toContain("+++ b/out.txt");
      expect(user).toContain("+done");
      expect(user).toContain("Check results");
      expect(user).toContain("Wrote out.txt with done.");
    } finally {
      await w.close();
    }
  });

  it("renders the evidence for a variant from the eval result and the files on disk", () => {
    const dir = tempDir();
    const task = evalTask(7);
    const written = join(dir, "out.txt");
    writeFileSync(written, "nope\n");
    const ev = evidenceFor(
      task,
      "seeded_defect",
      {
        taskId: task.id,
        title: task.title,
        variant: "seeded_defect",
        status: "fail",
        checks: [
          {
            kind: "file_contains",
            label: "out.txt contains done",
            status: "fail",
            evidence: 'out.txt: "done" not found',
            durationMs: 1,
          },
        ],
        evidence: ["[fail] out.txt contains done"],
        finalText: "done!",
        costUsdMicro: 0,
        durationMs: 0,
      },
      dir,
    );
    expect(ev.changedFiles).toEqual(["out.txt"]);
    expect(ev.checkResults).toEqual([
      {
        name: "out.txt contains done",
        passed: false,
        output: 'out.txt: "done" not found',
        required: true,
      },
    ]);
    expect(ev.acceptanceCriteria).toEqual(["out.txt contains done"]);
    expect(ev.diff).toBe("--- /dev/null\n+++ b/out.txt\n@@ -0,0 +1,1 @@\n+nope");
    expect(ev.brief).toContain("# Task brief");
    expect(renderFilesAsDiff(dir, ["missing.txt"])).toBe("");
  });
});
