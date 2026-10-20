import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { MilestoneRow, ProjectRow } from "../types.ts";
import { type ListOptions, Repository } from "./base.ts";

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

export class MilestoneRepo extends Repository<MilestoneRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.milestone as EntityDef, clock);
  }

  forProject(projectId: string, opts: ListOptions = {}): Promise<MilestoneRow[]> {
    return this.list(
      { project_id: projectId },
      { orderBy: [{ column: "order_index" }, { column: "created_at" }], ...opts },
    );
  }
}
