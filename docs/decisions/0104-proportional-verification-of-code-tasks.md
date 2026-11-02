# 0104 — Proportional verification: the critic reviews every task, the project's checks always run for code, a page is tried, and the person sees "Reviewed" or "Reviewed and tried"

Date: 2026-11-02
Status: accepted (the owner may still change it)

## Context

The first runs on the real Claude API (2026-11-01, `docs/status/handoff/round-2026-11-01/
live-reports/`) showed work marked Done that was not done or not checked:

- The planner put every coding task at tier 0 ("Checks only"). Tier 0 never called the critic;
  with no test command nothing ran, so "Build the three pages" became Done on a report that said
  "nothing here has been tested", and the specialist's brief still said "Acceptance criteria (the
  critic checks each)".
- "Members chart": the data file was missing; the specialist rightly made no chart and ended its
  report with "Questions for the person: Please add data/members.csv". The critic accepted (82),
  marking "every bar uses the exact number" met because there were no bars; the task was Done and
  the Inbox said "Nothing needs you".
- In most reviews the critic said it could not check a claim because the file was not in the
  request: it had the diff only, never the project's other files, and never a command's output.
- A deploy task edited down to a light review was accepted with a criterion "not verified".

The owner decided on 2026-11-01 (`docs/status/handoff/NEXT-SESSION.md`, "Owner decisions"):
verification of code tasks is proportional, set by the planner and enforced by the runner:
(1) the project's build, lint and tests always run for a code task and are never shown as a
level, and a task that adds behaviour adds tests; (2) the critic always reviews code tasks, with
read access to the project, not only the diff; (3) work a person will use is also tried, started
in its own environment and used as a person would, with screenshots and outputs as evidence the
critic judges; (4) deploys, data migrations, money and security keep the full review and the
owner's sign-off; (5) the person sees "Done" only after the right check passed, with "Reviewed"
or "Reviewed and tried" and the evidence one click away, and no "checks only" or tier words. In
the owner's words, automated checks "should be absolutely mandatory and not even mentioned in the
UI ... we will clearly need to boot things up in their own environment, and test them in an
agentic way".

## Decision

1. **The critic reviews every task an agent finished** (`SessionRunner`, `CriticLoop`). A task's
   review level is its risk tier, never below the light review (tier 1) and never below its
   specialist's `risk_tier_floor` from the registry; a task by `ops-deploy` or
   `migration-specialist` is reviewed at tier 3, which ends with the person's sign-off
   (`loop/verification.ts`: `reviewTierOf`, `reviewFloorOf`). The mechanical tier-0 close
   ("automated checks only") remains only for a runner composed without a critic (engine test
   worlds); the daemon always composes one.

2. **The project's own checks run for every code task, at every level, in the task's sandbox.**
   A change that touches anything but documentation and notes is code (`isCodeChange`). Its
   checks are the project's `settings.checks` plus the `build`, `lint`, `typecheck` and `test`
   scripts of the `package.json` at the root of the task's folder (`npm run --silent <name>`;
   npm's "no test specified" placeholder and empty scripts are not checks), run before the
   critic reads, in a lease of the task's sandbox (the container for a full review, the process
   sandbox below that), never on the host when a sandbox is wired. When they cannot run (no npm
   where they run, dependencies not installed, the sandbox refused) they are not run and the
   review says why (`ReviewEvidence.notChecked`); nothing fails for it. A failed required check
   blocks an accept at every level. Before, tier 1 only listed the commands as "not run".

3. **The critic reads the project.** For a task, the critic's token allows `read_file` and
   `list_dir` on the task's folder only (its `allowedPaths`, enforced by the hooks like every
   path), and the request lists the folder's files (up to 200). A review that may read gets up
   to 12 model calls and up to 180 s (the 30 s light-review target stays the target and is
   reported when missed).

