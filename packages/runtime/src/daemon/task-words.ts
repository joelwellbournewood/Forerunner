import type {
  HumanRequestRow,
  MergeRecordRow,
  ReviewRow,
  RunRow,
  TaskRow,
  TaskStatus,
} from "@forerunner/state";
import {
  type MergeMode,
  mergesAfterLabel,
  mergesAfterSentence,
  OWED_FOLDER_LABEL,
  owedMergeWait,
} from "../loop/merge-mode.ts";
import { SIGNOFF_SPECIALISTS } from "../loop/verification.ts";
import { CREDENTIAL_WAIT_REASON } from "../session/credential-wait.ts";
import { FULL_REVIEW_TIER } from "../session/sandbox-gate.ts";
import type { TaskAction, TaskDisplay } from "./api-types.ts";
import { cancelWorkKind, cancelWorkLine } from "./cancel-words.ts";
import { TAKE_OUT_NOTICE_PREFIX } from "./take-out-words.ts";

/*
 * The words of a task's status and the person's actions on it (design §2 and §3.5,
 * core-experience.md), with no store and nothing that needs Node: the daemon's views, the
 * UI's stand-in daemon (`apps/ui/test/fake-daemon.ts`) and the screens read the same map.
 */

/**
 * The stored statuses each person's action is offered from (design §3.5): the daemon refuses
 * an action the task's status does not offer, whatever a stale screen sends.
 */
export const ACTION_FROM: Readonly<Record<TaskAction, readonly TaskStatus[]>> = {
  make_ready: ["draft"],
  pause: ["ready"],
  resume: ["needs_human"],
  stop: ["claimed", "in_progress"],
  // A task waiting on its retry card (design §2 "Needs your decision") is tried again from the
  // Tasks tab as from the card; the move withdraws the card.
  try_again: ["failed", "needs_human"],
  go_ahead: ["needs_human"],
  cancel: ["draft", "ready", "claimed", "in_progress", "in_review", "needs_human", "failed"],
  reopen: ["cancelled"],
  redo: ["done"],
};

/**
 * Session events after which a task's status may differ (a run began or ended, the critic
 * took or released it, the session began or ended): `/events` then says the project changed,
 * so the Tasks tab and the header follow the work without a reload (design §3.5). The
 * per-step lines (`task.step`) and what the session heard are not among them.
 */
export function changesTasks(type: string): boolean {
  if (/^(task\.(step|heard|notes)|session\.brief)$/.test(type)) return false;
  return /^(task|session|critic)\./.test(type);
}

/** The buttons' words, for messages about them. */
export const ACTION_WORDS: Readonly<Record<TaskAction, string>> = {
  make_ready: "Make ready",
  pause: "Pause",
  resume: "Resume",
  stop: "Stop",
  try_again: "Try again",
  go_ahead: "Go ahead without",
  cancel: "Cancel",
  reopen: "Reopen",
  redo: "Redo",
};

/**
 * A task's status in the person's words (design §2, core-experience.md): one map from the
 * stored state, what the task waits for, the Docker sandbox and its open Inbox cards. The
 * Tasks tab's badge and filter, the drawer, the Start dialog and the chat read it; raw states
 * (`needs_human`, `in_progress`, `claimed`, tiers) never reach a person through it.
 */

