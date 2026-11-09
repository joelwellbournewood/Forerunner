# Live check 3: brief for the session that runs it

You run LIVE CHECK 3 of Forerunner: the app at commit 7d6b34a (wave 15 merged: runs A and B),
used as a person would, with the REAL Claude model and REAL GitHub (forerunner-sandbox), and
you report what a person would see go wrong. You change no code: a failure is a finding.

## Who asked, and the limits

- The repository owner (joelwellbournewood) asked for these live checks as part of the plan in
  `docs/status/handoff/NEXT-SESSION.md` (owner-approved): live checks with the real model, an
  owner budget of USD 40 of Anthropic API spend for them (about USD 10 spent so far), and
  GitHub work only on `joelwellbournewood/forerunner-sandbox`. On 2026-11-09 the owner renewed
  the test token (`FORERUNNER_TEST_GITHUB_TOKEN`) for exactly this check.
- **Cap: USD 3.00 of API spend in all.** Run steps in priority order (all priority 1, then 2,
  then 3). Start no new step once the spend reaches USD 2.60. Dropped first to last: X5, X6,
  X7, X8, B1, X9, X4, X3, X2, G7, X1, R4. A dropped step is reported as `skipped_cap`.
- If you need the owner's own confirmation before spending money or writing to GitHub, say so
  in one line and wait for it.

## Setup

1. The repository is checked out at 7d6b34a (check `git log -1`; if not, `git fetch origin
   claude/nifty-knuth-f9udt0 && git checkout --detach 7d6b34a`). `pnpm install
   --frozen-lockfile`. Read `scripts/bench/README.md` (the bench: real daemon + real UI;
   `--provider bench-live` is the real Messages API with a model-call log; `calls.mjs` prints
   spend; the journeys in `scripts/bench/journeys/`), `docs/design/core-experience.md` (the
   design target: states, one-line explanations, the writing rules in section 5) and
   `AGENTS.md`.
2. The plan files: `git fetch origin claude/nifty-knuth-f9udt0-backup/plan-files`, then
   `mkdir -p /tmp/frbench && git archive FETCH_HEAD frbench | tar -x -C /tmp` (this writes
   `/tmp/frbench/...`). Your inputs:
   - `/tmp/frbench/live3/steps.json`: the steps (id, journey, priority, est_usd, step, source,
     needs), the owner checklist and the environment notes. Additions (`addition: true`)
     revise or extend a step with the same id.
   - The sources the steps cite: `/tmp/frbench/phaseE7-live.md`, `phaseE7-live-extra.md`,
     `phaseE7-live-w12w14.md`, `wave15a-fix-<area>.json` / `wave15a-fixup-<area>.json` and
     `wave15b-fix-<area>.json` / `wave15b-fixup-<area>.json` (their `fixed[].check_in_the_app`
     say what to do and what to expect), `wave15-areas.json`, `wave15b-areas.json`.
   - Live check 2 for comparison: `/tmp/frbench/live2-result.json`, and its helper scripts in
     `/tmp/frbench/live3/live2-scripts/<journey>/` (Playwright helpers for approving a plan,
     answering cards, chat, reading the Overview: adapt them; they were written for 7d54fff).
3. Write your scripts and evidence under `/tmp/frbench/live3/<journey>/` (journeys: github,
   run, research).

## Secrets (binding)

- The Anthropic API key is in the environment as `FORERUNNER_ANTHROPIC_API_KEY`. Pass it ONLY
  as a prefix on the bench start: `ANTHROPIC_API_KEY="$FORERUNNER_ANTHROPIC_API_KEY" node
  scripts/bench/start.mjs ... --provider bench-live`. Where a step needs the key typed into the
  app (Settings, the setup assistant), a Playwright script types it from
  `process.env.FORERUNNER_ANTHROPIC_API_KEY`, takes NO screenshot while the field holds it, and
  never logs it.
- The GitHub token is `FORERUNNER_TEST_GITHUB_TOKEN`: enter it in the app's UI from the
  environment the same way (no screenshot of the field, never printed). Use it ONLY for
  `joelwellbournewood/forerunner-sandbox`; never create, rename or delete a repository (a
  repository card is answered No; never press Yes on "Create a repository"), never change
  branch protection, never delete branches.
