import { formatChf, usdToChfMicro } from "@forerunner/billing";
import type { StartCheck } from "../session/start-check.ts";
import type { StartCheckView } from "./api-types.ts";
import {
  type ChfAmount,
  leftOutSentence,
  oversizedAsk,
  oversizedSentence,
} from "./oversize-words.ts";
import { money } from "./views.ts";

/**
 * The Start check's facts about a task larger than one session, as the routes and the chat say
 * them (d1109-oversize-start, D4): CHF at the day's rate, every sentence from
 * `oversize-words.ts`. One place for `GET /projects/:id/start-check` and the chat's read-back.
 */

/** A USD micro amount as the sentences take it: CHF at the rate, with its text. */
export function chfAmountOf(usdMicro: number, chfPerUsd: number): ChfAmount {
  const chfMicro = usdToChfMicro(Math.max(0, Math.round(usdMicro)), chfPerUsd);
  return { chfMicro, text: formatChf(chfMicro) };
}

/** `StartCheckView.oversized`: the larger task the session takes, with its warning; or null. */
export function oversizedView(check: StartCheck, chfPerUsd: number): StartCheckView["oversized"] {
  const o = check.oversized;
  if (!o) return null;
  const at = (n: number) => chfAmountOf(n, chfPerUsd);
  return {
    taskId: o.taskId,
    title: o.title,
    estimate: money(o.estimateUsdMicro, chfPerUsd),
    room: money(o.roomUsdMicro, chfPerUsd),
    after: o.after,
    ...(o.spentUsdMicro ? { spent: money(o.spentUsdMicro, chfPerUsd) } : {}),
    sentence: oversizedSentence({
      title: o.title,
      estimate: at(o.estimateUsdMicro),
      workBudget: at(check.workBudgetUsdMicro),
      room: o.after ? at(o.roomUsdMicro) : null,
      spent: o.spentUsdMicro ? at(o.spentUsdMicro) : null,
    }),
  };
}

/** `StartCheckView.overBudget`: each task left out of the work that fits, with why and its sentence. */
export function overBudgetView(check: StartCheck, chfPerUsd: number): StartCheckView["overBudget"] {
  const at = (n: number) => chfAmountOf(n, chfPerUsd);
  const big = oversizedView(check, chfPerUsd);
  return check.overBudget.map((t) => {
    const why = t.reason ?? "after_others";
    return {
      taskId: t.taskId,
      title: t.title,
      estimate: money(t.estimateUsdMicro, chfPerUsd),
      // C-45 (polish-screens): what the tasks before each left-out one take.
      ...(t.aheadUsdMicro !== undefined ? { ahead: money(t.aheadUsdMicro, chfPerUsd) } : {}),
      why,
      sentence:
        why === "oversized" && big
          ? big.sentence
          : leftOutSentence(why === "oversized" ? "no_room" : why, {
              title: t.title,
              estimate: at(t.estimateUsdMicro),
              workBudget: at(check.workBudgetUsdMicro),
              ahead: at(t.aheadUsdMicro ?? 0),
            }),
    };
  });
}

/**
 * The chat's warning after its "Start a session on Shop (up to CHF 5.00)?" (OS-6): '"Build the
 * shop" needs more than its work budget of CHF 4.00: it pauses with its work kept and asks you to
 * continue.' Null when the session would take no task larger than its work budget.
 */
export function oversizedWarning(check: StartCheck, chfPerUsd: number): string | null {
  if (!check.oversized) return null;
  return oversizedAsk(check.oversized.title, chfAmountOf(check.workBudgetUsdMicro, chfPerUsd));
}
