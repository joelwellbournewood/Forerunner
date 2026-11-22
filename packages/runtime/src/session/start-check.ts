import type { StateStore, TaskRow, WaitsOn } from "@forerunner/state";
import {
  type EstimatePort,
  estimateLeftUsdMicro,
  type KeptWork,
  keptWorkFor,
  planEstimateUsdMicro,
  withinTaskBudget,
} from "../estimates/model.ts";
import { continuableTasks } from "./budget-card.ts";
import { cutFollowers, followersOf } from "./promise.ts";
import {
  cutPlanToBudget,
  DEFAULT_RESERVE_SHARE,
  type LeftOutReason,
  type PlanItem,
} from "./runner.ts";
import { needsContainerSandbox, type SandboxGate, type SandboxGateAnswer } from "./sandbox-gate.ts";

export { cutFollowers, followersOf } from "./promise.ts";

/** A ready task as the start check names it: what the planner would price it at. */
export interface StartCheckTask {
  taskId: string;
  title: string;
  estimateUsdMicro: number;
  /**
   * A task left out for the budget only (C-45): what the tasks planned before it take of the
   * work budget, the reason it did not fit. Tasks after it that still fit are not counted.
   */
  aheadUsdMicro?: number;
  /**
   * `overBudget` only (D4): why it is not in the plan's work that fits: `oversized`, it is the
   * task larger than the work budget the session takes at its place in the plan's order
   * (`StartCheck.oversized`); `after_large`, it comes after that task and runs only if it leaves
   * budget (d1109-oversize-pause, OP-0); `no_room`, such a task the tasks before it leave too
   * little for; `after_others`, it fits the work budget but not after the tasks before it.
   */
  reason?: LeftOutReason | "oversized";
}

/**
 * D4: the task larger than the session's work budget a session started now takes at its place in
 * the plan's order (d1109-oversize-pause, OP-0, the owner's answer 5), as the runner cuts and takes
 * it (`cutPlanToBudget`).
 */
export interface StartCheckOversized {
  taskId: string;
  title: string;
  /** What it needs: its estimate, or what is left of it after its kept work. */
  estimateUsdMicro: number;
  /**
   * What it works with: the work budget less what the tasks before it in the plan's order take.
   * The whole work budget when none does.
   */
  roomUsdMicro: number;
  /** Tasks run before it in the session (its room is then what they leave). */
  after: boolean;
  /** The titles of the tasks before it in the plan's order (OP-0's 'after "A" it works ...'). */
  before: string[];
  /**
   * The titles of the tasks after it: the ready ones it waits ahead of (`after_large`), then those
   * that become ready meanwhile; they run only if it leaves budget, else in the next session.
   */
  comesAfter: string[];
  /** What its kept work cost, when it resumes from it (OS-1). */
  spentUsdMicro?: number;
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
   * The waiting tasks a session started now would take as they become ready (design §3.6):
   * those whose every unfinished dependency is ready, running or itself one of these, never one
   * that waits on a failed, cancelled, missing or person-held task. In plan order, priced.
   */
  later: StartCheckTask[];
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
  /**
   * D4: the task larger than the work budget the session would take at its place in the plan's
   * order, with the room it gets; null when none (or when too little is left: it is then in
   * `overBudget` with `no_room`). Also in `overBudget`, with the reason `oversized`.
   */
  oversized: StartCheckOversized | null;
  /**
   * d1109-starts-engine (S-6): the followers past what the work budget left after the runnable
   * tasks holds, in run order (`later` is cut to it): they wait for a later Start.
   */
  laterBeyond: StartCheckTask[];
  /**
   * C4b-left-5 (d1109-cred-screens, BA-12; the owner's answer of 2026-11-16: a task's budget
   * counts "critics reviews, and fixes"): the tasks the session takes whose own budget may leave
   * too little for their review: what is left of the budget is less than the task's estimate
   * plus one critic call's worst case at its review tier (`CriticPort.reviewCallUsdMicro`'s
   * `worstUsdMicro`, what the runner keeps room for). Its review then waits for Continue (BA-3).
   * Empty without a critic that prices its call, or for tasks without a budget of their own.
   */
  reviewMayWait: { taskId: string; title: string; budgetUsdMicro: number }[];
}

