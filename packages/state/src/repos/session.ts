import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { JsonValue, RunRow, SessionRow, SessionStatus } from "../types.ts";
import { assertTransition, SESSION_TRANSITIONS } from "../workflow.ts";
import {
  type Actor,
  authorColumns,
  type ListOptions,
  Repository,
  requireChangeReason,
} from "./base.ts";

const TERMINAL: readonly SessionStatus[] = ["stopped", "completed", "failed", "killed"];

/**
 * Sessions. A change to the plan is versioned with its author and reason (spec B.5):
 * `setPlan` is the write path, and `updateWhere` refuses a patch that carries `plan` without
 * a reason and an author, so `update` and `patch` cannot bypass it. Spend, status, summary
 * and handoff writes are not plan changes and carry none.
 */
export class SessionRepo extends Repository<SessionRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.session as EntityDef, clock);
  }

  /**
   * Replace the plan with optimistic concurrency, recording why and by whom. A blank reason
   * or an actor naming neither agent nor human is ForerunnerError("validation"); a stale
   * `expectedVersion` is "version_conflict".
   */
  async setPlan(
    id: string,
    expectedVersion: number,
    plan: JsonValue,
    reason: string,
    actor: Actor,
  ): Promise<SessionRow> {
    return this.update(id, expectedVersion, {
      plan,
      reason: reason.trim(),
      ...authorColumns(actor),
    });
  }

  override async updateWhere(
    patch: Partial<SessionRow>,
    whereSql: string,
    whereParams: unknown[],
    extra: { set: string[]; params: unknown[] } = { set: [], params: [] },
  ): Promise<SessionRow[]> {
    if (patch.plan !== undefined) requireChangeReason(this.table, patch);
    return super.updateWhere(patch, whereSql, whereParams, extra);
  }

  /** planned -> running with started_at. */
  async start(
    id: string,
    expectedVersion: number,
    now: string = this.clock.nowIso(),
  ): Promise<SessionRow> {
    const current = await this.mustGet(id);
    assertTransition(SESSION_TRANSITIONS, "session", current.status, "running");
    return this.update(id, expectedVersion, {
      status: "running",
      started_at: current.started_at ?? now,
    });
  }

  /** Any legal status move; terminal statuses set ended_at and may carry summary and handoff. */
  async setStatus(
    id: string,
    expectedVersion: number,
    to: SessionStatus,
    extra: { summary?: string; handoff?: JsonValue; now?: string } = {},
  ): Promise<SessionRow> {
    const current = await this.mustGet(id);
    assertTransition(SESSION_TRANSITIONS, "session", current.status, to);
    const patch: Partial<SessionRow> = { status: to };
    if (TERMINAL.includes(to)) patch.ended_at = extra.now ?? this.clock.nowIso();
    if (to === "running" && !current.started_at)
      patch.started_at = extra.now ?? this.clock.nowIso();
    if (extra.summary !== undefined) patch.summary = extra.summary;
    if (extra.handoff !== undefined) patch.handoff = extra.handoff;
    return this.update(id, expectedVersion, patch);
  }

  /** Atomic increment of spend and steps (the ledger stays the truth; this is the fast counter). */
  async recordSpend(id: string, usdMicro: number, steps = 1): Promise<SessionRow> {
    const [row] = await this.updateWhere({}, '"id" = ?', [id], {
      set: ['"spent_usd_micro" = "spent_usd_micro" + ?', '"steps" = "steps" + ?'],
      params: [Math.round(usdMicro), Math.round(steps)],
    });
    if (!row) return this.mustGet(id);
    return row;
  }

  /** Running or paused sessions of an agent. */
  active(agentId: string): Promise<SessionRow[]> {
    return this.list({ agent_id: agentId, status: ["running", "paused"] });
  }

  forProject(projectId: string, opts: ListOptions = {}): Promise<SessionRow[]> {
    return this.list({ project_id: projectId }, { orderBy: "created_at desc", ...opts });
  }

  async latestForAgent(agentId: string): Promise<SessionRow | undefined> {
    const [row] = await this.list({ agent_id: agentId }, { orderBy: "created_at desc", limit: 1 });
    return row;
  }
}

export class RunRepo extends Repository<RunRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.run as EntityDef, clock);
  }

  forSession(sessionId: string, opts: ListOptions = {}): Promise<RunRow[]> {
    return this.list({ session_id: sessionId }, opts);
  }

  forTask(taskId: string, opts: ListOptions = {}): Promise<RunRow[]> {
    return this.list({ task_id: taskId }, opts);
  }

  /** Record the result of a run (tokens, cost, timing, outcome). */
  finish(id: string, expectedVersion: number, patch: Partial<RunRow>): Promise<RunRow> {
    return this.update(id, expectedVersion, patch);
  }

  children(parentRunId: string): Promise<RunRow[]> {
    return this.list({ parent_run_id: parentRunId });
  }
}
