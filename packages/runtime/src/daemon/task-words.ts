import type { HumanRequestRow, RunRow, TaskRow, TaskStatus } from "@forerunner/state";
import { FULL_REVIEW_TIER } from "../session/sandbox-gate.ts";
import type { TaskAction, TaskDisplay } from "./api-types.ts";

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
  try_again: ["failed"],
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
  /** The project's tasks by id (the ones a task waits for are among them). */
  tasks: ReadonlyMap<string, Pick<TaskRow, "id" | "title" | "status" | "reason">>;
  /** Open Inbox cards by the task they are about (the oldest first). */
  cards: ReadonlyMap<string, Pick<HumanRequestRow, "id">>;
  /** Whether the Docker sandbox is ready; null when it was not checked yet. */
  sandboxReady: boolean | null;
  /** The latest run of each task: when it began and who runs it. */
  runs: ReadonlyMap<string, Pick<RunRow, "created_at" | "specialist">>;
  /** Agents' names by id: a running task names its agent, never an id. */
  agentNames: ReadonlyMap<string, string>;
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

/**
 * A stored reason as one plain line (design §5): no ids, no ladder words, at most `max`
 * characters, cut at a word. The runner's own texts are rewritten where they are known.
 */
export function plainReason(reason: string, max = 100): string {
  let r = reason.replace(IDS, "").replace(/\s+/g, " ").trim();
  const ladder = /^retry ladder exhausted after (\d+) failed attempt/i.exec(r);
  if (ladder) r = `tried ${ladder[1]} times`;
  r = r
    .replace(/\(ceiling [^)]*\)/gi, "")
    .replace(/\bat (?:haiku|sonnet|opus)\b/gi, "")
    .replace(/:\s*human decides$/i, "")
    .replace(/\[stand-in model\]\s*/gi, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (r.length <= max) return r;
  const cut = r.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
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
  };
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
    case "done":
      return /accepted without review/i.test(task.reason)
        ? display("done", "Done: accepted without review", "good")
        : display("done", "Done", "good");
    case "failed": {
      const why = plainReason(task.reason);
      return display("failed", why ? `Failed: ${why}` : "Failed", "bad", {
        ...(card
          ? { blocker: { kind: "card", taskId: null, requestId: card.id, title: null } }
          : {}),
      });
    }
    case "in_review":
      return display("review", "Being reviewed", "info", {
        detail: "The critic is checking the work.",
      });
    case "claimed":
    case "in_progress": {
      const run = ctx.runs.get(task.id);
      const agentName = task.claimed_by ? (ctx.agentNames.get(task.claimed_by) ?? null) : null;
      return display("running", "Running", "info", {
        agentName,
        since: run?.created_at ?? task.updated_at,
        ...(run?.specialist ? { detail: `The ${run.specialist} is working on it.` } : {}),
      });
    }
    case "needs_human": {
      if (card)
        return display("answer", "Needs your answer", "warn", {
          detail: "Its card is in the Inbox.",
          blocker: { kind: "card", taskId: null, requestId: card.id, title: null },
        });
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
          detail:
            "Full review runs in Docker, which is not running on this computer. Set up Docker, or edit the task to a light review.",
          blocker: { kind: "docker", taskId: null, requestId: null, title: null },
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
