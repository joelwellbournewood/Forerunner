# Memory

`packages/memory`: lessons in three scopes that are never mixed, Markdown files with YAML
frontmatter plus a local vector index, retrieval under a per-session token budget, the weekly
consolidation job, cross-project promotion after critic approval, and the standard project doc
set with its drift check. [ADR 0002](../decisions/0002-operator-memory.md) fixes the layout and
the retrieval formula; [ADR 0027](../decisions/0027-memory-package-parameters.md) records the
embedder width, the frontmatter keys, the thresholds and the scope grants.

## Purpose

An agent should not make the same mistake twice, and two people's agents must never read each
other's private memory. The package keeps every lesson as one file a human can open, grep, edit
and delete, mirrors it into a row the code can score, and gives the session runner one call to
load what matters within a fixed number of tokens. All rules (scope, budget, validation, what
consolidation may change) are enforced in this code, never in a prompt.

Requirements covered: G.1, G.2, G.3, G.4, G.5, G.6, G.7, N.4, S.10, U.15; H.5 on the memory side
(a repeated finding becomes a lesson through `MemoryService.rememberFromSession`); P.10 for the
memory-format part (see [migrations.md](migrations.md)). K.5 (the memory views) is the apps' job
on top of `LessonFiles` and `LessonRepo`.

## How it works

### Layout on disk

Roots come from `appDirs().data` (so `FORERUNNER_HOME` moves everything) through `memoryRoot()`,
joined with `join()`; nothing is hardcoded to a user path.

```
<data>/memory/
  agents/<agent_id>/        private scope: this machine, this agent only; never synced
    instructions.md         the agent's standing notes; always loaded first
    lessons/<id>.md         one Lesson per file; the file is canonical, the row is the index
    catalog.md              generated map of the root (id, status, tags, confidence, hits, read-if)
  critic/
    lessons/<id>.md         export of the critic rows (team mode: rows live in the state service)
    catalog.md
  shared/
    lessons/<id>.md         export of the shared rows (same rule)
    catalog.md
  private.sqlite            team mode only: the local index of the private rows (ADR 0083); the
                            shared store never holds one
```

`LessonFiles` owns one memory root and refuses any path outside it (`inside()` throws
`path_not_allowed`); scope roots and lesson ids must be safe path segments (ids are the state
store's monotonic UUIDv7 ids). Writes are atomic (temp file in the same directory, fsync,
rename), LF on write, CRLF accepted on read.

### Scopes

| Scope | Who may read | Owner | Where the truth lives | Source of lessons |
| --- | --- | --- | --- | --- |
| `agent_private` | the owning agent only (`ownerAgentId` must equal the asking agent) | `owner_agent_id` required | file, row is derived; team mode: the row is in the local private index, never in the shared store | the agent's sessions, the conversation agent |
| `critic` | every principal, the critic | none | row (state service in team mode), file is the export | the critic's reviews and calibration |
| `shared` | every principal, the critic | none | row, file is the export | promotion, project-level lessons recorded by the critic or a principal |

Project docs (`README`, `docs/*.md` in the project repo) are the fourth place knowledge lives and
are never written by this package beyond scaffolding missing ones (see "Project docs").

`grantFor(kind, agentId)` in `src/service.ts` turns an agent kind into a `ScopeGrant`: principal
and conversation agents get their own private scope plus shared; the critic gets critic plus
shared; specialists get nothing (the principal relays what they need in the brief). `recall`
checks the grant again in code: a private scope without `ownerAgentId` throws `validation`; a
private scope whose owner is not the asking agent is denied and listed in `result.denied`,
and no candidate from it is ever scored. `test/scopes.test.ts` proves agent B asking with agent
A's id gets nothing and a critic grant can never return a private lesson. The state layer has
the same rule (`LessonRepo.search` needs an owner for private lessons), so there are two
independent guards.

The write side has the same shape: `remember` takes the acting `agentId` and refuses a private
write whose `ownerAgentId` is another agent (`autonomy_insufficient`, nothing written).
`MemoryService.rememberFromSession` always passes it and never lets the caller choose the owner;
a direct caller that leaves `agentId` out is trusted to pass its own id, so runtime code should
go through the service. A critic or shared lesson may not cite a private lesson id either:
`remember` resolves every lesson id in the text and refuses one that belongs to a private row
(ADR 0002 "shared may never reference private"); promotion checks again against its destination.

