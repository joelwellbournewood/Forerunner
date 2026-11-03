import { systemClock } from "@forerunner/platform/clock";
import { TestRunner } from "vitest";

/**
 * Waiting on work a test started (docs/maintainers/testing.md, "Waiting on work a case started").
 *
 * On c8c16fb a case on the Windows runner waited a fixed 30 s for a session that was still taking
 * a step every 2 to 4 s, gave up, and its file's `afterAll` closed the runtime under the session
 * ("sqlite database is closed"). About 20 test files had the same local helper: a fixed limit, a
 * message that said little, and nothing stopped when it gave up. This is the one helper they use
 * now. It:
 *
 * - waits while what it watches still changes (`progress`, by default `seen`), and gives up only
 *   when nothing changed for `quietMs` (45 s: the longest quiet spell seen on a loaded Windows
 *   runner was a 16 s session start) or the wait ran past its limit;
 * - takes its limit from the running case: the case's own timeout less a reserve (a quarter of
 *   it, at most 20 s), so the wait gives up, stops what the case started and says what it saw
 *   before vitest's timeout ends the case with none of that ("Test timed out in 20000ms");
 * - calls `stop` before it throws, so nothing the case started runs into the next case or into
 *   the runtime's close;
 * - throws a `WaitTimeout` whose message names what it waited for, why it gave up, whether the
 *   stop worked and what it saw last.
 *
 * Polls on real timers and the system clock, never a simulated one: what the case waits for is
 * real work in this process (a session, a run, a daemon's answer).
 */

/** No change in what a wait watches for this long: it is stuck, however loaded the machine. */
export const QUIET_MS = 45_000;
/** A wait outside a test case (a hook) gives up after this when it names no limit. */
export const OUTSIDE_CASE_LIMIT_MS = 45_000;

export interface WaitOptions {
  /**
   * What the wait saw, for its failure message, read again when it gives up. A string is used
   * as written; anything else as JSON.
   */
  seen?: () => unknown;
  /**
   * What moves while the awaited work goes on (a session's row and log, a store's rows, a
   * controller's state). The wait goes on as long as it changes. Default: `seen`.
   */
  progress?: () => unknown;
  /**
   * Stop what the case started and wait until none of it runs. Called once, with the reason,
   * before the wait throws; its own failure is named in the message.
   */
  stop?: (why: string) => unknown;
  /** Give up when `progress` did not change for this long. Default `QUIET_MS`. */
  quietMs?: number;
  /**
   * Give up after this long in total, however much still moves. Always capped below the running
   * case's own timeout; outside a case the default is `OUTSIDE_CASE_LIMIT_MS`.
   */
  limitMs?: number;
  /**
   * How much of the running case's time the wait leaves for the stop and the message. Default: a
   * quarter of the case's timeout, between 1 and 20 s. A wait that is itself part of a stop
   * (waiting until what it stopped has ended) leaves less.
   */
  reserveMs?: number;
  /** Poll interval. Default 25 ms. */
  everyMs?: number;
  /**
   * False for a wait that is part of a stop (until what was stopped has ended): the forced
   * give-up of `FORERUNNER_TEST_WAIT_GIVE_UP_MS` does not apply to it.
   */
  forceable?: boolean;
}

/**
 * `FORERUNNER_TEST_WAIT_GIVE_UP_MS`: every wait gives up after that long (its quiet window and
 * its limit), to check the give-up path of every wait in a file: each one that does not hold at
 * once stops what its case started and fails with what it saw (testing.md).
 */