/**
 * What a session started now promises (d1109-starts-engine S-6, ADR 0118; the owner's "the
 * session keeps its promise"): the runnable tasks (cut as the runner cuts), the task larger than
 * the work budget at its place with its planned room and the tasks after it (`after_large`, the
 * session's own after it: they hold no room while it runs), then the followers that fit the work
 * budget left. The Start dialog's sentence and the runner's `session.promised` read this one list.
 */
export interface StartPromise {
  taskIds: string[];
  /** What the promise is planned at: the runnable tasks, the larger task's room, the followers. */
  estimateUsdMicro: number;
  /** The tasks after the larger one, its own once it ended (they hold no room). */
  afterLarge: string[];
}

/** The promise of a start check (`StartPromise`). */
export function promiseOf(
  check: Pick<StartCheck, "runnable" | "oversized" | "overBudget" | "later">,
): StartPromise {
  const afterLarge = check.overBudget
    .filter((t) => t.reason === "after_large")
    .map((t) => t.taskId);
  const big = check.oversized;
  return {
    taskIds: [
      ...check.runnable.map((t) => t.taskId),
      ...(big ? [big.taskId] : []),
      ...afterLarge,
      ...check.later.map((t) => t.taskId),
    ],
    estimateUsdMicro:
      check.runnable.reduce((s, t) => s + t.estimateUsdMicro, 0) +
      (big?.roomUsdMicro ?? 0) +
      check.later.reduce((s, t) => s + t.estimateUsdMicro, 0),
    afterLarge,
  };
}

/**
 * A task a session already holds (claimed or in progress) when its credential stopped, as the
 * waiting work counts it (l4-cred-screens L4-creds-15): what is left of its estimate.
 */
export interface InFlightTask {
  taskId: string;
  title: string;
  /**
   * Its estimate as the planner prices it (the learned estimate with its review part, the
   * owner's answer of 2026-11-16: "yes it should count critics reviews, and fixes") less all it
   * spent (work, reviews and fixes: `actual_cost_usd_micro`), floored at 0 and kept within what
   * is left of its own budget.
   */
  leftUsdMicro: number;
}

/**
 * The claimed and in-progress tasks of a project, priced as `InFlightTask` says: the task whose
 * run met a credential's stop is still claimed while the ask card is filed (d1109-cred-screens
 * CS-8), so the ready tasks alone leave it out.
 */
export async function inFlightWork(
  deps: { store: StateStore; estimates?: EstimatePort; defaultEstimateUsdMicro?: number },
  projectId: string,
): Promise<InFlightTask[]> {
  const fallback = deps.defaultEstimateUsdMicro ?? 500_000;
  const rows = await deps.store.task
    .forProject(projectId, { status: ["claimed", "in_progress"] }, { limit: 50 })
    .catch(() => [] as TaskRow[]);
  return rows.map((t) => {
    const whole = deps.estimates
      ? deps.estimates.estimate({
          specialist: t.specialist,
          risk_tier: t.risk_tier,
          est_cost_usd_micro: t.est_cost_usd_micro,
          budget_usd_micro: t.budget_usd_micro,
          outcome: t.outcome,
          acceptance_criteria: t.acceptance_criteria,
        }).usdMicro
      : t.est_cost_usd_micro || t.budget_usd_micro || fallback;
    return {
      taskId: t.id,
      title: t.title,
      leftUsdMicro: withinTaskBudget(Math.max(0, whole - (t.actual_cost_usd_micro ?? 0)), t),
    };
  });
}

/**
 * The one figure for "the waiting work" (l4-cred-screens L4-creds-15, ADR 0120 amended
 * 2026-11-22): what a yes to "Use your API key until 15:40?" lets run, priced once for the ask
 * card, the Start dialog's "Use API key" line and the plan card's foot line. It is the session's
 * promise (`promiseOf`: the runnable tasks, the larger task's room and the later followers, each
 * priced with its review part) plus what is left of the tasks a session already holds
 * (`inFlightWork`), never more than the session's work budget: nothing passes that budget.
 * Before, the card priced the held tasks at their raw estimate without the review part and left
 * out the followers, and the dialog priced the runnable tasks alone: three figures for one thing.
 */
