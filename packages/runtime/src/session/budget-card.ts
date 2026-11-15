import { chfToUsdMicro, DEFAULT_CHF_PER_USD, formatChf, usdToChfMicro } from "@forerunner/billing";
import { saidByName } from "@forerunner/critic";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type {
  HumanRequestRow,
  JsonObject,
  SessionRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import { ANSWER_CARD_KEYS, answerNote, budgetStopAnswer } from "../wiring/request-answers.ts";
import type { BudgetStopSource, RunHandoff } from "./budget-pause.ts";
import { unappliedAnswers } from "./findings.ts";
import { moneyWords } from "./money-words.ts";
import { noteAboutTask, recordStart, resumeWork, type StartPort } from "./resume-work.ts";
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
 *
 * d1109-oversize-pause (OP-6; the owner's "the work can be continued in the next run"): at the
 * session's budget, what lets what is left of the task's estimate (`estimateLeftUsdMicro`, the
 * card's `estimate_left_usd_micro`) fit the session Continue starts, its work budget being its
 * cap less the review reserve: the estimate left divided by one less the reserve share, and never
 * less than the same amount again; a card without an estimate left (one filed before) as before.
 * Before, the whole estimate again at least, whatever the task had already done. At the task's
 * own budget or its specialist's limit, unchanged.
 */
export function continueUsdMicro(
  task: Pick<TaskRow, "est_cost_usd_micro">,
  stop: Pick<BudgetStop, "capUsdMicro" | "source">,
  rate: number = DEFAULT_CHF_PER_USD,
  floor: { estimateLeftUsdMicro?: number | null; reserveShare?: number } = {},
): number {
  const same = offersContinue(stop.source) ? Math.max(0, stop.capUsdMicro) : 0;
  const left = floor.estimateLeftUsdMicro;
  const reserve = floor.reserveShare ?? CONTINUE_RESERVE_SHARE;
  const usd =
    stop.source === "session" && typeof left === "number" && left > 0
      ? Math.max(same, Math.ceil(left / (1 - reserve)))
      : Math.max(same, Math.max(0, task.est_cost_usd_micro));
  const room = usdToChfMicro(usd, rate);
  const steps = Math.max(1, Math.ceil(room / CONTINUE_STEP_CHF_MICRO));
  return chfToUsdMicro(steps * CONTINUE_STEP_CHF_MICRO, rate);
}

/**
 * The review reserve a session Continue starts keeps (the runner's `DEFAULT_RESERVE_SHARE`, a
 * fifth), for Continue's floor (OP-6); a number here so the card's words need no runner import.
 */
export const CONTINUE_RESERVE_SHARE = 0.2;

/** W15-74: a limit or an amount under a centime reads "less than CHF 0.01", never "CHF 0.00". */
const chfText = (usdMicro: number, rate: number) => {
  const chfMicro = usdToChfMicro(Math.max(0, Math.round(usdMicro)), rate);
  return moneyWords(formatChf(chfMicro), chfMicro);
};

/** "Continue (CHF 0.40 more)": the card's main button. */
export function continueLabel(moreUsdMicro: number, rate: number): string {
  return `Continue (${chfText(moreUsdMicro, rate)} more)`;
}

/**
 * '"X" paused at its budget of CHF 0.40' (the card's title and the task's reason). A run that
 * heard the wrap-up paused before its limit ran out, and says so: '"X" paused before its budget
 * ran out' (live check 3, L3-research-2: the title said "paused at its budget of CHF 0.15" beside
 * the session's "paused before its budget of CHF 0.15 ran out: it spent CHF 0.09"). Its amounts
 * are the card's first sentence (`request-words.ts`), so the title, the task's reason and the
 * notification's title stay whole within 60 characters.
 */
export function budgetStopTitle(
  task: Pick<TaskRow, "title">,
  stop: Pick<BudgetStop, "capUsdMicro" | "source" | "specialist" | "stoppedBy">,
  rate: number,
): string {
  const title = `"${task.title.replace(/\s+/g, " ").trim()}"`;
  const chf = chfText(stop.capUsdMicro, rate);
  if (stop.stoppedBy === "wrap_up")
    switch (stop.source) {
      case "task_budget":
        return `${title} paused before its budget ran out`;
      case "specialist_limit":
        return `${title} paused before the ${saidByName(stop.specialist) ?? "specialist"}'s limit per run ran out`;
      case "session":
        return `${title} paused before this session's budget ran out`;
      default:
        break;
    }
  // The limit that stopped it (ADR 0112): before, every stop below the session's remainder was
  // "its budget" or the specialist's limit, whatever refused it.
  switch (stop.source) {
    case "task_budget":
      return `${title} paused at its budget of ${chf}`;
    case "specialist_limit":
      // W15-43: the specialist in words ("the writer"), never its registry key.
      return `${title} paused at the ${saidByName(stop.specialist) ?? "specialist"}'s limit of ${chf} per run`;
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

/**
 * A run's note and to-do list as the card keeps them: plain, data only, each item whole as the
 * handoff kept it (`parseHandoff` bounds them: 600 characters for the note, 200 an item, 20
 * items). Before (live check 3, L3-research-2), the note was cut at 160 characters and each item
 * at 80, mid-phrase ("Two pages define hint:…", "each listed page gives its…"), and no screen could
 * show them whole again; the card's words (`request-words.ts`) choose what to show.
 */
function cardHandoff(handoff: RunHandoff | null | undefined): { done: string; left: string[] } {
  const plain = (s: string) => s.replace(/\s+/g, " ").trim();
  return {
    done: plain(handoff?.stopped ?? ""),
    left: (handoff?.leftToDo ?? []).map(plain).filter(Boolean),
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
  /**
   * The specialist finished and only the critic's review waits for room (TR-14: a review a
   * limit refused, ADR 0112 point 6). The card then says the work is done, not that the run
   * stopped before it could say where it stood.
   */
  reviewWaits?: boolean;
  /** Now (ISO), for when a month's limit resets. */
  now?: string;
  /** The day's CHF per USD for the amounts on the card. */
  chfPerUsd?: number;
  /**
   * d1109-oversize-pause (OP-4): the pause got no further than the task's last one (the same
   * kept work, the same list): the card asks the person, and nothing makes the task ready by
   * itself (`wakeBudgetWaits` leaves it out; the runner does not run it again in the session).
   */
  noProgress?: boolean;
  /** OP-2: the names of the project's checks that passed and failed on the kept work. */
  keptChecks?: { passed: string[]; failed: string[] };
  /** OP-8, OP-6: the task's whole estimate at the pause, and what is left of it. */
  estimateUsdMicro?: number;
  estimateLeftUsdMicro?: number;
  /** L3-left-2: what the paused run itself spent (its card's figure at a limit per run). */
  runSpentUsdMicro?: number;
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
  const more = offersContinue(stop.source)
    ? continueUsdMicro(task, stop, rate, { estimateLeftUsdMicro: input.estimateLeftUsdMicro })
    : null;
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
      ...(input.reviewWaits ? { review_waits: true } : {}),
      // OP-8: one place per fact, what the card, the result and every screen read.
      ...(input.noProgress !== undefined ? { no_progress: input.noProgress } : {}),
      ...(input.keptChecks
        ? {
            kept_checks: {
              passed: [...input.keptChecks.passed],
              failed: [...input.keptChecks.failed],
            },
          }
        : {}),
      ...(input.estimateUsdMicro !== undefined
        ? { estimate_usd_micro: input.estimateUsdMicro }
        : {}),
      ...(input.estimateLeftUsdMicro !== undefined
        ? { estimate_left_usd_micro: input.estimateLeftUsdMicro }
        : {}),
      ...(input.runSpentUsdMicro !== undefined
        ? { run_spent_usd_micro: input.runSpentUsdMicro }
        : {}),
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
    // OP-4: the question after a pause that got no further, at an outer limit once it has room,
    // offers Continue too (no amount: the limit's own room).
    const question = card.question === true;
    const canContinue =
      question ||
      offersContinue(card.source) ||
      legacySession ||
      typeof card.raise_to_usd_micro === "number";
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
        // A question card at an outer limit adds nothing: Continue goes on in the limit's room.
        const outer = question && !offersContinue(card.source) && !legacySession;
        const more = outer
          ? 0
          : typeof card.continue_usd_micro === "number" || session
            ? named
            : Math.max(0, named - task.actual_cost_usd_micro);
        // The task's own budget grows by that much for a stop at its own limit; the session
        // that continues it gets that much for a stop at the session's budget.
        const budget =
          session || outer
            ? task.budget_usd_micro
            : Math.max(task.budget_usd_micro, task.actual_cost_usd_micro) + more;
        // OP-4: the person's note with Continue reaches the next brief, as a task note does.
        const note = answerNote(row.answer);
        await store.transaction(async (tx) => {
          if (budget !== task.budget_usd_micro)
            await tx.task.patch(task.id, { budget_usd_micro: budget });
          const fresh = await tx.task.mustGet(task.id);
          await tx.task.transition(
            fresh.id,
            fresh.version,
            "ready",
            outer
              ? "you said to go on in the Inbox: it continues from where it stopped"
              : `you gave it ${chfText(more, rate)} more in the Inbox: it continues from where it stopped`,
            actor,
          );
          if (note)
            await tx.queue.enqueue({
              project_id: fresh.project_id,
              human_id: deps.humanId,
              kind: "note",
              text: noteAboutTask(fresh, note),
              priority: 8,
              status: "queued",
              author_agent: deps.agentId,
            });
        });
        await finish("continue", { budget_usd_micro: budget, continued_usd_micro: more });
        out.continued++;
        await recordStart(
          store,
          row.id,
          await resumeWork(store, deps.start, {
            agentId: deps.agentId,
            projectId: task.project_id,
            reason: outer
              ? `you said "${task.title}" goes on`
              : `you gave "${task.title}" ${chfText(more, rate)} more`,
            ...(session && !outer ? { budgetUsdMicro: more } : {}),
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
    // A new month: the card's own date, else (none, or one not after the card was filed, as a
    // card filed without `now` would have) the month after the card was filed.
    const resets =
      typeof card.resets_at === "string" && card.resets_at > row.created_at
        ? card.resets_at
        : nextMonthStart(row.created_at);
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
    // d1109-oversize-pause (OP-4): a pause that got no further is never made ready by itself:
    // once its limit has room, the card becomes one question for the same pause (Continue with
    // a note, Cancel task), and nothing starts.
    if (card.no_progress === true) {
      if (card.question === true) continue;
      try {
        await askAfterNoProgress(store, row, card, clock.nowIso());
      } catch (e) {
        log("budget-card").warn("the question of a pause that got no further was not filed", {
          taskId: task.id,
          error: errorMessage(e),
        });
      }
      continue;
    }
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

/** `change_card.outcome` of a no-progress card the question for the same pause replaced (OP-4). */
export const ASKED_AGAIN_OUTCOME = "asked_again";

/**
 * OP-4: the outer limit a pause that got no further waited at has room again: its card is
 * withdrawn (`asked_again`) and one question card is filed for the same pause, with Continue (no
 * amount: the limit's own room; a note goes into the next brief) and Cancel task. In one
 * transaction; the task stays waiting.
 */
async function askAfterNoProgress(
  store: StateStore,
  row: HumanRequestRow,
  card: JsonObject,
  now: string,
): Promise<void> {
  await store.transaction(async (tx) => {
    const withdrawn = await tx.humanRequest.withdraw(row.id, row.version);
    await tx.humanRequest.patch(withdrawn.id, {
      change_card: { ...card, applied_at: now, outcome: ASKED_AGAIN_OUTCOME },
    });
    await tx.humanRequest.insert({
      human_id: row.human_id,
      project_id: row.project_id,
      task_id: row.task_id,
      session_id: row.session_id,
      kind: "approval",
      why: row.why,
      steps: [],
      options: [CONTINUE_OPTION, CANCEL_TASK_OPTION],
      blocking: true,
      risk: "medium",
      change_card: {
        ...card,
        question: true,
        asked_of: row.id,
        applied_at: null,
      },
      author_agent: row.author_agent ?? null,
    } as never);
  });
}

/** The question card's Continue (OP-4): no amount, at an outer limit. */
export const CONTINUE_OPTION = "Continue";

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

/**
 * d1109-oversize-pause (OP-0, "Continue next time"; the owner's answer 5 of 2026-11-09, "be able
 * to wrap up and continue next time", and D4, "continues from there in the next run"): a pause the
 * next session's start takes in its turn like any ready task. A pause at a session's work budget
 * (the card's source `session`, or the legacy `session_budget`) or at its specialist's limit per
 * run (`specialist_limit`, filed only for its session's last pause), whose pause got further
 * (`no_progress` not true, OP-4; a card filed before it has no such field and counts as progress).
 * Not taken: a pause at the task's own budget (that budget is used up: its Continue raises it), a
 * pause without progress (its question card first) and a pause at an outer limit (the project's
 * budget, this month's cap, the subscription's share: `wakeBudgetWaits`, then the next Start).
 */
export function continuesAtStart(card: Pick<HumanRequestRow, "change_card" | "status">): boolean {
  if (card.status !== "open" || keyOf(card) !== BUDGET_STOP_KEY) return false;
  const c = (card.change_card ?? {}) as JsonObject;
  if (c.no_progress === true) return false;
  return (
    c.source === "session" ||
    c.source === LEGACY_SESSION_BUDGET_SOURCE ||
    c.source === "specialist_limit"
  );
}

/**
 * The project's tasks a session's start takes in its turn from their kept work (OP-0): waiting on
 * an open budget card that `continuesAtStart`, still `needs_human`. In the order the ready tasks
 * are read (priority, then age), for the start's plan and the Start check alike.
 */
export async function continuableTasks(store: StateStore, projectId: string): Promise<TaskRow[]> {
  const cards = (
    await store.humanRequest.list({ project_id: projectId, status: "open" } as never, {
      limit: 500,
    })
  ).filter((r) => r.task_id && continuesAtStart(r));
  const out: TaskRow[] = [];
  for (const id of new Set(cards.map((r) => r.task_id as string))) {
    const task = await store.task.get(id);
    if (task?.status === "needs_human" && task.project_id === projectId) out.push(task);
  }
  return out.sort(
    (a, b) =>
      b.priority - a.priority ||
      a.created_at.localeCompare(b.created_at) ||
      a.id.localeCompare(b.id),
  );
}

/** `change_card.outcome` of a budget card a session's start went on from (OP-0). */
export const CLOSED_BY_START_OUTCOME = "went_on_at_start";

/**
 * The start that takes a paused task in its turn (OP-0) closes its card in the same transaction as
 * the task's move back to ready, adding money to no budget: the card is withdrawn with the outcome
 * `went_on_at_start`, the session and its start time (`started_session_time`, "14:05" in the
 * person's time zone, for the Done line 'Your session of 14:05 went on with it.'). False, and
 * nothing written, when the task or its card moved meanwhile (an answer, a cancel): the claim
 * that follows then sees the task as it is.
 */
export async function closeByStart(input: {
  store: StateStore;
  task: Pick<TaskRow, "id">;
  session: Pick<SessionRow, "id">;
  agentId: string;
  /** The session's start as the person reads it ("14:05"). */
  startTime: string;
  now: string;
}): Promise<boolean> {
  const { store } = input;
  return store.transaction(async (tx) => {
    const task = await tx.task.get(input.task.id);
    if (task?.status !== "needs_human") return false;
    const card = (
      await tx.humanRequest.list({ task_id: task.id, status: "open" } as never, { limit: 50 })
    ).find((r) => continuesAtStart(r));
    if (!card) return false;
    await tx.task.transition(
      task.id,
      task.version,
      "ready",
      "this session goes on with it from where it stopped",
      { agentId: input.agentId },
    );
    const withdrawn = await tx.humanRequest.withdraw(card.id, card.version);
    await tx.humanRequest.patch(withdrawn.id, {
      change_card: {
        ...((card.change_card ?? {}) as JsonObject),
        applied_at: input.now,
        outcome: CLOSED_BY_START_OUTCOME,
        started_session_id: input.session.id,
        started_session_time: input.startTime,
      },
    });
    return true;
  });
}
