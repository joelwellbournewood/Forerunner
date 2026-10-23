# w2-chat-memory

Item: the quick chat searches the project docs and the principal's lessons under a token
budget, and a lesson stated in chat is recorded (requirements J.1 and O.2; O.1 and O.3 are
context and unchanged). Branch `wave/w2-chat-memory`, base `ccr-4d8a843c-1k9syk` at `b1804e3`.

## Build report

### Starting point

The branch `wave/w2-chat-memory` on origin was at `b31c2e5`. That commit is an ancestor of
the base, and the branch had no commits of its own. `git merge --no-edit
origin/ccr-4d8a843c-1k9syk` fast-forwarded it to `b1804e3`, the base the brief names. The
starting commit recorded for the export is therefore `b1804e3`
(`git rev-parse HEAD > /tmp/start-sha` after the fast-forward). Exporting from `b31c2e5`
would have put 80 base commits, merges included, into the patch.

### What was built

1. **Docs search in `@forerunner/memory`** (`packages/memory/src/docs-search.ts`, spec J.1).
   - `collectDocFiles` reads `README.md` plus the markdown under `docs/`. It skips symlinks,
     hidden directories and `node_modules`, and caps the number and size of files.
   - `chunkMarkdown` cuts the text into sections at each heading and labels each section with
     its heading trail. It drops frontmatter and empty sections, and splits sections longer
     than 300 tokens.
   - `rankChunks` ranks the sections with BM25 over word terms, with stopwords removed and a
     light stem.
   - `searchDocs` returns the best sections under `maxTokens`. Each part is charged as it is
     picked, then the rendered block is measured with the caller's counter and cut until
     `tokensUsed = countTokens(block) <= maxTokens`.
   - A section that contains a credential shape is never rendered and is listed in `excluded`.
   - Each section is labelled `## [<path> > <heading>]` so the answer can cite it.
2. **`memory.record` command in `@forerunner/commands`** (`src/commands/memory.ts`, spec O.2).
   - Low risk and undoable. It goes through the new `CommandPorts.memory`
     (`MemoryCommandPort`) into the private memory of the human's own principal, for the named
     or active project. With no project, the lesson applies to every project.
   - The source is `human:<id>;<chat|voice>:<conversation session>`.
   - The reply reads the stored text back:
     `Recorded a lesson in Alice's memory for Game: "...". Undo.`
   - It is refused without a principal agent, for an agent the human does not own, or without
     the port (`unavailable`).
   - Parser phrases: "remember that ...", "lesson: ...", "lesson learned: ...",
     "merk dir, dass ...", "Lektion: ..." and "Lehre: ...". These are matched before notes, so
     "remember to ..." and "note that ..." are still `note.add`.
   - On the model path the command is the `memory_record` tool.
3. **Runtime** (`packages/runtime`).
   - `ConversationAgent` has new options: `memory` (recall port), `docsDir(projectId)` and
     `retrieval { docsMaxTokens = 1200, lessonsMaxTokens = 600 }`.
   - On every model turn, `retrieve()` adds to the volatile first message (never the cached
     system prompt):
     - the principal's lessons, recalled with the principal grant, and only when the agent is
       a principal or conversation agent owned by the human asking;
     - the project's best doc sections, wrapped in the data envelope with their paths.
   - Each budget is measured with the provider's `countTokens` on the exact text sent:
     - The lessons are recalled with that counter (`MemoryRecallRequest.countTokens` is new),
       and the block is dropped if it still measures over budget.
     - The docs envelope is measured after wrapping. If it is over budget, the search runs
       again with the overshoot taken off, until it fits.
   - `ChatReply.sources` and the `chat.reply` event (`sources`, plus `retrieval`: budget,
     tokens, hits, dropped) record what the model was given.
   - The built-in prompt asks the model to cite the bracketed path and to record stated lessons
     with the memory tool.
   - `MemoryLoop.recordStated` and `forgetStated`, exposed as `memoryCommandPort(memory)`:
     - check that the human owns the agent;
     - run the lesson injection screen and the memory lint;
     - record with the human as author and confidence 0.8;
     - on undo, retire the lesson and restore any lesson a merge superseded.
   - `ProjectDocs.docsDirFor(project)` picks the docs location without cloning or fetching:
     a linked local folder, else the docs clone, else the data-dir workspace.
   - `composeRuntime` connects these: the registry's memory port, plus the chat's `memory` and
     `docsDir`.
4. **Docs.** `docs/maintainers/memory.md` (Docs search, tests, known issues),
   `commands.md` (command table, `memory.record`, parser phrases, tests),
   `runtime.md` (Memory loop, Project docs `docsDirFor`, Conversation agent retrieval, Tests,
   Known issues). ADR `docs/decisions/0061-chat-retrieval-budgets-and-stated-lessons.md`
   records the budgets, the per-turn lexical docs search and the recording rule.

### Tests that prove it

