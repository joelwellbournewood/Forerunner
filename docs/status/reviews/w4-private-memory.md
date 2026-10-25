# w4-private-memory

Item: private lessons never reach the shared store; the Postgres adapter refuses the
`agent_private` scope (triage P0 #3; requirements G.1, G.3, S.1, S.10; ADR 0083). Built on
`wave/w4-private-memory` (commits `676b3af`, `e93af6c`) and merged in `4c13067` on 2026-10-23
without an independent review. Brief: `git show origin/build-briefs:briefs/w4-private-memory.md`.

## Review

Independent adversarial review of the item's changes as they stand on the integration branch
`ccr-af5a431d-jc9xqj` at `894b76d`, 2026-10-25. Later merges touched the same files (the chat's
stated lessons of J.1/O.2, cross-project promotion G.6, the conformance case of `049ed52`); every
function, route, test and doc sentence the item added was located on the current head and traced
from its real callers.

Verdict: **revise**. Score: **72/100**.

The two guards the brief asked for are built and proven: `LessonRepo` on the Postgres dialect
refuses an `agent_private` insert, update, patch and supersede before any statement runs
(`packages/state/src/repos/lesson.ts`), and `composeRuntime` opens `<data>/memory/private.sqlite`
next to a non-`sqlite:` state and routes the private scope to it through `ScopedLessonStore`
(`packages/memory/src/scoped-store.ts`, `packages/runtime/src/daemon/compose.ts`). Every memory
write and read path on the current head (`remember`, `recall`, `recordStated`/`forgetStated`,
`proposePromotion`/`promote`/`offerToProjects`, `consolidate`, `reconcile`/`mirrorRow`, the
`/memory` routes) goes through `MemoryContext.repo`, which is the facade; no caller outside
`packages/memory` writes a lesson on `store.lesson` directly (one reads, finding 3). The
Postgres conformance suite passed here against a real database (`postgres.integration.test.ts`,
56 tests, `FORERUNNER_TEST_PG` set), the item's three unit files pass (19 tests), and each of
four mutations was caught by a test: dropping the guard in `updateWhere`
(`lesson-scope.test.ts` fails), routing `search` to the shared store (`scoped-store.test.ts`
fails), composing `MemoryLoop` without the index (`compose-memory.test.ts` fails twice), and
removing `assertStaysHome` (`scoped-store.test.ts` fails). The tests prove what their names say.

One path the item did not close carries private lesson text into the shared store: the weekly
consolidation's approval request (finding 1). That is the same class of violation the item was
merged to end, in a path the brief named, so the verdict is revise.

### Requirements checked

- Brief: "Postgres `LessonRepo.insert/update` throw `MEMORY_SCOPE_VIOLATION` for scope
  `agent_private`". Met: `insert` and `updateWhere` (so `update`, `patch`, `touch`, `retire`,
  `supersede`, `setPinned`) check the dialect before any SQL; the suite case asserts the refusal
  on Postgres and the acceptance on SQLite; `049ed52` kept both halves intact.
- Brief: "compose: when the state store is not `sqlite:`, open a local index
  `<data>/memory/private.sqlite` and route the `agent_private` scope to it (a by-scope facade in
  `packages/memory`)". Met: `privateIndexUrl`, `openPrivateIndex` (foreign keys off, same
  migration version), `ScopedLessonStore`, `RuntimeApp.privateMemory`; the path goes through
  `join`, the URL decision is tested on both dialect spellings.
- Brief: "every read path must union the private index and the shared store for the agent's
  own scopes". Met: `recall` lists per scope, `list`/`count` without a scope union both, `get`
  looks in the index first; the critic's grant never names a private scope and the test proves
  the critic sees no private row.
- Brief: promotion keeps working through the facade. Met: the proposal is a new `shared` row,
  the private origin stays home and is never superseded (`promote` only supersedes a `shared`
  origin); `scoped-store.test.ts` covers it, and G.6's later `offerToProjects`/`acceptOffer`
  copy only shared rows.
- Spec "never leave that PC" / ADR 0002 "a private plan runs on the owner's machine and is
  shown only to the owner". **Not met** for the consolidation request (finding 1). Not
  described for the cloud runner (finding 2).
