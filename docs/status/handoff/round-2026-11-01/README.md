# Round of 2026-11-01: working state kept in the repository

The cloud container that ran this round keeps its scratch files in /tmp/frbench, which is lost when the
container is reclaimed. What a later session needs is copied here. The plan itself is in
`../NEXT-SESSION.md`.

- `phase-c-spec.json`: the four phase C areas (verification, continuity, github-result, research-web) with
  their problems, root causes, fix scope, files, acceptance and shared-file ownership. The workflow script
  `phase-c.workflow.txt` reads it from `/tmp/frbench/phaseC.json` (copy it there first).
- `leftovers.json`: items for later phases. `phase-C` (folded into the spec), `later` (phase E, the
  leftovers sweep: real problems first, polish batched), and the per-area lists the fix waves used.
- `live-reports/`: what the real-model walks found, in order. live1 was the first real-model run (plans
  rejected 5 of 6 times), live2 covered steering and failures (its part 3 is on current code), live3 is the
  phase B confirmation (4 of 4 plans first time, work that runs), live4 covered every specialist (phase D).
- `wip/`: phase C work stopped at the weekly-limit warning on 2026-11-02 03:00 UTC. It has NOT been reviewed
  or validated. Each patch applies on 7765efd (`git apply --index wip/<area>.patch` in a worktree at 7765efd).
  `verification.patch` is the fixer's partial work: critic rules and evidence, `loop/project-checks.ts`,
  `loop/try-it.ts`, `test/verification.test.ts`. `continuity.patch` has two finished commits (the person's
  answers reach the waiting task; the Start dialog's budget sentence) plus partial work (the budget card).
  A fixer continues from it; the independent review and the merge pipeline still apply in full.
