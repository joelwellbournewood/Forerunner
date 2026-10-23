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

## Review

Stage REVIEW AND FIX, reviewer: independent (managed agent), 2026-10-23. Starting commit
4742e03 on `wave/w3-e4-recheck`; base `origin/ccr-4d8a843c-1k9syk` at f1948dd.

**Verdict: revise. Score: 72/100.** The core of the brief is built and proven: the end
re-check runs before every step-4 write, a `requires_ack` stop sent during the last task is
read (and acted on) before the summary cache, the peers' handoff and the human note are written,
and the handoff names it. Three behaviours around it are wrong on realistic paths (findings 1–3),
and the status rows still say the item is unreviewed (finding 4).

### Requirements checked

- [x] Spec E.4 "inbox re-checked ... before any write to shared state": `recheckInbox(..., { atEnd: true })`
  is the first statement of step 4 in `runner.ts`, before the status doc, memory, promotions,
  the summary cache, the handoffs, the human note and the session record.
- [x] Brief: a `requires_ack` stop sent during the last task is read before the handoff and the
  summary cache are written, `read_at` set — `closeout-sessions.test.ts` test 1 records `read_at`
  at the moment of each write (spies on `project.patch` and `message.send`); with the re-check
  removed the test fails (`read_at` null).
- [x] A stop read there ends the session `stopped` / `stopped_by_message` with a handoff naming
  it and saying what was and was not written — partly: the written/not-written lists omit
  writes (finding 3).
- [x] A pause defers nothing and is acknowledged — but the row is left `paused` when the
  session ends `failed` (finding 1).
- [x] An ordinary message is delivered and read (`read_at`) and summarised in the handoff —
  test 2; the carry-over into the next brief is lost on one path (finding 2).
- [x] Task states consistent (both `done`, unclaimed) — test 1.
- [x] The step-4 writes stay where they were (no reordering beyond the re-check).
- [x] Privacy: `end_inbox` carries ids, types, senders and kinds, never message bodies
  (test 1 asserts the words are absent); no secret or body reaches peers.
- [x] Docs: runtime.md section matches the code except as noted in findings 1–3; requirements
  E.4 `done`.
- [x] Base branch: a trial merge of `origin/ccr-4d8a843c-1k9syk` (f1948dd) into the branch in a
  throwaway worktree has one textual conflict in `runner.ts` (the base's `summarizeMerges` and
  this item's `summarizeEndInbox` / `endWritesAccount` added at the same spot; keeping both
  resolves it) and no semantic conflict: the runtime unit suite on the merged tree passes
  (117 files, 1043 passed, 1 skipped). The base's J.9 merge step runs inside the task loop,
  before the end re-check, so it is not an after-stop write.

### Findings

1. **medium** — `packages/runtime/src/session/runner.ts:1330` (final `setStatus`). A pause that
   lands while the session is running marks the row `paused` (pause port); when that session
   then ends `failed` (e.g. the planner throws), the end re-check reads the pause, but
   `setStatus(paused -> failed)` is not a legal move (`workflow.ts`: `paused: [running,
   stopped, killed]`), the error is swallowed, and the row stays `paused` with `ended_at` set.
   `session.active` counts `paused`, so the agent's next session is refused with
   `claim_conflict` forever. runtime.md and session-ports.ts say the row "leaves `paused`".
   Verified with a throwaway test (pause port called from the planner, planner throws): the
   row read `paused`, the handoff named the pause, and the next `start` threw `claim_conflict`.
   Needed: the final status is reached from `paused` (through `running` when the move is not
   direct), with a test.
   Resolution: fixed in 0580bca — the final `setStatus` goes `paused -> running -> <final>` when
   `paused` cannot move to the final status directly; test "a pause read at the end of a session
   that fails does not leave the row paused; the next session starts" (fails without the fix:
   row `paused`, next start `claim_conflict`).
2. **medium** — `packages/runtime/src/session/checklist.ts:43` (`carriedFromLastEnd`). An
   ordinary message read by the end re-check is marked read and carried into the next brief
   only from the handoff of the *last ended* session. When the next session ends before its
   startup receipts (the peer feed or another startup step throws, the kill switch during
   startup, a checklist error), that session's handoff has no `end_inbox`, so the session
   after it carries nothing: the message stays read, never acted on and never in any brief —
   lost. Before this branch an unread message survived such a session. Verified with a
   throwaway test (session N reads an `info` at its end, session N+1 fails in `peersOf`,
   session N+2's brief does not contain the message, `acted_at` null). Needed: a session that
   did not take its inbox in passes the carry on, with a test.
   Resolution: fixed in 0580bca — a session whose startup receipts never ran calls the exported
   `carriedFromLastEnd` in step 4 and records the messages in `handoff.carried_forward`, which
   the checklist reads alongside `end_inbox.read`; test "a message read at the end is carried
   past a session that ended before its startup receipts" (fails without the fix: no
   `carried_forward`, the message absent from the next brief).