- Clock, paths, `ForerunnerError` codes, envelope, nothing hardcoded: checked in every file of
  the item; `openPrivateIndex` redacts credentials from the URL in its error details.
- Maintainer docs: `memory.md`, `runtime.md`, `migrations.md`, `platform-notes.md` and ADR 0083
  agree with the code, except that none says what happens on the cloud runner (finding 2) or
  what the consolidation request carries (finding 1).
- Semantic conflicts with later merges: none found. `recordStated`/`forgetStated` (J.1/O.2)
  and `proposeSharing`/`fileOffers`/`answerOffer` (G.6) use `this.ctx.repo`; the conformance
  change of `049ed52` asserts the refusal rather than weakening the case.

### Findings

1. **high (privacy)**: `packages/runtime/src/loop/memory.ts:920-962` (`MemoryLoop.propose`)
   with `packages/memory/src/consolidation.ts:224-227`, `:243-247` and `:260-263`. The weekly
   consolidation reports every scope, the private one included, and files one approval request
   in `this.deps.store.humanRequest` — the shared Postgres in paired and hybrid mode. Its `steps`
   lines and `change_card.reports[].proposals` quote a 67-character preview of each private
   lesson proposed for a merge or a retirement (`preview(kept.text)`, `preview(l.text)`,
   `preview(r.text)`), and a contradiction's `reason` quotes both texts. ADR 0083 says "Private
   lessons never reach Postgres"; ADR 0002 says a private plan "is shown only to the owner". The
   other human holds the database credentials, so the owner filter on `human_request.human_id`
   is advisory against a reader, the same argument the triage used for the lesson rows. The
   state service also publishes `human_request.changed` from that table.
   - Verified with a throwaway runtime test (deleted afterwards): a `MemoryLoop` with a
     `privateStore` and two near-duplicate private lessons; after `propose()` the request row in
     the shared store read `steps: ["agent_private: merge: keep 01a1... \"Run the Windows CI job
     before merging any change that touches file ...\" (hits 0, confidence 0.8); retire 01a1...
     \"Run the Windows CI job before merging a change that touches file pa...\" (cosine >=
     0.9)"]`, and `change_card.reports[0].proposals` carried the same line.
   - The existing test `loop-memory.test.ts` "weekly consolidation ..." runs in solo mode (one
     store) and asserts the line contains "merge", so it cannot see this.

   Smallest correct fix: `ConsolidationOptions.quoteText` (default true) that, when false,
   builds the proposal lines and the contradiction reason from ids, hits, confidence and dates
   only; `MemoryLoop.propose` and `syncApprovals` pass `quoteText: false` for an
   `agent_private` report whenever the loop has a `privateStore` (the request store is then the
   shared one). Solo mode keeps the previews. A runtime test over a split store asserting the
   request row carries no lesson text, and a package test of the option.

   Resolution: fixed in f04f514: `consolidate` takes `quoteText` and `MemoryLoop.consolidationOptions` passes `false` for a private report next to a `privateStore`, so the request row names ids, hits, confidence and dates only; `consolidation.test.ts` "quoteText: false names ids only ..." and `loop-memory.test.ts` "with a shared state the private scope's consolidation request names ids only ..." fail without the fix (the latter also proves the inbox answer still applies the private merge in the index); ADR 0083 amendment of 2026-10-25, memory.md and runtime.md describe the rule.

