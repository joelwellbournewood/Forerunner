import { saidByName } from "@forerunner/critic";
import type { SessionRow, StateStore } from "@forerunner/state";
import { keptContinuationOf, keptStartOf } from "../wiring/billing-pick.ts";
import type { RunningHealth, RunningView } from "./api-types.ts";
import { isIntakeSession } from "./project-status.ts";
import {
  CALIBRATION_NAME,
  calibrationExplain,
  emptyRunFold,
  foldRunEvents,
  type RunFold,
  type RunState,
  type RunWait,
  type RunWords,
  runFit,
  stopChoices,
  summaryAfterWait,
  runText as wordsText,
} from "./run-words.ts";

export * from "./run-words.ts";

// --- A stored result's promise, as it holds now (C3-left-8) ---------------------------------------

/** The clause a stored result ends with while the person's session waits to go on. */
const GOES_ON_CLAUSE = "; then your session goes on.";

/** Whether a session row is the continuation of the person's waiting session (S-10). */
function startedByContinuation(row: Pick<SessionRow, "plan">): boolean {
  const by = (row.plan as { startedBy?: { by?: unknown } } | null)?.startedBy?.by;
  return by === "continuation";
}

/**
 * C3-left-8 (and the review of d1109-run-visible, blocking 3): whether "...; then your session
 * goes on." in a result written at `since` for a project is still true. It is while the
 * continuation (or a Start kept for the reset) is kept and no session of the project began since,
 * and once a continuation began after it (it went on by itself). After Cancel, Stop all, or a
 * session the person started instead, it is not: nothing went on by itself.
 */
export async function waitPromiseHolds(
  store: StateStore,
  projectId: string,
  since: string,
): Promise<boolean> {
  const later = (await store.session.forProject(projectId, { limit: 20 })).filter(
    (r) => r.created_at > since && !isIntakeSession(r),
  );
  if (later.some(startedByContinuation)) return true;
  if (later.length) return false;
  return !!(await keptContinuationOf(store, projectId)) || !!(await keptStartOf(store, projectId));
}

/**
 * A stored result as it reads now: unchanged unless it promises that the person's session goes
 * on and that no longer holds (`waitPromiseHolds`), then "...; then it runs at your next
 * Start." (`summaryAfterWait`). Every place that shows a session's stored result reads it so: the
 * session page, the Overview's Last result and its Read aloud, and the Inbox's Update line.
 */
export async function resultAfterWait(
  store: StateStore,
  projectId: string | null | undefined,
  since: string | null | undefined,
  text: string,
): Promise<string> {
  if (!projectId || !since || !text.includes(GOES_ON_CLAUSE)) return text;
  return (await waitPromiseHolds(store, projectId, since)) ? text : summaryAfterWait(text);
}

/** The words with the specialist in a person's words (`saidByName`: writer-marketing is "writer"). */
function said<T extends RunWords>(w: T): T {
  return { ...w, specialist: w.specialist ? (saidByName(w.specialist) ?? w.specialist) : null };
}

/** `run-words.ts`'s sentence with the registry's specialist key said as a person reads it. */
export function runText(
  w: RunWords & { projectName: string; nextProject?: string | null },
): string {
  return wordsText(said(w));
}

const fitted = (w: RunWords & { projectName: string; nextProject?: string | null }) =>
  runFit(said(w));

/**
 * The run indicator (d1109-run-visible, ADR 0118 point 12; D8, the owner, 2026-11-09: "it should
 * at least be very clear to a user when a run is ongoing. That should also be very visually clear
 * no matter where the person is."): one run state in the daemon's words, so the header's bar on
 * every page, Home's and the Overview's Working now, the Talk panel, the Sessions list's working
 * row, the desktop tray and the window title say the same sentence (design §5 rule 10: one place
 * per fact). `GET /running` answers `runViews`; `run.changed` carries it on `GET /events`; and
 * `/health.running` holds its first entry for a shell that reads only health.
 *
 * What it shows: every session that runs now (never the conversation's row, never a plan being
 * drafted), the critic's monthly check on known examples (a session on no project, as the critic
 * agent), a person start of another project that waits behind a running session (' · then Garden
 * site'), and a person's own session that ended to wait for its Claude credential and goes on by
 * itself (the kept continuation, d1109-starts-engine S-10): 'Quote page · waiting until 15:40,
 * then it goes on', with Cancel and no Stop. A Start the person kept for the reset and a held
 * hands-off start are said on their project's status line, not here (nothing runs for them yet).
 *
 * The words never carry an id or USD; task titles are data, quoted and shortened (design §5).
 * d1109-cred-screens (C6) adds the share and key-month forms of the waiting state in place of the
 * generic 'waiting for Claude, then it goes on'.
 */

