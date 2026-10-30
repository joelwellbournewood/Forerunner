import { type Clock, ForerunnerError } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { TaskRow, TaskStatus } from "../types.ts";
import { assertTransition, TASK_TRANSITIONS } from "../workflow.ts";
import { type Actor, type ListOptions, Repository } from "./base.ts";
import type { FindingRepo } from "./review.ts";

export type ClaimResult =
  | { ok: true; task: TaskRow }
  | { ok: false; reason: "held_by"; holder: string; expires: string | null }
  | { ok: false; reason: "not_claimable"; status: TaskStatus }
  | { ok: false; reason: "version_conflict"; version: number };

/** States in which a claim may be held. */
const CLAIMABLE: readonly TaskStatus[] = ["ready", "claimed", "in_progress"];
/** Statuses that keep the claim when transitioned to. */
const KEEPS_CLAIM: readonly TaskStatus[] = ["claimed", "in_progress", "in_review"];
/**
 * Statuses only an agent's claim puts a task in. A person moving a task there left it with no
 * holder and no expiry: no session would pick it up and nothing returned it to ready.
 */
export const AGENT_ONLY_STATUSES: readonly TaskStatus[] = ["claimed", "in_progress"];

/**
 * Tasks: the workflow graph, atomic claims with expiry, dependency-aware readiness and
 * the "no close with open findings" rule.
 */
export class TaskRepo extends Repository<TaskRow> {
  constructor(
    db: Database,
    clock: Clock,
    private readonly findings: FindingRepo,
  ) {
    super(db, ENTITIES.task as EntityDef, clock);
  }

  /**
   * Claim in ONE atomic update: succeeds when the task is unclaimed, held by the same
   * agent, or the previous claim has expired, and the task is ready / claimed / in_progress.
   * A ready task becomes claimed; an in_progress task keeps its status (re-claim by holder).
   */
  async claim(
    taskId: string,
    agentId: string,
    ttlMs: number,
    now: number = this.clock.now(),
    opts: { expectedVersion?: number; reason?: string } = {},
  ): Promise<ClaimResult> {
    const nowIso = new Date(now).toISOString();
    const expires = new Date(now + Math.max(0, ttlMs)).toISOString();
    const versionSql = opts.expectedVersion === undefined ? "" : ' AND "version" = ?';
    const versionParams = opts.expectedVersion === undefined ? [] : [opts.expectedVersion];
    const rows = await this.rows(
      `UPDATE ${this.qt}
         SET "claimed_by" = ?, "claim_expires" = ?,
             "status" = CASE WHEN "status" = 'ready' THEN 'claimed' ELSE "status" END,
             "updated_at" = ?, "version" = "version" + 1, "author_agent" = ?, "reason" = ?
       WHERE "id" = ?
         AND ("claimed_by" IS NULL OR "claimed_by" = ? OR "claim_expires" IS NULL OR "claim_expires" < ?)
         AND "status" IN ('ready', 'claimed', 'in_progress')${versionSql}
       RETURNING *`,
      [
        agentId,
        expires,
        this.clock.nowIso(),
        agentId,
        opts.reason ?? "claimed",
        taskId,
        agentId,
        nowIso,
        ...versionParams,
      ],
    );
    const task = rows[0];
    if (task) return { ok: true, task };
    const current = await this.mustGet(taskId);
    if (opts.expectedVersion !== undefined && current.version !== opts.expectedVersion) {
      return { ok: false, reason: "version_conflict", version: current.version };
    }
    if (!CLAIMABLE.includes(current.status))
      return { ok: false, reason: "not_claimable", status: current.status };
    return {
      ok: false,
      reason: "held_by",
      holder: current.claimed_by ?? "",
      expires: current.claim_expires,
    };
  }

  /** Extend the holder's claim. Throws claim_conflict when `agentId` is not the holder. */
  async renewClaim(
    taskId: string,
    agentId: string,
    ttlMs: number,
    now: number = this.clock.now(),
  ): Promise<TaskRow> {
    const expires = new Date(now + Math.max(0, ttlMs)).toISOString();
    const [row] = await this.updateWhere(
      { claim_expires: expires },
      `"id" = ? AND "claimed_by" = ? AND "status" IN ('claimed', 'in_progress')`,
      [taskId, agentId],
    );
    if (row) return row;
    const current = await this.mustGet(taskId);
    throw new ForerunnerError("claim_conflict", `task ${taskId} is not held by ${agentId}`, {
      details: { taskId, holder: current.claimed_by, status: current.status },
    });
  }

  /** Give the claim back; a claimed or in_progress task returns to ready. */
  async releaseClaim(taskId: string, agentId: string, reason = "claim released"): Promise<TaskRow> {
    const rows = await this.rows(
      `UPDATE ${this.qt}
         SET "claimed_by" = NULL, "claim_expires" = NULL,
             "status" = CASE WHEN "status" IN ('claimed', 'in_progress') THEN 'ready' ELSE "status" END,
             "updated_at" = ?, "version" = "version" + 1, "author_agent" = ?, "reason" = ?
       WHERE "id" = ? AND "claimed_by" = ?
       RETURNING *`,
      [this.clock.nowIso(), agentId, reason, taskId, agentId],
    );
    const row = rows[0];
    if (row) return row;
    const current = await this.mustGet(taskId);
    throw new ForerunnerError("claim_conflict", `task ${taskId} is not held by ${agentId}`, {
      details: { taskId, holder: current.claimed_by, status: current.status },
    });
  }

