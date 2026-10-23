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

  /**
   * Set or clear the device's push registration token (spec R.6). Last write wins: the token
   * belongs to the device itself and a refresh must not fail on a concurrent `last_seen` bump.
   */
  setPushToken(id: string, token: string | null): Promise<DeviceRow> {
    return this.patch(id, { push_token: token });
  }

  /** Devices of a human that are not revoked and hold a push token. */
  async pushTargets(ownerHumanId: string): Promise<DeviceRow[]> {
    const rows = await this.active(ownerHumanId);
    return rows.filter((d) => typeof d.push_token === "string" && d.push_token !== "");
  }

  async byPublicKey(publicKey: string): Promise<DeviceRow | undefined> {
    const [row] = await this.list({ public_key: publicKey }, { limit: 1 });
    return row;
  }
}