// --- The views ------------------------------------------------------------------------------------

/** A person's session kept to go on after its credential wait (S-10), as the indicator reads it. */
export interface WaitingContinuation {
  projectId: string;
  /** The session it goes on with, when known. */
  sessionId: string | null;
  /** When it was kept (the wait's start). */
  since: string | null;
  wait: RunWait;
}

export interface RunIndicatorDeps {
  store: StateStore;
  /** The critic agent the monthly check runs as (its session has no project). */
  criticAgentId: string | null;
  /** The folds kept between reads, by session id (only the events after each are read). */
  folds: Map<string, RunFold>;
  /** The scheduler's waiting starts the person asked for, in order (the agent and project). */
  pendingPersonStarts(): { agentId: string; projectId: string | null | undefined }[];
  /** The person's sessions waiting to go on after a credential wait (kept continuations). */
  waitingContinuations(): Promise<WaitingContinuation[]>;
  /** The monthly check's budget in CHF and whether its calls run on the Claude plan. */
  calibration(sessionId: string): Promise<{ budgetChfMicro: number; onPlan: boolean }>;
}

const RUNNING = ["planned", "running", "paused"] as const;

/** Whether a session row is the critic's monthly check (the critic agent, no project). */
export function isCalibrationSession(
  row: Pick<SessionRow, "agent_id" | "project_id" | "plan">,
  criticAgentId: string | null,
): boolean {
  if (row.project_id) return false;
  if (criticAgentId && row.agent_id === criticAgentId) return true;
  const summary = (row.plan as { summary?: unknown } | null)?.summary;
  return typeof summary === "string" && summary.startsWith("critic calibration");
}

/** A session's fold over its whole log, reading only the events after the one kept (`folds`). */
async function foldOf(
  store: StateStore,
  folds: Map<string, RunFold>,
  sessionId: string,
): Promise<RunFold> {
  let fold = folds.get(sessionId) ?? emptyRunFold();
  for (;;) {
    const page = await store.event.list(sessionId, fold.afterSeq, 500);
    fold = foldRunEvents(fold, page);
    if (page.length < 500) break;
  }
  folds.set(sessionId, fold);
  return fold;
}

/** The folds kept for a store, so the bar and the Sessions list read each log once (in order). */
const storeFolds = new WeakMap<StateStore, Map<string, RunFold>>();
/** Kept folds at most: the oldest goes first (`runViews` drops the ended sessions' folds). */
const FOLDS_KEPT = 200;

/**
 * The run folds kept for this store: compose's run indicator (`RunIndicatorDeps.folds`) and the
 * Sessions list's working row (`sessionRunText`) share them, so both fold the same whole log
 * and say the same sentence however many steps a task has taken.
 */
export function runFoldsOf(store: StateStore): Map<string, RunFold> {
  let folds = storeFolds.get(store);
  if (!folds) {
    folds = new Map();
    storeFolds.set(store, folds);
  }
  return folds;
}

/**
 * The run indicator's entries now: the running sessions (the person's agent first, then the
 * critic's monthly check), each with what it does, then the person's sessions waiting to go on
 * whose project has no running session. Empty when nothing runs or waits.
 */