/** What `taskDisplay` needs beyond the task itself; `loadTaskDisplayContext` reads it. */
export interface TaskDisplayContext {
  /**
   * The project's tasks by id (the ones a task waits for are among them); `depends_on`, where
   * given, lets a done task say which pull requests it merges after (merge-in-app).
   */
  tasks: ReadonlyMap<
    string,
    Pick<TaskRow, "id" | "title" | "status" | "reason"> & Partial<Pick<TaskRow, "depends_on">>
  >;
  /**
   * Open Inbox cards by the task they are about (the oldest first); the card's `change_card`
   * says which kind it is (questions, or a decision after failed tries).
   */
  cards: ReadonlyMap<
    string,
    Pick<HumanRequestRow, "id"> & Partial<Pick<HumanRequestRow, "change_card">>
  >;
  /** Whether the Docker sandbox is ready; null when it was not checked yet. */
  sandboxReady: boolean | null;
  /** The latest run of each task: when it began and who runs it. */
  runs: ReadonlyMap<string, Pick<RunRow, "created_at" | "specialist">>;
  /** Agents' names by id: a running task names its agent, never an id. */
  agentNames: ReadonlyMap<string, string>;
  /**
   * The critic's latest review of each done task (ADR 0104: "Reviewed" or "Reviewed and
   * tried"); absent where the caller does not need it.
   */
  reviews?: ReadonlyMap<string, Pick<ReviewRow, "verdict" | "evidence">>;
  /**
   * The merge record of each done task's pull request (merge-in-app, ADR 0111): the row says
   * "Merged", "Accepted · merges when its checks pass" or "Accepted · waiting for you to merge".
   * Absent where the caller does not read them, or for a task without a pull request: "Done".
   * `pr_number` names the pull requests a person-approved merge waits behind.
   */
  merges?: ReadonlyMap<
    string,
    Pick<MergeRecordRow, "state" | "approval" | "sentence"> &
      Partial<
        Pick<
          MergeRecordRow,
          | "pr_number"
          | "take_out_pr_number"
          | "take_out_pr_url"
          | "take_out_state"
          // TM-4: a merge that waits for the task folder's changes (`owedMergeWait`).
          | "rebuild_owed_for"
          | "last_outcome"
        >
      >
  >;
  /**
   * The project's merge mode (`project.settings.merge_mode`): a queued record the person did not
   * approve merges by itself in `after_review` ("Accepted · merging"), else it waits for the
   * click. Absent: "You press Merge", the default.
   */
  mergeMode?: MergeMode;
  /**
   * Whether a review of the task goes on in this app now (the kill switch holds it): a task
   * being reviewed's `live` (L-7). Absent: not said. A running task is not asked: its run goes
   * on wherever it was claimed, and a run on another computer stops on its own once it sees the
   * move (the runner's watch of the task), so a Cancel takes its work out there too.
   */
  live?: (taskId: string) => boolean;
  /**
   * The project is linked to the person's own folder (C-37): a Cancel sets nothing aside there,
   * so what a run wrote stays (`cancelWork`). Absent: a project's folder or a repository.
   */
  ownFolder?: boolean;
  /**
   * The project's work waits for a Claude credential (U-078): its reset ("Waits until 15:40,
   * your subscription's limit") or a new key ("Waits for a new API key"), as the row says it,
   * with the line under it. Absent or null: no wait.
   */
  credentialWait?: {
    label: string;
    detail: string;
    /** The project status sentence's head ("Waiting for a new API key"; `credentialWaitRow`). */
    line?: string;
    /** Where a refused credential's replacement is saved ("Save a new key", /setup). */
    save?: { label: string; to: string } | null;
  } | null;
}

