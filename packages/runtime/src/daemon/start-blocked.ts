import type { JsonObject, StateStore } from "@forerunner/state";
import { nothingRunsYetSentence } from "../session/credential-wait.ts";
import type { StartCheck } from "../session/start-check.ts";
import type { StartCheckView } from "./api-types.ts";
import { type HeldTask, heldBlocker, outerLimitHold } from "./held-words.ts";
import { resetDay } from "./request-words.ts";
import { isPausedByPerson } from "./task-words.ts";

export type { HeldTask } from "./held-words.ts";

/** What else decides whether a Start would do anything. */
export interface StartBlockedFacts {
  /** Stop all is on for the agent (the kill switch is frozen). */
  stopped: boolean;
  /** A model (a Claude key or subscription) is configured. */
  hasModel: boolean;
  /**
   * A session of the agent runs now whose work can make this project's tasks ready: one on this
   * project, or one tied to no project (`busyHere`). A start then waits for it rather than being
   * refused. Another project's session does not count: a task waits only on tasks of its own
   * project, so that work makes nothing here ready (later #38).
   */
  busy: boolean;
  projectId: string;
  chfPerUsd: number;
  /**
   * The plan from the project's brief while no task is written yet: it waits for the person's
   * approval in the Inbox (`pending`) or is being drafted (`drafting`); null or absent otherwise
   * (`IntakeService.status`).
   */
  plan?: "pending" | "drafting" | "waiting" | null;
  /**
   * With `plan: "waiting"` (U-078): what planning waits for, as the project page says it
   * ("Planning waits for a new API key: save one in Settings."), and where a refused key is
   * replaced.
   */
  planWait?: { text: string; save: { label: string; to: string } | null } | null;
  /**
   * R-startcred (U-078): no ready task can run now because each one's credential rests or was
   * refused (its own pick waits), as the wait's sentence ("Waits for a new API key: save one in
   * Settings.", "Waits until 15:40 (your subscription's limit) and starts by itself.") and the
   * link that replaces a refused credential. Null or absent: a task's credential serves now.
   */
  credentialWait?: {
    text: string;
    save: { label: string; to: string } | null;
    /**
     * TR-2: a resting credential whose wait no Start has kept yet: `text` is the whole sentence
     * ("Nothing can run until 15:40 (...). Press Start and the work starts then.") and Start stays on.
     */
    startable?: boolean;
    /** S-10: the person's session (or a Start they pressed) is kept on the wait: Cancel drops it. */
    kept?: boolean;
    /** S-10, with `startable`: the Start button's words ("Start at 15:40"). */
    startLabel?: string;
    /**
     * S-10: a Start the person pressed is kept for the reset: "Starts at 15:40 (your
     * subscription's limit)" (l4-cred-screens, L4-creds-26: the dialog says it, with Cancel;
     * before, "...; then your session goes on." for a start that is no session yet).
     */
    startsAt?: string;
  } | null;
  /**
   * C2-left-2 (run C3): with no task ready, the title of a task of the project that waits on the
   * person's card (a pause that got no further, a question): the sentence names it with Open it
   * (design §3.6: 'Nothing can run: "Step 3" needs your answer [Open it]'). Null or absent: none.
   */
  needsYou?: string | HeldTask | null;
  /**
   * L4g-left-1: why each `needs_human` task of the project holds (by task id), so a task that
   * waits on one names what holds it (`heldFacts`). Absent: every such task needs an answer.
   */
  held?: Readonly<Record<string, HeldTask>> | null;
}

/**
 * The project's `needs_human` tasks and why each holds (`HeldTask`), read-only, and the first
 * one an open card or a limit holds (the `needsYou` fact): one reading for the Start dialog's
 * check (`GET /projects/:id/start-check`) and chat's start (`CommandPorts.startBlocked`), so
 * both say the same sentence.
 */