3. **low** — `packages/runtime/src/session/runner.ts:1169` and `endWritesAccount` (≈1820).
   `after_stop` claims to say what was and was not written after the stop was read, but the
   memory record (lessons into the agent's memory, the rejected-lessons warning to the human)
   and the cross-project promotion reviews (shared store, offers to other projects) run after
   the re-check and appear in neither list. Verified by reading step 4 (memory at ≈1186,
   promotions at ≈1262, both after the re-check at 1055 and after `after_stop` is computed at
   1169). Needed: both entries in the account, computed after those writes, with a test that
   records a lesson after an end-of-session stop.
   Resolution: fixed in 0580bca — `after_stop` is filled in after memory and promotions and
   lists `memory`, `lesson_warning` and `promotions` as written or not written; test "a stop
   read at the end names the memory write that followed it in after_stop", and test 1's
   expected `not_written` now includes the three entries (both fail without the fix).
4. **low** — `docs/status/BLOCKERS.md` E.4 row and `docs/status/PROGRESS.md` (2026-10-23 entry)
   say "builder-verified, no independent review yet"; after this review they must name it and
   its outcome.
   Resolution: fixed in eb72017 — the BLOCKERS E.4 row and a new PROGRESS log entry name this
   review, its verdict and the fixes; the "review before the merge" re-test is removed.

### After the fixes

Checks on the branch after 0580bca and eb72017 (2026-10-23): `pnpm typecheck` exit 0;
`pnpm lint` exit 0 (59 pre-existing warnings, no errors); `pnpm exec vitest run --project unit
packages/runtime/test` 114 files, 992 passed, 1 skipped; `node scripts/docs-check.mjs --base
4742e03` ok. With `runner.ts` and `checklist.ts` reverted to 4742e03, `closeout-sessions.test.ts`
has 4 failed / 11 passed (the three new tests and test 1's account).

## Rebase

2026-10-23: `wave/w3-e4-recheck` (was 5d1931c on merge base 82a6295) rebased onto
`origin/ccr-4d8a843c-1k9syk` at cac6fee (181 commits ahead of the old merge base: J.9 merge
step, B.5 plan reasons, E.1 triggers, S.12, S.32 and others). The twelve commits replay one to
one (old → new: fdc5f8e → 8bc9b84, 1490c6d → 7b6567e, 23b57e1 → 484eb06, f22cd12 → f09e214,
6deba4b → 31491e9, 83adad0 → 8594b1a, 67d6931 → 75a79e7, 4742e03 → 135b66f, cf1b804 →
14b9f0f, 46ab224 → ebf2936, 8fbef05 → cfa923c, 5d1931c → 0ab2a39); the short hashes in the
sections above are the pre-rebase ones.

Conflicts and how they were resolved:

1. `packages/runtime/src/session/runner.ts` (on fdc5f8e): the base added `summarizeMerges`
   (J.9, the merge step's outcomes in the summary) where the branch added `summarizeEndInbox`
   after `summarize`. Both functions kept, in that order; `summarize` calls both
   (`...summarizeMerges(x.merges ?? [])` then the end-inbox line) and the handoff carries both
   the base's `merges` and the branch's `end_inbox` (git merged those hunks itself). The
   base's `setPlan` (B.5) and `mergeReviewed` (J.9) run during planning and tasks, before the
   end re-check, so `after_stop` needs no new entry for them.
2. `docs/status/PROGRESS.md` (on f22cd12): the base's new log entries (w2-s32-indicator,
   w2-s12-unlock-card, w3-e1-triggers, w4-fcm-sender) and the branch's E.4 entry all kept, the
   branch's on top (newest first).
3. `docs/status/BLOCKERS.md` (on f22cd12, 83adad0, 8fbef05): the base's E.1, S.12 and S.32
   rows kept as the base has them; the E.4 row is the branch's (resolved, reviewed, eight
   tests) with the base's added clause merged into it: the same `recheckInbox` also collects
   what the human says during the session (O.9, ADR 0078, `live-chat.test.ts`), the
   end-of-session re-check included.

`docs/requirements.md` and `docs/maintainers/runtime.md` merged without conflict (the E.4 row
`done`; the runtime.md paragraph "The inbox before the session-end writes" sits before the
base's O.9 paragraph).

Checks after the rebase (on the rebased head, 2026-10-23): `pnpm typecheck` exit 0; `pnpm lint`
exit 0 (59 warnings, no errors); `pnpm exec vitest run --project unit packages/runtime/test`
128 files, 1140 passed, 1 skipped; `--project integration packages/runtime/test` 1 file, 4
skipped (`sandbox.integration.test.ts`, no Docker daemon); the E.4 block of
`closeout-sessions.test.ts` 8 passed (the file 15, `session.test.ts` 13, `loop-critic.test.ts`
15); `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk` ok (11 files).
