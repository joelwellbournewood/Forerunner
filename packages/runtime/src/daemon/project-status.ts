import type { HumanRequestRow, SessionRow, StateStore, TaskRow } from "@forerunner/state";
import { waitHeadWords } from "../session/credential-wait.ts";
import type { ProjectCard, TaskDisplay } from "./api-types.ts";
import { TASK_PROPOSAL_KEY } from "./task-proposal-words.ts";
import {
  cardKindOf,
  holdsTask,
  needsYouAfterAccept,
  shortTitle,
  WAITING_FOR_YOUR_MERGE,
} from "./task-words.ts";

/**
 * A project's state in one sentence (design §2, "Project status"), the line the project header,
 * its Overview and its row on Home show instead of the stage, health, status and autonomy
 * badges. Computed when shown, from the tasks as they are now (§5 rule 4), first match wins:
 *
 * 1. "Waiting for you: approve the plan" / "Waiting for you: 2 questions" / "Waiting for you:
 *    1 sign-off and 1 paused task" (the cards' kinds, linking the oldest card)
 * 2. "Working on "Style the page" (3 of 7 done)"; what waits to start (d1109-run-visible V-3):
 *    "Waiting until 15:40 (your subscription's limit), then it goes on" [Cancel] (the person's
 *    session waiting to go on), "Starts at 15:40 (your subscription's limit)" [Cancel] (a Start
 *    kept for the reset), "Starts after your quiet hours" (a held hands-off start), 'Starts after
 *    the session on "Garden site"' (a person start waiting behind another project's session)
 * 3. "Stuck: "Style the page" failed; 4 tasks wait on it" / "Waiting for Docker: 1 task"
 * 4. "Ready: 3 tasks wait for your Start" [Continue] (D6: only the person's Start starts work)
 * 5. "Drafting the plan…" / "Planning failed: <short reason>" [Try again] / "You rejected the
 *    plan. Nothing was written." [Draft a new plan]; without Claude the button is Connect Claude
 * 6. "Done: all 7 tasks." [Open your files]; a repository project: "Done: all 6 tasks. 6 pull
 *    requests wait for you to merge." [Open Overview]; "; 2 taken out" when some were taken out
 *    (later #53/#54, C-58: the folder's path, with the project's id in it, was in the sentence;
 *    the Overview and Files show it)
 *
 * The pure part (`projectStatusLine`) takes what was read; `projectFacts` reads it.
 */

export type ProjectStatusLine = NonNullable<ProjectCard["statusLine"]>;
export type ProjectWorking = NonNullable<ProjectCard["working"]>;

/** The plan from the brief, as the intake says (`IntakeService.status`). */
export type PlanState =
  | "none"
  | "drafting"
  | "pending"
  | "approved"
  | "rejected"
  | "failed"
  | "waiting"
  | "skipped"
  | null;

