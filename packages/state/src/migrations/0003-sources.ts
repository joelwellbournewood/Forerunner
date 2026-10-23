import type { Migration } from "./types.ts";

/**
 * Source discovery (spec A.4, ADR 0056): the `source.kind` enum gains `github_repo` (a chosen
 * repository is a source of its own) and the `source_candidate` table holds what a scan found,
 * one row per repository or folder, keyed by its normalised locator per source.
 *
 * SQLite cannot alter a CHECK constraint, so `source` is rebuilt (new table, copy, drop,
 * rename, index) inside the migration's transaction; nothing referenced `source` before this
 * migration, so the drop is safe. Postgres drops and re-adds the named constraint. The DDL
 * below is the generator's output for the v3 declaration, written out and frozen;
 * schema.test.ts proves that v1 + v2 + v3 equals the generator's schema.
 */
export const MIGRATION_0003: Migration = {
  version: 3,
  name: "sources",
  up: {
    sqlite: [
      `CREATE TABLE "source_v3" (
  "id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "author_agent" TEXT,
  "author_human" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "kind" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "locator" TEXT NOT NULL,
  "credential_ref" TEXT,
  "last_scan" TEXT,
  "status" TEXT NOT NULL DEFAULT 'connected',
  "scan_result" TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY ("id"),
  CONSTRAINT "source_kind_enum" CHECK ("kind" IN ('github_org', 'github_user', 'github_repo', 'gitlab', 'git_remote', 'local_folder'))
)`,
      `INSERT INTO "source_v3" ("id", "created_at", "updated_at", "author_agent", "author_human", "version", "kind", "display_name", "locator", "credential_ref", "last_scan", "status", "scan_result")
  SELECT "id", "created_at", "updated_at", "author_agent", "author_human", "version", "kind", "display_name", "locator", "credential_ref", "last_scan", "status", "scan_result" FROM "source"`,
      `DROP TABLE "source"`,
      `ALTER TABLE "source_v3" RENAME TO "source"`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "source_kind_locator_idx" ON "source" ("kind", "locator")`,
      `CREATE TABLE IF NOT EXISTS "source_candidate" (
  "id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "author_agent" TEXT,
  "author_human" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "source_id" TEXT NOT NULL REFERENCES "source" ("id"),
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "locator" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "proposed_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "existing_install" INTEGER NOT NULL DEFAULT 0,
  "install_marker" TEXT,
  "project_id" TEXT REFERENCES "project" ("id"),
  "is_git" INTEGER NOT NULL DEFAULT 1,
  "details" TEXT NOT NULL DEFAULT '{}',
  "last_seen_at" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "source_candidate_kind_enum" CHECK ("kind" IN ('repo', 'folder')),
  CONSTRAINT "source_candidate_status_enum" CHECK ("status" IN ('proposed', 'accepted', 'duplicate', 'gone'))
)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "source_candidate_source_id_key_idx" ON "source_candidate" ("source_id", "key")`,
      `CREATE INDEX IF NOT EXISTS "source_candidate_key_idx" ON "source_candidate" ("key")`,
      `CREATE INDEX IF NOT EXISTS "source_candidate_status_idx" ON "source_candidate" ("status")`,
    ],
    postgres: [
      `ALTER TABLE "source" DROP CONSTRAINT IF EXISTS "source_kind_enum"`,
      `ALTER TABLE "source" ADD CONSTRAINT "source_kind_enum" CHECK ("kind" IN ('github_org', 'github_user', 'github_repo', 'gitlab', 'git_remote', 'local_folder'))`,
      `CREATE TABLE IF NOT EXISTS "source_candidate" (
  "id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "author_agent" TEXT,
  "author_human" TEXT,
  "version" BIGINT NOT NULL DEFAULT 1,
  "source_id" TEXT NOT NULL REFERENCES "source" ("id"),
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "locator" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "proposed_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "existing_install" BOOLEAN NOT NULL DEFAULT FALSE,
  "install_marker" TEXT,
  "project_id" TEXT REFERENCES "project" ("id"),
  "is_git" BOOLEAN NOT NULL DEFAULT TRUE,
  "details" JSONB NOT NULL DEFAULT '{}',
  "last_seen_at" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "source_candidate_kind_enum" CHECK ("kind" IN ('repo', 'folder')),
  CONSTRAINT "source_candidate_status_enum" CHECK ("status" IN ('proposed', 'accepted', 'duplicate', 'gone'))
)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "source_candidate_source_id_key_idx" ON "source_candidate" ("source_id", "key")`,
      `CREATE INDEX IF NOT EXISTS "source_candidate_key_idx" ON "source_candidate" ("key")`,
      `CREATE INDEX IF NOT EXISTS "source_candidate_status_idx" ON "source_candidate" ("status")`,
    ],
  },
};
