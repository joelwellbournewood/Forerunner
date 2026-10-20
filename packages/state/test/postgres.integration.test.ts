import { randomBytes } from "node:crypto";
import { SimulatedClock } from "@forerunner/platform";
import { afterAll, beforeAll, describe } from "vitest";
import { ENTITIES } from "../src/schema.ts";
import { openStore, rebindStore, type StateStore } from "../src/store.ts";
import { defineStateSuite } from "./suite.ts";

/**
 * Runs the conformance suite against Postgres. Needs FORERUNNER_TEST_PG; without it the
 * whole file is skipped with the reason in the suite name. One schema per run, dropped at
 * the end; tables are truncated between tests.
 */
const PG = process.env.FORERUNNER_TEST_PG;
const schema = `fr_state_test_${randomBytes(4).toString("hex")}`;
const tables = Object.values(ENTITIES)
  .filter((e) => e.envelope)
  .map((e) => `"${e.table}"`)
  .join(", ");

let shared: StateStore | undefined;

describe.skipIf(!PG)(
  PG ? "postgres adapter" : "postgres adapter (skipped: FORERUNNER_TEST_PG not set)",
  () => {
    beforeAll(async () => {
      shared = await openStore({ url: PG as string, schema, clock: new SimulatedClock() });
    });

    afterAll(async () => {
      if (!shared) return;
      await shared.db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await shared.close();
    });

    defineStateSuite({
      name: `postgres schema ${schema}`,
      fresh: async (clock) => {
        if (!shared) throw new Error("store not opened");
        await shared.db.exec(`TRUNCATE ${tables} CASCADE`);
        const bound = rebindStore(shared, clock);
        return { ...bound, close: async () => undefined };
      },
    });
  },
);
