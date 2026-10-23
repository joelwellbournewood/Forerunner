/**
 * The monthly critic calibration job (spec H.7 "the critic grades the golden eval set monthly
 * so drift is visible"; ADR 0060): `calibrate()` over the registry's eval sets through the
 * composed critic under a budget the hooks enforce, the report under the data directory with
 * the date, a notification naming the catch rate, the pass rate and the drift against the
 * previous report, once per month unless forced, and a failure reported rather than hidden.
 * Fake provider, in-memory store, simulated clock.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import {
  type EvalTask,
  EvalTaskSchema,
  expectedOutputDriver,
  runEvalSet,
} from "../../../evals/src/index.ts";
import {
  CALIBRATION_AGENT_ID,
  CALIBRATION_AUDIT_TOOL,
  CALIBRATION_SCHEDULE_ID,
  type CalibrationEvalsPort,
  CalibrationJob,
  calibrationSettingsOf,
  DEFAULT_CALIBRATION_SETTINGS,
  isCalibrationRequest,
  scheduleCalibration,
} from "../src/jobs/calibration.ts";
import type { Notification, NotificationRecord } from "../src/notifications/types.ts";
import { loadRegistry } from "../src/registry/index.ts";
import { Scheduler } from "../src/session/triggers.ts";
import { closingReply, loopWorld, submitReply } from "./loop-helpers.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(os.tmpdir(), "fr-cal-job-"));
  temps.push(d);
  return d;
};

const REGISTRY = loadRegistry(join(process.cwd(), "evals", "registry"));

/** A tiny eval task: write out.txt saying done; the seeded variant says nope (fails the check). */
function evalTask(n: number, over: Record<string, unknown> = {}): EvalTask {
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

/** Three defects the mechanical check catches, one that only changes the final text. */
const FIRST_SET = [
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
const SECOND_SET = [evalTask(1), evalTask(2)];

class FakeNotifier {
  readonly sent: Notification[] = [];
  async notify(n: Notification): Promise<NotificationRecord> {
    this.sent.push(n);
    return {
      id: `n-${this.sent.length}`,
      notification: n,
      urgency: "normal",
      outcome: "delivered",
      heldFor: null,
      deliveries: [],
      createdAt: "2026-10-20T09:00:00.000Z",
      resolvedAt: null,
    };
  }
}

describe("monthly critic calibration job (H.7)", () => {
  it("runs calibrate() over the registry's eval sets, writes the dated report, notifies with the rates and the drift, and runs once per month", async () => {
    // The scripted critic accepts everything it reads; the mechanical checks catch three of
    // the four seeded defects, so the first report lands under the catch gate.
    const w = await loopWorld({
      replies: [
        submitReply(
          { grade: 91 },
          { when: { lastUserIncludes: "# Review request" }, times: Number.POSITIVE_INFINITY },
        ),
        closingReply(),
      ],
    });
    const outDir = tempDir();
    const notifier = new FakeNotifier();
    let evalSet: EvalTask[] = FIRST_SET;
    const loaded: string[] = [];
    const evals: CalibrationEvalsPort = {
      runEvalSet,
      expectedOutputDriver,
      loadEvalSet: (dir) => {
        loaded.push(dir);
        return dir.endsWith("coder") ? evalSet : [];
      },
    };
    try {
      const job = new CalibrationJob({
        store: w.store,
        clock: w.clock,
        tokens: w.tokens,
        critic: w.critic.service,
        registry: REGISTRY,
        evals,
        outDir,
        notifier,
        humanId: w.human,
        agentId: w.alice,
        criticAgentId: w.criticAgent,
        settings: async () => ({
          ...DEFAULT_CALIBRATION_SETTINGS,
          budgetUsdMicro: 2_000_000,
          tier: 1,
          specialists: ["coder"],
        }),
      });

      // --- First run of the month ---------------------------------------------------------
      const first = await job.run();
      expect(first.status).toBe("ran");
      expect(first.monthKey).toBe("2026-10");
      expect(loaded).toEqual([REGISTRY.specialist("coder").evalSetDir]);
      const report = first.report;
      expect(report).not.toBeNull();
      expect(report?.counts).toEqual({
        tasks: 4,
        cleanReviewed: 4,
        cleanAccepted: 4,
        seededReviewed: 4,
        defectsCaught: 3,
      });
      expect(report?.catchRate).toBe(0.75);
      expect(report?.passRate).toBe(1);
      expect(report?.gate.ok).toBe(false);
      expect(report?.tier).toBe(1);
      expect(report?.model).toBe("fake-sonnet");
      expect(report?.date).toBe("2026-10-20");
      // The report is a dated file under the install's data directory.
      expect(report?.file).toBe(join(outDir, "calibration-2026-10-20.json"));
      expect(existsSync(report?.file as string)).toBe(true);
      expect(JSON.parse(readFileSync(report?.file as string, "utf8")).catchRate).toBe(0.75);
      // No earlier report: the drift names none.
      expect(first.previous).toBeNull();
      expect(first.drift).toEqual({ since: null, catchRatePoints: null, passRatePoints: null });
      // The notification names the catch rate, the pass rate and the gate.
      expect(notifier.sent).toHaveLength(1);
      const n1 = notifier.sent[0];
      expect(n1).toMatchObject({
        kind: "critic_calibration",
        humanId: w.human,
        link: `/sessions/${first.sessionId}`,
        dedupeKey: "calibration:2026-10-20",
      });
      expect(n1?.title).toContain("caught 75%");
      expect(n1?.title).toContain("accepted 100%");
      expect(n1?.title).toContain("gate not met");
      expect(n1?.body).toContain("3/4");
      expect(n1?.body).toContain("4/4");
      expect(n1?.body).toContain("no earlier report");
      expect(n1?.body).toContain("fake-sonnet");
      // The run has a session row (the budget the hooks enforced) and an audit row.
      const session = await w.store.session.mustGet(first.sessionId as string);
      expect(session).toMatchObject({
        agent_id: w.alice,
        trigger: "schedule",
        status: "completed",
        budget_cap_usd_micro: 2_000_000,
      });
      expect(session.spent_usd_micro).toBeGreaterThan(0);
      expect(session.spent_usd_micro).toBe(report?.cost.usdMicro);
      expect(session.summary).toContain("defects caught 3/4");
      const audit = await w.store.auditLog.list({ sessionId: first.sessionId as string });
      const row = audit.find((r) => r.tool === CALIBRATION_AUDIT_TOOL);
      expect(row).toMatchObject({ allowed: true, agent_id: w.criticAgent, human_id: w.human });
      expect(row?.input_summary).toContain('"specialists":["coder"]');
      expect(row?.result_summary).toContain('"defectsCaught":3');
      // Calibration never persists reviews or findings.
      expect(await w.store.review.count()).toBe(0);
      expect(await w.store.finding.count()).toBe(0);

      // --- The same month again: skipped unless forced ---------------------------------------
      await w.clock.advance(3 * 24 * 3_600_000);
      const again = await job.run();
      expect(again).toMatchObject({
        status: "skipped",
        reason: "already_ran",
        monthKey: "2026-10",
      });
      expect(again.previous?.date).toBe("2026-10-20");
      expect(notifier.sent).toHaveLength(1);
      expect(readdirSync(outDir).filter((f) => f.startsWith("calibration-"))).toHaveLength(1);
      const forced = await job.run({ force: true });
      expect(forced.status).toBe("ran");
      expect(forced.drift).toEqual({ since: "2026-10-20", catchRatePoints: 0, passRatePoints: 0 });
      expect(notifier.sent[1]?.body).toContain("unchanged since 2026-10-20");
      expect(readdirSync(outDir).filter((f) => f.startsWith("calibration-"))).toHaveLength(2);

      // --- Next month: the drift against the previous report is visible ----------------------
      await w.clock.set("2026-11-01T06:00:00Z");
      evalSet = SECOND_SET;
      const second = await job.run();
      expect(second.status).toBe("ran");
      expect(second.monthKey).toBe("2026-11");
      expect(second.report?.catchRate).toBe(1);
      expect(second.previous).toMatchObject({ date: "2026-10-23", catchRate: 0.75, passRate: 1 });
      expect(second.drift).toEqual({ since: "2026-10-23", catchRatePoints: 25, passRatePoints: 0 });
      const n3 = notifier.sent[2];
      expect(n3?.title).toContain("caught 100%");
      expect(n3?.title).not.toContain("gate not met");
      expect(n3?.body).toContain("catch rate +25 points");
      expect(n3?.body).toContain("pass rate unchanged since 2026-10-23");
      expect(second.report?.file).toBe(join(outDir, "calibration-2026-11-01.json"));
      // The job lists its reports newest first.
      const listed = job.reports();
      expect(listed.map((r) => r.date)).toEqual(["2026-11-01", "2026-10-23", "2026-10-20"]);
      expect(listed[0]).toMatchObject({ catchRate: 1, passRate: 1, gateOk: true });
    } finally {
      await w.close();
    }
  });

  it("once per LOCAL month, and the drift is measured against the newest run even on the same day", async () => {
    const w = await loopWorld({
      replies: [
        submitReply(
          { grade: 91 },
          { when: { lastUserIncludes: "# Review request" }, times: Number.POSITIVE_INFINITY },
        ),
        closingReply(),
      ],
    });
    const outDir = tempDir();
    let evalSet: EvalTask[] = SECOND_SET;
    try {
      const job = new CalibrationJob({
        store: w.store,
        clock: w.clock,
        tokens: w.tokens,
        critic: w.critic.service,
        registry: REGISTRY,
        evals: {
          runEvalSet,
          expectedOutputDriver,
          loadEvalSet: (dir) => (dir.endsWith("coder") ? evalSet : []),
        },
        outDir,
        humanId: w.human,
        agentId: w.alice,
        criticAgentId: w.criticAgent,
        timezone: async () => "America/Los_Angeles",
        settings: async () => ({
          ...DEFAULT_CALIBRATION_SETTINGS,
          budgetUsdMicro: 2_000_000,
          specialists: ["coder"],
        }),
      });
      // Day 30 at 20:00 in Los Angeles: February's run (clamped to the 28th) is 1 March UTC.
      await w.clock.set("2027-03-01T04:00:00Z");
      expect(await job.run()).toMatchObject({ status: "ran", monthKey: "2027-02" });
      // March's run, 30 March 20:00 PDT = 31 March 03:00 UTC, is not "already ran".
      await w.clock.set("2027-03-31T03:00:00Z");
      expect(await job.run()).toMatchObject({ status: "ran", monthKey: "2027-03" });
      await w.clock.set("2027-03-31T05:00:00Z");
      expect(await job.run()).toMatchObject({ status: "skipped", monthKey: "2027-03" });
      // A forced second run the same UTC day is the newest report: the next drift is against it.
      evalSet = FIRST_SET;
      await w.clock.set("2027-03-31T18:00:00Z");
      const forced = await job.run({ force: true });
      expect(forced.report?.catchRate).toBe(0.75);
      expect(job.reports().map((r) => r.startedAt)).toEqual([
        "2027-03-31T18:00:00.000Z",
        "2027-03-31T03:00:00.000Z",
        "2027-03-01T04:00:00.000Z",
      ]);
      evalSet = SECOND_SET;
      await w.clock.set("2027-04-30T03:00:00Z");
      const april = await job.run();
      expect(april.previous?.startedAt).toBe("2027-03-31T18:00:00.000Z");
      expect(april.drift).toMatchObject({ catchRatePoints: 25 });
    } finally {
      await w.close();
    }
  });

  it("a run the budget refuses is reported as failed, with the reason and no report", async () => {
    const w = await loopWorld({
      replies: [
        submitReply({}, { when: { lastUserIncludes: "# Review request" }, times: 10 }),
        closingReply(),
      ],
    });
    const outDir = tempDir();
    const notifier = new FakeNotifier();
    try {
      const job = new CalibrationJob({
        store: w.store,
        clock: w.clock,
        tokens: w.tokens,
        critic: w.critic.service,
        registry: REGISTRY,
        evals: {
          runEvalSet,
          expectedOutputDriver,
          loadEvalSet: (dir) => (dir.endsWith("coder") ? [evalTask(1)] : []),
        },
        outDir,
        notifier,
        humanId: w.human,
        agentId: w.alice,
        criticAgentId: w.criticAgent,
        // One micro-dollar: the hooks refuse the first model call before it is made.
        settings: async () => ({
          ...DEFAULT_CALIBRATION_SETTINGS,
          budgetUsdMicro: 1,
          specialists: ["coder"],
        }),
      });
      const r = await job.run();
      expect(r.status).toBe("failed");
      expect(r.reason).toMatch(
        /review_errors: 2 of 2 reviews did not complete \(budget_exceeded\)/,
      );
      expect(r.report).toBeNull();
      expect(readdirSync(outDir)).toEqual([]);
      expect(notifier.sent).toHaveLength(1);
      expect(notifier.sent[0]?.title).toMatch(/failed/);
      expect(notifier.sent[0]?.body).toMatch(/budget_exceeded/);
      const session = await w.store.session.mustGet(r.sessionId as string);
      expect(session.status).toBe("failed");
      const audit = await w.store.auditLog.list({ sessionId: r.sessionId as string });
      expect(audit.find((a) => a.tool === CALIBRATION_AUDIT_TOOL)).toMatchObject({
        allowed: false,
        denied_reason: expect.stringContaining("budget_exceeded"),
      });
      // A second run the same month is not blocked by the failure (nothing was written).
      expect((await job.run()).status).toBe("failed");
    } finally {
      await w.close();
    }
  });

  it("settings: defaults, the human's notify_prefs.calibration, clamping, and the monthly schedule", () => {
    expect(calibrationSettingsOf({})).toEqual(DEFAULT_CALIBRATION_SETTINGS);
    expect(calibrationSettingsOf(null)).toEqual(DEFAULT_CALIBRATION_SETTINGS);
    expect(DEFAULT_CALIBRATION_SETTINGS).toMatchObject({
      enabled: true,
      day: 1,
      time: "06:00",
      budgetUsdMicro: 10_000_000,
      tier: 1,
      specialists: null,
    });
    expect(
      calibrationSettingsOf({
        calibration: {
          enabled: false,
          day: 15,
          time: "07:30",
          budget_usd: 2.5,
          tier: 2,
          specialists: ["researcher"],
        },
      }),
    ).toEqual({
      enabled: false,
      day: 15,
      time: "07:30",
      budgetUsdMicro: 2_500_000,
      tier: 2,
      specialists: ["researcher"],
    });
    // Malformed values fall back to the defaults, never throw.
    expect(
      calibrationSettingsOf({
        calibration: { day: 40, time: "25:99", budget_usd: -1, tier: 9, specialists: "coder" },
      }),
    ).toEqual({ ...DEFAULT_CALIBRATION_SETTINGS, day: 31 });
    expect(calibrationSettingsOf({ calibration: "yes" })).toEqual(DEFAULT_CALIBRATION_SETTINGS);

    const scheduler = new Scheduler({
      clock: { now: () => 0 } as never,
      start: async () => undefined,
    });
    const s = scheduleCalibration(scheduler, { timezone: "Europe/Zurich", day: 3, time: "07:30" });
    expect(s).toEqual({
      id: CALIBRATION_SCHEDULE_ID,
      agentId: CALIBRATION_AGENT_ID,
      kind: "monthly",
      dayOfMonth: 3,
      time: "07:30",
      timezone: "Europe/Zurich",
      enabled: true,
    });
    expect(scheduler.list().map((x) => x.id)).toEqual([CALIBRATION_SCHEDULE_ID]);
    // Re-adding replaces the entry (a settings change), disabling keeps it off.
    scheduleCalibration(scheduler, { timezone: "UTC", enabled: false });
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.list()[0]).toMatchObject({ enabled: false, dayOfMonth: 1, time: "06:00" });
    expect(
      isCalibrationRequest({ agentId: CALIBRATION_AGENT_ID, trigger: "schedule", reason: "" }),
    ).toBe(true);
    expect(isCalibrationRequest({ agentId: "alice", trigger: "schedule", reason: "" })).toBe(false);
    expect(
      isCalibrationRequest({ agentId: CALIBRATION_AGENT_ID, trigger: "manual", reason: "" }),
    ).toBe(true);
  });
});
