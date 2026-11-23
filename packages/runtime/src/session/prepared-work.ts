import { errorMessage, ForerunnerError, log } from "@forerunner/platform";
import type { JsonObject, ProjectRow, StateStore } from "@forerunner/state";

import { canonicalSpecialistName } from "../registry/specialist-names.ts";
import type { AdmitContext, AdmitOutcome, LiveSessions, PrepareBy } from "./live-sessions.ts";
import type { StartOutcome, StartRequest } from "./triggers.ts";

export type { PrepareBy } from "./live-sessions.ts";

/**
 * Prepared work (d1109-starts-engine S-2, ADR 0118; the owner, 2026-11-09: "the user clearly
 * states when a session will run, such that they could maybe queue up tasks and then change
 * things and then also give some text context into the chat ... and only then run a session").
 *
 * Every action that makes a task runnable without the person pressing Start (an Inbox answer, a
 * Tasks-row action, chat's change of a task, a raised or reset limit, a late approval, a
 * credential back for work outside the person's session) prepares the work here, in one place:
 * it joins the session of its project that runs now if it fits that session's promise (option C,
 * `LiveSessions`), else it waits for the person's next Start, said in one line. A session starts
 * from here only when the project's "Start a session by itself" is on (`by: "hands_off"`, S-5),
 * never for work the agent prepared (D7). Nothing of a card's or a chat's text reaches a prompt
 * from here.
 */

/** What became of prepared work (stored on an answered card as `change_card.start`). */
export type PrepareOutcome =
  | AdmitOutcome
  /** Nothing runs it now: the person's next Start does. */
  | "waits_start"
  /** The person's own session waits to go on (S-10): it takes the task then if it fits. */
  | "waits_continuation"
  /** Stop all is on: nothing starts until the person allows sessions again. */
  | "stopped_all"
  /** The hands-off setting started a session for it (S-5). */
  | "started"
  /** The hands-off setting's session waits behind the one that runs. */
  | "queued"
  /** The hands-off setting's session waits for the end of the person's quiet hours. */
  | "deferred"
  /** No task of the project can run now (nothing to say). */
  | "nothing_to_run"
  /** The hands-off setting's start failed: it runs at the next Start. */
  | "failed";

export interface PrepareRequest {
  agentId: string;
  projectId: string | null;
  /** The tasks prepared; absent: whatever of the project can run now (a task closed as done). */
  taskIds?: readonly string[];
  /** Why, for the logs (never a prompt). */
  reason: string;
  by: PrepareBy;
  /** D7's relation to the session's promise (`AdmitContext`). */
  context?: AdmitContext;
}

export interface PrepareResult {
  outcome: PrepareOutcome;
  /** The one line that says what happens next, or null when there is nothing to say. */
  line: string | null;
  /** Set when the hands-off setting asked for the start (its words say so). */
  startedBy?: "hands_off";
}

/** The daemon's `prepareWork` over its scheduler, registry and settings (compose builds it). */
export type PreparePort = (req: PrepareRequest) => Promise<PrepareResult | null>;

export interface PrepareDeps {
  store: StateStore;
  live?: Pick<LiveSessions, "forProject">;
  /** The scheduler's `requestStart` (a hands-off start only). */
  start?: (req: StartRequest) => Promise<{ id: string; result: StartOutcome }>;
  /** Stop all is on for the agent. */
  frozen?: (agentId: string) => boolean;
  /** A session of this project already asked for or running in the scheduler (no handle yet). */
  startedFor?: (agentId: string, projectId: string) => boolean;
  /** The person's own session waits to go on for this project (S-10). */
  continuationWaits?: (projectId: string) => Promise<boolean>;
  now: () => string;
}

/** The project's "When work is ready": start a session by itself (S-5), off unless set. */
export function startsByItself(project: Pick<ProjectRow, "settings"> | null | undefined): boolean {
  return (project?.settings as JsonObject | undefined)?.start_by_itself === true;
}

/** The tasks of the project a session could run now (ready, nothing they wait on unfinished). */
async function runnableNow(
  store: StateStore,
  projectId: string,
  taskIds: readonly string[] | undefined,
): Promise<string[]> {
  // A task planned for the person is no work for a session (live L-11).
  const ready = (await store.task.readyTasks(projectId, { limit: 100 })).filter(
    (t) => !t.specialist || canonicalSpecialistName(t.specialist) !== "person",
  );
  const ids = ready.map((t) => t.id);
  return taskIds ? ids.filter((id) => taskIds.includes(id)) : ids;
}

