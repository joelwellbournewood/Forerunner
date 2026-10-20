import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import { openSqlite, silenceSqliteExperimentalWarning } from "../src/db/sqlite.ts";
import { MIGRATIONS } from "../src/migrations/index.ts";
import { openStore } from "../src/store.ts";

const tmp = mkdtempSync(join(os.tmpdir(), "fr-state-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("sqlite adapter", () => {
  it("opens a file database in WAL mode with foreign keys, creating the directory", async () => {
    const file = join(tmp, "nested", "dir", "state.db");
    const db = await openSqlite(file);
    try {
      expect(await db.query("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
      expect(await db.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
      expect(readdirSync(join(tmp, "nested", "dir"))).toContain("state.db");
    } finally {
      await db.close();
    }
    const store = await openStore({ url: `sqlite:${file}` });
    expect(store.migration?.applied).toEqual(MIGRATIONS.map((m) => m.version));
    await store.close();
    const reopened = await openStore({ url: `sqlite:${file}` });
    expect(reopened.migration?.applied).toEqual([]);
    await reopened.close();
  });

  it("encodes booleans, undefined, Dates and objects for binding and returns plain objects", async () => {
    const db = await openSqlite(":memory:");
    try {
      await db.exec('CREATE TABLE t ("b" INTEGER, "n" TEXT, "d" TEXT, "o" TEXT)');
      await db.query("INSERT INTO t VALUES (?, ?, ?, ?)", [
        true,
        undefined,
        new Date("2026-01-01T00:00:00Z"),
        { a: 1 },
      ]);
      const [row] = await db.query<{ b: number; n: null; d: string; o: string }>("SELECT * FROM t");
      expect(row).toEqual({ b: 1, n: null, d: "2026-01-01T00:00:00.000Z", o: '{"a":1}' });
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    } finally {
      await db.close();
    }
  });

  it("serialises concurrent callers: an outside query never sees a half-finished transaction", async () => {
    const db = await openSqlite(":memory:");
    try {
      await db.exec('CREATE TABLE t ("id" INTEGER)');
      const observed: number[] = [];
      const tx = db.transaction(async (h) => {
        await h.query("INSERT INTO t VALUES (1)");
        await new Promise((r) => setImmediate(r));
        await h.query("INSERT INTO t VALUES (2)");
      });
      const outside = (async () => {
        const [row] = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM t");
        observed.push(row?.n ?? -1);
      })();
      await Promise.all([tx, outside]);
      expect([0, 2]).toContain(observed[0]);
      expect(db.inTransaction).toBe(false);
      const writes = Array.from({ length: 25 }, (_, i) =>
        db.query("INSERT INTO t VALUES (?)", [100 + i]),
      );
      await Promise.all(writes);
      expect((await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM t"))[0]?.n).toBe(27);
    } finally {
      await db.close();
    }
  });

  it("rolls back on error, supports nested savepoints, and routes root queries into the open transaction", async () => {
    const db = await openSqlite(":memory:");
    try {
      await db.exec('CREATE TABLE t ("id" TEXT PRIMARY KEY)');
      await expect(
        db.transaction(async (h) => {
          await h.query("INSERT INTO t VALUES ('a')");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await db.query("SELECT * FROM t")).toEqual([]);
      await db.transaction(async (h) => {
        expect(h.inTransaction).toBe(true);
        await h.query("INSERT INTO t VALUES ('outer')");
        await db.query("INSERT INTO t VALUES ('via-root')");
        await expect(
          h.transaction(async (inner) => {
            await inner.query("INSERT INTO t VALUES ('inner')");
            await inner.transaction(async (deeper) => {
              await deeper.query("INSERT INTO t VALUES ('deeper')");
            });
            throw new Error("inner");
          }),
        ).rejects.toThrow("inner");
        expect(
          (await h.query<{ id: string }>("SELECT id FROM t ORDER BY id")).map((r) => r.id),
        ).toEqual(["outer", "via-root"]);
        await expect(h.close()).rejects.toThrow(/not allowed/);
      });
      expect(
        (await db.query<{ id: string }>("SELECT id FROM t ORDER BY id")).map((r) => r.id),
      ).toEqual(["outer", "via-root"]);
      await expect(db.query("INSERT INTO t VALUES ('outer')")).rejects.toThrow(/UNIQUE/);
    } finally {
      await db.close();
    }
  });

  it("rejects work after close and closes idempotently", async () => {
    const db = await openSqlite(":memory:");
    await db.close();
    await db.close();
    await expect(db.query("SELECT 1")).rejects.toThrow(/closed/);
    await expect(db.exec("SELECT 1")).rejects.toThrow(/closed/);
  });

  it("filters only the SQLite ExperimentalWarning and lets other warnings through", async () => {
    silenceSqliteExperimentalWarning();
    const seen: string[] = [];
    const listener = (w: Error) => {
      seen.push(`${w.name}:${w.message}`);
    };
    process.on("warning", listener);
    try {
      process.emitWarning(
        "SQLite is an experimental feature and might change at any time",
        "ExperimentalWarning",
      );
      process.emitWarning("something else", "ExperimentalWarning");
      process.emitWarning("plain warning");
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off("warning", listener);
    }
    expect(seen).toEqual(["ExperimentalWarning:something else", "Warning:plain warning"]);
  });
});
