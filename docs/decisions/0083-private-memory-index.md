# 0083 — Private memory next to a shared state: a local SQLite index routed by scope, and the Postgres adapter's refusal

Date: 2026-10-23
Status: accepted

## Context

The spec says the two installs differ only in "whose private memory and keys each holds, and
those never leave that PC" ("Source of truth rules": private agent memory lives on the owner's
machine; critic memory and shared lessons in the shared state service). [ADR 0002](0002-operator-memory.md)
fixed the rule for the index: "Private rows exist only in the local SQLite; the Postgres adapter
throws `ForerunnerError("MEMORY_SCOPE_VIOLATION")` on any `scope = private` write."

Neither half was built. `packages/memory` wrote every scope through one `LessonRepo`
(`MemoryContext.repo`), `composeRuntime` built memory on the daemon's one state store, and in
paired or hybrid mode that store is the shared Postgres. An `agent_private` row carries the
lesson text, so one human's private memory sat in a database the other human holds credentials
for; the owner filter in `LessonRepo.search` is advisory against a reader with database access.
The release triage listed this as P0 #3.

Constraints: the memory functions (`remember`, `recall`, `consolidate`, `reconcile`, promotion,
the runtime's views) must keep one store interface; promotion (G.6, built on another branch
through `proposePromotion` / `promote`) copies a private lesson into the shared scope and must
keep working through whatever the context holds; the `lesson` table has foreign keys to `agent`
and `project`, which live in the shared store; the error taxonomy (`ErrorCode`) spells its codes
in lower-case snake case.

## Decision

1. **The Postgres adapter refuses private rows, before any SQL.** `LessonRepo` checks the
   dialect in `insert` and in `updateWhere` (which `update`, `patch`, `touch` and `supersede`
   all pass through): on `postgres`, an `agent_private` insert, or a patch that sets
   `scope = "agent_private"`, throws `ForerunnerError("MEMORY_SCOPE_VIOLATION")` with
   `{ scope, dialect, operation }` in `details`. The code is added to `ErrorCode` in the
   upper-case spelling ADR 0002 uses, as the one exception to the taxonomy's lower-case names:
   the ADR, the triage and the handover all name it that way, and a reader greps for it.
   SQLite accepts the write: in solo mode the one local store holds every scope.

2. **A second SQLite file is the private index.** With a state URL that is not `sqlite:`,
   `composeRuntime` opens `<data>/memory/private.sqlite` through the ordinary `openStore`, so it
   carries the whole state schema at the same migration version and needs no migration path of
   its own; only its `lesson` table is used. It is opened with `PRAGMA foreign_keys = OFF`
   (`OpenStoreOptions.sqlite.foreignKeys`), because the `agent` and `project` rows a private
   lesson references live in the shared store and are checked there (`MemoryLoop` verifies the
   owning agent against `store.agent` before a private view, `remember` against the acting
   agent). The index closes with the store and is exposed as `RuntimeApp.privateMemory` (null in
   solo mode); `ComposeOptions.privateIndexUrl` overrides the decision so tests can force an
   index next to an in-memory state.

3. **One store interface, routed by scope.** `MemoryContext.repo` is now a `LessonStore` (the
   public `Pick` of `LessonRepo`), and `createMemory({ store, privateStore })` wraps the two in a
   `ScopedLessonStore`: writes route by the row's scope, reads by id look in the index first and
   then the shared store, `search` reads the scope's store, `list` and `count` without a single
   scope union both. A row never changes store: `update`, `patch` and `supersede` with a scope
   that belongs to the other store are refused with `MEMORY_SCOPE_VIOLATION`, so there is never
   a write that spans two SQLite files without a transaction. Promotion is the explicit copy the
   spec asks for and works unchanged: the shared proposal is a new row the facade routes to the
   shared store, the private origin stays home. `mirrorRow` restores a file's envelope through a
   new `LessonRepo.overwriteEnvelope` instead of raw SQL on `repo.db`, so the facade can route it.

## Consequences

