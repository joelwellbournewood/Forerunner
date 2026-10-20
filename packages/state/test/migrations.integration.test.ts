import { randomBytes } from "node:crypto";
import { SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { openPostgres } from "../src/db/postgres.ts";
import { MIGRATION_0001 } from "../src/migrations/0001-initial.ts";
import { appliedVersions, migrate } from "../src/migrations/index.ts";
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
        expect(forward.applied).toEqual([2]);
        expect(await appliedVersions(db)).toEqual([1, 2]);
        // Idempotent: ADD COLUMN IF NOT EXISTS makes a re-run of the statements harmless too.
        expect(await migrate(db, { clock })).toEqual({ applied: [], version: 2 });

        const repos = createRepos(db, clock);
        const run = await repos.run.mustGet("r1");
        expect(run.tokens_before_compression).toBe(5000);
        expect(run.context_transforms).toEqual([]);
        expect(run.headroom_used).toBe(false);
        expect((await repos.session.mustGet("s1")).headroom_saved_tokens).toBe(0);
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
  },
);
