import { type Clock, ForerunnerError, log, systemClock } from "@forerunner/platform";
import { quoteIdent } from "../db/dialect.ts";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import { MIGRATION_0001 } from "./0001-initial.ts";
import { MIGRATION_0002 } from "./0002-headroom-savings.ts";
import { MIGRATION_0003 } from "./0003-sources.ts";
import { MIGRATION_0004 } from "./0004-shared-secrets.ts";
import { MIGRATION_0005 } from "./0005-change-reasons.ts";
import { createTableSql } from "./generate.ts";
import type { Migration } from "./types.ts";

export {
  appendOnlySql,
  createIndexSql,
  createTableSql,
  generateInitialMigration,
  generateSchemaSql,
  renderMigrationModule,
} from "./generate.ts";
export type { Migration } from "./types.ts";
export { MIGRATION_0001, MIGRATION_0002, MIGRATION_0003, MIGRATION_0004, MIGRATION_0005 };

const logger = log("state:migrations");

/** All migrations, ascending. Add new ones at the end; never edit a shipped one. */
export const MIGRATIONS: readonly Migration[] = [
  MIGRATION_0001,
  MIGRATION_0002,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0005,
];

const MIGRATIONS_TABLE = "schema_migrations";

export interface MigrateOptions {
  clock?: Clock;
  migrations?: readonly Migration[];
}

export interface MigrateResult {
  /** Versions applied by this call. */
  applied: number[];
  /** Highest version present afterwards. */
  version: number;
}

function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new ForerunnerError(
        "validation",
        `migrations must be contiguous from 1; found ${m.version} at index ${i}`,
      );
    }
  });
}

/** Versions recorded in schema_migrations (empty when the table does not exist yet). */
export async function appliedVersions(db: Database): Promise<number[]> {
  await db.exec(createTableSql(ENTITIES[MIGRATIONS_TABLE] as EntityDef, db.dialect));
  const rows = await db.query<{ version: unknown }>(
    `SELECT "version" FROM ${quoteIdent(MIGRATIONS_TABLE)} ORDER BY "version"`,
  );
  return rows.map((r) => Number(r.version));
}

/**
 * Apply pending migrations inside one transaction and record them. Safe to call on every
 * start: a second call is a no-op. Postgres takes an advisory lock so two processes
 * migrating at once serialise.
 */
export async function migrate(db: Database, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const clock = opts.clock ?? systemClock;
  const migrations = opts.migrations ?? MIGRATIONS;
  assertContiguous(migrations);
  return db.transaction(async (tx) => {
    if (tx.dialect === "postgres") {
      await tx.exec("SELECT pg_advisory_xact_lock(hashtext('forerunner_schema_migrations'))");
    }
    const done = new Set(await appliedVersions(tx));
    const applied: number[] = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      logger.debug("applying migration", { version: m.version, name: m.name, dialect: tx.dialect });
      for (const stmt of m.up[tx.dialect]) await tx.exec(stmt);
      await tx.query(
        `INSERT INTO ${quoteIdent(MIGRATIONS_TABLE)} ("version", "name", "applied_at") VALUES (?, ?, ?)`,
        [m.version, m.name, clock.nowIso()],
      );
      applied.push(m.version);
    }
    const version = Math.max(0, ...done, ...applied);
    return { applied, version };
  });
}

/** Migrations not yet applied. */
export async function pendingMigrations(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<Migration[]> {
  const done = new Set(await appliedVersions(db));
  return migrations.filter((m) => !done.has(m.version));
}