export async function heldFacts(
  store: Pick<StateStore, "task" | "humanRequest">,
  projectId: string,
): Promise<{ needsYou: HeldTask | null; held: Record<string, HeldTask> }> {
  const tasks = await store.task.forProject(projectId, { status: ["needs_human"] }, { limit: 50 });
  const held: Record<string, HeldTask> = {};
  let needsYou: HeldTask | null = null;
  for (const t of tasks) {
    const open = await store.humanRequest.list({ task_id: t.id, status: "open" } as never, {
      limit: 5,
    });
    const limit = open
      .map((r) => outerLimitHold(r.change_card as JsonObject | null, resetDay))
      .find((h) => h !== null);
    const one: HeldTask | null = limit
      ? { title: t.title, why: "limit", clause: limit.clause, to: limit.to }
      : open.length > 0
        ? { title: t.title, why: "answer" }
        : isPausedByPerson(t, false)
          ? { title: t.title, why: "paused" }
          : null;
    if (!one) continue;
    held[t.id] = one;
    if (!needsYou && one.why !== "paused") needsYou = one;
  }
  return { needsYou, held };
}

/**
 * Whether the session the agent runs now (`active`, the scheduler's `activeStart`) can make
 * `projectId`'s tasks ready: it works on that project, or on no project in particular. The
 * `busy` fact of `startBlocked`. Before, any running session counted, so a start on a project
 * with nothing to run was queued behind another project's session and became a session that
 * ran nothing (design §4.8: nothing runnable means no session; later #38).
 */
export function busyHere(
  active: { req: { projectId?: string | undefined } } | undefined,
  projectId: string,
): boolean {
  if (!active) return false;
  return active.req.projectId === undefined || active.req.projectId === projectId;
}

/**
 * Why a Start now would do nothing (design §3.6), first match wins: sessions are stopped, no
 * Claude credential, nothing can run (the first blocker, named with the button that unblocks
 * it). Null when a session would work. The Start dialog (`GET /projects/:id/start-check`) and
 * the chat's "start a session" (`session.start` through `CommandPorts.startBlocked`) say the
 * same sentence. With no task written yet because the plan from the brief waits for approval
 * or is being drafted, the sentence names the plan and its button is the plan card (design
 * §3.3), not the Tasks tab.
 */
export function startBlocked(r: StartCheck, f: StartBlockedFacts): StartCheckView["blocked"] {
  const blocked = firstBlocker(r, f);
  // R-startcred: tasks would run, but no credential can serve them now: Start would end at once
  // with the wait (before, the dialog said "This session runs ..." and the session then waited).
  if (blocked === null && f.credentialWait && runsWork(r) && !f.busy)
    return {
      kind: "nothing_runnable",
      // W15-78: one sentence with a subject (before: "Nothing can run yet. Waits until ...").
      sentence: f.credentialWait.startable
        ? f.credentialWait.text
        : f.credentialWait.kept && f.credentialWait.startsAt
          ? `${f.credentialWait.startsAt}.`
          : nothingRunsYetSentence(f.credentialWait.text),
      action: f.credentialWait.save
        ? { kind: "link", label: f.credentialWait.save.label, to: f.credentialWait.save.to }
        : null,
      ...(f.credentialWait.startable ? { startable: true } : {}),
      ...(f.credentialWait.kept ? { kept: true } : {}),
      ...(f.credentialWait.startable && f.credentialWait.startLabel
        ? { startLabel: f.credentialWait.startLabel }
        : {}),
    };
  if (blocked?.kind !== "nothing_runnable" || r.ready !== 0) return blocked;
  if (f.plan === "pending")
    return {
      kind: "nothing_runnable",
      sentence: "Nothing can run yet: the plan from your brief waits for your approval.",
      action: { kind: "link", label: "Review the plan", to: "/inbox" },
    };
  if (f.plan === "drafting")
    return {
      kind: "nothing_runnable",
      sentence: "Nothing can run yet: the plan from your brief is being drafted.",
      action: null,
    };
  // U-078: the plan waits for a Claude credential; it is drafted by itself once one serves.
  if (f.plan === "waiting")
    return {
      kind: "nothing_runnable",
      sentence: `Nothing can run yet. ${f.planWait?.text ?? "Planning waits for a Claude credential."}`,
      action: f.planWait?.save
        ? { kind: "link", label: f.planWait.save.label, to: f.planWait.save.to }
        : null,
    };
  return blocked;
}

