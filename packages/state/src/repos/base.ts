import { type Clock, ForerunnerError } from "@forerunner/platform";
import { quoteIdent } from "../db/dialect.ts";
import type { Database, Row } from "../db/types.ts";
import { monotonicId } from "../ids.ts";
import { allColumns, type EntityDef } from "../schema.ts";
import type { BaseRow } from "../types.ts";
import { columnMap, decodeRow, encodePatch } from "./codec.ts";

/**
 * Generic repository over one entity: insert, get, list, update with optimistic
 * concurrency, delete. Typed repositories extend it with entity logic. Every write sets
 * updated_at from the injected Clock and bumps version.
 */

export interface OrderSpec {
  column: string;
  direction?: "asc" | "desc";
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  /** Column name, "column desc", or explicit specs. Default: created_at, id. */
  orderBy?: string | OrderSpec | OrderSpec[];
}

/** Equality filter: `null` matches IS NULL, an array matches IN (...). */
export type Filter<T> = { [K in keyof T]?: T[K] | T[K][] | null };

export interface WhereClause {
  sql: string;
  params: unknown[];
}

/** Who made a change: the agent, the human, or both. Where a reason is required, so is one of them. */
export interface Actor {
  agentId?: string | null;
  humanId?: string | null;
}

/** Author columns of a patch, from an Actor. */
export function authorColumns(actor: Actor): Pick<BaseRow, "author_agent" | "author_human"> {
  return { author_agent: actor.agentId ?? null, author_human: actor.humanId ?? null };
}

/**
 * Spec B.5: a change that must carry its reason is refused unless the patch names a non-blank
 * `reason` and an author (`author_agent` or `author_human`). Repositories whose rows carry a
 * reason call this from `updateWhere`, so the generic `update` and `patch` are no back door.
 * The ForerunnerError("validation") says which is missing in `details.missing`.
 */
export function requireChangeReason(table: string, patch: Record<string, unknown>): void {
  const reason = patch.reason;
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new ForerunnerError("validation", `${table}: a change needs a reason (spec B.5)`, {
      details: { table, missing: "reason" },
    });
  }
  if (!patch.author_agent && !patch.author_human) {
    throw new ForerunnerError(
      "validation",
      `${table}: a change needs its author, an agent or a human (spec B.5)`,
      { details: { table, missing: "actor" } },
    );
  }
}

export class Repository<T extends BaseRow> {
  readonly table: string;
  protected readonly columns: ReturnType<typeof columnMap>;

  constructor(
    readonly db: Database,
    readonly entity: EntityDef,
    readonly clock: Clock,
  ) {
    this.table = entity.table;
    this.columns = columnMap(entity);
  }

  /** Quoted table name for hand-written SQL. */
  get qt(): string {
    return quoteIdent(this.table);
  }

  protected decode(row: Row): T {
    return decodeRow<T>(this.entity, row, this.db.dialect);
  }

  /** Run SQL and decode the rows as this entity. */
  async rows(sql: string, params: unknown[] = []): Promise<T[]> {
    const raw = await this.db.query<Row>(sql, params);
    return raw.map((r) => this.decode(r));
  }

  protected assertColumn(name: string): string {
    if (!this.columns.has(name)) {
      throw new ForerunnerError("validation", `${this.table}: unknown column ${name}`, {
        details: { table: this.table, column: name },
      });
    }
    return quoteIdent(name);
  }

