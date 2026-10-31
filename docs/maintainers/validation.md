# Validation: how a change is proven before it reaches a person

Every change follows this file, whoever writes it (a person, an agent, a specialist) and whoever
reviews it (a person, a critic, a reviewer agent). `AGENTS.md` makes it binding. It exists
because 1.0.0 to 1.0.4 shipped bugs that every check passed and the first person to use the app
found within minutes.

## Why the checks passed and the app failed

Those releases had a long spec, thousands of unit tests, CI on Windows and Linux, critics and
reviews. They still shipped an app that did not start (U-001, U-002), buttons that did the
opposite of their label (U-021), a kill switch that came back on every start (U-019), and
background processes that blocked updates (U-018). The checks were not missing. They were
pointed at the wrong thing:

- **Tests proved the code agreed with itself, not with the person.** The extension approval test
  asserted the internal shape of the options (the shape that was the bug) and answered with
  "yes", never with what a click sends (U-021).
- **Stand-ins drifted from the real thing.** The UI's tests ran against a fake daemon that served
  routes and shapes the real daemon did not (U-003 to U-008).
- **Nothing crossed a restart, a quit or an install.** Resume was tested inside one process; the
  file that re-applied the kill on the next start was never looked at (U-019). Nothing checked
  what is still running after Quit (U-018).
- **CI ran where people do not.** The Windows job ran as administrator, so read-only install
  folders were never read-only (U-012). The installed app was first started on Windows in CI in
  1.0.2.
- **Reviews read diffs.** Critics and reviewers compared code to the spec and saw tests pass.
  Nobody installed the build and used it.
- **Breadth before the core path.** Voice, email, phone, cloud runner and desktop control were
  built before one person could install, set up, run a session, answer the Inbox and quit
  without help. U-022 (questions for the person sent to a specialist that cannot ask) is a
  journey nobody walked.

## The rules

These are rules, not advice. A change that breaks one is not done, whatever else is green.

1. **Test what the person sees and sends, at the boundary they use.** A UI test clicks the
   control and asserts what appears and what goes over the wire. A route test sends the exact
   body the UI sends. Answers to Inbox requests are tested with the option strings the Inbox
   shows (`requestView(row).options`), never with "yes"/"no" typed by the test.
2. **Never assert an internal shape the person never sees** (the stored form of options, a
   private field) unless a second assertion checks the visible result. Asserting the shape
   locks the bug in.
3. **The real daemon, not only the stand-in.** A new or changed daemon route gets a case in
   `apps/ui/test/real-daemon.test.ts`, which runs the UI's client against the real daemon. The
   fake (`apps/ui/test/fake-daemon.ts`) is updated in the same commit. A route only in the
   fake is a bug.
4. **Cross the lifecycle.** Anything persisted (a file in the runtime or data dir, a row, a
   setting, a marker) is tested across a restart: compose the runtime twice on the same home,
   or start the daemon twice. Anything that starts a process or a timer is tested for what is
   left after stop, Quit, uninstall and upgrade. An undo or a Resume is tested after a restart.
5. **Windows is the main platform.** Paths with spaces, non-ASCII letters, another drive and a
   long path. A non-administrator user. Files a running process keeps open. Links in caches
   (Hugging Face, npm) that may be copies or links. A behaviour that differs by OS is tested
   on both, or the PR says why it cannot be, and the release checklist asks the owner to try
   it.
6. **Every person-facing step can be done by the person, and every agent step by an agent.**
   A task that needs the person's answer becomes a question in the Inbox with the questions in
   it, not work for a specialist. A specialist is only given work its tools and paths allow. A
   request the person must answer says what to do in plain words.
7. **A UI action leads somewhere.** A button that moves data into a state must lead to a state
   something processes (U-013). A toggle that switches nothing is removed or labelled as
   information (U-023).
8. **A fix starts with a failing test, then the siblings.** Reproduce the person's report as a
   failing test, fix it, keep the test. Then search for the same class elsewhere (the bug
   classes below) and fix those too or log them as new U-entries. Name the root cause, not
   only the symptom.
9. **Errors and refusals are tested as the person meets them.** The text a person reads (a
   dialog, a toast, an Inbox card, a session log line) is asserted, and it says what happened
   and what to do next.
10. **No release without the owner trying the build.** CI proves the installers start. Only a
    person proves the fixes work. See "Release" below.

