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
/** Statuses a reopened task goes back to as they were; from any other it goes to `ready`. */
export const REOPEN_STATUSES: readonly TaskStatus[] = ["draft", "ready", "needs_human", "failed"];

/**
 * Where a cancelled task reopens to (U-061): the status it had before the cancel when a person
 * can set it, else `ready`, so a session plans it again (an agent's `claimed`, `in_progress`
 * or `in_review` needs a session's claim).
 */
export function reopenTarget(previous: TaskStatus): TaskStatus {
  return REOPEN_STATUSES.includes(previous) ? previous : "ready";
}

/** A dependency a ready task still waits on: the task it names, or null when no such task exists. */
export interface WaitsOn {
  id: string;
  title: string | null;
  status: TaskStatus | null;
}

/** A ready task that cannot run yet, and what it waits on (U-040). */
export interface WaitingTask {
  task: TaskRow;
  waitsOn: WaitsOn[];
}

/**
 * Dependency states a task never leaves by itself: a task that waits on one is stuck until a
 * person changes its dependencies or moves the other task (U-040). A missing task (deleted, a
 * typo kept from before the check) is stuck too.
 */
export const STUCK_DEPENDENCY_STATUSES: readonly TaskStatus[] = ["cancelled", "failed"];

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

  /**
   * Reopen a cancelled task (U-061): the undo of a cancel, the one way out of `cancelled`,
   * which the workflow graph keeps terminal for every other move. The task goes to
   * `reopenTarget(previous)` without a claim; any other status is refused.
   */
  async reopen(
    id: string,
    expectedVersion: number,
    previous: TaskStatus,
    reason: string,
    actor: Actor = {},
  ): Promise<TaskRow> {
    const current = await this.mustGet(id);
    if (current.status !== "cancelled") {
      throw new ForerunnerError(
        "validation",
        `only a cancelled task can be reopened; this one is ${current.status}`,
        { details: { taskId: id, status: current.status } },
      );
    }
    return this.update(id, expectedVersion, {
      status: reopenTarget(previous),
      reason,
      claimed_by: null,
      claim_expires: null,
      author_agent: actor.agentId ?? null,
      author_human: actor.humanId ?? null,
    });
  }

  /** Ready tasks of a project whose dependencies are all done, highest priority first. */
  async readyTasks(projectId: string, opts: ListOptions = {}): Promise<TaskRow[]> {
    const { ready, depById } = await this.readyWithDependencies(projectId);
    const runnable = ready.filter((t) =>
      t.depends_on.every((d) => depById.get(d)?.status === "done"),
    );
    const offset = opts.offset ?? 0;
    return opts.limit === undefined
      ? runnable.slice(offset)
      : runnable.slice(offset, offset + opts.limit);
  }

  /**
   * Ready tasks of a project that cannot run yet because a dependency is not done (U-040),
   * highest priority first, each with the dependencies it still waits on (title and status,
   * null for a task that does not exist). The Start dialog and the session summary name them,
   * so a task waiting on a cancelled or failed task is never stuck silently.
   */
  async waitingTasks(projectId: string): Promise<WaitingTask[]> {
    const { ready, depById } = await this.readyWithDependencies(projectId);
    const out: WaitingTask[] = [];
    for (const task of ready) {
      const waitsOn = task.depends_on
        .filter((d) => depById.get(d)?.status !== "done")
        .map((d) => {
          const dep = depById.get(d);
          return { id: d, title: dep?.title ?? null, status: dep?.status ?? null };
        });
      if (waitsOn.length) out.push({ task, waitsOn });
    }
    return out;
  }

  /** The project's ready tasks in plan order and the rows their dependencies name. */
  private async readyWithDependencies(projectId: string): Promise<{
    ready: TaskRow[];
    depById: Map<string, { status: TaskStatus; title: string }>;
  }> {
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
    const depById = new Map<string, { status: TaskStatus; title: string }>();
    for (let i = 0; i < depIds.length; i += 500) {
      const chunk = depIds.slice(i, i + 500);
      const rows = await this.db.query<{ id: string; status: TaskStatus; title: string }>(
        `SELECT "id", "status", "title" FROM ${this.qt} WHERE "id" IN (${chunk.map(() => "?").join(", ")})`,
        chunk,
      );
      for (const r of rows) depById.set(r.id, { status: r.status, title: r.title });
    }
    return { ready, depById };
  }

  /**
   * Check the dependencies a person gives a task (U-040) and return them without duplicates.
   * Each must be a task of the same project, not the task itself, not cancelled (a task that
   * waits on a cancelled one never runs), and the new edges must not close a cycle (the tasks
   * on it would wait on each other for good). Refused with `validation`, a message that names
   * each problem by the task's title where there is one, and `details.reason`:
   * `unknown_dependency`, `self_dependency`, `cancelled_dependency` or `dependency_cycle`.
   * `taskId` is null for a task about to be created (it cannot be part of a cycle yet).
   */
  async checkDependencies(
    projectId: string,
    taskId: string | null,
    dependsOn: readonly string[],
  ): Promise<string[]> {
    const ids = [...new Set(dependsOn.map((d) => d.trim()).filter((d) => d.length > 0))];
    if (taskId !== null && ids.includes(taskId)) {
      throw new ForerunnerError("validation", "A task cannot depend on itself.", {
        details: { reason: "self_dependency", taskId },
      });
    }
    const rows = new Map<string, TaskRow>();
    for (const id of ids) {
      const row = await this.get(id);
      if (row && row.project_id === projectId) rows.set(id, row);
    }
    const unknown = ids.filter((id) => !rows.has(id));
    if (unknown.length) {
      throw new ForerunnerError(
        "validation",
        `Depends on: ${unknown.map((u) => `"${u}"`).join(", ")} ${
          unknown.length === 1 ? "is not a task" : "are not tasks"
        } of this project. Pick the tasks it waits on from the project's list.`,
        { details: { reason: "unknown_dependency", unknown } },
      );
    }
    const cancelled = ids.filter((id) => rows.get(id)?.status === "cancelled");
    if (cancelled.length) {
      throw new ForerunnerError(
        "validation",
        `Depends on: ${cancelled.map((c) => `"${rows.get(c)?.title}"`).join(", ")} ${
          cancelled.length === 1 ? "is" : "are"
        } cancelled and will never be done, so a task waiting on ${
          cancelled.length === 1 ? "it" : "them"
        } would never run.`,
        { details: { reason: "cancelled_dependency", cancelled } },
      );
    }
    if (taskId !== null) {
      // A new edge task -> dep closes a cycle when the dependency already waits on the task,
      // directly or through others. Walk the project's graph from each new dependency.
      const all = await this.list({ project_id: projectId }, { limit: 10_000 });
      const depsOf = new Map(all.map((t) => [t.id, t.depends_on]));
      for (const start of ids) {
        const seen = new Set<string>();
        const stack = [start];
        while (stack.length) {
          const at = stack.pop() as string;
          if (at === taskId) {
            const self = all.find((t) => t.id === taskId);
            throw new ForerunnerError(
              "validation",
              `Depends on: "${rows.get(start)?.title}" already waits on "${self?.title ?? taskId}" (directly or through other tasks), so "${self?.title ?? taskId}" cannot wait on it: neither would ever run.`,
              { details: { reason: "dependency_cycle", taskId, dependency: start } },
            );
          }
          if (seen.has(at)) continue;
          seen.add(at);
          stack.push(...(depsOf.get(at) ?? []));
        }
      }
    }
    return ids;
  }

  /**
   * Change the tasks a task waits on (U-040), checked as `checkDependencies` does, with the
   * version check and the person's reason on the row (spec B.5).
   */
  async setDependencies(
    id: string,
    expectedVersion: number,
    dependsOn: readonly string[],
    reason: string,
    actor: Actor = {},
  ): Promise<TaskRow> {
    const current = await this.mustGet(id);
    const ids = await this.checkDependencies(current.project_id, current.id, dependsOn);
    return this.update(id, expectedVersion, {
      depends_on: ids,
      reason,
      author_agent: actor.agentId ?? null,
      author_human: actor.humanId ?? null,
    });
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