### Where the private rows live (`src/scoped-store.ts`, ADR 0083)

Spec: "whose private memory and keys each holds ... never leave that PC". In solo mode the one
local SQLite holds every scope. With a shared state (Postgres through the state service in
paired and hybrid mode) the runtime opens a second SQLite, `<data>/memory/private.sqlite` (the
state schema at the same migration version, one `lesson` table in use, foreign keys off because
the agents and projects its rows name live in the shared store), and `createMemory({ store,
privateStore })` wraps the two in a `ScopedLessonStore`: writes route by the row's scope
(`agent_private` to the index, `critic` and `shared` to the shared store), reads by id look in
the index first and then in the shared store, `search` reads the scope's store, `list` and
`count` without a single scope union both (private first). A row never changes store: `update`,
`patch` and `supersede` with a scope that belongs to the other store are refused with
`MEMORY_SCOPE_VIOLATION`; promotion is the explicit copy (`proposePromotion` writes the shared
proposal through the facade, the private origin stays home and is never superseded). Every
memory function (`remember`, `recall`, `consolidate`, `reconcile`, promotion, the runtime's
views) sees one `LessonStore` (the `Pick` of `LessonRepo` in `src/types.ts`) and needs no
knowledge of the split; `mirrorRow` restores a file's envelope through
`LessonRepo.overwriteEnvelope` instead of raw SQL for the same reason.

The second, independent guard is in `packages/state`: `LessonRepo` on the Postgres dialect
refuses an `agent_private` insert, update, patch or supersede with `MEMORY_SCOPE_VIOLATION`
before any statement runs (`packages/state/test/lesson-scope.test.ts`; the suite case runs on
the real adapter in the integration project), so a caller that bypasses the facade cannot put a
private row into the shared store either. A hand-edited file whose `scope` no longer matches its
directory is reported invalid by `LessonFiles.list` and never mirrored, so `reconcile` cannot
move a row across the boundary.

### Lesson file (`src/files.ts`, format 1)

```
---
author_agent: agt_...          author_human: hum_... | null       confidence: 0.7
created_at: 2026-...Z          flags: [contradiction:<id>]        format: 1
hit_count: 4                   id: <uuid v7>                      last_used: 2026-...Z | null
owner_agent_id: <agent> | null pinned: false                      project_id: <project> | null
scope: agent_private | critic | shared                            source: session:ses_1;review:rev_2
status: active | retired | proposed                               superseded_by: <id> | null
tags: [testing, windows]       updated_at: 2026-...Z              version: 3
---
Present-tense text, one concern, 20 to 2000 characters. May cite lesson ids.
```

Keys are written sorted (the order above), every key except `flags` and `format` is required,
unknown and duplicate keys fail, values are YAML scalars and flow arrays (strings are quoted
only when they need it). `parseLesson()` is strict and non-throwing (`{ ok, doc | error }`);
`serializeLesson()` is the single serializer for both directions. `lintLesson()` enforces text
length, lowercase kebab tags, confidence 0..1, no credential shapes (`hasSecretShape`, mirrors
`scripts/secret-scan.mjs`), no home-directory path in a critic or shared lesson (`/home/<user>`,
`/Users/<user>`, `/root`, `C:\Users\<user>`; generic system paths such as `/tmp/`, `/var/log` or
`D:\build` are legitimate content and pass), and owner presence exactly for private lessons.
`citedLessonIds(text)` lists the lesson ids a text names; `remember` and promotion use it for the
cross-scope rule above. `LESSON_FORMAT` in `src/types.ts` is the format version; a file with a
newer `format` is refused.

`source` is `kind:id[;kind:id]` (`SOURCE_PATTERN`): kinds `session`, `review`, `human`,
`promotion` (origin lesson), `consolidation`, `approved_by` (the accepting review). `parseSource`
and `formatSource` convert. `flags` exist only in the file; the row has no column for them, so
`exportRow()` keeps whatever flags the file already carries.

### Index and reconciliation

