# 0060 — Monthly jobs: the scheduler's monthly kind, where the calibration and handover reports live, and the stuck-place rule

Date: 2026-10-23
Status: accepted

## Context

Two requirements are monthly. H.7: "Calibration: the critic grades the golden eval set monthly
so drift is visible." P.15: "Handover test: monthly, a fresh agent with only the repo and docs
makes a small seeded change. Where it gets stuck becomes a docs task." `calibrate()` and its
report existed in `packages/critic`, and scenario 8 ran a fresh agent against a seeded defect
in a sample repository, but nothing ran either once a month. The session scheduler
(`packages/runtime/src/session/triggers.ts`) knew daily, weekdays and every N minutes, and kept
the day it last fired a schedule in memory, so a daemon restarted after the due time ran the
day's job again. For a job that spends money on a live model once a month that is not
acceptable. Three things had to be decided: how a monthly schedule is expressed and kept to
once a month, where the reports live and what "drift" is measured against, and what counts as
a place the handover agent "got stuck".

## Decision

1. **A `monthly` schedule kind.** `dayOfMonth` (1 to 31) and `time` (hh:mm) in the human's time
   zone. A day past the month's end fires on its last day. A month whose day passed while the
   daemon was down fires once later in that month. A schedule seen for the first time after
   its day, such as a new install on the 20th or a job just switched on, waits for the next
   month. Otherwise the calibration, which is on by default, would spend its budget minutes
   after the first start. `fr jobs` runs a job by hand. The dedupe key is the local
   `YYYY-MM`. The
   scheduler's fired keys (day keys and month keys, every kind) go through a `FiredKeys` port.
   The daemon passes `fileFiredKeys(<data dir>/scheduler-fired.json)`, so a restart does not
   fire a day's or a month's job twice. Each job also checks its own reports for the month (the
   second line): the local month of the newest report's `startedAt` in the human's zone, never
   the UTC date (a late run on the last day in a western zone is the next month in UTC and
   would swallow that month's run). `--force` on the CLI overrides that check. Every handover
   project has its own scheduler agent id (`handover-test:<project>`), because the scheduler
   keeps one pending slot per agent.
2. **Settings decide the schedules, re-read before every tick.** The calibration is on by
   default: day 1 at 06:00, USD 10, tier 1, from `human.notify_prefs.calibration`. The
   handover is per project and off until `settings.handover.enabled` is true: day 1 at 07:00,
   USD 5. The install's "own Forerunner project" is the project that carries this flag. No
   separate install-level pointer exists, because the flag alone is enough to say which
   project the job targets. Both keys are `settings.set` keys of the command registry (medium
   risk, undoable), so the CLI, the app, the phone and the conversation change them the same
   way. `SchedulerDeps.refresh` re-reads them before every tick.
3. **Reports are dated JSON files under the install's data dir, plus the inbox.** Each
   calibration writes `<data dir>/critic/calibration-<date>.json`, which is the file
   `calibrate()` always wrote. Each handover writes
   `<data dir>/handover/<project>/handover-<date>.json`. Drift is the catch rate and the pass
   rate in percentage points against the newest earlier calibration report (by `startedAt`). With no earlier
   report, the run is "the baseline". A calibration whose reviews did not all complete (budget,
   provider, timeout) writes no report and is notified as failed. Its conservative verdicts
   would otherwise show up as drift. The humans see the result as a notification
   (`critic_calibration`, `handover_report`, normal urgency, held through quiet hours). The
   handover also sends the report to the inbox as a message from the fresh agent. Both jobs
   write an audit row (`critic.calibration`, `handover.run`).
4. **The stuck-place rule** counts only the fresh agent's audit rows of the one handover
   session. The following are stuck places:
   - a `read_file` of the same path more than once;
   - an allowed call whose result starts with `ERROR:` (the tool failed);
   - a call the hooks refused;
   - the seeded task ending `needs_human` or `failed`;
   - the seeded task ending anywhere else short of `done` or `in_review` (`task_unfinished`:
     the change was not made);
   - the session ending `failed` or `killed`.

   If there is any stuck place, the job files ONE ready docs task on the project. The task
   lists every place, and has one acceptance criterion per file named. The agent's own
   report text never goes into the task, because it is data, not a brief; tool output, the
   hooks' reasons and paths that the injection scan flags are withheld from it for the same
   reason (the task is filed ready and becomes a later specialist's goal).
5. **The fresh agent and the seed.** The fresh agent is a new principal row with no lessons. The
   session runs through a second `SessionRunner` over the daemon's ports with no memory port,
   its own executor whose specialists recall no lessons either (the daemon's executor hands
   principal agents the `shared` scope per task), and a planner that sees only the seeded task. The seed comes from the project setting, or
   by default is a dated line at the end of `docs/runbook.md` that is only reachable by
   reading README.md and the docs. After the session, the seed is cancelled if it is still
   active and the agent is retired. Scenario 8's sample repository and task moved into
   `packages/runtime/src/jobs/handover-seed.ts`, so the job and the scenario share one seed.

## Consequences

- The daily and weekdays schedules (memory consolidation, mirrors) also stop re-firing after a
  restart, which is the same fix for the same cost problem.
- A run deferred by quiet hours waits in the scheduler's in-memory pending slot. The fired key
  is already set at that point, so a restart before the hours end loses that month's run. Only
  `fr jobs ... --force` brings it back. This is recorded in runtime.md's Known issues.
- The reports are local to the install, so a second device sees only the notification and the
  inbox message. Calibration reports were already local (`docs/status/gates.md` copies them).
- The handover's live run on Forerunner's own repository needs a live model. It is a manual
  run on the final build (`fr jobs handover <project> --force`) within the live budget.
- The re-read rule counts `read_file` by path. A search tool, or reads through the critic, are
  not counted, so an agent that is lost in `search` without re-reading files does not count
  as stuck by this rule.

## Alternatives considered

- **A cron expression for schedules.** This is more general, but needs a parser or a
  dependency, and nobody needs anything beyond day-of-month here.
- **Reports as state rows (a new table).** These would be visible on every device, but would
  need a migration, the schema doc and the Postgres adapter for two monthly records. The
  inbox message and the notification already reach every device.
- **An install-level `handover_target` setting naming one project.** This is one more place to
  keep in sync with the project list. The per-project flag also lets a second repository opt
  in.
- **Turning the agent's own "Lesson:" lines or its report into the docs task.** This is
  rejected because the report is model output (data). The audit rows are what the hooks
  recorded.
- **Counting every repeated tool call, not only `read_file`.** Re-running a test command after
  a fix is normal work, not a sign that the docs were missing.
