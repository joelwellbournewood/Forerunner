import type { Command } from "commander";
import type { SpecialistApplyResult, SpecialistApprovals } from "../registry/approval.ts";

/**
 * `fr specialists list|approve|reject` (spec C.5, ADR 0071): the headless path of the
 * proposal approval. `approve` answers the proposal's request as the install's human and
 * applies it at once through the same steps as an inbox answer: the eval set runs, the result
 * is recorded in `proposal.json`, and only a pass promotes the file. A one-shot over the
 * composed runtime (no background services); the exit code is 1 when the proposal did not go
 * live.
 */
export interface SpecialistsCliRuntime {
  specialistApprovals: SpecialistApprovals;
  human: { id: string };
}

export interface SpecialistsCliDeps {
  open: () => Promise<SpecialistsCliRuntime>;
  out: (line: string) => void;
}

/** One line per outcome, the way the CLI prints it. */
export function applyResultLine(r: SpecialistApplyResult): string {
  const ev = r.evalResult;
  const rate = ev
    ? ` (pass rate ${Math.round(ev.passRate * 1000) / 10}%, ${ev.passedTasks}/${ev.decided} decided, ${ev.total} tasks on ${ev.model})`
    : "";
  switch (r.outcome) {
    case "promoted":
      return `Specialist "${r.name}" is active${rate}.`;
    case "withdrawn":
      return `Proposal "${r.name}" withdrawn; the name is free.`;
    default:
      return `Specialist "${r.name}" stays proposed: ${r.outcome}${r.detail ? `: ${r.detail}` : ""}${rate}.`;
  }
}

export function registerSpecialistsCli(program: Command, deps: SpecialistsCliDeps): void {
  const cmd = program
    .command("specialists")
    .description("Proposed specialists: list them, approve (runs the eval set) or reject");

  cmd
    .command("list")
    .description("Pending proposals with their eval-set size, last result and open request")
    .option("--json", "machine readable", false)
    .action(async (opts: { json?: boolean }) => {
      const rt = await deps.open();
      const rows = await rt.specialistApprovals.pendingWithRequests();
      const invalid = rt.specialistApprovals.invalidProposals();
      if (opts.json) {
        deps.out(JSON.stringify({ proposals: rows, invalid }, null, 2));
        return;
      }
      if (rows.length === 0) deps.out("No pending specialist proposals.");
      for (const p of rows) {
        const last = p.record?.evalResult;
        const result = last
          ? `last run ${last.passed ? "passed" : "failed"} at ${Math.round(last.passRate * 1000) / 10}% on ${last.ranAt}`
          : "not evaluated";
        deps.out(
          `${p.name}  ${p.promptVersion}  ${p.evalTaskCount} eval task(s)  ${result}  ${p.openRequestId ? `request ${p.openRequestId}` : "no open request"}`,
        );
      }
      for (const i of invalid) deps.out(`invalid: ${i.file} [${i.field}] ${i.message}`);
    });

  cmd
    .command("approve <name>")
    .description("Approve a proposal as yourself: runs its eval set and activates it on a pass")
    .option("--json", "machine readable", false)
    .action(async (name: string, opts: { json?: boolean }) => {
      const rt = await deps.open();
      const r = await rt.specialistApprovals.approve(name, rt.human.id);
      deps.out(opts.json ? JSON.stringify(r, null, 2) : applyResultLine(r));
      if (r.outcome !== "promoted") process.exitCode = 1;
    });

  cmd
    .command("reject <name>")
    .description("Reject a proposal: withdraws it and frees the name")
    .option("--json", "machine readable", false)
    .action(async (name: string, opts: { json?: boolean }) => {
      const rt = await deps.open();
      const r = await rt.specialistApprovals.reject(name, rt.human.id);
      deps.out(opts.json ? JSON.stringify(r, null, 2) : applyResultLine(r));
      if (r.outcome !== "withdrawn") process.exitCode = 1;
    });
}
