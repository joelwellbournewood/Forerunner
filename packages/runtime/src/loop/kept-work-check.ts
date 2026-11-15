import { existsSync } from "node:fs";
import {
  errorMessage,
  type RunOptions,
  type RunResult,
  run as runProcess,
} from "@forerunner/platform";
import type { JsonObject, StateStore, TaskRow } from "@forerunner/state";
import type { KeptCheck } from "../session/budget-pause.ts";
import type { RunSandboxPort } from "../session/executor.ts";
import type { KeptWorkCheckPort } from "../session/runner.ts";
import { codeTaskChecks, runMarkerCheck, sandboxCheckRunner, startsIn } from "./critic.ts";
import { PROJECT_CHECK_TIMEOUT_MS } from "./project-checks.ts";

/**
 * The project's own checks on a paused run's kept work (d1109-oversize-pause, OP-2; the owner's D4:
 * "wrap up in an organized and error free way such that the work can be continued in the next
 * run"). After a pause whose kept work changed a code file, the same list the critic runs for a
 * code task (`codeTaskChecks`: the commands in the project's settings, the package.json scripts
 * build, lint, typecheck and test as they were before the task, the marker checks) runs once on
 * the kept work in the task's sandbox (`RunSandboxPort.open` with its worktree and no network),
 * never on the host: with no sandbox port, or one that cannot open, nothing runs and the reason
 * is kept (`notRun`). In all within `PROJECT_CHECK_TIMEOUT_MS`, under the session's signal (Stop
 * now ends it). No model call and nothing booked: the checks cost time, not money.
 *
 * Each check keeps the end of its output (at most `KEPT_OUTPUT_CHARS`), passed through the
 * secrets redactor before it is stored (data: the next brief quotes it, never as instructions).
 * A failing check never reverts or hides the work and never brings a review: it is said on the
 * card and the result, and the next run is told.
 */

/** The longest end of a check's output kept on the Run row (and quoted in the next brief). */
export const KEPT_OUTPUT_CHARS = 1_500;

export interface KeptWorkCheckDeps {
  store: Pick<StateStore, "project">;
  /** The task's sandbox (the critic's port). Absent: no check runs, and the reason is kept. */
  sandbox?: RunSandboxPort;
  /** Scrubs secret values out of a check's output before it is stored. */
  redact: (text: string) => string | Promise<string>;
  /** For reading the scripts as they were before the task (git, on the host; runs no script). */
  run?: (argv: readonly string[], opts: RunOptions) => Promise<RunResult>;
}

/** The end of a check's output, cut to `KEPT_OUTPUT_CHARS`. */
function tailOf(output: string): string {
  const t = output.trim();
  return t.length > KEPT_OUTPUT_CHARS ? `…${t.slice(-(KEPT_OUTPUT_CHARS - 1))}` : t;
}

/** The kept-work check (`SessionRunnerDeps.keptWorkCheck`). */
export function keptWorkChecker(deps: KeptWorkCheckDeps): KeptWorkCheckPort {
  return async ({ task, worktree, changedFiles, signal }) => {
    const root = worktree && existsSync(worktree) ? worktree : undefined;
    if (!root) return { notRun: "its folder is not on this computer" };
    const project = task.project_id ? await deps.store.project.get(task.project_id) : undefined;
    const list = await codeTaskChecks({
      settings: (project?.settings ?? null) as JsonObject | null,
      root,
      changedFiles,
      taskId: task.id,
      code: true,
      run: deps.run ?? runProcess,
    });
    let checks = list.checks;
    const markers = list.markers;
    if (!checks.length && !markers.length) return {};
    if (!deps.sandbox) return { notRun: "there is no sandbox to run them in" };
    const deadline = Date.now() + PROJECT_CHECK_TIMEOUT_MS;
    let lease: Awaited<ReturnType<RunSandboxPort["open"]>>;
    try {
      lease = await deps.sandbox.open({
        task: task as Pick<TaskRow, "id" | "project_id" | "risk_tier">,
        worktree: root,
        allowedDomains: [],
        timeoutMs: PROJECT_CHECK_TIMEOUT_MS,
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      return {
        notRun: `the sandbox could not be opened (${errorMessage(e).split("\n")[0]?.slice(0, 200)})`,
      };
    }
    const out: KeptCheck[] = [];
    try {
      // The project's scripts need npm where they run; without it they are not run.
      if (list.ownChecks.length && !(await startsIn(lease.sandbox, ["npm", "--version"])))
        checks = checks.filter((c) => !list.ownChecks.includes(c));
      const runner = sandboxCheckRunner(lease.sandbox);
      for (const c of checks) {
        if (signal.aborted) throw new Error("stopped");
        const left = deadline - Date.now();
        if (left <= 0) break;
        const r = await runner.run(
          { ...c, timeoutMs: Math.min(c.timeoutMs ?? 120_000, left) },
          { signal },
        );
        out.push({ name: c.name, passed: r.passed, output: tailOf(r.output) });
      }
      const node = lease.sandbox.kind !== "process" ? "node" : process.execPath;
      for (const m of markers) {
        if (signal.aborted) throw new Error("stopped");
        const left = deadline - Date.now();
        if (left <= 0) break;
        const r = await runMarkerCheck(
          m,
          (argv, o) =>
            lease.sandbox.run(argv, {
              timeoutMs: Math.min(o.timeoutMs, left),
              maxOutputBytes: 256 * 1024,
              ...(o.env ? { env: o.env } : {}),
              signal,
            }),
          root,
          { node },
        );
        if ("result" in r)
          out.push({
            name: r.result.name,
            passed: r.result.passed,
            output: tailOf(r.result.output),
          });
      }
    } finally {
      await lease.sandbox.destroy().catch(() => undefined);
    }
    if (signal.aborted) throw new Error("stopped");
    // The output is data a check printed: secrets out before it is stored or quoted.
    const redacted: KeptCheck[] = [];
    for (const c of out) redacted.push({ ...c, output: await deps.redact(c.output) });
    return { checks: redacted };
  };
}
