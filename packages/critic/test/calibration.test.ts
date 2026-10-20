import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { type EvalTask, EvalTaskSchema, expectedOutputDriver, runEvalSet } from "@forerunner/evals";
import { basename, join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALIBRATION_THRESHOLDS,
  type CalibrationTaskRow,
  calibrate,
  calibrationRates,
  evidenceFor,
  formatCalibrationReport,
  renderFilesAsDiff,
  WORK_DIR_PLACEHOLDER,
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
          {
            kind: "command_exit0",
            label: "node test exits 0",
            status: "fail",
            evidence: "node test -> exit 1 in 3 ms",
            detail: `not ok 1\n  at ${join(dir, "test.ts")}:1 (${basename(dir)})`,
            durationMs: 3,
          },
        ],
        evidence: [
          "[fail] out.txt contains done",
          "expected-output driver (seeded_defect) wrote 1 file(s)",
        ],
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
      {
        name: "node test exits 0",
        passed: false,
        // The work directory, whose name carries the variant, never reaches the critic.
        output: `node test -> exit 1 in 3 ms\nnot ok 1\n  at ${join(WORK_DIR_PLACEHOLDER, "test.ts")}:1 (${WORK_DIR_PLACEHOLDER})`,
        required: true,
      },
    ]);
    expect(ev.acceptanceCriteria).toEqual(["out.txt contains done"]);
    expect(ev.diff).toBe("--- /dev/null\n+++ b/out.txt\n@@ -0,0 +1,1 @@\n+nope");
    expect(ev.brief).toContain("# Task brief");
    // The fixtures the worker was given, in full; the driver's notes (which name the variant) dropped.
    expect(ev.inputFiles).toEqual([{ path: "in.txt", content: "input\n" }]);
    expect(ev.artifacts).toBeUndefined();
    expect(ev.testOutput).toBeUndefined();
    expect(JSON.stringify(ev)).not.toContain("seeded_defect");
    expect(renderFilesAsDiff(dir, ["missing.txt"])).toBe("");
  });

  describe("the escalate default on the eval set (ADR 0042)", () => {
    /**
     * A critic that answers like the live tier 1 model did: clean work gets `escalate` at
     * medium confidence with no finding and no ground ("I did not run the tests myself"), a
     * failed check gets the verdict in the row with a major finding.
     */
    const cases: { name: string; seededVerdict: "revise" | "escalate" }[] = [
      { name: "seeded defect answered revise with a major finding", seededVerdict: "revise" },
      { name: "seeded defect answered escalate with a major finding", seededVerdict: "escalate" },
    ];
    for (const c of cases) {
      it(`${c.name}: the clean escalate-without-ground becomes accept, the defect is still caught`, async () => {
        const w = await world({
          replies: [
            submitReply(
              {
                grade: 20,
                confidence: "high",
                verdict: c.seededVerdict,
                summary: "The check failed.",
                findings: [
                  { severity: "major", what: "out.txt does not say done", where: "out.txt" },
                ],
              },
              { when: { lastUserIncludes: "[FAIL]" }, times: Number.POSITIVE_INFINITY },
            ),
            submitReply(
              {
                grade: 86,
                confidence: "medium",
                verdict: "escalate",
                summary: "Correct by reading; I could not run the check myself.",
              },
              { when: { lastUserIncludes: "# Review request" }, times: Number.POSITIVE_INFINITY },
            ),
            closingReply(),
          ],
        });
        try {
          const tasks = [evalTask(1), evalTask(2)];
          const report = await calibrate({
            evalSet: tasks,
            tier: 1,
            critic: w.critic,
            ctx: w.ctx(),
            evals: { runEvalSet, expectedOutputDriver },
            clock: w.clock,
            write: false,
          });
          expect(report.counts).toEqual({
            tasks: 2,
            cleanReviewed: 2,
            cleanAccepted: 2,
            seededReviewed: 2,
            defectsCaught: 2,
          });
          expect(report.gate).toEqual({ catchOk: true, passOk: true, ok: true });
          for (const row of report.tasks) {
            expect(row.clean).toMatchObject({ verdict: "accept", grade: 86, findings: 0 });
            expect(row.clean.confidence).toBeGreaterThanOrEqual(0.6);
            // The model's major finding plus the high finding the code adds for the failed check.
            expect(row.seeded).toMatchObject({ verdict: c.seededVerdict, findings: 2 });
          }
          // What the critic read: the brief, the fixture, the files as a diff, the verified
          // checks, the closing "nothing missing" section; never the variant or the work dir.
          const users = w.provider.calls
            .filter((call) => call.request.messages.length === 1)
            .map((call) => String(call.request.messages[0]?.content));
          expect(users).toHaveLength(4);
          for (const user of users) {
            expect(user).toContain(
              "## Input files given to the worker (data)\n### in.txt\n```text\ninput\n```",
            );
            expect(user).toContain("## Check results (run by the runtime: verified)");
            expect(user).toContain("a pass is verified evidence, not a claim of the worker");
            expect(user).toContain("+++ b/out.txt");
            expect(user).toContain(
              "## Evidence not available\n(nothing: every section above is complete.",
            );
            expect(user).not.toContain("seeded_defect");
            expect(user).not.toContain("expected-output driver");
            expect(user).not.toMatch(/coder-00\d-clean-\d/);
          }
          expect(users.filter((u) => u.includes("[FAIL]"))).toHaveLength(2);
          expect(users.filter((u) => u.includes("[pass]"))).toHaveLength(2);
          expect(await w.store.review.count()).toBe(0);
        } finally {
          await w.close();
        }
      });
    }
  });
});
