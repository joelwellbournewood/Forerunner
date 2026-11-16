import { randomBytes } from "node:crypto";
import { SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { openPostgres } from "../src/db/postgres.ts";
import { MIGRATION_0001 } from "../src/migrations/0001-initial.ts";
import { appliedVersions, MIGRATIONS, migrate } from "../src/migrations/index.ts";
import { createRepos } from "../src/repos/index.ts";

/**
 * Forward migration on Postgres: a database left at v1 (with rows) is migrated to the current
 * version and the old rows read back with the v2 defaults. Needs FORERUNNER_TEST_PG; skipped
 * visibly otherwise. One throw-away schema per run.
 */
const PG = process.env.FORERUNNER_TEST_PG;

describe.skipIf(!PG)(
  PG
    ? "postgres forward migration"
    : "postgres forward migration (skipped: FORERUNNER_TEST_PG not set)",
  () => {
    it("migrates a v1 database to the current version and keeps old rows readable", async () => {
      const schema = `fr_migrate_test_${randomBytes(4).toString("hex")}`;
      const db = await openPostgres(PG as string, { schema });
      try {
        const clock = new SimulatedClock("2026-10-20T10:00:00.000Z");
        const at = clock.nowIso();
        expect(await migrate(db, { clock, migrations: [MIGRATION_0001] })).toEqual({
          applied: [1],
          version: 1,
        });
        await db.query(
          `INSERT INTO "human" ("id", "created_at", "updated_at", "name", "email") VALUES (?, ?, ?, ?, ?)`,
          ["h1", at, at, "Ada", "ada@example.test"],
        );
        await db.query(
          `INSERT INTO "agent" ("id", "created_at", "updated_at", "name", "owner_human_id") VALUES (?, ?, ?, ?, ?)`,
          ["a1", at, at, "Alice", "h1"],
        );
        await db.query(
          `INSERT INTO "session" ("id", "created_at", "updated_at", "agent_id") VALUES (?, ?, ?, ?)`,
          ["s1", at, at, "a1"],
        );
        await db.query(
          `INSERT INTO "run" ("id", "created_at", "updated_at", "session_id", "specialist", "model", "tokens_before_compression", "tokens_after_compression") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ["r1", at, at, "s1", "coder", "claude-sonnet-4-5", 5000, 2000],
        );

        const forward = await migrate(db, { clock });
        // Every shipped migration applies on a v1 database: 0002 (headroom), 0003 (sources),
        // 0004 (shared secrets), 0005 (change reasons), 0006 (merge records), 0007 (take out),
        // 0008 (rebuild owed), 0009 (the change log's 'session' source), 0010 (each task's figure
        // counts its reviews, data only).
        expect(forward.applied).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(await appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        // Idempotent: ADD COLUMN IF NOT EXISTS makes a re-run of the statements harmless too.
        expect(await migrate(db, { clock })).toEqual({ applied: [], version: 10 });

        const repos = createRepos(db, clock);
        const run = await repos.run.mustGet("r1");
        expect(run.tokens_before_compression).toBe(5000);
        expect(run.context_transforms).toEqual([]);
        expect(run.headroom_used).toBe(false);
        expect((await repos.session.mustGet("s1")).headroom_saved_tokens).toBe(0);
        // The v5 column reads back empty on a row from before it.
        expect((await repos.session.mustGet("s1")).reason).toBe("");
        const patched = await repos.run.patch("r1", {
          context_transforms: ["logs", "dedup-cross"],
          headroom_used: true,
        });
        expect(patched.context_transforms).toEqual(["logs", "dedup-cross"]);
        expect(patched.headroom_used).toBe(true);
        expect(
          (await repos.session.patch("s1", { headroom_saved_tokens: 42 })).headroom_saved_tokens,
        ).toBe(42);
      } finally {
        await db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.close();
      }
    });

    // d1109-selftasks-run, run C (ST-5, ADR 0119): v9 drops and re-adds the change log's source
    // constraint with 'session'; every row of every source written before stays.
    it("d1109-selftasks-run, run C: migrates a v8 change_log with a row of every source and accepts 'session' (ST-5)", async () => {
      const schema = `fr_migrate_test_${randomBytes(4).toString("hex")}`;
      const db = await openPostgres(PG as string, { schema });
      try {
        const clock = new SimulatedClock("2026-11-16T10:00:00.000Z");
        const at = clock.nowIso();
        const v8 = MIGRATIONS.filter((m) => m.version <= 8);
        expect((await migrate(db, { clock, migrations: v8 })).version).toBe(8);
        await expect(
          db.query(
            `INSERT INTO "change_log" ("id", "created_at", "updated_at", "source") VALUES (?, ?, ?, ?)`,
            ["x0", at, at, "session"],
          ),
        ).rejects.toThrow();
        const sources = ["ui", "chat", "voice", "email", "api", "palette"];
        for (const [i, source] of sources.entries())
          await db.query(
            `INSERT INTO "change_log" ("id", "created_at", "updated_at", "human_id", "words_used", "commands", "undo_state", "source", "sentence") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              `c${i}`,
              at,
              at,
              "h1",
              `words ${source}`,
              `[{"name":"task.update"}]`,
              i % 2 ? "undone" : "undoable",
              source,
              `Renamed task ${i}.`,
            ],
          );
        expect(await migrate(db, { clock })).toEqual({ applied: [9, 10], version: 10 });
        const repos = createRepos(db, clock);
        for (const [i, source] of sources.entries())
          expect(await repos.changeLog.mustGet(`c${i}`)).toMatchObject({
            source,
            words_used: `words ${source}`,
            commands: [{ name: "task.update" }],
            undo_state: i % 2 ? "undone" : "undoable",
            sentence: `Renamed task ${i}.`,
          });
        const made = await repos.changeLog.record({
          human_id: "h1",
          agent_id: "a1",
          words_used: "",
          commands: [{ name: "task.split", params: {} }],
          before: {},
          after: {},
          scope: "project",
          project_id: null,
          expires_at: null,
          undo_state: "undoable",
          source: "session",
          sentence: 'Split "Style the page" into "Style the layout" and "Style the colours".',
          author_human: null,
          author_agent: "a1",
        });
        expect((await repos.changeLog.mustGet(made.id)).source).toBe("session");
        await expect(
          db.query(
            `INSERT INTO "change_log" ("id", "created_at", "updated_at", "source") VALUES (?, ?, ?, ?)`,
            ["x1", at, at, "model"],
          ),
        ).rejects.toThrow();
      } finally {
        await db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.close();
      }
    });

    // d1116-budget-all, run C (BA-2): v10 sets each task's figure to the larger of itself and the
    // ledger's sum for its task id (GREATEST on Postgres), data only and idempotent.
    it("d1116-budget-all, run C: migrates a v9 database so each task's figure counts its reviews (BA-2)", async () => {
      const schema = `fr_migrate_test_${randomBytes(4).toString("hex")}`;
      const db = await openPostgres(PG as string, { schema });
      try {
        const clock = new SimulatedClock("2026-11-16T10:00:00.000Z");
        const at = clock.nowIso();
        const v9 = MIGRATIONS.filter((m) => m.version <= 9);
        expect((await migrate(db, { clock, migrations: v9 })).version).toBe(9);
        await db.query(
          `INSERT INTO "project" ("id", "created_at", "updated_at", "name") VALUES (?, ?, ?, ?)`,
          ["p1", at, at, "Club site"],
        );
        const task = (id: string, actual: number, version: number) =>
          db.query(
            `INSERT INTO "task" ("id", "created_at", "updated_at", "version", "project_id", "title", "status", "actual_cost_usd_micro") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, at, "2026-11-10T08:00:00.000Z", version, "p1", `Task ${id}`, "done", actual],
          );
        const ledger = (id: string, taskId: string, usd: number) =>
          db.query(
            `INSERT INTO "cost_ledger" ("id", "created_at", "updated_at", "human_id", "task_id", "kind", "usd_micro", "model", "occurred_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, at, at, "h1", taskId, "api", usd, "claude-sonnet-5-5", at],
          );
        await task("tA", 300_000, 4);
        await ledger("l1", "tA", 300_000);
        await ledger("l2", "tA", 150_000);
        await task("tB", 120_000, 2);
        await ledger("l3", "tB", 120_000);
        await task("tC", 70_000, 3);
        expect(await migrate(db, { clock })).toEqual({ applied: [10], version: 10 });
        const repos = createRepos(db, clock);
        const read = async () =>
          Promise.all(
            ["tA", "tB", "tC"].map(async (id) => {
              const t = await repos.task.mustGet(id);
              return [t.actual_cost_usd_micro, t.version, t.updated_at];
            }),
          );
        const after = await read();
        expect(after).toEqual([
          [450_000, 4, "2026-11-10T08:00:00.000Z"],
          [120_000, 2, "2026-11-10T08:00:00.000Z"],
          [70_000, 3, "2026-11-10T08:00:00.000Z"],
        ]);
        for (const sql of MIGRATIONS[9]?.up.postgres ?? []) await db.exec(sql);
        expect(await read()).toEqual(after);
      } finally {
        await db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.close();
      }
    });
  },
);
