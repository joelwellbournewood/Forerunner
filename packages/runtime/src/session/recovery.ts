import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { SessionRow, StateStore, TaskRow } from "@forerunner/state";

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
 * closed, the tasks its agent still holds go back to ready with the reason
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
  const tasks: TaskRow[] = [];
  for (const t of held) {
    try {
      tasks.push(await store.task.releaseClaim(t.id, row.agent_id, opts.taskReason));
    } catch (e) {
      logger.warn("interrupted task not released", { taskId: t.id, error: errorMessage(e) });
    }
  }
  const titles = tasks.map((t) => t.title);
  const summary = (opts.summary ?? interruptedSummary)(titles);
  const handoff = {
    ...((fresh.handoff as Record<string, unknown> | null) ?? {}),
    stop_reason: opts.stopReason,
    released: tasks.map((t) => t.id),
  };
  // `paused` and `planned` may move to `stopped` directly; so may `running`.
  const ended = await store.session.setStatus(fresh.id, fresh.version, "stopped", {
    summary,
    handoff: handoff as never,
    now: clock.nowIso(),
  });
  await store.event.append(fresh.id, "session.ended", {
    status: "stopped",
    stopReason: opts.stopReason,
    released: tasks.map((t) => ({ taskId: t.id, title: t.title })),
  } as never);
  return { session: ended, tasks };
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
