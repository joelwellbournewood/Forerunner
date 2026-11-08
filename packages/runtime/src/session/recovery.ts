import { DEFAULT_CHF_PER_USD, usdToChfMicro } from "@forerunner/billing";
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { SessionRow, StateStore, TaskRow } from "@forerunner/state";
import { holdsTask } from "../daemon/task-words.ts";
import type { LastSessionOutcome } from "./result.ts";

/**
 * Crash recovery (core-experience design §4.10, ADR 0102). A daemon that died while a session
 * ran (a crash, a forced close, a power cut) left the session row `running` (or `paused`), its
 * run rows `running` and its tasks `claimed` or `in_progress` with a claim nobody renews. The
 * runner refuses every later start of the agent while such a row exists (one active session per
 * agent), so before this one crash locked the agent for good: "agent Alice already has an
 * active session <uuid>", and Stop, Stop all and a restart changed nothing.
 *
 * At daemon start nothing of this install runs yet, so every such row is a ghost: it is ended
 * `stopped` with the stop reason `interrupted` and a one-line result, its running run rows are
 * closed, the tasks its agent still holds and the tasks its runs left in review (claimed or
 * not: Quit releases every claim, L-1) go back to ready with the reason
 * `INTERRUPTED_TASK_REASON`, and the person gets one Update naming what is ready again. An
 * intake session (the plan's `intake`) is the intake's own (`IntakeService.closeExpired`), a
 * cloud runner's session runs elsewhere, and a row another device ran is that device's.
 */

/** The stop reason an interrupted session carries (handoff `stop_reason`, `session.ended`). */
export const INTERRUPTED_STOP_REASON = "interrupted";

/** What a task a dead session held reads after the recovery (the task's reason). */
export const INTERRUPTED_TASK_REASON = "Forerunner closed while it ran";

/** The session's one-line result after the recovery. */
export function interruptedSummary(titles: readonly string[]): string {
  if (titles.length === 0) return "Interrupted: Forerunner closed while this session ran.";
  return `Interrupted: Forerunner closed while this session ran. ${namesOf(titles)} ${
    titles.length === 1 ? "is" : "are"
  } ready again.`;
}

/** "X", "X" and "Y", "X", "Y" and 2 more (writing rules §5.5). */
export function namesOf(titles: readonly string[], max = 3): string {
  const quoted = titles.map((t) => `"${t}"`);
  if (quoted.length <= 1) return quoted.join("");
  if (quoted.length <= max)
    return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return `${quoted.slice(0, max).join(", ")} and ${quoted.length - max} more`;
}

export interface RecoveryDeps {
  store: StateStore;
  clock: Clock;
  /** The agents of this install whose sessions may be ghosts (the human's own). */
  agentIds: readonly string[];
  /** Who hears about it (the Update). */
  humanId: string;
  /** The principal: the Update's sender. */
  principalId: string;
  /** Whether a session still runs in this process; at daemon start nothing does. */
  isLive?: (sessionId: string) => boolean;
  /** This daemon's device row, when it has one: a row another device ran is left alone. */
  deviceId?: string | null;
}

export interface RecoveredSession {
  session: SessionRow;
  tasks: TaskRow[];
}

/** Whether a session row is the intake's planning call (ADR 0055), which has its own close. */
export function isIntakeSession(s: Pick<SessionRow, "plan">): boolean {
  const plan = s.plan as { intake?: unknown } | null;
  return !!plan && typeof plan === "object" && !Array.isArray(plan) && !!plan.intake;
}

/**
 * End one session row nothing runs any more: status `stopped`, the stop reason, the result
 * line and `ended_at`; its running run rows closed; the tasks it held back to ready. Returns
 * the tasks put back. Safe to call on a row that ended meanwhile (it is left as it is).
 */
