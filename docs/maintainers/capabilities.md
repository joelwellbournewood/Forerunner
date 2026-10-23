# Capabilities

> Status: partial. Git host adapters are in; browser, email, desktop control and connectors
> land with phase 6.

## Purpose

`packages/capabilities`: what agents can reach outside the runtime. Each capability is
granted or revoked per run through the capability token (tools, domains, secrets). This file
covers the git host adapters; browser, email, desktop control and MCP connectors are added
with their milestone.

## Git hosts (`src/githost/`)

- `GitHost` (`types.ts`) is the contract: repositories, branches, file contents, pull requests
  (create, list, merge, comment, review), issues, check runs, releases with assets, rate limit.
- `GitHubHost` (`github.ts`) implements it for api.github.com, GitHub Enterprise and the fake
  git host in `testenv` (same REST shapes). The token is a bearer header taken from the vault by
  reference; it is never logged. 403 with an exhausted rate limit waits for the reset once
  (bounded by `maxRateLimitWaitSec`); 5xx retries with backoff; 401/403/404/405/409/422 map to
  `provider_auth`, `tool_not_allowed`, `not_found` and `validation` codes. A merge that GitHub
  refuses returns `{ merged: false, message }` instead of throwing so the caller can open a
  human request. `mergePullRequest(repo, n, { sha })` pins the head the caller checked (the
  reviewed commit, the one the checks ran on): GitHub and the fake host refuse with 409 ("Head
  branch was modified") when the head moved, `MemoryGitHost` answers the same message, so the
  runtime's merge step after an accepting review (`packages/runtime/src/loop/merge.ts`, spec
  J.9, ADR 0062) never merges a commit nobody reviewed. `listCommitStatuses(repo, ref)` reads
  the combined status (`GET /commits/<ref>/status`, the latest status per context: the status
  API Jenkins and many external CIs report through) beside `listCheckRuns`, so the merge step
  refuses a red status as it refuses a red check run; `MemoryGitHost.setCommitStatuses` sets
  them for tests. `listRepos({ org })`, `listRepos({ user })` (a user's public repositories)
  and `listRepos()` (every repository the token is affiliated with) follow the `Link:
  rel="next"` header page by page up to `MAX_LIST_PAGES` (100), `pageSize` items per page
  (1 to 100, default 100; `nextPageUrl` parses the header), so a source scan (spec A.4,
  `packages/runtime/src/sources`) sees an organisation whole; `github.test.ts` serves two
  pages from its stub.
- `GitOps` (`git.ts`) runs local git with argv arrays: clone, fetch, branch, commit, rebase onto
  the base before a PR (conflicts are reported by file and the rebase aborted, leaving the tree
  clean), push with `--force-with-lease` only when asked and never on the default branch,
  `isAncestor(base, of)` (has the base moved past the branch; any git failure throws rather
  than reading as "moved"), changed files, log. HTTPS auth uses an `http.extraheader` config argument so the token never
  touches disk; error output is redacted.
- `PrTaskExecutor` (`pr-executor.ts`) wraps any task executor in the branch-and-PR flow: clone
  or fetch into a per-task worktree, branch from the base (or the existing PR branch), run the
  inner executor inside the worktree, commit, rebase onto the base, push and open a pull
  request whose body carries the outcome and acceptance criteria; a second run on the same
  task updates the PR. A rebase conflict becomes a blocking human request with options and the
  task outcome `needs_human`; no changes means `failed`; tasks without a repository run the
  inner executor directly.
- `MemoryGitHost` (`memory.ts`) is an in-memory implementation of the contract for unit tests
  of callers.
- Project operations on the same contract (`ensureProject`, `ensureFields`, `listProjectItems`,
  `findItem`, `upsertItem`, `setItemFields`, `archiveItem`) back the one-way task mirror below.
  `GitHubHost` serves them over the GraphQL endpoint (`github-graphql.ts` holds the documents;
  Projects V2 has no REST API); `MemoryGitHost` keeps them in maps and records every call in
  `projectCalls` so tests can count outward actions.

## GitHub Projects mirror (`src/githost/projects-mirror.ts`)

### Purpose

Spec, build order phase 2: "One-way mirror of tasks to GitHub Projects"; "Source of truth
rules": tasks live in the shared state service, GitHub is a mirror so the work is visible there.
`ProjectsMirror.sync(projectId)` reads the tasks of one Forerunner project from the store and
makes a GitHub Projects V2 board show them: one draft-issue item per task with title, status,
specialist, cost in CHF and links to the PR and the review; done and cancelled tasks (and
deleted ones) are archived. Nothing flows the other way: the host's state only decides whether
an item already exists, the store decides what it says. Edits made on GitHub survive only until
the task next changes (or `full: true` re-asserts the whole board); they never reach the store.

### Operations

| Step | Host call | When |
| --- | --- | --- |
| Board | `ensureProject(owner, title)` | once; the id is stored in `settings.github_mirror.project_id` |
| Fields | `ensureFields(projectId, MIRROR_FIELDS)` | once per process per board, and again when `MIRROR_FIELDS_VERSION` moved |
| Item | `upsertItem(projectId, taskToItem(task, ledger, review))` | every task whose `version` differs from the cursor |
| Archive | `archiveItem(projectId, itemId)` | after the upsert of a done or cancelled task; for a task id in the persisted cursor whose row no longer exists (`findItem` first), on incremental and `full` runs alike |

`upsertItem` is idempotent by the `forerunner_task_id` text field: the GitHub adapter lists
the board once per process (100 items per page) and keeps an index task id -> item; a new item
is `addProjectV2DraftIssue` + one `MirrorSetFields` mutation that writes every field with
aliases (one request per item, not one per field); an existing item gets
`updateProjectV2DraftIssue` only when title or body changed, a field mutation only for values
that differ, and `unarchiveProjectV2Item` when it was archived. Items a human added (issues,
pull requests) carry no task id and are never written to.

Order of a run: settings check -> host -> board -> fields -> read tasks -> diff against the
cursor -> batches of `batchSize` (default 25) upserts, cursor saved after each batch ->
archive deleted -> save cursor and `last_sync_at` -> event -> result. The mirror runs on a
session of its own (trigger `manual` or `schedule`, agent = `opts.agentId` or the first active
principal) so the run event has a home; pass `sessionId` to write into a running session instead.
A run that can get no session (no `sessionId`, no `agentId`, no active principal agent) is not
silent: the same counts go to the audit log as one `github.projects.sync` row
(`MIRROR_AUDIT_TOOL`, `runSummary` builds the line the session summary also uses) and the
result carries `sessionId: null, eventId: null`.

Enforcement in code, not prompts: `sync` throws `tool_not_allowed` unless
`project.settings.github_mirror.enabled === true` (the human's opt-in, set by `fr mirror enable`
or the UI); with a `MirrorHumanPort` wired, creating a board is asked once
(`approval_required` on a denial; `approved: true` is remembered); unknown fields or options are
refused by the host before any request (`validation`). Every outward action appends an audit
row (`github.projects.ensure_project`, `ensure_fields`, `upsert_item`, `archive_item`; a denied
creation is logged with `allowed: false`).

Rate limits: the GitHub adapter waits for `Retry-After` (secondary limits, 403/429), for
`X-RateLimit-Reset` when `X-RateLimit-Remaining` is 0, and for `RATE_LIMITED` errors inside a
200 body, on the injected Clock, bounded by `maxRateLimitWaitSec` (default 120 s); past that it
throws a retryable `provider_rate_limit`. The mirror catches that, stops the run, keeps the
cursor of the finished batches, records `stopped: { reason: "rate_limit", retryAfterMs }` in the
result and the event, and the next run continues where it stopped without creating twins.

### Field mapping (`taskToItem`)

| Board field | Type | Value |
| --- | --- | --- |
| title | draft issue | `task.title` |
| body | draft issue | outcome, acceptance criteria, status, specialist, cost, risk tier, milestone, PR and review links, and the sentence that edits here are not synced back; cut at `MIRROR_BODY_MAX_CHARS` (60 000, under GitHub's 65 536 cap) with `MIRROR_BODY_TRUNCATED_MARKER` at the end (`capBody`) |
| `Status` | single-select (GitHub's built-in field, options added) | `MIRROR_STATUS_LABELS[task.status]`: Draft, Ready, Claimed, In Progress, In Review, Needs Human, Done, Failed, Cancelled (title case so GitHub's own "In Progress" and "Done" options are reused) |
| `specialist` | text | `task.specialist`, cleared when null |
| `cost` | text | `CHF x.xx` from the cost ledger sum for the task (`chf_micro`); `USD x.xx` from `actual_cost_usd_micro` when the ledger has no entry (ADR 0008: CHF is the display currency) |
| `forerunner_task_id` | text | `task.id`; the idempotency key, written once on creation |
| `pr` | text | `task.pr_url` |
| `review` | text | `<verdict> <grade>/100 <link>` of the latest review (`deps.reviewLink`, default `forerunner://reviews/<id>`) |
| `milestone` | text | name of the task's milestone (`store.milestone`, loaded once per run), cleared when the task has none (added in field set version 2) |

Archived: `task.status` in `CLOSED_TASK_STATUSES` (`done`, `cancelled`) or the task row is gone.
Milestones are mirrored as a field on each task, not as items of their own: a board groups by
`milestone` the way it groups by `Status`.

### Cursor and settings

`project.settings.github_mirror` (type `MirrorSettings`, read by `mirrorSettingsOf`):
`enabled` (the only switch), `owner` (default: owner of the first repo locator,
`ownerFromLocator`), `title` (default: project name), `secret_ref` (default
`secret:github_token`), `project_id` / `project_url` / `project_number` once the board exists,
`approved`, `fields_version`, `cursor` (task id -> task `version` last mirrored) and
`last_sync_at`. The cursor is exact (a per-row version, not a timestamp), so clock skew between
two installs writing the same Postgres cannot hide a change, and a run after no changes makes
zero host calls. Settings are written with optimistic concurrency and retried on
`version_conflict`; the cursor is persisted after every batch, so a crash mid-run redoes at most
one batch (upserts are idempotent anyway). The cursor follows the task row only: a change that
lives elsewhere (a milestone renamed, a new ledger entry, a new review) reaches the board when
the task next changes or on `fr mirror sync --full`. `fields_version` records which field set
(`MIRROR_FIELDS_VERSION`) a board was last ensured with; a board set up by an older build gets
the new fields on its next run.

A `full` run resets only the working cursor (so every present task is re-asserted); the ids of
tasks deleted since the last run are always computed from the cursor as persisted, and they
stay in the working cursor until their items are archived. A full run therefore archives a
task deleted since the previous incremental run instead of forgetting it, and a full run that
stops early (rate limit, crash) still hands the deleted ids to the next run.

Rate-limit arithmetic (`retryAfterMs`, or `resetAt` minus now) runs on the injected `Clock`,
never on the wall clock, so the stop reason in the event is right under a simulated clock too.

### Scopes

The token comes from the vault by reference (`githubHostForSecretRef`: the value goes into the
bearer header only; `resolveSecretRefs` audits the name, never the value). It needs, for a
fine-grained PAT, "Projects: Read and write" on the user or organisation that holds the board
(plus repository "Metadata: Read"); for a classic PAT, the `project` scope (`read:project` is
not enough). A GitHub App installation needs the organisation permission "Projects: write".
Insufficient scopes surface as `tool_not_allowed` (`INSUFFICIENT_SCOPES` / `FORBIDDEN`).

### Wiring

- Scheduler: `scheduleMirror(scheduler, { projectId, everyMinutes })` registers an `every`
  schedule under the pseudo agent `mirror:<projectId>` (one run at a time per project, quiet
  hours respected). The orchestrator wraps its session starter:
  `start: mirrorStartHandler(mirror, startSession)`; mirror requests run `sync`, everything else
  goes on to `startSession`. A manual `scheduler.request({ agentId: mirrorAgentId(id), projectId: id, trigger: "manual" })` runs it now.
- CLI: `registerMirrorCli(program, { open })` adds `fr mirror sync --project <name-or-id> [--all] [--full]`,
  `fr mirror enable --project ... [--owner] [--title] [--secret]` and `fr mirror disable`.
  `program` is typed structurally (`MirrorCliCommand`) so this package does not depend on
  commander; a commander `Command` satisfies it.
- Human port: `MirrorHumanPort { ask(request) }`; `HumanRequestMirrorPort` files a non-blocking
  `approval` human request with the two options and polls the store on the Clock until it is
  answered (timeout withdraws it and counts as deny).

### How to change it

- New field: add it to `MIRROR_FIELDS`, fill it in `taskToItem`, bump `MIRROR_FIELDS_VERSION`
  so existing boards get it on their next run, extend both hosts' tests.
- New status: `TASK_STATUSES` drives the Status options; add its label to
  `MIRROR_STATUS_LABELS` (the type forces it).
- Another git host: implement the project operations in its adapter; the mirror only uses the
  contract. The fake git host in `testenv` speaks classic REST projects only (retired by GitHub),
  so adapter tests use `test/helpers/fake-projects-graphql.ts`, a node:http GraphQL stand-in
  that records every request body.
- Never add a read-back: anything that copies board state into the store breaks the
  one-way test and the "Source of truth rules".

### Decisions (recorded here; no ADR number was reserved for this module)

- Projects V2 over GraphQL, not classic projects: classic projects were retired in 2024 and
  the only supported API is GraphQL. The fake git host's classic routes are therefore not used.
- Draft issues, not repository issues, as items: a draft issue belongs to the board and needs
  no repository permission; the one-way rule is easier to keep (no issue webhooks, no
  comments to reconcile). Linking real issues can come later as an opt-in.
- Cursor as a per-task version map in project settings rather than an `updated_at`
  watermark: exact under clock skew and concurrent writers; the cost is one small JSON entry per
  task.
- The spec's "edits there sync back only for status and comments" is deferred: phase 2 asks
  for the one-way mirror; a sync-back would be a separate, explicitly approved capability with
  its own tests. Until then the board is informational.

### Tests

`packages/capabilities/test/github-projects.test.ts` (adapter over the GraphQL stand-in:
endpoint derivation, ensureProject lookup-then-create and bearer header, ensureFields creating
fields and extending Status options with colours, idempotent upsert with batched aliased field
writes and a fresh-process lookup, archive/unarchive and item paging, Retry-After and
RATE_LIMITED waits on `SimulatedClock` with the give-up bound, error code mapping and
unknown-field refusal, `buildSetFieldsMutation`, memory host parity) and
`packages/capabilities/test/projects-mirror.test.ts` (first run creates board, fields, items with
status, specialist, CHF cost, PR and review, plus event and audit rows; cursor skips unchanged
tasks and re-mirrors only changes; archive on done, cancelled and deleted, unarchive on reopen;
one-way guarantee with a tampered board and a `full` re-assert; rate-limit stop with
per-batch cursor and continuation without twins; not-enabled refusal and owner derivation;
approval port deny/approve asked once; `HumanRequestMirrorPort` answer and timeout; scheduler
hook; CLI registration and commands; host from a vault reference; `taskToItem` for every
status; body cap with the cut marker; milestone name on the item, a milestone rename reaching
the board only through a task change or a full run, and a board with an older `fields_version`
getting its fields ensured again once; `resetAt` retry delay computed on the simulated clock;
a full run archiving a task deleted since the last run and dropping its id from the cursor; a
full run stopped by a rate limit keeping the deleted ids until the next run archives them; a
run without a principal agent writing its counts to the audit log instead of an event;
end-to-end run over GraphQL). Run: `pnpm vitest run --project unit packages/capabilities/test/github-projects.test.ts packages/capabilities/test/projects-mirror.test.ts`
(28 tests).

### Known issues

- The GitHub adapter's item index is per process; two processes mirroring the same board at
  the same time could each create an item for a task created between their listings. Run the
  mirror from one place (the scheduler) per project.
- A milestone rename, a new ledger entry or a new review does not bump the task's version, so
  the cursor hides it until the task changes or a `--full` run; the board is informational, so
  this is accepted rather than widening the cursor to those rows.
- Milestones are a text field, not a single-select: option ids would have to be kept in sync
  with milestone rows (creates, renames, deletes); a text field needs no reconciliation.
- The fake git host in `testenv` speaks classic (REST) projects only; the GraphQL stand-in
  lives in this package's test helpers and is not shared with other packages.
- A done or cancelled task that changes version while its item is already archived costs two
  extra mutations (`upsertItem` unarchives, `mirrorTask` re-archives). Kept on purpose: an
  archived item is read-only on GitHub until it is restored, and the API does not document
  field writes on one, so the unarchive is what lets the update land; two cheap mutations are
  preferred to an undocumented edge of the API.
- The "Decisions" subsection above belongs in `docs/decisions/` as an ADR; no number was
  reserved for this module yet, so it stays here until the orchestrator lifts it.

### Requirements

No row in `docs/requirements.md` names the mirror (it sits under "Source of truth rules" in
the Architecture section, outside the A-V scheme). It contributes to: B.1 (milestones and
tasks of a project, shown on the board), B.3 (every workflow status and side exit has exactly
one board option), B.7 (task log with cost, verdict and links to PR and review, reproduced on
the board), S.1 (enabled flag, approval and field checks enforced in code), S.4 (token by
reference, value only in the header), S.5 (scopes documented and insufficient scopes
surfaced), S.6 (creating the board can be routed through a human), S.9 (audit row per outward
action), U.9 (run event with counts on a session).

## How it works

## How to change it

## Tests

`github.test.ts` reads commit statuses from the combined-status endpoint, sends the merge's
`sha` pin to the stub and has `MemoryGitHost` refuse a merge
pinned to a head the PR no longer has; `git.test.ts` has `isAncestor` false while the base has
moved and true after the rebase. The runtime's merge step on the fake git host is
`packages/runtime/test/loop-merge.test.ts`.

## Known issues

### Changed files for peer awareness

After a successful rebase the PR executor records `git diff --name-only base...HEAD` as
`changedFiles` on the task result. The session runner appends a `task.files` event and stores
the list under `in_flight_files` in the session handoff, which is what peers use for overlap
detection (`runtime.md` § Peer awareness). The diff is informational: a failure to compute it
never fails the pull request.
