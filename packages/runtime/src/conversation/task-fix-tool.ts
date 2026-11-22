import { DEFAULT_CHF_PER_USD } from "@forerunner/billing";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { ProjectRow, StateStore } from "@forerunner/state";
import { z } from "zod";
import type { ToolSpec } from "../agent/tools.ts";
import type { AutonomyLevel } from "../enforcement/autonomy.ts";
import { SessionBudget } from "../enforcement/budget.ts";
import type {
  CommandCallLike,
  CommandResultView,
  CommandTurn,
  ConversationCommands,
} from "../loop/ports.ts";
import { chfText } from "../money-words.ts";
import { clockTime } from "../session/credential-wait.ts";
import { shortStoppedPhrase } from "../session/credential-words.ts";
import { moneyWords } from "../session/money-words.ts";
import {
  applyTaskChanges,
  type ChangeRunResult,
  type CheckQuote,
  callsOf,
  fenceTaskChanges,
  makesFixesAtOnce,
  quotedPhrase,
  type RefusedChange,
  runTaskCheck,
  TASK_CHECK_TIMEOUT_MS,
  type TaskCheckDeps,
  taskCheckRunning,
  withTaskCheckLock,
} from "../session/task-check.ts";
import { keptNotesOf, takeNotes } from "../session/task-list-notes.ts";
import { proposalLine } from "../session/task-proposal.ts";
import {
  FIX_NEEDS_CLAUDE,
  fixAsk,
  fixBusyReply,
  fixChangedReply,
  fixCheckingStep,
  fixCostFooter,
  fixFailedReply,
  fixHeldReply,
  fixLeftOut,
  fixNoChangeReply,
  fixNoRoomReply,
  fixUnreadableReply,
} from "./sentences.ts";

const logger = log("chat-fix-tasks");

/**
 * d1109-selftasks-chat (ADR 0119, the owner's D7 of 2026-11-09: "I would also like that being
 * talking to the agent would also allow the agent to have dynamic control over its tasks"):
 * "fix the tasks" from chat runs the agent's own task check (d1109-selftasks-run's call, fence
 * and commands, unchanged), with the person's message of that turn as the request and the notes
 * kept on the project as the evidence; the project's autonomy decides what happens to the
 * changes: from Standard up each is made at once as the agent's own, one Changes row and one
 * Undo each, with no Inbox line; at Advisor and Assisted, when the fence asks first, or in a turn
 * whose lookups returned records (`CommandTurn.recordsRead`), the set is read back once as one
 * question with Yes and No.
 */

/** The tool's name (the chat model's tool list). */
export const FIX_TASKS_TOOL = "fix_tasks";

/** The tool's definition, as the chat model receives it (model-facing text is code). */
export const FIX_TASKS_DESCRIPTION =
  "Check this project's task list and fix it: split a task that is too big, add a missing step, change what waits for what, drop a duplicate, correct wording. Use it when the person asks you to fix, tidy or check the tasks; their message is passed to the check as it is. The project's autonomy decides whether the changes are made at once or read back for a yes.";

/** The person's message as the check's request is at most this long (ADR 0119). */
export const FIX_TASKS_REQUEST_MAX = 500;

/** What compose gives chat to fix the tasks with; absent: no Claude, so no check. */
export interface ChatTaskFixDeps {
  /** The task check's deps: the runner's (the planning call routed as the intake's). */
  check: TaskCheckDeps;
  /** The room the project's budget and the month cap leave (the chat's own `chatRoom`). */
  room?(scope: {
    humanId: string;
    projectId: string | null;
  }): Promise<{ usdMicro: number; level: "project" | "month" | "plan" } | null>;
  chfPerUsd?(): number;
}

export interface ChatTaskFixInput {
  store: StateStore;
  clock: Clock;
  commands: Pick<ConversationCommands, "planFix">;
  deps: ChatTaskFixDeps | undefined;
  project: ProjectRow;
  /** The person's message of this turn, as they wrote it (never text the model wrote). */
  request: string;
  turn: CommandTurn;
  /** The person's time zone, for "until 15:40". */
  timezone: string;
  /** The waiting line ("Checking the tasks of Quote page…"). */
  onStep?(line: string): void;
}

export interface ChatTaskFixResult {
  /** The reply's sentences (one to three, design §5). */
  reply: string;
  /** The changes made (each with its Undo) or the one read-back waiting for a yes. */
  results: CommandResultView[];
  /** What the check cost (booked to the project; 0 when no call was made). */
  costUsdMicro: number;
  /** The line under the reply: what the check cost. */
  footer: string | null;
  /** A reply about the app (no change, no answer): "make this a task" skips it. */
  notice: boolean;
}

/**
 * l4-selftasks-103 (ADR 0119 point 4): the reply says a line was left out; the line itself is
 * quoted only in the footer under it (`fixQuoteFooter`), which never goes back to a model (the
 * reply's text does, as the conversation's history), so a flagged line never reaches one.
 */
