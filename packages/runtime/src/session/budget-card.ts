import { chfToUsdMicro, DEFAULT_CHF_PER_USD, formatChf, usdToChfMicro } from "@forerunner/billing";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type {
  HumanRequestRow,
  JsonObject,
  SessionRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import { ANSWER_CARD_KEYS, budgetStopAnswer } from "../wiring/request-answers.ts";
import type { BudgetStopSource, RunHandoff } from "./budget-pause.ts";
import { unappliedAnswers } from "./findings.ts";
import { recordStart, resumeWork, type StartPort } from "./resume-work.ts";
import type { BudgetStop } from "./runner.ts";

/**
 * A paused task asks the person once (ADR 0112 amended by budget-resume, the owner's decision of
 * 2026-11-02): one card per pause, filed at the first stop of any kind, that names the real limit
 * and what the run did and left, with **Continue (CHF N more)** and **Cancel task**.
 *
 * - **Continue (CHF N more)** gives it the same amount again (at least its estimate): the task's
 *   budget grows by N for a stop at its own budget or its specialist's limit, and the session
 *   that continues it gets N for a stop at the session's budget. The session starts at once
 *   (`resumeWork` with `budgetUsdMicro`) and its brief starts from where the run stopped
 *   (`task-context.ts`, "Where the last run stopped"); its work in progress is a commit of its
 *   own (`PrTaskExecutor`).
 * - A stop at this month's cap, the project's budget or the subscription's share offers no
 *   Continue (raising the task's budget does not help there: the next session stopped at once at
 *   the same cap and filed the same card, the review of budget-stop): the card says where to
 *   change it (Settings) or when it resets, and the task goes on by itself once that limit
 *   changed and has room (`wakeBudgetWaits`, before every scheduler tick): raised or removed in
 *   Settings, or a new month. Room alone never wakes it (the review of budget-resume).
 * - **Cancel task** sets its work in progress aside (`setAside`, Undo or Reopen brings it back)
 *   and names the tasks that will be stuck.
 *
 * Before: '"X" stopped at its budget of CHF Y' with Raise the budget (a session that "tries
 * again") or Cancel task, the same offer for a month-cap stop, and a session-budget stop that
 * filed nothing the first time and a second card with three options the second (C-36).
 */
export const BUDGET_STOP_KEY = ANSWER_CARD_KEYS.budgetStop;
/** The card's Cancel option. */
export const CANCEL_TASK_OPTION = "Cancel task";
/** `change_card.source` of a card a session's budget filed before budget-resume (C-36). */
export const LEGACY_SESSION_BUDGET_SOURCE = "session_budget";
/** Continue adds whole steps of CHF 0.01 (what its button shows), at least one. */
const CONTINUE_STEP_CHF_MICRO = 10_000;

/** The limits whose card offers Continue: those a bigger budget lifts. */
export function offersContinue(source: unknown): boolean {
  return source === "task_budget" || source === "specialist_limit" || source === "session";
}

/**
 * How much Continue adds: the same amount again (the budget, the specialist's limit per run or
 * the session's budget it paused at), at least the task's estimate, in whole steps of CHF 0.01 so
 * the button says what it adds: a task paused at its budget of CHF 0.01 gets "Continue (CHF 0.01
 * more)" (rounding in USD steps made that CHF 0.02).
 */
export function continueUsdMicro(
  task: Pick<TaskRow, "est_cost_usd_micro">,
  stop: Pick<BudgetStop, "capUsdMicro" | "source">,
  rate: number = DEFAULT_CHF_PER_USD,
): number {
  const same = offersContinue(stop.source) ? Math.max(0, stop.capUsdMicro) : 0;
  const room = usdToChfMicro(Math.max(same, Math.max(0, task.est_cost_usd_micro)), rate);
  const steps = Math.max(1, Math.ceil(room / CONTINUE_STEP_CHF_MICRO));
  return chfToUsdMicro(steps * CONTINUE_STEP_CHF_MICRO, rate);
}

const chfText = (usdMicro: number, rate: number) =>
  formatChf(usdToChfMicro(Math.max(0, Math.round(usdMicro)), rate));

/** "Continue (CHF 0.40 more)": the card's main button. */
export function continueLabel(moreUsdMicro: number, rate: number): string {
  return `Continue (${chfText(moreUsdMicro, rate)} more)`;
}

/** '"X" paused at its budget of CHF 0.40' (the card's title and the task's reason). */
export function budgetStopTitle(
  task: Pick<TaskRow, "title">,
  stop: Pick<BudgetStop, "capUsdMicro" | "source" | "specialist">,
  rate: number,
): string {
  const title = `"${task.title.replace(/\s+/g, " ").trim()}"`;
  const chf = chfText(stop.capUsdMicro, rate);
  // The limit that stopped it (ADR 0112): before, every stop below the session's remainder was
  // "its budget" or the specialist's limit, whatever refused it.
  switch (stop.source) {
    case "task_budget":
      return `${title} paused at its budget of ${chf}`;
    case "specialist_limit":
      return `${title} paused at the ${stop.specialist}'s limit of ${chf} per run`;
    case "session":
      return `${title} paused at this session's budget of ${chf}`;
    case "project":
      return `${title} paused at the project's budget of ${chf}`;
    case "month":
      return `${title} paused at this month's cap of ${chf}`;
    case "plan":
      // The plan level's cap is a share of the subscription, never an amount (budget-stop).
      return `${title} paused at the share of your Claude subscription that Forerunner may use`;
  }
}

/** The first moment of the month after `nowIso` (UTC): when a month's cap and share reset. */
export function nextMonthStart(nowIso: string): string {
  const d = new Date(nowIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/** A run's note and to-do list as the card keeps them: plain, short, data only. */
function cardHandoff(handoff: RunHandoff | null | undefined): { done: string; left: string[] } {
  const plain = (s: string, n: number) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
  };
  return {
    done: plain(handoff?.stopped ?? "", 160),
    left: (handoff?.leftToDo ?? []).slice(0, 5).map((t) => plain(t, 80)),
  };
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
  /** The run's "Where I stopped" and "Left to do" (data), when it wrote them. */
  handoff?: RunHandoff | null;
  /** Now (ISO), for when a month's limit resets. */
  now?: string;
  /** The day's CHF per USD for the amounts on the card. */
  chfPerUsd?: number;
}

function keyOf(r: Pick<HumanRequestRow, "change_card">): string | undefined {
  const key = (r.change_card as JsonObject | null)?.key;
  return typeof key === "string" ? key : undefined;
}

/** File (or reuse) the one card of a paused task. */
export async function fileBudgetStopCard(
  input: BudgetStopCardInput,
): Promise<{ request: HumanRequestRow; reused: boolean }> {
  const { store, task, stop } = input;
  const open = (
    await store.humanRequest.list({ task_id: task.id, status: "open" } as never, { limit: 50 })
  ).find((r) => keyOf(r) === BUDGET_STOP_KEY);
  if (open) return { request: open, reused: true };
  const rate = input.chfPerUsd ?? DEFAULT_CHF_PER_USD;
  const more = offersContinue(stop.source) ? continueUsdMicro(task, stop, rate) : null;
  const title = budgetStopTitle(task, stop, rate);
  const left = cardHandoff(input.handoff);
  const request = await store.humanRequest.insert({
    human_id: input.humanId,
    project_id: task.project_id,
    task_id: task.id,
    session_id: input.session?.id ?? null,
    kind: "approval",
    // Design §3.8, §5: one sentence; the options say what they do.
    why: `${title}.`,
    steps: [],
    options: more !== null ? [continueLabel(more, rate), CANCEL_TASK_OPTION] : [CANCEL_TASK_OPTION],
    blocking: true,
    risk: "medium",
    change_card: {
      key: BUDGET_STOP_KEY,
      task_id: task.id,
      task_title: task.title,
      title,
      run_id: input.runId,
      source: stop.source,
      specialist: stop.specialist,
      cap_usd_micro: stop.capUsdMicro,
      spent_usd_micro: stop.spentUsdMicro,
      continue_usd_micro: more,
      stopped_by: stop.stoppedBy ?? input.handoff?.stoppedBy ?? "budget",
      done: left.done,
      left: left.left,
      ...(stop.source === "month" || stop.source === "plan"
        ? { resets_at: nextMonthStart(input.now ?? new Date(0).toISOString()) }
        : {}),
      chf_per_usd: rate,
      applied_at: null,
    },
    author_agent: input.agentId,
  });
  return { request, reused: false };
}

export interface BudgetStopSyncResult {
  continued: number;
  cancelled: number;
  /** Answered cards whose task had moved on, or whose answer was not one of the options. */
  skipped: number;
}

/** What a cancel did with the task's work (`PrTaskExecutor.setAsideWork`). */
export type SetAsidePort = (task: TaskRow) => Promise<{ files: string[]; kept: string | null }>;

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
  /** Cancel task sets the work in progress aside (budget-resume); absent: it stays. */
  setAside?: SetAsidePort;
}): Promise<BudgetStopSyncResult> {
  const logger = log("budget-card");
  const { store, clock } = deps;
  const out: BudgetStopSyncResult = { continued: 0, cancelled: 0, skipped: 0 };
  for (const row of await unappliedAnswers(store, deps.humanId, BUDGET_STOP_KEY)) {
    const card = (row.change_card ?? {}) as JsonObject;
    const finish = (outcome: string, extra: JsonObject = {}) =>
      store.humanRequest.patch(row.id, {
        change_card: { ...card, applied_at: clock.nowIso(), outcome, ...extra },
      });
    const answer = budgetStopAnswer(row.answer);
    const task = row.task_id ? await store.task.get(row.task_id) : undefined;
    const legacySession = card.source === LEGACY_SESSION_BUDGET_SOURCE;
    const canContinue =
      offersContinue(card.source) || legacySession || typeof card.raise_to_usd_micro === "number";
    if (
      !answer ||
      !task ||
      task.status !== "needs_human" ||
      (answer === "continue" && !canContinue)
    ) {
      out.skipped++;
      await finish(!answer || answer === "continue" ? "unrecognized_answer" : "task_moved_on");
      continue;
    }
    const actor = { agentId: deps.agentId, humanId: deps.humanId };
    const rate = typeof card.chf_per_usd === "number" ? card.chf_per_usd : DEFAULT_CHF_PER_USD;
    try {
      if (answer === "continue") {
        // How much more: the amount the button named; a card of before budget-resume named the
        // budget to set (`raise_to_usd_micro`), which counts from what it spent.
        const named =
          typeof card.continue_usd_micro === "number"
            ? card.continue_usd_micro
            : typeof card.raise_to_usd_micro === "number"
              ? card.raise_to_usd_micro
              : 0;
        const session = card.source === "session" || legacySession;
        const more =
          typeof card.continue_usd_micro === "number" || session
            ? named
            : Math.max(0, named - task.actual_cost_usd_micro);
        // The task's own budget grows by that much for a stop at its own limit; the session
        // that continues it gets that much for a stop at the session's budget.
        const budget = session
          ? task.budget_usd_micro
          : Math.max(task.budget_usd_micro, task.actual_cost_usd_micro) + more;
        await store.transaction(async (tx) => {
          if (budget !== task.budget_usd_micro)
            await tx.task.patch(task.id, { budget_usd_micro: budget });
          const fresh = await tx.task.mustGet(task.id);
          await tx.task.transition(
            fresh.id,
            fresh.version,
            "ready",
            `you gave it ${chfText(more, rate)} more in the Inbox: it continues from where it stopped`,
            actor,
          );
        });
        await finish("continue", { budget_usd_micro: budget, continued_usd_micro: more });
        out.continued++;
        await recordStart(
          store,
          row.id,
          await resumeWork(store, deps.start, {
            agentId: deps.agentId,
            projectId: task.project_id,
            reason: `you gave "${task.title}" ${chfText(more, rate)} more`,
            ...(session ? { budgetUsdMicro: more } : {}),
          }),
        );
      } else {
        await store.task.transition(
          task.id,
          task.version,
          "cancelled",
          `you cancelled it in the Inbox when it paused at a budget (request ${row.id})`,
          actor,
        );
        // Its work in progress goes out of the way (Undo or Reopen brings it back); a failure
        // leaves the files where they are and is said in the log.
        let aside: { files: string[]; kept: string | null } = { files: [], kept: null };
        if (deps.setAside)
          aside = await deps.setAside(await store.task.mustGet(task.id)).catch((e: unknown) => {
            logger.warn("the cancelled task's work was not set aside", {
              taskId: task.id,
              error: errorMessage(e),
            });
            return { files: [], kept: null };
          });
        await finish("cancel", {
          set_aside: aside.files.length,
          ...(aside.kept ? { kept: aside.kept } : {}),
        });
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

/** An outer limit as it is now, in USD micro-units; `Number.POSITIVE_INFINITY` when none is set. */
export type LimitNowPort = (source: "project" | "month", projectId: string) => Promise<number>;

/**
 * Whether the limit a card names changed since the pause, as its card says it goes on: the
 * project's budget or this month's cap was raised (or removed) in Settings, or a new month (the
 * month's cap, the subscription's share) began. Room alone is not a change: a pause at an outer
 * limit comes when the next call's worst case would reach the limit, which can leave the spend
 * under its 80% line, where room was always there (the review of budget-resume: every scheduler
 * tick woke the task and a session paused again at once, with nothing changed).
 */
async function limitChanged(
  row: Pick<HumanRequestRow, "created_at">,
  card: JsonObject,
  projectId: string,
  now: string,
  limitNow: LimitNowPort,
): Promise<boolean> {
  const source = card.source;
  if (source !== "project" && source !== "month" && source !== "plan") return false;
  if (source !== "project") {
    // A new month: the card's own date, else the month after the card was filed.
    const resets =
      typeof card.resets_at === "string" ? card.resets_at : nextMonthStart(row.created_at);
    if (now >= resets) return true;
    if (source === "plan") return false;
  }
  const cap = card.cap_usd_micro;
  if (typeof cap !== "number") return false;
  return (await limitNow(source, projectId)) > cap;
}

/**
 * The cards of tasks paused at this month's cap, the project's budget or the subscription's
 * share (budget-resume): each goes on by itself once its limit changed and has room (the person
 * raised it in Settings, or the month changed), as its card says. The card is closed with the
 * outcome `went_on`, the task goes back to ready and a session of its project is asked for.
 * Before, the card offered Raise the budget, and the session that started stopped at once at the
 * same cap. Returns how many went on.
 */
export async function wakeBudgetWaits(deps: {
  store: StateStore;
  clock: Clock;
  humanId: string;
  agentId: string;
  /** The project's budget or this month's cap now, to see whether the person changed it. */
  limitNow: LimitNowPort;
  /**
   * Whether work of the project may spend again under the month's cap and its own budget,
   * asked only once the limit changed (the caps read again, not from a minute's cache).
   */
  roomFor: (projectId: string) => Promise<boolean>;
  start?: StartPort;
}): Promise<number> {
  const { store, clock } = deps;
  const cards = (await store.humanRequest.open({ humanId: deps.humanId }, { limit: 500 })).filter(
    (r) => {
      const source = (r.change_card as JsonObject | null)?.source;
      return (
        keyOf(r) === BUDGET_STOP_KEY &&
        !offersContinue(source) &&
        source !== LEGACY_SESSION_BUDGET_SOURCE
      );
    },
  );
  let wentOn = 0;
  const projects = new Set<string>();
  for (const row of cards) {
    const card = (row.change_card ?? {}) as JsonObject;
    const task = row.task_id ? await store.task.get(row.task_id) : undefined;
    if (task?.status !== "needs_human") continue;
    const changed = await limitChanged(
      row,
      card,
      task.project_id,
      clock.nowIso(),
      deps.limitNow,
    ).catch(() => false);
    if (!changed) continue;
    // The subscription's share is not money: its new month is its room.
    if (card.source !== "plan" && !(await deps.roomFor(task.project_id).catch(() => false)))
      continue;
    try {
      const fresh = await store.humanRequest.withdraw(row.id, row.version);
      await store.humanRequest.patch(fresh.id, {
        change_card: { ...card, applied_at: clock.nowIso(), outcome: "went_on" },
      });
      await store.task.transition(
        task.id,
        task.version,
        "ready",
        "its limit has room again: it continues from where it stopped",
        { agentId: deps.agentId },
      );
      projects.add(task.project_id);
      wentOn++;
    } catch (e) {
      log("budget-card").warn("a paused task did not go on", {
        taskId: task.id,
        error: errorMessage(e),
      });
    }
  }
  for (const projectId of projects)
    await resumeWork(store, deps.start, {
      agentId: deps.agentId,
      projectId,
      reason: "a limit a task paused at has room again",
    });
  return wentOn;
}

/** The limit a card names, for a paused task's row and the session's result. */
export function budgetCardSource(card: { change_card?: unknown }): BudgetStopSource | null {
  const source = (card.change_card as JsonObject | null)?.source;
  switch (source) {
    case "task_budget":
    case "specialist_limit":
    case "session":
    case "project":
    case "month":
    case "plan":
      return source;
    case LEGACY_SESSION_BUDGET_SOURCE:
      return "session";
    default:
      return null;
  }
}
