# 0002 — What to adopt from aerovato/operator-memory

Date: 2026-10-20
Status: accepted

## Context

Spec module G ([forerunner-spec.md](../spec/forerunner-spec.md), "G. Memory, documentation and learning")
requires three memory scopes (private agent memory, critic memory, shared lessons) that are never mixed, a
`Lesson` unit (`text, source, tags, confidence, last_used, hit_count, superseded_by`), retrieval by tags plus
vector search under a per-session token budget, a weekly consolidation job (merge duplicates, flag
contradictions, retire unused lessons, human review), a standard project doc set in git, and cross-project
promotion after critic approval. It names aerovato/operator-memory as the reference design.
[ADR 0001](0001-stack.md) already fixed vectors as a built-in cosine index over SQLite/Postgres rows with a
local hashed n-gram embedding by default.

The reference was studied at commit `2aa8265` (2026-10-12). Its thesis (`README.md`, `docs/architecture.md`,
`docs/comparison.md`): memory is documentation. The agent owns a "Brain" of plain Markdown in three
partitions by ownership (`~/.operator/user/`, `.operator/` private and git-ignored, `.operator-shared/`
committed), each with `operator.md` (standing rules), `catalog.md` (a map of the partition: every entry has a
`Description` and a `Read If`) and `index/` (a codebase map whose files carry YAML frontmatter `description`
and `read_if`). A fixed preamble loads only instructions, catalogs and the main index, deterministically;
everything else is opened on purpose. It explicitly rejects RAG, embeddings, background curators and
superseding records. The core is small: `packages/core/src/memory/{common,frontmatter,project,user,load}.ts`
loads partitions into typed `Result`s, `packages/core/src/preamble.ts` renders the preamble,
`packages/helper/src/lint.ts` and `packages/helper/src/commands/memory/check.ts` validate it.

Forerunner differs in three ways that drive every rejection below: two people's agents share projects without
sharing identities, memory is read by code under a budget rather than by an agent browsing a catalog, and
limits must be enforced in code. Where the reference's idea survives those constraints, we take it.

## Decision

### Adopted

