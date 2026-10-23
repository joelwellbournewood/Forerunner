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

Output excerpts are copied from the terminal; colour codes stripped.

```
$ pnpm install --frozen-lockfile
Done in 20.1s using pnpm v10.28.0

$ pnpm typecheck; echo "typecheck exit=$?"
apps/mobile typecheck: Done
apps/desktop typecheck: Done
apps/approvals-web typecheck: Done
apps/ui typecheck: Done
typecheck exit=0            # and `grep -c "error TS"` on the full output: 0

$ pnpm lint; echo "lint exit=$?"
Checked 1158 files in 2s. No fixes applied.
Found 59 warnings.          # pre-existing; no errors
lint exit=0

$ pnpm exec vitest run --project unit packages/runtime/test
 Test Files  114 passed (114)
      Tests  989 passed | 1 skipped (990)

$ pnpm exec vitest run --project unit packages/runtime/test/closeout-sessions.test.ts \
    packages/runtime/test/loop-critic.test.ts packages/runtime/test/session.test.ts
 ✓ unit packages/runtime/test/session.test.ts (13 tests)
 ✓ unit packages/runtime/test/closeout-sessions.test.ts (12 tests)
 ✓ unit packages/runtime/test/loop-critic.test.ts (15 tests)
 Test Files  3 passed (3)
      Tests  40 passed (40)

# the same closeout file with the end re-check in runner.ts replaced by `void 0` (reverted after)
 × a requires_ack stop sent during the last task is read before the summary cache and the handoff are written, ...
 × an ordinary message sent during the last task is read before the writes and named in the handoff; ...
 × a pause from the pause port during the last task is acknowledged and the row ends stopped, not left paused
 × a session already stopped for another reason keeps its reason; ...
      Tests  4 failed | 8 passed (12)
# with the checklist carry-over disabled (reverted after)
      Tests  1 failed | 11 passed (12)   # the ordinary-message test

$ pnpm exec vitest run --project integration packages/runtime/test
 Test Files  1 skipped (1)
      Tests  4 skipped (4)  # needs Postgres; FORERUNNER_TEST_PG unset

$ pnpm exec vitest run --project e2e tests/e2e/scenarios/01-good-day.scenario.test.ts \
    tests/e2e/scenarios/04-collision.scenario.test.ts
 Test Files  2 passed (2)
      Tests  2 passed (2)

$ pnpm check
check-paths: ok (984 files).
 Test Files  269 passed (269)
      Tests  2678 passed | 4 skipped | 1 todo (2683)
docs-check: cannot diff against origin/main (...); nothing to check.   # no origin/main in this clone
link-check: ok (105 files).
secret-scan: clean (1407 files).

$ node scripts/docs-check.mjs --base e2bfb1e
docs-check: ok (11 files).
$ node scripts/docs-check.mjs --base 1490c6d
docs-check: ok (10 files).   # before this report's commit

$ git log --oneline 1490c6d..HEAD     # exactly this run's commits (before the commit adding this text)
336696a status: build report for w3-e4-recheck
92ae3a1 status: E.4 rows name the carry-over of a message read at the session end
8f6514f runtime: a message read at the end of a session reaches the next session's brief
f6b45d4 status: E.4 done, its blocker row resolved, progress log for w3-e4-recheck
7698dd9 runtime: the session-end handoff says what was written after an end-of-session stop

$ git format-patch --stdout 1490c6d..HEAD > /tmp/pre.patch
$ git worktree add -q --detach /tmp/clean 1490c6d && cd /tmp/clean
$ git rev-parse --short HEAD; git status --short | wc -l
1490c6d
0
$ git apply --check -v /tmp/pre.patch
Checking patch packages/runtime/test/loop-critic.test.ts...
Checking patch docs/status/BLOCKERS.md...
Checking patch docs/status/PROGRESS.md...
Checking patch docs/status/reviews/w3-e4-recheck.md...
apply --check exit=0
$ git worktree remove --force /tmp/clean
```

The exported `/mnt/session/outputs/w3-e4-recheck.patch` is regenerated after the commit that
adds this text and checked again the same way; that final result is appended to the copy of
this report in `/mnt/session/outputs/w3-e4-recheck-report.md` (a committed file cannot hold
the check of the patch that contains it).

### Branch history below the starting commit

The branch held two commits from an earlier, interrupted attempt before this run started:
fdc5f8e "runtime: the inbox is re-checked before the session-end writes" (the runner change)
and 1490c6d "wip: files left uncommitted at the end of the build run (not verified)" (the
E.4 tests). Both carry the trailer `Claude-Build: github-actions build-item w3-e4-recheck
build` of that run, and 1490c6d is not in the `area: what changed` form. They sit below the
starting commit (1490c6d), so they are not in the exported patch, and rewriting them would
need a rebase, which the working rules forbid. This run read both, ran their tests, and kept
their content. Everything after them is in this run's five commits, all in the
`area: what changed` form with the trailer `Claude-Build: managed-agent w3-e4-recheck build`.
The integration step can squash or reword the two older commits when it merges the branch.

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
