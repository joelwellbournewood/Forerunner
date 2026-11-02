# 0110 — Work is tried in its own environment: a command line tool is run, an API is called, a page is opened; the project's tests run whatever the language; the scripts that judge the work are the ones from before the task

Date: 2026-11-02
Status: accepted (amends ADR 0104 point 4 and its "later work"; the owner may still change it)

## Context

ADR 0104 point 4 tried only pages, in a headless Chromium on the host, and said: "trying inside
the Docker sandbox and trying a CLI or an API are later work". The owner's decision (3) of
2026-11-01 (`docs/status/handoff/NEXT-SESSION.md`) asks more: work a person will use (a page, an
app, a CLI, an API) is started in its own environment (the Docker sandbox on the owner's PC) and
used as a person would, with screenshots and outputs as evidence the critic judges. Decision (1)
says the project's build, lint and tests always run for a code task. Phase E found (C-1, C-3,
C-17, L-4, L-5, R-1; `/tmp/frbench/handoffs.json` "verification"):

- a CLI or an API a task built was never tried: "Write wc.js" with the criterion "`node wc.js
  <file>` prints the number of words" became "Done · Reviewed" with nothing run (bench
  fix-verification, 2026-11-02, `steps-before/02-before-cli-drawer.png`);
- only `package.json` scripts ran: a Python project with `tests/test_calc.py` got no test run
  and "See what was checked" said nothing (`06-before-python-drawer.png`);
- Chromium started with Playwright's default `--no-sandbox` on every page, a full review's too,
  and a throw from the loopback server or the screenshot folder left the browser running;
- a retry brief turned the critic's notes ("[info] … unrelated to this change") into orders, and
  a coder that narrowed the person's `test` script to its own file got "test: passed" (live,
  2026-11-02).

## Decision

1. **What to try is decided by what the task made** (`packages/runtime/src/loop/try-plan.ts`,
   `planTries`), from the brief, the acceptance criteria, the README the task wrote and the files:
   - a **command line tool**: a command written exactly (in backticks, in a README's code block,
     or in a sentence whose next word goes on the sentence: "node wc.js <file> prints …") whose
     program is `node`, `python3` or `python` and whose script is in the task's folder. Its
     placeholders become sample input written for the try under `.forerunner-try/` (`<file>` a
     small text file, `<name>` "Ada", `<number>` 3, a file the folder does not have a sample of
     that name; `echo "x" |` and `< file` become standard input). A command whose words end in a
     guess ("node greet.js Ada prints …") is not run; a tool that reads its command line but whose
     usage nobody wrote down is not guessed at: the review says it was not tried and why. A text
     around the command that expects an error ("exits with code 1") makes a failing exit no
     problem, and one that says it keeps running ("watches the folder", "until you stop it")
     makes a tool still running after 5 s no problem. A full stop or comma after a placeholder is
     the sentence's ("Usage: node wc.js <file>." runs `node wc.js <sample>`, never a redirect
     from a file named "file>."), and `./wc.js` is `wc.js`;
   - an **API or a server**: a file the task wrote that listens (`.listen(`, `serve_forever`,
     `app.run(`, …) is started (the command the brief names, else `node <file>` / `python3
     <file>`), with `PORT` set to a free port; the ports its code or the brief names are watched
     too. Its GET routes are called: the ones the brief, a criterion or the README names first
     (`GET /health`, `` `/items` ``), then the ones its code handles, else `/`; routes with
     parameters and other methods are listed as not called. A named route carries what its
     sentence says it answers: a status ("GET /admin answers 401 without a token"), an error
     ("refuses", "not found"), or a call with a token or a login the try's plain GET does not
     make;
   - a **page**: as ADR 0104 (`pagesToTry`);
   - a **library**: nothing is started; its tests check it.
2. **Commands and servers run in the task's sandbox lease** (`try-run.ts`, `runTries`): the same
   lease the project's checks use, the container when Docker is ready (always for a full review,
   ADR 0101), with the network off (`--network none`); the process sandbox otherwise, which only
   points the proxy settings at a proxy that refuses every connection (ADR 0007), so its evidence
   says "on this computer, not in a container (a program that ignores proxy settings can still
   reach the network)" and never "the network off"; 30 s per command, 15 s for a server to listen
   and 5 s per call. A server is driven by a small Node script written into the
   folder's `.forerunner-try/` and run inside the same sandbox (`SERVER_DRIVER`): it starts the
   server, waits until it accepts a connection (ports in use before it started do not count),
   calls each route over the sandbox's own loopback, stops the server and its children, and
   prints the result. The server never outlives the driver: a guard (the same script) starts
   it in a process group of its own and kills that group when the driver's pipe to it closes,
   however the driver ended (Stop, a session's end, Quit, the lease's time limit, all of which
   kill only the driver in the process sandbox). A stopped review stops its try; the stop is
   not reported as a problem of the work. `node` is the runner image's in the container and the daemon's own Node in
   the process sandbox. Without a sandbox (a test world) nothing the work made is started on the
   host. Afterwards `.forerunner-try/` is removed, and so are files the tried work wrote; a file
   it changed is named in the try's output.
3. **What a try finds.** A command that exits with an error (unless expected) or does not finish
   (unless it keeps running by design), a server that stops before it listens, a named route
   whose answer is not the status or error its sentence names ("answered 200, and the brief says
   it answers 401"), any route that answers 5xx or does not answer, and a server that stops while
   it is called are problems: `blocking`, so a high finding "Tried <target>: <problem>" that only
   a new try without it resolves (ADR 0104 point 9). A named route that answers 4xx where nothing
   says what it answers is a problem that does not block, a low finding the critic weighs (the
   route may be a later task's); a 401 or 403 on a route the brief calls with a token is no
   problem. A server the brief neither says how to start nor names a route
   of (the task only edited a big app's server file, which needs its database or a key) is still
   tried, but what goes wrong is a line "… was started, but …; the brief says nothing about
   running it, so this is not held against the task", never a finding. A program that is not
   installed where the work is tried, a
   package the work imports that is not installed, a server that never listens and a web address
   it would need are "not tried, because …" lines, never failures. The output (the command, its
   sample input, the exit, the output; the calls and their replies) is the critic's verified
   evidence (`TriedEvidence.kind` "command" or "server") and the person's under **See what was
   checked**; "Reviewed and tried" means something was tried.
4. **A page is opened by a browser, not in the container.** A page's own environment is a
   browser; its files are the task's folder, bind-mounted into the container and on the host
   alike, and a static page runs only in the browser's renderer. The runner image has no browser
   (Playwright's Chromium and its system libraries would add some 500 MB to every person's
   download), and a container with the network off publishes no port a host browser could open.
   So the page is opened on the host as before, network off, from a loopback server of the folder
   alone, now with **Chromium's own sandbox on** (`chromiumSandbox: true`). Where it cannot start
   with it (Linux as root, a kernel without user namespaces), a light review's page is opened
   without it and its try says "the browser ran without its own sandbox: it could not start with
   it on this computer (…)"; a **full review's page is not opened without it** (ADR 0101): "not
   tried: the browser could not start with its own sandbox on this computer (…), and a page of a
   full-review task is only opened with it". The browser is started inside the try whose
   `finally` closes it (R-1).
5. **The project's tests whatever the language** (`project-checks.ts`, `markerChecks`): Python
   (test files `test_*.py` / `*_test.py`): `python3 -m pytest -q -p no:cacheprovider`, else, when
   pytest is not installed and the tests are `unittest` tests, `python3 -m unittest discover`;
   Rust (`Cargo.toml`): `cargo test --offline` (its build under `.forerunner-try/`); Go
   (`go.mod`): `go test ./...` with `GOPROXY=off`. They run in the same lease, at every review
   level, as required checks. A tool missing where the checks run, dependencies that are not on
   the computer (the network is off), or a runner that found no tests is "the project's <language>
   tests were not run: …", never a failure. JavaScript test files that no script runs are told
   ("the project has test files (…) that no check ran: its package.json names no test script").
6. **The scripts that judge the work are the ones from before the task** (L-5,
   `scriptsBefore`): when a task changed `package.json`, its `build`, `lint`, `typecheck` and
   `test` scripts are read from the folder's commit before the task's first run (`Workspace
   before … (task <id>)`) or the merge base with the default branch. A script the task changed or
   removed runs as it was (`npm exec -c "<script>"`) under its own name, the changed one runs
   beside it as "<name> (as this task changed it)" (not required), and the critic is told
   ("this task changed the project's test script from `…` to `…`").
7. **Notes are not orders** (L-4, `retryConstraints`): an `info` finding and a measured problem
   "(not caused by this task)" go into a retry brief under "Notes from the review, for your
   information only: they are not part of this task. Do not change code for them; if one stops
   your task, say so under 'Questions for the person:'.", without their required action. A failed
   check stays an order, with its way out ("if it failed before this task, say so … under
   'Questions for the person:'"), which goes to the person as one question card (U-022).
8. **The brief says it** (`HOW_WORK_IS_CHECKED`): the scripts as they were before the task, the
   other languages' tests, a tool run with the sample input its brief or README names, a server
   started and called, a page opened; and "Write the exact command a person runs in backticks in
   the README, so it can be tried."

## Consequences

- A review of a CLI or an API task costs a few seconds more (one command, or a server start and a
  few calls); nothing runs for a library or a document.
- In the container a review lease is `--network none`: a server is called over the container's
  own loopback; a tool that needs the network is reported as failing or not tried.
- A tool whose usage is not written down is "Reviewed", not "Reviewed and tried", and says why;
  the brief asks for the command in the README so that it can be tried.
- On Linux as root (CI, this bench) Chromium's sandbox cannot start: light-review pages are
  tried without it and say so; full-review pages are not tried there. On Windows (the owner's
  PC) the sandbox starts.
- A Rust project's review builds into `.forerunner-try/cargo-target`, removed afterwards: a cold
  build every review, never a `target/` the next commit could pick up.
- `scripts/sandbox-full-review.mjs` (CI's `sandbox-full-review` job) now proves a CLI try inside
  the container: the full-review task names `` `node src/greet.js Ada` ``, and the check asserts
  the try ran in the container (`exec_start`), exited 0 and printed the greeting, as the drawer
  shows it.

## Alternatives considered

- **A browser in the runner image** (Playwright's Chromium in `services/cloud-runner/Dockerfile`,
  the page served and opened inside the container): the honest "inside the container" for a page,
  but a much larger image for every person and a browser that runs as the container's user with
  `--no-sandbox` (no user namespaces inside the container): weaker than the host browser with its
  own sandbox, for static files that run only in a renderer. Kept for when a page needs a server
  of the task (an app with a backend), which is the API case today.
- **Publishing a port of the review container** for the host browser: needs a network on the
  container (it has none), so the work under review could reach out.
- **Guessing a tool's usage** (`--help`, no arguments): a usage message with a non-zero exit would
  be a finding the task cannot remove; told instead.
- **Running the task's changed scripts only, and flagging the change**: "test: passed" would still
  mean the task's own file passed; the script as it was is what the person's project calls "test".
