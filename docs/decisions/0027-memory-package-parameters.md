# 0027 — Memory package parameters: embedder width, frontmatter keys, consolidation thresholds, scope grants

Date: 2026-10-20
Status: accepted

## Context

[ADR 0002](0002-operator-memory.md) fixes the on-disk layout, the retrieval formula and the shape
of the memory package. `packages/memory` lands with four points the ADR left loose or that the
state schema (ADR 0005) decided differently in the meantime: the width and features of the
default embedder, the exact frontmatter key set (the schema has no `lesson_vector`, `lesson_tag`
or `lesson_use` tables and no `read_if`, `promoted_from`, `approved_by` or `retired_at` columns),
the consolidation thresholds, and how contradictions are detected without a model call. The
build instruction for the package named concrete values for all four. This ADR records what was
built so a later tuning run changes one place and knows what it is changing.

## Decision

| Point | Value | Why |
| --- | --- | --- |
| Default embedder | `HashedNgramEmbedder`: character 3-5-grams plus word unigrams (weight 2), FNV-1a feature hashing into 256 signed buckets, L2-normalised; name `hashed-ngram-3-5-w256-v1` | ADR 0002 sketched 1024 buckets and trigrams. 256 dimensions keep a lesson row under 3 KB of JSON and score thousands of lessons in milliseconds; the 3-5-gram range separates near-duplicates (0.96) from paraphrases (0.87-0.90) and unrelated text (under 0.2) on the fixtures in `test/`. Options are a constructor argument, so retuning is a one-line change plus a rerun of the Phase 4 eval. A model-backed embedder registers under another name in `EmbedderRegistry`; vectors of different embedders are never compared. |
| Vector storage | `lesson.embedding` JSON array (6 decimals), rewritten whenever the text changes | Follows the shipped schema instead of adding a `lesson_vector` table; the index is derived and rebuilt by `reconcile`. |
| Frontmatter keys | Exactly the `lesson` row minus `embedding` and `file_path`, plus `flags` and `format`: `author_agent, author_human, confidence, created_at, flags, format, hit_count, id, last_used, owner_agent_id, pinned, project_id, scope, source, status, superseded_by, tags, updated_at, version` | One serializer, one schema, no field that exists only in files or only in rows. `promoted_from` and `approved_by` live in `source` (`promotion:<id>;approved_by:<review id>`); retirement is `status: retired`; the catalog's "Read if" column is the first line of the text. Unknown keys fail lint so a format change must bump `format` (see migrations.md). |
| Near-duplicate at write time | cosine >= 0.92 within the same scope, owner and project (a global lesson matches any project); the merged lesson is global when either side was global | The newer text supersedes the older row (`superseded_by`), carrying hits, tags and the higher confidence, as ADR 0002's "rewrite the canonical record" tenet asks. A merge never narrows visibility: a lesson recorded for every project must not become one project's lesson because a project-level duplicate existed first. Consolidation's merge groups follow the same rule (`MergeProposal.projectId`). |
| Cross-scope references | `remember` refuses a critic or shared text that cites a lesson id resolving to a private row; promotion refuses any id outside the shared scope | ADR 0002 "shared may never reference private" enforced at write time, not only at promotion. Only ids that resolve on this machine can be known to be private; an unknown id is allowed. |
| Lint path rule | A critic or shared lesson may not name a home-directory path (`/home/<user>`, `/Users/<user>`, `/root`, `C:\Users\<user>`); generic system paths (`/tmp/`, `/var/log`, `/opt`, `/mnt`, `D:\build`) pass | ADR 0002 says "machine path". The narrow rule catches what identifies a person or a machine; the broad one refused legitimate lessons such as "tests must not write to /tmp/ directly". |
| Recall fault tolerance | `recall` touches and exports per lesson; a failure is reported in `result.touchFailures` and the lesson is still returned; a row whose text carries a credential shape is refused before scoring (`result.excluded`) | One row that fails lint (written by the state service in team mode, by `LessonRepo.add`, or before a lint rule tightened) must not deny memory to every reader of its scope. A credential value never enters model context (AGENTS.md), whatever wrote the row. |
| Embedder marker | `<scope root>/index.json` = `{ embedder, dims, format }`, written by `reconcile`; a differing name, width or format re-embeds the whole root | The schema stores no embedder name per row. Comparing on length alone would let two embedders of the same width meet, which ADR 0002 forbids; the marker makes the change visible and the reindex automatic at the next start. |
| Partial load on reconcile (deviation from ADR 0002) | `reconcile` indexes the valid files of a root and lists the unparsable ones in `report.invalid` and in the catalog; it does not fail the scope | ADR 0002 adopted the reference's all-or-nothing load. In Forerunner a lesson is data under a budget, never an instruction, so a missing one changes a ranking, not a rule; a typo in one hand-edited file must not remove an agent's whole memory. The diagnostic the ADR asks for (`memory.load_failed`, `fr memory check`) is raised by the runtime and the CLI from the non-empty list. |
| Consolidation thresholds | duplicates: cosine >= 0.90; contradictions: cosine >= 0.60 and opposite polarity words (`always/never`, `use/avoid`, `do/don't`, `should/should not`, `prefer/avoid`), no upper bound; retire: `hit_count = 0` and older than 60 days, or `last_used` older than 90 days; pinned never retired; interval 7 days | 0.90 is below the write-time 0.92 on purpose: the weekly job exists to catch what slipped past. The polarity heuristic replaces ADR 0002's "the model judges contradictory" for now: it is deterministic, free, explainable, and testable with a SimulatedClock; a model pass can be added behind the same `ConsolidationReport`. |
| Opposite-polarity pairs | Never merged, at any cosine, neither by `remember` nor by consolidation; always flagged | "Always run X" and "Never run X" are near-identical strings (cosine 0.93 on the fixture). Merging them would silently replace a rule by its opposite. |
| Scope grant | `grantFor(kind, agentId)`: principal and conversation agents get `agent_private` (own) plus `shared`; the critic gets `critic` plus `shared`; specialists get nothing (the principal relays what they need in the brief) | ADR 0002 "Scope grant", made concrete. `recall` re-checks the grant: a private scope needs `ownerAgentId` equal to the asking agent, otherwise the scope is denied and recorded in the result. |
| Token accounting | `estimateTokens = ceil(chars / 4)` unless the caller passes a tokenizer; every rendered segment is charged with the newline that joins it; the agent's `instructions.md` is charged first and a file larger than the whole budget is an error | The sum of the parts is then never below the count of the rendered block, so `tokens <= maxTokens` holds for the block the runtime injects, not only for the planner's arithmetic. |
| Usage counters | `hit_count` and `last_used` on the row and in the file; no `lesson_use` table yet | The Phase 4 gate needs per-session totals, which the runtime logs; per-load rows with `cited` come with the critic wiring that can set them. |

