/**
 * `fr jobs calibrate`, `fr jobs handover <project>` and `fr jobs reports`: run the monthly
 * jobs by hand (the live run on a final build, a project just flagged) and read their
 * reports. A one-shot: the runtime is composed without its background services. `--force`
 * runs again in a month that already has a report; the hooks' budget applies either way.
 */

import { formatCalibrationReport } from "@forerunner/critic";
import { errorMessage } from "@forerunner/platform";
import type { Command } from "commander";
import { calibrationDriftLine } from "../notifications/producers.ts";
import type { CalibrationJob } from "./calibration.ts";
import { formatHandoverReport, type HandoverJob } from "./handover.ts";

export interface JobsCliDeps {
  /** The composed runtime's jobs and store; the caller closes the runtime after the action. */
  open: () => Promise<{
    jobs: { calibration: CalibrationJob; handover: HandoverJob };
    store: {
      project: {
        list(filter: object, opts: { limit: number }): Promise<{ id: string; name: string }[]>;
      };
    };
  }>;
  /** Line sink; defaults to console.log. Tests capture it. */
  out?: (line: string) => void;
}

export function registerJobsCli(program: Command, deps: JobsCliDeps): Command {
  const jobs = program
    .command("jobs")
    .description("The monthly jobs: critic calibration (H.7) and the handover test (P.15)");
  const out = deps.out ?? ((line: string) => console.log(line));

  jobs
    .command("calibrate")
    .description("Run the critic calibration over the registry's eval sets now")
    .option("--force", "run even when this month already has a report", false)
    .option("--json", "print the result as JSON", false)
    .action(async (opts: { force: boolean; json: boolean }) => {
      const rt = await deps.open();
      const r = await rt.jobs.calibration.run({ force: opts.force });
      if (opts.json) {
        out(JSON.stringify(r, null, 2));
        return;
      }
      if (r.status === "skipped") {
        out(`calibration skipped: ${r.reason} (previous report ${r.previous?.file ?? "none"})`);
        return;
      }
      if (r.status === "failed" || !r.report) {
        out(`calibration failed: ${r.reason ?? "unknown"}`);
        return;
      }
      out(formatCalibrationReport(r.report));
      if (r.drift) out(calibrationDriftLine(r.drift));
      if (r.report.file) out(`report: ${r.report.file}`);
    });

  jobs
    .command("handover <project>")
    .description(
      "Run the handover test on a project (its id or name) now: a fresh agent, the seeded change, the docs task",
    )
    .option("--force", "run even when this month already has a report", false)
    .option("--json", "print the result as JSON", false)
    .action(async (project: string, opts: { force: boolean; json: boolean }) => {
      const rt = await deps.open();
      const rows = await rt.store.project.list({}, { limit: 1000 });
      const row =
        rows.find((p) => p.id === project) ??
        rows.find((p) => p.name.toLowerCase() === project.toLowerCase());
      if (!row) {
        out(`no project ${project}`);
        return;
      }
      try {
        const r = await rt.jobs.handover.run(row.id, { force: opts.force });
        if (opts.json) {
          out(JSON.stringify(r, null, 2));
          return;
        }
        if (r.status !== "ran" || !r.report) {
          out(`handover ${r.status}: ${r.reason ?? "unknown"}`);
          return;
        }
        out(formatHandoverReport(r.report));
      } catch (e) {
        out(`handover failed: ${errorMessage(e)}`);
      }
    });

  jobs
    .command("reports")
    .description("List the calibration reports and the handover reports of every project")
    .action(async () => {
      const rt = await deps.open();
      {
        const cal = rt.jobs.calibration.reports();
        out(`calibration reports: ${cal.length}`);
        for (const r of cal)
          out(
            `  ${r.date} tier ${r.tier} ${r.model}: caught ${Math.round(r.catchRate * 100)}%, accepted ${Math.round(r.passRate * 100)}%, gate ${r.gateOk ? "ok" : "FAIL"} (${r.file})`,
          );
        for (const p of await rt.store.project.list({}, { limit: 1000 })) {
          const reports = rt.jobs.handover.reports(p.id);
          if (reports.length === 0) continue;
          out(`handover reports for ${p.name}: ${reports.length}`);
          for (const r of reports)
            out(
              `  ${r.date}: ${r.stuck} stuck place(s), session ${r.sessionStatus}${r.docsTaskId ? `, docs task ${r.docsTaskId}` : ""} (${r.file})`,
            );
        }
      }
    });

  return program;
}
