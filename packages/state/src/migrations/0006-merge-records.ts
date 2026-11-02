import type { Migration } from "./types.ts";

/**
 * ADR 0111: the merge record of a task's reviewed pull request. One row per task, written when
 * the critic accepts it: the commit the critic accepted (every later merge is pinned to it),
 * the patch id of the task's own change, where the merge is (queued, merging, waiting_checks,
 * merged, left_to_you), what approved it, the merge commit and method, and one sentence for
 * the person. A merge that waits for checks, a sleep, a crash or the app closing keeps its row,
 * and the daemon retries it with no session. `agent_id` names the install's agent that owns it,
 * since the store can be the shared Postgres. Written by hand and frozen: the DDL is the
 * generator's output at the time of writing; schema.test.ts proves that v1 to v6 equals the
 * generator's output for the current schema.
 */
export const MIGRATION_0006: Migration = {
  version: 6,
  name: "merge-records",
  up: {
    sqlite: [
      `CREATE TABLE IF NOT EXISTS "merge_record" (
  "id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "author_agent" TEXT,
  "author_human" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "task_id" TEXT NOT NULL REFERENCES "task" ("id"),
  "project_id" TEXT REFERENCES "project" ("id"),
  "agent_id" TEXT NOT NULL REFERENCES "agent" ("id"),
  "pr_number" INTEGER NOT NULL,
  "pr_url" TEXT NOT NULL,
  "reviewed_head_sha" TEXT NOT NULL,
  "reviewed_base_sha" TEXT,
  "own_change_id" TEXT,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "approval" TEXT NOT NULL DEFAULT 'none',
  "approved_by" TEXT,
  "merge_sha" TEXT,
  "method" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "sentence" TEXT NOT NULL DEFAULT '',
  "last_outcome" TEXT,
  PRIMARY KEY ("id"),
  CONSTRAINT "merge_record_state_enum" CHECK ("state" IN ('queued', 'merging', 'waiting_checks', 'merged', 'left_to_you')),
  CONSTRAINT "merge_record_approval_enum" CHECK ("approval" IN ('none', 'mode', 'person')),
  CONSTRAINT "merge_record_method_enum" CHECK ("method" IN ('merge', 'squash', 'rebase'))
)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "merge_record_task_id_idx" ON "merge_record" ("task_id")`,
      `CREATE INDEX IF NOT EXISTS "merge_record_agent_id_state_idx" ON "merge_record" ("agent_id", "state")`,
    ],
    postgres: [
      `CREATE TABLE IF NOT EXISTS "merge_record" (
  "id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "author_agent" TEXT,
  "author_human" TEXT,
  "version" BIGINT NOT NULL DEFAULT 1,
  "task_id" TEXT NOT NULL REFERENCES "task" ("id"),
  "project_id" TEXT REFERENCES "project" ("id"),
  "agent_id" TEXT NOT NULL REFERENCES "agent" ("id"),
  "pr_number" BIGINT NOT NULL,
  "pr_url" TEXT NOT NULL,
  "reviewed_head_sha" TEXT NOT NULL,
  "reviewed_base_sha" TEXT,
  "own_change_id" TEXT,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "approval" TEXT NOT NULL DEFAULT 'none',
  "approved_by" TEXT,
  "merge_sha" TEXT,
  "method" TEXT,
  "attempts" BIGINT NOT NULL DEFAULT 0,
  "sentence" TEXT NOT NULL DEFAULT '',
  "last_outcome" TEXT,
  PRIMARY KEY ("id"),
  CONSTRAINT "merge_record_state_enum" CHECK ("state" IN ('queued', 'merging', 'waiting_checks', 'merged', 'left_to_you')),
  CONSTRAINT "merge_record_approval_enum" CHECK ("approval" IN ('none', 'mode', 'person')),
  CONSTRAINT "merge_record_method_enum" CHECK ("method" IN ('merge', 'squash', 'rebase'))
)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "merge_record_task_id_idx" ON "merge_record" ("task_id")`,
      `CREATE INDEX IF NOT EXISTS "merge_record_agent_id_state_idx" ON "merge_record" ("agent_id", "state")`,
    ],
  },
};
