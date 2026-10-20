import type { Clock } from "@forerunner/platform";
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
   * Atomically take the oldest pending command for a target (optionally only ones addressed
   * to `deviceId` or to nobody in particular). Returns undefined when the queue is empty.
   */
  async pickUp(
    target: RemoteTarget,
    opts: { deviceId?: string; now?: string } = {},
  ): Promise<RemoteCommandRow | undefined> {
    const now = opts.now ?? this.clock.nowIso();
    const deviceSql = opts.deviceId
      ? ' AND ("target_device_id" IS NULL OR "target_device_id" = ?)'
      : "";
    const deviceParams = opts.deviceId ? [opts.deviceId] : [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const [row] = await this.updateWhere(
        { status: "picked_up", picked_up_at: now },
        `"id" = (SELECT "id" FROM ${this.qt} WHERE "status" = 'pending' AND "target" = ?${deviceSql}
                 ORDER BY "created_at", "id" LIMIT 1) AND "status" = 'pending'`,
        [target, ...deviceParams],
      );
      if (row) return row;
      const [next] = await this.db.query<{ id: string }>(
        `SELECT "id" FROM ${this.qt} WHERE "status" = 'pending' AND "target" = ?${deviceSql} LIMIT 1`,
        [target, ...deviceParams],
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
