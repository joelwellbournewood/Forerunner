import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { ChangeLogRow, NewChangeLog } from "../types.ts";
import { type ListOptions, Repository } from "./base.ts";

export class ChangeLogRepo extends Repository<ChangeLogRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.change_log as EntityDef, clock);
  }

  record(input: NewChangeLog): Promise<ChangeLogRow> {
    return this.insert(input);
  }

  /** Changes that can still be undone, newest first. */
  undoable(
    filter: { humanId?: string; projectId?: string } = {},
    now: string = this.clock.nowIso(),
    opts: ListOptions = {},
  ): Promise<ChangeLogRow[]> {
    const parts = ["\"undo_state\" = 'undoable'", '("expires_at" IS NULL OR "expires_at" > ?)'];
    const params: unknown[] = [now];
    if (filter.humanId !== undefined) {
      parts.push('"human_id" = ?');
      params.push(filter.humanId);
    }
    if (filter.projectId !== undefined) {
      parts.push('"project_id" = ?');
      params.push(filter.projectId);
    }
    let tail = ' ORDER BY "created_at" DESC, "id" DESC';
    if (opts.limit !== undefined) {
      tail += " LIMIT ?";
      params.push(Math.max(0, Math.floor(opts.limit)));
    }
    return this.rows(`SELECT * FROM ${this.qt} WHERE ${parts.join(" AND ")}${tail}`, params);
  }

  markUndone(
    id: string,
    expectedVersion: number,
    now: string = this.clock.nowIso(),
  ): Promise<ChangeLogRow> {
    return this.update(id, expectedVersion, { undo_state: "undone", undone_at: now });
  }

  /** Temporary changes whose window closed become expired. Returns the rows changed. */
  expireDue(now: string = this.clock.nowIso()): Promise<ChangeLogRow[]> {
    return this.updateWhere(
      { undo_state: "expired" },
      `"undo_state" = 'undoable' AND "expires_at" IS NOT NULL AND "expires_at" <= ?`,
      [now],
    );
  }

  forProject(projectId: string, opts: ListOptions = {}): Promise<ChangeLogRow[]> {
    return this.list({ project_id: projectId }, { orderBy: "created_at desc", ...opts });
  }
}