## Consequences

- `docs/maintainers/memory.md` documents the keys, thresholds and formula; a change to any of
  them is a change to this table too (supersede this ADR rather than editing it).
- The embedder name is part of every stored vector's meaning: changing the default options
  changes the name, and `reconcile` re-embeds every file of a root whose `index.json` names
  another embedder, width or format (a root never reconciled has no marker and is re-embedded
  once). The runtime is expected to reconcile every granted root at start, so a name change
  without a length change is caught there; `fr memory reindex` (once the CLI lands) only forces
  the same walk.
- The write side of the privacy rule is in `remember` (`agentId` must equal the owner of a
  private write; no private id in a critic or shared text), the read side in `recall`. Direct
  callers that omit `agentId` are trusted; runtime code goes through `MemoryService`.
- The contradiction heuristic has false negatives (contradictions without a polarity word) and
  tolerates them: a missed contradiction is still visible as two lessons in the memory view.

## Alternatives considered

- Keep ADR 0002's 1024-bucket trigram embedder: four times the row size for no measurable gain on
  the fixtures; the option object makes it a one-line experiment if the eval disagrees.
- A separate `lesson_vector` table with float32 blobs: cleaner for a large corpus, but the schema
  shipped with a JSON column and the corpus is thousands of rows, not millions (ADR 0001).
- Model-judged contradictions from day one: a model call per candidate pair under the
  consolidation budget. Deferred; the report shape does not change when it is added.
- Letting `remember` supersede an opposite-polarity lesson: it is the literal "rewrite the
  record", but it hides a conflict the human should decide. Rejected.