export async function endDeadSession(
  deps: Pick<RecoveryDeps, "store" | "clock">,
  row: SessionRow,
  opts: { stopReason: string; taskReason: string; summary?: (titles: string[]) => string },
): Promise<{ session: SessionRow; tasks: TaskRow[] } | null> {
  const { store, clock } = deps;
  const logger = log("session-recovery");
  const fresh = await store.session.get(row.id);
  if (!fresh || !["running", "paused", "planned"].includes(fresh.status)) return null;
  // Runs of the session that never ended: closed, so run history and the cost view see an end.
  for (const r of await store.run.forSession(row.id)) {
    if (r.outcome !== "running") continue;
    try {
      await store.run.patch(r.id, { outcome: "killed" });
    } catch (e) {
      logger.warn("interrupted run not closed", { runId: r.id, error: errorMessage(e) });
    }
  }
  // The tasks this session held: those its runs worked on, and those its agent still claims
  // in the session's project (a claim the dead process can never renew or release).
  const runTaskIds = new Set(
    (await store.run.forSession(row.id)).map((r) => r.task_id).filter((id): id is string => !!id),
  );
  const held = (await store.task.claimedBy(row.agent_id)).filter(
    (t) => runTaskIds.has(t.id) || !row.project_id || t.project_id === row.project_id,
  );
  // And a task its runs worked on that was being reviewed, claimed or not (L-1, live check of
  // phase C): Quit stops every run and releases every claim (`POST /shutdown`), and releasing
  // the claim of a task in review leaves it in review. When the process ended before the
  // session put it back, the claim alone missed it, and it read "Being reviewed" for good: no
  // review runs once the session that ran it is gone, and no session plans a task in review.
  const reviewing: TaskRow[] = [];
  for (const id of runTaskIds) {
    if (held.some((t) => t.id === id)) continue;
    const t = await store.task.get(id);
    if (t?.status === "in_review" && (t.claimed_by ?? row.agent_id) === row.agent_id)
      reviewing.push(t);
  }
  const tasks: TaskRow[] = [];
  for (const t of [...held, ...reviewing]) {
    try {
      const released = t.claimed_by
        ? await store.task.releaseClaim(t.id, row.agent_id, opts.taskReason)
        : t;
      const back = await reviewBackToReady(store, released, row.agent_id, opts.taskReason);
      if (back) tasks.push(back);
    } catch (e) {
      logger.warn("interrupted task not released", { taskId: t.id, error: errorMessage(e) });
    }
  }
  const titles = tasks.map((t) => t.title);
  const summary = (opts.summary ?? interruptedSummary)(titles);
  // What the session did before it died (the leftovers of wave 7): the tasks its runs worked on
  // that are done now, and what it spent (the cost ledger's rows for it, else the row's own
  // count). Before, its end said "nothing done. CHF 0.00." whatever it had finished.
  const done: TaskRow[] = [];
  for (const id of runTaskIds) {
    const t = await store.task.get(id).catch(() => undefined);
    if (t?.status === "done") done.push(t);
  }
  const booked = await store.costLedger.sum({ sessionId: fresh.id }).catch(() => null);
  const spentUsdMicro = booked && booked.entries > 0 ? booked.usd_micro : fresh.spent_usd_micro;
  const spentChfMicro =
    booked && booked.entries > 0
      ? booked.chf_micro
      : usdToChfMicro(Math.max(0, Math.round(spentUsdMicro)), DEFAULT_CHF_PER_USD);
  const handoff = {
    ...((fresh.handoff as Record<string, unknown> | null) ?? {}),
    stop_reason: opts.stopReason,
    released: tasks.map((t) => t.id),
  };
  // The row's spend is the ledger's too, as the runner's own end writes it: the live counter
  // misses what only the ledger books (the critic's review), and the session page's "Spent of
  // this session's budget" and the session lists read the row (the fix-up of R-recovery: the
  // page read CHF 0.00 above an end line of CHF 0.01).
  const settled =
    booked && booked.entries > 0 && booked.usd_micro !== fresh.spent_usd_micro
      ? await store.session.update(fresh.id, fresh.version, { spent_usd_micro: booked.usd_micro })
      : fresh;
  // `paused` and `planned` may move to `stopped` directly; so may `running`.
  const ended = await store.session.setStatus(settled.id, settled.version, "stopped", {
    summary,
    handoff: handoff as never,
    now: clock.nowIso(),
  });
  await store.event.append(fresh.id, "session.ended", {
    status: "stopped",
    stopReason: opts.stopReason,
    released: tasks.map((t) => ({ taskId: t.id, title: t.title })),
    // The end line's counts and money, as a session that ended by itself says them.
    completed: done.length,
    spentUsdMicro,
  } as never);
  await recordLastSession(deps, ended, {
    summary,
    stopReason: opts.stopReason,
    done,
    released: tasks,
    spentChfMicro,
  }).catch((e: unknown) =>
    logger.warn("the interrupted session was not recorded as the project's last", {
      sessionId: fresh.id,
      error: errorMessage(e),
    }),
  );
  return { session: ended, tasks };
}

/**
 * The project's last session (`summary_cache.last_session`, the Overview's "Last session") is
 * the one that ended here, unless a later one of the project already ended (the leftovers of
 * wave 7: only the live runner wrote it, so after a crash the Overview read "No session yet"
 * though the session had done work). Its outcome holds what it did and what it left ready.
 */
