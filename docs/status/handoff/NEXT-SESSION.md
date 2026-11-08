# Next session: make Forerunner work for a person, and be intuitive

Handoff written 2026-11-01 at the end of session `claude/dreamy-johnson-2zfr0m`. Read this first,
then `AGENTS.md` and `docs/maintainers/validation.md`. Do not re-plan from scratch: the owner
has approved this plan and asked for it to be done thoroughly, hands-on, for real.

## Where things stood at the start of the round

- Branch `claude/dreamy-johnson-2zfr0m` = `claude/adoring-meitner-ebkoom` (012c9009, U-018 to
  U-088 fixes, the newest work) plus this handoff. Work on this branch.
- Nothing has been changed in the product yet in this round. The test run below was started and
  stopped before it wrote anything.
- The owner is adding an Anthropic API key to the cloud environment as the environment variable
  `ANTHROPIC_API_KEY` (preferred), or as a network secret for `api.anthropic.com` with the
  header `x-api-key` and no prefix. **Step 0 below checks which one works.** Never print, log or
  commit the key; never ask the owner to paste it into chat.

## Status at 2026-11-08 22:00 UTC (wave 7 group 6: wave 13 running)

The weekly limit reset on 2026-11-08 at 05:00 UTC and the work resumed then, on the included
plan (no paid extra usage). Session `claude/nifty-knuth-f9udt0` carries on; its scheduled
check-ins pick the work up if a run stops.

