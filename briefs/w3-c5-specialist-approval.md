## title

A proposed specialist goes live only after human approval and a passing eval set

## requirements

C.5 (C.1 to C.4 context)

## adr

0071

## brief

BLOCKERS.md row C.5 a proposed specialist going live: **partly built**: `proposeSpecialist` writes the proposal and the loader keeps it `runnable: false` (`packages/runtime/test/registry.test.ts`); the human approval and the eval-set gate that make it active are not built. Stand-in: a human runs the eval set by hand (`evals`) and sets the file's `status` to `active`: the same gate, done manually, and nothing runs before that. Needed: an approval route that runs the eval set and promotes the file on a pass; then C.5 `done`. Spec C.5: 'PM can propose a new specialist; it goes live only after human approval and passing its eval set.' Note: the machine is shared with other builders; a test that fails only on a timeout under load is re-run once before it is treated as real.

## hints

Read packages/runtime/src/registry (proposeSpecialist, the loader, proposed/<name>/ layout, proposal.json, the required steps it returns), docs/maintainers/adding-a-specialist.md (Known issues names this gap and the approval command's intended behaviour: human approval, moving proposed/<name> to specialists/, recording the eval result in proposal.json), packages/runtime/src/models/eval-runner.ts (how an eval set runs on the fake provider; evals/registry eval sets; a proposal must come with its eval set, at least the minimum count the spec or the doc names), the daemon's approvals (syncApprovals in compose.ts; human_request kinds), the commands registry (a `specialist.approve` command? check the catalog) and the Extensions/registry UI if one lists proposals. Build: a proposal files a human_request (kind approval, change_card key `specialist:<name>`, the proposal's summary and the eval-set size in the card); on 'approve' the daemon runs the eval set through the eval runner (fake provider in tests; a real model under the budget hooks in production, with the spend charged to the human's testing share), records the result in proposal.json (pass rate, date, model), promotes the files to specialists/ (status active, runnable true in the loader) only on a pass above the threshold the registry defines (record it), otherwise keeps it proposed with the failure in the card and a note to the inbox; 'reject' withdraws it; the registry sync script (scripts/sync-registry.ts) keeps working. Also a CLI path (`fr specialists approve <name>`) for the headless case. Tests: packages/runtime/test/specialist-approval.test.ts (approve -> evals run -> pass -> active; fail -> stays proposed with the result; reject -> withdrawn; the request idempotent; another human refused), registry.test.ts kept green, the CLI test. Docs: adding-a-specialist.md (the Known issues row closed, the approval flow), runtime.md. ADR 0071: the threshold and where results are recorded.

## paths

packages/runtime/src/registry, packages/runtime/src/models/eval-runner.ts, packages/runtime/src/daemon/compose.ts, packages/runtime/src/cli, tests
