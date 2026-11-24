# 0109 — A reviewer's findings are its report: it writes no file, the planner asks for none, and its command tool is not read-only

Date: 2026-11-02
Status: accepted

## Context

The registry's reviewer reads a change and returns findings "without editing code"
(`evals/registry/specialists/reviewer/specialist.md`). Its tools are `cc:Read`, `cc:Bash`,
`cc:Grep` and `cc:Glob`: no `cc:Write` or `cc:Edit`, so on the loop driver it gets `read_file`,
`list_dir`, `grep`, `glob` and `run_command`, and no `write_file` (ADR 0043).

Live walk 4 (real model, 2026-11-02, phase E #96): a reviewer task whose outcome named a review
file wrote `review.md` with `node -e` through `run_command`. The findings were right; the tool
limit meant nothing. `run_command` runs any command the sandbox allows in the task's folder (the
process stand-in on a light review, the Docker sandbox on a full one), and a command can write a
file: leaving out `write_file` is not a write limit for a specialist that runs commands. The
planner had given a specialist without a write tool a "write a file" outcome, which validation
rule 6 forbids ("a specialist is only given work its tools allow").

Forerunner already keeps every run's final report with the task (the task drawer shows it, the
critic reviews it), so a reviewer's findings reach the person without a file.

## Decision

1. **The reviewer's findings are its final report.** Forerunner keeps the report with the task's
   run, where the person (the task drawer) and the critic read it. The reviewer writes no file,
   not even a review file a brief names; it says so in its report instead. Its commands run the
   tests, linters and builds and never create or change a file. Its registry entry says each of
   these.
2. **The planner never asks a reviewer for a file.** The project manager's delegation rules
   (`evals/registry/principals/project-manager.md`, the role prompt the intake and the session
   planner both start with) say: a specialist only gets work its tools allow; a reviewer's
   findings are its report, so it gets no outcome or criterion that asks it to write a file.
3. **`run_command` is not read-only, and nothing says it is.** A specialist's tool list says what
   it is offered, not what its commands cannot do: the boundary for a specialist that runs
   commands is the task's folder and the sandbox (paths, network, the Docker sandbox for a full
   review), not the absence of `write_file`. What a run changed is recorded for every run, a
   reviewer's included, and the critic sees it with the work.

## Consequences

- A person who wants a review reads it in the task drawer (the report), not in a file in the
  folder; a plan that needs the review written down gives that step to a specialist with a write
  tool.
- The rule is a prompt rule backed by the critic, not a code limit: a reviewer that still writes a
  file through a command is not stopped by code. A read-only folder for the commands of a
  specialist without a write tool (a read-only mount in the Docker sandbox, a refusal in the
  process stand-in) would make it one; it is not built by this decision (a sandbox change for
  both runners, out of proportion to a minor finding).
- Tests: `packages/runtime/test/registry.test.ts` (the reviewer's, the tester's and the writer's
  entries and the PM's rule), `packages/runtime/test/intake.test.ts` (the intake's system prompt
  carries the rule).

## Alternatives considered

- **Forerunner writes the reviewer's report into the file the task names.** The person would get
  the file they asked for, but it needs the executor to find a file name in the outcome and write
  a model's report into the person's folder on its behalf, and it hides the planning mistake
  (work routed to a specialist that cannot do it) instead of removing it.
- **Give the reviewer `write_file`.** It contradicts its role (it never edits the code), and the
  critic would have to tell a review file from an edit.
- **A read-only command mode for the reviewer now.** The right enforcement, but a sandbox change
  (both the process stand-in and the Docker mount) out of proportion to a minor finding; left as
  the follow-up named above.

## Amendment 2026-11-23 (l4-selftasks-chat, run L4, L4-other-1)

Decision 1 covers the tasks the person makes too (New task, Edit, chat): New task and Edit say
"The reviewer writes no file: its findings are its report, which you read in the task's
drawer." when the reviewer is chosen, and nothing is refused. A task with no criteria whose
specialist writes no file (decided from its registry tools, `writesNoFile`) is held to its
report: its brief and its review read "The report shows this outcome (this specialist writes no
file, so a file named here is met by its report): <outcome>". No prompt changed. validation.md's
gap (the planner only plans work the specialist can do, U-022) stays open.

## Amendment 2026-11-23 (l4-selftasks-carried, run L4, L4-other-1 D-3, D-5, D-6)

Decision 1's line names the file the task's words ask for, and says the same wherever a task
for a specialist that writes no file is made or changed:

- **The line names the file** (D-5): when the outcome or a criterion asks for a file ("review.md
  lists the gaps"), the line reads "The reviewer writes no file, so review.md is not written: its
  findings are its report, which you read in the task's drawer." (`writesNoFileLine` with
  `fileTheWordsWrite`, registry/tools.ts). Words that name no file keep the plain line. New task
  and Edit ask `GET /settings/models` with the words typed so far (`?title=`, `?outcome=`,
  `?criteria=`), so the line follows them while the person types. A dotted name that is no file
  is never the file (the review of this amendment: "so Node.js is not written" was a false
  sentence): a word counts as a file only when its ending is a file's (md, csv, json, html, js
  and the like, not NET, IO or com), and a capitalised one-word name with .js or .ts ("Node.js",
  "Vue.js", "D3.js", as the bench's stand-in critic reads them) or a well-known one in lower
  case ("node.js") is a technology unless it has a folder ("src/App.js"). When in doubt the
  plain line shows, which is true whatever the words ask for.
- **Edit asks with its words** (D-3): the drawer's Edit passes the task's title, outcome and
  criteria, so its line names the same file New task names.
- **Chat says it too** (D-6): chat's read-back of a task.create for such a specialist, and of a
  task.update that gives a task to one or changes such a task's words, ends with the same line
  ("Add "Review the plan" to PharmaWatch? The reviewer writes no file, so review.md is not
  written: ..."), and so does the sentence after the yes. The commands ask the registry through
  `CommandPorts.modelSettings.writesNoFile`. An edit of only the priority, and every other
  specialist, read as before.

Nothing is refused and no prompt changed. On the bench the stand-in critic holds such a
specialist to its report (scripts/bench/README.md), so a reviewer run can be walked there.