- **Merged and pushed at ce13bb1** (wave 14). CI and the Desktop app workflow (Windows and Linux
  builds, the installed-app check and the real-window check) were green on ca2c58d (wave 12;
  the Desktop app run's Windows Playwright job failed once on `e2e/extensions.spec.ts:67`,
  `page.goto` net::ERR_ABORTED, a flaky test on a path wave 12 did not touch, and passed on
  the re-run). On ce13bb1 they were running when this was written (CI on Linux had
  passed lint, the unit, UI, integration and gate tests); this docs-only commit runs CI again
  on the same code. Merged so far:
  - phase C (verification, continuity, GitHub result, research on the web);
  - phase E wave 5 (answers, screens, noise, bench) and wave 6 (stops, asking, decisions,
    verification);
  - wave 7 group 1 (the merge record, ADR 0111; the budget stop, ADR 0112; desktop polish, with
    Ctrl- and Shift-click on the app's own links acting as a plain click);
  - wave 7 group 2 (dependent branches, credential limits);
  - wave 7 group 3: Merge in the app, with a per-project "Who merges accepted work" setting
    ("You press Merge" by default; no autonomy level merges by itself any more); the credential
    chooser; cost (prompt caching, honest estimates); this computer's copy following every merge,
    with its Local only folder (ADR 0113);
  - wave 7 group 4: a task paused at a budget keeps its work as a commit on its own branch and
    continues from it, with one Inbox card ("Continue (CHF N more)" or "Cancel task"; at the
    month cap or the project's budget it goes on by itself once that limit is raised or
    resets); research on the API key searches the web (at most 10 searches a task, priced in
    the estimate). ADRs 0112 and 0107 are amended;
  - wave 7 group 5: "Take this work out" on a merged task opens a pull request that removes its
    changes from main (merge, squash and rebase merges; you merge it); "Open this version" puts
    a waiting pull request's files in a folder on this computer; no repository is created
    without a yes, at any level; research reads any public website, or only (or never) the
    sites listed per project, on both credentials, never this PC or the home network. ADRs 0097,
    0107 and 0113 are amended;
  - wave 12 (two of its three areas, independently reviewed and fixed up in wave 14):
    same-titled tasks get their own branch and pull request; a run cut short by a crash leaves
    nothing behind; a merge made later by the retry pass files an Update; the rebuild card
    offers Merge and Redo; a review refused at a budget or by a credential pauses or waits
    instead of failing; under "Wait" only the tasks that must wait wait; recovery says what a
    session did and spent; the plan card's estimate equals the Start dialog's;
  - wave 14: the agent browser drops Chromium's own sandbox only when the browser says the
    sandbox cannot start (W6-30); a stored "only these websites" rule never reads as "any
    website"; the Overview's research line follows a change made in chat; the subscription's
    hook no longer sends Claude Code a replacement it rejects for file reads; a stopped run's
    late cost and each model's cost are booked; credential waits keep a start until it runs, end
    when another credential can do the work, and the Start dialog says the wait; the chooser
    reads a decision already recorded; rebuilds owed survive a restart; one folder lock for
    rebuilds and merges, so a merge never takes an unrebuilt head; a chain of three is rebuilt
    whole; a pull request that stops being mergeable gets a card whose Redo does the task again
    from main; Files says when this computer's copy stops following; a merge made later raises
    a desktop notification. Fix-ups from the reviews: one repository card whatever the order;
    the rebuild card's Redo starts from main; after a crash the session page shows the ledger's
    spend; a conflict resolved on GitHub offers Merge only on the reviewed head;
  - F2: the real window on Windows CI, and Docker full review on Linux;
  - test temp files go in one folder per run, removed at its end.
- **The owner's decisions of 2026-11-02** are built in waves 7 and 8: merging, Autopilot, the
  local copy, the Local only folder, the PR preview, credentials, budgets, web search, the site
  rules, Ctrl-click, the status issue, the standard repository guide and collaboration. Their
  full text is in the plan files backup below. Each is recorded in its ADR as it is built; the
  user-guide entries are checked in phase G.
- **Group 6 is four waves.** Every leftover of groups 1 to 5 (246 items, 210 after merging
  duplicates) was checked against the code at fa1a86f (`wave7g6-triage.json` in the plan
  files): 42 real problems, 34 new polish items, 14 live-check steps, 11 owner questions, 2 for
  wave 8, the rest already fixed or not a problem.
  - **Wave 12** (run `wf_294ae3cd-fb8`) merged leftovers7-merge (11 of its 16 problems) and
    leftovers7-session (all 10) at ca2c58d, with the full suite and the bench smoke green. The
    run then broke: the session's working folder fell back to `/home/user` while it ran, so no
    new agent worktree could be made. The independent reviews did not run, and leftovers7-web
    never started. Lesson: while a workflow runs, no shell command of the session lead may end
    outside `/home/user/Forerunner`.
  - **Wave 14** (run `wf_8c348d94-071`) merged leftovers7-web, the independent reviews of the two
    wave 12 areas with their fix-ups (the reviews found 4 blocking problems, all fixed), and
    leftovers7-merge2 at ce13bb1: 35 commits, all signed; the full suite (4,904 unit tests,
    952 UI tests, integration, e2e, the live harness dry run, the injection suite, Playwright)
    and the bench smoke (25 of 25) green. Reports: `wave7g6c-*.json` in the plan files.
  - **Running now: wave 13** (run `wf_06cd7061-9f6`, started 21:40 UTC on ce13bb1), four areas:
    polish-words (53 items: the 46 planned plus the sentences waves 12 and 14 added) and
    polish-screens (24), with separate files; and two small logic areas for what the wave 14
    reviewers found but did not block on: leftovers7-tailmerge (10: a redo whose run changes
    nothing leaves an empty pull request offered for Merge; a person's half-done conflict
    resolution is aborted; a merge waiting for a rebuild says nothing; git messages read in one
    language) and leftovers7-tailrun (16, first a security gap: on the subscription a secret's
    value in a repository file reaches the model unredacted; also the Start dialog recording a
    wait when the person only looked, the New task line ignoring the typed words, and a paused
    review costing a second specialist run). One session-lead decision in it: opening the Start
    dialog records no wait; pressing Start does.
- **The plan files are on GitHub:** branch `claude/nifty-knuth-f9udt0-backup/plan-files`
  (refreshed after wave 13 started). It holds the wave 7 and 8 specs, the owner's decisions,
  the leftovers and their triage, each wave's results, the collaboration audit, the workflow
  scripts and the resume recipes. Its README says how to restore them and resume, on this
  machine or a fresh one. Delete it once wave 8 is merged.
- **Backup branches to delete:** the four `claude/nifty-knuth-f9udt0-backup/fix-*` branches
  (merge-in-app, credential-chooser, cost, merged-copy) are fully merged. The session cannot
  delete branches (GitHub answers 403), so the owner deletes them.
- **Next, in order:**
  1. wave 13: polish and the two small logic areas (running);
  2. live check 2 with the real model (it now includes budget resume, web search, the site
     rules, take-out and the preview; the triage lists the steps to add, and
     `phaseE7-live-w12w14.md` in the plan files collects the 52 steps of waves 12 and 14);
  3. wave 8: 16 areas in 8 groups (collaboration, the status issue, the repository guide);
  4. then F, G, G2 and H, as below.
- **Session-lead write-ups left for phase G** (the area agents may not edit them): the
  UPDATE-LOG entries (U-028, U-037, U-078, L-15, L-22 from group 3; U-042, C-36, W6-7, W6-23,
  C-30, C-37 from group 4's budget resume; group 4's web search entries; Q7 from group 1;
  group 5's take-out, preview, repository offer and site-rule entries: Q6, C-60, C-66, C-70,
  C-71, W6-29, W6-30, R-9), docs/requirements.md J.9 and J.10, and the CHANGELOG lines. Each
  area's suggested words are in its result file.
- **Cost estimate for waves 7 and 8,** from what earlier rounds used: about USD 2,200 at API
  prices (1,800 to 2,700), about three quarters of one week's included limit. Used so far
  since the estimate: about USD 730 (group 3's remaining work about 115, group 4 about 160,
  group 5 about 160, the group 6 triage about 90, wave 12 about 80, wave 14 about 130, rough).
- **API spend for live checks:** about USD 6 of the owner's USD 40.
- **Open owner questions** (today's behaviour stays until answered): 9 on collaboration
  (`collab/owner-summary.md`) and 6 from waves 5 and 6 (`owner-questions-wave56.md`), both in
  the plan files; from group 3, U-078 (does "Wait" also hold a refused API key's work, as built;
  should running commands be a hard need for code tasks on a project with dependencies) and
  U-037 (a Local only file changed by the person during a run: the person's version wins, as
  built). ADRs 0100 and 0113 give the options. From group 4, W6-23: should a task whose
  estimate alone is more than the session's work budget also get an Inbox card? As built it
  gets the Start dialog's warning and a line in the session's result, and no card, since it
  never ran. The group 6 triage adds 11 (`wave7g6-triage.json` owner_questions), several of
  them sharper forms of U-078 and W6-23: whether Redo or Try again on a Tasks row starts work;
  what "Wait" holds when a credential rests, is refused or reaches a plan-share or monthly cap;
  whether a large Local only folder is copied into every run; what the time on the Files line
  means; whether a conflicting take-out offers to draft a revert task; how the project line
  counts taken-out work. Wave 12 adds two for the session lead or the owner: how stale the
  Overview's view of GitHub's branch rules may be (a cache would save about 4 GitHub calls a
  look but show a rule change up to a minute late), and whether Merge on the rebuild card should
  merge a rebuilt pull request whose own change differs from the reviewed one (today it goes
  back to the person, as the Overview's Merge does).

## Progress, and the plan from here (approved by the owner, 2026-11-01 evening)

Session `claude/nifty-knuth-f9udt0` (the branch to work on) did steps 0 to 3 below and fix
waves 1 (session engine, Tasks screen) and 2 (Inbox, chat): merged, pushed, CI green on Windows
and Linux at c316eba. The walks found 132 problems, grouped into 67 (4 blockers, 46 major).
The real model ran for the first time (two live walks, about USD 1.20). It showed that a plan
from a brief was rejected 5 times out of 6, among other things (scratch reports were in
/tmp/frbench of that session: live1-report.md, live2-report.md, handoffs.json).

The owner approved this plan for the rest of the round. **Done means:** a person goes from a
brief to finished work they can open, with the real model on their own PC, without the app
getting stuck or saying anything untrue; each of the owner's 8 complaints has a "Check in the
app" step that passes on their machine. The owner's own install "boots up, but you can't really
get a project into a workable state": that is the test the round must pass. The owner will use
an API key first (the priority) and a Claude subscription too; Docker Desktop runs on their PC,
so full-review tasks will run in the Docker sandbox there.

**Quality rules (the evidence of this round; do not trade them for usage):** a failing test
first, never a weakened test; the full suite at every stage (fixer, reviewer, merge: the fixers'
full runs surfaced 53 existing tests changed by the design, the merges 5 bugs that exist only
when two areas meet); an independent reviewer who walks the app on the bench before anything
merges (every area came back with blocking findings that all tests passed); one merge at a time,
then the full suite and a bench walk; CI on Windows and Linux (it caught 3 timing failures the
local suite missed); the real model for anything that depends on how it behaves; helpers always
on the current code; one agent per journey for walks (27 of the 67 problems were found by a
single walk, including the owner's complaints 1 and 2).

- **A. Running:** wave 3 (progress and navigation: one-sentence status, Stop all only while
  something runs, the project switcher, the 30 s queued start; system text and wording); the live
  fixes (plan rejected for a long reason or a fenced doc, right-sized plans for short briefs,
  true failure words, chat told about planning, raw markdown, the bench on the real model); live
  walks on GitHub (`joelwellbournewood/forerunner-sandbox`) and on steering.
- **B. Merge and confirm:** wave 3, then the live fixes, one at a time with full validation; a
  real-model walk brief → plan → approve → session → result; exit when plans pass first time and
  are the right size.
- **C. Wrong or stuck work:** answers to a person task reach the next task's brief (the coder
  asked the same 7 questions again: `task-context.ts` uses the dependency's planned outcome);
  nothing is Done without a check (the planner chose tier 0 with no checks, and the specialist is
  told "the critic checks each"); plans only contain work this install can run (on an API key the
  researcher and science-evaluator get no web tools and have no stand-in, so their tasks go to the
  person; Docker-only tasks say so on the plan card); the result is visible (the project folder
  with Open folder, the last task's work committed); what the GitHub walk finds; re-check the
  findings of the walk that ran on pre-wave-2 code.
- **D. Live coverage (helpers, about USD 5):** one small real project per specialist not yet run
  live (researcher, writer-marketing, designer, data-analyst, migration-specialist,
  science-evaluator, reviewer; ops-deploy up to its Docker wait); real API errors (overloaded,
  rate limit, no credit, no network) through the bench's failure injection. Findings go to E.
- **E. Leftovers sweep:** about 35 collected items, real problems first (what misleads, blocks or
  contradicts), polish batched into one agent; same pipeline.
- **F. Independent final check:** fresh agents, one per journey (Tasks tab; a chain with a
  failure and a restart; chat steering; Inbox; wording and navigation; start / stop / settings;
  a real-model end-to-end walk that also covers the first project; a larger real-model project of
  about 10 tasks with dependencies, a planted failure and a daemon restart, about USD 3-5, since
  the live walks so far had 3 to 5 tasks); at most two fix rounds; then full validation and CI.
- **F2. The real desktop window, on Windows CI:** every walk drives the UI in Chromium, but the
  desktop shell opens links, files and windows its own way (the owner's complaint 1 was such a
  bug). `scripts/installed-check.ps1` already installs the MSI and checks the service starts; add a
  job that starts the installed app with WebView2 remote debugging and drives the core journey
  through it with the stand-in model (brief, plan, a session, a card answered, PR and file links,
  notifications if reachable). On a Linux runner (Docker with Linux containers), run a task that
  needs a full review in the real Docker sandbox end to end with the stand-in model: nobody has
  run that path hands-on, and it is the one the owner's PC will use
  (`packages/runtime/test/sandbox.integration.test.ts` covers only the adapter).
- **G. Hand-over:** UPDATE-LOG U-entries with commits, tests and "Check in the app"; CHANGELOG,
  requirements, gates evidence; what was and was not tested; remove the CLAUDE.md WIP paragraph;
  the Desktop app workflow installer; the owner's checklist: (1) remove the old install and its
  data, install fresh; (2) a first project from a brief; (3) answer a question and see work
  continue; (4) steer from chat, open the result and its PR in forerunner-sandbox; (5) with
  Docker Desktop, a task that needs a full review; (6, optional) switch Settings to the Claude
  subscription and run one task (the subscription path last ran live on 2026-10-20, through a
  test harness).
- **G2. Fix what the owner's checklist finds,** with the same pipeline, until the checklist passes
  on the owner's PC.
- **H. The phone, last (after every desktop phase above, G2 included):** first map, screen by
  screen, what carries over from the
  desktop (the daemon's words and fields, ADR 0102, design §3 and §5); then the same rigour for
  `apps/ui/src/mobile` and `apps/mobile` (walks in phone emulation, fixes that show the daemon's
  words, the Android workflow's emulator scenarios, a check on the owner's phone). Known gaps: the
  phone Inbox shows the old options, count and reply box; Reviews "Approve" maps to Mark done
  anyway without the ADR 0102 confirmation; Reviews links use `target=_blank`.

Owner decisions of 2026-11-01, late evening:
- **Limits for the rest of the round:** up to 90% of the weekly Claude usage in total, and at most
  USD 40 of Anthropic API spend for live checks (about USD 1.40 spent by then). Near either
  limit, stop at a clean point and write where things stand here.
- **Verification of code tasks (to record as an ADR in phase C; the owner may still change it):**
  proportional, set by the planner and enforced by the runner. (1) The project's build, lint and
  tests always run for a code task and are never shown as a "level"; a task that adds behaviour to
  a project without tests adds them. (2) The critic always reviews code tasks, with read access to
  the project, not only the diff. (3) Work a person will use (a page, an app, a CLI, an API) is
  also tried: started in its own environment (the Docker sandbox on the owner's PC) and used as a
  person would, with screenshots and outputs as evidence the critic judges. (4) Deploys, data
  migrations, money and security keep the full review and the owner's sign-off. (5) The person
  sees "Done" only after the right check passed, with "Reviewed" or "Reviewed and tried" and the
  evidence one click away; no "checks only" or tier words. The owner's words: automated checks
  "should be absolutely mandatory and not even mentioned in the UI ... we will clearly need to
  boot things up in their own environment, and test them in an agentic way".
- **Research on an API key:** give the researcher and the science-evaluator web access on the
  API-key path through Forerunner's own fetch/search capability, within the network rules (phase C).
- **GitHub token:** the owner kept FORERUNNER_TEST_GITHUB_TOKEN as it is; the app reports it
  reaches 4 repositories with admin rights. Agents link and touch only forerunner-sandbox. A
  first commit (README.md, main at f6aa072) was pushed there so tasks can branch; the app's
  failure on an empty linked repository is a phase C blocker of its own (pr-executor.ts branches
  from `origin/<base>` without checking it exists; project docs are not scaffolded, silently).

Out of scope this round: voice, email, extensions, the GitHub Projects mirror (the cloud GitHub
proxy blocks GraphQL, so it cannot be tested from a cloud session), peers and teams, the cloud
runner. The owner's old Forerunner install is not kept: no upgrade check.

## What the owner says (verbatim, the target of this round)

1. Clicking PR on the task list tends to do nothing.
2. "I can't figure out what Needs me, Mark failed, Cancel, or Depends on is supposed to do."
3. It seems hard to have a dynamic interaction with the system.
4. A large number of features don't work as intended.
5. The workflows get easily stuck or blocked.
6. The "Not in this session" display has tons of text and is confusing (a 7-line chain of
   `"X" waits on "Y" (ready)`).
7. The summaries of the last session and the decisions are verbose, confusing, badly written,
   full of irrelevant information.
8. The chat never seems to know anything.

Then: "this app is busted as hell ... really test its functionality in an agentic way,
genuinely, trying to make it do small tasks ... It needs to be real ... bring this whole thing
together ... get it to not only work well, but be intuitive as well ... very thoroughly."

## Root causes already confirmed in the code (this branch)

- **PR link (1):** `apps/ui/src/pages/project/TasksTab.tsx:334` is a plain `<a target="_blank">`.
  The desktop window only opens a link in the browser when it navigates in place
  (`apps/desktop/src-tauri/src/windows.rs:102`, `on_navigation`); `target="_blank"` asks for a
  new window, which the shell ignores. `apps/ui/src/components/ExternalLink.tsx` does it right.
  Same bug: `SandboxSettingsCard.tsx:165`, `UpdatesPage.tsx:400`, `project/PeersSection.tsx:77`.
- **Task buttons (2):** `apps/ui/src/lib/task-transitions.ts` turns the raw state graph into
  buttons ("Needs me" = move to `needs_human`), with no explanation of what each does or what
  happens next.
- **Chat knows nothing (3, 8):** `packages/runtime/src/conversation/agent.ts:581` sends the model
  ONE user message (the volatile facts plus the current line): no earlier turns. `context()`
  (`:959`) gives project names with a 160-character goal and last-session text, counts of unread
  messages and running sessions, open requests, and keyword-matched doc chunks and lessons. No
  task list, no session results, no failures and their reasons. Fast model, thinking off at low
  effort (`:663`), at most 4 turns (`:665`). There are two chats (project Chat tab and the side
  panel). U-084 (Chat cannot see or change tasks) is open.
- **Stuck work (5):** a session plans once, at its start, from the tasks whose dependencies are
  already done (`packages/runtime/src/session/runner.ts:808`), then runs that fixed list
  (`:981`). Tasks unblocked during the session are not picked up, so a 7-step chain needs 7
  manual starts, and a failure stops everything behind it. To confirm on the bench (also: is a
  task "done" only after a PR merge?).
- **Walls of text (6, 7):** `summarize()` (`runner.ts:2397`) glues about 15 sentence templates,
  each added by a separate fix (U-009, U-039, U-040, U-045, U-072, ...); `summarizeWaiting`
  (`:2490`) and `StartSessionDialog.tsx:263` are the U-040 fix that produced the "Not in this
  session" block. Decisions are Inbox answers re-filed with the machine-written `request.why`
  as the question (`packages/runtime/src/wiring/state-ports.ts:268`).
- **Too broad (4):** 8 top-level screens, 8 project tabs, voice, phone, email, extensions, all
  built before the core loop worked (228 requirements in the spec).

## Why previous rounds failed (do not repeat)

- An audit became ~60 tickets fixed in isolation by parallel agents. Each fix was locally right
  and added a sentence, a button or a setting; nobody owned a screen, so screens got worse.
- "Done" meant tests green, and the browser tests run against a hand-written fake daemon
  (`apps/ui/playwright.config.ts`, `apps/ui/test/fake-daemon.ts`). Nobody drove the real UI on
  the real daemon through a whole journey and looked at it.
- No design target: reviewers checked against the 228-requirement spec, not against what a
  person needs on a screen.

## The plan (approved by the owner)

0. **Check the key, cheaply.** `test -n "$ANTHROPIC_API_KEY" && echo set`, then
   `curl -sS -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"`
   must print 200. If the variable is absent, the owner may have used a network secret: note
   that `api.anthropic.com` is in `NO_PROXY` here (direct, not through the proxy that adds
   secrets), so check whether a request without the header gets 200; if neither works, tell the
   owner plainly and carry on with the stand-in for mechanics. Do not fake live results.
1. **Bench (1 agent).** Real daemon + real UI in Chromium + a role-playing stand-in model with
   failure injection and a model-call log, plus a live mode on the real API with the same log.
   Committed under `testenv/src/bench/` and `scripts/bench/` so it stays useful.
2. **Walks (7 agents, hands-on through the UI, read-only on the code):** first project as a
   newcomer; every Tasks-tab control; a 7-task chain with a planted failure and a daemon restart;
   chat and steering (with what the model was given); everything that needs the person; every
   screen and every system-written text plus the information architecture; start / stop /
   restart / settings. Real model for model-dependent journeys, stand-in for planted failures.
3. **Synthesis (1 agent):** 5 to 7 fix areas with root causes; the design target in
   `docs/design/core-experience.md` (each screen's one job, plain action labels with one-line
   explanations, empty / running / failed / stuck states, writing rules with before/after
   examples, what is primary and what moves behind "More" (hide, never delete), how a session
   should behave). Give the owner a short summary; do not wait long for approval: the owner
   asked for action.
4. **Fix by area, one owner each, in worktrees:** session engine (keep going while tasks
   unblock, stop clearly at a real blocker, recover after failure and restart); Tasks screen
   (links, plain actions, dependencies by name, Reopen U-080); chat (one chat, conversation
   history, the project's tasks, results and failures in context, commands to change tasks and
   dependencies, U-084); the needs-me loop (one place, each card says what and why in one
   sentence, answering resumes work); everything the system writes (one voice, length limits:
   summary, waiting list, decisions, notifications, intake and decision-doc prompts; U-086,
   U-087); navigation (primary screens vs "More"). Each owner reproduces first (failing test at
   the boundary the person uses, `docs/maintainers/validation.md`), re-walks their journeys on
   the bench and attaches before/after screenshots.
5. **Independent check:** fresh agents who wrote none of the fixes walk every journey on the
   merged result (real model where it matters), try to break it, and send failures back (at most
   two rounds). Then the full validation the repo requires: `pnpm check`,
   `pnpm test:integration`, `pnpm test:e2e`, the UI suite (`cd apps/ui && pnpm vitest run --config vitest.config.ts`)
   and Playwright, and for desktop changes `cargo fmt --check`, `cargo clippy`, `cargo test`.
6. **Owner tries it:** push, run the Desktop app workflow for an installer, and give the owner a
   five-step checklist (the core journeys), not a list of tickets. Log each problem found as a
   U-entry with a "Check in the app" line.

The workflow script for steps 1 to 3 is `docs/status/handoff/real-walkthrough.workflow.txt`
(a Workflow tool script, saved as .txt because it is not plain JavaScript and the linter would reject it: pass its text as `script`, or copy it to a .js file outside the repo and pass `scriptPath`). It was written for this environment; check the
ports and the journey list before running it.

## Environment facts (learned the hard way)

- 4 CPUs, 15 GB RAM: at most two workflow agents run at once; one bench per agent at a time.
- `pnpm install --frozen-lockfile` works (about 20 s).
- Start the real daemon: `FORERUNNER_HOME=/tmp/frbench/<name>/home npx tsx packages/runtime/src/cli/main.ts daemon --provider fake --port <p>`.
  `pnpm fr -- daemon ...` fails with "too many arguments". The token is in
  `<home>/runtime/daemon.json`.
- Start the UI against it: `cd apps/ui && VITE_DAEMON_URL=http://127.0.0.1:<p> VITE_DAEMON_TOKEN=<token> npx vite --port <u> --strictPort --host 127.0.0.1`.
  The setup assistant opens first; "Set up later" skips it.
- Never `pkill -f` a pattern that appears in your own command line: it kills your own shell.
  Stop processes by their PIDs.
- No Docker here: tasks at risk tier 2 and above wait for a Docker sandbox (U-079). The owner's
  Windows machine may not have Docker either; check what a person sees.
- GitHub: the cloud GitHub proxy serves only repositories attached to the session (attach
  `joelwellbournewood/forerunner-sandbox` with the add_repo tool for live GitHub checks) and
  rejects GraphQL whatever the token. The owner put a fine-grained token for forerunner-sandbox
  only in the environment as `FORERUNNER_TEST_GITHUB_TOKEN` (7-day expiry from 2026-11-01): enter
  it in the app's UI from the environment, never print it. Otherwise test projects without a
  repository (they work in their folder, U-037) and the pull-request flow with the fake GitHub in
  `testenv/src/githost`.
- The Anthropic key: `ANTHROPIC_API_KEY` set in the environment never reaches a session (the name
  is held back), so the owner stored it as `FORERUNNER_ANTHROPIC_API_KEY`. Pass it to the app as
  a prefix on the bench start only:
  `ANTHROPIC_API_KEY="$FORERUNNER_ANTHROPIC_API_KEY" node scripts/bench/start.mjs ... --provider bench-live`.
  A session reads environment variables when it is created: a running session does not see a
  change; start a new one. Network secrets are never attached to `api.anthropic.com`.
- Auto-mode refuses scanning environment values or the proxy status for credentials; do not work
  around it. Check a named variable with `test -n "$NAME"` only.
