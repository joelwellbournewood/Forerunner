import { type Clock, ForerunnerError } from "@forerunner/platform";
import { jsonArrayContains, jsonArrayContainsParam } from "../db/dialect.ts";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type {
  JsonObject,
  NewSecretGrant,
  SecretGrantBlob,
  SecretGrantRow,
  SecretGrantStatus,
} from "../types.ts";
import { assertTransition, SECRET_GRANT_TRANSITIONS } from "../workflow.ts";
import { type ListOptions, Repository } from "./base.ts";

/**
 * Shared secrets (spec S.13, ADR 0065). A grant names the agents that may read one secret of
 * the owner's vault and carries the value wrapped to each named agent's install key. It is
 * `pending` until every human other than the owner whose agent is named has approved, then
 * `active`; a refusal makes it `cancelled`, the owner may `revoke` it at any time, and both
 * ends drop the blobs. Only `blobFor` hands a blob out, and only for an active grant, to the
 * agent it names and the install it was wrapped for. The value is never in this table.
 */
export class SecretGrantRepo extends Repository<SecretGrantRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.secret_grant as EntityDef, clock);
  }

  /** File a grant. With nobody to ask (only the owner's own agents are named) it is active at once. */
  propose(input: NewSecretGrant): Promise<SecretGrantRow> {
    const required = input.required_human_ids ?? [];
    const now = this.clock.nowIso();
    return this.insert({
      ...input,
      status: required.length === 0 ? "active" : "pending",
      activated_at: required.length === 0 ? now : null,
    });
  }

  forOwner(ownerHumanId: string, status?: SecretGrantStatus): Promise<SecretGrantRow[]> {
    return this.list(
      { owner_human_id: ownerHumanId, ...(status ? { status } : {}) },
      { orderBy: "created_at desc" },
    );
  }

  /** Grants a human is the owner of or must approve (both halves of the two-human rule). */
  async forHuman(humanId: string, opts: ListOptions = {}): Promise<SecretGrantRow[]> {
    return this.rows(
      `SELECT * FROM ${this.qt} WHERE "owner_human_id" = ? OR ${jsonArrayContains(
        '"required_human_ids"',
        this.db.dialect,
      )} ORDER BY "created_at" DESC, "id" DESC${opts.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : ""}`,
      [humanId, jsonArrayContainsParam(humanId, this.db.dialect)],
    );
  }

  /** Active grants that name the agent, newest first. */
  activeFor(agentId: string): Promise<SecretGrantRow[]> {
    return this.rows(
      `SELECT * FROM ${this.qt} WHERE "status" = 'active' AND ${jsonArrayContains(
        '"agent_ids"',
        this.db.dialect,
      )} ORDER BY "created_at" DESC, "id" DESC`,
      [jsonArrayContainsParam(agentId, this.db.dialect)],
    );
  }

  /** Names of the shared secrets an agent may currently resolve (what joins its run token). */
  async activeNamesFor(agentId: string): Promise<string[]> {
    const names = new Set((await this.activeFor(agentId)).map((g) => g.name));
    return [...names].sort();
  }

  /**
   * Record one human's approval. The grant becomes active with the last required one; an
   * approval from a human the grant does not wait for is refused (`validation`), as is one on
   * a grant that is no longer pending.
   */
  async approve(
    id: string,
    expectedVersion: number,
    humanId: string,
    requestId: string | null,
    now: string = this.clock.nowIso(),
  ): Promise<SecretGrantRow> {
    const current = await this.mustGet(id);
    if (current.status !== "pending") {
      throw new ForerunnerError("validation", `secret grant ${id} is ${current.status}`, {
        details: { id, status: current.status },
      });
    }
    if (!current.required_human_ids.includes(humanId)) {
      throw new ForerunnerError("validation", "this human's approval is not required", {
        details: { id, humanId },
      });
    }
    const approvals: JsonObject = {
      ...current.approvals,
      [humanId]: { at: now, request_id: requestId },
    };
    const complete = current.required_human_ids.every((h) => h in approvals);
    return this.update(id, expectedVersion, {
      approvals,
      ...(complete ? { status: "active", activated_at: now } : {}),
      author_human: humanId,
    });
  }

  /** Cancel (a refusal) or revoke (the owner). The blobs are dropped with the status. */
  async end(
    id: string,
    expectedVersion: number,
    to: "cancelled" | "revoked",
    reason: string,
    by: string | null = null,
    now: string = this.clock.nowIso(),
  ): Promise<SecretGrantRow> {
    const current = await this.mustGet(id);
    assertTransition(SECRET_GRANT_TRANSITIONS, "secret_grant", current.status, to);
    return this.update(id, expectedVersion, {
      status: to,
      blobs: [],
      ended_at: now,
      ended_reason: reason,
      author_human: by,
    });
  }

  /**
   * The one way a blob leaves the table: for an active grant of `name` that names `agentId`,
   * the copy wrapped for `deviceId`. Anything else is `undefined`; the caller decides the
   * error. With several active grants of one name for the agent the newest wins.
   */
  async blobFor(
    name: string,
    agentId: string,
    deviceId: string,
  ): Promise<{ grant: SecretGrantRow; blob: SecretGrantBlob } | undefined> {
    const grants = (await this.activeFor(agentId)).filter((g) => g.name === name);
    for (const grant of grants) {
      const blob = grant.blobs.find((b) => b.agent_id === agentId && b.device_id === deviceId);
      if (blob) return { grant, blob };
    }
    return undefined;
  }

  markServed(id: string, now: string = this.clock.nowIso()): Promise<SecretGrantRow> {
    return this.patch(id, { last_served: now });
  }
}