4. **A page is tried as a person would use it** (`loop/try-it.ts`, `@forerunner/capabilities`
   `browser/try-page.ts`). When a change made or changed an HTML page (or a stylesheet or script
   of a folder with an `index.html`), at most three pages are opened in a fresh headless
   Chromium (never an agent's profile) from a loopback server that serves the task's folder and
   nothing else; every other request is blocked (the network is off). At 1280 and 390 pixels wide
   it records whether the page opened, its title, the text on it, linked files that did not
   load, errors on the page and a screenshot, stored under `<data>/evidence/<task>/<review>/`.
   The critic gets it as verified evidence. A page that did not open or threw an error (not
   explained by a blocked request) is a high finding: no accept. A smaller problem (a linked file
   that did not load, a console error) is a low finding the critic weighs against the brief (a
   stylesheet a later task writes is not this task's fault). No Chromium: the review says the page
   was not tried, and the person sees "Reviewed", not "Reviewed and tried". The try runs on the
   host for every level in this version, with the network off; trying inside the Docker sandbox
   and trying a CLI or an API are later work.

5. **Work that waits for the person is never Done.** A report that ends with "Questions for the
   person:" is shown to the critic as such, and the code turns an accept into a `human` verdict
   (`ASKS_PERSON_RULE`); the loop then files the report's questions as one Inbox card and the task
   waits in `needs_human`, as a report that needs the person's answers already did after a revise
   (U-022). The critic's prompt (critic 1.2.0) says a deliverable that is not there is never met
   whatever the reason, a part of the task left undone is a major finding, a criterion the worker
   could not verify and nothing verifies is not met, new behaviour in code comes with a test, and
   numbers are counted from the evidence.

6. **The specialist is told the truth.** Every brief says how the work is checked (the project's
   build, lint and tests, a page opened in a browser, the critic reading the work and the
   project's files against each criterion) and asks for a test with new behaviour. A task with no
   criteria is held to its outcome ("The work itself shows this outcome …"), in the brief and in
   the review, instead of "The outcome described in the goal is achieved and verified."

7. **What the person sees.** A done task the critic reviewed shows "Reviewed and tried" (a page
   was tried) or "Reviewed" in the Tasks tab, and the task drawer opens the evidence: the checks
   with their output, what was tried with its screenshots, and what could not be run and why. The
   review level is chosen as "Light review" or "Full review" (with the person's sign-off as the
   third choice); "Checks only" is no longer offered or shown, and a stored tier 0 reads as a
   light review. Each review keeps a `verification` record (checks, tries, what was not checked)
   in its evidence; `GET /tasks/:id/evidence?file=` returns a screenshot of the task's own
   evidence folder and nothing else.

8. **Small fixes found on the way.** A `doc_drift` that starts with "none" ("none (docs/testing.md
   still says …)") is no drift (it had turned an accept into a revise). A finding the model gave no
   action for asks to "Resolve it and show the evidence" instead of repeating itself ("X -> Fix:
   X"). A session whose planned tasks all wait for the person is not graded 100.

## Consequences

- Every finished task costs one critic call more than a tier-0 task did; the light review stays
  on the critic's tier-1 model.
- A project whose `package.json` has scripts but no installed dependencies gets no automatic
  checks until they are installed in the task's folder; the review says so.
- A page task needs a Chromium to be "Reviewed and tried"; the desktop install finds Playwright's,
  Edge or Chrome as the agent browser does (`resolveChromiumExecutable`).
- The deploy and migration floor applies to the review; the run itself follows the stored tier,
  so a deploy task a person lowered to a light review runs in the process sandbox and then waits
  for the person's sign-off. Raising the stored tier at creation is left to the planner and the
  New task dialog.

## Alternatives considered

- **Run the acceptance criteria as checks at tier 0:** criteria are prose; a model would have to
  turn them into commands, which is the critic's job anyway.
- **Keep tier 0 and only fix the planner's choice:** the planner can still choose it, and the owner
  asked for the check to be enforced by the runner, not left to a prompt.
- **Try pages from `file://`:** module scripts fail there for reasons a person serving the folder
  would not meet, and file requests cannot be confined as simply as a loopback server's.
- **Let the try reach the network:** a person's browser would, but the review's token allows no
  domain; requests to other sites are reported as blocked and the critic is told so.
