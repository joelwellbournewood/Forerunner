/**
 * Who started a session, in words (l4-starts-sessions, L4-money-206): one map for the Sessions
 * row's "why it started" (`startedByWords`, session-list.ts) and the session page's first log
 * line (`personLine('session.started')`, event-lines.ts). Before, the page read only the trigger:
 * a session the hands-off setting started read "The session started with a budget of CHF 1.00."
 * while its row said "started by itself when work was ready".
 */

/** Who asked for a session (`plan.startedBy.by`, the `session.started` event's `by`). */
export type StartedByWho = "person" | "schedule" | "hands_off" | "continuation";

/**
 * The reason a row names beside a session the person did not press Start for, or null for the
 * person's own Start (nothing to say). `remote` is the phone's trigger.
 */
export function startedByReason(
  by: StartedByWho,
  opts: { trigger?: string | null; continuesAt?: string | null } = {},
): string | null {
  switch (by) {
    case "schedule":
      return "started on its schedule";
    case "person":
      return opts.trigger === "remote" ? "started from your phone" : null;
    case "hands_off":
      // S-5: the project's "Start a session by itself" setting started it.
      return "started by itself when work was ready";
    case "continuation":
      // S-10: the person's own session going on after a wait for its Claude credential.
      return opts.continuesAt
        ? `goes on with your session of ${opts.continuesAt}`
        : "goes on with your earlier session";
  }
}

/**
 * The session page's first line: who started it and its budget. An event written before `by`
 * existed reads by its trigger: a press ("manual") is the person's, anything else "The session".
 */
export function startedLine(
  by: StartedByWho | null,
  trigger: string | null,
  budget: string,
): string {
  switch (by) {
    case "person":
      return trigger === "remote"
        ? `You started the session from your phone with a budget of ${budget}.`
        : `You started the session with a budget of ${budget}.`;
    case "schedule":
      return `Started on its schedule, with a budget of ${budget}.`;
    case "hands_off":
      return `Started by itself when work was ready (this project's setting), with a budget of ${budget}.`;
    case "continuation":
      return `It goes on with a budget of ${budget}.`;
    default:
      return trigger === "manual" || trigger === "remote"
        ? `You started the session with a budget of ${budget}.`
        : `The session started with a budget of ${budget}.`;
  }
}

/** A stored `by` read safely (an old or foreign value is none). */
export function startedByOfValue(v: unknown): StartedByWho | null {
  return v === "person" || v === "schedule" || v === "hands_off" || v === "continuation" ? v : null;
}
