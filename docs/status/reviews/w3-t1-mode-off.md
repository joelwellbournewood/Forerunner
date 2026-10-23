# w3-t1-mode-off — Email commands at sending mode off (T.1, ADR 0081)

## Build report

Item `w3-t1-mode-off`, stage build, branch `wave/w3-t1-mode-off`. The starting commit is
`ca842c1`: the `wip:` snapshot an earlier attempt left there, with no verification. The task
named base `e2bfb1e` (`ccr-4d8a843c-1k9syk`). The patch is the series `ca842c1..HEAD`. The
base branch was not merged or rebased in.

### What was decided

ADR 0081 (`docs/decisions/0081-email-commands-need-a-sending-mode.md`) settles the conflict
in the spec. One part says "Off: sends nothing" and the other says "replies to you are always
allowed". The ADR picks the safer of the two readings: **email commands need a sending mode
other than off.** At mode off the mailbox sends nothing, so it could not send the
acknowledgement either. The reply to the owner still goes out in every mode where commands
can be on. `EmailPolicy.checkSend` does not change.

### What was built

The wip snapshot already held the code below. This attempt checked it, fixed it and tested
it.

- **The settings store** (`packages/capabilities/src/email/types.ts`, `EmailSettingsStore`;
  this repository has no `settings.ts`, so the settings live in this file). Every writer goes
  through it.
  - **Turning commands on at mode off is refused.** It throws
    `ForerunnerError("validation", COMMANDS_NEED_SENDING_MODE)` with `details.reason:
    "commands_need_sending_mode"` and writes nothing. The daemon's `PUT` answers 400 with that
    plain sentence. The settings page on wave/w2-email-page will read the same validation.
  - **Switching the mode to off turns commands off.** This happens in the same write, and the
    other command settings are kept.
    - It writes one `email.settings` audit row with action `commands_switched_off`, the mode
      before and the human who made the change.
    - It calls the `onCommandsSwitchedOff` listeners.
    - A failing audit store or listener is logged and never undoes the write.
  - **`emailCommandsActive(config)`** means the toggle is on and the mode is not off.
- **The gate** (`commands.ts`) reads `emailCommandsActive`. A row stored before the rule
  (commands on at mode off) therefore obeys nothing.
- **The watcher** (`services/cloud-runner/src/email-watch.ts`): `EmailWatch.start` refuses to
  start at mode off. It gives `reason: EMAIL_WATCH_MODE_OFF_REASON` in `status`, which is also
  the runner's `/health` email state, and logs `email watch not started` at warn level. It
  builds its settings store with the runner's audit log.
- **The daemon** (`packages/runtime`):
  - `agentEmailPorts` passes the audit log to the store.
  - `compose.ts` binds `onCommandsSwitchedOff` to a new `email_commands_off` notification:
    urgency normal, link `/settings`, dedupe key `email-commands-off:<agent>:<at>`.
- **Fixes in this attempt:**
  - The shared email test fixture (`packages/capabilities/test/helpers/email-world.ts`) now
    turns commands on by default only when the mode is not off. Before this, three tests in
    `email-policy.test.ts` and `email-tools.test.ts` failed on the new refusal.
  - In the watcher, the class's doc comment had become separated from `EmailWatch` and is
    back above it.
  - Biome's import order in `types.ts`. The wip snapshot did not pass `pnpm lint`.

### Tests that prove it

Every test below is new.

- `packages/capabilities/test/email-settings.test.ts`, describe "email commands need a
  sending mode other than off (ADR 0081)", 5 tests:
  - turning commands on at off is refused with the message and nothing is written, including
    mode off and commands on in a single write;
  - every other mode accepts commands;
  - switching to off turns commands off and writes the audit row with the exact
    input/result JSON and the human. It also tells the listener with the message, and does
    the same when a form still ticks commands;
  - a row stored before the rule is not in force, and the next write turns it off;
  - a failing audit store or listener never undoes the switch-off.
- `packages/capabilities/test/email-commands.test.ts`, "obeys nothing at sending mode off
  …": the gate obeys nothing after the switch to off, or on a row stored before the rule. The
  handler ignores the mail and nothing is acted on. Without the gate change this test fails;
  I checked that by reverting the line.
- `services/cloud-runner/test/email-watch.test.ts`, "refuses to start at sending mode off even
  with commands on …": `start` returns `disabled` with `EMAIL_WATCH_MODE_OFF_REASON`, the
  status and the log line carry the reason, and a command mailed afterwards starts no session
  and gets no reply. Without the watcher check this test fails; I checked that by reverting
  the branch.
- `packages/runtime/test/email-routes-wiring.test.ts`, "ADR 0081: …": through the composed
  daemon, `PUT` mode off over commands on turns them off, writes the
  `commands_switched_off` row and sends an `email_commands_off` notification to the owner.
  `PUT` with commands on at mode off is a 400 carrying `COMMANDS_NEED_SENDING_MODE`.