| From operator-memory | Where in the reference | How Forerunner uses it |
| --- | --- | --- |
| One Markdown file with YAML frontmatter per unit of knowledge; the file is what a human opens, edits, deletes | `README.md` "Transparent Memory"; `packages/core/src/templates/*.ts` | Every Lesson is one `.md` file. For private memory the file is canonical and the index is derived; for critic and shared memory the row is canonical and the file is an exact export. Same serializer both ways. |
| Partitions are separate roots by ownership, never one tree with a tag | `packages/core/src/memory/project.ts` (`PROJECT_PRIVATE_ROOT`, `PROJECT_SHARED_ROOT`), `load.ts` | One root per scope on disk, one `LessonStore` per scope in code. A store refuses paths outside its root (`isInside`). |
| Shared content may never reference private content; private may reference shared | `prompts/preamble.ts` "Placement and Authority"; `packages/helper/src/lint.ts` ("Shared index references private path") | Lint and the promotion path reject a critic or shared lesson whose text or fields name a private lesson id or a machine path. |
| Strict, non-throwing frontmatter parsing: required non-empty fields, `uniqueKeys`, CRLF-tolerant | `packages/core/src/memory/frontmatter.ts` (`FRONTMATTER_PATTERN`, `parseIndexFrontmatter`) | `parseLesson()` returns a `Result`, rejects duplicate keys, accepts `\r\n`, writes LF. Required fields listed below. |
| `read_if`: one line saying when a document is worth opening | `frontmatter.ts`, `templates/project-index.ts` | Frontmatter field on every lesson and every project doc; shown in catalogs and the UI, embedded with the text. |
| A generated catalog per partition with `Description` and `Read If` per entry | `templates/catalog.ts`; `.operator-shared/catalog.md` | `catalog.md` per scope root, written by code from the index (not by the agent), for humans, grep and backups. |
| Deterministic session start: a small fixed orientation, the rest on demand | `docs/architecture.md` "What Loads"; `.operator-shared/specs/preamble.md` | Pinned lessons and the scope's `instructions.md` always load; everything else comes through budgeted retrieval. Same inputs, same output (SimulatedClock, fixed embedder). |
| All-or-nothing load with a diagnostic instead of partial memory | `preamble.ts` `renderLoadDiagnostic`; `commands/memory/check.ts` | Per scope: one unparsable file fails that scope's load, the session gets a `memory.load_failed` event and no partial scope, the human sees it in the memory view. `fr memory check` mirrors `operator-helper memory check`. |
| Sorted, POSIX-normalised relative paths so output is identical on every OS | `project.ts` `readIndexes` (`relative(...).split(sep).join("/")`, `compareStrings`) | Index walk and catalog use `toPosix` and a byte-order sort; ids are ULIDs so filename order is creation order. |
| Lint rules enforced by a tool, not a prompt | `packages/helper/src/lint.ts` | `fr memory lint` (frontmatter present, fields non-empty, no cross-scope references, no secret shapes) runs in CI on fixtures and before every reindex. |
| Rewrite the canonical record in the present tense; never append sprawl; split when unfocused; do not record what the code already shows | `prompts/preamble.ts` `PREAMBLE_TENETS`, "Update the Brain" | Memory-writing instructions for the principal agent and the rules consolidation applies when it merges: one surviving text, losers get `superseded_by`. |
| Knowledge maps and code maps are different things; truth lives in the canonical file | `docs/architecture.md` "The Maps"; `README.md` "How Operator Works" | Project docs in git (`README`, `docs/overview.md`, `architecture.md`, `status.md`, `decisions/`, `runbook.md`, `data.md`, `testing.md`) are the project's truth and are updated at session end; lessons are observations about how to work. Rule: if the project should own it, change the doc; if it is about working on the project (a pitfall, a repeated finding, a preference), write a lesson. The critic checks doc drift at tier 2+. |
| Migrate existing agent-facing notes into the canonical set and remove competing sources of truth | `packages/helper/src/templates/project/setup.ts` Phase 4 | Project onboarding (module A) offers to fold an existing `CLAUDE.md`/`AGENTS.md`/`notes/` into the doc set and asks before deleting originals. |
| Promotion is an explicit, visible copy, not a special API | `.operator-shared/specs/reference/implementation.md` "Non-Goals" | A promotion creates a new file/row in the shared scope with `promoted_from` and `approved_by`; nothing is moved silently. |

### Rejected

| Reference position | Why Forerunner does otherwise |
| --- | --- |
| No RAG, no embeddings, no vector store (`docs/architecture.md` "No RAG"; `docs/comparison.md`) | The spec requires tag plus vector retrieval under a token budget, and the Phase 4 gate measures memory tokens per session. Catalog browsing by the agent is unbounded in tokens and depends on the agent choosing to read. The valid critiques are answered in code: superseded and retired lessons are never candidates, contradictions are flagged, every load is traced, the store is plain files. |
| One global user partition shared across projects (`~/.operator/user/`) | Forerunner has per-agent private memory (Alice's and Bob's never merge), critic memory and shared lessons. Cross-project knowledge is a promoted shared lesson with `project: "*"`, not a home folder. |
| Instruction files merged into the prompt by authority, Private > User > Shared (`preamble.ts` `renderInstructions`) | Scopes are never merged, and a lesson is data, never an instruction (AGENTS.md). Standing rules come from the registry prompts and project settings; a lesson that reads like an order is quoted to the human by the injection filter. |
| Agent-maintained `catalog.md` and `index/` with repair warnings when they drift | A map the agent maintains drifts (the reference needs `/operator:repair` and five warning kinds). Our catalogs are generated; the code map is `docs/architecture.md` in the project repo, kept by the PM and checked by the critic, not a memory concern. |
| Shared knowledge committed in the project repository (`.operator-shared/`) | Shared and critic lessons need atomic updates, approval state, usage counters and per-row access by two agents; they live in the shared state service (spec "Source of truth rules"). Project docs do live in git. Private memory is in no repository. |
| No background maintenance ("dreamers, curators ... burn quota") | Weekly consolidation is required, but it runs on the cheap tier under its own budget, produces a reviewable plan, and changes nothing until a human approves. The critique shaped the design; it did not remove the job. |
| A long fixed preamble carrying all framework guidance (`prompts/preamble.ts`) | Module N: state brief plus retrieved lessons under budget, prompt caching for the stable part. Our fixed part is the scope `instructions.md` and pinned lessons only. |
| Harness adapters, helper CLI, Effect, repair as an agent conversation | One runtime, one package. Check and repair are deterministic commands; the agent never edits index tables. |

