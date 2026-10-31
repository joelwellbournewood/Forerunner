/**
 * Phase 3 gate harness (spec, build order): "On the eval set, critic catches at least 80% of
 * seeded defects and passes at least 90% of clean work. Escalation never exceeds the ceiling."
 *
 * Runs on the fake provider with no network: `calibrate()` over the real coder and researcher
 * eval sets (20 tasks each) with a scripted critic that judges from the evidence it is given
 * (a seeded defect's marker line in the diff means findings and `revise`, a clean diff means
 * `accept`), so the harness proves the plumbing end to end: the eval runner's files reach the
 * critic as a diff with the check results, the verdict rules in code apply, the report is
 * written with catchRate and passRate and the 0.8 / 0.9 gate is evaluated. The live-model run
 * of the same command is what turns the gate row into "passed"; this harness turns it into
 * "harness passed on the fake provider". The world runs on the simulated clock, the report is
 * evidence of a real run: its date, startedAt and file name come from the system clock.
 *
 * The second part runs a session on the fake provider in which the critic keeps sending the
 * work back: the task climbs the retry ladder and stops at the project ceiling with a blocking
 * human request, never above it, with every review and finding persisted.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import {
  CALIBRATION_THRESHOLDS,
  type CalibrationReport,
  calibrate,
  formatCalibrationReport,
} from "@forerunner/critic";
import { type EvalTask, expectedOutputDriver, loadEvalSet, runEvalSet } from "@forerunner/evals";
import { join, systemClock } from "@forerunner/platform";
import {
  AnthropicMessagesProvider,
  DEFAULT_LADDER,
  type ModelTier,
  pricingFor,
  resolveRegistryDir,
  tierOfModel,
} from "@forerunner/runtime";
import type { TaskRow } from "@forerunner/state";
import { afterAll, describe, expect, it } from "vitest";
import { evalCriticScript, evidenceShowsDefect } from "../src/eval-defects.ts";
import { CODER_FAMILIES, familyScript } from "../src/four-weeks.ts";
import { type GateWorld, gateWorld } from "../src/world.ts";

const REGISTRY = resolveRegistryDir().dir;
const temps: string[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const tierRank = (tier: ModelTier | null): number =>
  DEFAULT_LADDER.findIndex((r) => r.tier === tier);

describe("phase 3 gate: critic calibration on the eval sets (fake provider)", () => {
  it("calibrate() over the coder and researcher sets: every seeded defect caught from the diff, every clean result accepted, the 0.8 / 0.9 gate evaluated and the report written", async () => {
    const coder = loadEvalSet(join(REGISTRY, "evals", "coder"));
    const researcher = loadEvalSet(join(REGISTRY, "evals", "researcher"));
    expect(coder).toHaveLength(20);
    expect(researcher).toHaveLength(20);
    const tasks: EvalTask[] = [...coder, ...researcher];
    const script = evalCriticScript(tasks);
    // Every seeded defect adds a distinctive line, so the scripted critic judges the diff,
    // not the check results; a task without one would fall back to a failed check.
    expect(script.withoutMarker).toEqual([]);
    expect(script.markers).toHaveLength(40);
    expect(new Set(script.markers.map((m) => m.marker)).size).toBe(40);
    expect(script.markers.filter((m) => m.kind === "added").length).toBeGreaterThanOrEqual(38);

    const w = await gateWorld({ replies: script.replies, memory: false });
    const outDir =
      process.env.FORERUNNER_E2E_REPORT_DIR ?? mkdtempSync(join(os.tmpdir(), "fr-phase3-"));
    if (!process.env.FORERUNNER_E2E_REPORT_DIR) temps.push(outDir);
    let report: CalibrationReport;
    try {
      const project = await w.addProject({
        name: "Calibration",
        goal: "Critic calibration against the golden eval sets",
        members: [w.alice],
      });
      const ctx = await w.reviewContext(project);
      const seen: string[] = [];
      const runDates = [systemClock.nowIso().slice(0, 10)];
      report = await calibrate({
        evalSet: tasks,
        tier: 1,
        critic: w.critic.service,
        ctx,
        evals: { runEvalSet, expectedOutputDriver },
        clock: systemClock,
        outDir,
        onTask: (row) => seen.push(row.taskId),
      });
      runDates.push(systemClock.nowIso().slice(0, 10));
      console.log(formatCalibrationReport(report));
      if (process.env.FORERUNNER_E2E_REPORT_DIR)
        writeFileSync(
          join(outDir, "phase3-calibration.txt"),
          `${formatCalibrationReport(report)}\n`,
          "utf8",
        );
      expect(seen).toEqual(tasks.map((t) => t.id));

      // The gate arithmetic on the real sets: 40 clean reviews, 40 seeded reviews.
      expect(report.thresholds).toEqual(CALIBRATION_THRESHOLDS);
      expect(report.counts).toEqual({
        tasks: 40,
        cleanReviewed: 40,
        cleanAccepted: 40,
        seededReviewed: 40,
        defectsCaught: 40,
      });
      expect(report.catchRate).toBeGreaterThanOrEqual(CALIBRATION_THRESHOLDS.catchRate);
      expect(report.passRate).toBeGreaterThanOrEqual(CALIBRATION_THRESHOLDS.passRate);
      expect(report.gate).toEqual({ catchOk: true, passOk: true, ok: true });
      expect(report.tier).toBe(1);
      expect(report.model).toBe("fake-sonnet");
      expect(report.promptVersion).toMatch(/^critic@/);
      expect(report.cost.reviews).toBe(80);
      expect(report.cost.usdMicro).toBeGreaterThan(0);
      // The report is dated by the real run, not by the simulated clock the world runs on.
      expect(runDates, `report date ${report.date}`).toContain(report.date);
      expect(report.startedAt.slice(0, 10)).toBe(report.date);
      expect(report.cost.durationMs).toBeGreaterThan(0);
      // Per task: the clean variant accepted with no finding, the seeded one sent back with
      // the finding the critic wrote from the diff (the rules in code keep both as they are).
      for (const row of report.tasks) {
        expect(row.clean.verdict, `${row.taskId} clean`).toBe("accept");
        expect(row.clean.findings, `${row.taskId} clean findings`).toBe(0);
        expect(row.clean.outcome).toBe("completed");
        expect(row.seeded?.verdict, `${row.taskId} seeded`).toBe("revise");
        expect(row.seeded?.findings ?? 0, `${row.taskId} seeded findings`).toBeGreaterThanOrEqual(
          1,
        );
        expect(row.defectCaught).toBe(true);
        expect(row.cleanPassed).toBe(true);
      }
      // Coder defects also fail a mechanical check; researcher defects are in the content.
      expect(
        report.tasks
          .filter((t) => t.specialist === "coder")
          .every((t) => t.seeded?.mechanical === "fail"),
      ).toBe(true);
      expect(
        report.tasks
          .filter((t) => t.specialist === "researcher")
          .every((t) => t.clean.mechanical === "needs_model"),
      ).toBe(true);

      // The evidence the critic read: the brief, the criteria, the files as a diff, the check
      // results and the worker's final text, never a transcript. One seeded review per task
      // carried that task's marker line.
      const criticCalls = w.provider.calls.filter((c) =>
        c.request.tools?.some((t) => t.name === "submit_review"),
      );
      expect(criticCalls.length).toBeGreaterThanOrEqual(80);
      const firstTurns = criticCalls.filter((c) => c.request.messages.length === 1);
      expect(firstTurns).toHaveLength(80);
      for (const m of script.markers) {
        const hits = firstTurns.filter((c) =>
          evidenceShowsDefect(String(c.request.messages[0]?.content), m),
        );
        expect(hits, `marker of ${m.taskId} seen once`).toHaveLength(1);
        const text = String(hits[0]?.request.messages[0]?.content);
        expect(text).toContain("# Review request");
        expect(text).toContain(`Subject: task ${m.taskId}`);
        expect(text).toContain(`+++ b/${m.file}`);
        expect(text).toContain("## Acceptance criteria");
      }
      // Calibration never persists: the store has no review, finding or run from it.
      expect(await w.store.review.count()).toBe(0);
      expect(await w.store.finding.count()).toBe(0);
      // The report on disk, with the gate, for docs/status/gates.md.
      expect(report.file).not.toBeNull();
      expect(report.file).toContain(`calibration-${report.date}`);
      expect(existsSync(report.file as string)).toBe(true);
      const parsed = JSON.parse(readFileSync(report.file as string, "utf8")) as CalibrationReport;
      expect(parsed.gate.ok).toBe(true);
      expect(parsed.tasks).toHaveLength(40);
      expect(parsed.catchRate).toBe(report.catchRate);
    } finally {
      await w.close();
    }
  }, 600_000);
});

describe("phase 3 gate: escalation never exceeds the ceiling (fake provider)", () => {
  /** Sessions until the task leaves the ladder, with the decisions the critic took. */
  async function climb(
    w: GateWorld,
    projectId: string,
    task: TaskRow,
    maxSessions = 6,
  ): Promise<{ decisions: string[]; sessions: number }> {
    const decisions: string[] = [];
    for (let i = 0; i < maxSessions; i++) {
      await w.clock.advance(3_600_000);
      const result = await w.startSession({ agentId: w.alice, projectId });
      const review = result.reviews.find((r) => r.taskId === task.id);
      if (!review) break;
      decisions.push(review.retry ? `${review.decision}:${review.retry}` : review.decision);
      if ((await w.store.task.mustGet(task.id)).status !== "ready") break;
    }
    return { decisions, sessions: decisions.length };
  }

  async function runsOf(w: GateWorld, taskId: string) {
    const runs = await w.store.run.list({ task_id: taskId }, { limit: 1000 });
    return runs.map((r) => ({
      specialist: r.specialist,
      model: r.model,
      tier: tierOfModel(r.model),
      outcome: r.outcome,
    }));
  }

  it("at a ceiling of sonnet: improve brief, split or change specialist, then the human; no run above sonnet; reviews and findings persisted", async () => {
    const family = CODER_FAMILIES[0];
    if (!family) throw new Error("no family");
    const w = await gateWorld({ replies: familyScript([family], { alwaysDefective: true }) });
    try {
      const project = await w.addProject({
        name: "Ceiling sonnet",
        goal: "A task the critic keeps sending back",
        members: [w.alice],
        settings: { critic_ceiling: "sonnet" },
      });
      const task = await w.addTask(project, {
        title: family.title,
        outcome: family.outcome,
        acceptanceCriteria: [family.criterion],
        specialist: "coder",
      });
      const { decisions } = await climb(w, project, task);
      expect(decisions).toEqual([
        "revise:improve_brief",
        "revise:split_or_change_specialist",
        "human",
      ]);
      const after = await w.store.task.mustGet(task.id);
      expect(after.status).toBe("needs_human");
      expect(after.attempt).toBe(3);
      const requests = (await w.store.humanRequest.open({ humanId: w.human })).filter(
        (r) => r.task_id === task.id && r.blocking,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.why).toContain("ceiling sonnet");
      // Every run of the task (specialist and critic) stayed at or under the ceiling.
      const runs = await runsOf(w, task.id);
      // Rung 2 (U-044): after two coder attempts the third goes to another specialist, never
      // the coder again. Which one depends on the specialists' tools; this world gives every
      // specialist the same file tools, so the shipped registry's choice (the
      // migration-specialist) is checked in specialist-handover.test.ts instead.
      const workerRuns = runs.filter((r) => r.specialist !== "critic");
      expect(workerRuns.map((r) => r.specialist).slice(0, 2)).toEqual(["coder", "coder"]);
      expect(workerRuns).toHaveLength(3);
      expect(workerRuns[2]?.specialist).not.toBe("coder");
      expect(runs.filter((r) => r.specialist === "critic")).toHaveLength(3);
      for (const r of runs)
        expect(tierRank(r.tier), r.model).toBeLessThanOrEqual(tierRank("sonnet"));
      expect(runs.some((r) => r.model === "fake-opus" || r.model === "fake-fable")).toBe(false);
      const verdicts = w.events.filter((e) => e.type === "critic.verdict").map((e) => e.payload);
      expect(verdicts.some((v) => v.nextTier === "opus")).toBe(false);
      // The only "escalation" the live view highlights is the hand-over to the human.
      expect(verdicts.filter((v) => v.escalation === true).map((v) => v.decision)).toEqual([
        "human",
      ]);
      // Persisted: one review per attempt, one finding each with the same fingerprint, and
      // the repeat is a pattern the critic turned into critic memory (H.5).
      const reviews = await w.store.review.forTask(task.id);
      expect(reviews).toHaveLength(3);
      expect(reviews.every((r) => r.verdict === "revise" && r.critic_model === "fake-sonnet")).toBe(
        true,
      );
      const findings = (await w.store.finding.list({ task_id: task.id })).filter(
        (f) => f.description === family.finding,
      );
      expect(findings).toHaveLength(3);
      expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(1);
      const patterns = await w.store.finding.repeated(3);
      expect(patterns.map((p) => p.fingerprint)).toContain(findings[0]?.fingerprint);
      const critic = await w.store.lesson.list({ scope: "critic" });
      expect(critic.length).toBeGreaterThanOrEqual(1);
      expect(critic[0]?.text).toContain("Repeated critic finding");
      // The hooks logged every tool call and denied nothing.
      const audit = await w.store.auditLog.list(undefined, { limit: 10_000 });
      expect(audit.length).toBeGreaterThanOrEqual(6);
      expect(audit.filter((a) => !a.allowed)).toHaveLength(0);
    } finally {
      await w.close();
    }
  }, 300_000);

  it("at a ceiling of opus: the third failure escalates one rung to opus, the fourth goes to the human; never fable", async () => {
    const family = CODER_FAMILIES[1];
    if (!family) throw new Error("no family");
    const w = await gateWorld({ replies: familyScript([family], { alwaysDefective: true }) });
    try {
      const project = await w.addProject({
        name: "Ceiling opus",
        goal: "A task the critic keeps sending back",
        members: [w.alice],
        settings: { critic_ceiling: "opus" },
      });
      const task = await w.addTask(project, {
        title: family.title,
        outcome: family.outcome,
        acceptanceCriteria: [family.criterion],
        specialist: "coder",
      });
      const { decisions } = await climb(w, project, task);
      expect(decisions).toEqual([
        "revise:improve_brief",
        "revise:split_or_change_specialist",
        "revise:escalate",
        "human",
      ]);
      expect((await w.store.task.mustGet(task.id)).status).toBe("needs_human");
      const verdicts = w.events.filter((e) => e.type === "critic.verdict").map((e) => e.payload);
      expect(verdicts[2]).toMatchObject({ retry: "escalate", nextTier: "opus" });
      const runs = await runsOf(w, task.id);
      // Rung 2 hands the task to a stand-in specialist (U-044); rung 3 escalates its model.
      const workerRuns = runs.filter((r) => r.specialist !== "critic");
      expect(workerRuns.map((r) => r.specialist).slice(0, 2)).toEqual(["coder", "coder"]);
      const standIn = workerRuns[2]?.specialist;
      expect(standIn).not.toBe("coder");
      expect(workerRuns[3]?.specialist).toBe(standIn);
      expect(workerRuns.map((r) => r.model)).toEqual([
        "fake-sonnet",
        "fake-sonnet",
        "fake-sonnet",
        "fake-opus",
      ]);
      for (const r of runs) expect(tierRank(r.tier), r.model).toBeLessThanOrEqual(tierRank("opus"));
      expect(runs.some((r) => r.model === "fake-fable")).toBe(false);
      expect(await w.store.review.forTask(task.id)).toHaveLength(4);
      expect(
        (await w.store.humanRequest.open({ humanId: w.human })).filter(
          (r) => r.task_id === task.id && r.blocking,
        ),
      ).toHaveLength(1);
    } finally {
      await w.close();
    }
  }, 300_000);
});

