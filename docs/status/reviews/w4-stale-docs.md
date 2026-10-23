# w4-stale-docs

Build: commits `adb8171` (docs: close the Known issues entries the 2026-10-23 triage found
already fixed) and `2cff785` (status: V.4 row records the stale Known issues entries as
edited) on `wave/w4-stale-docs`; the base `ccr-4d8a843c-1k9syk` was merged in before review
(it added only `scripts/android-apk-verify.*`, no overlap).

## Review

Verdict: **accept**

Score: 92

Scope checked: every row of the triage's "Already fixed" table
(`docs/status/reports/triage-2026-10-23.md`) against the diff and against the source at
HEAD. Each piece of evidence was re-read: `server.ts:1482` (SSE `notification`),
`desktop.yml:55-61` (fmt, clippy, test), `watcher.ts:346-355` (plan and chat envelopes),
`compose.ts:2211-2240` (`registerDesktopDevice`, `DesktopPresence`, gated by
`remoteCommandsEnabled`, which is off on `sqlite:` by default), `compose.ts:2033-2037`
(`sessionCapFromSettings` honours the override with its expiry, as `commands` does),
`ExtensionsPage.tsx:220` (`pendingStage`), `compose.ts:1382-1446` (browser and email tools
in the run registry) and `:1977` (`notifications.injectionFlagged`), `install.rs:180,214`,
`restart.rs:108`, `actions.rs:602`, `docs/user-guide.md` present, `package.json:14,29` and
`ci.yml:50` (`lint:paths`), `cloud-runner/src/remote.ts:91-93` (`ownerHumanId`),
`ci.yml:61-62,122-123` on the Linux and Windows jobs (live harness), `sdk.ts:181-192` (abort
race), critic.md:421 and gates.md:40 (ADR 0042 re-run 40/40), `checklist.ts:177`
(`humanId`), `runner.ts:758-766` (renewal every TTL/6 on an interval), `commands.ts:212`
(`gate: "registry"`) and `conversation.test.ts:310` (`email_mode_set`). All hold. The two
narrowed entries are right: the approvals web page still sends `command: "chat"`
(`Chat.tsx:130`) and the service's `REMOTE_COMMANDS` (`routes/remote.ts:10`) still refuses
it; scenario 3 still leaves the seeded request open. The ADR index row 0021 already carries
the file's title (`docs/decisions/README.md:40` equals the H1 of `0021-desktop-control.md`),
so removing the desktop-control.md entry without editing the index is correct. The
notifications.md (8) link was rightly left: it needs `producers.updateAvailable`,
`SHELL_ROOTS` and the shell's deep-link roots, not a one-line doc fix. The phase 5/7 records
(RT-P5-1 to 4, the answer-route log, the phase 7 refusal text) were already marked closed with
date and test and are untouched. No P2 or "being built" entry was removed; the P2 entries
touched (notifications.md (7), apps.md approvals web (3)) lost only their fixed half. No
dangling "see Known issues" reference points at a removed entry (each remaining one was
followed). Commands run: `pnpm docs:links` ok (105 files); `node scripts/docs-check.mjs
--base origin/ccr-4d8a843c-1k9syk` ok (11 files); `pnpm exec vitest run --project unit
scripts` 10 files, 99 passed, 1 todo; `scripts/closeout-docs.test.ts` 19 passed, 1 todo.

Findings:

1. **low**, `docs/maintainers/apps.md:784-788` (approvals web, Known issues): "on a solo
   `sqlite:` store it has none" is true only by default; `remoteCommandsEnabled`
   (`compose.ts:471-483`) turns registration and the heartbeat on for a `sqlite:` store when
   `FORERUNNER_REMOTE_COMMANDS=1`, and `opts.remote.enabled` registers the row without the
   heartbeat. Verified by reading `remoteCommandsEnabled` and the `registerDevice` condition
   at `compose.ts:2219`. Fix: "on a `sqlite:` store it has none unless
   `FORERUNNER_REMOTE_COMMANDS=1`".
2. **low**, `docs/status/reports/triage-2026-10-23.md:241`: the triage's "Already fixed"
   table still lists apps.md approvals web (2) as fixed, while the build found its chat half
   open (the page's `command: "chat"` the service refuses). The open half is recorded only in
   the BLOCKERS V.4 row and the apps.md entry, not in the triage's P2 list or counts, so the
   "163 P2" figure is one short. Verified by comparing `Chat.tsx:128-131` with
   `routes/remote.ts:10,17`. Fix: one line under the triage's P2 table (or a note on the
   "Already fixed" row) classifying the web chat envelope as P2; the report is a dated
   record, so a dated addendum line is enough.
3. **low**, `docs/maintainers/testing.md:1376` and `:1484`: the two rewritten sentences were
   not re-wrapped (113 and about 190 columns) where the surrounding prose wraps at about 95.
   Verified by reading the lines. Fix: re-wrap the two paragraphs; no content change.
