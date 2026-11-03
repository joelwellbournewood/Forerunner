import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENTITIES, openStore } from "../../packages/state/src/index.ts";
import { storeProgress } from "../src/wait.ts";

/**
 * `storeProgress` on Postgres (testing.md, "Waiting on work a case started"): the tables are read
 * from Postgres's catalogue in the store's own schema, so a wait on a Postgres-backed runtime
 * sees its rows move as it does on SQLite. Needs FORERUNNER_TEST_PG; skipped with the reason
 * without it. One schema per run, dropped at the end.
 */
const PG = process.env.FORERUNNER_TEST_PG;

describe.skipIf(!PG)(
  PG
    ? "storeProgress on Postgres"
    : "storeProgress on Postgres (skipped: FORERUNNER_TEST_PG not set)",
  () => {
    it("lists every versioned table of the store's schema and changes when a row is written or updated", async () => {
      const schema = `fr_wait_test_${randomBytes(4).toString("hex")}`;
      const store = await openStore({ url: PG as string, schema });
      try {
        const a = await storeProgress(store);
        const tables = a.split(" ").map((t) => t.split(":")[0]);
        // Every record table (and the migrations' bookkeeping, which also has a `version`).
        expect(tables).toEqual(
          [
            ...Object.values(ENTITIES)
              .filter((e) => e.envelope)
              .map((e) => e.table),
            "schema_migrations",
          ].sort(),
        );
        expect(a).toMatch(/\bsession:0:0\b/);
        expect(await storeProgress(store)).toBe(a);
        const human = await store.human.insert({ name: "J", email: "j@example.test" });
        const b = await storeProgress(store);
        expect(b).not.toBe(a);
        await store.human.update(human.id, human.version, { name: "Jo" });
        expect(await storeProgress(store)).not.toBe(b);
      } finally {
        await store.db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await store.close();
      }
    });
  },
);
