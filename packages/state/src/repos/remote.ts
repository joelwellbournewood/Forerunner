import type { Clock } from "@forerunner/platform";
import { quoteIdent } from "../db/dialect.ts";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type {
  JsonValue,
  NewQueueItem,
  NewRemoteCommand,
  QueueItemRow,
  RemoteCommandRow,
  RemoteTarget,
} from "../types.ts";
import {
  assertTransition,
  QUEUE_ITEM_TRANSITIONS,
  REMOTE_COMMAND_TRANSITIONS,
} from "../workflow.ts";
import { type ListOptions, Repository } from "./base.ts";

/** Notes, tasks, corrections and ideas waiting for the next session. */
export class QueueRepo extends Repository<QueueItemRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.queue_item as EntityDef, clock);
  }

  enqueue(input: NewQueueItem): Promise<QueueItemRow> {
    return this.insert(input);
  }

  pending(projectId: string, opts: ListOptions = {}): Promise<QueueItemRow[]> {
    return this.list(
      { project_id: projectId, status: "queued" },
      {
        orderBy: [
          { column: "priority", direction: "desc" },
          { column: "created_at" },
          { column: "id" },
        ],
        ...opts,
      },
    );
  }

  async consume(id: string, expectedVersion: number, sessionId: string): Promise<QueueItemRow> {
    const current = await this.mustGet(id);
    assertTransition(QUEUE_ITEM_TRANSITIONS, "queue_item", current.status, "consumed");
    return this.update(id, expectedVersion, { status: "consumed", consumed_by_session: sessionId });
  }

  async dismiss(id: string, expectedVersion: number): Promise<QueueItemRow> {
    const current = await this.mustGet(id);
    assertTransition(QUEUE_ITEM_TRANSITIONS, "queue_item", current.status, "dismissed");
    return this.update(id, expectedVersion, { status: "dismissed" });
  }
}

const DEVICE_TABLE = (ENTITIES.device as EntityDef).table;
const AGENT_TABLE = (ENTITIES.agent as EntityDef).table;

/** Commands from a phone or web client to a PC or cloud runner. */
export class RemoteCommandRepo extends Repository<RemoteCommandRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.remote_command as EntityDef, clock);
  }

  enqueue(input: NewRemoteCommand): Promise<RemoteCommandRow> {
    return this.insert(input);
  }

  pending(target: RemoteTarget, opts: ListOptions = {}): Promise<RemoteCommandRow[]> {
    return this.list({ target, status: "pending" }, opts);
  }

  /** Atomically take one specific pending command; undefined when someone else already did. */
  async pickUpById(
    id: string,
    now: string = this.clock.nowIso(),
  ): Promise<RemoteCommandRow | undefined> {
    const [row] = await this.updateWhere(
      { status: "picked_up", picked_up_at: now },
      `"id" = ? AND "status" = 'pending'`,
      [id],
    );
    return row;
  }

  /**
   * Atomically take the oldest pending command for a target. Options narrow the queue:
   * `deviceId` takes only commands addressed to that device or to nobody in particular;
   * `ownerHumanId` only commands whose issuing device belongs to that human; `agentId` only
   * commands whose issuing device belongs to the human who owns that agent (the runner's own
   * agent), so on a shared state another human's phone can never hand this runner a command
   * (ADR 0033 item 8b, ADR 0041). The owner filters run in SQL on both dialects (a subquery
   * on `device.owner_human_id`, through `agent` for `agentId`), so a command of another human
   * stays `pending` for that human's own runner instead of being taken and failed here. A
   * revoked device of the owner is still picked up: the runner refuses it with a visible
   * `failed` result and an audit row rather than leaving the row pending for ever. Returns
   * undefined when nothing matches.
   */
  async pickUp(
    target: RemoteTarget,
    opts: { deviceId?: string; ownerHumanId?: string; agentId?: string; now?: string } = {},
  ): Promise<RemoteCommandRow | undefined> {
    const now = opts.now ?? this.clock.nowIso();
    let filterSql = "";
    const filterParams: unknown[] = [];
    if (opts.deviceId) {
      filterSql += ' AND ("target_device_id" IS NULL OR "target_device_id" = ?)';
      filterParams.push(opts.deviceId);
    }
    if (opts.ownerHumanId) {
      filterSql += ` AND "device_id" IN (SELECT "id" FROM ${quoteIdent(DEVICE_TABLE)} WHERE "owner_human_id" = ?)`;
      filterParams.push(opts.ownerHumanId);
    }
    if (opts.agentId) {
      filterSql += ` AND "device_id" IN (SELECT "d"."id" FROM ${quoteIdent(DEVICE_TABLE)} "d" JOIN ${quoteIdent(AGENT_TABLE)} "a" ON "a"."owner_human_id" = "d"."owner_human_id" WHERE "a"."id" = ?)`;
      filterParams.push(opts.agentId);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const [row] = await this.updateWhere(
        { status: "picked_up", picked_up_at: now },
        `"id" = (SELECT "id" FROM ${this.qt} WHERE "status" = 'pending' AND "target" = ?${filterSql}
                 ORDER BY "created_at", "id" LIMIT 1) AND "status" = 'pending'`,
        [target, ...filterParams],
      );
      if (row) return row;
      const [next] = await this.db.query<{ id: string }>(
        `SELECT "id" FROM ${this.qt} WHERE "status" = 'pending' AND "target" = ?${filterSql} LIMIT 1`,
        [target, ...filterParams],
      );
      if (!next) return undefined;
    }
    return undefined;
  }

  async complete(id: string, result: JsonValue | null = null): Promise<RemoteCommandRow> {
    const current = await this.mustGet(id);
    assertTransition(REMOTE_COMMAND_TRANSITIONS, "remote_command", current.status, "done");
    return this.update(id, current.version, { status: "done", result });
  }

  async fail(id: string, result: JsonValue | null = null): Promise<RemoteCommandRow> {
    const current = await this.mustGet(id);
    assertTransition(REMOTE_COMMAND_TRANSITIONS, "remote_command", current.status, "failed");
    return this.update(id, current.version, { status: "failed", result });
  }
}
