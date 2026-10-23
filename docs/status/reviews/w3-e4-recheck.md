# w3-e4-recheck — the inbox is re-checked before the session-end writes (E.4)

## Build report

Item `w3-e4-recheck`, stage BUILD, branch `wave/w3-e4-recheck`, base
`ccr-4d8a843c-1k9syk` at e2bfb1e. Starting commit of this run: 1490c6d (the branch already held
fdc5f8e, the runner change, and 1490c6d, a `wip:` snapshot of the tests; both were read, verified
and kept). ADR: none (the brief calls for none).

### What was built

- `packages/runtime/src/session/runner.ts`, step 4: `recheckInbox(..., { atEnd: true })` runs
  before every session-end write (status doc, project `summary_cache`, handoffs to peers, the
  note to the human, the session record). Those writes stay where and as they were; the task
  states were already written as each task ended.
  - A stop or pause read there ends a session that would otherwise end `completed` /
    `budget_finish_current` as `stopped` with `stop_reason: stopped_by_message`; a
    `requires_ack` stop or pause is marked acted on. The handoff carries
    `end_inbox: { read, stopped_by, after_stop: { written, not_written } }`: what was still
    written after the stop was read (`task_states`, `summary_cache`, `handoffs`, `human_note`,
    `session_record`, `status_doc` when the docs port wrote it) and what was not (`task_claims`,
    plus any of those that did not apply). The summary names the stop message.
  - A pause at the end defers nothing and is acknowledged by reading it; the row moves
    `paused -> stopped` instead of staying `paused`.
  - An ordinary message is delivered and read (`read_at`), named in `handoff.end_inbox.read`
    (ids, type, sender, kind; never the words) and summarised ("Read before the session-end
    writes: N message(s).") in the summary the peers' handoff and the human note carry.
  - A session already ended for another reason (killed, out of budget, plan filed) keeps it.
  - Said lines (O.9) are left for the next brief; a failing re-check is a warning event.
- `packages/runtime/src/session/checklist.ts` and `brief.ts`: found during verification — the
  startup checklist lists unread messages only, so a message read by the end re-check (a peer's
  request, the critic's "Revision requested") would vanish from the next brief
  (`loop-critic.test.ts` failed on exactly that). An ordinary message read at the end is now
  read but not acted on, and the next session's checklist carries every such message the last
  ended session named in `handoff.end_inbox.read` and nobody acted on into
  `brief.inbox.unread` once (`readAtLastSessionEnd`, rendered "read at the end of the last
  session"); that session's startup receipts act on it as before. Stops and pauses are not
  carried.
- `packages/runtime/src/wiring/session-ports.ts`: the doc comment no longer says an
  end-of-session pause waits for the next session.
- Docs: `docs/maintainers/runtime.md` ("The inbox before the session-end writes (spec E.4)");
  `docs/requirements.md` E.4 → `done`; `docs/status/BLOCKERS.md` E.4 row resolved;
  `docs/status/PROGRESS.md` log entry.

### Tests that prove it

`packages/runtime/test/closeout-sessions.test.ts`, block "closeout: the inbox is re-checked
before the session-end writes (E.4)", five tests:
1. A `requires_ack` stop sent during the last task: spies on `project.patch` (summary cache)
   and `message.send` (handoff, human note) record the stop's `read_at` at the moment of each
   write and it equals the final `read_at` (read before the writes); `acted_at` set; both task
   states `done` and unclaimed; session `stopped` / `stopped_by_message`; handoff names it with
   `after_stop`; the words are not in the handoff; the next session's brief does not carry it.
2. An ordinary `info` message during the last task: read before the writes, not acted, named in
   the handoff and in the peers' handoff body; the session completes; the next session's brief
   carries it once (`readAtLastSessionEnd`) and acts on it; the one after does not see it.
3. A pause from the real pause port (`sessionPausePorts`) during the last task: read, the row
   ends `stopped` not `paused`, the handoff and summary name it.
4. A session out of budget keeps `budget_exceeded`; the stop is named with `stopped_by: null`.
5. An empty inbox adds no event, handoff field or summary line.

Fails without the change: with the end re-check removed, tests 1–4 fail (4 failed, 8 passed);
with the checklist carry-over disabled, test 2 fails. `packages/runtime/test/loop-critic.test.ts`
("revise: ...") now asserts the revision request is read at the end, not acted, and named in the
handoff (it asserted an unread row before; the behaviour changed by spec E.4, the message is
not lost: the next brief carries it).

### Commands and results (2026-10-23, Linux build box)

- `pnpm install --frozen-lockfile` — done.
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0 (warnings pre-existing, none in touched files beyond the existing ones).
- `pnpm exec vitest run --project unit packages/runtime/test` — 114 test files passed, 989
  tests passed, 1 skipped.
- `pnpm exec vitest run --project unit packages/runtime/test/closeout-sessions.test.ts
  packages/runtime/test/loop-critic.test.ts packages/runtime/test/session.test.ts` — 3 files,
  40 tests passed.
- `pnpm exec vitest run --project integration packages/runtime/test` — 1 file, 4 tests skipped
  (needs Postgres; `FORERUNNER_TEST_PG` unset).
- `pnpm exec vitest run --project e2e tests/e2e/scenarios/01-good-day.scenario.test.ts
  tests/e2e/scenarios/04-collision.scenario.test.ts` (E.4's other test files) — 2 files, 2
  tests passed.
- `pnpm check` — lint, paths (984 files ok), typecheck, unit project 269 files passed / 2678
  tests passed, 4 skipped, 1 todo; link-check ok (105 files); secret-scan clean (1407 files).
  Its `docs:check` step has no `origin/main` in this clone and checks nothing, so:
- `node scripts/docs-check.mjs --base e2bfb1e` and `--base 1490c6d` — `docs-check: ok (10 files)`.

### Left open

- No independent review yet (the next stage). The requirement totals in the PROGRESS milestone
  table and gates.md criterion 1 move by one (E.4 in progress → done) at integration, so the
  parallel items do not conflict on that line.
- Seen, not changed (outside the item): `runStartupChecklist`'s `lastSession` uses
  `session.latestForAgent`, and the runner inserts the session row before the checklist, so
  `brief.lastSession` may name the session being started rather than the previous one. The
  carry-over above does not rely on it (it picks the latest session with `ended_at`). Worth a
  separate item with a failing test.
- The Postgres integration file of the runtime package was not run (no Postgres here).
