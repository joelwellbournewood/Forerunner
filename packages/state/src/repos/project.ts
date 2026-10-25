import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { MilestoneRow, ProjectRow } from "../types.ts";
import {
  type Actor,
  authorColumns,
  type ListOptions,
  Repository,
  requireChangeReason,
} from "./base.ts";

export class ProjectRepo extends Repository<ProjectRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.project as EntityDef, clock);
  }

  active(opts: ListOptions = {}): Promise<ProjectRow[]> {
    return this.list({ active: true, status: "active" }, { orderBy: "name", ...opts });
  }

  async byName(name: string): Promise<ProjectRow | undefined> {
    const [row] = await this.list({ name }, { limit: 1 });
    return row;
  }
}

/**
 * Milestones. Every change is versioned with its author and reason (spec B.5): `change` is
 * the write path for an existing row, `insert` refuses a new row that names no reason or no
 * author (a new milestone is a change to the project's plan), and `updateWhere` refuses any
 * update whose patch lacks them, so `update`, `patch` and `insertMany` cannot bypass it.
 */
export class MilestoneRepo extends Repository<MilestoneRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.milestone as EntityDef, clock);
  }

  override async insert(input: Record<string, unknown>): Promise<MilestoneRow> {
    requireChangeReason(this.table, input);
    return super.insert(input);
  }

  /**
   * Change a milestone with optimistic concurrency, recording why and by whom. A blank
   * reason or an actor naming neither agent nor human is ForerunnerError("validation");
   * a stale `expectedVersion` is "version_conflict".
   */
  async change(
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<MilestoneRow, "reason" | "author_agent" | "author_human">>,
    reason: string,
    actor: Actor,
  ): Promise<MilestoneRow> {
    return this.update(id, expectedVersion, {
      ...patch,
      reason: reason.trim(),
      ...authorColumns(actor),
    });
  }

  override async updateWhere(
    patch: Partial<MilestoneRow>,
    whereSql: string,
    whereParams: unknown[],
    extra: { set: string[]; params: unknown[] } = { set: [], params: [] },
  ): Promise<MilestoneRow[]> {
    requireChangeReason(this.table, patch);
    return super.updateWhere(patch, whereSql, whereParams, extra);
  }

  forProject(projectId: string, opts: ListOptions = {}): Promise<MilestoneRow[]> {
    return this.list(
      { project_id: projectId },
      { orderBy: [{ column: "order_index" }, { column: "created_at" }], ...opts },
    );
  }
}