- Private lessons never reach Postgres: the memory layer does not send them, and the adapter
  would refuse them if it did. Two independent guards, both in code, both tested without a
  database (`packages/state/test/lesson-scope.test.ts` runs the refusal on a Postgres-dialect
  handle that fails the test if a statement reaches it; `packages/memory/test/scoped-store.test.ts`
  runs the facade over a shared store that refuses like the adapter; the suite case in
  `packages/state/test/suite.ts` runs the real adapter under `FORERUNNER_TEST_PG`).
- `docs/maintainers/memory.md` (the new "Where the private rows live" section), `runtime.md`,
  `migrations.md` and `platform-notes.md` describe the index, the facade and the code.
- A schema migration applies to the index at the next start like the state store; a `lesson`
  migration that backfills from `agent` or `project` finds them empty there (migrations.md,
  Known issues).
- The index is unencrypted on disk like the solo-mode state store; the spec's encrypted backup
  of private memory to the owner's own cloud slot remains unbuilt (memory.md, Known issues).
- Nothing changes for solo mode or for the e2e worlds, which run on `sqlite::memory:` and pass
  no private store.

## Alternatives considered

- **Encrypt private rows inside the shared Postgres** with a device key. Rejected: ADR 0002 and
  the spec say private memory never leaves the PC, and an encrypted row is still a row the other
  human holds; retrieval needs the plain text for scoring anyway.
- **A lesson-only schema for the index** (one table, no foreign keys, its own migrations).
  Rejected for now: a second migration path for one table, with the same column set to keep in
  step with `ENTITIES.lesson`; the full schema costs a few empty tables and nothing else.
- **Keep foreign keys on and mirror the agent and project rows into the index.** Rejected: the
  mirror would have to follow every project and agent change in the shared store, and the
  referential checks the memory layer actually relies on happen against the shared store.
- **Spell the code `memory_scope_violation`.** Rejected: the ADR that specified the guard, the
  triage and the handover name `MEMORY_SCOPE_VIOLATION`, and the verification that found the gap
  grepped for that string.
- **Refuse a private write on a sqlite store marked `shared`.** Not needed: paired and hybrid
  mode are Postgres through the state service (ADR 0024, state-service.md); a `sqlite:` state is
  solo mode by definition and holds every scope.

## Amendment 2026-10-25

From the independent review of the item (`docs/status/reviews/w4-private-memory.md`), two
points this ADR left open.

1. **Rows about private memory in other tables of the shared store.** The guards above keep the
   `lesson` rows home, but the runtime writes about private memory elsewhere: the weekly
   consolidation files its plan as one `human_request` row of the state store, and its lines
   quoted a preview of each private lesson proposed for a merge, a flag or a retirement. Next to
   a private index the state store is the shared Postgres, so the previews left the PC. The
   rule now: a row about private memory that goes to the shared store names ids, counts and
   dates only. `consolidate` takes `quoteText` (default true); `MemoryLoop.consolidationOptions`
   passes `false` for an `agent_private` report whenever the loop has a `privateStore`. Solo
   mode and the critic and shared scopes keep the previews. The other such rows were checked:
   a cross-project offer quotes a promoted shared lesson (shared already), the audit rows of
   memory operations carry ids, the rejected-candidate warning quotes text that never became
   memory. Alternative rejected: filing the private plan in the index's own `human_request`
   table, which the inbox never reads.

2. **The cloud runner.** "Nothing changes for solo mode or for the e2e worlds" above said nothing
   about hybrid and cloud-only mode. The cloud runner composes the same runtime on the shared
   Postgres URL, so `privateIndexUrl` opens an index under the runner's data directory and the
   runner holds a second, unencrypted copy of the served human's private memory (the canonical
   lesson files were written there before this ADR too). That is accepted for now as the lesser
   evil: with no index every private write on the runner fails with `MEMORY_SCOPE_VIOLATION`
   after the file is written, and the spec's answer, the owner's encrypted cloud slot, is the
   unbuilt backup already listed in memory.md. Consequence: the served human's private memory is
   split between the PC and the runner until that slot exists; cloud-runner.md and memory.md
   carry the Known issues bullet. A runner serving one human must not share its data directory
   with another human's runner.
