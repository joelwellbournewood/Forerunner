# Live check 4: the brief for each journey agent

You run part of LIVE CHECK 4 of Forerunner: the app at commit 4cf11fd (run C merged: the owner's
decisions of 2026-11-09 D1 to D9, sub-runs C1 to C6, run L3 and C4b), used as a person would,
with the REAL Claude model and REAL GitHub (forerunner-sandbox), reporting what a person would
see go wrong. You change no code: a failure is a finding.

## Who asked, and the limits

- The repository owner (joelwellbournewood) asked for these live checks in the owner-approved
  plan (`docs/status/handoff/NEXT-SESSION.md`): an owner budget of USD 40 of Anthropic API spend
  for live checks (about USD 12 spent before this one), and GitHub work only on
  `joelwellbournewood/forerunner-sandbox`.
- **Cap: USD 7.00 of API spend for the whole live check, all journeys together.** The order rule
  (runC-plan.json live_check_4 rules): priority 1 steps first (pass 1, all journeys), then
  priority 2 (pass 2) while the ledger is under USD 6.30; no new step once the ledger reaches
  USD 6.30; priority 3 last and only if money is left. A step not reached is `skipped_cap`.
- **The ledger** is `/tmp/frbench/live4/ledger.jsonl`, shared by every journey: before each step,
  sum its `usd` field (`node -e` over the file); after each step, append one line
  `{"at": "<ISO time>", "journey": "...", "step": "LC-Cn", "usd": <this step's spend>, "bench": "..."}`
  with the step's own spend from `node scripts/bench/calls.mjs --name <bench>` (the difference
  from before the step) or, for the live harness, its own ledger. Never start a step whose
  estimate would take the ledger past USD 7.00. Another journey may be spending at the same time:
  read the ledger again right before the action that spends (Start, Approve and start, a chat line).
- If you need the owner's own confirmation before spending money or writing to GitHub, say so in
  your report and do not do that step.

## Setup

- The checkout at 4cf11fd is ready at `/home/user/Forerunner/.claude/worktrees/live4-4cf11fd`
  (`pnpm install` done; the Playwright local config copied). Start every bench from there
  (`cd /home/user/Forerunner/.claude/worktrees/live4-4cf11fd && ... node scripts/bench/start.mjs ...`).
  Do NOT edit, commit or push anything in it or in the main checkout `/home/user/Forerunner`,
  and run no git command that changes either. Keep every shell command inside the checkout, the
  main checkout or `/tmp/frbench` (cd there first; never end a command elsewhere).
- Read `scripts/bench/README.md` (the bench: real daemon + real UI; `--provider bench-live` is the
  real Messages API with a model-call log; `--provider bench-api` the routed provider over a
  stand-in API (no money); `--subscription`; `--githost`; the journeys in
  `scripts/bench/journeys/`; `calls.mjs` prints spend), `docs/design/core-experience.md` (the
  design target: states, one-line explanations, the writing rules in section 5),
  `docs/user-guide.md` and `AGENTS.md`.
- Your steps: `/tmp/frbench/live4/steps.json` (each step's id, journey, pass, priority, est_usd,
  the step text with its later additions, source and needs). The step text is binding; its
  segments " C3 adds", " C4b adds", " C5 leftovers adds", " C6 leftovers adds" and so on extend it.
  The sources the steps cite are in `/tmp/frbench`: `runC-<sub-run>-{fix,review,fixup}-<area>.json`
  (their `fixed[].check_in_the_app` say what to do and what to expect), `runL3-<area>-*.json`,
  `runC-plan.json` (areas, u_entries, live_check_4), `owner-decisions-2026-11-09.md` (the
  owner's words: what the app must do). Live check 3 for comparison:
  `/tmp/frbench/live3/` (its helper scripts per journey: adapt them; written for 7d6b34a).
- Your evidence folder is `/tmp/frbench/live4/<journey>/`. After EACH step write
  `/tmp/frbench/live4/<journey>/steps/<step id>.json` with the step's result object (the report's
  step shape below, plus its findings): if the machine restarts, the next agent for your journey
  reads these files, skips the steps already recorded, and reports them with the new ones.