async function recordLastSession(
  deps: Pick<RecoveryDeps, "store" | "clock">,
  session: SessionRow,
  facts: {
    summary: string;
    stopReason: string;
    done: readonly TaskRow[];
    released: readonly TaskRow[];
    spentChfMicro: number;
  },
): Promise<void> {
  const { store, clock } = deps;
  if (!session.project_id) return;
  const project = await store.project.get(session.project_id);
  if (!project) return;
  const cache = (project.summary_cache ?? {}) as Record<string, unknown>;
  const last = cache.last_session as { ended_at?: unknown } | undefined;
  const lastEnded = typeof last?.ended_at === "string" ? last.ended_at : null;
  // A session of the project that ended after this one started is newer news.
  if (lastEnded && session.started_at && lastEnded > session.started_at) return;
  const named = (t: TaskRow) => ({ id: t.id, title: t.title });
  const outcome: LastSessionOutcome = {
    done: facts.done.map(named),
    failed: [],
    needsYou: [],
    leftOver: facts.released.map(named),
    waiting: [],
    waitingForDocker: [],
    stopReason: facts.stopReason,
    spentChfMicro: facts.spentChfMicro,
  };
  await store.project.patch(project.id, {
    summary_cache: {
      ...cache,
      last_session: {
        id: session.id,
        ended_at: session.ended_at ?? clock.nowIso(),
        summary: facts.summary,
        stop_reason: facts.stopReason,
        outcome,
      },
    } as never,
  });
}

/**
 * A released task that was being reviewed when its session ended without a verdict (phase C
 * review): releasing a claim puts back only a claimed or running task, so it stayed "Being
 * reviewed" for good, while the session's result said it was ready again, and no session plans
 * a task in review. It goes back to ready, as a stopped review does in a live session (design
 * §4.9, §4.10), unless a card waits on the person for it (its review failed, or a finding is
 * still open): then it stays, and null says it is not ready again. Any other task is returned
 * as it is.
 */
async function reviewBackToReady(
  store: StateStore,
  t: TaskRow,
  agentId: string,
  reason: string,
): Promise<TaskRow | null> {
  if (t.status !== "in_review") return t;
  const open = await store.humanRequest.list({ task_id: t.id, status: "open" } as never, {
    limit: 20,
  });
  if (open.some(holdsTask)) return null;
  return store.task.restoreStatus(t.id, t.version, "in_review", reason, { agentId });
}

/**
 * The startup recovery: every running or paused work session of this install's agents that
 * nothing runs is ended as interrupted (see the module comment). One Update per recovery, not
 * per session. Returns what was ended.
 */
export async function recoverInterruptedSessions(deps: RecoveryDeps): Promise<RecoveredSession[]> {
  const { store } = deps;
  const logger = log("session-recovery");
  const out: RecoveredSession[] = [];
  for (const agentId of deps.agentIds) {
    for (const s of await store.session.active(agentId)) {
      if (deps.isLive?.(s.id)) continue;
      if (isIntakeSession(s) || s.runner !== "pc") continue;
      if (s.device_id && deps.deviceId && s.device_id !== deps.deviceId) continue;
      try {
        const ended = await endDeadSession(deps, s, {
          stopReason: INTERRUPTED_STOP_REASON,
          taskReason: INTERRUPTED_TASK_REASON,
        });
        if (ended) out.push(ended);
      } catch (e) {
        logger.warn("interrupted session not ended", { sessionId: s.id, error: errorMessage(e) });
      }
    }
  }
  // The person hears about their own work only: a background job's row on no project (the
  // critic's monthly calibration) is ended so it holds nothing, without an Update that would
  // read "Your last session was interrupted" for a session the person never started.
  const theirs = out.filter((r) => r.session.project_id !== null);
  if (theirs.length) {
    const titles = theirs.flatMap((r) => r.tasks.map((t) => t.title));
    const projectIds = [...new Set(theirs.map((r) => r.session.project_id))];
    const body =
      titles.length > 0
        ? `Your last session was interrupted when Forerunner closed. ${namesOf(titles)} ${
            titles.length === 1 ? "is" : "are"
          } ready again.`
        : "Your last session was interrupted when Forerunner closed. Nothing was left half done.";
    await store.message.send({
      from_agent_id: deps.principalId,
      to_human_id: deps.humanId,
      project_id: projectIds.length === 1 ? (projectIds[0] ?? null) : null,
      type: "info",
      body,
      requires_ack: false,
      author_agent: deps.principalId,
    });
  }
  if (out.length)
    logger.warn("interrupted sessions ended at start", {
      sessions: out.map((r) => r.session.id),
      tasks: out.flatMap((r) => r.tasks.map((t) => t.id)),
    });
  return out;
}
