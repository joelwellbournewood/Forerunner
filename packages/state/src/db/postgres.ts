import { AsyncLocalStorage } from "node:async_hooks";
import { ForerunnerError, log } from "@forerunner/platform";
import pg from "pg";
import { quoteIdent, toPositional } from "./dialect.ts";
import type { Database, Dialect, Row } from "./types.ts";

/**
 * Postgres adapter over `pg.Pool`. `?` placeholders are rewritten to `$n`. BOOLEAN and
 * JSONB come back parsed by the driver; INT8 and NUMERIC are parsed to JS numbers through
 * a per-pool type parser (never the global one, so other users of `pg` in the process are
 * unaffected). Transactions run on a dedicated client; nested ones use SAVEPOINTs.
 */

const logger = log("state:postgres");

type Queryable = Pick<pg.Pool, "query">;

const INT8_OID = 20;
const NUMERIC_OID = 1700;

function numberParsingTypes(): pg.CustomTypesConfig {
  const base = pg.types.getTypeParser;
  return {
    getTypeParser(oid: number, format?: "text" | "binary") {
      if (format !== "binary" && (oid === INT8_OID || oid === NUMERIC_OID)) {
        return (value: string | null) => (value === null ? null : Number(value));
      }
      return (base as (oid: number, format?: "text" | "binary") => (v: string) => unknown)(
        oid,
        format,
      );
    },
  } as pg.CustomTypesConfig;
}

function encodeParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

async function runQuery<T>(target: Queryable, sql: string, params: unknown[]): Promise<T[]> {
  const result = await target.query({ text: toPositional(sql), values: params.map(encodeParam) });
  return result.rows as T[];
}

interface Shared {
  readonly pool: pg.Pool;
  readonly als: AsyncLocalStorage<PgTx>;
  closed: boolean;
}

class PgTx implements Database {
  readonly dialect: Dialect = "postgres";
  readonly inTransaction = true;
  constructor(
    private readonly shared: Shared,
    readonly client: pg.PoolClient,
    private readonly depth: number,
  ) {}

  query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return runQuery<T>(this.client, sql, params);
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const name = `fr_sp_${this.depth + 1}`;
    const inner = new PgTx(this.shared, this.client, this.depth + 1);
    await this.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await this.shared.als.run(inner, () => fn(inner));
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (e) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      throw e;
    }
  }

  async close(): Promise<void> {
    throw new ForerunnerError("not_supported", "close() is not allowed on a transaction handle");
  }
}

export class PostgresDatabase implements Database {
  readonly dialect: Dialect = "postgres";
  readonly inTransaction = false;
  private readonly shared: Shared;

  constructor(
    pool: pg.Pool,
    readonly schema: string | undefined,
  ) {
    this.shared = { pool, als: new AsyncLocalStorage<PgTx>(), closed: false };
    pool.on("error", (e) => logger.warn("idle client error", { error: e.message }));
  }

  private assertOpen(): void {
    if (this.shared.closed) throw new ForerunnerError("unavailable", "postgres pool is closed");
  }

  query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.assertOpen();
    const active = this.shared.als.getStore();
    if (active) return active.query<T>(sql, params);
    return runQuery<T>(this.shared.pool, sql, params);
  }

  async exec(sql: string): Promise<void> {
    this.assertOpen();
    const active = this.shared.als.getStore();
    if (active) return active.exec(sql);
    await this.shared.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    this.assertOpen();
    const active = this.shared.als.getStore();
    if (active) return active.transaction(fn);
    const client = await this.shared.pool.connect();
    const tx = new PgTx(this.shared, client, 0);
    try {
      await client.query("BEGIN");
      const result = await this.shared.als.run(tx, () => fn(tx));
      await client.query("COMMIT");
      return result;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        logger.warn("rollback failed", { error: String(rollbackError) });
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.shared.closed) return;
    this.shared.closed = true;
    await this.shared.pool.end();
  }
}

export interface PostgresOptions {
  /**
   * Schema to work in (created if missing and put first on search_path for every
   * connection). Tests use one schema per run; deployments may use it for tenancy.
   */
  schema?: string;
  /** Pool size. Default 10. */
  max?: number;
  /** Fail connect() after this many ms. Default 10000. */
  connectionTimeoutMs?: number;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Open a pool for `url` (postgres:// or postgresql://). The URL comes from the caller, never from a constant. */
export async function openPostgres(
  url: string,
  opts: PostgresOptions = {},
): Promise<PostgresDatabase> {
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new ForerunnerError(
      "validation",
      "postgres url must start with postgres:// or postgresql://",
    );
  }
  const schema = opts.schema;
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new ForerunnerError("validation", "postgres schema name must match ^[a-z_][a-z0-9_]*$", {
      details: { schema },
    });
  }
  if (schema) {
    const bootstrap = new pg.Pool({ connectionString: url, max: 1 });
    try {
      await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    } finally {
      await bootstrap.end();
    }
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 10_000,
    types: numberParsingTypes(),
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  return new PostgresDatabase(pool, schema);
}
