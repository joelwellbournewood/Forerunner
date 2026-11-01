# Next session: make Forerunner work for a person, and be intuitive

Handoff written 2026-11-01 at the end of session `claude/dreamy-johnson-2zfr0m`. Read this first,
then `AGENTS.md` and `docs/maintainers/validation.md`. Do not re-plan from scratch: the owner
has approved this plan and asked for it to be done thoroughly, hands-on, for real.

## Where things stand

- Branch `claude/dreamy-johnson-2zfr0m` = `claude/adoring-meitner-ebkoom` (012c9009, U-018 to
  U-088 fixes, the newest work) plus this handoff. Work on this branch.
- Nothing has been changed in the product yet in this round. The test run below was started and
  stopped before it wrote anything.
- The owner is adding an Anthropic API key to the cloud environment as the environment variable
  `ANTHROPIC_API_KEY` (preferred), or as a network secret for `api.anthropic.com` with the
  header `x-api-key` and no prefix. **Step 0 below checks which one works.** Never print, log or
  commit the key; never ask the owner to paste it into chat.

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
- GitHub: only `joelwellbournewood/Forerunner` is reachable from this environment. Test projects
  without a repository (they work in their folder, U-037) and the pull-request flow with the
  fake GitHub in `testenv/src/githost`.