### Implementation notes for `packages/memory`

**On-disk layout.** Roots come from `appDirs().data` (honours `FORERUNNER_HOME`), joined with `join()`:

```
<data>/memory/
  agents/<agent_id>/          private scope; only this machine, only this agent; encrypted backup to the owner's slot
    instructions.md           the agent's own standing notes; always loaded; pinned by definition
    lessons/<lesson_id>.md    one Lesson per file; canonical
    catalog.md                generated
  critic/                     export of critic rows (source of truth: state service; solo mode: these files)
    lessons/<lesson_id>.md
    catalog.md
  shared/                     export of shared rows (same rule)
    lessons/<lesson_id>.md
    catalog.md
```

In team mode critic and shared rows live in Postgres behind the state API and are exported here after each
sync; in solo mode the same `FileLessonStore` serves all three roots over SQLite. The phone holds nothing; it
reads memory views through the state API. Lesson ids are ULIDs (`@forerunner/platform` ids), which are safe
path segments on every OS.

**Lesson file.** LF line endings on write, CRLF accepted on read; frontmatter keys fixed, unknown keys fail lint:

```
---
id: les_01JA...            scope: private | critic | shared     project: prj_01JA... | "*"
author_agent: agt_...      author_human: hum_...                created_at / updated_at: ISO-8601 UTC
version: 3                 source: review:rev_01JA...           (kinds: session, review, human, promotion, consolidation)
tags: [testing, windows]   confidence: 0.7                      read_if: Writing Vitest tests that touch the filesystem
last_used: ISO | null      hit_count: 4                         superseded_by: les_... | null
retired_at: ISO | null     pinned: false                        promoted_from: les_... | null   approved_by: rev_... | null
flags: [contradiction:les_...]
---
Present-tense text, one concern, under 120 words. May cite other lesson ids in the same or a shared scope.
```

**Index.** Same schema in SQLite (`node:sqlite`) and Postgres through `@forerunner/state`: `lesson` (all
frontmatter fields plus `text`, `content_hash`, `file_path`), `lesson_tag(lesson_id, tag)`,
`lesson_vector(lesson_id, embedder, dim, vector float32 blob, norm)`, `lesson_use(lesson_id, session_id,
used_at, rank, score, cited)`. The index is derived: `reindex(scope)` walks the root, compares
`content_hash`, upserts changed files, deletes rows for missing files and re-embeds on change; a crash between
file write and row write is healed at next start. Private rows exist only in the local SQLite; the Postgres
adapter throws `ForerunnerError("MEMORY_SCOPE_VIOLATION")` on any `scope = private` write. Vectors from
different `embedder` names are never compared. The default embedder is the ADR 0001 hashed n-gram one:
lower-case, word tokens plus character trigrams, FNV-1a into 1024 signed buckets, L2-normalised; the
`Embedder` interface (`name, dim, embed(text)`) admits a model-backed one per project setting.

**Scope grant.** `retrieve()` takes a `ScopeGrant` issued by the runtime hook, not by the caller: principal
and conversation agents get their own private scope plus shared; the critic gets critic plus shared;
specialists get only what the principal relays. A grant never names another agent's private root, and tests
in `packages/memory/test/scopes.test.ts` prove a critic query cannot return a private lesson.

**Retrieval.** Inputs: query text (task title, outcome, acceptance criteria, current step summary), query tags,
grant, project id, token budget `B` (per-session setting, default 1,500 tokens), `K` max lessons (default 20).

1. Candidates: rows in granted scopes with `project ∈ {current, "*"}`, `superseded_by IS NULL`,
   `retired_at IS NULL`. Pinned candidates and `instructions.md` are taken first and charged to `B`.