/**
 * One outcome for several tasks a session answered for at once: "joined" only when every one
 * joined (C3-left-3: one that joined made the line say so for all); some joined and some not,
 * the room rule's words, which are true of each.
 */
export function summarize(answers: Map<string, AdmitOutcome>): AdmitOutcome {
  const all = [...answers.values()];
  if (all.length > 0 && all.every((a) => a === "joined")) return "joined";
  if (all.length > 0 && all.every((a) => a === "stopping")) return "stopping";
  // L4-money-203: tasks too large for the session (and the ones it stopped taking) never join.
  if (all.includes("too_large") && all.every((a) => a === "too_large" || a === "stopping"))
    return "too_large";
  return all.includes("joined") || all.includes("no_room") ? "no_room" : "stopping";
}

/**
 * Prepare work (S-2): it joins the project's running session if it fits (option C), else it
 * waits for the person's next Start; with "Start a session by itself" on (and work the person or
 * the system prepared, never the agent's own) a session starts for it (`hands_off`), held by
 * quiet hours and kept on the project when it cannot start now (`keepStartPending`). Never
 * throws: a failure is logged and said as `failed` ("it runs at your next Start").
 */
export async function prepareWork(
  deps: PrepareDeps,
  req: PrepareRequest,
): Promise<PrepareResult | null> {
  if (!req.projectId) return null;
  const { store } = deps;
  try {
    const runnable = await runnableNow(store, req.projectId, req.taskIds);
    if (runnable.length === 0) return { outcome: "nothing_to_run", line: null };
    const handle = deps.live?.forProject(req.projectId);
    if (handle) {
      const outcome = summarize(await handle.admit(runnable, req.by, req.context));
      return { outcome, line: preparedLine(outcome) };
    }
    // A session of the project was asked for and has not registered yet (it plans now): its
    // plan or its next look takes the task if it fits.
    if (deps.startedFor?.(req.agentId, req.projectId))
      return { outcome: "no_room", line: preparedLine("no_room") };
    if (await deps.continuationWaits?.(req.projectId))
      return { outcome: "waits_continuation", line: preparedLine("waits_continuation") };
    const project = await store.project.get(req.projectId);
    if (!startsByItself(project) || req.by === "agent" || !deps.start)
      return { outcome: "waits_start", line: preparedLine("waits_start") };
    if (deps.frozen?.(req.agentId))
      return { outcome: "stopped_all", line: preparedLine("stopped_all") };
    const entry = await deps.start({
      agentId: req.agentId,
      projectId: req.projectId,
      trigger: "message",
      by: "hands_off",
      reason: req.reason,
    });
    // A start that waits (quiet hours, another session) is kept on the project, so it is asked
    // again after a restart too (S-5); the sweep clears it once it starts.
    if (entry.result !== "started")
      await keepStartPending(store, req.projectId, {
        since: deps.now(),
        why: entry.result,
      }).catch(() => undefined);
    return {
      outcome: entry.result,
      line: preparedLine(entry.result, "hands_off"),
      startedBy: "hands_off",
    };
  } catch (e) {
    log("prepared-work").warn("prepared work not placed", {
      projectId: req.projectId,
      error: errorMessage(e),
    });
    return { outcome: "failed", line: preparedLine("failed") };
  }
}

/**
 * What prepared work would do now, read-only (chat's read-back of a move, S-9): nothing is
 * admitted and nothing starts. A running session answers with the room rule's words, since the
 * room is decided at the move.
 */
export async function previewWork(
  deps: Pick<PrepareDeps, "store" | "live" | "startedFor" | "continuationWaits">,
  req: Pick<PrepareRequest, "agentId" | "projectId" | "by">,
): Promise<string | null> {
  if (!req.projectId) return null;
  if (deps.live?.forProject(req.projectId) || deps.startedFor?.(req.agentId, req.projectId))
    return preparedLine("no_room");
  if (await deps.continuationWaits?.(req.projectId)) return preparedLine("waits_continuation");
  const project = await deps.store.project.get(req.projectId);
  return startsByItself(project) && req.by !== "agent"
    ? preparedLine("started", "hands_off")
    : preparedLine("waits_start");
}

