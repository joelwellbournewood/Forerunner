import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { AgentRow, HumanRow } from "../types.ts";
import { type ListOptions, Repository } from "./base.ts";

export class HumanRepo extends Repository<HumanRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.human as EntityDef, clock);
  }

  async byEmail(email: string): Promise<HumanRow | undefined> {
    const [row] = await this.rows(`SELECT * FROM ${this.qt} WHERE LOWER("email") = ? LIMIT 1`, [
      email.trim().toLowerCase(),
    ]);
    return row;
  }
}

export class AgentRepo extends Repository<AgentRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.agent as EntityDef, clock);
  }

  forOwner(ownerHumanId: string, opts: ListOptions = {}): Promise<AgentRow[]> {
    return this.list({ owner_human_id: ownerHumanId }, opts);
  }

  async byName(ownerHumanId: string, name: string): Promise<AgentRow | undefined> {
    const [row] = await this.list({ owner_human_id: ownerHumanId, name }, { limit: 1 });
    return row;
  }

  principals(ownerHumanId: string): Promise<AgentRow[]> {
    return this.list({ owner_human_id: ownerHumanId, kind: "principal", status: "active" });
  }
}
