import type { StateStore, WaitsOn } from "@forerunner/state";
import { type EstimatePort, planEstimateUsdMicro } from "../estimates/model.ts";
import { cutPlanToBudget, DEFAULT_RESERVE_SHARE, type PlanItem } from "./runner.ts";
import { needsContainerSandbox, type SandboxGate, type SandboxGateAnswer } from "./sandbox-gate.ts";

/** A ready task as the start check names it: what the planner would price it at. */
export interface StartCheckTask {
  taskId: string;
  title: string;
  estimateUsdMicro: number;
}

/**
 * What a session started now would plan (U-040), for the Start dialog: the ready tasks it would
 * run within the budget, the ones it would leave out because they do not fit, and the ones that
 * wait on another task. "No task is ready" is only one way a session plans nothing; a dependency
 * that is cancelled or failed, or a task larger than the budget, is another, and the dialog
 * names it before the person starts a session that would end at once.
 */
export interface StartCheck {
  projectId: string;
  /** The session's cap: the budget asked for, or the project's session cap. */
  sessionBudgetUsdMicro: number;
  /** What the plan may use: the cap less the review reserve (the runner's cut). */
  workBudgetUsdMicro: number;
  /** Tasks in status `ready`, whatever they wait on. */
  ready: number;
  runnable: StartCheckTask[];
  overBudget: StartCheckTask[];
  waiting: { taskId: string; title: string; waitsOn: WaitsOn[] }[];
  /**
   * U-079: the ready tasks at tier 2+ a session would leave out because the container sandbox
   * is not ready, with what is wrong and the step to take; null when none waits for it.
   */
  waitingForSandbox: {
    state: SandboxGateAnswer["state"];
    headline: string;
    step: string;
    tasks: StartCheckTask[];
  } | null;
}

/**
 * The start check over the store, priced as the daemon's planner prices (`StaticPlanner` with
 * the learned estimates: `planEstimateUsdMicro`, else the task's estimate or budget, else the
 * planner's default) and cut as the runner cuts (`cutPlanToBudget` with the default reserve).
 */
export async function startCheck(
  deps: {
    store: StateStore;
    estimates?: EstimatePort;
    defaultEstimateUsdMicro?: number;
    /** The runner's gate (U-079): asked as the runner asks it, before the plan. */
    sandbox?: Pick<SandboxGate, "check">;
  },
  projectId: string,
  sessionBudgetUsdMicro: number,
  reserveShare = DEFAULT_RESERVE_SHARE,
): Promise<StartCheck> {
  const { store, estimates } = deps;
  const fallback = deps.defaultEstimateUsdMicro ?? 500_000;
  const ready = await store.task.forProject(projectId, { status: "ready" }, { limit: 10_000 });
  let runnableRows = await store.task.readyTasks(projectId, { limit: 100 });
  let sandboxWait: StartCheck["waitingForSandbox"] = null;
  const price = (t: (typeof runnableRows)[number]) =>
    estimates
      ? planEstimateUsdMicro(estimates, t)
      : t.est_cost_usd_micro || t.budget_usd_micro || fallback;
  if (deps.sandbox && runnableRows.some(needsContainerSandbox)) {
    const answer = await deps.sandbox.check();
    if (!answer.ready) {
      sandboxWait = {
        state: answer.state,
        headline: answer.headline,
        step: answer.step,
        tasks: runnableRows
          .filter(needsContainerSandbox)
          .map((t) => ({ taskId: t.id, title: t.title, estimateUsdMicro: price(t) })),
      };
      runnableRows = runnableRows.filter((t) => !needsContainerSandbox(t));
    }
  }
  const items: PlanItem[] = runnableRows.map((t) => ({
    taskId: t.id,
    title: t.title,
    specialist: t.specialist ?? "coder",
    estimateUsdMicro: price(t),
  }));
  const workBudgetUsdMicro = Math.floor(sessionBudgetUsdMicro * (1 - reserveShare));
  const cut = cutPlanToBudget(
    {
      items,
      estimateUsdMicro: items.reduce((s, i) => s + i.estimateUsdMicro, 0),
      summary: "",
    },
    workBudgetUsdMicro,
  );
  const named = (i: PlanItem): StartCheckTask => ({
    taskId: i.taskId,
    title: i.title,
    estimateUsdMicro: i.estimateUsdMicro,
  });
  return {
    projectId,
    sessionBudgetUsdMicro,
    workBudgetUsdMicro,
    ready: ready.length,
    runnable: cut.items.map(named),
    overBudget: (cut.leftOutForBudget ?? []).map(named),
    waiting: (await store.task.waitingTasks(projectId)).map((w) => ({
      taskId: w.task.id,
      title: w.task.title,
      waitsOn: w.waitsOn,
    })),
    waitingForSandbox: sandboxWait,
  };
}