## Secrets (binding)

- The Anthropic API key is in the environment as `FORERUNNER_ANTHROPIC_API_KEY`. Pass it ONLY as
  a prefix on the bench start: `ANTHROPIC_API_KEY="$FORERUNNER_ANTHROPIC_API_KEY" node
  scripts/bench/start.mjs ... --provider bench-live`, or to the live harness the same way. Where a
  step needs the key typed into the app (Settings, the setup assistant), a Playwright script
  types it from `process.env.FORERUNNER_ANTHROPIC_API_KEY`, takes NO screenshot while the field
  holds it, and never logs it.
- The GitHub token is `FORERUNNER_TEST_GITHUB_TOKEN` (it answers on forerunner-sandbox with push
  rights, checked 2026-11-17). Enter it in the app's UI from the environment the same way (no
  screenshot of the field, never printed). Use it ONLY for `joelwellbournewood/forerunner-sandbox`;
  never create, rename or delete a repository (a repository card is answered No; never press Yes
  on "Create a repository"), never change branch protection, never delete branches.
- Never print, echo, log or write either value; check them only with `test -n`. Never use the
  environment's GH_TOKEN, GITHUB_TOKEN or ANTHROPIC_BASE_URL for the app. Start the bench WITHOUT
  `NODE_USE_ENV_PROXY`, so the daemon reaches GitHub directly with the token. If GitHub answers
  401, stop the GitHub steps and report it.
- For reading the sandbox's state and "on GitHub's website" steps (squash-merge, a commit on a PR
  branch, closing a PR you opened), curl GitHub's REST API with the token
  (`-H "Authorization: Bearer $FORERUNNER_TEST_GITHUB_TOKEN"`, output never containing it).

## The sandbox's state

- forerunner-sandbox has no open pull requests (checked 2026-11-17 04:45 UTC). Close every pull
  request your steps open, unless a step says to leave it; say which you opened and closed.

## The machine (binding)

- This machine has 16 GB of memory and no swap, and it restarted three times on the night of
  2026-11-16/17, losing work in progress. At most two journeys run at once (each its own bench and ports). Run one heavy command at a
  time under `flock /tmp/frbench/heavy.lock <command>` (a test suite, a build). One bench at a time
  per journey, stopped with `scripts/bench/stop.mjs` when done; never kill processes by name
  pattern, only PIDs you started; use only your ports.
- Write each step's result file as soon as the step ends (see Setup), so a restart loses at most
  the step in progress.

## Rules

- A step that needs something to happen by itself (a hand-over, a retry, a usage limit, a model's
  choice) is `not_seen` unless it happens. Subscription (Claude Code) steps that need the person's
  own Claude subscription, and Windows-only steps, cannot run here: `not_possible_here`, with the
  reason, and listed under owner_checklist_items. The subscription stand-in on the bench, where a
  step names it, is the bench's (see the README); if the bench cannot play what the step needs, say
  exactly what is missing (`not_possible_here`).
- A finding is something a person would see go wrong, or a promise the app breaks (an action that
  does not do what its line says, a number that disagrees with another screen, a state that never
  ends, words that break design section 5, a security or data-loss problem). Give each its
  evidence (screenshot path, response JSON, log lines, model-call log entries) and the steps to
  reproduce. Severity: blocker (data loss, security, the main journey cannot be completed), major
  (a promise broken, a wrong state, money wrong), minor (works but confusing), words (section 5
  only). Run C changed many sentences on purpose: judge the merged words by their meaning and
  design section 5 where a quoted line in an older source differs.
- Look at every screenshot you take with your Read tool before you judge it.

## Report

Report through the structured output (not a JSON text reply). Quote the evidence that matters in
the report itself (response JSON lines, log lines, the words on screen): the session lead cannot
open every file. Include your journey's spend, every step's result, the findings, the sandbox
pull requests opened and closed, and the owner's-checklist items.