export function forcedGiveUpMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const ms = Number(env.FORERUNNER_TEST_WAIT_GIVE_UP_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** The error a wait throws when it gives up. */
export class WaitTimeout extends Error {
  constructor(
    /** What was waited for. */
    readonly what: string,
    /** Why the wait gave up, in words. */
    readonly why: string,
    /** What the wait saw last. */
    readonly seen: string,
    /** What became of the stop: "stopped what the case started", its failure, or null (none). */
    readonly stopped: string | null,
  ) {
    super(`timed out waiting for ${what} (${why}${stopped ? `; ${stopped}` : ""}): saw ${seen}`);
    this.name = "WaitTimeout";
  }
}

/** When the running case's timeout ends it, and that timeout; undefined outside a case. */
export function caseDeadline(): { at: number; timeoutMs: number } | undefined {
  const test = TestRunner.getCurrentTest();
  const started = test?.result?.startTime;
  const timeoutMs = test?.timeout;
  if (!test || typeof started !== "number" || !timeoutMs || !Number.isFinite(timeoutMs))
    return undefined;
  return { at: started + timeoutMs, timeoutMs };
}

/**
 * How long a wait that starts now may last: `limitMs` (or, outside a case, the default), capped
 * so it ends a reserve before the running case's timeout (by default a quarter of it, between 1
 * and 20 s): the reserve is the stop's and the message's.
 */
export function waitLimit(limitMs?: number, now = systemClock.now(), reserveMs?: number): number {
  const deadline = caseDeadline();
  const asked = limitMs ?? (deadline ? Number.POSITIVE_INFINITY : OUTSIDE_CASE_LIMIT_MS);
  if (!deadline) return asked;
  const reserve = reserveMs ?? Math.min(20_000, Math.max(1_000, deadline.timeoutMs / 4));
  return Math.max(0, Math.min(asked, deadline.at - reserve - now));
}

/** A value as one line for a message: strings as written, anything else as JSON. */
export function asLine(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "nothing";
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

const secondsOf = (ms: number) =>
  ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;

/** Read `fn`, turning its failure into words: what a message says when a read itself failed. */
async function read(fn: (() => unknown) | undefined): Promise<unknown> {
  if (!fn) return undefined;
  try {
    return await fn();
  } catch (e) {
    return `(could not read: ${e instanceof Error ? e.message : String(e)})`;
  }
}

/**
 * Poll `probe` until it gives a value (anything but `undefined`), while what the wait watches
 * still moves. See the file's comment for when it gives up and what it does then.
 */
export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  opts: WaitOptions = {},
): Promise<T> {
  const forced = opts.forceable === false ? undefined : forcedGiveUpMs();
  const quietMs = forced ?? opts.quietMs ?? QUIET_MS;
  const everyMs = opts.everyMs ?? 25;
  const started = systemClock.now();
  const limit = waitLimit(forced ?? opts.limitMs, started, opts.reserveMs);
  const watch = opts.progress ?? opts.seen;
  let last: string | undefined;
  let movedAt = started;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    const now = systemClock.now();
    const at = asLine(await read(watch));
    if (at !== last) {
      last = at;
      movedAt = now;
    }
    const why =
      watch && now - movedAt >= quietMs
        ? `nothing it watches changed for ${secondsOf(now - movedAt)}`
        : now - started >= limit
          ? `it was still waiting after ${secondsOf(now - started)}${
              watch ? `, the last change ${secondsOf(now - movedAt)} before` : ""
            }`
          : null;
    if (why) {
      const seen = asLine(await read(opts.seen ?? opts.progress));
      let stopped: string | null = null;
      if (opts.stop) {
        try {
          await opts.stop(why);
          stopped = "stopped what the case started";
        } catch (e) {
          stopped = `stopping what the case started failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      throw new WaitTimeout(what, why, seen, stopped);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** `waitFor` for a condition: resolves once `cond` holds. */
export async function until(
  what: string,
  cond: () => boolean | Promise<boolean>,
  opts: WaitOptions = {},
): Promise<void> {
  await waitFor(what, async () => ((await cond()) ? true : undefined), opts);
}

/** The part of a state store a fingerprint reads (`StateStore` from `@forerunner/state`). */
export interface QueryableStore {
  readonly dialect: string;
  readonly db: {
    query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  };
}

const versionedTables = new WeakMap<object, Promise<string[]>>();

/**
 * Every table of the store with its row count and the sum of its rows' versions: it changes
 * whenever anything writes a row (a session's step, an event, a run, a task's move, a card).
 * The `progress` of a wait on work that writes to the store. The tables are read from the
 * database once per store (every table with a `version` column; SQLite and Postgres).
 */
export async function storeProgress(store: QueryableStore): Promise<string> {
  let tables = versionedTables.get(store.db);
  if (!tables) {
    const sql =
      store.dialect === "postgres"
        ? `SELECT table_name AS name FROM information_schema.columns
           WHERE table_schema = current_schema() AND column_name = 'version' ORDER BY table_name`
        : `SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) p
           WHERE m.type = 'table' AND p.name = 'version' ORDER BY m.name`;
    tables = store.db
      .query<{ name: string }>(sql)
      .then((rows) => rows.map((r) => String(r.name)).filter((n) => /^[a-z_][a-z0-9_]*$/.test(n)));
    versionedTables.set(store.db, tables);
  }
  const names = await tables;
  if (names.length === 0) return "";
  const rows = await store.db.query<{ t: string; n: unknown; v: unknown }>(
    names
      .map((t) => `SELECT '${t}' AS t, COUNT(*) AS n, COALESCE(SUM("version"), 0) AS v FROM "${t}"`)
      .join(" UNION ALL "),
  );
  return rows.map((r) => `${r.t}:${Number(r.n)}:${Number(r.v)}`).join(" ");
}
