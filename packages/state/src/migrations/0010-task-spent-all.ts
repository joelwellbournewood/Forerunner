import type { Migration } from "./types.ts";

/**
 * d1116-budget-all (the owner's answer of 2026-11-16: "yes it should count critics reviews, and
 * fixes."; ADR 0112, amendment of 2026-11-16): a task's figure, `actual_cost_usd_micro`, which its
 * budget, its cards and Continue read, is everything spent on the task: its work, every review of
 * the critic and every fix. Since then each review call is added as it ends, as each work call
 * is. A task written before held its work only, while the cost ledger has always carried its
 * reviews under its task id (the critic's token carries it), so this migration sets each task's
 * figure to the larger of itself and the ledger's sum for its task id: old tasks follow the same
 * rule as new ones, and nothing is guessed. A task whose total already passed its budget then
 * pauses before its next run, with today's words and one card with Continue.
 *
 * Data only and idempotent (a second run changes nothing): one UPDATE with a correlated
 * subquery, SQLite's two-argument MAX and Postgres's GREATEST. It touches neither `version` nor
 * `updated_at`: a spend increment is no edit a person's action could conflict with (`addCost`),
 * and the estimate fold, which reads finished tasks by `updated_at`, sees no task again. Written
 * by hand and frozen; the schema is unchanged.
 */
export const MIGRATION_0010: Migration = {
  version: 10,
  name: "task-spent-all",
  up: {
    sqlite: [
      `UPDATE "task" SET "actual_cost_usd_micro" = MAX("actual_cost_usd_micro", (SELECT COALESCE(SUM("usd_micro"), 0) FROM "cost_ledger" WHERE "cost_ledger"."task_id" = "task"."id")) WHERE "actual_cost_usd_micro" < (SELECT COALESCE(SUM("usd_micro"), 0) FROM "cost_ledger" WHERE "cost_ledger"."task_id" = "task"."id")`,
    ],
    postgres: [
      `UPDATE "task" SET "actual_cost_usd_micro" = GREATEST("actual_cost_usd_micro", (SELECT CAST(COALESCE(SUM("usd_micro"), 0) AS BIGINT) FROM "cost_ledger" WHERE "cost_ledger"."task_id" = "task"."id")) WHERE "actual_cost_usd_micro" < (SELECT CAST(COALESCE(SUM("usd_micro"), 0) AS BIGINT) FROM "cost_ledger" WHERE "cost_ledger"."task_id" = "task"."id")`,
    ],
  },
};
