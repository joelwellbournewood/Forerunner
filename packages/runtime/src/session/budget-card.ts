import { DEFAULT_CHF_PER_USD, formatChf, usdToChfMicro } from "@forerunner/billing";
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
  return stop.source === "task_budget"
    ? `${title} stopped at its budget of ${chfText(stop.capUsdMicro, rate)}`
    : `${title} stopped at the ${stop.specialist}'s limit of ${chfText(stop.capUsdMicro, rate)} per run`;
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
    try {
      if (answer === "raise") {
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
          `you cancelled it in the Inbox when it stopped at its budget (request ${row.id})`,
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