  /** Build a WHERE clause from an equality filter. */
  where(filter: Filter<T> | undefined): WhereClause {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        if (v === undefined) continue;
        const col = this.columns.get(k);
        const q = this.assertColumn(k);
        if (col?.type === "json") {
          throw new ForerunnerError(
            "validation",
            `${this.table}: cannot filter on JSON column ${k}`,
            {
              details: { table: this.table, column: k },
            },
          );
        }
        if (v === null) {
          parts.push(`${q} IS NULL`);
        } else if (Array.isArray(v)) {
          if (v.length === 0) {
            parts.push("1 = 0");
          } else {
            parts.push(`${q} IN (${v.map(() => "?").join(", ")})`);
            for (const item of v) params.push(this.encodeOne(k, item));
          }
        } else {
          parts.push(`${q} = ?`);
          params.push(this.encodeOne(k, v));
        }
      }
    }
    return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", params };
  }

  protected encodeOne(column: string, value: unknown): unknown {
    const { values } = encodePatch(this.entity, { [column]: value }, this.db.dialect);
    return values[0];
  }

  protected orderSql(orderBy: ListOptions["orderBy"]): string {
    let specs: OrderSpec[];
    if (!orderBy) specs = [{ column: "created_at" }, { column: "id" }];
    else if (typeof orderBy === "string") {
      const [column, dir] = orderBy.trim().split(/\s+/);
      specs = [
        { column: column as string, direction: dir?.toLowerCase() === "desc" ? "desc" : "asc" },
      ];
    } else specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    // Deterministic order: ids are monotonic per process, so "id" breaks ties in the same direction.
    const last = specs[specs.length - 1];
    if (last && !specs.some((s) => s.column === "id"))
      specs = [...specs, { column: "id", direction: last.direction }];
    const rendered = specs.map(
      (s) => `${this.assertColumn(s.column)} ${s.direction === "desc" ? "DESC" : "ASC"}`,
    );
    return rendered.length ? ` ORDER BY ${rendered.join(", ")}` : "";
  }

  protected limitSql(opts: ListOptions): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    let sql = "";
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(Math.max(0, Math.floor(opts.limit)));
    }
    if (opts.offset !== undefined) {
      if (opts.limit === undefined) {
        // SQLite requires LIMIT before OFFSET; -1 means unlimited in SQLite, Postgres uses ALL.
        sql += this.db.dialect === "sqlite" ? " LIMIT -1" : " LIMIT ALL";
      }
      sql += " OFFSET ?";
      params.push(Math.max(0, Math.floor(opts.offset)));
    }
    return { sql, params };
  }

  /** Insert a row. Fills the envelope and schema defaults; missing required columns throw. */
  async insert(input: Record<string, unknown>): Promise<T> {
    const now = this.clock.nowIso();
    const row: Record<string, unknown> = {};
    for (const col of allColumns(this.entity)) {
      const given = input[col.name];
      if (col.name === "id")
        row.id = typeof given === "string" && given ? given : monotonicId(this.clock.now());
      else if (col.name === "created_at") row.created_at = given ?? now;
      else if (col.name === "updated_at") row.updated_at = now;
      else if (col.name === "version") row.version = 1;
      else if (given !== undefined) row[col.name] = given;
      else if (col.default !== undefined) row[col.name] = col.default;
      else if (col.nullable) row[col.name] = null;
      else {
        throw new ForerunnerError(
          "validation",
          `${this.table}: missing required column ${col.name}`,
          {
            details: { table: this.table, column: col.name },
          },
        );
      }
    }
    for (const k of Object.keys(input)) this.assertColumn(k);
    const { columns, values } = encodePatch(this.entity, row, this.db.dialect);
    const sql = `INSERT INTO ${this.qt} (${columns.map(quoteIdent).join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")}) RETURNING *`;
    const [inserted] = await this.rows(sql, values);
    if (!inserted) throw new ForerunnerError("internal", `${this.table}: insert returned no row`);
    return inserted;
  }

  async insertMany(inputs: Record<string, unknown>[]): Promise<T[]> {
    return this.db.transaction(async () => {
      const out: T[] = [];
      for (const input of inputs) out.push(await this.insert(input));
      return out;
    });
  }

  async get(id: string): Promise<T | undefined> {
    const [row] = await this.rows(`SELECT * FROM ${this.qt} WHERE "id" = ?`, [id]);
    return row;
  }

  async mustGet(id: string): Promise<T> {
    const row = await this.get(id);
    if (!row) {
      throw new ForerunnerError("not_found", `${this.table} ${id} not found`, {
        details: { table: this.table, id },
      });
    }
    return row;
  }

  async exists(id: string): Promise<boolean> {
    const rows = await this.db.query<{ one: number }>(
      `SELECT 1 AS one FROM ${this.qt} WHERE "id" = ?`,
      [id],
    );
    return rows.length > 0;
  }

  async list(filter?: Filter<T>, opts: ListOptions = {}): Promise<T[]> {
    const w = this.where(filter);
    const l = this.limitSql(opts);
    return this.rows(`SELECT * FROM ${this.qt}${w.sql}${this.orderSql(opts.orderBy)}${l.sql}`, [
      ...w.params,
      ...l.params,
    ]);
  }

  async count(filter?: Filter<T>): Promise<number> {
    const w = this.where(filter);
    const [row] = await this.db.query<{ n: unknown }>(
      `SELECT COUNT(*) AS n FROM ${this.qt}${w.sql}`,
      w.params,
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Update with optimistic concurrency. Throws ForerunnerError("version_conflict") when the
   * stored version differs from `expectedVersion`, "not_found" when the row is missing.
   */
  async update(id: string, expectedVersion: number, patch: Partial<T>): Promise<T> {
    const [row] = await this.updateWhere(patch, `"id" = ? AND "version" = ?`, [
      id,
      expectedVersion,
    ]);
    if (row) return row;
    const current = await this.get(id);
    if (!current) {
      throw new ForerunnerError("not_found", `${this.table} ${id} not found`, {
        details: { table: this.table, id },
      });
    }
    throw new ForerunnerError(
      "version_conflict",
      `${this.table} ${id}: expected version ${expectedVersion}, found ${current.version}`,
      {
        details: { table: this.table, id, expected: expectedVersion, actual: current.version },
        retryable: true,
      },
    );
  }

  /** Update without a version check (still bumps version and updated_at). */
  async patch(id: string, patch: Partial<T>): Promise<T> {
    const [row] = await this.updateWhere(patch, `"id" = ?`, [id]);
    if (!row) {
      throw new ForerunnerError("not_found", `${this.table} ${id} not found`, {
        details: { table: this.table, id },
      });
    }
    return row;
  }

  /**
   * UPDATE ... SET <patch>, updated_at, version = version + 1 [, extra.set] WHERE <where> RETURNING *.
   * `extra` adds raw SET fragments with their own parameters, e.g.
   * { set: ['"hit_count" = "hit_count" + ?'], params: [1] }.
   */
  async updateWhere(
    patch: Partial<T>,
    whereSql: string,
    whereParams: unknown[],
    extra: { set: string[]; params: unknown[] } = { set: [], params: [] },
  ): Promise<T[]> {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "created_at" || k === "updated_at" || k === "version") continue;
      clean[k] = v;
    }
    clean.updated_at = this.clock.nowIso();
    const { columns, values } = encodePatch(this.entity, clean, this.db.dialect);
    const sets = [
      ...columns.map((c) => `${quoteIdent(c)} = ?`),
      '"version" = "version" + 1',
      ...extra.set,
    ];
    const sql = `UPDATE ${this.qt} SET ${sets.join(", ")} WHERE ${whereSql} RETURNING *`;
    return this.rows(sql, [...values, ...extra.params, ...whereParams]);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.query<Row>(`DELETE FROM ${this.qt} WHERE "id" = ? RETURNING "id"`, [
      id,
    ]);
    return rows.length > 0;
  }
}
