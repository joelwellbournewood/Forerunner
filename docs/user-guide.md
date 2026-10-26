# Forerunner user guide

What Forerunner does for you day to day, and where to look when something needs you. For
installation and first run see `setup-guide.md`. This guide ships with every release and grows
with it; a section marked "coming in this release" names a feature whose final shape lands with
a later milestone of the 1.0 build.

## The idea in one paragraph

You have an agent (Alice by default) that works on your projects in sessions: it reads the
state of the project, plans what fits the budget you gave it, claims tasks so it never collides
with your collaborator's agent, does the work in a sandbox, opens pull requests, asks you only
when it must, and leaves a handoff note. Every limit (money, steps, time, tools, files, domains,
autonomy) is enforced by the runtime, not by a prompt. You can stop everything at any time with
the kill switch.

## Home

Every project is a card: stage, next milestone, health, spend against budget, how many things
wait on you, and the latest critic grade. The active project is always shown in the header.
"New project" asks for a name, a goal, a short brief and a repository link.

## A project

- **Summary**: one screen the agent keeps current. "Read aloud" speaks it.
- **Plan**: milestones and their dependencies.
- **Tasks**: every task with status, specialist, cost, verdict and links to the pull request
  and the review. Transitions you may make by hand are buttons.
- **Docs**: the standard document set the agent maintains.
- **Reviews**: critic findings and grades over time.
- **Costs**: spend by model, specialist and task, in CHF, with the savings from caching and
  context compression.
- **Data**: files and datasets the project knows about; agents see metadata and samples, never
  whole files.
- **Chat**: a quick, read-only chat with the fast model about this project. "Make this a task"
  turns a message into a draft task.

## Sessions

A session starts on a schedule, on a trigger (a pull request comment, CI, an email command) or
by hand. The live view shows the event stream in plain words, the current task and specialist,
the step count and the running cost against the cap; escalations are highlighted. Raw output is
behind a toggle. A session stops cleanly when it reaches 80% of its cap (it finishes the
current task and starts nothing new), when its wall clock runs out, or when you stop it.

## Inbox

Human requests and agent messages across all projects, blocking ones first. A request shows the
context, why it matters, the options (multiple choice when possible) and whether it blocks work.
Answered decisions go to the decision log and are not asked again unless something changes.

## Autonomy and budgets

Each project has an autonomy level from 0 (advisor: plans only) to 4 (autopilot: everything
except destructive, financial and credential actions). The default is 2: routine reversible
actions are free, everything else is approved by you. Some actions always need a human at any
level: deleting repositories or data, force-pushing to main, spending real money, sharing
secrets, changing permissions, granting a new capability, sending money, entering passwords on
third-party sites.

Budgets exist per month, per project, per session, per task and per run. The runtime refuses a
model call that would cross a cap; it never relies on the agent noticing.

## Kill switch

The tray icon and the red button in the header stop every session of one agent or of
everyone, revoke the run tokens and freeze claims within two seconds. Starting a session again
lifts the stop.

## Voice, phone and email (coming in this release)

Push-to-talk voice chat with read-back confirmation, the Android app for approvals and remote
control of your PC, and tasks by email that run on the cloud runner while your PCs are off.
Each arrives with its milestone; the setup guide says what to configure. Speech on this PC is
chosen in the setup wizard and changed in Settings → Voice: none, CPU (any PC, slower replies)
or GPU (NVIDIA, fastest), each with its disk size shown.

## Where things live

Configuration, the vault, memory and data stay in your user profile (`fr dirs` prints the
paths). Updates never touch them. Secrets are stored by reference; their values never enter a
model's context, a log or git.

## When something goes wrong

`docs/maintainers/troubleshooting.md` lists the known failure modes and their fixes. `fr doctor`
checks the installation and prints what is missing.
