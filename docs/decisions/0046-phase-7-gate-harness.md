# 0046 — Phase 7 gate harness: Forerunner as a project, the release built from main, two installs on one release table, the model watch on the fake provider

Date: 2026-10-20
Status: accepted

## Context

The phase 7 gate (spec, build order) reads: "A UI change requested in plain language ships as
an update both users install, and a deliberately broken build rolls back on its own." The
phase also adds the weekly model watch (spec D.6, D.21). The harness
`tests/e2e/scenarios/phase7-gate.integration.test.ts` proves the gate end to end on the fake
provider, on the scenario world of the nine release scenarios. The spec leaves open what
"Forerunner as a project" is in a test, what builds the update from a merged PR, what "both
users" means on one shared state, how a second install learns that a release broke on the
first, and how a weekly eval run is made deterministic. These are the decisions.

## Decision

1. **Forerunner as a project is a stand-in repository** on the fake git host
   (`tests/e2e/src/gate7-release.ts`, `FORERUNNER_FILES`): the standard docs (`README.md`,
   `AGENTS.md`), the module's maintainer doc (`docs/maintainers/apps.md`) and the one UI file
   the request is about (`apps/ui/src/inbox-badge.ts`). The project row is the world's
   project named "Forerunner". The real repository is not cloned: the gate is about the
   flow, and a clone would make the harness depend on the checkout it runs in.

2. **The request enters through the conversation agent's model path.** "make the inbox
   badge show the blocking count" matches no parser pattern (`matchTask` only knows "make
   this a task"), so the sentence goes to the fast model with the registry's command tools
   and the scripted model calls `task_create` with a ready, tier 2 task. Nothing is added to
   the parser for the gate: a free-form feature request is exactly the case the model path
   exists for (spec Q.2), and the task lands in the project's list with a change log row
   carrying the words used (spec M.1, Q.6).

3. **The PR carries the module's maintainer doc.** The critic's docs-drift rule (spec G.6)
   sent the first draft back at tier 2 because `apps/` changed without
   `docs/maintainers/apps.md`. The harness keeps the rule and has the coder write the doc in
   the same PR, as AGENTS.md demands of every change; the rule is not relaxed for the gate.
   The critic reviews at tier 2 on the opus rung (the task's risk tier; spec M.2) and the
   human merge is the approval.

4. **The release is built from `main` by the harness, not by a build.** `releaseFromMain`
   reads the UI file from the default branch after the merge and publishes it verbatim with
   `app/VERSION`, the build's doctor and a changelog line naming the request and the PR,
   through the publish job's steps of `scenario-update.ts` (one zip per platform, the
   Ed25519-signed manifest as a release asset). A Tauri build of the real app is a release
   workflow concern (`.github/`), out of the harness's reach; what the gate proves is that
   the merged change is what both installs stage and run.

5. **"Both users" are two updaters on two homes over the shared store.** Alice's and Bob's
   installs each get `scenarioUpdater` (own `FORERUNNER_HOME`, own restarter, probe and
   notifier, own human for inbox rows and audit rows) on the world's one `release` table.
   One release row per version is shared; its `health` is written by whichever install
   checked last; audit rows and inbox items are per human.

6. **The second install learns a release broke from the shared release row.** There is no
   peer feed message for a rollback. `UpdateManager.assertNotRejectedBefore` reads the
   `release` row by channel and version from the store and refuses a version whose status
   is `rolled_back` or `failed`; because the store is shared, Alice's automatic rollback
   makes 1.2.0 `previously_rejected` for Bob's next check before any download. The harness
   proves this as the "peer reports it broken" rule. The refusal's text says "on this install
   before", which is inaccurate when the row came from a peer; a wording fix in the runtime
   is filed, not made here.

7. **The model watch runs the real coder eval tasks through `@forerunner/evals`, not the
   daemon's `LoopEvalRunner`.** `LoopEvalRunner` grades `command_exit0` checks only inside a
   sandbox lease and the world has none, so every coder task would count as an error. The
   harness backs the `EvalRunnerPort` with `runEvalSet` (the orchestrator may inject an
   evals-backed runner through `ComposeOptions.evalRunner`) and a driver that asks the fake
   provider once per task and effort (`model-watch eval <task> at <effort>`) and writes the
   task's reference solution when the provider answers PASS; the grader then runs the real
   checks (node on the files). The driver accepts only PASS or FAIL and the runner rejects
   when a task errored: `runEvalSet` counts a throwing driver as a failed task and a bare
   `FakeProvider` echoes an unscripted probe, so a model listed without a script would
   otherwise read as a quality delta instead of a scripting gap (a guard test in the
   harness pins this). The first four tasks of the registry's coder set are used
   (above `minEvalTasks`, under the time budget); the scripted baseline fails one task at
   every effort and the candidate none, a lower effort answers with half the output tokens,
   the candidate is priced at half the sonnet rung by the price list. The deltas the report
   measures are therefore +25 quality points and -50% cost for the switch and -35.71% for
   the lower effort, from the grader and the usage, not from constants in the test.

8. **The weekly trigger is the session `Scheduler` with `scheduleModelWatch`, ticked by hand.**
   The harness composes a scheduler whose `start` routes `isModelWatchRequest` to
   `ModelWatch.run()` as `compose.ts` does, and ticks it at the minutes the test chooses
   (the first tick is the first weekly run; a day later nothing fires; a week later the
   second run fires on the first tick past the week). The daemon's minute interval is the
   same tick on a timer.

9. **The gate row's status is "harness passed on the fake provider".** The real UI build,
   the Windows and Android runs and the live-model run of the model watch remain for the
   final build, as for the other scenario rows.

## Consequences

- The harness proves every clause of the gate sentence in code paths that are the
  production ones: the registry, the session runner, the PR executor, the critic, the
  updater, the health check, the rollback, the model watch and its approval port.
- A change to the docs-drift rule, the tier rules, the rollback rule or the watch
  thresholds (ADR 0019) shows up here as a failure with the measured numbers.
- The cross-install refusal depends on the shared `release` table. An install on its own
  SQLite store (solo mode) has no peer and the rule is moot; two installs on separate
  stores would not learn from each other, which is the state service's job (spec M.4 does
  not ask for more).
- The evals part costs about ten seconds of real node processes per run; raising
  `EVAL_TASKS` raises it linearly.

## Alternatives considered

- **Cloning the real Forerunner repository** as the project: rejected (decision 1); the
  harness would depend on its own checkout and the git host's size limits.
- **A parser pattern for feature requests**: rejected (decision 2); the model path is the
  spec's answer for free-form requests, and the gate should exercise it.
- **Switching the docs-drift rule off for the gate**: rejected (decision 3); never weaken a
  check to make it pass.
- **A broken release that breaks on both installs**: rejected; the spec's sentence is about
  one rollback, and the second install never taking the release is the stronger proof.
- **The daemon's `LoopEvalRunner` with the process sandbox stand-in**: rejected (decision
  7); the stand-in's commands run on the host under a different contract and the gate is
  not about sandboxes.
- **Synthetic eval tasks** as in the model watch unit tests: rejected; the gate should run
  the registry's own set through the real grader so the deltas are measured.
