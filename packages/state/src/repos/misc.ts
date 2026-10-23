import { type Clock, ForerunnerError } from "@forerunner/platform";
import { jsonArrayContains, jsonArrayContainsParam } from "../db/dialect.ts";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type {
  BillingSourceRow,
  BudgetScope,
  BudgetWindowRow,
  CommandRow,
  DataAssetRow,
  ExtensionKind,
  ExtensionRow,
  JsonValue,
  NewBudgetWindow,
  NewCommand,
  ReleaseRow,
  ReleaseStatus,
  SecretRefRow,
  SourceCandidateRow,
  SourceCandidateStatus,
  SourceKind,
  SourceRow,
} from "../types.ts";
import { assertTransition, RELEASE_TRANSITIONS } from "../workflow.ts";
import { Repository } from "./base.ts";

export class SourceRepo extends Repository<SourceRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.source as EntityDef, clock);
  }

  async byLocator(kind: SourceKind, locator: string): Promise<SourceRow | undefined> {
    const [row] = await this.list({ kind, locator }, { limit: 1 });
    return row;
  }

  markScanned(
    id: string,
    scanResult: JsonValue,
    status = "connected",
    now: string = this.clock.nowIso(),
  ): Promise<SourceRow> {
    return this.patch(id, { last_scan: now, scan_result: scanResult, status });
  }
}

/** Candidates a scan found (spec A.4): keyed by their normalised locator per source. */
export class SourceCandidateRepo extends Repository<SourceCandidateRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.source_candidate as EntityDef, clock);
  }

  forSource(sourceId: string, status?: SourceCandidateStatus): Promise<SourceCandidateRow[]> {
    return this.list(
      { source_id: sourceId, ...(status ? { status } : {}) },
      { orderBy: [{ column: "name" }, { column: "created_at" }] },
    );
  }

  async byKey(sourceId: string, key: string): Promise<SourceCandidateRow | undefined> {
    const [row] = await this.list({ source_id: sourceId, key }, { limit: 1 });
    return row;
  }

  /** Every source's candidates with this key (the duplicate check across sources). */
  withKey(key: string): Promise<SourceCandidateRow[]> {
    return this.list({ key }, { orderBy: "created_at" });
  }

  /** Removes a source's candidates; returns how many went. Projects are never touched. */
  async deleteForSource(sourceId: string): Promise<number> {
    const rows = await this.db.query<{ n: unknown }>(
      `DELETE FROM ${this.qt} WHERE "source_id" = ? RETURNING 1 AS n`,
      [sourceId],
    );
    return rows.length;
  }
}

export class SecretRefRepo extends Repository<SecretRefRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.secret_ref as EntityDef, clock);
  }

  async byName(ownerHumanId: string, name: string): Promise<SecretRefRow | undefined> {
    const [row] = await this.list({ owner_human_id: ownerHumanId, name }, { limit: 1 });
    return row;
  }

  /** Secrets an agent may use (granted_to contains the agent id). */
  forAgent(agentId: string): Promise<SecretRefRow[]> {
    return this.rows(
      `SELECT * FROM ${this.qt} WHERE ${jsonArrayContains('"granted_to"', this.db.dialect)} ORDER BY "name"`,
      [jsonArrayContainsParam(agentId, this.db.dialect)],
    );
  }

  async isGranted(id: string, agentId: string): Promise<boolean> {
    const ref = await this.get(id);
    return ref?.granted_to.includes(agentId) ?? false;
  }

  async grant(id: string, expectedVersion: number, agentId: string): Promise<SecretRefRow> {
    const ref = await this.mustGet(id);
    if (ref.granted_to.includes(agentId)) return ref;
    return this.update(id, expectedVersion, { granted_to: [...ref.granted_to, agentId] });
  }

  async revokeGrant(id: string, expectedVersion: number, agentId: string): Promise<SecretRefRow> {
    const ref = await this.mustGet(id);
    return this.update(id, expectedVersion, {
      granted_to: ref.granted_to.filter((a) => a !== agentId),
    });
  }

  markUsed(id: string, now: string = this.clock.nowIso()): Promise<SecretRefRow> {
    return this.patch(id, { last_used: now });
  }
}

export class ExtensionRepo extends Repository<ExtensionRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.extension as EntityDef, clock);
  }

  enabled(kind?: ExtensionKind): Promise<ExtensionRow[]> {
    return this.list({ enabled: true, ...(kind ? { kind } : {}) }, { orderBy: "name" });
  }

  async byName(kind: ExtensionKind, name: string): Promise<ExtensionRow | undefined> {
    const [row] = await this.list({ kind, name }, { limit: 1 });
    return row;
  }

  setEnabled(id: string, expectedVersion: number, enabled: boolean): Promise<ExtensionRow> {
    return this.update(id, expectedVersion, { enabled });
  }
}

