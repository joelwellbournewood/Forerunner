import type { Migration } from "./types.ts";

/**
 * merged-actions (the owner's decision of 2026-11-02, "Take this work out"): a merged task's
 * work can be taken out by a pull request that reverts its merge. The task's merge record keeps
 * that pull request's number and URL and where it is (open, merged or closed), so the task's row
 * says "Taken out in #9 (waiting for you to merge)" after a restart and on another install of a
 * shared store. Rows written before v7 read back with nulls: nothing was taken out. Written by
 * hand and frozen; schema.test.ts proves that v1 to v7 equals the generator's output for the
 * current schema.
 */
export const MIGRATION_0007: Migration = {
  version: 7,
  name: "take-out",
  up: {
    sqlite: [
      `ALTER TABLE "merge_record" ADD COLUMN "take_out_pr_number" INTEGER`,
      `ALTER TABLE "merge_record" ADD COLUMN "take_out_pr_url" TEXT`,
      `ALTER TABLE "merge_record" ADD COLUMN "take_out_state" TEXT`,
    ],
    postgres: [
      `ALTER TABLE "merge_record" ADD COLUMN IF NOT EXISTS "take_out_pr_number" BIGINT`,
      `ALTER TABLE "merge_record" ADD COLUMN IF NOT EXISTS "take_out_pr_url" TEXT`,
      `ALTER TABLE "merge_record" ADD COLUMN IF NOT EXISTS "take_out_state" TEXT`,
    ],
  },
};
