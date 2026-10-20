import type { Clock } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { DeviceRow, NewDevice } from "../types.ts";
import { Repository } from "./base.ts";

export type RegisterDevice = Omit<NewDevice, "paired_at"> & { paired_at?: string };

export class DeviceRepo extends Repository<DeviceRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.device as EntityDef, clock);
  }

  register(input: RegisterDevice): Promise<DeviceRow> {
    return this.insert({ paired_at: this.clock.nowIso(), ...input });
  }

  revoke(id: string, expectedVersion: number): Promise<DeviceRow> {
    return this.update(id, expectedVersion, { revoked: true, revoked_at: this.clock.nowIso() });
  }

  /** Devices of a human that are not revoked. */
  active(ownerHumanId: string): Promise<DeviceRow[]> {
    return this.list({ owner_human_id: ownerHumanId, revoked: false });
  }

  seen(id: string, now: string = this.clock.nowIso()): Promise<DeviceRow> {
    return this.patch(id, { last_seen: now });
  }

  async byPublicKey(publicKey: string): Promise<DeviceRow | undefined> {
    const [row] = await this.list({ public_key: publicKey }, { limit: 1 });
    return row;
  }
}
