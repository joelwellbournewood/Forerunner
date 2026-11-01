import { formatChf, usdToChfMicro } from "@forerunner/billing";
import type { StartCheck } from "../session/start-check.ts";
import type { StartCheckView } from "./api-types.ts";

/** What else decides whether a Start would do anything. */
export interface StartBlockedFacts {
  /** Stop all is on for the agent (the kill switch is frozen). */
  stopped: boolean;
  /** A model (a Claude key or subscription) is configured. */
  hasModel: boolean;
  /** A session of the agent runs now: a start waits for it, and its work makes tasks ready. */
  busy: boolean;
  projectId: string;
  chfPerUsd: number;
  /**
   * The plan from the project's brief while no task is written yet: it waits for the person's
   * approval in the Inbox (`pending`) or is being drafted (`drafting`); null or absent otherwise
   * (`IntakeService.status`).
   */
  plan?: "pending" | "drafting" | null;
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
  // A session runs now: the start waits for it, and its work makes more tasks ready.
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