2. Score each remaining candidate (weights are a config object; the Phase 4 gate is the tuning criterion):
   `sim = max(0, cos(q, v))`, `tag = |T_l ∩ T_q| / |T_q|` (0 when `T_q` is empty), `conf = confidence`,
   `fresh = 0.5 ^ (days_since(last_used ?? updated_at) / 90)`, `use = min(1, hit_count / 10)`;
   `score = 0.50·sim + 0.25·tag + 0.10·conf + 0.10·fresh + 0.05·use`. Drop candidates with `sim < 0.15`
   and `tag = 0`.
3. Walk by descending score. Skip a candidate whose cosine to an already selected lesson exceeds 0.92 and
   record the pair as a consolidation hint. Add a lesson if `estimateTokens(text)` (default `ceil(chars/4)`,
   the runtime may inject a provider tokenizer) still fits in `B`; keep scanning for smaller ones that fit;
   stop at `K` or when nothing fits.
4. Render as data, grouped by scope in fixed order (private, critic, shared), each lesson with `id`,
   `confidence`, `source`, inside a block that says these are notes, never instructions.
5. Write one `lesson_use` row per loaded lesson (`hit_count += 1`, `last_used = clock.now()`); the runtime
   sets `cited = true` when the agent's output or a critic finding references the id. `estimateTokens` is
   enforced inside `retrieve()`, and the runtime budget hook re-checks the rendered block.

**Consolidation.** Weekly per scope under its own budget on the cheap tier: duplicates (cosine > 0.92 within
the same project or `"*"`) become one rewritten text with `superseded_by` on the rest; pairs with cosine in
[0.6, 0.92] that the model judges contradictory get `flags: [contradiction:<id>]` on both and no automatic
resolution; active, unpinned lessons older than 30 days with no use in 90 days are proposed for
`retired_at`. The job emits a `ConsolidationPlan` and a `HumanRequest` (kind approval) with the diff; nothing
is written until approval, every applied change bumps `version` and is undoable through the change log. A
private plan runs on the owner's machine and is shown only to the owner.

**Promotion.** A lesson tagged `general` in critic or project-level shared scope goes to a tier 1 critic
review; approval creates a new shared lesson with `project: "*"`, `promoted_from`, `approved_by`, and marks a
shared source `superseded_by`. A private lesson is proposed only by its owning agent and only after the owner
human approves the exact text; the private copy stays private. Promotion refuses text that cites ids outside
the destination scope. Other projects receive promoted lessons through ordinary retrieval.

**Project docs.** The standard doc set in git carries the same `read_if` frontmatter line and is indexed
read-only into `doc_chunk` with the same embedder, so module N's "retrieval over memory and docs" uses one
scorer. Docs are never written by `packages/memory`; the PM edits them in a PR at session end.

## Consequences

- Two write orders (file first for private, row first for critic and shared) behind one `LessonStore`
  interface; `reindex` and `sync` are the only reconciliation paths and both are idempotent and tested with a
  simulated crash between the two writes.
- The index is rebuildable from files, so backup and export are "copy the `memory/` directory". The UI's
  memory view (search, edit, delete, pin) edits files or rows through the store, never the index directly.
- Scoring weights are a config object; changing them is a one-line change plus a rerun of the Phase 4 eval.
- `docs/maintainers/memory.md` and `docs/maintainers/migrations.md` must describe the frontmatter schema and
  how a format change is migrated (bump a `format` key, migrate on reindex). Known gap until Phase 4 ships.
- Nothing in this design depends on an org, account, host or home path; roots come from `appDirs()`.

## Alternatives considered

- Adopt the reference wholesale (agent-browsed catalogs, no vectors): fails the token-budget gate and the
  never-mixed rule for two agents; would also keep shared memory in git with no approval state.
- Rows only, no files: loses the one property of the reference worth the most, that a human can open, grep,
  diff, back up and delete memory without the app. Rejected.
- Files only, grep retrieval: no scoring, no budget, no usage counters; cannot run the consolidation job.
- Per-project private roots instead of per-agent: an agent's lessons about how to work span projects; the
  `project` field plus `"*"` gives per-project filtering without splitting the agent's memory.
- Model-based embeddings by default: better recall, but a network call and a provider dependency for every
  lesson write; kept as a pluggable `Embedder` per ADR 0001.