/**
 * The one line an action that prepared work says next (design §5: one sentence, at most 100
 * characters, true now). "by itself" only where the hands-off setting makes it true (S-12).
 */
export function preparedLine(outcome: PrepareOutcome, by?: "hands_off"): string | null {
  switch (outcome) {
    case "joined":
      return "It joins the session that is running.";
    case "no_room":
      return "Ready: it joins this session if budget is left after its own tasks, else your next Start.";
    case "too_large":
      return "Ready: it is larger than this session's budget, so it runs at your next Start.";
    case "stopping":
    case "waits_start":
      return "Ready: it runs at your next Start.";
    case "waits_continuation":
      return "Ready: it joins your session when it goes on, if it fits, else your next Start.";
    case "stopped_all":
      return "Ready: sessions are stopped; it runs at your next Start once you allow them again.";
    case "started":
      return by === "hands_off"
        ? "A session started for it (this project starts by itself when work is ready)."
        : "A session started.";
    case "queued":
      return by === "hands_off"
        ? "A session starts for it after the current one (this project starts by itself)."
        : "It runs after the current session.";
    case "deferred":
      return "Ready: it runs after your quiet hours.";
    case "failed":
      return "Ready: the session did not start; it runs at your next Start.";
    case "nothing_to_run":
      return null;
  }
}

/**
 * The same, as the clause a card's Done line ends with ("Trying "X" again: it runs at your next
 * Start."): the line without its "Ready: " and full stop, lower-case.
 */
export function preparedClause(outcome: unknown, by?: unknown): string | null {
  if (typeof outcome !== "string") return null;
  const line = preparedLine(
    outcome as PrepareOutcome,
    by === "hands_off" ? "hands_off" : undefined,
  );
  if (!line) return null;
  const bare = line.replace(/^Ready: /, "").replace(/\.$/, "");
  return bare.charAt(0).toLowerCase() + bare.slice(1);
}

/** Whether a stored `change_card.start` is a prepared outcome (not an old start's). */
export function isPreparedOutcome(outcome: unknown): outcome is PrepareOutcome {
  return (
    outcome === "joined" ||
    outcome === "no_room" ||
    outcome === "too_large" ||
    outcome === "stopping" ||
    outcome === "waits_start" ||
    outcome === "waits_continuation" ||
    outcome === "stopped_all"
  );
}

/**
 * What an option that prepares work says will happen (a card's explain, read when the card is
 * shown, S-9): a running session of the project takes it if it fits; the person's own session
 * that waits to go on takes it then; with "Start a session by itself" on a session starts for it
 * (after the current one, after the quiet hours, never while sessions are stopped); else the
 * person's next Start runs it. The same steps, in the same order, as `prepareWork`'s, so pressing
 * the option does what its explain said (`preparedContextOf` reads them).
 */
export interface PreparedContext {
  /** A session of the card's project runs now, or one of another project does. */
  running?: "this_project" | "other" | null;
  /** The project's "When work is ready: Start a session by itself" is on. */
  startsByItself?: boolean;
  /** The person's own session waits to go on for this project (S-10). */
  continuationWaits?: boolean;
  /** Stop all is on: the hands-off setting starts nothing. */
  stopped?: boolean;
  /** The person's quiet hours hold a start they did not press now. */
  quiet?: boolean;
}

/** The clause an option's explain ends with ("...; it runs at your next Start."). */
export function preparedExplain(ctx: PreparedContext = {}): string {
  if (ctx.running === "this_project") return "it joins the running session if it fits";
  if (ctx.continuationWaits) return "it joins your session when it goes on, if it fits";
  if (ctx.startsByItself) {
    if (ctx.stopped) return "it runs at your next Start once you allow sessions again";
    if (ctx.quiet) return "a session starts for it after your quiet hours";
    return ctx.running === "other"
      ? "a session starts for it after the current one"
      : "a session starts for it by itself";
  }
  return "it runs at your next Start";
}