/**
 * The live-model run of the same command, opt-in: `FORERUNNER_E2E_LIVE=1` with the key in
 * `FORERUNNER_ANTHROPIC_KEY` (or `ANTHROPIC_API_KEY`) and the workspace in
 * `FORERUNNER_ANTHROPIC_WORKSPACE_ID`. The critic runs on the real provider at tier 1 (Sonnet,
 * the production pick); the spend is capped in code by the session budget
 * (`FORERUNNER_E2E_CALIBRATION_BUDGET_USD`, default 10): the hooks refuse a call past it. The
 * report goes to `FORERUNNER_E2E_REPORT_DIR`; the result and the cost belong in gates.md and
 * COST.md. Without the opt-in the test is skipped, visibly.
 */
const LIVE = process.env.FORERUNNER_E2E_LIVE === "1";
const LIVE_KEY = process.env.FORERUNNER_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;

describe("phase 3 gate: critic calibration on the eval sets (live model, opt-in)", () => {
  it.skipIf(!LIVE || !LIVE_KEY)(
    "FORERUNNER_E2E_LIVE=1: calibrate() over both sets on the real critic at tier 1, under the cap",
    async () => {
      const tasks: EvalTask[] = [
        ...loadEvalSet(join(REGISTRY, "evals", "coder")),
        ...loadEvalSet(join(REGISTRY, "evals", "researcher")),
      ];
      const capUsd = Number(process.env.FORERUNNER_E2E_CALIBRATION_BUDGET_USD ?? "10");
      expect(Number.isFinite(capUsd) && capUsd > 0).toBe(true);
      const workspace = process.env.FORERUNNER_ANTHROPIC_WORKSPACE_ID;
      const provider = new AnthropicMessagesProvider({
        apiKey: LIVE_KEY as string,
        clock: systemClock,
        ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}),
      });
      const w = await gateWorld({
        replies: [],
        memory: false,
        critic: { provider, pricing: pricingFor },
      });
      const outDir =
        process.env.FORERUNNER_E2E_REPORT_DIR ?? mkdtempSync(join(os.tmpdir(), "fr-phase3-live-"));
      try {
        const project = await w.addProject({
          name: "Calibration (live)",
          goal: "Critic calibration against the golden eval sets on the live model",
          members: [w.alice],
        });
        const ctx = await w.reviewContext(project, Math.round(capUsd * 1_000_000));
        const report = await calibrate({
          evalSet: tasks,
          tier: 1,
          critic: w.critic.service,
          ctx,
          evals: { runEvalSet, expectedOutputDriver },
          clock: systemClock,
          outDir,
          onTask: (row) =>
            console.log(
              `${row.taskId}: clean ${row.clean.verdict} ${row.clean.grade}, seeded ${row.seeded?.verdict ?? "-"} ${row.seeded?.grade ?? "-"} ${row.defectCaught ? "caught" : "MISSED"}`,
            ),
        });
        const text = formatCalibrationReport(report);
        console.log(text);
        writeFileSync(join(outDir, "phase3-calibration-live.txt"), `${text}\n`, "utf8");
        console.log(
          `live calibration cost: USD ${(report.cost.usdMicro / 1_000_000).toFixed(4)} over ${report.cost.reviews} reviews; report ${report.file}`,
        );
        expect(report.cost.usdMicro).toBeLessThanOrEqual(capUsd * 1_000_000);
        expect(report.counts.seededReviewed).toBe(40);
        expect(report.counts.cleanReviewed).toBe(40);
        // The gate itself.
        expect(report.catchRate).toBeGreaterThanOrEqual(CALIBRATION_THRESHOLDS.catchRate);
        expect(report.passRate).toBeGreaterThanOrEqual(CALIBRATION_THRESHOLDS.passRate);
        expect(report.gate.ok).toBe(true);
      } finally {
        await w.close();
      }
    },
    1_800_000,
  );
});
