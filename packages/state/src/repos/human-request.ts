import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { HumanRequestRow, JsonValue } from "../types.ts";
import { assertTransition, HUMAN_REQUEST_TRANSITIONS } from "../workflow.ts";
import { type ListOptions, Repository } from "./base.ts";

export class HumanRequestRepo extends Repository<HumanRequestRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.human_request as EntityDef, clock);
  }

  /** Open requests, blocking ones first, then oldest first. */
  open(
    filter: { humanId?: string; projectId?: string } = {},
    opts: ListOptions = {},
  ): Promise<HumanRequestRow[]> {
    return this.list(
      {
        status: "open",
        ...(filter.humanId !== undefined ? { human_id: filter.humanId } : {}),
        ...(filter.projectId !== undefined ? { project_id: filter.projectId } : {}),
      },
      {
        orderBy: [
          { column: "blocking", direction: "desc" },
          { column: "created_at" },
          { column: "id" },
        ],
        ...opts,
      },
    );
  }

  async answer(
    id: string,
    expectedVersion: number,
    answer: JsonValue,
    by: string,
    now: string = this.clock.nowIso(),
  ): Promise<HumanRequestRow> {
    const current = await this.mustGet(id);
    assertTransition(HUMAN_REQUEST_TRANSITIONS, "human_request", current.status, "answered");
    return this.update(id, expectedVersion, {
      status: "answered",
      answer,
      answered_by: by,
      answered_at: now,
      author_human: by,
    });
  }

  async withdraw(id: string, expectedVersion: number): Promise<HumanRequestRow> {
    const current = await this.mustGet(id);
    assertTransition(HUMAN_REQUEST_TRANSITIONS, "human_request", current.status, "withdrawn");
    return this.update(id, expectedVersion, { status: "withdrawn" });
  }

  async expire(id: string, expectedVersion: number): Promise<HumanRequestRow> {
    const current = await this.mustGet(id);
    assertTransition(HUMAN_REQUEST_TRANSITIONS, "human_request", current.status, "expired");
    return this.update(id, expectedVersion, { status: "expired" });
  }
}
