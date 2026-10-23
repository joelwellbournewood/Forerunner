## Build report

Item `w3-e1-triggers`, stage BUILD, branch `wave/w3-e1-triggers`. The starting commit is
`c4a0e85`: a `wip:` snapshot from an earlier attempt that held a first draft of
`githost-watcher.ts`. The draft did not typecheck (it imported `mkdirp` and `parentDir`, which
`@forerunner/platform` does not export) and had no tests or wiring. I kept its design and
finished it. Requirement: E.1 (E.2 and E.3 are context only). ADR: 0075.

### What was built

- **Git host port** (`packages/capabilities/src/githost/`):
  - `listPullRequestComments(repo, n, { since })` now follows the host's pagination. GitHub
    lists issue comments oldest first, so the old single page of 100 never showed a new
    comment on a long PR. It also passes `since` to the host.
  - `listPullRequestReviews(repo, n)` is new and returns `ReviewInfo`. It is implemented in
    `GitHubHost` and `MemoryGitHost`; `MemoryGitHost.reviewPullRequest` now records reviews.
  - The fake git host (`testenv/src/githost/routes-issues.ts`) honours `?since=` on PR and
    issue comments.
- **`GitHostWatcher`** (`packages/runtime/src/session/githost-watcher.ts`):
  - Runs on the `Clock`. Each poll lists the PRs that the task rows give the install's agents
    (`pr_url` plus owner, claimer or author) and reads each PR, its comments (with `since`),
    its reviews and the check runs on its head.
  - Fires `ci` for a completed check that concluded failure, timed_out, cancelled or
    action_required. It fires once per check run id, and the reason carries the check name
    and conclusion. A head whose checks all passed fires `ci` once per sha.
  - Fires `pr_comment` for a comment or a submitted review by anyone other than the agent's
    own host login (`whoAmI`).
  - Each event goes into the agent's inbox, where the next session's brief shows it. A comment
    is quoted inside the untrusted-content envelope and run through the injection scan. If the
    scan flags it, the message is marked FLAGGED and `onInjection` reports it to the human.
  - The start request and the `githost.trigger` audit row carry only the author and the PR,
    never the comment text.
  - Dedupe: each event has a key (`check:<id>`, `green:<sha>`, `comment:<id>`, `review:<id>`).
    The keys are kept in a cursor that is saved before the start, so an event fires at most
    once. `fileCursorStore` writes the cursor atomically, so it survives a restart.
  - The first poll is a baseline: it records what is already on the PRs and fires nothing.
  - A closed PR is read once and then never again.
  - Quiet hours defer: the PRs are not read and the cursor does not move.
  - Starts go through `Scheduler.requestStart`. A second trigger while a session runs is queued
    (one active session per agent). A refused start is logged and audited, not thrown.
- **Daemon wiring** (`packages/runtime/src/daemon/compose.ts`):
  - `RuntimeApp.githostWatcher` is built when `githostWatchEnabled(...)` allows it: the
    background services must be running, then the `githostWatch.enabled` option decides, then
    `FORERUNNER_GITHOST_WATCH`. Otherwise it is on only when a real host exists (the GitHub
    token in the vault, or an injected host).
  - Poll interval: `githostWatch.pollMs`, else `FORERUNNER_GITHOST_POLL_MS`, else 60 000 ms.
  - The cursor lives at `<data>/githost/cursor-<agent>.json`.
  - Quiet hours are the human's notification `quiet_hours`.
  - Polling pauses while the schema-sync gate is paused.
  - A flagged comment produces an `injection.flagged` audit row and an `injection_flagged`
    notification.
  - The watcher starts after the scheduler and stops on `close()`.