/**
 * Whether a session started now runs work: a ready task that fits, or the task larger than the
 * work budget it takes with what is left (D4, `StartCheck.oversized`).
 */
export function runsWork(r: Pick<StartCheck, "runnable"> & { oversized?: unknown }): boolean {
  return r.runnable.length > 0 || !!r.oversized;
}

function firstBlocker(r: StartCheck, f: StartBlockedFacts): StartCheckView["blocked"] {
  if (f.stopped)
    return {
      kind: "stopped",
      sentence: "Sessions are stopped (Stop all), so nothing can start.",
      action: { kind: "resume", label: "Allow sessions again", to: null },
    };
  if (!f.hasModel)
    return {
      kind: "no_model",
      sentence: "Claude is not connected: planning and tasks need it.",
      action: { kind: "link", label: "Connect Claude", to: "/settings" },
    };
  // A session runs now on this project: the start waits for it, and its work makes more tasks
  // ready. One on another project makes none of these ready (`busyHere`).
  if (runsWork(r) || f.busy) return null;
  const tasksTab = `/projects/${encodeURIComponent(f.projectId)}/tasks`;
  const stuck = r.waiting.find((w) =>
    w.waitsOn.some(
      (d) =>
        d.status === "needs_human" ||
        d.status === "failed" ||
        d.status === "cancelled" ||
        d.status === null,
    ),
  );
  if (stuck) {
    const dep = stuck.waitsOn.find((d) => d.status !== "done") ?? stuck.waitsOn[0];
    const name = dep?.title ? `"${dep.title}"` : "a task that does not exist";
    if (dep?.status === "needs_human") {
      // L4g-left-1: what holds it, as the Tasks row says it (a limit, the person's own pause).
      const h = f.held?.[dep.id];
      if (h && h.why !== "answer") return heldBlocker(h, stuck.title, tasksTab);
      return {
        kind: "nothing_runnable",
        sentence: `Nothing can run: ${name} needs your answer.`,
        action: { kind: "link", label: "Open it", to: "/inbox" },
      };
    }
    return {
      kind: "nothing_runnable",
      sentence: `Nothing can run: "${stuck.title}" waits on ${name}, which ${dep?.status === "cancelled" ? "was cancelled" : dep?.status === "failed" ? "failed" : "does not exist"}.`,
      action: { kind: "link", label: "Open Tasks", to: tasksTab },
    };
  }
  const docker = r.waitingForSandbox?.tasks[0];
  if (docker)
    return {
      kind: "nothing_runnable",
      sentence: `Nothing can run: "${docker.title}" is waiting for Docker.`,
      action: { kind: "link", label: "Set up Docker", to: "/settings#sandbox" },
    };
  // C2-left-2: nothing is ready because a task waits on the person's card: name it.
  if (r.ready === 0 && f.needsYou)
    return heldBlocker(
      typeof f.needsYou === "string" ? { title: f.needsYou, why: "answer" } : f.needsYou,
      null,
      tasksTab,
    );
  // D4 (d1109-oversize-start): a task larger than the work budget is no blocker any more: the
  // session takes it with the whole work budget (`runsWork`), and the Start check's `oversized`
  // warns. Before: "Nothing can run within this budget: "X" needs about CHF 6.00." with Start
  // off, and POST /sessions refused it.
  return {
    kind: "nothing_runnable",
    sentence:
      r.ready === 0
        ? "Nothing can run: no task is ready."
        : "Nothing can run: every ready task waits on another one.",
    action: { kind: "link", label: "Open Tasks", to: tasksTab },
  };
}