- `packages/runtime/test/notifications-channels.test.ts`: checks the producer's shape and
  dedupe key and its normal urgency, and that it links to a route the shell opens.
- Kept green: `closeout-email-commands.test.ts`, where replies to the owner go out in read
  only, draft only, allowlist and full discretion, and the `email-policy.test.ts` mode matrix,
  where mode off still refuses everything.

### Commands run (2026-10-23, Linux build box) and their output

Every command below was run from `/workspace/repo` on the final tree of this branch. The
output is copied as printed; long runs are cut to their last lines, with ANSI colours removed.
The exit code was captured with `echo "exit=$?"`, or `${PIPESTATUS[0]}` for vitest piped
through `grep`.

`pnpm install --frozen-lockfile`

```
Done in 9.5s using pnpm v10.28.0
```

`pnpm typecheck` (run before any formatter)

```
> tsc -p tsconfig.node.json --noEmit && pnpm -r --filter "./apps/*" --if-present typecheck
apps/desktop typecheck: Done
apps/mobile typecheck: Done
apps/approvals-web typecheck: Done
apps/ui typecheck: Done
exit=0
```

`pnpm lint`

```
Checked 1158 files in 2s. No fixes applied.
Found 59 warnings.
exit=0
```

Lint reports 0 errors. None of the 59 warnings is in code this item added.
`pnpm exec biome check --max-diagnostics=200 .` puts them in 16 files. The only one this item
touched is `packages/capabilities/test/email-commands.test.ts`, and its 19 warnings are all
`noNonNullAssertion` on lines from before this item: 115, 129, 154, 176, 205, 219, 245, 325,
336, 347, 525, 851, 861, 936, 973 and 1080. The new test sits at lines 280 to 312 and has
none. At the starting commit `ca842c1`, `pnpm lint` failed: 4 errors and 59 warnings. The
errors were the formatting and import order of the wip snapshot, which this item fixed.

`node scripts/docs-check.mjs` (three runs)

```
docs-check: cannot diff against origin/main (...); nothing to check.
exit=0
$ node scripts/docs-check.mjs --base ca842c1
docs-check: ok (18 files).
exit=0
$ node scripts/docs-check.mjs --base e2bfb1e
docs-check: ok (23 files).
exit=0
```

This clone has no `origin/main`, so the plain run checks nothing. The two runs with a base are
the ones that check the changed modules against their docs.

Unit tests, per touched package: `pnpm exec vitest run --project unit <dir>`

```
== packages/capabilities/test
 Test Files  35 passed (35)
      Tests  384 passed (384)
exit=0
== services/cloud-runner/test
 Test Files  9 passed (9)
      Tests  54 passed (54)
exit=0
== packages/runtime/test
 Test Files  114 passed (114)
      Tests  985 passed | 1 skipped (986)
exit=0
== packages/commands/test
 Test Files  9 passed (9)
      Tests  130 passed (130)
exit=0
```

Integration tests that need no Postgres:
`pnpm exec vitest run --project integration packages/capabilities/test services/cloud-runner/test`

```
 Test Files  3 passed | 1 skipped (4)
      Tests  21 passed | 3 skipped (24)
exit=0
```

The skipped tests are `runner.integration.test.ts` (2) and one case in
`phase2-gate.integration.test.ts`. They need Postgres or Docker, and neither is on this box.

New tests fail without the behaviour. I reverted the watcher's mode-off branch to
`else if (false)`, ran the file, then restored it:

```
$ pnpm exec vitest run --project unit services/cloud-runner/test/email-watch.test.ts
     × refuses to start at sending mode off even with commands on, with the reason in the log and the status (ADR 0081)
      Tests  1 failed | 6 passed (7)
```

I did the same for the gate, back to `if (!commands.enabled)`:

```
$ pnpm exec vitest run --project unit packages/capabilities/test/email-commands.test.ts
     × obeys nothing at sending mode off: the switch turns commands off, and a row stored before ADR 0081 is not in force
      Tests  1 failed | 31 passed (32)
```

`pnpm check`: lint, lint:paths, typecheck, test, docs:check, docs:links and secrets:scan

```
 Test Files  269 passed (269)
      Tests  2681 passed | 4 skipped | 1 todo (2686)
link-check: ok (106 files).
secret-scan: clean (1408 files).
exit=0
```

`pnpm check` ran on the tree before the build report and the status commit, which changed only
docs. `node scripts/link-check.mjs` on the final tree prints `link-check: ok (107 files).`

### Export and apply check

