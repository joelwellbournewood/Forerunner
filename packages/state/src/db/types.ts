/**
 * The one database interface both adapters implement. SQL is written once with `?`
 * placeholders; the Postgres adapter rewrites them to `$1..$n`. Rows come back as plain
 * objects keyed by column name. Type decoding (booleans, JSON, numbers) is done by the
 * repository layer from the declarative schema, so callers never see dialect differences.
 */
export type Dialect = "sqlite" | "postgres";

export type Row = Record<string, unknown>;

export interface Database {
  readonly dialect: Dialect;
  /** Run one statement with positional `?` parameters and return its rows (empty for writes without RETURNING). */
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run one or more statements without parameters (DDL, pragmas). */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` inside a transaction. The `tx` handle shares the connection; a nested call
   * opens a SAVEPOINT. Queries issued on the parent handle from inside `fn` (same async
   * context) are routed to the transaction too, so repositories bound to the root handle
   * take part in it without deadlocking.
   */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  /** True while this handle is inside a transaction. */
  readonly inTransaction: boolean;
  close(): Promise<void>;
}
