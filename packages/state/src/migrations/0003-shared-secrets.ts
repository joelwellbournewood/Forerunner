import type { Migration } from "./types.ts";

/**
 * Spec S.13 / ADR 0065: shared secrets. Adds `device.wrap_public_key` (the install's X25519
 * wrapping key, nullable: a phone or a web page has none) and the `secret_grant` table (the
 * grant of one secret to named agents with its approvals and the wrapped blobs). The DDL is
 * the generator's output for the schema at the time of writing, frozen here; schema.test.ts
 * proves that v1 + v2 + v3 equals the generator's output for the current schema.
 */
export const MIGRATION_0003: Migration = {
  version: 3,
  name: "shared-secrets",
  up: {
    sqlite: [
      `ALTER TABLE "device" ADD COLUMN "wrap_public_key" TEXT`,
      `CREATE TABLE IF NOT EXISTS "secret_grant" (
  "id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "author_agent" TEXT,
  "author_human" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "name" TEXT NOT NULL,
  "owner_human_id" TEXT NOT NULL REFERENCES "human" ("id"),
  "kind" TEXT NOT NULL DEFAULT 'token',
  "why" TEXT NOT NULL DEFAULT '',
  "agent_ids" TEXT NOT NULL DEFAULT '[]',
  "required_human_ids" TEXT NOT NULL DEFAULT '[]',
  "approvals" TEXT NOT NULL DEFAULT '{}',
  "request_ids" TEXT NOT NULL DEFAULT '[]',
  "blobs" TEXT NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "activated_at" TEXT,
  "last_served" TEXT,
  "ended_at" TEXT,
  "ended_reason" TEXT,
  PRIMARY KEY ("id"),
  CONSTRAINT "secret_grant_status_enum" CHECK ("status" IN ('pending', 'active', 'cancelled', 'revoked'))
)`,
      `CREATE INDEX IF NOT EXISTS "secret_grant_owner_human_id_name_idx" ON "secret_grant" ("owner_human_id", "name")`,
      `CREATE INDEX IF NOT EXISTS "secret_grant_status_idx" ON "secret_grant" ("status")`,
    ],
    postgres: [
      `ALTER TABLE "device" ADD COLUMN IF NOT EXISTS "wrap_public_key" TEXT`,
      `CREATE TABLE IF NOT EXISTS "secret_grant" (
  "id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "author_agent" TEXT,
  "author_human" TEXT,
  "version" BIGINT NOT NULL DEFAULT 1,
  "name" TEXT NOT NULL,
  "owner_human_id" TEXT NOT NULL REFERENCES "human" ("id"),
  "kind" TEXT NOT NULL DEFAULT 'token',
  "why" TEXT NOT NULL DEFAULT '',
  "agent_ids" JSONB NOT NULL DEFAULT '[]',
  "required_human_ids" JSONB NOT NULL DEFAULT '[]',
  "approvals" JSONB NOT NULL DEFAULT '{}',
  "request_ids" JSONB NOT NULL DEFAULT '[]',
  "blobs" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "activated_at" TEXT,
  "last_served" TEXT,
  "ended_at" TEXT,
  "ended_reason" TEXT,
  PRIMARY KEY ("id"),
  CONSTRAINT "secret_grant_status_enum" CHECK ("status" IN ('pending', 'active', 'cancelled', 'revoked'))
)`,
      `CREATE INDEX IF NOT EXISTS "secret_grant_owner_human_id_name_idx" ON "secret_grant" ("owner_human_id", "name")`,
      `CREATE INDEX IF NOT EXISTS "secret_grant_status_idx" ON "secret_grant" ("status")`,
    ],
  },
};