```
$ git rev-parse HEAD~7
ca842c1115f3b7e438a8935210c439e4373c2c4f        # = /tmp/start-sha = outputs/w3-t1-mode-off.start
$ git format-patch --stdout ca842c1..HEAD > /mnt/session/outputs/w3-t1-mode-off.patch
$ git worktree add --detach /tmp/clean ca842c1      # clean checkout of the starting commit
$ cd /tmp/clean && git status --short | wc -l
0
$ git apply --check /mnt/session/outputs/w3-t1-mode-off.patch; echo "exit=$?"
exit=0
```

The patch holds 7 commits, and every one ends with the trailer `Claude-Build: managed-agent
w3-t1-mode-off build`. This report sits inside the patch, so the check above was run twice.
The first run was on the series before this section was written. The second was on the final
exported patch, and its output is saved as
`/mnt/session/outputs/w3-t1-mode-off-apply-check.log`.

### Docs and status

- ADR 0081 is written and added to the index in `docs/decisions/README.md`.
- `docs/maintainers/email.md`: a new section "Commands need a sending mode other than off",
  plus the gate rule, the `types.ts` row, the test lists and the close-out paragraph.
- `docs/maintainers/cloud-runner.md`: the email watch section and the `email-watch.test.ts`
  row.
- `docs/maintainers/notifications.md`: the kind row and the tests.
- `docs/maintainers/runtime.md`: the wiring and the email routes tests.
- `docs/requirements.md`: T.1 is `done`. Its Test column lists the tests above and ADR 0081.
- `docs/status/BLOCKERS.md`: the T.1 row is resolved, and the L.3 row no longer lists T.1 as
  open.
- `docs/status/PROGRESS.md`: a log entry; item 3 of the handover marks this item as built and
  awaiting review.

### Left open and why