export interface ProjectStatusInput {
  projectId: string;
  /** Every task of the project. */
  tasks: readonly Pick<TaskRow, "id" | "title" | "status" | "depends_on">[];
  /** Each task's status in words (design §2), by task id. */
  displays: ReadonlyMap<string, TaskDisplay>;
  /** The project's open Inbox cards for the person, oldest first. */
  cards: readonly Pick<HumanRequestRow, "id" | "task_id" | "change_card">[];
  /** The plan from the brief; `pending` waits for approval in the Inbox. */
  plan: PlanState;
  /** Why planning failed, in words (`summary_cache.intake.error`). */
  planError?: string | null;
  /**
   * The plan from the brief waits for a Claude credential (`plan: "waiting"`, U-078): the status
   * sentence's words ("Planning waits for a new API key") and, for a refusal, where a new one is
   * saved. Waiting is no failure: no Try again, which cannot work while it waits.
   */
  planWait?: { short: string; save: { label: string; to: string } | null } | null;
  /**
   * The project's ready tasks wait for a Claude credential (U-078, the rows' `credentialWait`):
   * the sentence's head ("Waiting for a new API key", "Waiting until 15:40 (your subscription's
   * limit)") and, for a refusal, where a new one is saved.
   */
  credentialWait?: {
    label: string;
    line?: string;
    save?: { label: string; to: string } | null;
    /** d1109-cred-screens (CS-5): the tasks wait for the person's answer on the ask card. */
    ask?: boolean;
  } | null;
  /**
   * W15-67: no ready task can run now because its credential rests or was refused, kept or not
   * (`RuntimeApp.billing.waits.now`, the Start check's sentence and its link): the ready line
   * names the wait and its time. Null: a ready task would run.
   */
  credentialWaitNow?: {
    text: string;
    save: { label: string; to: string } | null;
    startable?: boolean;
    /**
     * d1109-starts-engine S-10: a Start the person pressed while the credential was out is kept
     * for its reset: "Starts at 15:40 (your subscription's limit)", the line's head.
     */
    startsAt?: string;
  } | null;
  /**
   * Whether a Claude credential is in force now (the intake can call the model); null when not
   * known. Without one, Try again cannot work, so the button is Connect Claude.
   */
  hasModel?: boolean | null;
  /** Stop all is on (the kill switch is frozen): no session starts until it is lifted. */
  stopped?: boolean | null;
  /** The session working on the project now, if one runs. */
  working: ProjectWorking | null;
  /** The project's folder (its workspace, or the linked folder or repository checkout). */
  folder: string | null;
  /**
   * d1109-onerepo-join (OJ-06): the project was closed into another by Make one project: its
   * sentence ('Joined into "Site" on 9 Nov.') with Open it, before every other rule (nothing of
   * it runs; its sessions, changes and costs stay readable).
   */
  joinedInto?: { text: string; projectId: string } | null;
  /**
   * d1109-run-visible (V-3): what waits to start for the project, said on its line after the
   * working rule: the person's own session waiting to go on after its credential wait (the
   * wait's words, "Waiting until 15:40 (your subscription's limit)"; a refusal's with where a new
   * key is saved), a Start kept for the reset ("Starts at 15:40 (your subscription's limit)"),
   * a hands-off start quiet hours hold, a person start waiting behind another project's session.
   */
  startsWait?: StartsWait | null;
}

/** What waits to start for a project (`ProjectStatusInput.startsWait`). */
export type StartsWait =
  | { kind: "continuation"; head: string; save?: { label: string; to: string } | null }
  | { kind: "kept_start"; head: string }
  | { kind: "held" }
  /**
   * l4-cred-screens (L4a-left-4): `goesOn`, the person's own session that waited for its
   * credential goes on after the other project's session ("Goes on after ..."), not a new start.
   */
  | { kind: "queued"; behind: string; goesOn?: boolean };

/** Cancel on a wait that goes on or starts by itself (POST /projects/:id/continuation/cancel). */
const CANCEL_WAIT = { kind: "cancel", label: "Cancel", to: null } as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The plural of a card word that is not its word with an "s" (W15-77). */
const CARD_WORD_PLURALS: Readonly<Record<string, string>> = {
  "change to confirm": "changes to confirm",
};

/** What a card asks of the person, in a word the status line counts (L-13a). */
function cardWord(card: { change_card?: unknown }): string {
  const cc = card.change_card as { key?: unknown; command?: unknown } | null | undefined;
  const key = cc?.key;
  // W15-77: a change waiting for a yes (the registry's card: a command, no card key) is a
  // change to confirm; it read "1 question" (live check 2, an undo left on Changes).
  if (typeof cc?.command === "string" && cc.command && key === undefined)
    return "change to confirm";
  // l4-selftasks-112 (b): the agent's suggested changes to the tasks are a suggestion (live
  // check 4: "Waiting for you: 1 question" when it was the only card).
  if (key === TASK_PROPOSAL_KEY) return "suggestion";
  switch (cardKindOf(card)) {
    case "signoff":
      return "sign-off";
    case "budget":
      return "paused task";
    case "questions":
      return typeof key === "string" && key.startsWith("merge:") ? "pull request" : "question";
    default:
      return "decision";
  }
}

/**
 * "2 questions", "1 sign-off and 1 paused task", "2 decisions, 1 question and 1 paused task",
 * "2 decisions, 1 question, 1 sign-off and 2 more" (L-13a: before, every card was counted as a
 * question, a sign-off and a budget card too); the kinds in the order of their oldest card, up
 * to three named (design §5.5; the review of polish-words: a third kind read "and 1 more").
 */