- `packages/runtime/test/conversation.test.ts`, describe "chat context: project docs search
  and the principal's lessons" (6 new tests):
  - A question about a doc puts the Deploy section in the volatile message inside the
    envelope, labelled `[docs/runbook.md > Runbook > Deploy]`. A section sharing no term is
    left out, the system prompt is untouched, the answer cites the path, and `sources` and the
    event list the section.
  - The budget holds: a 61-file docs tree is cut to `docsMaxTokens: 500`, measured with the
    provider's counter on the envelope as sent, and the event's `dropped` count is above 0.
  - The relevant lesson is in context and an unrelated one is not, under the 600-token default.
  - "remember that ..." is recorded with no model call: a private lesson of the principal for
    the active project, with the human and the conversation session as source. The lesson is
    read back, appears in the change log, is retrieved for the next question, and is retired
    by "undo".
  - The model's `memory_record` tool records a lesson the human stated in other words.
  - Another human's memory is never used:
    - another human's private lesson on the same project is never in the context;
    - a turn naming another human's agent retrieves no lessons;
    - recording into another human's agent is refused.

    With the owner check disabled, this test fails (checked by hand, then the check was
    restored).
- `packages/memory/test/docs-search.test.ts` (7 tests): file collection (symlink out of the
  tree skipped), chunking, splitting, ranking and citation labels, a budget measured under a
  non-default counter, empty and tiny budgets, credential shapes excluded.
- `packages/commands/test/commands.test.ts` (3 new tests: read-back, source, low risk, undo,
  another project or none, refusals) and `intent.test.ts` (6 new phrase cases, including
  "remember to" staying a note).
- `packages/runtime/test/loop-docs.test.ts` (`docsDirFor`, 1 new test) and
  `docs-scaffold.test.ts` (1 new test: the composed daemon's `/chat` searches a project's
  workspace docs and records a stated lesson into `rt.memory`).

Failing first: the runtime and commands tests were run before the code and failed
(`memoryCommandPort is not a function`: 20 failed in `conversation.test.ts`; 7 failed in the
commands package).

### Commands run and results (2026-10-23)

- `pnpm install --frozen-lockfile`: done.
- `pnpm typecheck`: clean (node project plus apps). Run before every Biome write.
- `pnpm lint`: exit 0. The warnings are all in files this item does not touch;
  `pnpm exec biome check <the 18 changed .ts files>` reports no diagnostics.
- `node scripts/check-paths.mjs`: `check-paths: ok (990 files)`.
- `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk`: `docs-check: ok (22 files)`.
- `node scripts/link-check.mjs`: `link-check: ok (108 files)`.
- `pnpm secrets:scan`: `secret-scan: clean (1416 files)`.
- `pnpm exec vitest run --project unit packages/memory/test`: 12 files, 113 tests passed.
- `pnpm exec vitest run --project unit packages/commands/test`: 9 files, 139 tests passed.
- `pnpm exec vitest run --project unit packages/runtime/test`: 116 files, 1009 passed,
  1 skipped.
- Targeted run (`conversation`, `loop-docs`, `docs-scaffold`, `closeout-conversation`,
  `live-chat`, `docs-search`, `commands`, `intent`): 8 files, 132 tests passed
  (`conversation.test.ts` alone has 21).
- `pnpm exec vitest run --project integration packages/runtime/test packages/memory/test packages/commands/test`:
  2 files, 5 tests, all skipped. They need Postgres or Docker, which this sandbox lacks.
- `pnpm exec vitest run --project e2e tests/e2e/scenarios/phase5-gate.integration.test.ts`:
  1 file, 4 tests passed.
- `pnpm exec vitest run --project e2e tests/e2e/scenarios/03-voice.scenario.test.ts tests/e2e/scenarios/09-phone.scenario.test.ts tests/e2e/scenarios/phase4-gate.integration.test.ts`:
  3 files, 4 passed, 1 todo.
- `pnpm --filter @forerunner/ui test`: 42 files, 256 tests passed.
  `pnpm --filter @forerunner/approvals-web test`: 10 files, 57 tests passed.
- `pnpm check`: lint, paths and typecheck pass. The tests give 272 files: 2717 passed,
  **1 failed**, 4 skipped, 1 todo.
  - The one failure is `scripts/closeout-docs.test.ts`, which requires every ADR to be indexed
    in `docs/decisions/README.md`.
  - The brief forbids editing that file; the index row is returned for the orchestrator.
  - With the row
    `| 0061 | Quick chat retrieval: docs and lessons under measured budgets; recording a stated lesson |`
    added locally (not committed), `scripts/closeout-docs.test.ts` passes 19 tests (1 todo).

### What is left open and why

- **ADR index row.** The `docs/decisions/README.md` row for 0061 is not committed (the rule
  says it is added centrally). Until it is, `pnpm check` fails on `closeout-docs.test.ts`.
- **Status files.** `docs/requirements.md`, `docs/status/BLOCKERS.md` and
  `docs/status/PROGRESS.md` are not edited, by rule; the row updates are in the final answer.
- **Registry prompt.** The `conversation-agent` prompt in the registry repository
  (`evals/registry` is a synced copy) does not yet mention cited paths or the memory tool. The
  docs block header and the lessons header tell the model directly, and `ChatReply.sources`
  names the sources in code whatever the model writes.
- **No live model.** The answer that cites the path is a scripted fake-provider reply. Live
  citation quality is not measured here because no model key is available.
- **Docs search limits.** The search is lexical and runs on every turn with no index (see the
  Known issues in memory.md and runtime.md). The docs clone is read as last checked out and is
  not fetched for the chat.