- The settings page (wave/w2-email-page, another builder's) has to show the 400's message and
  re-read the settings after a mode change. The rule is in the store, as the brief asked, so
  that page needs no rule of its own.
- A runner already watching when the mode changes to off keeps its IMAP watch until it
  restarts. The gate obeys nothing in the meantime, so no task starts and nothing is sent.
  Re-reading the settings in the watcher is a possible later refinement and is not needed for
  T.1.
- The runner's settings store has no switch-off listener. The owner is notified by the daemon,
  which is the usual writer of mode changes.
- The B.6 residual was not applied: per the brief it belongs to wave/w1-b6-review.
- L.3 stays `in progress`, because the real mailbox is still missing (its own BLOCKERS row).
- CI on Windows has not run this branch; I cannot push from here.

## Review

Stage REVIEW AND FIX, reviewer: independent (managed agent), 2026-10-24. Reviewed the series
`ccr-4d8a843c-1k9syk..wave/w3-t1-mode-off` (starting commit `b124321`, merge base with the base
branch `82a6295`; the base has since moved to `f1948dd`). `git merge-tree --write-tree HEAD
origin/ccr-4d8a843c-1k9syk` is clean, and the base's own changes to the touched files
(`compose.ts`: the J.9 merge step; `email-commands.test.ts`: a fixture guard; the ADR index row
0062) do not touch the mode-off rule.

**Verdict: revise.** Score: 62/100. The rule is right in the settings store, the gate and the
watcher, and the tests that exist prove what they claim; but the command registry, the way
chat, voice, the phone and the agent's own `email_mode_set` tool change the mode, still writes
the row past the store, so switching to off there leaves commands on with no audit row and no
notification, and the ADR's "every writer goes through it" is false.

After the fixes (commits `aaddb91`, `96ddd11`, `f407646`, `c7e53ac`) every requirement below
holds; the build report's "Left open" items about the running watcher and the page are closed
by findings 2 and 3.

### Requirements checked

- [x] ADR 0081 picks one reading (commands need a sending mode other than off) and records the
  alternatives; index row present, number free on the base.
- [x] Turning commands on at mode off is refused by the store with a plain message
  (`email-settings.test.ts`, `email-routes-wiring.test.ts` 400). Verified by running both.
- [ ] Switching the mode to off with commands on turns them off **with an audit row and a
  notification to the owner, on every path**: true through `PUT /agents/:id/email/settings`,
  false through `email.mode.set` (finding 1).
- [x] `EmailWatch.start` refuses at mode off with the reason in the log and in `status`
  (= runner `/health` `email`). Verified the test fails with the branch reverted (build report)
  and that `runner.ts` exposes `emailWatch.status` in the health view (lines 878, 920).
- [~] The health view tells the truth after the mode changes under a running watcher
  (finding 2).
- [x] Replies to the owner allowed in every other mode: `closeout-email-commands.test.ts`
  green; `checkSend` unchanged (`email-policy.test.ts` still refuses everything at off).
- [x] Gate reads `emailCommandsActive`, so a legacy row (commands on at off) obeys nothing
  (`email-commands.test.ts`).
- [~] The settings page reads the same validation: the 400 message is shown, but the page
  keeps showing commands ticked after a mode change to off turned them off (finding 3).
- [x] B.6 residual not applied (belongs to wave/w1-b6-review).
- [x] Status rows: T.1 `done` in requirements.md, BLOCKERS T.1 resolved, L.3 updated,
  PROGRESS entry. Correct once finding 1 is fixed.
- [x] No security or privacy regression found: the audit row and the notification carry the
  mode and a fixed sentence, no addresses beyond the human id; secrets untouched.

### Findings

1. **high** — `packages/commands/src/commands/email.ts:60` (`applyMode`, used by `run` at 122
   and `undo` at 136). `email.mode.set`, the command every chat, voice, phone and agent-tool
   mode change runs through (spec Q; `email_mode_set` in `tests/e2e/src/gate5-week.ts`),
   writes the `capability`/`email:<agent>` row directly and never goes through
   `EmailSettingsStore.update`. Switching the mode to off there keeps `commands.enabled: true`
   (and the `email-commands` permission and `enabled: true` on the row), writes no
   `commands_switched_off` audit row and sends no `email_commands_off` notification, so the
   state ADR 0081 says cannot be stored is stored by the most common writer; the owner is not
   told; the UI then shows commands on at mode off. ADR 0081 ("which every writer goes
   through"), `email.md` and the `types.ts` doc comment claim the opposite. Verified with a
   throwaway test in `packages/commands/test` (deleted): a row at `read_only` with commands on,
   `email.mode.set {mode: "off"}` done, the row afterwards was
   `{"settings":{"mode":"off"},"commands":{"enabled":true}}`, permissions
   `["email:off","email-commands"]`, `enabled: true`, and 0 `email.settings` audit rows. Needed:
   the command goes through the rule (the daemon's settings store, so the audit row and the
   notification follow), a fallback that keeps the rule when no store is wired, the change
   card saying commands go off with it, undo restoring commands with the mode, and a commands
   test plus a daemon test proving the audit row and the notification.
   Resolution: fixed in aaddb91: `email.mode.set` hands the change to the daemon's settings store through `CommandPorts.emailMode` (switch-off, `commands_switched_off` audit row, `email_commands_off` notification), applies the same rule and audit row itself without the port, says so on the card and its undo turns commands back on; proved by `commands.test.ts` ("email.mode.set to off turns email commands off …", "… goes through the daemon's settings store when the port is wired") and `email-routes-wiring.test.ts` ("ADR 0081: email.mode.set … undo turns them back on", which fails with the port unwired); ADR 0081 amended, commands.md, runtime.md and email.md corrected.
2. **low** — `services/cloud-runner/src/email-watch.ts:297` (`handleOne`). The watcher reads
   the settings once at `start`; after the owner switches the mode to off (or turns commands
   off) under a running runner, `status` and `/health` keep saying `watching` for commands
   that are no longer in force until the runner restarts. The gate obeys nothing, so no task
   starts, but the health view the brief names as the place for the reason is wrong.
   Verified by reading `start`/`handleOne` (no other read of the settings) and
   `docs/maintainers/cloud-runner.md`, which states the gap. Needed: the watcher stands down
   with the reason when a message arrives for commands no longer in force, with a test.
   Resolution: fixed in 96ddd11: after each message the watcher re-reads the settings and, when commands are no longer in force, stops watching with the reason in `status`/`/health` and an `email watch stopped` line (`standDownWhenOff`); two new `email-watch.test.ts` cases (push, and poll-only with a pre-rule row) fail with the call removed; cloud-runner.md updated.
3. **low** — `apps/ui/src/pages/EmailSettingsPage.tsx:638` (`CommandsForm`) and `:179`
   (`ModePicker`). The commands checkbox is local state seeded once from
   `config.commands.enabled` and the form is not keyed on it; after "Apply mode" to off the
   daemon answers `commands.enabled: false` but the box stays ticked and the note says only
   "Mode set to Off.", so the owner is not told on the page and a later "Save commands" sends
   `enabled: true` and gets the 400. Verified by reading the component (the `LimitsForm` next
   to it is keyed on the mode; `CommandsForm` is not) and the fake daemon's `PUT`
   (`apps/ui/test/fake-daemon.ts:411`), which does not mirror the rule, so no UI test can see
   it. Needed: the form follows the stored toggle, the mode note says commands went off, the
   fake daemon mirrors ADR 0081, and a UI test.

   Resolution: fixed in f407646: the commands toggle follows the stored value, the mode note adds `COMMANDS_TURNED_OFF_NOTE` when the change turned commands off, and the fake daemon mirrors ADR 0081 (400 with the plain sentence, switch-off at off); the new `apps/ui/test/email-settings.test.tsx` case fails without the `useEffect`; apps.md and email.md updated.