  /**
   * Expire lapsed claims: claimed / in_progress tasks whose claim_expires is in the past go back
   * to ready. A `claimed` task nobody holds (a person clicked Claim, U-013) goes back too.
   */
  async expireClaims(now: number = this.clock.now()): Promise<TaskRow[]> {
    const lapsed = await this.rows(
      `UPDATE ${this.qt}
         SET "claimed_by" = NULL, "claim_expires" = NULL, "status" = 'ready',
             "updated_at" = ?, "version" = "version" + 1, "reason" = 'claim expired'
       WHERE "claimed_by" IS NOT NULL AND "claim_expires" < ? AND "status" IN ('claimed', 'in_progress')
       RETURNING *`,
      [this.clock.nowIso(), new Date(now).toISOString()],
    );
    const unheld = await this.rows(
      `UPDATE ${this.qt}
         SET "claim_expires" = NULL, "status" = 'ready',
             "updated_at" = ?, "version" = "version" + 1,
             "reason" = 'claimed by no agent: back to ready'
       WHERE "claimed_by" IS NULL AND "status" = 'claimed'
       RETURNING *`,
      [this.clock.nowIso()],
    );
    return [...lapsed, ...unheld];
  }

  /**
   * Move along the workflow graph with optimistic concurrency. Closing to done is refused
   * with ForerunnerError("findings_open") while open findings exist. Leaving an active state
   * clears the claim; failed -> ready counts an attempt.
   */
  async transition(
    id: string,
    expectedVersion: number,
    to: TaskStatus,
    reason: string,
    actor: Actor = {},
  ): Promise<TaskRow> {
    const current = await this.mustGet(id);
    assertTransition(TASK_TRANSITIONS, "task", current.status, to);
    if (actor.humanId && !actor.agentId && AGENT_ONLY_STATUSES.includes(to)) {
      throw new ForerunnerError(
        "validation",
        `only an agent's session moves a task to ${to}; mark it ready and start a session`,
        { details: { taskId: id, status: current.status, to, reason: "agent_only_status" } },
      );
    }
    if (to === "done") {
      const open = await this.findings.openFor(id);
      if (open.length > 0) {
        throw new ForerunnerError(
          "findings_open",
          `task ${id} has ${open.length} open finding(s)`,
          {
            details: { taskId: id, findings: open.map((f) => f.id) },
          },
        );
      }
    }
    const patch: Partial<TaskRow> = {
      status: to,
      reason,
      author_agent: actor.agentId ?? null,
      author_human: actor.humanId ?? null,
    };
    if (!KEEPS_CLAIM.includes(to)) {
      patch.claimed_by = null;
      patch.claim_expires = null;
    }
    if (current.status === "failed" && to === "ready") patch.attempt = current.attempt + 1;
    return this.update(id, expectedVersion, patch);
  }

  /** Ready tasks of a project whose dependencies are all done, highest priority first. */
  async readyTasks(projectId: string, opts: ListOptions = {}): Promise<TaskRow[]> {
    const ready = await this.list(
      { project_id: projectId, status: "ready" },
      {
        orderBy: [
          { column: "priority", direction: "desc" },
          { column: "created_at" },
          { column: "id" },
        ],
      },
    );
    const depIds = [...new Set(ready.flatMap((t) => t.depends_on))];
    const statusById = new Map<string, TaskStatus>();
    for (let i = 0; i < depIds.length; i += 500) {
      const chunk = depIds.slice(i, i + 500);
      const rows = await this.db.query<{ id: string; status: TaskStatus }>(
        `SELECT "id", "status" FROM ${this.qt} WHERE "id" IN (${chunk.map(() => "?").join(", ")})`,
        chunk,
      );
      for (const r of rows) statusById.set(r.id, r.status);
    }
    const runnable = ready.filter((t) => t.depends_on.every((d) => statusById.get(d) === "done"));
    const offset = opts.offset ?? 0;
    return opts.limit === undefined
      ? runnable.slice(offset)
      : runnable.slice(offset, offset + opts.limit);
  }

  /** Tasks currently claimed by an agent (the peer-awareness feed). */
  async claimedBy(agentId: string): Promise<TaskRow[]> {
    return this.list({ claimed_by: agentId }, { orderBy: "claim_expires" });
  }

  async forProject(
    projectId: string,
    filter: { status?: TaskStatus | TaskStatus[] } = {},
    opts: ListOptions = {},
  ): Promise<TaskRow[]> {
    return this.list(
      { project_id: projectId, ...(filter.status ? { status: filter.status } : {}) },
      opts,
    );
  }
}
