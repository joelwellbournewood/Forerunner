# 0005 — Shared state schema: one TypeScript schema, two SQL dialects, versioned migrations

Date: 2026-10-20
Status: accepted

## Context

The spec names fourteen core entities, nine supporting tables, a record envelope
(`id, created_at, updated_at, author_agent, author_human, version`) and the claims rule. Solo
mode runs on SQLite (Node's `node:sqlite`, ADR 0001), shared mode on Postgres. Two hand-written
schemas would drift; a query builder or ORM would add a dependency with its own dialect quirks on
three platforms. The data-model doc must be generated, and limits (claims, findings blocking
close, append-only logs) must hold in code, not prompts.

## Decision

- **One declarative schema** in `packages/state/src/schema.ts` (`ENTITIES: Record<string, EntityDef>`)
  with a one-line description per column. It drives the DDL generator, the row codec, the
  repositories and `docs/maintainers/data-model.md`.
- **One `Database` interface** (`query` with `?` placeholders, `exec`, `transaction`, `close`).
  The Postgres adapter rewrites `?` to `$n`. Both adapters route queries made on the root handle
  from inside an open transaction (same async context) into that transaction, so repositories
  bound to the store take part in `store.transaction()` without a second set of handles.
- **Identical encoding in both dialects**: ids and timestamps are TEXT (ISO-8601 UTC, so string
  order is time order and `claim_expires < now` is one comparison); booleans INTEGER 0/1 vs
  BOOLEAN; JSON TEXT vs JSONB; integers and money INTEGER vs BIGINT, always read back as JS
  numbers. Money is micro-USD; values above 2^53 are rejected on write (about 9 billion USD).
  Enum columns carry CHECK constraints; structural references carry foreign keys; `cost_ledger`,
  `audit_log` and `change_log` reference by id without FKs so they outlive their subjects.
- **Migration v1 is generated and snapshotted** into `0001-initial.ts`; a test asserts the
  snapshot equals the generator output, so a schema change forces a new migration file.
  Migrations are forward-only, contiguous, applied in one transaction, recorded in
  `schema_migrations`, serialised on Postgres with an advisory lock.
- **Repositories** carry the entity rules: `TaskRepo.claim` is one atomic UPDATE with the
  claim predicate in its WHERE clause; `transition` enforces the workflow graph and refuses
  `done` while findings are open; `EventRepo` and `AuditLogRepo` expose no update or delete and
  the tables have triggers refusing both; `LessonRepo.search` always filters private lessons by
  owner. Every write sets `updated_at` from the injected `Clock` and bumps `version`;
  `update(id, expectedVersion, patch)` throws `version_conflict`.
- Two columns were renamed to avoid clashing with the envelope's `version`: `release.release_version`
  and `extension.ext_version`. `decision` gained `question_normalised` and `superseded_by`,
  `human_request` gained `human_id`, `cost_ledger` gained `specialist`, `budget_window` exists as
  a cache for cap checks (the ledger is the truth). `in_review -> in_progress` (critic "revise")
  and `claimed -> ready` (release) were added to the task graph.

## Consequences

- No ORM, no query builder, no native modules: `pg` and `node:sqlite` only.
- The same conformance suite runs against both adapters (unit: SQLite in memory; integration:
  Postgres with one schema per run), so a dialect difference shows up as a failing test.
- Adding a column means a schema edit, a hand-written migration for both dialects, and
  `pnpm docs:schema`. The process is in `docs/maintainers/migrations.md`.
- The SQLite adapter serialises all work on one connection with a mutex; concurrency comes
  from Postgres in shared mode, not from SQLite.

## Alternatives considered

- Drizzle or Kysely: good dialect coverage, but another layer to learn and pin, and the
  generated doc would still need our own metadata. Rejected for now; the `Database` interface
  leaves room to adopt one later.
- TIMESTAMPTZ / BOOLEAN / JSONB everywhere with SQLite emulation in the adapter: more
  Postgres-native, but every SQL statement would then differ. Rejected in favour of one SQL text.
- Storing money as NUMERIC: exact, but `pg` returns strings and SQLite has no decimal type.
  Integer micro-units are exact and portable.
