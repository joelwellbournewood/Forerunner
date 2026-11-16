import type { Migration } from "./types.ts";

/**
 * d1109-selftasks-run (ADR 0119, D7; the owner, 2026-11-09: the agent keeps its own task list
 * right during a run, "each change shown with one Undo"): the change log's `source` gains
 * `session`, a change the project's agent made during a session (a split, a missing step, the
 * order, a duplicate dropped, a wording). Changes lists it as "In a session", by the agent, with
 * its Undo; the executor posts no Inbox line for it (the session's one Update counts them).
 *
 * SQLite cannot alter a CHECK constraint, so `change_log` is rebuilt as 0003 rebuilt `source`
 * (new table, copy every row of every source, drop, rename, the two indexes again) inside the
 * migration's transaction; no table references `change_log`, so the drop is safe. Postgres drops
 * and re-adds the named constraint. The DDL below is the generator's output for the v9
 * declaration, written out and frozen; schema.test.ts proves that v1 to v9 equals the generator's
 * schema and that a v8 database's rows survive.
 */
export const MIGRATION_0009: Migration = {
  version: 9,
  name: "change-source-session",
  up: {
    sqlite: [
      `CREATE TABLE "change_log_v9" (
  "id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "author_agent" TEXT,
  "author_human" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "human_id" TEXT,
  "agent_id" TEXT,
  "words_used" TEXT NOT NULL DEFAULT '',
  "commands" TEXT NOT NULL DEFAULT '[]',
  "before" TEXT NOT NULL DEFAULT '{}',
  "after" TEXT NOT NULL DEFAULT '{}',
  "scope" TEXT NOT NULL DEFAULT 'project',
  "project_id" TEXT,
  "expires_at" TEXT,
  "undo_state" TEXT NOT NULL DEFAULT 'undoable',
  "undone_at" TEXT,
  "source" TEXT NOT NULL DEFAULT 'ui',
  "sentence" TEXT NOT NULL DEFAULT '',
  PRIMARY KEY ("id"),
  CONSTRAINT "change_log_scope_enum" CHECK ("scope" IN ('session', 'project', 'global')),
  CONSTRAINT "change_log_undo_state_enum" CHECK ("undo_state" IN ('undoable', 'undone', 'expired', 'irreversible')),
  CONSTRAINT "change_log_source_enum" CHECK ("source" IN ('ui', 'chat', 'voice', 'email', 'api', 'palette', 'session'))
)`,
      `INSERT INTO "change_log_v9" ("id", "created_at", "updated_at", "author_agent", "author_human", "version", "human_id", "agent_id", "words_used", "commands", "before", "after", "scope", "project_id", "expires_at", "undo_state", "undone_at", "source", "sentence")
  SELECT "id", "created_at", "updated_at", "author_agent", "author_human", "version", "human_id", "agent_id", "words_used", "commands", "before", "after", "scope", "project_id", "expires_at", "undo_state", "undone_at", "source", "sentence" FROM "change_log"`,
      `DROP TABLE "change_log"`,
      `ALTER TABLE "change_log_v9" RENAME TO "change_log"`,
      `CREATE INDEX IF NOT EXISTS "change_log_undo_state_expires_at_idx" ON "change_log" ("undo_state", "expires_at")`,
      `CREATE INDEX IF NOT EXISTS "change_log_project_id_idx" ON "change_log" ("project_id")`,
    ],
    postgres: [
      `ALTER TABLE "change_log" DROP CONSTRAINT IF EXISTS "change_log_source_enum"`,
      `ALTER TABLE "change_log" ADD CONSTRAINT "change_log_source_enum" CHECK ("source" IN ('ui', 'chat', 'voice', 'email', 'api', 'palette', 'session'))`,
    ],
  },
};
