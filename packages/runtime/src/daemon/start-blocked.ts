import { formatChf, usdToChfMicro } from "@forerunner/billing";
import type { StartCheck } from "../session/start-check.ts";
import type { StartCheckView } from "./api-types.ts";

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
  if (r.runnable.length > 0 || f.busy) return null;
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
    if (dep?.status === "needs_human")
      return {
        kind: "nothing_runnable",
        sentence: `Nothing can run: ${name} needs your answer.`,
        action: { kind: "link", label: "Open it", to: "/inbox" },
      };
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
  const big = r.overBudget[0];
  if (big)
    return {
      kind: "nothing_runnable",
      sentence: `Nothing can run within this budget: "${big.title}" needs about ${formatChf(usdToChfMicro(big.estimateUsdMicro, f.chfPerUsd))}.`,
      action: null,
    };
  return {
    kind: "nothing_runnable",
    sentence:
      r.ready === 0
        ? "Nothing can run: no task is ready."
        : "Nothing can run: every ready task waits on another one.",
    action: { kind: "link", label: "Open Tasks", to: tasksTab },
  };
}