export const FIX_LEFT_OUT_SAID = "One line read like an instruction and was left out.";

/** The footer's sentence that quotes what the check left out ('A line of the report …("…").'). */
export function fixQuoteFooter(quotes: readonly CheckQuote[]): string {
  const first = quotes[0];
  if (!first) return "";
  const phrase = quotedPhrase(first);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`;
}

/** The person's words as the check's request: verbatim, cut at `FIX_TASKS_REQUEST_MAX`. */
export function fixRequestOf(text: string): string {
  return text.trim().slice(0, FIX_TASKS_REQUEST_MAX);
}

/** One fix of a project's task list from chat (the parser's line or the fix_tasks tool). */
export async function fixTasksInChat(input: ChatTaskFixInput): Promise<ChatTaskFixResult> {
  const { store, clock, project, turn } = input;
  const nothing = (reply: string, extra: Partial<ChatTaskFixResult> = {}): ChatTaskFixResult => ({
    reply,
    results: [],
    costUsdMicro: 0,
    footer: null,
    notice: true,
    ...extra,
  });
  const deps = input.deps;
  if (!deps || !input.commands.planFix || !deps.check.provider()) return nothing(FIX_NEEDS_CLAUDE);
  // One check of a project at a time (the session's boundary check holds the same lock).
  if (taskCheckRunning(project.id)) return nothing(fixBusyReply(project.name));
  const rate = deps.chfPerUsd?.() ?? DEFAULT_CHF_PER_USD;
  const money = (usd: number) => moneyWords(chfText(usd, rate), usd);
  const footerOf = (usd: number) => (usd > 0 ? fixCostFooter(money(usd)) : null);
  const room = await deps.room?.({ humanId: turn.humanId, projectId: project.id }).catch((e) => {
    logger.warn("the room for the task check was not read", { error: errorMessage(e) });
    return null;
  });
  const roomUsdMicro = room ? Math.max(0, room.usdMicro) : Number.MAX_SAFE_INTEGER;
  const session = await store.session.mustGet(turn.sessionId);
  // The check's own budget: what the room leaves (the hooks refuse a call past it and past the
  // project's budget and the month cap in any case).
  const budget = new SessionBudget({
    sessionId: session.id,
    budgetUsdMicro: Math.min(roomUsdMicro, Number.MAX_SAFE_INTEGER),
    stepCap: 8,
    deadlineMs: clock.now() + TASK_CHECK_TIMEOUT_MS + 60_000,
    reserveShare: 0,
  });
  // Asked again with no await before the lock is taken: a second request that arrived while the
  // room and the session were read would otherwise wait for this check and pay for another
  // (review of d1109-selftasks-chat).
  if (taskCheckRunning(project.id)) return nothing(fixBusyReply(project.name));
  input.onStep?.(fixCheckingStep(project.name));
  return withTaskCheckLock(project.id, async () => {
    const fresh = (await store.project.get(project.id)) ?? project;
    const notes = keptNotesOf(fresh);
    const run = await runTaskCheck(deps.check, {
      session,
      budget,
      agentId: turn.agentId,
      ownerHumanId: turn.humanId,
      project: fresh,
      notes,
      roomUsdMicro,
      request: fixRequestOf(input.request),
    });
    if (run.status === "not_made") {
      if (run.reason === "no_provider") return nothing(FIX_NEEDS_CLAUDE);
      if (run.reason === "no_room") return nothing(fixNoRoomReply(room?.level ?? "project"));
      // SC-14 (D5): the person's policy holds the call: no call, nothing booked, the notes kept.
      const wait = run.wait;
      const until = wait?.until ? clockTime(wait.until, input.timezone, clock.now()) : null;
      return nothing(
        fixHeldReply(
          wait ? shortStoppedPhrase(wait, until) : "your Claude credential cannot serve now",
        ),
      );
    }
    const cost = run.costUsdMicro;
    if (run.status === "failed")
      return nothing(fixFailedReply(fresh.name), { costUsdMicro: cost, footer: footerOf(cost) });
    if (!run.reply.ok)
      return nothing(fixUnreadableReply(fresh.name), {
        costUsdMicro: cost,
        footer: footerOf(cost),
      });
    const now = (await store.project.get(project.id)) ?? fresh;
    const fence = await fenceTaskChanges(store, {
      project: now,
      reply: run.reply,
      notes,
      addedThisSession: 0,
      specialists: deps.check.specialists(),
    });
    // The kept notes were checked once: they leave the project.
    if (notes.length) await takeNotes(store, project.id);
    // l4-selftasks-103: what the check left out is quoted under the reply, with its cost.
    const quoted = fixQuoteFooter(fence.quotes);
    const footer = joined(quoted, footerOf(cost) ?? "") || null;
    if (!fence.changes.length)
      return nothing(
        joined(
          fixNoChangeReply(now.name),
          fixLeftOut(fence.refused),
          quoted ? FIX_LEFT_OUT_SAID : "",
        ),
        { costUsdMicro: cost, footer },
      );
    const level = now.autonomy_level as AutonomyLevel;
    const askFirst = fence.askFirst.length > 0;
    const readBack = !!turn.recordsRead || !makesFixesAtOnce(level) || askFirst;
    const planFix = (input.commands.planFix as NonNullable<ConversationCommands["planFix"]>).bind(
      input.commands,
    );
    if (readBack) {
      // One read-back for the whole set (every change's calls worked out before any is made).
      const planned: CommandCallLike[][] = [];
      for (const f of fence.changes) {
        const calls = await callsOf(store, now, f);
        if (calls.length) planned.push(calls);
      }
      // l4-selftasks-113 (live check 4, L4-selftasks-18): why it asks first is said only where
      // the ask-first rule caused the read-back: at a level that would make the changes at once
      // and with no records read (before, every read-back at Assisted carried it).
      const reasons =
        askFirst && makesFixesAtOnce(level) && !turn.recordsRead
          ? fence.askFirst.filter((a) => !a.quote).map((a) => a.reason)
          : [];
      const ask = fixAsk(
        now.name,
        fence.changes.map((f) => proposalLine(f)),
      );
      const [r] = await planFix(planned, turn, {
        level,
        readBack: true,
        ...(askFirst ? { askFirst: true } : {}),
        ...(fence.changes.length > 1 ? { ask } : {}),
      });
      if (!r) return nothing(fixNoChangeReply(now.name), { costUsdMicro: cost, footer });
      if (r.status === "pending")
        return {
          // The read-back once (the card shows it with Yes and No); why it asks at a level that
          // would make the changes at once goes under it, with the check's cost.
          reply: r.readback ?? ask,
          results: [{ ...r, readback: r.readback ?? ask }],
          costUsdMicro: cost,
          footer: joined(reasons[0] ? `Asks you first: ${reasons[0]}.` : "", footer ?? "") || null,
          notice: false,
        };
      if (r.status === "done" || r.status === "partial")
        return {
          reply: fixChangedReply(fence.changes.length, now.name),
          results: [r],
          costUsdMicro: cost,
          footer,
          notice: false,
        };
      return nothing(
        joined(
          fixNoChangeReply(now.name),
          fixLeftOut([{ what: "the changes", reason: r.reason ?? "they were refused" }]),
        ),
        { costUsdMicro: cost, footer },
      );
    }
    // From Standard up, nothing that asks first: each change at once as the agent's own.
    const views: CommandResultView[] = [];
    const applied = await applyTaskChanges(
      store,
      {
        run: async (calls): Promise<ChangeRunResult> => {
          const [v] = await planFix([calls], turn, { level, readBack: false });
          if (v && (v.status === "done" || v.status === "partial") && v.changeLogId) {
            views.push(v);
            return { status: "done", changeLogId: v.changeLogId, sentence: v.sentence ?? "" };
          }
          return { status: "refused", reason: v?.reason ?? "it was not made" };
        },
      },
      {
        project: now,
        fence,
        level,
        sessionId: session.id,
        // A task written from a kept report says so in its brief; the person's words alone do not.
        fromReport: notes.length > 0,
      },
    );
    const refused: RefusedChange[] = [...fence.refused, ...applied.refused];
    if (!views.length)
      return nothing(joined(fixNoChangeReply(now.name), fixLeftOut(refused)), {
        costUsdMicro: cost,
        footer,
      });
    return {
      reply: joined(fixChangedReply(views.length, now.name), fixLeftOut(refused)),
      results: views,
      costUsdMicro: cost,
      footer,
      notice: false,
    };
  });
}

function joined(...parts: string[]): string {
  return parts.filter((p) => p.trim()).join(" ");
}

/**
 * The fix_tasks tool (SC-2): its only parameter is the project; the request is the person's
 * message of the turn, which the code passes (never text the model writes).
 */
export function fixTasksTool(opts: {
  /** The project a call names (by name), else the turn's; null: none to fix. */
  project(named: string | undefined): Promise<ProjectRow | null | { ask: string }>;
  run(project: ProjectRow): Promise<ChatTaskFixResult>;
}): ToolSpec<{ project?: string | undefined }> {
  return {
    name: FIX_TASKS_TOOL,
    description: FIX_TASKS_DESCRIPTION,
    schema: z.object({
      project: z
        .string()
        .max(200)
        .optional()
        .describe("The project's name when it is not the one on screen."),
    }),
    // Changes through the registry (each with its Undo), decided by the project's autonomy in code.
    actionClass: "routine_reversible",
    risk: "low",
    gate: "registry",
    execute: async (input) => {
      const project = await opts.project(input.project);
      if (!project) return { content: "There is no project to fix the tasks of." };
      if ("ask" in project) return { content: project.ask };
      const r = await opts.run(project);
      const lines = [
        r.reply,
        ...r.results
          .filter((x) => x.status === "done" || x.status === "partial")
          .map((x) => x.sentence ?? ""),
      ].filter(Boolean);
      return { content: lines.join("\n") };
    },
  };
}
