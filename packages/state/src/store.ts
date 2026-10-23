import { type Clock, ForerunnerError, systemClock } from "@forerunner/platform";
import { openPostgres, type PostgresOptions } from "./db/postgres.ts";
import { openSqlite, type SqliteOptions } from "./db/sqlite.ts";
import type { Database, Dialect } from "./db/types.ts";
import { type MigrateResult, migrate } from "./migrations/index.ts";
import { createRepos, type Repos } from "./repos/index.ts";

export interface OpenStoreOptions {
  /** "sqlite::memory:" | "sqlite:<path>" | "postgres://..." | "postgresql://...". */
  url: string;
  clock?: Clock;
  /** Postgres only: schema to use (created if missing). */
  schema?: string;
  /** Run pending migrations on open. Default true. */
  migrate?: boolean;
  postgres?: Omit<PostgresOptions, "schema">;
  sqlite?: SqliteOptions;
}

export interface StateStore extends Repos {
  readonly db: Database;
  readonly clock: Clock;
  readonly dialect: Dialect;
  /** Result of the migration run at open (applied: [] when nothing was pending). */
  readonly migration: MigrateResult | undefined;
  /** Run `fn` with every repository bound to one transaction. */
  transaction<T>(fn: (tx: StateStore) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type ParsedStoreUrl =
  | { dialect: "sqlite"; location: string }
  | { dialect: "postgres"; url: string };

export function parseStoreUrl(url: string): ParsedStoreUrl {
  if (url === "sqlite::memory:" || url === "sqlite:memory:")
    return { dialect: "sqlite", location: ":memory:" };
  if (url.startsWith("sqlite:")) {
    const location = url.slice("sqlite:".length);
    if (!location) throw new ForerunnerError("validation", "sqlite url needs a path or :memory:");
    return { dialect: "sqlite", location };
  }
  if (/^postgres(ql)?:\/\//.test(url)) return { dialect: "postgres", url };
  throw new ForerunnerError("validation", "store url must start with sqlite: or postgres://", {
    details: { url: url.replace(/\/\/[^@]*@/, "//[REDACTED]@") },
  });
}

function buildStore(
  db: Database,
  clock: Clock,
  migration: MigrateResult | undefined,
  closer: () => Promise<void>,
): StateStore {
  const repos = createRepos(db, clock);
  return {
    ...repos,
    db,
    clock,
    dialect: db.dialect,
    migration,
    transaction<T>(fn: (tx: StateStore) => Promise<T>): Promise<T> {
      return db.transaction((tx) =>
        fn(
          buildStore(tx, clock, migration, async () => {
            throw new ForerunnerError("not_supported", "close() inside a transaction");
          }),
        ),
      );
    },
    close: closer,
  };
}

/** The same database with every repository bound to another Clock (tests, simulations). */
export function rebindStore(store: StateStore, clock: Clock): StateStore {
  return buildStore(store.db, clock, store.migration, () => store.close());
}

/** Open a state store, run migrations and return every repository on one object. */
export async function openStore(opts: OpenStoreOptions): Promise<StateStore> {
  const clock = opts.clock ?? systemClock;
  const parsed = parseStoreUrl(opts.url);
  const db: Database =
    parsed.dialect === "sqlite"
      ? await openSqlite(parsed.location, opts.sqlite ?? {})
      : await openPostgres(parsed.url, {
          ...(opts.postgres ?? {}),
          ...(opts.schema ? { schema: opts.schema } : {}),
        });
  try {
    const migration = opts.migrate === false ? undefined : await migrate(db, { clock });
    return buildStore(db, clock, migration, () => db.close());
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
}
