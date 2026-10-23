# w3-c5-specialist-approval

## Build report

Item: w3-c5-specialist-approval, stage BUILD, branch `wave/w3-c5-specialist-approval`.
Starting commit: `16bb864` (the earlier attempt's `wip:` snapshot, which holds the eval
runner's `candidate` input; this build keeps it and builds on it). Base branch
`ccr-4d8a843c-1k9syk` at `e2bfb1e`. Requirement C.5 (C.1 to C.4 context). ADR 0071.

### What was built

- **The approval gate** `packages/runtime/src/registry/approval.ts` (`SpecialistApprovals`):
  - `propose()` writes the proposal (`proposeSpecialist`) and files one blocking `approval`
    request for the proposal's human: options approve / reject, `change_card.key`
    `specialist:<name>`, with the summary (description and rationale), the `prompt_version`
    shown, `eval_task_count`, the threshold, tools, domains, budget, tier and risk floor.
    `file()` is idempotent (it returns the open request). `fileMissing()` files requests for
    proposals already on disk (the daemon calls it once at start).
  - `syncAnswers()` claims each answered request once (a versioned write of `applied_at`
    before anything runs). Approve runs the eval set through the `EvalRunnerPort` (the model
    watch's `LoopEvalRunner`, with the proposal passed as `candidate`). Every call runs under
    the enforcement hooks, owned by the approving human. Before the first call, the run's
    worst case must fit the approval eval budget: the smaller of USD 5 and 20% of the human's
    monthly cap. The result goes into `proposal.json`: pass rate, counts, provider, model,
    effort, the evaluated prompt version, cost, date, approver and the threshold, with each
    run also added to `evalHistory`.
  - A pass needs at least 10 mechanically decided tasks and a pass rate of at least 90%
    (`ACTIVATION_THRESHOLD`, `gateVerdict`). On a pass the file is written to
    `specialists/<name>/` with only its `status:` line changed to `active`. The write is an
    exclusive create, and every field is first compared with the evaluated definition.
    `proposal.json` moves with it, `proposed/<name>/` is removed, and the live registry is
    updated (`onPromoted`).
  - Any other outcome keeps the proposal proposed: a failed set, fewer than 10 tasks, a worst
    case over the budget, no model, an eval error, or the name already taken. The outcome and
    result go on the card, a `warning` message goes to the inbox, and `proposal.json` records
    `eval_failed`.
  - Reject withdraws the proposal: the directory is removed, the record is kept on the card
    and the name becomes free.
  - Some answers run nothing: an answer from another human, an answer that is neither approve
    nor reject, and an approval of a proposal edited after it was filed. Each is recorded and
    the proposal is filed again. Every step writes a `registry.specialist_approval` audit row.
- **Daemon wiring** in `compose.ts`:
  - `RuntimeApp.specialistApprovals` is built over the shared eval runner. The run uses the
    composed provider's rung for the proposal's `default_tier` and the pricing table in force.
  - `syncApprovals` now has a `specialists` half. In the daemon the evaluation runs in the
    background after the claim; a CLI one-shot waits for it.
  - `close()` waits for any evaluation still running.
  - The gate5 harness mirrors the new `specialists` half (as zeros).
- **CLI** `packages/runtime/src/cli/specialists.ts`: `fr specialists list|approve <name>|reject <name>`
  (`--json`). `approve` answers the request as the install's human and applies it through the
  same steps as an inbox answer. It exits with 1 when the specialist did not go live.
- **Eval runner** (kept from the wip snapshot): `EvalRunInput.candidate` runs a pending
  proposal under its own name. Anything else is a `validation` error, and without a candidate
  only runnable entries run.
- **Docs**:
  - `docs/decisions/0071-specialist-approval-gate.md` (new ADR, plus its row in the
    decisions README): the threshold, the budget, where results are recorded, the one-line
    promotion, and how each answer is applied once.
  - `adding-a-specialist.md`: the approval-flow section; the Known issues row is closed and
    two new limits are recorded.
  - `runtime.md`: `approval.ts`, the CLI table row and the tests.
  - `model-watch.md`: the eval runner's `candidate` input.
  - `testing.md`: the gate5 harness's new `specialists` half.
- **Status files**:
  - `docs/requirements.md`: C.5 set to `done`, with the new tests listed.
  - `docs/status/BLOCKERS.md`: the C.5 row now says the gate is built.
  - `docs/status/PROGRESS.md`: the item is listed as built on its branch, awaiting review.

### Tests that prove it

- `packages/runtime/test/specialist-approval.test.ts` (18 tests). The eval set runs through
  the real `LoopEvalRunner`, with the loop driver under the hooks, on the scripted fake
  provider. It checks:
  - **Filing:** a proposal files one request carrying the summary and eval-set size, and
    filing again returns the same request. A proposal for another human is refused.
    `fileMissing` files a request for a proposal already on disk.
  - **Pass:** approve runs the set (20 model calls, using the proposal's prompt), then the
    proposal is active and runnable, with the result in `proposal.json`. 9 of 10 passes at
    the threshold.
  - **Stays proposed:** 8 of 10 keeps it proposed, with the result in `proposal.json` and on
    the card and a note in the inbox. A set of 4 tasks, a run over budget and a missing model
    each run nothing. An eval error keeps it proposed. A proposal edited after filing is
    filed again.
  - **Reject:** withdraws the proposal and frees the name.
  - **Wrong human:** another human's answer, and the CLI path called as another human, run
    nothing.
  - **Applied once:** an unreadable answer is filed again. A second sync and two concurrent
    background syncs run the set once. `approve()` after a failure files a new request and
    promotes, and `evalHistory` reads `[false, true]`.
  - **Other:** `scripts/sync-registry.ts` copies a promoted specialist. The eval runner
    refuses a candidate that is not the named pending proposal. Pure tests cover
    `gateVerdict`, `specialistAnswer` and `activeTextOf`.
- `packages/runtime/test/specialists-cli.test.ts` (3 tests), through `composeRuntime`:
  approve on the daemon's `POST /requests/:id/answer` makes `rt.specialists(name)` defined.
  A failing set leaves it undefined. `fr specialists list`, `approve` and `reject` print and
  exit as documented.
- `packages/runtime/test/registry.test.ts` still passes (it ran within the 51 tests of the
  targeted run below).

### Commands run and results (2026-10-23, Linux build box)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | done |
| `pnpm typecheck` | exit 0 (node tsc plus the apps) |
| `pnpm lint` | exit 0 (59 warnings, all in files this item does not touch) |
| `pnpm exec vitest run --project unit packages/runtime/test/specialist-approval.test.ts packages/runtime/test/specialists-cli.test.ts packages/runtime/test/registry.test.ts` | 3 files, 51 tests passed |
| `pnpm exec vitest run --project unit packages/runtime/test` | 116 files passed; 1005 tests passed, 1 skipped |
| `pnpm exec vitest run --project integration packages/runtime/test` | 1 file, 4 tests skipped (`sandbox.integration.test.ts`: no container engine on the box) |
| `pnpm exec vitest run --project unit scripts/sync-registry.test.ts` | 1 file, 9 tests passed |
| `pnpm exec vitest run --project e2e tests/e2e/scenarios/phase5-gate.integration.test.ts` (it uses the edited `gate5-daemon.ts`) | 1 file, 4 tests passed |
| `pnpm exec vitest run --project e2e tests/e2e/scenarios` (the whole test directory of `@forerunner/e2e`, the package that owns the edited `tests/e2e/src/gate5-daemon.ts`; it is the package's own `test` script and has no other test files) | exit 0: 13 files passed; 24 tests passed, 1 skipped, 1 todo (26) |
| `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk` | `docs-check: ok (19 files)` (bare `node scripts/docs-check.mjs` exits 0, but there is no `origin/main` in this clone, so it checks nothing) |
| `pnpm check` | exit 0: lint, lint:paths, typecheck, unit tests (271 files; 2694 tests passed, 4 skipped, 1 todo), docs:check, link-check ok (106 files), secret-scan clean (1412 files) |

### Pasted output of the gating commands

`pnpm typecheck` (exit code 0, the tail of the output):

```
apps/approvals-web typecheck$ tsc -p tsconfig.json --noEmit
apps/desktop typecheck$ echo 'no TypeScript in the desktop shell; see @forerunner/ui'
apps/mobile typecheck$ echo 'no TypeScript in the mobile shell; see @forerunner/ui'
apps/ui typecheck$ tsc -p tsconfig.json --noEmit
apps/desktop typecheck: Done
apps/mobile typecheck: Done
apps/approvals-web typecheck: Done
apps/ui typecheck: Done
$ echo $?
0
```

`pnpm lint` (exit code 0; the 59 warnings are in files this item does not touch, and
`biome check` on the files this item changed reports none):

```
Checked 1162 files in 3s. No fixes applied.
Found 59 warnings.
$ echo $?
0
```

The docs check, against every base available in this clone. The script defaults to
`--base origin/main`, but the remote has no `main` branch (`git fetch origin main` fails with
`couldn't find remote ref main`). A bare run therefore prints "nothing to check" and proves
nothing, so the evidence is the two runs with an explicit base:

```
$ node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk   # the item's base branch
docs-check: ok (20 files).
$ node scripts/docs-check.mjs --base 16bb864                      # the starting commit
docs-check: ok (18 files).
```

`pnpm exec vitest run --project e2e tests/e2e/scenarios`, per file:

```
 ✓  e2e  tests/e2e/scenarios/phase5-gate.integration.test.ts (4 tests)
 ✓  e2e  tests/e2e/scenarios/phase4-gate.integration.test.ts (2 tests)
 ✓  e2e  tests/e2e/scenarios/06-injection.scenario.test.ts (2 tests)
 ✓  e2e  tests/e2e/scenarios/phase3-gate.integration.test.ts (4 tests | 1 skipped)
 ✓  e2e  tests/e2e/scenarios/phase7-gate.integration.test.ts (4 tests)
 ✓  e2e  tests/e2e/scenarios/09-phone.scenario.test.ts (2 tests | 1 todo)
 ✓  e2e  tests/e2e/scenarios/01-good-day.scenario.test.ts (1 test)
 ✓  e2e  tests/e2e/scenarios/05-budget.scenario.test.ts (1 test)
 ✓  e2e  tests/e2e/scenarios/08-handover.scenario.test.ts (1 test)
 ✓  e2e  tests/e2e/scenarios/04-collision.scenario.test.ts (1 test)
 ✓  e2e  tests/e2e/scenarios/07-bad-update.scenario.test.ts (2 tests)
 ✓  e2e  tests/e2e/scenarios/02-email-task.scenario.test.ts (1 test)
 ✓  e2e  tests/e2e/scenarios/03-voice.scenario.test.ts (1 test)
 Test Files  13 passed (13)
      Tests  24 passed | 1 skipped | 1 todo (26)
```

Touched packages and their full test runs: `@forerunner/runtime` (`packages/runtime/test`,
unit: 116 files, 1005 passed, 1 skipped; integration: 1 file, 4 skipped, no Docker) and
`@forerunner/e2e` (`tests/e2e/scenarios`: 13 files, 24 passed, 1 skipped, 1 todo).

### Patch export and verification

```
$ git format-patch --stdout $(cat /tmp/start-sha)..HEAD > /mnt/session/outputs/w3-c5-specialist-approval.patch
$ git worktree add --detach /tmp/verify 16bb864   # a clean checkout of the starting commit
$ cd /tmp/verify && git status --short | wc -l
0
$ git apply --check -v /mnt/session/outputs/w3-c5-specialist-approval.patch
Checking patch packages/runtime/src/registry/approval.ts...
...
Checking patch docs/status/reviews/w3-c5-specialist-approval.md...
$ echo $?
0
```

The check ran on the patch before this section was added and again on the final export,
which includes this commit. Both exited 0. `git log --oneline 16bb864..HEAD` lists exactly
this item's commits (eight, including this report update). Each one ends with the trailer
`Claude-Build: managed-agent w3-c5-specialist-approval build`.

### Left open, and why

- **A live approval run on the real provider.** The tests use the fake provider. A live run
  costs money and needs a real proposal with 10 or more mechanically checked tasks; it
  should be recorded in gates.md when one is made.
- **Rubric-only eval sets cannot pass yet.** Sets like researcher's leave every task
  `needs_model`, and the gate counts only mechanically decided tasks. The fix is for the
  critic to grade eval rubrics inside the runner. Recorded in `adding-a-specialist.md`
  Known issues and in ADR 0071.
- **No UI card renderer for the `specialist:` card yet.** The inbox shows it as a generic
  approval with options and steps. A dedicated view (proposal diff, eval history) belongs
  with the Extensions/registry UI; no proposals list exists there today.
- **The running daemon's registry `files` and `hash` are not recomputed on promotion.**
  Only `specialists` is updated, which is what the executor reads. The next start picks up
  the new file in the hash.
- **The PM has no tool that calls `propose()`.** The gate is wired (`RuntimeApp.specialistApprovals.propose`),
  but exposing it as a principal-agent tool or command was not in this item's paths.
