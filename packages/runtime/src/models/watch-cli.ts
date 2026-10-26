/**
 * `fr models watch` and `fr models report`: run the weekly model watch by hand and read its
 * reports. The orchestrator registers this on the `fr` program with the wired ModelWatch.
 */
import { ForerunnerError } from "@forerunner/platform";
import type { Command } from "commander";
import { formatModelWatchReport, type ModelWatch, type ModelWatchHealth } from "./watch.ts";

export interface ModelWatchCliDeps {
  watch: ModelWatch;
  /** Line sink; defaults to console.log. Tests capture it. */
  out?: (line: string) => void;
}

export function registerModelWatchCli(
  program: Command,
  deps: () => ModelWatchCliDeps | Promise<ModelWatchCliDeps>,
): Command {
  const models = program
    .command("models")
    .description("Model ladder, pricing and the weekly model watch");

  models
    .command("watch")
    .description(
      "Run the model watch now: list provider models, check prices and propose changes. The eval sets (paid model calls) run only with --evals or the model_watch run_evals setting",
    )
    .option("--json", "print the report as JSON", false)
    .option(
      "--evals",
      "run the eval sets on new candidates and lower efforts now (costs money, counts against your caps)",
      false,
    )
    .option(
      "--model <provider/id>",
      "evaluate this listed model as a candidate even when it is not new (repeatable; needs --evals)",
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .action(async (opts: { json: boolean; evals: boolean; model: string[] }) => {
      const d = await deps();
      const out = d.out ?? ((line: string) => console.log(line));
      if (opts.model.length && !opts.evals) {
        throw new ForerunnerError(
          "validation",
          "--model runs paid evals: add --evals (fr models watch --evals --model <provider/id>)",
          { details: { models: opts.model } },
        );
      }
      const r = await d.watch.run(
        opts.evals ? { evals: true, ...(opts.model.length ? { models: opts.model } : {}) } : {},
      );
      if (opts.json) {
        out(
          JSON.stringify(
            {
              report: r.report,
              decision: r.decision,
              requestId: r.requestId,
              applied: r.applied,
            },
            null,
            2,
          ),
        );
        return;
      }
      const health: ModelWatchHealth = {
        decision: r.decision,
        request_id: r.requestId,
        decided_at: null,
        by: null,
        applied: r.applied,
        remind_at: null,
      };
      out(formatModelWatchReport(r.report, health));
      if (r.decision === "pending")
        out(`A decision request is open in the inbox${r.requestId ? ` (${r.requestId})` : ""}.`);
      for (const a of r.applied) out(`applied: ${a}`);
    });

  models
    .command("report")
    .description("Show the latest model watch report, one report by id, or the list of reports")
    .option("--id <id>", "report id")
    .option("--list", "list reports newest first", false)
    .option("--json", "print as JSON", false)
    .action(async (opts: { id?: string; list: boolean; json: boolean }) => {
      const d = await deps();
      const out = d.out ?? ((line: string) => console.log(line));
      if (opts.list) {
        const rows = await d.watch.listReports({ limit: 50 });
        if (opts.json) return out(JSON.stringify(rows, null, 2));
        if (rows.length === 0) return out("No model watch report yet.");
        for (const r of rows)
          out(
            `${r.generated_at}  ${r.id}  ${r.decision.padEnd(18)} ${r.recommendations} recommendation(s): ${r.summary}`,
          );
        return;
      }
      const found = opts.id ? await d.watch.getReport(opts.id) : await d.watch.latestReport();
      if (!found) return out("No model watch report yet. Run: fr models watch");
      if (opts.json)
        return out(JSON.stringify({ report: found.report, health: found.health }, null, 2));
      out(formatModelWatchReport(found.report, found.health));
    });

  return models;
}