## Bug classes that reached people, and the check that catches each

| Class | Released as | Check |
| --- | --- | --- |
| What the person clicks is not what the code parses | U-021 | Rule 1: answer with `requestView(row).options[i]`, assert the outcome for every option |
| UI and real daemon disagree on a route or a shape | U-001, U-003 to U-008 | Rule 3: `real-daemon.test.ts`; contract schemas parse the real answer |
| Persisted state re-applied on the next start | U-019 | Rule 4: compose twice on one home; assert after the restart |
| Processes or files left behind after Quit, uninstall or upgrade | U-018 | Rule 4: assert nothing runs after `POST /shutdown`; the MSI step test; owner checks Task Manager |
| A UI action moves data into a state nothing processes | U-013, U-016 | Rule 7: after the action, run the consumer (a session) and assert it picks the item up |
| Work routed to an actor that cannot do it | U-014, U-017, U-022 | Rule 6: the planner's output is checked against the registry and the specialists' tools |
| A switch that does nothing, or two screens for one thing | U-023, U-026 | Rule 7: each control has a test of its effect; the user guide names the one place |
| Windows-only behaviour never run on Windows as a person | U-002, U-011, U-012, U-024 | Rule 5: CI as a standard user; paths and links tested; owner checklist |
| An error that hides its cause or the next step | U-007, U-009, U-017 | Rule 9: assert the text and the next step |

Add a row when a new class reaches a release.

## Checklists

### The author, before asking for review

- [ ] The person's report (or the requirement) is a test that failed before the change.
- [ ] Rules 1 to 9: each one that applies is covered, or the PR says why not.
- [ ] Siblings searched (rule 8), with the search named in the PR.
- [ ] `pnpm check` is green locally. For desktop changes, also `cargo fmt --check`,
      `cargo clippy --all-targets -- -D warnings` and `cargo test` in `apps/desktop/src-tauri`.
- [ ] The U-entry has a **Check in the app** line: the steps a person takes to see the fix
      (see `docs/status/UPDATE-LOG.md`).
- [ ] Maintainer docs, the user guide (if a person sees the change), `CHANGELOG.md`
      `[Unreleased]` and `docs/requirements.md` updated.

### The reviewer or critic

A review that only reads the diff is not a review of a person-facing change. The reviewer:

- [ ] Reads the U-entry's "Check in the app" steps and asks whether a test does those steps.
- [ ] Checks every new Inbox request: its options are plain strings, and each option's click
      leads to the outcome its label says.
- [ ] Checks every new route against `real-daemon.test.ts` and the fake.
- [ ] Asks what happens after a restart, after Quit, on Windows, and as a non-administrator.
- [ ] Asks whether a person can do every step the change expects of them, and whether a
      specialist can do every step given to it.
- [ ] Rejects tests that assert internal shapes only, answer with words the UI never sends,
      or were weakened to pass.

### Release

A release is cut only when all of these hold, with evidence in `docs/status/gates.md`:

- [ ] CI green on Windows and Linux for the release commit (run IDs).
- [ ] The Desktop app workflow green for that commit: installers built, installed and started
      (run ID).
- [ ] The owner installed that run's MSI over the current release ("Trying a build before it
      is released" in `docs/setup-guide.md`) and went through each U-entry's "Check in the
      app" steps, plus the core path: open the app, start a session on a project, answer an
      Inbox card, close the window, Quit from the tray, and see nothing of Forerunner left in
      Task Manager.
- [ ] Each U-entry in the batch is `fixed` with commits, the failing-then-passing test, the CI
      runs and the owner's confirmation.

## Gaps today

Closed on 2026-10-31: the Desktop app workflow (Playwright UI tests, the Rust shell's checks,
the installers and the installed-app check) ran only for pull requests and `main`, so 1.0.4 was
released with a Playwright test that still expected U-016's old behaviour. It now runs on every
push to a development branch.

These checks do not exist yet. Until they do, the owner's run-through covers them, and each
is a candidate for the next work:

- No automated journey on the **installed** app: install the MSI as a standard user, finish
  setup with the fake provider, create a project, run a session, answer the Inbox, Quit,
  check that no process is left, upgrade, uninstall. CI only runs `--self-test`.
- The Windows installed-app check still runs as administrator (U-012).
- No check that the planner only plans work the assigned specialist can do (U-022).