function cardKindsWords(cards: readonly { change_card?: unknown }[]): string {
  const counts = new Map<string, number>();
  for (const c of cards) {
    const w = cardWord(c);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([w, n]) => plural(n, w, CARD_WORD_PLURALS[w]));
  if (parts.length <= 1) return parts.join("");
  if (parts.length <= 3) return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  const rest = [...counts.values()].slice(3).reduce((a, b) => a + b, 0);
  return `${parts.slice(0, 3).join(", ")} and ${rest} more`;
}

/** Status sentence length (design §5 rule 1). */
const STATUS_MAX = 80;

/** A status sentence within `STATUS_MAX`, cut at a word (a long project or task name). */
function fitStatus(text: string): string {
  if (text.length <= STATUS_MAX) return text;
  const cut = text.slice(0, STATUS_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > STATUS_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
const PLAN_FAILED = "Planning failed";
/** Connect Claude: the setup assistant, as the header's no-key bar opens it (design §3.1). */
const CONNECT_CLAUDE = { kind: "link", label: "Connect Claude", to: "/setup" } as const;

/**
 * The intake's reasons (`intakeFailureWords`, `INTAKE_NEEDS_A_MODEL`, the lost "Change the
 * plan" draft) as a few words after "Planning failed: " (design §2 item 5, §5.1: the sentence
 * stays within 80 characters; the project page's plan banner keeps the reason in full).
 * `noModel` marks the reasons that are a missing Claude credential.
 */
const PLAN_FAILURE_SHORT: readonly { match: RegExp; short: string; noModel?: true }[] = [
  {
    match: /needs a Claude key or subscription|No Claude key or subscription|No Claude credential/i,
    short: "Claude is not connected",
    noModel: true,
  },
  { match: /^Claude did not answer/i, short: "Claude did not answer" },
  { match: /^Claude was busy/i, short: "Claude was busy" },
  { match: /^Claude could not be reached/i, short: "Claude could not be reached" },
  {
    match: /took longer than its time limit|did not finish the plan in time/i,
    short: "it took too long",
  },
  { match: /used up the budget/i, short: "it used up its budget" },
  { match: /used all the steps/i, short: "it ran out of steps" },
  { match: /was stopped before it finished/i, short: "it was stopped" },
  // The intake's reader words (fix/intake-live): a reply that is no plan, or a plan without a part.
  {
    match: /^Claude's plan could not be read|^Claude's answer had no plan/i,
    short: "Claude's answer was not a plan",
  },
  { match: /^Claude's plan was missing/i, short: "Claude's plan was incomplete" },
  { match: /Forerunner closed before it was done/i, short: "Forerunner closed before it was done" },
];

/**
 * "Planning failed: <a few words>" with the button that unblocks it: Connect Claude while no
 * credential is in force (the retry route refuses then), otherwise Try again (the intake's
 * retry, `POST /projects/:id/intake/retry`). A reason nobody worded is its first sentence, cut
 * at a word.
 */
function planFailedLine(
  error: string | null | undefined,
  hasModel: boolean | null | undefined,
): ProjectStatusLine {
  // "The run failed: " is how a task run's reason starts; here "Planning failed" says it.
  const said = (error ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^The run failed:\s*/i, "");
  const known = said ? PLAN_FAILURE_SHORT.find((r) => r.match.test(said)) : undefined;
  let reason: string;
  if (known?.noModel) reason = hasModel === true ? "Claude was not connected" : known.short;
  else if (known) reason = known.short;
  else if (hasModel === false) reason = "Claude is not connected";
  else {
    const first = (said.split(/(?<=[.!?])\s/)[0] ?? "").replace(/[.!?…]+$/, "");
    const room = STATUS_MAX - PLAN_FAILED.length - 2;
    reason = first.length > room ? `${first.slice(0, room - 1).replace(/\s+\S*$/, "")}…` : first;
  }
  return {
    kind: "planning_failed",
    text: reason ? `${PLAN_FAILED}: ${reason}` : PLAN_FAILED,
    action:
      hasModel === false ? { ...CONNECT_CLAUDE } : { kind: "retry", label: "Try again", to: null },
  };
}

/** "3 of 7 done": tasks not cancelled, and the ones done. */
export function progressOf(tasks: readonly Pick<TaskRow, "status">[]): {
  done: number;
  total: number;
} {
  const counted = tasks.filter((t) => t.status !== "cancelled");
  return { done: counted.filter((t) => t.status === "done").length, total: counted.length };
}

export function projectStatusLine(input: ProjectStatusInput): ProjectStatusLine {
  const tasksTab = `/projects/${encodeURIComponent(input.projectId)}/tasks`;
  const { done, total } = progressOf(input.tasks);
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const keyOf = (t: { id: string }) => input.displays.get(t.id)?.key;

  // OJ-06: a project closed into another reads where its work is, with Open it.
  if (input.joinedInto)
    return {
      kind: "joined",
      text: input.joinedInto.text,
      action: {
        kind: "link",
        label: "Open it",
        to: `/projects/${encodeURIComponent(input.joinedInto.projectId)}/summary`,
      },
    };

  // 1. What needs the person first (design §5 rule 2). The Docker card asks nothing of a task:
  // it is "Waiting for Docker" below.
  if (input.plan === "pending")
    return {
      kind: "waiting",
      text: "Waiting for you: approve the plan",
      action: { kind: "link", label: "Open", to: "/inbox" },
    };
  const asking = input.cards.filter((c) => holdsTask(c));
  if (asking.length > 0) {
    const only = asking.length === 1 ? asking[0] : undefined;
    const task = only?.task_id ? byId.get(only.task_id) : undefined;
    // later #55: Answer opens the oldest card, as Home's Needs you rows do (`/inbox#card-<id>`).
    const oldest = asking[0];
    return {
      kind: "waiting",
      text: task
        ? `Waiting for you: "${shortTitle(task.title)}"`
        : `Waiting for you: ${cardKindsWords(asking)}`,
      action: {
        kind: "link",
        label: "Answer",
        to: oldest ? `/inbox#card-${encodeURIComponent(oldest.id)}` : "/inbox",
      },
    };
  }

  // d1109-cred-screens (CS-5): the tasks wait for the person's answer on the one ask card ("Use
  // your API key until 15:40?"): what needs the person comes first, with Answer opening it.
  const asked = input.credentialWait?.ask
    ? input.tasks.filter(
        (t) =>
          keyOf(t) === "waiting" && input.displays.get(t.id)?.label === input.credentialWait?.label,
      )
    : [];
  if (asked.length > 0 && input.credentialWait?.line)
    return {
      kind: "waiting",
      text: input.credentialWait.line,
      action: input.credentialWait.save
        ? { kind: "link", label: input.credentialWait.save.label, to: input.credentialWait.save.to }
        : { kind: "link", label: "Answer", to: "/inbox" },
    };

  // 2. A session works on it now.
  if (input.working) {
    const progress = total > 0 ? ` (${done} of ${total} done)` : "";
    return {
      kind: "working",
      text: input.working.taskTitle
        ? `Working on "${shortTitle(input.working.taskTitle)}"${progress}`
        : `Working${progress}`,
      action: {
        kind: "link",
        label: "Open running session",
        to: `/sessions/${encodeURIComponent(input.working.sessionId)}`,
      },
    };
  }

  // 2b. What waits to start (d1109-run-visible V-3; D6, the owner: "the user clearly states when a
  // session will run"): the person's own session going on, a kept Start, a held hands-off start
  // or a person start behind another project's session, each said with when, Cancel where it
  // starts by itself.
  const sw = input.startsWait;
  if (sw?.kind === "continuation")
    return {
      // A refusal needs the person (a new key); a limit needs nothing but time.
      kind: sw.save ? "waiting" : "paused",
      text: fitStatus(`${sw.head}, then it goes on`),
      action: sw.save ? { kind: "link", label: sw.save.label, to: sw.save.to } : { ...CANCEL_WAIT },
    };
  if (sw?.kind === "kept_start")
    return { kind: "paused", text: fitStatus(sw.head), action: { ...CANCEL_WAIT } };
  if (sw?.kind === "queued")
    return {
      kind: "paused",
      text: fitStatus(
        `${sw.goesOn ? "Goes on" : "Starts"} after the session on "${shortTitle(sw.behind, 40)}"`,
      ),
      action: null,
    };
  if (sw?.kind === "held")
    return { kind: "paused", text: "Starts after your quiet hours", action: null };

  // 3. Stuck: a task that failed or was cancelled holds others back; or Docker is not ready.
  const stuck = input.tasks.filter((t) => keyOf(t) === "stuck");
  if (stuck.length > 0) {
    const holderId = input.displays.get(stuck[0]?.id ?? "")?.blocker?.taskId ?? null;
    const holder = holderId ? byId.get(holderId) : undefined;
    const behind = holderId
      ? stuck.filter((t) => t.depends_on.includes(holderId)).length
      : stuck.length;
    const what = holder
      ? `"${shortTitle(holder.title)}" ${holder.status === "cancelled" ? "was cancelled" : "failed"}`
      : "a task it waits for is gone";
    return {
      kind: "stuck",
      text: `Stuck: ${what}; ${plural(behind, "task waits", "tasks wait")} on it`,
      action: { kind: "link", label: "Open Tasks", to: tasksTab },
    };
  }
  const docker = input.tasks.filter((t) => keyOf(t) === "docker");
  if (docker.length > 0)
    return {
      kind: "docker",
      text: `Waiting for Docker: ${plural(docker.length, "task")}`,
      action: { kind: "link", label: "Set up Docker", to: "/settings#sandbox" },
    };
  // U-078: the tasks wait for a Claude credential, as their rows say: a refused one needs the
  // person (Save a new key), a limit needs nothing (they start by themselves at its reset).
  // Before, the line fell through to "0 of 2 done [Open Tasks]".
  const head = input.credentialWait?.line;
  const credential = head
    ? input.tasks.filter(
        (t) =>
          keyOf(t) === "waiting" && input.displays.get(t.id)?.label === input.credentialWait?.label,
      )
    : [];
  if (head && credential.length > 0) {
    const save = input.credentialWait?.save ?? null;
    return {
      kind: save ? "waiting" : "paused",
      text: `${head}: ${plural(credential.length, "task")}`,
      action: save ? { kind: "link", label: save.label, to: save.to } : null,
    };
  }

  // 4. Work that can run now. Continue opens the Start dialog, so the line offers it only when
  // the dialog would start (`start-blocked.ts`): without Claude it is Connect Claude, and with
  // Stop all on the header's stopped bar has Allow sessions again (design §5 rule 4: true now;
  // later #62, #49: before, "Ready to continue [Continue]" led to a disabled Start).
  const ready = input.tasks.filter((t) => keyOf(t) === "ready");
  if (ready.length > 0) {
    const n = plural(ready.length, "task");
    if (input.hasModel === false)
      return {
        kind: "ready",
        text: `Ready: ${n}. Claude is not connected.`,
        action: { ...CONNECT_CLAUDE },
      };
    if (input.stopped === true)
      return { kind: "ready", text: `Ready: ${n}. Sessions are stopped.`, action: null };
    // W15-67: the only credential rests (or was refused), so nothing runs before its reset (or
    // a new key): the line names the wait and its time. Continue stays where Start still keeps
    // the wait (`startable`); a refusal links to where a new one is saved; a kept wait starts
    // by itself. Before: "Ready to continue: 1 task ready" said nothing of the wait.
    const wait = input.credentialWaitNow;
    // S-10: the person's Start is kept for the reset: the line says when it starts.
    if (wait?.startsAt) return { kind: "ready", text: `${wait.startsAt}: ${n}`, action: null };
    if (wait)
      return {
        kind: "ready",
        text: `Ready: ${n}; ${waitHeadWords(wait.text)}`,
        action: wait.startable
          ? { kind: "start", label: "Continue", to: null }
          : wait.save
            ? { kind: "link", label: wait.save.label, to: wait.save.to }
            : null,
      };
    // d1109-run-visible (V-3, rewording w15-words' "Ready to continue: 3 tasks ready"): only the
    // person's Start starts work (D6), so the line says what the work waits for.
    return {
      kind: "ready",
      text: `Ready: ${plural(ready.length, "task waits", "tasks wait")} for your Start`,
      action: { kind: "start", label: "Continue", to: null },
    };
  }

  // 5. The plan from the brief.
  if (input.plan === "drafting" && total === 0)
    return { kind: "planning", text: "Drafting the plan…", action: null };
  if (input.plan === "failed" && total === 0)
    return planFailedLine(input.planError, input.hasModel);
  // U-078: planning waits for a Claude credential (a refusal or a limit), and is drafted by
  // itself once one serves; a refusal links to where a new one is saved.
  if (input.plan === "waiting" && total === 0) {
    const save = input.planWait?.save ?? null;
    return {
      kind: save ? "waiting" : "planning",
      text: input.planWait?.short ?? "Planning waits for a Claude credential",
      action: save ? { kind: "link", label: save.label, to: save.to } : null,
    };
  }
  // Design §3.3: "You rejected the plan. Nothing was written. [Draft a new plan]".
  if (input.plan === "rejected" && total === 0)
    return {
      kind: "planning_failed",
      text: "You rejected the plan. Nothing was written.",
      action:
        input.hasModel === false
          ? { ...CONNECT_CLAUDE }
          : { kind: "retry", label: "Draft a new plan", to: null },
    };

  // 6. Done. The folder's path stays on the Overview and in Files (later #53: with the project's
  // id in it, it pushed Start session onto a second line); a repository project says what
  // waits for the person's Merge (C-58), and how many were taken out (the owner question's
  // recommendation (b), built meanwhile: taken-out tasks still count as done).
  if (total > 0 && done === total) {
    const labels = input.tasks.map((t) => input.displays.get(t.id)?.label ?? "");
    const takenOut = labels.filter((l) => /^Taken out in #\d+/.test(l)).length;
    const toMerge = labels.filter((l) => l === WAITING_FOR_YOUR_MERGE).length;
    // W15B-12: accepted work that waits on the person in another way (its folder, a conflict, a
    // closed pull request, one that could not be rebuilt, a failed check) counts too, said as
    // needing the person on the Overview, never as waiting to be merged. Before: "Done: all 2
    // tasks." while #3 waited for a commit in its folder.
    const needYou = labels.filter(needsYouAfterAccept).length;
    const waits = toMerge
      ? `${plural(toMerge, "pull request waits", "pull requests wait")} for you to merge`
      : "";
    const others = needYou
      ? toMerge
        ? `${needYou} ${needYou === 1 ? "needs" : "need"} you on the Overview`
        : `${plural(needYou, "task needs", "tasks need")} you on the Overview`
      : "";
    const merges = waits || others ? ` ${[waits, others].filter(Boolean).join(", and ")}.` : "";
    return {
      kind: "done",
      text: `Done: all ${plural(total, "task")}${takenOut ? `; ${takenOut} taken out` : ""}.${merges}`,
      action: merges
        ? {
            kind: "link",
            label: "Open Overview",
            to: `/projects/${encodeURIComponent(input.projectId)}`,
          }
        : input.folder
          ? {
              kind: "link",
              label: "Open your files",
              to: `/projects/${encodeURIComponent(input.projectId)}/files`,
            }
          : null,
    };
  }

  if (total === 0)
    return {
      kind: "empty",
      text: "No tasks yet",
      action: { kind: "link", label: "Open Tasks", to: tasksTab },
    };
  // What is left cannot run by itself: drafts, tasks paused, or tasks waiting on those.
  const paused = input.tasks.filter((t) => keyOf(t) === "paused");
  if (paused[0])
    return {
      kind: "paused",
      text: `Paused: "${shortTitle(paused[0].title)}"${paused.length > 1 ? ` and ${paused.length - 1} more` : ""}`,
      action: { kind: "link", label: "Open Tasks", to: tasksTab },
    };
  const drafts = input.tasks.filter((t) => keyOf(t) === "draft").length;
  if (drafts > 0)
    return {
      kind: "paused",
      text: `${done} of ${total} done; ${plural(drafts, "draft")} to make ready`,
      action: { kind: "link", label: "Open Tasks", to: tasksTab },
    };
  return {
    kind: "paused",
    text: `${done} of ${total} done`,
    action: { kind: "link", label: "Open Tasks", to: tasksTab },
  };
}

/** How many lines the Overview's "Next" shows (design §3.4: max 3 lines). */
export const NEXT_LINES = 3;
const NEXT_RANK: Record<TaskDisplay["key"], number> = {
  running: 0,
  review: 1,
  ready: 2,
  answer: 3,
  waiting: 4,
  stuck: 5,
  docker: 6,
  paused: 7,
  failed: 8,
  draft: 9,
  done: 10,
  cancelled: 11,
};

/**
 * Design §3.4 "Next", computed when shown (§5 rule 4): the open tasks (given in run order) with
 * their status in words, what runs now first, then what can run, then what waits; at most three
 * lines, then "and N more".
 */
export function overviewNext(
  items: readonly { task: Pick<TaskRow, "title" | "status">; display: TaskDisplay }[],
): string[] {
  const open = items
    .filter(({ task }) => task.status !== "done" && task.status !== "cancelled")
    .sort((a, b) => NEXT_RANK[a.display.key] - NEXT_RANK[b.display.key]);
  const lines = open
    .slice(0, NEXT_LINES)
    .map(({ task, display }) => `"${shortTitle(task.title, 60)}": ${display.label}`);
  if (open.length > NEXT_LINES) lines.push(`and ${open.length - NEXT_LINES} more`);
  return lines;
}

/** The session row the intake drafts a plan in (`session/intake.ts`: `plan.intake`). */
export function isIntakeSession(s: Pick<SessionRow, "plan">): boolean {
  const plan = s.plan as unknown;
  return !!plan && typeof plan === "object" && !Array.isArray(plan) && "intake" in plan;
}

/** Session states in which a session is working (or about to). */
export const WORKING_SESSION = new Set(["planned", "running", "paused"]);

/**
 * The session working on the project now: its id, its agent, the task in flight (from its
 * last `task.started` without a `task.finished` after it) and when it began. Null when none.
 */
export async function workingOn(
  store: StateStore,
  projectId: string,
): Promise<ProjectWorking | null> {
  const rows: SessionRow[] = [];
  for (const status of WORKING_SESSION)
    rows.push(
      ...(await store.session.list({ project_id: projectId, status } as never, {
        orderBy: [{ column: "created_at", direction: "desc" }],
        limit: 5,
      })),
    );
  // The plan from the brief is drafted in a session row of its own (`plan.intake`): that is
  // "Drafting the plan…", not work on the project's tasks (bench walk: the header said "Alice is
  // working on Quote page" with Stop all while the plan was being drafted).
  const s = rows
    .filter((r) => r.summary !== "conversation" && !isIntakeSession(r))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!s) return null;
  const agentName = (await store.agent.get(s.agent_id))?.name ?? null;
  // d1109-run-visible (D8-1): the newest task.started or task.finished only, as the run
  // indicator reads a session's log (before: the session's whole event list, per project card).
  const [last] = await store.event.ofTypes(s.id, ["task.started", "task.finished"], { limit: 1 });
  const payload = (last?.payload ?? {}) as { title?: unknown; taskId?: unknown };
  const running = last?.type === "task.started";
  return {
    sessionId: s.id,
    agentName,
    taskId: running && typeof payload.taskId === "string" ? payload.taskId : null,
    taskTitle: running && typeof payload.title === "string" ? payload.title : null,
    since: s.started_at ?? s.created_at,
  };
}

/** The task ids a session's handoff left waiting for the person (`handoff.blocked`). */
export function blockedTaskIds(handoff: unknown): string[] {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return [];
  const b = (handoff as { blocked?: unknown }).blocked;
  return Array.isArray(b) ? b.filter((x): x is string => typeof x === "string") : [];
}

/** Display keys of a task that still waits for the person as the session left it. */
const STILL_WAITS_ON_PERSON = new Set<TaskDisplay["key"]>(["answer", "failed"]);

/**
 * 'Since then: "Write the README" is done.' for each task the last session left waiting for
 * the person that has moved on, at most three, then "and N more" (C-54). A task still waiting
 * (its card open, still failed) or gone says nothing: the summary already says it.
 */
export function sinceLines<T extends Pick<TaskRow, "id" | "title">>(
  blocked: readonly string[],
  tasks: ReadonlyMap<string, T>,
  displayOf: (t: T) => TaskDisplay,
): string[] {
  const moved: string[] = [];
  for (const id of new Set(blocked)) {
    const t = tasks.get(id);
    if (!t) continue;
    const d = displayOf(t);
    if (STILL_WAITS_ON_PERSON.has(d.key)) continue;
    const label = d.label.charAt(0).toLowerCase() + d.label.slice(1);
    moved.push(`Since then: "${shortTitle(t.title, 60)}" is ${label}.`);
  }
  return moved.length > NEXT_LINES
    ? [...moved.slice(0, NEXT_LINES), `and ${moved.length - NEXT_LINES} more`]
    : moved;
}
