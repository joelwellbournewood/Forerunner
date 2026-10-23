/**
 * `fr jobs calibrate|handover|reports` (ADR 0060): the monthly jobs by hand. The jobs are
 * stand-ins here (their own suites run them for real); this pins what the CLI passes on
 * (`--force`, the project by id or name) and what it prints for each outcome.
 */
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { CalibrationJob, CalibrationRunResult } from "../src/jobs/calibration.ts";
import { registerJobsCli } from "../src/jobs/cli.ts";
import type { HandoverJob, HandoverRunResult } from "../src/jobs/handover.ts";

function cli(results: { calibration: CalibrationRunResult; handover: HandoverRunResult }) {
  const calls: { job: string; projectId?: string; force?: boolean }[] = [];
  const lines: string[] = [];
  const calibration = {
    run: async (opts: { force?: boolean }) => {
      calls.push({ job: "calibration", force: opts.force });
      return results.calibration;
    },
    reports: () => [
      {
        date: "2026-10-01",
        startedAt: "2026-10-01T04:00:00.000Z",
        file: "critic/calibration-2026-10-01.json",
        tier: 1,
        model: "fake-sonnet",
        catchRate: 0.9,
        passRate: 1,
        gateOk: true,
        costUsdMicro: 120_000,
      },
    ],
  } as unknown as CalibrationJob;
  const handover = {
    run: async (projectId: string, opts: { force?: boolean }) => {
      calls.push({ job: "handover", projectId, force: opts.force });
      return results.handover;
    },
    reports: (projectId: string) =>
      projectId === "p-1"
        ? [
            {
              date: "2026-10-01",
              file: "handover/p-1/handover-2026-10-01.json",
              projectId,
              stuck: 2,
              docsTaskId: "t-docs",
              sessionStatus: "completed",
            },
          ]
        : [],
  } as unknown as HandoverJob;
  const program = new Command();
  program.exitOverride();
  registerJobsCli(program, {
    open: async () => ({
      jobs: { calibration, handover },
      store: {
        project: {
          list: async () => [
            { id: "p-1", name: "Forerunner" },
            { id: "p-2", name: "Game" },
          ],
        },
      },
    }),
    out: (l) => lines.push(l),
  });
  return { program, calls, lines };
}

const SKIPPED_CAL: CalibrationRunResult = {
  status: "skipped",
  reason: "already_ran",
  monthKey: "2026-10",
  report: null,
  previous: null,
  drift: null,
  sessionId: null,
  notificationId: null,
};
const FAILED_HANDOVER: HandoverRunResult = {
  status: "failed",
  reason: "no model credential configured",
  monthKey: "2026-10",
  report: null,
  messageId: null,
  notificationId: null,
};

describe("fr jobs", () => {
  it("calibrate passes --force on and prints a skip or a failure with its reason", async () => {
    const { program, calls, lines } = cli({
      calibration: SKIPPED_CAL,
      handover: FAILED_HANDOVER,
    });
    await program.parseAsync(["jobs", "calibrate", "--force"], { from: "user" });
    expect(calls).toEqual([{ job: "calibration", force: true }]);
    expect(lines).toEqual(["calibration skipped: already_ran (previous report none)"]);
  });

  it("handover finds the project by name, says when there is none, and prints the outcome", async () => {
    const { program, calls, lines } = cli({
      calibration: SKIPPED_CAL,
      handover: FAILED_HANDOVER,
    });
    await program.parseAsync(["jobs", "handover", "forerunner"], { from: "user" });
    expect(calls).toEqual([{ job: "handover", projectId: "p-1", force: false }]);
    expect(lines).toEqual(["handover failed: no model credential configured"]);
    lines.length = 0;
    await program.parseAsync(["jobs", "handover", "nope"], { from: "user" });
    expect(lines).toEqual(["no project nope"]);
    expect(calls).toHaveLength(1);
  });

  it("reports lists the calibration reports and every project's handover reports", async () => {
    const { program, lines } = cli({ calibration: SKIPPED_CAL, handover: FAILED_HANDOVER });
    await program.parseAsync(["jobs", "reports"], { from: "user" });
    expect(lines).toEqual([
      "calibration reports: 1",
      "  2026-10-01 tier 1 fake-sonnet: caught 90%, accepted 100%, gate ok (critic/calibration-2026-10-01.json)",
      "handover reports for Forerunner: 1",
      "  2026-10-01: 2 stuck place(s), session completed, docs task t-docs (handover/p-1/handover-2026-10-01.json)",
    ]);
  });
});