The `lesson` row (`@forerunner/state`, `LessonRepo`) mirrors the file field for field plus
`embedding` (JSON array of the vector) and `file_path`. `mirrorRow()` upserts a row so it equals
the file exactly, including `version`, `created_at` and `updated_at` (set through
`LessonRepo.overwriteEnvelope`; with a private index the row goes to the store of its scope). `reconcile(files, repo,
embedder, scope, ownerAgentId?, { deleteOrphans, writeCatalog })` walks one scope root, upserts
rows for new or changed files (re-embedding), reports rows whose file is gone as `orphans`
(deleted only with `deleteOrphans`), reports unparsable files in `invalid` without trusting them,
and regenerates `catalog.md`. It is idempotent and heals a crash between a file write and its
row write; `test/files.test.ts` simulates that crash.

Each scope root also carries `index.json` (`{ embedder, dims, format }`, `IndexMeta`), written
by `reconcile`. When the context's embedder differs from the marker by name, width or lesson
format (or the marker is missing), every file of the root is re-embedded and the marker is
rewritten; `report.embedder` says `{ name, previous, reembedded }`. This is how "vectors of
different embedders are never compared" (ADR 0002) is enforced without an embedder column in
the schema.

Partial load is a recorded deviation from ADR 0002 (ADR 0027): one unparsable file does not
take the scope offline. The valid files are indexed, the invalid ones are listed in
`report.invalid` and under "Files that failed to parse" in the catalog, and the runtime raises
its `memory.load_failed` diagnostic from that list. Reason: a typo in one hand-edited file must
not remove an agent's whole memory, and lessons are data under a budget, not standing rules, so
a missing one changes a ranking, not an instruction.