- Never print, echo, log or write either value; check them only with `test -n`. Never use the
  environment's GH_TOKEN, GITHUB_TOKEN or ANTHROPIC_BASE_URL for the app.
- GitHub without the proxy: start the bench WITHOUT `NODE_USE_ENV_PROXY`, so the daemon reaches
  GitHub directly with the token (live check 2 had to go through an agent proxy because the
  old token had expired; that is no longer needed, and the steps' words "GitHub via the proxy"
  now mean "GitHub with the real token"). If GitHub answers 401 with the token, stop the GitHub
  steps and report it.
- For reading the sandbox's state and doing "on GitHub's website" steps (squash-merge, a
  commit on a PR branch, closing a PR you opened), curl GitHub's REST API with the token
  (`-H "Authorization: Bearer $FORERUNNER_TEST_GITHUB_TOKEN"`, output never containing it).

## The sandbox's state

- Open on forerunner-sandbox from earlier test benches (2026-11-01/02, their homes deleted):
  #1 (fr/docs-scaffold), #2, #3, #6, #7. Leave them open (the owner has not yet answered
  whether to close them) and note if the app reads, lists, comments on or pushes to any of
  them: by W15-01's legacy rule an unmarked docs or status pull request counts as a project's
  own only while it is the one project of the install linked to the repository.
- #5 (fr/status) was closed on 2026-11-09 with the owner's OK. G2's part (1) needs a
  marker-less PR on fr/status; open one by hand only if the step says so, and close it after.
- Close every pull request your steps open and leave open, unless a step says to leave it.

## Rules

- One bench at a time; stop it with `scripts/bench/stop.mjs` when done. Never kill processes by
  name pattern; stop only PIDs you started.
- Check spend after each step: `node scripts/bench/calls.mjs --name <bench> --cap <usd>`
  (exits 3 at the cap). For the routed provider (no --provider), read the app's Costs tab and
  the ledger.
- A step that needs something to happen by itself (a hand-over, a retry, a usage limit, a
  model's choice) is `not_seen` unless it happens. Subscription (Claude Code) steps and
  Windows-only steps cannot run here: `not_possible_here`, listed under owner_checklist_items.
  New this time: the setup assistant's GitHub check can run with the real token; try it once
  (step G0 below) and report it.
- A finding is something a person would see go wrong, or a promise the app breaks (an action
  that does not do what its line says, a number that disagrees with another screen, a state
  that never ends, words that break design section 5, a security or data-loss problem). Give
  each its evidence (screenshot path, response JSON, log lines, model-call log entries) and
  the steps to reproduce. Severity: blocker (data loss, security, the main journey cannot be
  completed), major (a promise broken, a wrong state, money wrong), minor (works but
  confusing), words (section 5 only).
- Wave 15 changed many sentences on purpose: where a quoted line in an older source differs,
  judge the merged words by their meaning and design section 5.

## Extra step

- **G0** (priority 1, about USD 0.02): fresh bench home, setup assistant: connect GitHub with
  the token typed from the environment (no screenshot of the field); expect the check to pass
  and forerunner-sandbox to be offered. Then link a project to it.

## Report

Reply at the end with one JSON object (and nothing secret):

```
{ "base": "7d6b34a", "spend_usd": { "github": n, "run": n, "research": n, "total": n },
  "steps": [ { "id", "journey", "result": "pass|fail|partial|not_seen|skipped_cap|not_possible_here",
               "what_happened", "evidence": [paths or quoted lines] } ],
  "findings": [ { "id": "L3-<journey>-<n>", "severity", "step", "what_the_person_sees",
                  "expected", "evidence", "repro" } ],
  "sandbox_prs": { "opened": [..], "closed": [..], "left_open": [..], "old_prs_touched": [..] },
  "owner_checklist_items": [..], "notes": ".." }
```

Quote the evidence that matters in the report itself (response JSON lines, log lines, the
words on screen): the session lead cannot open your files.
