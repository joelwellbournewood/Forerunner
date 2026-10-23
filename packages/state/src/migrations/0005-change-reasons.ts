import type { Migration } from "./types.ts";

/**
 * Spec B.5: every change to a plan, task or milestone is versioned with author and reason.
 * Tasks have carried `reason` since v1; this adds `milestone.reason` and `session.reason`
 * (the reason for the last change to the session plan). Rows written before v5 read back
 * with "" and take a reason on their next change, which the repositories require
 * (`MilestoneRepo.change`, `SessionRepo.setPlan`). Written by hand and frozen; schema.test.ts
 * proves that v1 to v5 equals the generator's output for the current schema. It is v5
 * because migrations 0003 (sources) and 0004 (shared secrets) shipped first on the release
 * branch.
 */
export const MIGRATION_0005: Migration = {
  version: 5,
  name: "change-reasons",
  up: {
    sqlite: [
      `ALTER TABLE "milestone" ADD COLUMN "reason" TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE "session" ADD COLUMN "reason" TEXT NOT NULL DEFAULT ''`,
    ],
    postgres: [
      `ALTER TABLE "milestone" ADD COLUMN IF NOT EXISTS "reason" TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "reason" TEXT NOT NULL DEFAULT ''`,
    ],
  },
};