- **Docs:**
  - `docs/maintainers/runtime.md`: Sessions ("CI results and PR comments"), Local daemon ("Git
    host poller"), Tests, Known issues.
  - `docs/maintainers/capabilities.md`: PR feedback reads.
  - `docs/maintainers/testing.md`: fake host `since`.
  - ADR `docs/decisions/0075-githost-triggers-polling-and-dedupe.md` (polling vs webhooks, the
    dedupe rule, the content rule), plus its index row.
  - `docs/requirements.md`: E.1 is now `done`, with the new tests.
  - `docs/status/BLOCKERS.md`: the E.1 row now says what was built and what is left.
  - `docs/status/PROGRESS.md`: a log entry for this item.
  - `CHANGELOG.md`: an entry under Unreleased.

### Tests that prove it

- `packages/runtime/test/githost-watcher.test.ts`, 13 tests. Runs against the testenv fake git
  host through the real `GitHubHost`, on a SimulatedClock. It proves:
  - the baseline poll fires nothing;
  - a failed check fires `ci` once, with the name and conclusion (a running check fires
    nothing);
  - a green head fires `ci` once;
  - a comment fires `pr_comment` once, and the rendered next-session brief quotes it as data;
  - the agent's own comment and review do not fire;
  - a "changes requested" review fires;
  - a restart over the file cursor fires nothing twice and fires what arrived while it was
    down exactly once;
  - quiet hours defer, then the events fire once;
  - an instruction-like comment is flagged and reported, kept out of the request and the audit
    row, and the poll makes no write to the host;
  - a second trigger queues behind the active session, and a refused start is audited
    (`allowed: false`) without throwing;
  - a closed PR is read once;
  - the poll runs on the clock and stops.
- `packages/runtime/test/githost-wiring.test.ts`, 5 tests. Uses the composed daemon. It proves:
  - `githostWatchEnabled` follows its precedence order;
  - the watcher is built at the option's interval (the option wins over the env variable);
  - it polls on the clock and fires `ci` into the scheduler's log once;
  - it defers in the human's quiet hours;
  - a flagged comment fires `pr_comment` and records `injection.flagged`;
  - it stops on close.
- `packages/capabilities/test/githost-feedback.test.ts`, 3 tests:
  - comments are read across several pages and filtered by `since` on the fake host;
  - reviews are mapped correctly;
  - the memory host keeps the same contract.

### Commands run and results

Every command below was run from `/workspace/repo`, on HEAD, after the commit messages were rewritten (see "Commit history" below). The output is copied verbatim, cut to its last lines, with ANSI colours removed.

```
$ pnpm install --frozen-lockfile
Done in 8.5s using pnpm v10.28.0
```

```
$ pnpm typecheck
apps/desktop typecheck$ echo 'no TypeScript in the desktop shell; see @forerunner/ui'
apps/ui typecheck$ tsc -p tsconfig.json --noEmit
apps/desktop typecheck: no TypeScript in the desktop shell; see @forerunner/ui
apps/mobile typecheck: no TypeScript in the mobile shell; see @forerunner/ui
apps/mobile typecheck: Done
apps/desktop typecheck: Done
apps/approvals-web typecheck: Done
apps/ui typecheck: Done
exit=0
```

`pnpm lint` reports 59 warnings, none of them in a file this item touches. I checked with `biome check --max-diagnostics=200`; the only githost-named hit is the existing file `packages/capabilities/test/security-cloudflare-githost.test.ts`.

```
$ pnpm lint
The number of diagnostics exceeds the limit allowed. Use --max-diagnostics to increase it.
Diagnostics not shown: 39.
Checked 1162 files in 2s. No fixes applied.
Found 59 warnings.
exit=0
```

```
$ node scripts/docs-check.mjs --base c4a0e85bfe5a3a8d29462c515ec01b754284b930
docs-check: ok (20 files).
exit=0
```

The new test files:

```
$ pnpm exec vitest run --project unit packages/runtime/test/githost-watcher.test.ts packages/runtime/test/githost-wiring.test.ts packages/capabilities/test/githost-feedback.test.ts
 ✓  unit  packages/capabilities/test/githost-feedback.test.ts (3 tests)
 ✓  unit  packages/runtime/test/githost-wiring.test.ts (5 tests)
 ✓  unit  packages/runtime/test/githost-watcher.test.ts (13 tests)
 Test Files  3 passed (3)
      Tests  21 passed (21)
```

The suites of every package touched (runtime, capabilities, testenv), plus state-api, whose mirror calls `listPullRequestComments`:

```
$ pnpm exec vitest run --project unit packages/runtime/test
 Test Files  116 passed (116)
      Tests  1002 passed | 1 skipped (1003)
exit 0

$ pnpm exec vitest run --project unit packages/capabilities/test testenv/test services/state-api/test
 Test Files  56 passed (56)
      Tests  654 passed (654)
exit 0

$ pnpm exec vitest run --project integration packages/runtime/test packages/capabilities/test testenv/test
 Test Files  3 passed | 1 skipped (4)
      Tests  21 passed | 5 skipped (26)
exit 0
```

The integration skips are `sandbox.integration.test.ts` (it needs a Docker daemon) and one case of `phase2-gate`. Neither is related to this item.

```
$ pnpm check
check-paths: ok (988 files).
 Test Files  272 passed (272)
      Tests  2694 passed | 4 skipped | 1 todo (2699)
link-check: ok (106 files).
secret-scan: clean (1412 files).
exit 0
```

None of these runs printed "No test files found".

### Export and `git apply --check` against a clean checkout of the starting commit

The starting commit is `c4a0e85bfe5a3a8d29462c515ec01b754284b930`; `/tmp/start-sha` holds it, and so does `/mnt/session/outputs/w3-e1-triggers.start`. Before this report was committed, I built the patch from every commit then on the branch (the four code and docs commits plus the first version of this report) and applied it to a fresh worktree of the starting commit:

```
$ git worktree add /tmp/verify c4a0e85bfe5a3a8d29462c515ec01b754284b930 && cd /tmp/verify && git apply --check /tmp/pre.patch
exit=0
$ git apply --stat /tmp/pre.patch | tail -1
 20 files changed, 1658 insertions(+), 93 deletions(-)
```

`exit=0` with no other output means the patch applies cleanly. After this report was committed, I ran the export again in the same way and repeated the check on the final patch:

```
$ git format-patch --stdout $(cat /tmp/start-sha)..HEAD > /mnt/session/outputs/w3-e1-triggers.patch
$ git worktree add /tmp/verify $(cat /tmp/start-sha) && cd /tmp/verify && git apply --check /mnt/session/outputs/w3-e1-triggers.patch
```

I also ran `git log --oneline $(cat /tmp/start-sha)..HEAD` and confirmed it lists exactly this item's commits, with nothing from the base branch.

### Commit history

Every commit ends with the trailer `Claude-Build: managed-agent w3-e1-triggers build`. The first export used `... BUILD` in upper case. I corrected the messages of this item's own commits with `git filter-branch --msg-filter` over `c4a0e85..HEAD`; this changed messages only, and no file contents. The base branch was not merged in, rebased onto, or touched.

### Left open, and why

- **No webhook receiver.** The brief made it a bonus "only if cheap", and it is not cheap:
  - a desktop daemon has no public address;
  - the shared state service must not hold each human's host events.

  ADR 0075 records this. The fake host's HMAC webhooks would use the same dedupe keys if a
  receiver is added later.
- **Commit statuses are not read** (the older combined-status API). A CI system that reports
  only statuses fires no `ci` trigger. This needs a combined-status read on the port.
- **Review line comments are not read.** The review summary is the event.
- **The human's own comments can be missed.** "The agent's own comment" means a comment by the
  host token's login. On an install whose token is the human's own PAT, the human's comments
  never fire `pr_comment`; a separate bot token fixes this. Recorded in runtime.md Known
  issues and in ADR 0075.
- **A PR reopened after being seen closed is not watched again.** Remembering closed PRs keeps
  finished tasks from costing a request every minute.
- **Delivery is at most once, by design** (ADR 0075). A crash between saving the cursor and
  the start loses that one event's message and start; the PR itself still shows the event.
- **V.1 and phase-8 requirement counts not updated.** The tallies in BLOCKERS.md (V.1) and the
  PROGRESS.md phase-8 row still say 183 / 40 / 5. Every item merging today changes them, so
  they belong to the integration step; this item moves one row (E.1) from in progress to done.
