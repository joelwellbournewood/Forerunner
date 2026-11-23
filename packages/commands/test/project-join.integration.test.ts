import { randomBytes } from "node:crypto";
import { openStore, type StateStore } from "@forerunner/state";
import { afterAll, describe, expect, it } from "vitest";
import type { ExecuteResult } from "../src/executor.ts";
import { type World, world } from "./helpers.ts";
import { counts, join, joinPort, seedPair } from "./join-world.ts";

/**
 * L4-github-121 (l4-github-merge, run L4): Make one project on the Postgres adapter. The same
 * pair as OJ-02's SQLite case (`project-join.test.ts`) is joined and the join undone on SQLite
 * and on Postgres, and every table's rows of both projects are counted before, after the join
 * and after its Undo: Postgres leaves the same counts as SQLite at each step. Needs
 * FORERUNNER_TEST_PG (CI's postgres:16 service, ci.yml); without it the file is skipped with the
 * reason in its name. One schema per run, dropped at the end.
 */
const PG = process.env.FORERUNNER_TEST_PG;
const schema = `fr_join_test_${randomBytes(4).toString("hex")}`;

type Counts = { site: Record<string, number>; kite: Record<string, number> };

/** OJ-02's journey on one store: seed, join keeping Site, a card since, Undo. */
async function walk(w: World): Promise<{
  before: Counts;
  after: Counts;
  back: Counts;
  joined: string;
  undone: string;
  closed: { status: string; repos: string[]; into: unknown; wasLinked: unknown };
  reopened: { status: string; repos: string[]; into: unknown };
  asset: string[];
  sinceBack: boolean;
}> {
  w.ports.projectJoin = joinPort(w);
  const { site, kite, ids } = await seedPair(w);
  const snap = async (): Promise<Counts> => ({
    site: await counts(w.store, site.id),
    kite: await counts(w.store, kite.id),
  });
  const before = await snap();
  const r = await join(w, site.id, [kite.id]);
  expect(r.status, JSON.stringify(r)).toBe("done");
  const done = r as Extract<ExecuteResult, { status: "done" }>;
  const after = await snap();
  const closedRow = await w.store.project.mustGet(kite.id);
  // A card made on Site since for a moved task goes back with it.
  const since = await w.store.humanRequest.insert({
    project_id: site.id,
    task_id: ids.signup,
    kind: "decision",
    why: "Email or phone?",
    status: "open",
  });
  const u = await w.executor.undo(done.changeLogId, w.ctx({ source: "ui" }));
  expect(u.status, JSON.stringify(u)).toBe("done");
  const back = await snap();
  const reopenedRow = await w.store.project.mustGet(kite.id);
  return {
    before,
    after,
    back,
    joined: done.sentence,
    undone: (u as Extract<ExecuteResult, { status: "done" }>).sentence,
    closed: {
      status: closedRow.status,
      repos: closedRow.repos,
      into: (closedRow.settings.joined_into as { name?: string } | undefined)?.name,
      wasLinked: closedRow.settings.was_linked,
    },
    reopened: {
      status: reopenedRow.status,
      repos: reopenedRow.repos,
      into: reopenedRow.settings.joined_into,
    },
    asset: (await w.store.dataAsset.mustGet(ids.asset)).project_ids,
    sinceBack: (await w.store.humanRequest.mustGet(since.id)).project_id === kite.id,
  };
}

let pg: StateStore | undefined;

describe.skipIf(!PG)(
  PG
    ? "l4-github-merge, run L4: project.join on Postgres (L4-github-121)"
    : "l4-github-merge, run L4: project.join on Postgres (L4-github-121; skipped: FORERUNNER_TEST_PG not set)",
  () => {
    afterAll(async () => {
      if (!pg) return;
      await pg.db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pg.close();
    });

    it("Make one project and its Undo leave the same rows per table on Postgres as on SQLite: Kite club's work moves into Site in one change, its history stays, and Undo puts every row back", async () => {
      const lite = await world();
      const onLite = await walk(lite);
      await lite.store.close();
      const onPg = await walk(
        await world({
          store: async (clock) => {
            pg = await openStore({ url: PG as string, schema, clock });
            return pg;
          },
        }),
      );
      // Postgres leaves SQLite's counts at every step.
      expect(onPg.before).toEqual(onLite.before);
      expect(onPg.after).toEqual(onLite.after);
      expect(onPg.back).toEqual(onLite.back);
      // What OJ-02 pins on SQLite, read on Postgres: 5 tasks, 2 milestones, the 2 cards about
      // tasks and the open project card, 1 queued note, 1 merge record, 1 decision and 1 accepted
      // proposal move; sessions, ledger, chat and lessons stay; the asset lists both.
      const moved = {
        task: 5,
        milestone: 2,
        human_request: 3,
        queue_item: 1,
        merge_record: 1,
        decision: 1,
        source_candidate: 1,
      };
      for (const [t, n] of Object.entries(moved)) {
        expect(onPg.after.site[t], t).toBe((onPg.before.site[t] ?? 0) + n);
        expect(onPg.after.kite[t], t).toBe((onPg.before.kite[t] ?? 0) - n);
      }
      for (const t of ["session", "cost_ledger", "message", "lesson"]) {
        expect(onPg.after.kite[t], t).toBe(onPg.before.kite[t]);
        expect(onPg.after.site[t], t).toBe(onPg.before.site[t]);
      }
      expect(onPg.after.site.data_asset).toBe(1);
      expect(onPg.after.kite.data_asset).toBe(1);
      // The person's sentences, the closed project's row and the Undo, as on SQLite.
      expect(onPg.joined).toBe('Made one project: "Kite club" joined "Site".');
      expect(onPg.undone).toBe('"Kite club" is its own project again.');
      expect(onPg.closed).toEqual({
        status: "archived",
        repos: [],
        into: "Site",
        wasLinked: ["https://github.com/O/site.git"],
      });
      expect(onPg.reopened).toEqual({
        status: "active",
        repos: ["https://github.com/O/site.git"],
        into: undefined,
      });
      expect(onPg.back.site).toEqual({
        ...onPg.before.site,
        change_log: onPg.back.site.change_log,
      });
      expect(onPg.back.kite).toEqual({
        ...onPg.before.kite,
        human_request: (onPg.before.kite.human_request ?? 0) + 1,
      });
      expect(onPg.sinceBack).toBe(true);
      expect(onPg.asset).toHaveLength(1);
      // Everything above held on SQLite too, so the two adapters agree on the whole journey.
      expect({ ...onPg, asset: onPg.asset.length }).toEqual({
        ...onLite,
        asset: onLite.asset.length,
      });
    });
  },
);