/** What `preparedContextOf` reads beyond `PrepareDeps`. */
export interface PreparedContextDeps
  extends Pick<PrepareDeps, "store" | "live" | "startedFor" | "continuationWaits" | "frozen"> {
  /** A session of another project of the agent runs or was asked for now. */
  runningOther?: (agentId: string, projectId: string) => boolean;
  /** The person's quiet hours hold a start they did not press now (read fresh). */
  quietNow?: () => Promise<boolean>;
}

/**
 * What prepared work of this project would meet now, read-only (S-9: a card's explain is read
 * when the card is shown, design §5 rule 4): the facts `prepareWork` decides by, nothing admitted
 * and nothing started.
 */
export async function preparedContextOf(
  deps: PreparedContextDeps,
  req: { agentId: string; projectId: string },
): Promise<PreparedContext> {
  const own =
    !!deps.live?.forProject(req.projectId) || !!deps.startedFor?.(req.agentId, req.projectId);
  const running: PreparedContext["running"] = own
    ? "this_project"
    : deps.runningOther?.(req.agentId, req.projectId)
      ? "other"
      : null;
  const project = await deps.store.project.get(req.projectId).catch(() => undefined);
  const byItself = startsByItself(project);
  const waits = !own && !!(await deps.continuationWaits?.(req.projectId).catch(() => false));
  const quiet = byItself && !!(await deps.quietNow?.().catch(() => false));
  return {
    running,
    ...(byItself ? { startsByItself: true } : {}),
    ...(waits ? { continuationWaits: true } : {}),
    ...(byItself && deps.frozen?.(req.agentId) ? { stopped: true } : {}),
    ...(quiet ? { quiet: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// A hands-off start that could not start now (S-5): kept on the project (`summary_cache`).

/** The key on `project.summary_cache` of a hands-off start that waits. */
export const START_PENDING_KEY = "start_pending";

export interface StartPending {
  /** When it was kept (ISO). */
  since: string;
  /** Why it waits: quiet hours (`deferred`) or another session (`queued`). */
  why: string;
}

/** The kept hands-off start of a project, read-only (C4's Make one project reads it). */
export function startPendingOf(
  project: Pick<ProjectRow, "summary_cache"> | null | undefined,
): StartPending | null {
  const cache = project?.summary_cache as JsonObject | undefined;
  const raw = cache?.[START_PENDING_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { since, why } = raw as Record<string, unknown>;
  return typeof since === "string" ? { since, why: typeof why === "string" ? why : "" } : null;
}

/** Change `summary_cache` with the version check (a write another beat is read again). */
async function changeCache(
  store: Pick<StateStore, "project">,
  projectId: string,
  change: (cache: JsonObject) => JsonObject | null,
): Promise<void> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const row = await store.project.get(projectId);
    if (!row) return;
    const next = change({ ...((row.summary_cache ?? {}) as JsonObject) });
    if (next === null) return;
    try {
      await store.project.update(row.id, row.version, { summary_cache: next });
      return;
    } catch (e) {
      if (e instanceof ForerunnerError && e.code === "version_conflict") continue;
      throw e;
    }
  }
}

/** Keep a hands-off start that waits (one per project; a newer one keeps the first `since`). */
export async function keepStartPending(
  store: Pick<StateStore, "project">,
  projectId: string,
  pending: StartPending,
): Promise<void> {
  await changeCache(store, projectId, (cache) =>
    startPendingOf({ summary_cache: cache })
      ? null
      : { ...cache, [START_PENDING_KEY]: { ...pending } },
  );
}

/** Drop a project's kept hands-off start (it started, or Stop all or the person dropped it). */
export async function dropStartPending(
  store: Pick<StateStore, "project">,
  projectId: string,
): Promise<void> {
  await changeCache(store, projectId, (cache) => {
    if (!(START_PENDING_KEY in cache)) return null;
    const { [START_PENDING_KEY]: _gone, ...rest } = cache;
    return rest;
  });
}

/**
 * A person's start (S-1): Start, Approve and start, Continue on a budget card, Use API key. The
 * same scheduler request, with who asked, so quiet hours never hold it.
 */
export function personStart<T>(
  start: (req: StartRequest) => Promise<T>,
  req: Omit<StartRequest, "by">,
): Promise<T> {
  return start({ ...req, by: "person" });
}