2. **medium (docs, design)**: `services/cloud-runner/src/runner.ts:380-397` with
   `docs/decisions/0083-private-memory-index.md` (Consequences: "Nothing changes for solo mode
   or for the e2e worlds"), `docs/maintainers/memory.md:81-99`, `runtime.md:1094-1106`,
   `cloud-runner.md` (no mention). The cloud runner composes the same runtime with
   `stateUrl: config.stateUrl` (`postgres://` in hybrid and cloud mode, `config.ts:36-42`) and
   no `privateIndexUrl`, so `privateIndexUrl` opens `<data>/memory/private.sqlite` on the runner
   host. The runner therefore keeps a second copy of the human's private memory (index plus the
   canonical lesson files, which the runner wrote there before this item too) that is not the
   PC's and not the spec's "own encrypted cloud slot" (spec "Source of truth rules"); lessons an
   overnight session learns stay on the runner, the PC's never reach it. The item did not make
   this worse (before it the runner's private rows went into Postgres, which was the P0), but
   its ADR and docs claim the behaviour is settled for every mode and say nothing about the
   runner, and no Known issues bullet names the split memory.
   - Verified by reading `startCloudRunner` (the compose call passes `dirs` from `appDirs` and
     the Postgres URL), `privateIndexUrl` and `config.ts`; the runner's unit tests run on
     `sqlite:` and never see an index.

   Smallest correct fix: a dated amendment to ADR 0083 stating the runner opens its own index on
   its host as the lesser evil until the encrypted cloud slot exists, a Known issues bullet in
   `memory.md` and `cloud-runner.md`, and the "nothing changes" sentence qualified. No code
   change: passing `privateIndexUrl: null` would make every private write on the runner fail
   with `MEMORY_SCOPE_VIOLATION` after the file is written, which is worse.

   Resolution: fixed in f04f514 and 67dea35 (docs): the ADR 0083 amendment of 2026-10-25 records the runner's own index as the accepted lesser evil until the encrypted cloud slot exists, memory.md and cloud-runner.md carry the Known issues bullet (split memory, why no index is worse, one data directory per human's runner), runtime.md's memory paragraph names it; the "nothing changes" claim stands qualified by the amendment. Verified once more before the fix: `startCloudRunner` passes no `privateIndexUrl`, `config.ts` requires `postgres://` outside single-machine trials, and the runner has no scheduler entry for consolidation (so finding 1 does not reach it).