export class DataAssetRepo extends Repository<DataAssetRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.data_asset as EntityDef, clock);
  }

  forProject(projectId: string): Promise<DataAssetRow[]> {
    return this.rows(
      `SELECT * FROM ${this.qt} WHERE ${jsonArrayContains('"project_ids"', this.db.dialect)} ORDER BY "created_at", "id"`,
      [jsonArrayContainsParam(projectId, this.db.dialect)],
    );
  }

  async byLocator(locator: string): Promise<DataAssetRow | undefined> {
    const [row] = await this.list({ locator }, { limit: 1 });
    return row;
  }
}

export class ReleaseRepo extends Repository<ReleaseRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.release as EntityDef, clock);
  }

  /** Newest release on a channel, optionally in a given status. */
  async latest(channel: string, status?: ReleaseStatus): Promise<ReleaseRow | undefined> {
    const [row] = await this.list(
      { channel, ...(status ? { status } : {}) },
      { orderBy: "created_at desc", limit: 1 },
    );
    return row;
  }

  async setStatus(
    id: string,
    expectedVersion: number,
    to: ReleaseStatus,
    health?: JsonValue,
  ): Promise<ReleaseRow> {
    const current = await this.mustGet(id);
    assertTransition(RELEASE_TRANSITIONS, "release", current.status, to);
    const patch: Partial<ReleaseRow> = { status: to };
    if (to === "published") patch.published_at = this.clock.nowIso();
    if (health !== undefined) patch.health = health;
    return this.update(id, expectedVersion, patch);
  }
}

export class CommandRepo extends Repository<CommandRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.command as EntityDef, clock);
  }

  async byName(name: string): Promise<CommandRow | undefined> {
    const [row] = await this.list({ name }, { limit: 1 });
    return row;
  }

  /** Insert or update by name (the registry is re-registered at every start). */
  register(input: NewCommand): Promise<CommandRow> {
    return this.db.transaction(async () => {
      const existing = await this.byName(input.name);
      if (!existing) return this.insert(input);
      const { name: _name, id: _id, ...rest } = input;
      return this.update(existing.id, existing.version, rest as Partial<CommandRow>);
    });
  }
}

export class BillingSourceRepo extends Repository<BillingSourceRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.billing_source as EntityDef, clock);
  }

  /** Enabled sources of a human in routing order (lowest priority value first). */
  enabledFor(humanId: string): Promise<BillingSourceRow[]> {
    return this.list(
      { human_id: humanId, enabled: true },
      { orderBy: [{ column: "priority" }, { column: "created_at" }] },
    );
  }

  setEnabled(id: string, expectedVersion: number, enabled: boolean): Promise<BillingSourceRow> {
    return this.update(id, expectedVersion, { enabled });
  }
}

/** Fast cap checks per scope and period. The cost ledger is the truth; this is the cache. */
export class BudgetWindowRepo extends Repository<BudgetWindowRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.budget_window as EntityDef, clock);
  }

  /** The window covering `now` for a scope, if one exists. */
  async current(
    scope: BudgetScope,
    scopeId: string,
    now: string = this.clock.nowIso(),
  ): Promise<BudgetWindowRow | undefined> {
    const [row] = await this.rows(
      `SELECT * FROM ${this.qt} WHERE "scope" = ? AND "scope_id" = ? AND "period_start" <= ? AND "period_end" > ?
        ORDER BY "period_start" DESC LIMIT 1`,
      [scope, scopeId, now, now],
    );
    return row;
  }

  /** Create the window or return the existing one for (scope, scope_id, period_start). */
  open(input: NewBudgetWindow): Promise<BudgetWindowRow> {
    return this.db.transaction(async () => {
      const [existing] = await this.list(
        { scope: input.scope, scope_id: input.scope_id, period_start: input.period_start },
        { limit: 1 },
      );
      if (existing) return existing;
      return this.insert(input);
    });
  }

  /**
   * Atomically add spend and recompute the state: ok below 80% of the cap, warn80 from 80%,
   * stopped at 100%. A cap of 0 means no cap.
   */
  async addSpent(id: string, usdMicro: number): Promise<BudgetWindowRow> {
    const delta = Math.round(usdMicro);
    const [row] = await this.rows(
      `UPDATE ${this.qt}
         SET "spent_usd_micro" = "spent_usd_micro" + ?,
             "state" = CASE
               WHEN "cap_usd_micro" <= 0 THEN 'ok'
               WHEN "spent_usd_micro" + ? >= "cap_usd_micro" THEN 'stopped'
               WHEN ("spent_usd_micro" + ?) * 5 >= "cap_usd_micro" * 4 THEN 'warn80'
               ELSE 'ok' END,
             "updated_at" = ?, "version" = "version" + 1
       WHERE "id" = ? RETURNING *`,
      [delta, delta, delta, this.clock.nowIso(), id],
    );
    if (!row)
      throw new ForerunnerError("not_found", `budget_window ${id} not found`, { details: { id } });
    return row;
  }

  setCap(id: string, expectedVersion: number, capUsdMicro: number): Promise<BudgetWindowRow> {
    return this.db.transaction(async () => {
      await this.update(id, expectedVersion, { cap_usd_micro: capUsdMicro });
      return this.addSpent(id, 0);
    });
  }
}