export async function runViews(deps: RunIndicatorDeps): Promise<RunningView[]> {
  const rows = (
    await deps.store.session.list({ status: [...RUNNING] } as never, {
      orderBy: [{ column: "created_at" }, { column: "id" }],
      limit: 50,
    })
  ).filter((r) => r.summary !== "conversation" && !isIntakeSession(r));
  const live = new Set(rows.map((r) => r.id));
  for (const id of [...deps.folds.keys()]) if (!live.has(id)) deps.folds.delete(id);
  const nameOf = async (projectId: string | null | undefined) =>
    projectId
      ? ((await deps.store.project.get(projectId).catch(() => undefined))?.name ?? null)
      : null;
  const pending = deps.pendingPersonStarts();
  const views: RunningView[] = [];
  const busy = new Set<string>();
  for (const row of rows) {
    if (isCalibrationSession(row, deps.criticAgentId)) {
      const c = await deps.calibration(row.id);
      const f = fitted({ projectName: CALIBRATION_NAME, state: "calibrating" });
      views.push({
        key: row.id,
        sessionId: row.id,
        projectId: null,
        projectName: CALIBRATION_NAME,
        state: "calibrating",
        what: f.what,
        text: f.text,
        since: row.started_at ?? row.created_at,
        stop: stopChoices("calibrating"),
        cancel: false,
        nextProject: null,
        explain: calibrationExplain(c),
      });
      continue;
    }
    const projectName = await nameOf(row.project_id);
    if (!row.project_id || !projectName) continue;
    busy.add(row.project_id);
    const fold = await foldOf(deps.store, deps.folds, row.id);
    const stopping = row.status === "paused";
    const state: RunState = stopping ? "stopping" : fold.phase;
    // A person start of another project waits behind this session: named once, the first.
    const behind = pending.find(
      (p) => p.agentId === row.agent_id && p.projectId && p.projectId !== row.project_id,
    );
    const then = behind ? await nameOf(behind.projectId) : null;
    const words: RunWords = {
      state,
      taskTitle: state === "between" || state === "planning" ? null : fold.taskTitle,
      specialist: fold.specialist,
    };
    const f = fitted({ ...words, projectName, nextProject: then });
    views.push({
      key: row.id,
      sessionId: row.id,
      projectId: row.project_id,
      projectName,
      state,
      what: f.what,
      text: f.text,
      since: row.started_at ?? row.created_at,
      stop: stopChoices(state),
      cancel: false,
      nextProject: then,
      explain: null,
    });
  }
  // The person's own sessions that wait to go on, when nothing of their project runs now.
  for (const w of await deps.waitingContinuations()) {
    if (busy.has(w.projectId)) continue;
    const projectName = await nameOf(w.projectId);
    if (!projectName) continue;
    busy.add(w.projectId);
    const f = fitted({ projectName, state: "waiting", wait: w.wait });
    views.push({
      key: `wait:${w.projectId}`,
      sessionId: w.sessionId,
      projectId: w.projectId,
      projectName,
      state: "waiting",
      what: f.what,
      text: f.text,
      since: w.since,
      stop: stopChoices("waiting"),
      cancel: true,
      nextProject: null,
      explain: null,
    });
  }
  return views;
}

/** `/health.running`: the indicator's first entry, a running session before a waiting one. */
export function runningHealth(views: readonly RunningView[]): RunningHealth | null {
  const first = views.find((v) => v.state !== "waiting") ?? views[0];
  if (!first) return null;
  return {
    projectName: first.projectName,
    what: first.what,
    text: first.text,
    waiting: first.state === "waiting",
  };
}

/**
 * One working session's words, as the indicator says them (the Sessions list's working row,
 * d1109-sessions' `workingWords`): '<project> · <what>'. It folds the session's whole log, as the
 * bar does, through the store's kept folds (`runFoldsOf`): a window of the newest events lost a
 * long task's task.started among its steps (one task.step per tool call) and said 'plans the
 * session' (the review of d1109-run-visible). The session's own row decides Stop after this task
 * (paused); the critic's monthly check reads its own words.
 */
export async function sessionRunText(
  store: StateStore,
  row: Pick<SessionRow, "id" | "agent_id" | "project_id" | "plan" | "status">,
  criticAgentId: string | null = null,
): Promise<string> {
  if (isCalibrationSession(row, criticAgentId))
    return runText({ projectName: CALIBRATION_NAME, state: "calibrating" });
  const projectName = row.project_id
    ? ((await store.project.get(row.project_id).catch(() => undefined))?.name ?? "")
    : "";
  const folds = runFoldsOf(store);
  const fold = await foldOf(store, folds, row.id);
  // The one read now goes last, so the oldest kept is the one dropped.
  folds.delete(row.id);
  folds.set(row.id, fold);
  for (const oldest of folds.keys()) {
    if (folds.size <= FOLDS_KEPT) break;
    folds.delete(oldest);
  }
  const state: RunState = row.status === "paused" ? "stopping" : fold.phase;
  return runText({
    projectName: projectName || "Your project",
    state,
    taskTitle: state === "between" || state === "planning" ? null : fold.taskTitle,
    specialist: fold.specialist,
  });
}