3. **low**: `packages/runtime/src/jobs/handover.ts:515`. The handover job proves the fresh
   agent's memory is empty with `store.lesson.search({ scope: "agent_private", ownerAgentId:
   fresh.id })` on the state store. With a shared state that store never holds a private row,
   so the check reads the wrong store and proves nothing there; the index (through
   `MemoryLoop`'s store) is where such a row would be. Harmless today (a fresh id has rows
   nowhere), but the only direct `store.lesson` read outside the memory layer, and it says
   "no memory" about a store that cannot hold it.
   - Verified by reading `HandoverJob.run` and its `HandoverJobDeps` (no memory or lesson store
     is passed; `composeRuntime` at `compose.ts:2330` passes `store` only).

   Smallest correct fix: an optional `lessons` dependency (a lesson store's `search`) on
   `HandoverJobDeps`, defaulting to `store.lesson`; `composeRuntime` passes the memory loop's
   store (`memory.ctx.repo`), and a test shows the job consults it.

   Resolution: fixed in 9120f72: `HandoverJobDeps.lessons` (a lesson store's `search`, default `store.lesson`) is what the check reads and `composeRuntime` passes `memory.ctx.repo`; `handover-job.test.ts` "proves the fresh agent's memory empty in the store the memory loop reads ..." resolved `{ status: "failed" }` before the fix (the stub store was ignored and the session ran) and now rejects with `internal` before any session, the query naming the fresh agent.

4. **low**: `packages/state/src/db/sqlite.ts:208-209` as used by `openPrivateIndex`
   (`packages/runtime/src/loop/memory.ts:216-227`). The index file and its directory are created
   with the process umask (typically `0644` / `0755`), while the vault writes `0600` / `0700`
   (`packages/vault/src/file.ts:301,506`). Another local account on the PC can read the private
   index. Not a regression of the item: the solo-mode `state.sqlite` and the canonical lesson
   files under `<data>/memory/agents/` carry the same default mode, and the spec's G.1/S.10
   isolation is between the two humans' machines, not local accounts. Neither `memory.md` nor
   ADR 0083 says so.

   Smallest correct fix: a sentence in `memory.md` Known issues next to the unencrypted-index
   bullet; a mode option for the whole memory tree (files, catalogs, index) is one later item,
   not a per-file change here.

   Resolution: not a defect of this item, documented in f04f514: the index carries the same default mode as the solo-mode `state.sqlite` and the canonical lesson files (`LessonFiles` writes with the default mode, `files.ts:334-339`), so an owner-only mode for the index alone would protect nothing the files beside it expose; memory.md Known issues now states the mode and asks for one change over the whole memory tree.

5. **low**: `packages/memory/src/scoped-store.ts:193-208` (`list`, `count`). A list without a
   single scope runs on both stores with the caller's `limit` and `offset` applied in each and
   the concatenation sliced private-first; `orderBy` is not re-applied across the union. No
   current caller lists lessons without a scope and with a limit or an order (`record`,
   `retrieval`, `consolidation`, `promotion` and `reconcile` all name one scope; the unscoped
   calls are the tests'), and `memory.md:90-91` documents "private first".

   Smallest correct fix: none needed in code; a sentence in `memory.md` saying the union is
   unpaged so a future caller does not rely on it.

   Resolution: not a defect, documented in f04f514: re-checked every `repo.list(` call in `packages/memory/src` and `packages/runtime/src` (record, retrieval, consolidation, promotion x3, reconcile), all name one scope and none pages; memory.md "Where the private rows live" now says the unscoped union is unpaged and concatenated private first.

### Not defects (checked and cleared)

- The chat's stated lessons (`recordStated`, `forgetStated`) fix the scope to `agent_private`
  and the owner to the human's own principal; the undo locates the row through the facade.
- A session's lessons (`SessionRunner` -> `MemoryPort.record`) pass no scope; the default is
  `agent_private`. A model cannot choose a scope anywhere on the record paths.
- `insertMany` runs `insert` per row inside the transaction, so the Postgres guard covers it.
- The peer feed (`session/peers.ts`), the sync (`update/sync.ts`) and the state service carry
  no lesson rows; the handoff reads tags only (`projectTags`: "no text leaves the scope").
- `MEMORY_SCOPE_VIOLATION` maps to HTTP 500 in the daemon's `onError`; no route can reach it
  (`edit` never carries a scope, `proposeSharing` writes a new shared row).
- The index is a full schema at the state's migration version; a backfill from `agent` or
  `project` finds them empty there, which `migrations.md` records.

### Verification (2026-10-25, on the branch at the resolutions commit)

- `pnpm exec biome check --write` then `pnpm exec biome check` over the seven changed TypeScript
  files: "Checked 7 files ... No fixes applied".
- `node scripts/check-paths.mjs`: `check-paths: ok (1093 files)`.
- `pnpm typecheck`: exit 0 (`tsc -p tsconfig.node.json`, then `apps/ui`, `apps/approvals-web`,
  `apps/desktop`, `apps/mobile`).
- Item files and the review's: `packages/memory/test/scoped-store.test.ts`,
  `packages/runtime/test/compose-memory.test.ts`, `packages/state/test/lesson-scope.test.ts`
  (3 files, 19 tests passed); `packages/memory/test/consolidation.test.ts` (11 passed),
  `packages/runtime/test/loop-memory.test.ts` (14 passed),
  `packages/runtime/test/handover-job.test.ts` (10 passed). Each new case was run before its fix
  and failed (the previews in the request row; the option ignored; the run resolving `failed`
  instead of rejecting).
- Whole directories, `pnpm exec vitest run --project unit packages/memory/test
  packages/state/test packages/runtime/test`: 162 files, 1549 passed, 1 skipped, 2 failed under
  load (747 s wall, `context.test.ts` "measures one run inside a session with mark()" on the 20 s
  test timeout, `monthly-jobs-wiring.test.ts` "the composed scheduler fires the calibration once
  on day 1" after 41 s); both files re-run alone once, as the rules allow: 2 files, 16 tests
  passed in 52 s.
- Postgres, `FORERUNNER_TEST_PG=postgres://postgres:forerunner@localhost:5432/forerunner_test_r2
  pnpm exec vitest run --project integration packages/state/test/postgres.integration.test.ts`:
  1 file, 56 tests passed (the "keeps private rows out of the shared store" and "keeps private
  lessons private" cases among them).
- `node scripts/docs-check.mjs --base ccr-af5a431d-jc9xqj`: `docs-check: ok (12 files)`.
- Mutation checks of the item's guards (each restored afterwards): the `updateWhere` guard
  removed, `search` routed to the shared store, `MemoryLoop` composed without the index,
  `assertStaysHome` removed; every one made at least one of the item's tests fail.