export function waitingWorkUsdMicro(
  check: Pick<StartCheck, "runnable" | "oversized" | "overBudget" | "later" | "workBudgetUsdMicro">,
  inFlight: readonly Pick<InFlightTask, "leftUsdMicro">[] = [],
): number {
  const promised = promiseOf(check).estimateUsdMicro;
  const held = inFlight.reduce((sum, t) => sum + Math.max(0, t.leftUsdMicro), 0);
  return Math.max(0, Math.min(promised + held, check.workBudgetUsdMicro));
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
    /** C4b-left-5: one critic call's worst case at a task's review tier (the runner's `W`). */
    reviewCallUsdMicro?: (task: TaskRow, specialist?: string) => Promise<{ worstUsdMicro: number }>;
  },
  projectId: string,
  sessionBudgetUsdMicro: number,
  reserveShare = DEFAULT_RESERVE_SHARE,
): Promise<StartCheck> {
  const { store, estimates } = deps;
  const fallback = deps.defaultEstimateUsdMicro ?? 500_000;
  // d1109-oversize-pause (OP-0, "continue next time"): a task paused at a session's budget (or
  // at its specialist's limit) with progress is one the start takes in its turn, as the runner's
  // plan takes it (`continuableTasks`), at what is left of its estimate.
  const continuing = await continuableTasks(store, projectId);
  const ready = [
    ...(await store.task.forProject(projectId, { status: "ready" }, { limit: 10_000 })),
    ...continuing,
  ];
  let runnableRows = await store.task.readyTasks(projectId, { limit: 100 });
  if (continuing.length)
    runnableRows = [...runnableRows, ...continuing].sort(
      (a, b) =>
        b.priority - a.priority ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id),
    );
  let sandboxWait: StartCheck["waitingForSandbox"] = null;
  // D4 (d1109-oversize-start): a task that resumes from its kept work is priced at what is left
  // of its estimate, as the runner's planner prices it (`keptWorkFor`); read once per task.
  const keptOf = new Map<string, KeptWork | null>();
  const priced = async (t: (typeof runnableRows)[number]) => {
    if (!keptOf.has(t.id)) keptOf.set(t.id, await keptWorkFor(store, t));
    const kept = keptOf.get(t.id) ?? null;
    return estimates
      ? planEstimateUsdMicro(estimates, t, kept)
      : withinTaskBudget(
          estimateLeftUsdMicro(t.est_cost_usd_micro || t.budget_usd_micro || fallback, kept)
            .usdMicro,
          t,
        );
  };
  const waiting = await store.task.waitingTasks(projectId);
  const prices = new Map<string, number>();
  for (const t of [...runnableRows, ...waiting.map((w) => w.task)])
    if (!prices.has(t.id)) prices.set(t.id, await priced(t));
  const price = (t: (typeof runnableRows)[number]) => prices.get(t.id) ?? fallback;
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
    estimateUsdMicro: i.wholeEstimateUsdMicro ?? i.estimateUsdMicro,
  });
  // D4 (d1109-oversize-pause, OP-0): the larger task is in the cut's items at its place, with the
  // room left as its planned figure; what runs before it is the work that fits.
  const bigAt = cut.items.findIndex((i) => i.wholeEstimateUsdMicro !== undefined);
  const big = bigAt >= 0 ? (cut.items[bigAt] as PlanItem) : null;
  const runs = bigAt >= 0 ? cut.items.slice(0, bigAt) : cut.items;
  const leftOut: (PlanItem & { reason?: LeftOutReason | "oversized" })[] = [
    ...(cut.leftOutForBudget ?? []),
    ...(big
      ? [{ ...big, estimateUsdMicro: big.wholeEstimateUsdMicro ?? 0, reason: "oversized" as const }]
      : []),
  ];
  const order = new Map(items.map((i, at) => [i.taskId, at]));
  leftOut.sort((a, b) => (order.get(a.taskId) ?? 0) - (order.get(b.taskId) ?? 0));
  // C-45: the cut is greedy (a smaller task after a left-out one still runs), so what came
  // before each left-out task is read in plan order, not as the sum of everything that runs.
  const aheadOf = new Map<string, number>();
  {
    const left = new Set(leftOut.map((i) => i.taskId));
    const planned = new Map(cut.items.map((i) => [i.taskId, i.estimateUsdMicro]));
    let before = 0;
    for (const i of items) {
      if (left.has(i.taskId)) aheadOf.set(i.taskId, before);
      if (planned.has(i.taskId)) before += planned.get(i.taskId) ?? 0;
    }
  }
  // A chain: a waiting task follows once what it waits on runs or follows (fixed point).
  const comes = new Set(cut.items.map((i) => i.taskId));
  for (const t of await store.task.forProject(
    projectId,
    { status: ["claimed", "in_progress", "in_review"] },
    { limit: 10_000 },
  ))
    comes.add(t.id);
  const following: StartCheckTask[] = followersOf(waiting, comes, needsContainerSandbox).map(
    (t) => ({ taskId: t.id, title: t.title, estimateUsdMicro: price(t) }),
  );
  // S-6: the followers the work budget left after the runnable tasks (and the larger task's
  // room) holds are the promise's; the rest wait for a later Start.
  // With a task larger than the work budget the followers come after it (OP-0's comesAfter):
  // the session's own after it, holding no room while it runs, so they are not cut.
  const promisedFirst = runs.reduce((sum, i) => sum + i.estimateUsdMicro, 0);
  const { taken: later, beyond: laterBeyond } = big
    ? { taken: following, beyond: [] as StartCheckTask[] }
    : cutFollowers(following, Math.max(0, workBudgetUsdMicro - promisedFirst));
  // D4 (OP-0): the larger task gets what the tasks before it in the plan's order leave (the
  // cut's room); the tasks after it, ready now or ready later, run only if it leaves budget.
  let oversized: StartCheckOversized | null = null;
  if (big && cut.oversized) {
    const kept = keptOf.get(big.taskId) ?? null;
    oversized = {
      taskId: big.taskId,
      title: big.title,
      estimateUsdMicro: big.wholeEstimateUsdMicro ?? cut.oversized.estimateUsdMicro,
      roomUsdMicro: big.estimateUsdMicro,
      after: runs.length > 0,
      before: runs.map((i) => i.title),
      comesAfter: [
        ...(cut.leftOutForBudget ?? [])
          .filter((l) => l.reason === "after_large")
          .map((l) => l.title),
        ...following.map((l) => l.title),
      ],
      ...(kept && kept.usdMicro > 0 ? { spentUsdMicro: kept.usdMicro } : {}),
    };
  }
  // C4b-left-5: a task the session takes whose own budget may not hold its work and its review
  // (estimate plus W against what is left of it), in run order.
  const reviewMayWait: StartCheck["reviewMayWait"] = [];
  if (deps.reviewCallUsdMicro) {
    const rows = new Map(
      [...runnableRows, ...waiting.map((w) => w.task)].map((t) => [t.id, t] as const),
    );
    for (const t of [...runs.map(named), ...later]) {
      const row = rows.get(t.taskId);
      if (!row || !(row.budget_usd_micro > 0)) continue;
      const worst = await deps
        .reviewCallUsdMicro(row, row.specialist ?? undefined)
        .then((p) => p.worstUsdMicro)
        .catch(() => 0);
      if (!(worst > 0)) continue;
      const left = Math.max(0, row.budget_usd_micro - row.actual_cost_usd_micro);
      if (t.estimateUsdMicro + worst > left)
        reviewMayWait.push({
          taskId: row.id,
          title: row.title,
          budgetUsdMicro: row.budget_usd_micro,
        });
    }
  }
  return {
    projectId,
    sessionBudgetUsdMicro,
    workBudgetUsdMicro,
    ready: ready.length,
    reviewMayWait,
    runnable: runs.map(named),
    overBudget: leftOut.map((i) => ({
      ...named(i),
      aheadUsdMicro: aheadOf.get(i.taskId) ?? 0,
      ...(i.reason ? { reason: i.reason } : {}),
    })),
    oversized,
    waiting: waiting.map((w) => ({
      taskId: w.task.id,
      title: w.task.title,
      waitsOn: w.waitsOn,
    })),
    later,
    laterBeyond,
    waitingForSandbox: sandboxWait,
  };
}
