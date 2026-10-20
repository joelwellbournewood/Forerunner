import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { dirname, ForerunnerError, log } from "@forerunner/platform";
import type { Database, Dialect, Row } from "./types.ts";

/**
 * SQLite adapter over Node's built-in `node:sqlite` (DatabaseSync). The driver is
 * synchronous; calls are wrapped in the async Database interface and serialised with a
 * mutex so concurrent async callers never interleave statements on one connection.
 * Transactions use BEGIN IMMEDIATE / COMMIT / ROLLBACK; nested transactions use SAVEPOINTs.
 */

const logger = log("state:sqlite");

let warningFilterInstalled = false;

/**
 * Node 22 prints "ExperimentalWarning: SQLite is an experimental feature" on first load.
 * Filter exactly that warning once, before the module is imported; every other warning
 * still reaches Node's default printer and any user listeners.
 */
export function silenceSqliteExperimentalWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emit.bind(process) as (...args: unknown[]) => boolean;
  const filtered = (...args: unknown[]): boolean => {
    const [name, payload] = args;
    if (name === "warning" && typeof payload === "object" && payload !== null) {
      const w = payload as { name?: unknown; message?: unknown };
      if (w.name === "ExperimentalWarning" && /SQLite/i.test(String(w.message))) return false;
    }
    return original(...args);
  };
  (process as unknown as { emit: (...args: unknown[]) => boolean }).emit = filtered;
}

let driverPromise: Promise<typeof import("node:sqlite")> | undefined;

async function loadDriver(): Promise<typeof import("node:sqlite")> {
  silenceSqliteExperimentalWarning();
  if (!driverPromise) driverPromise = import("node:sqlite");
  return driverPromise;
}

type Bindable = null | number | bigint | string | Uint8Array;

function encodeParam(v: unknown): Bindable {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function plainRows<T>(rows: unknown[]): T[] {
  // node:sqlite returns null-prototype objects; copy into plain ones so deep equality in
  // callers and tests behaves like Postgres rows.
  return rows.map((r) => ({ ...(r as Row) })) as T[];
}

interface Connection {
  readonly conn: DatabaseSync;
  readonly als: AsyncLocalStorage<SqliteTx>;
  chain: Promise<unknown>;
  closed: boolean;
}

class SqliteTx implements Database {
  readonly dialect: Dialect = "sqlite";
  readonly inTransaction = true;
  constructor(
    private readonly shared: Connection,
    private readonly depth: number,
  ) {}

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return runQuery<T>(this.shared.conn, sql, params);
  }

  async exec(sql: string): Promise<void> {
    this.shared.conn.exec(sql);
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const name = `fr_sp_${this.depth + 1}`;
    const inner = new SqliteTx(this.shared, this.depth + 1);
    this.shared.conn.exec(`SAVEPOINT ${name}`);
    try {
      const result = await this.shared.als.run(inner, () => fn(inner));
      this.shared.conn.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (e) {
      this.shared.conn.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.shared.conn.exec(`RELEASE SAVEPOINT ${name}`);
      throw e;
    }
  }

  async close(): Promise<void> {
    throw new ForerunnerError("not_supported", "close() is not allowed on a transaction handle");
  }
}

function runQuery<T>(conn: DatabaseSync, sql: string, params: unknown[]): T[] {
  const stmt = conn.prepare(sql);
  const rows = stmt.all(...params.map(encodeParam));
  return plainRows<T>(rows);
}

export class SqliteDatabase implements Database {
  readonly dialect: Dialect = "sqlite";
  readonly inTransaction = false;
  private readonly shared: Connection;

  constructor(
    conn: DatabaseSync,
    readonly location: string,
  ) {
    this.shared = {
      conn,
      als: new AsyncLocalStorage<SqliteTx>(),
      chain: Promise.resolve(),
      closed: false,
    };
  }

  /** Serialise work on the single connection; callers already inside a transaction bypass the lock. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.shared.closed) {
      return Promise.reject(new ForerunnerError("unavailable", "sqlite database is closed"));
    }
    const run = this.shared.chain.then(fn, fn);
    this.shared.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const active = this.shared.als.getStore();
    if (active) return active.query<T>(sql, params);
    return this.withLock(async () => runQuery<T>(this.shared.conn, sql, params));
  }

  async exec(sql: string): Promise<void> {
    const active = this.shared.als.getStore();
    if (active) return active.exec(sql);
    return this.withLock(async () => {
      this.shared.conn.exec(sql);
    });
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const active = this.shared.als.getStore();
    if (active) return active.transaction(fn);
    return this.withLock(async () => {
      const tx = new SqliteTx(this.shared, 0);
      this.shared.conn.exec("BEGIN IMMEDIATE");
      try {
        const result = await this.shared.als.run(tx, () => fn(tx));
        this.shared.conn.exec("COMMIT");
        return result;
      } catch (e) {
        try {
          this.shared.conn.exec("ROLLBACK");
        } catch (rollbackError) {
          logger.warn("rollback failed", { error: String(rollbackError) });
        }
        throw e;
      }
    });
  }

  async close(): Promise<void> {
    if (this.shared.closed) return;
    await this.withLock(async () => {
      this.shared.closed = true;
      this.shared.conn.close();
    });
  }
}

export interface SqliteOptions {
  /** Busy timeout in ms when another process holds the file lock. Default 5000. */
  busyTimeoutMs?: number;
}

/**
 * Open a SQLite database. `location` is ":memory:" or a file path (its directory is
 * created). WAL journaling and foreign keys are enabled.
 */
export async function openSqlite(
  location: string,
  opts: SqliteOptions = {},
): Promise<SqliteDatabase> {
  const { DatabaseSync } = await loadDriver();
  const isMemory = location === ":memory:";
  if (!isMemory) mkdirSync(dirname(location), { recursive: true });
  const conn = new DatabaseSync(location);
  conn.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))}`);
  if (!isMemory) conn.exec("PRAGMA journal_mode = WAL");
  conn.exec("PRAGMA foreign_keys = ON");
  conn.exec("PRAGMA synchronous = NORMAL");
  return new SqliteDatabase(conn, location);
}
