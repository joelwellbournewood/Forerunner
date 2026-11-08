import type { Migration } from "./types.ts";

/**
 * leftovers7-merge2 (ADR 0111, R-owed): a dependent branch's rebuild that could not run (its
 * task folder was busy or held changes nobody committed, or a step failed) was remembered only
 * in the daemon's memory, so after a restart a dependency squash-merged or closed meanwhile was
 * never taken out of the dependent's pull request. The dependent's merge record now keeps the
 * task whose change its branch has not followed yet (`rebuild_owed_for`): the watcher's sweep
 * tries the rebuild again at every poll, after a restart too, and nothing merges the pull
 * request while it is set. Rows written before v8 read back with null: nothing owed. Written by
 * hand and frozen; schema.test.ts proves that v1 to v8 equals the generator's output for the
 * current schema.
 */
export const MIGRATION_0008: Migration = {
  version: 8,
  name: "rebuild-owed",
  up: {
    sqlite: [`ALTER TABLE "merge_record" ADD COLUMN "rebuild_owed_for" TEXT`],
    postgres: [`ALTER TABLE "merge_record" ADD COLUMN IF NOT EXISTS "rebuild_owed_for" TEXT`],
  },
};