Write order: `remember` writes the file first, then the row (private memory's canonical order).
Updates made through the repo (`touch`, `patch`, `supersede`) are followed by `exportRow()` so the
file catches up in the same call.

### Embeddings (`src/embedding.ts`)

`Embedder { name, dims, embed(text): Float32Array }`. The default `HashedNgramEmbedder`
(ADR 0001, ADR 0027): NFKC lower-case, whitespace collapsed; word unigrams (weight 2) and
character 3-5-grams of the space-padded text, each hashed with FNV-1a 32 into one of 256 signed
buckets, L2-normalised. Deterministic on every OS, no dependency, no network, empty text gives
the zero vector. `cosine(a, b)` is 0 for a zero vector or mismatched lengths. `vectorToJson`
rounds to 6 decimals for the row.

`EmbedderRegistry` maps names to factories; `defaultEmbedderRegistry` ships `hashed-ngram`. A
model-backed embedder registers under its own kebab-case name and the project setting picks it
through `createMemory({ embedder })`. The name is part of every vector's meaning. A context has
exactly one embedder, and `reconcile` re-embeds a whole scope root whenever its `index.json`
names another one (see "Index and reconciliation"); between reconciles `recall`, `remember` and
`consolidate` use a stored vector when its length equals `embedder.dims` and otherwise re-embed
the text. `reconcile` is the healing path the runtime is meant to run on every granted scope
root at start (wiring is the runtime's job, see Known issues); a root that has never been
reconciled has no marker and is re-embedded once on its first walk.

### Retrieval (`src/retrieval.ts`)

`recall(ctx, { scopes, agentId, ownerAgentId?, projectId?, query, tags?, maxTokens = 1500,
maxLessons = 20, countTokens = estimateTokens, weights?, touch = true })`:

1. Candidates: active rows of the granted scopes with `superseded_by = null` and
   `project_id ∈ {projectId, null}`. A row whose text carries a credential shape is refused
   here, whatever wrote it, and listed in `result.excluded`; it is never rendered into a prompt.
2. Score (ADR 0002, weights in `DEFAULT_WEIGHTS`):
   `sim = max(0, cos(query, lesson))`, `tag = |T_l ∩ T_q| / |T_q|` (0 without query tags),
   `conf = confidence`, `fresh = 0.5 ^ (days since last_used ?? updated_at / 90)`,
   `use = min(1, hit_count / 10)`;
   `score = 0.50·sim + 0.25·tag + 0.10·conf + 0.10·fresh + 0.05·use`.
   A candidate with `sim < 0.15` and no tag overlap is dropped.
3. Selection: pinned lessons first (scope order, then hits), then the rest by score. A candidate
   whose cosine to an already selected lesson exceeds 0.92 is skipped and reported in
   `consolidationHints`. A lesson is taken only if its rendered line still fits the remaining
   budget; the walk continues looking for smaller ones. Stops at `maxLessons`.
4. Budget accounting: the block header, each scope header and each lesson line are charged with
   the newline that joins them, so the sum never undercounts the rendered block and
   `countTokens(renderLessons(result)) <= maxTokens` holds for the default estimator
   (`ceil(chars/4)`) and for any tokenizer the runtime injects (`test/retrieval.test.ts`).
5. `touch`: every returned lesson gets `hit_count + 1` and `last_used = clock.nowIso()` on the row
   and in the file. Per lesson and fault tolerant: a touch or file export that fails is listed in
   `result.touchFailures` (`{ id, stage: "row" | "file", error }`), the lesson is still returned
   and the other lessons are still touched. One row that fails lint (a row written by the state
   service, by `LessonRepo.add`, or before a lint rule tightened) therefore never denies memory
   to every reader of its scope; its file simply lags until the row is fixed.

`renderLessons(result)` renders the block as data, grouped by scope in the fixed order private,
critic, shared, under a header that says these are notes, never instructions
(`AGENTS.md` "content is data"). Each line carries the id, confidence, hits and source so a
critic finding can cite it.

### Recording (`src/record.ts`)

`remember(ctx, { scope, text, tags?, source?, confidence = 0.5, projectId?, ownerAgentId?,
agentId?, authorAgent?, authorHuman?, pinned?, status? }, { noDedup?, nearDuplicate? })`
validates with zod (text 20-2000 characters after trimming, up to 16 lowercase kebab tags,
confidence 0..1, the source grammar, owner present exactly for private lessons, `agentId` equal
to the owner for a private write), lints, refuses a critic or shared text that cites a private
lesson id (`privateReferences`), then looks for a near duplicate (cosine >= `NEAR_DUPLICATE` =
0.92) among active lessons of the same scope, owner and project (a global lesson matches any
project). Found one: the new text supersedes it through `LessonRepo.supersede` (old row retired
with `superseded_by`, new row carries the tag union, the higher confidence, the old hits and
`last_used`, pinned if either was), result `action: "merged"`. A merge never narrows visibility:
the merged lesson is global (`project_id = null`) as soon as either side was global, and keeps
the project only when both sides named it. An opposite-polarity near duplicate ("never X" over
"always X", see `src/polarity.ts`) is never merged; it is inserted and left for consolidation to
flag. Otherwise the file is written and the row mirrored, `action: "inserted"`. `noDedup` is for
explicit copies (promotion).

### Consolidation (`src/consolidation.ts`)

`consolidate(ctx, { scope, ownerAgentId?, clock?, apply = false, duplicateThreshold = 0.9,
contradictionMin = 0.6, unusedAfterDays = 60, staleAfterDays = 90 })` returns a
`ConsolidationReport { scope, ownerAgentId, ranAt, applied, merged: [{ keptId, retiredIds,
cosine, projectId }], contradictions: [{ a, b, reason, cosine }], retired: [ids], proposals:
string[] }`:

| Rule | Condition | Proposal | Applied change |
| --- | --- | --- | --- |
| Duplicate | cosine >= 0.9 within the same project or global, no polarity conflict; union-find groups; keep pinned, then most used, then most confident, then oldest | `merge: keep <id> ... [, becomes global]; retire <ids>` | losers get `superseded_by = kept`, `status = retired`; the kept lesson gets `project_id = null` when any member of the group was global (`MergeProposal.projectId`), so a merge never narrows what other projects see |
| Contradiction | shared tag, cosine >= 0.6 (no upper bound), opposite sides of a polarity pair (`always/never`, `use/avoid`, `do/don't`, `should/should not`, `prefer/avoid`) | `contradiction (flag only, not resolved): ...` | both files get `flags: [contradiction:<other>]`; rows stay active |
| Unused | `hit_count = 0` and created more than 60 days ago, or `last_used` more than 90 days ago; never pinned | `retire: <id> ... never used / last used <date>` | `status = retired` |

With `apply: false` (the default) nothing is written: the report is what the human reviews. The
caller (the runtime scheduler) files a `HumanRequest` of kind approval with `proposals` and calls
again with `apply: true` after approval; every applied change goes through the repo (version
bump) and is then exported to the file, and the scope's catalog is regenerated. A private plan
needs `ownerAgentId` and runs on the owner's machine. `consolidationDue(lastRunIso, now,
intervalDays = 7)` says whether the weekly job is due; wiring it to the scheduler is the runtime's
job. `polarityConflict(a, b)` is exported for the critic and the UI.

### Promotion (`src/promotion.ts`)

- `proposePromotion(ctx, lessonId, { agentId?, humanApproval? })`: the origin must be active,
  current, tagged `general` and not already global shared. A private origin is proposed only by
  its owning agent and only with `humanApproval.humanId` (the human approved the exact text);
  the private copy stays private. Text citing a lesson id outside the shared scope is refused.
  Creates (idempotently) a shared lesson with `status: proposed`, `project_id: null`,
  `source: promotion:<origin>`; proposals are never retrieved.
- `promote(ctx, proposedId, { reviewId })`: needs an accepting critic review (`ReviewRepo`,
  verdict `accept`, when the context has one); sets the proposal active with
  `source: promotion:<origin>;approved_by:<review>`, exports the file, and if the origin was a
  project-level shared lesson retires it with `superseded_by` pointing at the promoted copy. Other
  projects then receive it through ordinary retrieval (`project_id = null`).
- `rejectPromotion(ctx, proposedId)` retires the proposal; `pendingPromotions(ctx)` lists open ones.
- `offerToProjects(ctx, lessonId, projects?)` lists projects whose tags overlap the lesson's
  (ignoring `general`), excluding the origin project, most overlap first. Without an explicit
  list, a project's tags are derived from the critic and shared lessons recorded about it.

### Project docs (`src/docs.ts`)

`STANDARD_DOCS` = `README.md`, `docs/overview.md`, `docs/architecture.md`, `docs/status.md`,
`docs/decisions/`, `docs/runbook.md`, `docs/data.md`, `docs/testing.md`. `scaffoldDocs(repoDir,
{ name, goal?, repos? })` writes the missing ones from templates with frontmatter
`maintained-by: forerunner` and a `read_if` line, never touching an existing file (the directory
entry maps to `docs/decisions/README.md`). `checkDocDrift(repoDir, { changedFiles, tasksChanged?,
adrWorthy? })` returns the docs that should have changed, for the critic at tier 2+:
`docs/status.md` after a task change or any non-doc change; `docs/architecture.md` when files
were added or removed under a source directory; `docs/decisions/` when an ADR-worthy change is
flagged and no decision file changed; `docs/data.md` for schema, migration, model or `.sql`
files; `docs/testing.md` for test-runner or workflow config; plus every standard doc missing
from the repo. Paths may use either separator. The PM edits the docs in a PR at session end;
this package never rewrites an existing doc.

### Service facade (`src/service.ts`)

`createMemory({ store, privateStore?, root?, files?, embedder?, clock? })` builds the
`MemoryContext` (`repo`: the store's `LessonRepo`, or a `ScopedLessonStore` over the private
index and the store when `privateStore` is given; `files`, `embedder`, `clock`, optional
`reviews`). `MemoryService`:

- `recallForSession({ grant, projectId?, brief, tags?, maxTokens = 1500, countTokens? })`: loads
  the agent's `instructions.md` first when the grant covers its private scope (charged to the
  budget; a file larger than the whole budget throws `budget_exceeded`), then `recall` with the
  remaining budget, and returns `{ block, instructions, result, tokens }` with `tokens <=
  maxTokens`. An empty grant returns an empty block.
- `rememberFromSession({ agentId, sessionId, projectId?, scope = agent_private, lessons,
  authorHuman? })`: records each lesson with `agentId` as the acting agent, author and (for
  private memory) owner (`source` defaults to `session:<id>`), collects rejections instead of
  failing the session, and regenerates the scope's catalog.

### Errors

`ForerunnerError` codes used: `validation` (bad input, bad file, lint), `path_not_allowed`
(outside the root), `not_found`, `approval_required` (promotion without an accepting review or
human approval), `autonomy_insufficient` (proposing someone else's private lesson),
`budget_exceeded` (instructions larger than the budget), `unavailable` (file write failed),
`MEMORY_SCOPE_VIOLATION` (a private row headed for the shared store, or a lesson moved across
the private/shared boundary; spelled as ADR 0002 names it).

## How to change it

- **Scoring weights or thresholds**: `DEFAULT_WEIGHTS` in `src/retrieval.ts`,
  `NEAR_DUPLICATE` in `src/record.ts`, `DEFAULT_CONSOLIDATION` in `src/consolidation.ts`. Every
  one is also an option on the call. Rerun the Phase 4 eval and supersede ADR 0027.
- **A new frontmatter key**: add the column to the `lesson` entity first (migrations.md), then
  the key to `FRONTMATTER_KEYS`, `LessonDoc`, `serializeLesson`, `parseLesson`, `rowToDoc`,
  `mirrorRow` and `rowMatchesDoc` in `src/files.ts`; bump `LESSON_FORMAT` and add the migrator
  described in migrations.md ("Memory-format migrations"); update the table above.
- **Another embedder**: implement `Embedder` with a distinct `name`, register it with
  `defaultEmbedderRegistry.register(name, factory)` (lowercase kebab name), pass it through
  `createMemory({ embedder })`. The next `reconcile` of each scope root sees the new name in
  `index.json`, re-embeds every file and rewrites the marker; a name change without a width
  change is caught the same way, so the only manual step is to run `reconcile` on each root
  (or restart, once the runtime wires the start-time walk). Changing the default options of
  `HashedNgramEmbedder` changes its name too. Supersede ADR 0027 when the default changes.
- **Lint rules**: `lintLesson` in `src/files.ts` (`HOME_PATH`, `SECRET_SHAPES`, text and tag
  limits). A tightened rule makes old rows fail at export time; `recall` tolerates that
  (`touchFailures`) and `reconcile` of the files still indexes them, so tighten freely but list
  the affected rows for the memory view.
- **Another polarity pair**: append to `POLARITY_PAIRS` in `src/polarity.ts` with a test in
  `test/consolidation.test.ts`.
- **A new standard doc**: add it to `STANDARD_DOCS` and `TEMPLATES` in `src/docs.ts` and a rule
  in `checkDocDrift` if some change should trigger it.
- **Team mode**: critic and shared rows live in Postgres behind the state API; `LessonFiles` is
  then an export target after each sync. The Postgres adapter must refuse `scope = private`
  writes (ADR 0002); that guard belongs in `packages/state` and is listed under Known issues.

## Tests

`pnpm vitest run --project unit packages/memory/test` (no network; `sqlite::memory:` store with
foreign keys on, so the helper creates humans, agents and projects; a temp memory root per test;
`SimulatedClock`). `test/helpers.ts` builds the world and holds the fixture texts whose cosines
the suites rely on (near duplicate 0.96, consolidation duplicate 0.905, contradiction 0.87,
opposite polarity 0.93, unrelated under 0.2).

| File | Proves |
| --- | --- |
| `embedding.test.ts` | determinism across instances, unit length, zero vector, case/whitespace invariance, similar closer than unrelated, option validation, cosine edge cases, JSON round trip, registry (default, custom, unknown, bad name), FNV-1a known values |
| `files.test.ts` | sorted keys and LF, parse round trip with quoting, CRLF accepted, unknown/duplicate/missing keys and malformed files rejected, lint rules (home-directory paths refused for critic and shared, `/tmp/`-style system paths allowed), per-scope roots and path safety, atomic write and list, invalid files reported, `instructions.md`, reconcile (rebuild, orphans, idempotent, crash healing, re-embed on edit, invalid file reported while the rest is indexed, full re-embed and `index.json` rewrite when another embedder of the same width built the index), `exportRow` keeps flags |
| `retrieval.test.ts` | the formula numerically, ranking by tags and similarity, budget never exceeded by the estimator or by the rendered block across budgets, caller tokenizer, pinned first and charged, touch in row and file, exclusions (retired, superseded, proposed, other project) and global inclusion, near-duplicate skip with hints, lesson cap, render order, input validation, a lint-failing row is still served and reported in `touchFailures` while the rest is touched, a row with a credential shape is never rendered (`excluded`) |
| `scopes.test.ts` | agent B with agent A's id gets nothing (denied, no touch), private scope without owner throws, own private only, critic and shared readable by every principal, critic grant never returns a private lesson, grants by kind, private files under the owner's root, state-layer guard |
| `record.test.ts` | validation of text, tags, confidence, source and ownership; file plus mirrored row; near-duplicate merge with supersede, tag union, carried hits; below-threshold insert; no merge across scopes, owners or projects (global merges); a merged lesson stays global when either side was global and is still recalled from another project; a critic or shared lesson citing a private id refused at write time (shared ids and private memory unaffected); a private write for another agent refused when `agentId` is given, the service forcing owner = acting agent; opposite polarity not merged; `noDedup`; source grammar |
| `consolidation.test.ts` | polarity pairs, `consolidationDue`, duplicate merge keeping the most used with report-only then apply, the kept lesson made global when a merged member was global (and kept project-scoped when none was), contradictions flagged in both files and never resolved, contradiction above the duplicate threshold, no pairing without a shared tag or across projects, retirement by the simulated clock (never used after 60 days, stale after 90, pinned kept, young kept), custom thresholds, owner required for a private plan |
| `promotion.test.ts` | `general` tag required, idempotent proposal with source pointing at the origin, proposals not retrievable, private origin needs owner plus human approval, foreign (critic) ids refused by promotion, promotion needs an accepting review (empty, revise, missing review rejected), promoted copy active and global, shared project origin superseded, critic origin untouched, reject, offers to projects (explicit and derived) |
| `docs.test.ts` | the eight docs, scaffold with frontmatter, existing untouched and idempotent, frontmatter parse, every drift rule including separators, missing docs reported |
| `scoped-store.test.ts` | the by-scope store over a private index and a shared store that refuses private writes like the Postgres adapter: `createMemory` builds it; a session's private lessons land only in the index (files in the usual roots) and critic and shared ones only in the shared store; recall unions both for the owner, the critic sees no private row, touches go to the holding store; edit, pin, retire, touch and delete locate the row; a scope change across the boundary (update, patch, supersede) is refused with `MEMORY_SCOPE_VIOLATION` while the near-duplicate merge inside the index still supersedes; promotion copies a private `general` lesson into the shared store and leaves the origin home; consolidation runs per scope on its store; `reconcile` of a private root fills the index and never the shared store; scoped and unscoped list, count and search |
| `service.test.ts` | `rememberFromSession` records, rejects and writes the catalog; `recallForSession` loads standing notes then lessons under the budget; instructions larger than the budget refused; empty grant; the "4 simulated weeks" sketch: repeated findings recorded as shared lessons are recalled by later sessions (repeats 3, 0, 0, 0), memory per session stays under budget, hits and `last_used` advance, re-recording merges instead of duplicating |

`test/postgres.integration.test.ts` (`pnpm vitest run --project integration packages/memory/test`)
runs the record, recall, touch, consolidate and reconcile path once against the Postgres dialect
in its own schema; it needs `FORERUNNER_TEST_PG` and skips with the reason in its name otherwise.

The Phase 4 gate proper (repeat-finding rate over four simulated weeks on the eval projects) runs
in `tests/e2e` once the critic wiring lands; the sketch here is its unit-level shape.

## Known issues

- The private index is a second full state schema (every table created, one used): a schema
  migration applies to it at the next start like the state store, and a `lesson` migration that
  backfills from other tables (`agent`, `project`) finds them empty there. A cross-store
  `supersede` has no transaction across the two SQLite files, which is why the facade refuses it
  instead of attempting it.
- The private index is unencrypted on disk like the solo-mode state store; the spec's "own
  encrypted backup" of private memory (spec "Source of truth rules") is not built.
- No `lesson_use` table yet: usage is `hit_count` and `last_used` only; `cited` (the agent or a
  finding referenced the id) waits for the critic wiring.
- Contradiction detection is a word heuristic (ADR 0027): contradictions without a polarity
  word are not flagged. They remain visible as two lessons in the memory view.
- `consolidate` is O(n²) over active lessons of one scope; fine for thousands, not millions
  (ADR 0001). Split by project before it matters.
- `offerToProjects` without an explicit project list derives tags only from critic and shared
  lessons; projects with no lessons yet are never offered anything. Pass the project list from the
  state store when the runtime calls it.
- The memory-format migrator (migrations.md, "Memory-format migrations") is still a placeholder:
  format 1 is the only format and a newer `format` is refused rather than migrated. `index.json`
  already records the format a root was indexed with, so the migrator has its trigger.
- `reconcile` indexes the valid files of a root even when some fail to parse (deviation from
  ADR 0002's all-or-nothing load, recorded in ADR 0027). The `memory.load_failed` event and the
  `fr memory check` command that surface `report.invalid` are the runtime's and the CLI's job,
  as is the start-time `reconcile` of every granted scope root that picks up hand edits and an
  embedder change; neither is wired yet.
- A row whose text fails lint is still served by `recall` (reported in `touchFailures`) and
  only refused when it carries a credential shape (`excluded`); the memory view should list both
  so the human can fix or delete the row.
