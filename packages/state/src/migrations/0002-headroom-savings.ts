import type { Migration } from "./types.ts";

/**
 * ADR 0003 section 3: savings live on the Run and the Session, never in cost_ledger.
 * Adds `run.context_transforms` (json), `run.headroom_used` (bool) and
 * `session.headroom_saved_tokens` (int). Written by hand and frozen; schema.test.ts proves that
 * v1 + v2 equals the generator's output for the current schema.
 */
export const MIGRATION_0002: Migration = {
  version: 2,
  name: "headroom-savings",
  up: {
    sqlite: [
      `ALTER TABLE "run" ADD COLUMN "context_transforms" TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE "run" ADD COLUMN "headroom_used" INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE "session" ADD COLUMN "headroom_saved_tokens" INTEGER NOT NULL DEFAULT 0`,
    ],
    postgres: [
      `ALTER TABLE "run" ADD COLUMN IF NOT EXISTS "context_transforms" JSONB NOT NULL DEFAULT '[]'`,
      `ALTER TABLE "run" ADD COLUMN IF NOT EXISTS "headroom_used" BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "headroom_saved_tokens" BIGINT NOT NULL DEFAULT 0`,
    ],
  },
};