/** A title as a status names it: whole when short, else cut at a word. */
export function shortTitle(title: string, max = 40): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Ids a person never reads (UUIDs, `request <id>`, `run:<id>`, `task:<id>`). */
const IDS =
  /\s*\((?:request|run|session|task)[ :][^)]*\)|\b(?:request|run|session|task)[ :]?[0-9a-f]{8}-[0-9a-f-]{27,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** A text without the ids a person never reads (design §5 rule 3), whitespace folded. */
export function withoutIds(text: string): string {
  return text
    .replace(IDS, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * "(s)" plurals as the number says (design §5 rule 6): "2 question(s)" reads "2 questions",
 * "1 changed file(s)" reads "1 changed file"; one with no number before it reads plural.
 */
export function plainPlurals(text: string): string {
  return text
    .replace(
      /\b(\d+) ((?:[a-z]+ ){0,2})([a-z]+)\(s\)/gi,
      (_, n: string, between: string, w: string) => `${n} ${between}${n === "1" ? w : `${w}s`}`,
    )
    .replace(/\(s\)/g, "s");
}

/**
 * A stored reason as one plain line (design §5): no ids, no ladder words, at most `max`
 * characters, cut at a word. The runner's own texts are rewritten where they are known.
 */
export function plainReason(reason: string, max = 100): string {
  let r = reason.replace(IDS, "").replace(/\s+/g, " ").trim();
  // The task's reason ("retry ladder exhausted after 4 failed attempt(s) …") and the retry
  // card's text ('Retry ladder exhausted for "X" after 4 failed attempt(s) …').
  const ladder = /^retry ladder exhausted (?:for ("[^"]*") )?after (\d+) failed attempt/i.exec(r);
  if (ladder) r = ladder[1] ? `${ladder[1]} failed ${ladder[2]} times` : `tried ${ladder[2]} times`;
  r = r
    .replace(/\(ceiling [^)]*\)/gi, "")
    .replace(/\bat (?:haiku|sonnet|opus)\b/gi, "")
    .replace(/:\s*human decides$/i, "")
    .replace(/\[stand-in model\]\s*/gi, "")
    .replace(/\*\*/g, "");
  r = plainPlurals(r).replace(/\s+/g, " ").trim();
  if (r.length <= max) return r;
  const cut = r.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Which kind of card holds a task (design §2, §3.8): `retry`, the decision after its tries
 * (Try again, Mark done anyway, Cancel task: the critic's retry card, a sign-off, a failed run,
 * a blocked or failed review); `questions`, anything that asks the person (answer it, or go
 * ahead without).
 */
export function cardKindOf(
  card: { change_card?: unknown } | undefined,
): "retry" | "questions" | "budget" | "cannot_run" {
  const c = card?.change_card;
  const key =
    c && typeof c === "object" && !Array.isArray(c) ? (c as { key?: unknown }).key : undefined;
  // A task stopped at its own budget (live walk 2, B2): Raise the budget or Cancel task.
  if (key === "task:budget_stop") return "budget";
  // A task a run left waiting without asking anything (live walk 4): Try again or Cancel task.
  if (key === "task:cannot_run") return "cannot_run";
  return key === "critic:signoff" || key === "findings:blocked" || key === "critic:review_failed"
    ? "retry"
    : "questions";
}

/**
 * A task's status while its budget card is open (ADR 0112): paused at the limit the card names
 * (`change_card.source`; a card a session's budget filed before budget-resume says "session_budget").
 */
export function budgetPauseLabel(source: unknown): string {
  switch (source) {
    case "session_budget":
    case "session":
      return "Paused at the session's budget";
    case "project":
      return "Paused at the project's budget";
    case "month":
      return "Paused at this month's cap";
    case "plan":
      return "Paused at your Claude subscription's share";
    default:
      return "Paused at its budget";
  }
}

/**
 * What a paused task's row says next (budget-resume, design §2 "status · one line"): its card
 * offers Continue or Cancel; at a limit no bigger budget lifts (the month's cap, the project's
 * budget, the subscription's share) it goes on by itself once that limit is raised in Settings
 * or resets (`wakeBudgetWaits`; room alone never wakes it, the review of budget-resume).
 */
export function budgetPauseDetail(source: unknown): string {
  return source === "month" || source === "project" || source === "plan"
    ? "It goes on by itself once that limit is raised or resets; cancel it in the Inbox."
    : "Continue or cancel in the Inbox.";
}

function cardKey(card: { change_card?: unknown }): unknown {
  const c = card.change_card;
  return c && typeof c === "object" && !Array.isArray(c) ? (c as { key?: unknown }).key : undefined;
}

/** The project's Docker card (`sandbox.not_ready`, one per project). */
export function isDockerCard(card: { change_card?: unknown }): boolean {
  return cardKey(card) === "sandbox.not_ready";
}

/**
 * The offer of a repository for a project without one (`RepoProposals`, key `repo:create:<id>`):
 * a yes or no the person gives when they like, which holds no work (tasks run in the project's
 * folder meanwhile).
 */
export function isRepositoryOffer(card: { change_card?: unknown }): boolean {
  const key = cardKey(card);
  return typeof key === "string" && key.startsWith("repo:create:");
}

/**
 * The notice that a "Take this work out" conflicted with later work (`take-out.ts`,
 * `TAKE_OUT_NOTICE_PREFIX`): it tells, and asks nothing of a task (the task stays done).
 */
export function isTakeOutNotice(card: { change_card?: unknown }): boolean {
  const key = cardKey(card);
  return typeof key === "string" && key.startsWith(TAKE_OUT_NOTICE_PREFIX);
}

/**
 * Whether an open card holds its task on the Tasks tab ("Needs your answer", "Needs your
 * decision") and counts as a question in the project's status line. The Docker card
 * (`sandbox.not_ready`, one per project, naming its task for Cancel task) asks nothing of the
 * task: the row reads "Waiting for Docker", or "Paused by you" with Resume when the person
 * paused it. Before, a paused task with that card read "Needs your answer" and lost its Resume.
 * The repository offer holds nothing either (C-60, merged-actions): before, a finished folder
 * project read "Waiting for you: 1 question" on Home because of it.
 */
export function holdsTask(card: { change_card?: unknown }): boolean {
  return !isDockerCard(card) && !isRepositoryOffer(card) && !isTakeOutNotice(card);
}

/**
 * A merged task's row (merge-in-app's "Merged"), with "Take this work out" (merged-actions, the
 * owner's decision of 2026-11-02): offered while its work is in main; "Taken out in #9 (waiting
 * for you to merge)" while the pull request that takes it out waits; "Taken out in #9" once that
 * one is merged. A take-out pull request closed without merging offers it again.
 */
function mergedDisplay(
  merge: Partial<Pick<MergeRecordRow, "take_out_pr_number" | "take_out_pr_url" | "take_out_state">>,
): TaskDisplay {
  const number = merge.take_out_pr_number ?? null;
  const url = merge.take_out_pr_url ?? null;
  if (number && merge.take_out_state === "open")
    return display("done", `Taken out in #${number} (waiting for you to merge)`, "good", {
      takeOut: { state: "open", number, url },
    });
  if (number && merge.take_out_state === "merged")
    return display("done", `Taken out in #${number}`, "neutral", {
      takeOut: { state: "merged", number, url },
    });
  return display("done", "Merged", "good", {
    takeOut: { state: "offered", number: null, url: null },
  });
}

/** True when a person paused the task (Pause or Stop) and no card asks anything about it. */
export function isPausedByPerson(
  task: Pick<TaskRow, "status" | "author_human" | "author_agent">,
  hasOpenCard: boolean,
): boolean {
  return task.status === "needs_human" && !hasOpenCard && !!task.author_human && !task.author_agent;
}

function display(
  key: TaskDisplay["key"],
  label: string,
  tone: TaskDisplay["tone"],
  extra: Partial<Omit<TaskDisplay, "key" | "label" | "tone">> = {},
): TaskDisplay {
  return {
    key,
    label,
    tone,
    detail: extra.detail ?? null,
    agentName: extra.agentName ?? null,
    since: extra.since ?? null,
    blocker: extra.blocker ?? null,
    ...(extra.live !== undefined ? { live: extra.live } : {}),
    ...(extra.cancelWork ? { cancelWork: extra.cancelWork } : {}),
    ...(extra.takeOut ? { takeOut: extra.takeOut } : {}),
  };
}

/** What Cancel does to the task's work now, as the dialog says it (budget-resume, C-37). */
function cancelWorkOf(
  task: Pick<TaskRow, "pr_url">,
  ctx: Pick<TaskDisplayContext, "ownFolder">,
  state: { running?: boolean; liveReview?: boolean; paused?: boolean },
): string | undefined {
  const kind = cancelWorkKind({
    running: !!state.running,
    liveReview: !!state.liveReview,
    paused: !!state.paused,
    pullRequest: !!task.pr_url,
    ownFolder: !!ctx.ownFolder,
  });
  return kind ? cancelWorkLine(kind) : undefined;
}

/**
 * The open pull requests a done task's merge waits behind (merge-in-app): every task it builds on,
 * near or far, whose work is not merged yet (`after`, in the order they merge, as the Overview's
 * `first`), and those of them that wait for their checks (`waitingOn`).
 */
function mergesBehind(
  task: Pick<TaskRow, "depends_on">,
  ctx: TaskDisplayContext,
): { after: number[]; waitingOn: number[] } {
  const after: number[] = [];
  const waitingOn: number[] = [];
  const seen = new Set<string>();
  const walk = (t: Partial<Pick<TaskRow, "depends_on">>) => {
    for (const id of t.depends_on ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const dep = ctx.tasks.get(id);
      const record = ctx.merges?.get(id);
      if (!dep || !record?.pr_number || record.state === "merged") continue;
      walk(dep);
      if (!after.includes(record.pr_number)) after.push(record.pr_number);
      if (record.state === "waiting_checks") waitingOn.push(record.pr_number);
    }
  };
  walk(task);
  return { after, waitingOn };
}

/**
 * TM-4 (leftovers7-tailmerge): a done task whose merge waits for the changes left in its
 * folder (`owedMergeWait`) says so with the way out, as the Overview's row does; null otherwise.
 * Before, it read "Accepted · merging" with no reason for as long as the folder held them.
 */
function owedFolderWait(merge: Parameters<typeof owedMergeWait>[0]): TaskDisplay | null {
  const sentence = owedMergeWait(merge);
  return sentence ? display("done", OWED_FOLDER_LABEL, "warn", { detail: sentence }) : null;
}

export function taskDisplay(task: TaskRow, ctx: TaskDisplayContext): TaskDisplay {
  const card = ctx.cards.get(task.id);
  switch (task.status) {
    case "draft":
      return display("draft", "Draft", "neutral", {
        detail: "No session picks it up until you make it ready.",
      });
    case "cancelled":
      return display("cancelled", "Cancelled", "neutral");
    case "done": {
      if (/accepted without review/i.test(task.reason))
        return display("done", "Done: accepted without review", "good");
      // merge-in-app: a task whose pull request has a merge record says whether its work is in
      // main (before, "Done" whether or not anything was merged, and nothing said which).
      const merge = ctx.merges?.get(task.id);
      if (!merge) return display("done", "Done", "good");
      const waits = owedFolderWait(merge);
      if (waits) return waits;
      const sentence = merge.sentence.trim();
      const detail =
        sentence && !/press Merge on the Overview\.?$/.test(sentence) ? sentence : null;
      switch (merge.state) {
        case "merged":
          return mergedDisplay(merge);
        case "waiting_checks":
          return display("done", "Accepted · merges when its checks pass", "good");
        case "merging":
          return display("done", "Accepted · merging", "good");
        case "queued": {
          // An accept whose merge has not run yet: the automatic mode merges it by itself, as
          // the Overview's row says ("merging"); "You press Merge" leaves it for the click
          // (R-queuedwords, leftovers7-merge: before, every mode read "waiting for you").
          if (merge.approval !== "person")
            return ctx.mergeMode === "after_review"
              ? display("done", "Accepted · merging", "good")
              : display("done", "Accepted · waiting for you to merge", "good");
          // The person's Merge, waiting its turn behind pull requests whose checks still run
          // (review, 2026-11-08: "Accepted · merging" for as long as those checks ran).
          const behind = mergesBehind(task, ctx);
          return behind.waitingOn.length && merge.pr_number
            ? display("done", mergesAfterLabel(behind.after), "good", {
                detail: mergesAfterSentence(merge.pr_number, behind.after, behind.waitingOn),
              })
            : display("done", "Accepted · merging", "good");
        }
        default:
          return display("done", "Accepted · waiting for you to merge", "good", { detail });
      }
    }
    case "failed": {
      const why = plainReason(task.reason);
      return display("failed", why ? `Failed: ${why}` : "Failed", "bad", {
        ...(card
          ? {
              detail: "Its card is in the Inbox.",
              blocker: {
                kind: "card",
                taskId: null,
                requestId: card.id,
                title: null,
                cardKind: cardKindOf(card),
              },
            }
          : {}),
      });
    }
    case "in_review":
      // A review that ended without a verdict the work can follow (it failed, U-045, or an
      // earlier finding is still open) waits on its card: no critic is checking the work, and
      // only the card moves it (phase C review: it read "Being reviewed", and Cancel promised
      // to stop a review that was not running).
      if (card && cardKindOf(card) === "retry")
        return display("answer", "Needs your decision", "warn", {
          detail: "Its card is in the Inbox: try again, mark it done anyway, or cancel it.",
          blocker: {
            kind: "card",
            taskId: null,
            requestId: card.id,
            title: null,
            cardKind: "retry",
          },
        });
      return display("review", "Being reviewed", "info", {
        detail: "The critic is checking the work.",
        ...(ctx.live ? { live: ctx.live(task.id) } : {}),
        ...(ctx.live?.(task.id)
          ? { cancelWork: cancelWorkOf(task, ctx, { liveReview: true }) }
          : {}),
      });
    case "claimed":
    case "in_progress": {
      const run = ctx.runs.get(task.id);
      const agentName = task.claimed_by ? (ctx.agentNames.get(task.claimed_by) ?? null) : null;
      return display("running", "Running", "info", {
        agentName,
        since: run?.created_at ?? task.updated_at,
        ...(run?.specialist ? { detail: `The ${run.specialist} is working on it.` } : {}),
        cancelWork: cancelWorkOf(task, ctx, { running: true }),
      });
    }
    case "needs_human": {
      if (card && cardKindOf(card) === "budget")
        // Live walk 2 (B2): it read "Paused" with no card; the card asks to raise the budget.
        // C-36: a session's budget that stopped it twice says so. ADR 0112: every other stop at
        // a budget is a pause, named by the limit that stopped it.
        return display(
          "answer",
          budgetPauseLabel((card.change_card as { source?: unknown } | null)?.source),
          "warn",
          {
            detail: budgetPauseDetail((card.change_card as { source?: unknown } | null)?.source),
            cancelWork: cancelWorkOf(task, ctx, { paused: true }),
            blocker: {
              kind: "card",
              taskId: null,
              requestId: card.id,
              title: null,
              cardKind: "budget",
            },
          },
        );
      if (card && cardKindOf(card) === "cannot_run")
        // Live walk 4: it read "Paused" with "Press Resume", and Resume only started the same
        // refusal again; its card says why and offers Try again once that is fixed.
        return display("answer", "Needs your decision: it could not run", "warn", {
          detail: "Its card is in the Inbox: fix what stopped it and try again, or cancel it.",
          blocker: {
            kind: "card",
            taskId: null,
            requestId: card.id,
            title: null,
            cardKind: "cannot_run",
          },
        });
      if (card && cardKindOf(card) === "retry") {
        // Design §5 "Task row": "Needs your decision: tried 4 times [Answer]".
        const tried = /^tried \d+ times$/.test(plainReason(task.reason))
          ? `: ${plainReason(task.reason)}`
          : "";
        return display("answer", `Needs your decision${tried}`, "warn", {
          detail: "Its card is in the Inbox: try again, mark it done anyway, or cancel it.",
          blocker: {
            kind: "card",
            taskId: null,
            requestId: card.id,
            title: null,
            cardKind: "retry",
          },
        });
      }
      if (card) {
        // A questions card filed after the person went ahead without answering offers no Go
        // ahead without again (live L-3); the row offers what the card offers.
        const asked = card.change_card as { go_ahead?: unknown } | null | undefined;
        return display("answer", "Needs your answer", "warn", {
          detail: "Its card is in the Inbox.",
          blocker: {
            kind: "card",
            taskId: null,
            requestId: card.id,
            title: null,
            cardKind: "questions",
            ...(asked && typeof asked === "object" && asked.go_ahead === false
              ? { goAhead: false }
              : {}),
          },
        });
      }
      if (isPausedByPerson(task, false))
        return display("paused", "Paused by you", "neutral", {
          detail: "No session runs it until you press Resume.",
        });
      const why = plainReason(task.reason);
      return display("paused", "Paused", "warn", {
        detail: why
          ? `${why}. Press Resume to let a session run it.`
          : "Press Resume to let a session run it.",
      });
    }
    case "ready": {
      const notDone = task.depends_on
        .map((id) => ({ id, dep: ctx.tasks.get(id) }))
        .filter(({ dep }) => dep?.status !== "done");
      const stuck = notDone.find(
        ({ dep }) => !dep || dep.status === "failed" || dep.status === "cancelled",
      );
      if (stuck) {
        const title = stuck.dep ? shortTitle(stuck.dep.title) : null;
        const what = !stuck.dep
          ? "a task it waits for no longer exists"
          : stuck.dep.status === "failed"
            ? `"${title}" failed`
            : `"${title}" was cancelled`;
        return display("stuck", `Stuck: ${what}`, "bad", {
          detail: "No session runs it until that task is done or you change what it waits for.",
          blocker: {
            kind: "task",
            taskId: stuck.id,
            requestId: null,
            title: stuck.dep?.title ?? null,
          },
        });
      }
      const first = notDone[0];
      if (first?.dep) {
        const more = notDone.length > 1 ? ` and ${notDone.length - 1} more` : "";
        return display(
          "waiting",
          `Waiting for "${shortTitle(first.dep.title)}"${more}`,
          "neutral",
          {
            detail: "It runs once that is done.",
            blocker: { kind: "task", taskId: first.id, requestId: null, title: first.dep.title },
          },
        );
      }
      if (task.risk_tier >= FULL_REVIEW_TIER && ctx.sandboxReady === false)
        return display("docker", "Waiting for Docker", "warn", {
          // A consequence line: at most 100 characters (design §5 rule 1). A deploy or a data
          // migration keeps the full review (ADR 0104, the owner's decision 4): no light-review
          // way out is suggested for it.
          detail: SIGNOFF_SPECIALISTS.has(task.specialist ?? "")
            ? "A deploy or a migration keeps the full review, which needs Docker. Set it up in Settings."
            : "Full review needs Docker, not running on this computer. Set it up, or edit to a light review.",
          blocker: { kind: "docker", taskId: null, requestId: null, title: null },
        });
      // U-078: no Claude credential that may run it can now; it starts by itself at the
      // credential's reset, or once a new key is saved (never "Failed: no billing source").
      // Only a task that waited says so (the leftovers of wave 7): under "Wait" a task whose
      // first choice can serve runs, so the project's wait is not every ready task's.
      if (ctx.credentialWait && task.reason === CREDENTIAL_WAIT_REASON)
        return display("waiting", ctx.credentialWait.label, "warn", {
          detail: ctx.credentialWait.detail,
        });
      return display("ready", "Ready", "neutral");
    }
  }
}

/**
 * The order a session runs the project's tasks in (design §3.5 "rows in run order"): a task
 * after every task it waits for, and among those free to go, higher priority first, then the
 * older first. Stable whatever the statuses, so rows do not jump while work runs. A cycle (the
 * daemon refuses new ones) falls back to priority order for the tasks on it.
 */
export function runOrder<T extends Pick<TaskRow, "id" | "depends_on" | "priority" | "created_at">>(
  tasks: readonly T[],
): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rank = (a: T, b: T) =>
    b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  const waitsFor = new Map(
    tasks.map((t) => [t.id, new Set(t.depends_on.filter((d) => byId.has(d) && d !== t.id))]),
  );
  const out: T[] = [];
  const placed = new Set<string>();
  while (out.length < tasks.length) {
    const free = tasks
      .filter((t) => !placed.has(t.id))
      .filter((t) => [...(waitsFor.get(t.id) ?? [])].every((d) => placed.has(d)))
      .sort(rank);
    const next = free[0] ?? tasks.filter((t) => !placed.has(t.id)).sort(rank)[0];
    if (!next) break;
    out.push(next);
    placed.add(next.id);
  }
  return out;
}
