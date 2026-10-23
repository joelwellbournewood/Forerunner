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

### Commits

All on `wave/w2-chat-memory` above the start commit `b1804e3`. Each commit ends with the
trailer `Claude-Build: managed-agent w2-chat-memory build`.

1. `memory:` the docs search (`packages/memory`).
2. `commands:` `memory.record` and its parser phrases (`packages/commands`).
3. `runtime:` chat retrieval, the memory port and the daemon wiring (`packages/runtime`).
4. `docs:` the maintainer docs (runtime, memory, commands) and ADR 0061.
5. `status:` this build report.
6. `status:` the J.1 and O.2 rows set to done in `docs/requirements.md`, the two rows removed
   from `docs/status/BLOCKERS.md`, `docs/status/PROGRESS.md` updated, and 0061 indexed in
   `docs/decisions/README.md`.

The trailers of the first build were written with an uppercase `BUILD`. The six commits were
re-applied unchanged with `git format-patch` and `git am` over the same start commit, with the
trailer corrected. The tree before and after is identical (`git diff` between the two was
empty).

### Commands run and results (2026-10-23, final tree)

Typecheck (`pnpm typecheck`), output as printed:

```
> forerunner@0.1.0 typecheck /workspace/repo
> tsc -p tsconfig.node.json --noEmit && pnpm -r --filter "./apps/*" --if-present typecheck

Scope: 4 of 21 workspace projects
apps/approvals-web typecheck$ tsc -p tsconfig.json --noEmit
apps/desktop typecheck$ echo 'no TypeScript in the desktop shell; see @forerunner/ui'
apps/mobile typecheck$ echo 'no TypeScript in the mobile shell; see @forerunner/ui'
apps/ui typecheck$ tsc -p tsconfig.json --noEmit
apps/mobile typecheck: Done
apps/desktop typecheck: Done
apps/approvals-web typecheck: Done
apps/ui typecheck: Done
exit 0
```

Lint (`pnpm lint`), tail of the output:

```
Diagnostics not shown: 39.
Checked 1164 files in 2s. No fixes applied.
Found 59 warnings.
exit 0
```

The 59 warnings are all in files this item does not touch.
`pnpm exec biome check <the 18 changed .ts files>` reports no diagnostics:

```
Checked 18 files in 106ms. No fixes applied.
```

Paths, docs, links and secrets:

```
$ node scripts/check-paths.mjs
check-paths: ok (990 files).
$ node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk
docs-check: ok (27 files).
$ node scripts/link-check.mjs
link-check: ok (109 files).
$ pnpm secrets:scan
secret-scan: clean (1417 files).
```

Tests of the touched packages, run from the repository root:

```
$ pnpm exec vitest run --project unit packages/memory/test packages/commands/test
 Test Files  21 passed (21)
      Tests  252 passed (252)
$ pnpm exec vitest run --project unit packages/memory/test
 Test Files  12 passed (12)
      Tests  113 passed (113)
$ pnpm exec vitest run --project unit packages/commands/test
 Test Files  9 passed (9)
      Tests  139 passed (139)
$ pnpm exec vitest run --project unit packages/runtime/test
 Test Files  116 passed (116)
      Tests  1009 passed | 1 skipped (1010)
$ pnpm exec vitest run --project unit packages/runtime/test/conversation.test.ts packages/runtime/test/loop-docs.test.ts packages/runtime/test/docs-scaffold.test.ts packages/runtime/test/closeout-conversation.test.ts packages/runtime/test/live-chat.test.ts packages/memory/test/docs-search.test.ts packages/commands/test/commands.test.ts packages/commands/test/intent.test.ts
 Test Files  8 passed (8)
      Tests  132 passed (132)
$ pnpm exec vitest run --project integration packages/runtime/test packages/memory/test packages/commands/test
 Test Files  2 skipped (2)
      Tests  5 skipped (5)
```

The integration files need Postgres or Docker, which this sandbox does not have:
`sandbox.integration.test.ts` and `postgres.integration.test.ts`.

Neighbouring suites:

```
$ pnpm exec vitest run --project e2e tests/e2e/scenarios/phase5-gate.integration.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)
$ pnpm exec vitest run --project e2e tests/e2e/scenarios/03-voice.scenario.test.ts tests/e2e/scenarios/09-phone.scenario.test.ts tests/e2e/scenarios/phase4-gate.integration.test.ts
 Test Files  3 passed (3)
      Tests  4 passed | 1 todo (5)
$ pnpm --filter @forerunner/ui test
 Test Files  42 passed (42)
      Tests  256 passed (256)
$ pnpm --filter @forerunner/approvals-web test
 Test Files  10 passed (10)
      Tests  57 passed (57)
$ pnpm exec vitest run --project unit scripts
 Test Files  10 passed (10)
      Tests  97 passed | 2 skipped | 1 todo (100)
```

Full check (`pnpm check`), relevant lines:

```
check-paths: ok (990 files).
 Test Files  272 passed (272)
      Tests  2718 passed | 4 skipped | 1 todo (2723)
link-check: ok (109 files).
secret-scan: clean (1417 files).
EXIT 0
```

Inside `pnpm check`, `pnpm docs:check` diffs against `origin/main`. This checkout has no such
ref, so the script prints that it cannot diff and passes. The check against the item's base
above is the real one.

Failing first: before the code existed, the new tests failed.
`packages/runtime/test/conversation.test.ts` had 20 failures (`memoryCommandPort is not a
function`), and `packages/commands/test` had 7 failures (unknown command `memory.record` and
the unmatched lesson phrases).

### Export and patch check

```
$ git format-patch --stdout $(cat /tmp/start-sha)..HEAD > /mnt/session/outputs/w2-chat-memory.patch
$ git worktree add --detach /tmp/clean b1804e3     # clean checkout of the start commit
$ cd /tmp/clean && git rev-parse --short HEAD && git status --short | wc -l
b1804e3
0
$ git apply --check -v /mnt/session/outputs/w2-chat-memory.patch
...
Checking patch docs/decisions/README.md...
Checking patch docs/requirements.md...
Checking patch docs/status/BLOCKERS.md...
Checking patch docs/status/PROGRESS.md...
exit 0
```

The check was run on the patch before this report was committed, and again on the final
exported patch: `git apply --check` exits 0 both times. The patch does not apply to
`b31c2e5`, the branch's old head, because that commit lacks 80 base commits; `b1804e3` is the
base the brief names.

### What is left open and why

- **Registry prompt.** The `conversation-agent` prompt in the registry repository
  (`evals/registry` is a synced copy) does not yet mention cited paths or the memory tool. The
  docs block header and the lessons header tell the model directly, and `ChatReply.sources`
  names the sources in code whatever the model writes.
- **No live model.** The answer that cites the path is a scripted fake-provider reply. Live
  citation quality is not measured here because no model key is available.
- **Docs search limits.** The search is lexical and runs on every turn with no index (see the
  Known issues in memory.md and runtime.md). The docs clone is read as last checked out and is
  not fetched for the chat.
- **Integration suites.** They need Postgres or Docker and were skipped in this sandbox.
