import { DEFAULT_CHF_PER_USD, formatChf, usdToChfMicro } from "@forerunner/billing";
import { SESSION_CAP_CHF_KEY, SESSION_CAP_KEY } from "@forerunner/commands";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type {
  HumanRequestRow,
  JsonObject,
  SessionRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import { ANSWER_CARD_KEYS, budgetStopAnswer } from "../wiring/request-answers.ts";
import { unappliedAnswers } from "./findings.ts";
import { recordStart, resumeWork, type StartPort } from "./resume-work.ts";
import type { BudgetStop } from "./runner.ts";

/**
 * A task stopped at its own budget asks the person once (live walk 2, part 3, B2). Before, a
 * run that reached the task's budget (U-042) moved it to `needs_human` with no card: the
 * session's result said '"Contact page" needs your decision (Inbox).' while the Inbox said
 * "Nothing needs you", the Tasks tab said "Paused", the drawer spoke dollars on a CHF screen,
 * and the only way on was Edit budget, Resume and Start.
 *
 * Now the runner files one card for the task (`fileBudgetStopCard`):
 * '"Contact page" stopped at its budget of CHF 0.01' with **Raise the budget** ("Sets its
 * budget to CHF 0.40 and starts a session that tries again.") and **Cancel task**. The answer is
 * applied by `syncBudgetStopAnswers` (run by `RuntimeApp.syncApprovals`): the budget is raised to
 * the amount the button named (never lowered: an Edit made meanwhile that set more stays), the
 * task goes back to ready and a session of its project is asked for; Cancel task cancels it.
 * The card's words are in `daemon/request-words.ts` (`budgetCard`), the task's status on the
 * Tasks tab in `daemon/task-words.ts` ("Needs your decision: its budget is used").
 */
export const BUDGET_STOP_KEY = ANSWER_CARD_KEYS.budgetStop;
/** The card's options as its buttons say them; `budgetStopAnswer` reads them. */
export const BUDGET_STOP_OPTIONS = ["Raise the budget", "Cancel task"] as const;
/**
 * The options of the card a task gets when a session's own budget stopped it twice (C-36):
 * raise this project's budget per session, give the task one bigger session, or cancel it.
 */
export const SESSION_BUDGET_STOP_OPTIONS = [
  "Raise session budget",
  "Raise its budget",
  "Cancel task",
] as const;
/** `change_card.source` of the card a session's budget filed (C-36). */
export const SESSION_BUDGET_SOURCE = "session_budget";
/** How many stops by a session's budget, since its last such card, file the card (C-36). */
export const SESSION_BUDGET_STOPS_BEFORE_CARD = 2;
/** The least a raise adds on top of what the task spent: USD 0.50, the planner's default. */
const MIN_RAISE_USD_MICRO = 500_000;
/** Raised budgets are whole steps of USD 0.05, so the CHF amount reads round enough. */
const RAISE_STEP_USD_MICRO = 50_000;

/**
 * The budget Raise the budget sets. The budget counts every run of the task (`runCapOf`), so it
 * is what the task spent so far plus room for the next run: as much as the whole budget it
 * stopped at, or twice the specialist's per-run limit it stopped at (a smaller room would stop
 * the next run where this one stopped), and at least its planned estimate and USD 0.50. Rounded
 * up to a step of USD 0.05.
 */
export function raisedBudgetUsdMicro(
  task: Pick<TaskRow, "est_cost_usd_micro">,
  stop: Pick<BudgetStop, "capUsdMicro" | "spentUsdMicro" | "source">,
): number {
  const room = Math.max(
    stop.source === "task_budget" ? stop.capUsdMicro : stop.capUsdMicro * 2,
    task.est_cost_usd_micro,
    MIN_RAISE_USD_MICRO,
  );
  const base = Math.max(0, stop.spentUsdMicro) + room;
  return Math.ceil(base / RAISE_STEP_USD_MICRO) * RAISE_STEP_USD_MICRO;
}

const chfText = (usdMicro: number, rate: number) =>
  formatChf(usdToChfMicro(Math.max(0, Math.round(usdMicro)), rate));

/** '"X" stopped at its budget of CHF 0.01' (the card's title and the task's reason). */
export function budgetStopTitle(
  task: Pick<TaskRow, "title">,
  stop: Pick<BudgetStop, "capUsdMicro" | "source" | "specialist">,
  rate: number,
): string {
  const title = `"${task.title.replace(/\s+/g, " ").trim()}"`;
  const chf = chfText(stop.capUsdMicro, rate);
  // The limit that stopped it (ADR 0111): before, every stop below the session's remainder was
  // "its budget" or the specialist's limit, whatever refused it.
  switch (stop.source) {
    case "task_budget":
      return `${title} stopped at its budget of ${chf}`;
    case "specialist_limit":
      return `${title} stopped at the ${stop.specialist}'s limit of ${chf} per run`;
    case "session":
      return `${title} stopped at this session's budget of ${chf}`;
    case "project":
      return `${title} stopped at the project's budget of ${chf}`;
    case "month":
      return `${title} stopped at this month's cap of ${chf}`;
    case "plan":
      return `${title} stopped at the share of your Claude subscription that Forerunner may use`;
  }
}

export interface BudgetStopCardInput {
  store: StateStore;
  /** The task, now `needs_human`. */
  task: TaskRow;
  session: Pick<SessionRow, "id"> | null;
  humanId: string;
  /** The principal agent that ran the task (author of the card). */
  agentId: string;
  runId: string | null;
  stop: BudgetStop;
  /** The day's CHF per USD for the amounts on the card. */
  chfPerUsd?: number;
}

function keyOf(r: Pick<HumanRequestRow, "change_card">): string | undefined {
  const key = (r.change_card as JsonObject | null)?.key;
  return typeof key === "string" ? key : undefined;
}

/** File (or reuse) the one card of a task stopped at its budget. */
export async function fileBudgetStopCard(
  input: BudgetStopCardInput,
): Promise<{ request: HumanRequestRow; reused: boolean }> {
  const { store, task, stop } = input;
  const open = (
    await store.humanRequest.list({ task_id: task.id, status: "open" } as never, { limit: 50 })
  ).find((r) => keyOf(r) === BUDGET_STOP_KEY);
  if (open) return { request: open, reused: true };
  const rate = input.chfPerUsd ?? DEFAULT_CHF_PER_USD;
  const raiseTo = raisedBudgetUsdMicro(task, stop);
  const request = await store.humanRequest.insert({
    human_id: input.humanId,
    project_id: task.project_id,
    task_id: task.id,
    session_id: input.session?.id ?? null,
    kind: "approval",
    // Design §3.8, §5: one sentence; the options say what they do.
    why: `${budgetStopTitle(task, stop, rate)}.`,
    steps: [],
    options: [...BUDGET_STOP_OPTIONS],
    blocking: true,
    risk: "medium",
    change_card: {
      key: BUDGET_STOP_KEY,
      task_id: task.id,
      task_title: task.title,
      title: budgetStopTitle(task, stop, rate),
      run_id: input.runId,
      source: stop.source,
      specialist: stop.specialist,
      cap_usd_micro: stop.capUsdMicro,
      spent_usd_micro: stop.spentUsdMicro,
      raise_to_usd_micro: raiseTo,
      chf_per_usd: rate,
      applied_at: null,
    },
    author_agent: input.agentId,
  });
  return { request, reused: false };
}

/**
 * How many times a session's own budget stopped this task's work since its last card about it
 * (C-36): its work runs that ended `budget_exceeded`, less the ones a budget card already
 * accounts for (a stop at the task's own cap has its card's `run_id`; a session-budget card
 * keeps the `run_ids` it was filed for). `current` is this stop's run (null when the run threw
 * before its row was written): it counts once, row or not.
 */
export async function sessionBudgetStops(
  store: StateStore,
  taskId: string,
  current: string | null,
): Promise<{ count: number; runIds: string[] }> {
  const cards = (
    await store.humanRequest.list({ task_id: taskId } as never, { limit: 500 })
  ).filter((r) => keyOf(r) === BUDGET_STOP_KEY);
  const accounted = new Set<string>();
  for (const c of cards) {
    const card = (c.change_card ?? {}) as JsonObject;
    if (typeof card.run_id === "string") accounted.add(card.run_id);
    if (Array.isArray(card.run_ids))
      for (const id of card.run_ids) if (typeof id === "string") accounted.add(id);
  }
  // A run that paused at the session's budget after its wrap-up is a stop too (ADR 0111).
  const runIds = (await store.run.forTask(taskId, { limit: 1000 }))
    .filter(
      (r) =>
        r.specialist !== "critic" && (r.outcome === "budget_exceeded" || r.outcome === "paused"),
    )
    .map((r) => r.id)
    .filter((id) => !accounted.has(id));
  if (current && !runIds.includes(current) && !accounted.has(current)) runIds.push(current);
  return { count: runIds.length + (current ? 0 : 1), runIds };
}

/**
 * What the session-budget card offers (C-36): twice the budget of the session that stopped the
 * task, at least USD 0.50, in steps of USD 0.05, for the project's budget per session or for
 * one session of the task.
 */
export function raisedSessionBudgetUsdMicro(stoppedAtUsdMicro: number): number {
  const room = Math.max(2 * Math.max(0, stoppedAtUsdMicro), MIN_RAISE_USD_MICRO);
  return Math.ceil(room / RAISE_STEP_USD_MICRO) * RAISE_STEP_USD_MICRO;
}

/** A project's budget per session as its settings hold it (the budget command's key), else `fallback`. */
export function budgetPerSessionOf(
  settings: JsonObject | null | undefined,
  fallback: number,
): number {
  const set = settings?.[SESSION_CAP_KEY];
  return typeof set === "number" && Number.isInteger(set) && set > 0 ? set : fallback;
}

/** '"X" needs more than a session's budget' (the card's title and the task's reason). */
export function sessionBudgetTitle(task: Pick<TaskRow, "title">): string {
  return `"${task.title.replace(/\s+/g, " ").trim()}" needs more than a session's budget`;
}

export interface SessionBudgetCardInput {
  store: StateStore;
  /** The task, now `needs_human`. */
  task: TaskRow;
  /** The session whose budget stopped it (its cap is what the card raises from). */
  session: Pick<SessionRow, "id" | "budget_cap_usd_micro">;
  humanId: string;
  agentId: string;
  /** The stops the card is filed for (`sessionBudgetStops`). */
  runIds: string[];
  /** The project's budget per session now, for the words of "Raise its budget". */
  projectCapUsdMicro: number;
  chfPerUsd?: number;
}

/**
 * Files (or reuses) the one card of a task a session's budget stopped twice (C-36). Before, such
 * a task went back to Ready after every stop and every session ran it again until the person
 * noticed, each run bounded only by the session's budget and the monthly cap.
 */
export async function fileSessionBudgetCard(
  input: SessionBudgetCardInput,
): Promise<{ request: HumanRequestRow; reused: boolean }> {
  const { store, task, session } = input;
  const open = (
    await store.humanRequest.list({ task_id: task.id, status: "open" } as never, { limit: 50 })
  ).find((r) => keyOf(r) === BUDGET_STOP_KEY);
  if (open) return { request: open, reused: true };
  const rate = input.chfPerUsd ?? DEFAULT_CHF_PER_USD;
  const raiseTo = raisedSessionBudgetUsdMicro(session.budget_cap_usd_micro);
  const title = sessionBudgetTitle(task);
  const request = await store.humanRequest.insert({
    human_id: input.humanId,
    project_id: task.project_id,
    task_id: task.id,
    session_id: session.id,
    kind: "approval",
    why: `${title}. Two sessions of ${chfText(session.budget_cap_usd_micro, rate)} stopped while it ran.`,
    steps: [],
    options: [...SESSION_BUDGET_STOP_OPTIONS],
    blocking: true,
    risk: "medium",
    change_card: {
      key: BUDGET_STOP_KEY,
      source: SESSION_BUDGET_SOURCE,
      task_id: task.id,
      task_title: task.title,
      title,
      run_ids: input.runIds,
      session_cap_usd_micro: session.budget_cap_usd_micro,
      project_cap_usd_micro: input.projectCapUsdMicro,
      spent_usd_micro: task.actual_cost_usd_micro,
      raise_to_usd_micro: raiseTo,
      chf_per_usd: rate,
      applied_at: null,
    },
    author_agent: input.agentId,
  });
  return { request, reused: false };
}

export interface BudgetStopSyncResult {
  raised: number;
  cancelled: number;
  /** Answered cards whose task had moved on, or whose answer was not one of the options. */
  skipped: number;
}

/**
 * Applies every answered budget card of the person not applied yet. The task must still wait
 * (`needs_human`); otherwise the answer is recorded as `task_moved_on` and nothing changes.
 * Each outcome is written on the card (`applied_at`, `outcome`, the budget set), so it is
 * applied once.
 */
export async function syncBudgetStopAnswers(deps: {
  store: StateStore;
  clock: Clock;
  humanId: string;
  agentId: string;
  /** Answering resumes work (design §3.8): the daemon's scheduler; absent in a one-shot. */
  start?: StartPort;
}): Promise<BudgetStopSyncResult> {
  const logger = log("budget-card");
  const { store, clock } = deps;
  const out: BudgetStopSyncResult = { raised: 0, cancelled: 0, skipped: 0 };
  for (const row of await unappliedAnswers(store, deps.humanId, BUDGET_STOP_KEY)) {
    const card = (row.change_card ?? {}) as JsonObject;
    const finish = (outcome: string, extra: JsonObject = {}) =>
      store.humanRequest.patch(row.id, {
        change_card: { ...card, applied_at: clock.nowIso(), outcome, ...extra },
      });
    const answer = budgetStopAnswer(row.answer);
    const task = row.task_id ? await store.task.get(row.task_id) : undefined;
    if (!answer || !task || task.status !== "needs_human") {
      out.skipped++;
      await finish(!answer ? "unrecognized_answer" : "task_moved_on");
      continue;
    }
    const actor = { agentId: deps.agentId, humanId: deps.humanId };
    const sessionCard = card.source === SESSION_BUDGET_SOURCE;
    try {
      if (sessionCard && answer !== "cancel") {
        // C-36: "Raise session budget" sets the project's budget per session to the amount the
        // button named (never lower than it is) and every later session gets it; "Raise its
        // budget" gives the task room for one session of that amount (its own budget covers
        // what it spent and that session) and starts that one session, later ones keep theirs.
        const promised = typeof card.raise_to_usd_micro === "number" ? card.raise_to_usd_micro : 0;
        const rate = typeof card.chf_per_usd === "number" ? card.chf_per_usd : DEFAULT_CHF_PER_USD;
        const project = await store.project.get(task.project_id);
        if (!project) throw new Error("the task's project is gone");
        const now = project.settings?.[SESSION_CAP_KEY];
        const current = typeof now === "number" && now > 0 ? now : 0;
        const raisesProject = answer === "raise_session";
        const amount = raisesProject ? Math.max(current, promised) : promised;
        const taskBudget = raisesProject
          ? task.budget_usd_micro
          : Math.max(task.budget_usd_micro, task.actual_cost_usd_micro + promised);
        await store.transaction(async (tx) => {
          if (raisesProject) {
            const fresh = await tx.project.mustGet(project.id);
            await tx.project.patch(project.id, {
              settings: {
                ...(fresh.settings ?? {}),
                [SESSION_CAP_KEY]: amount,
                [SESSION_CAP_CHF_KEY]: usdToChfMicro(amount, rate),
              },
            });
          } else await tx.task.patch(task.id, { budget_usd_micro: taskBudget });
          const fresh = await tx.task.mustGet(task.id);
          await tx.task.transition(
            fresh.id,
            fresh.version,
            "ready",
            raisesProject
              ? `you raised the budget per session to ${chfText(amount, rate)} in the Inbox`
              : `you gave it one session of ${chfText(amount, rate)} in the Inbox`,
            actor,
          );
        });
        await finish(raisesProject ? "raise_session" : "raise", {
          ...(raisesProject ? { session_cap_usd_micro_set: amount } : {}),
          budget_usd_micro: raisesProject ? amount : taskBudget,
        });
        out.raised++;
        await recordStart(
          store,
          row.id,
          await resumeWork(store, deps.start, {
            agentId: deps.agentId,
            projectId: task.project_id,
            reason: raisesProject
              ? `you raised the budget per session for "${task.title}"`
              : `you gave "${task.title}" a bigger session`,
            // The session it starts has the amount the button named, either way.
            budgetUsdMicro: amount,
          }),
        );
      } else if (answer === "raise" || answer === "raise_session") {
        const promised = typeof card.raise_to_usd_micro === "number" ? card.raise_to_usd_micro : 0;
        const budget = Math.max(task.budget_usd_micro, promised);
        const rate = typeof card.chf_per_usd === "number" ? card.chf_per_usd : DEFAULT_CHF_PER_USD;
        await store.transaction(async (tx) => {
          await tx.task.patch(task.id, { budget_usd_micro: budget });
          const fresh = await tx.task.mustGet(task.id);
          await tx.task.transition(
            fresh.id,
            fresh.version,
            "ready",
            `you raised its budget to ${chfText(budget, rate)} in the Inbox`,
            actor,
          );
        });
        await finish("raise", { budget_usd_micro: budget });
        out.raised++;
        await recordStart(
          store,
          row.id,
          await resumeWork(store, deps.start, {
            agentId: deps.agentId,
            projectId: task.project_id,
            reason: `you raised the budget of "${task.title}"`,
          }),
        );
      } else {
        await store.task.transition(
          task.id,
          task.version,
          "cancelled",
          sessionCard
            ? `you cancelled it in the Inbox when it needed more than a session's budget (request ${row.id})`
            : `you cancelled it in the Inbox when it stopped at its budget (request ${row.id})`,
          actor,
        );
        await finish("cancel");
        out.cancelled++;
      }
    } catch (e) {
      logger.warn("budget card answer not applied", {
        requestId: row.id,
        error: errorMessage(e),
      });
    }
  }
  return out;
}
