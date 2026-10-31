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

## What works and what doesn't yet

Version 1.0.0 was released with known gaps. Some parts were tested live, on real PCs, a real
phone and real accounts. Others were tested only against stand-ins we built. A few were not
tested at all. The full matrix is [docs/release/1.0.0-tested.md](release/1.0.0-tested.md).

In short:

- **Tested live:** chat and coding sessions on an Anthropic API key and on a Claude
  subscription (their pull requests went to a test git host, not GitHub); the critic; voice on
  one Windows PC; installing and updating the Android app on one real phone. Most of these runs
  used code from before the last release candidate; only the GitHub run below used the 1.0.0
  code.
- **Slower than the target:** voice. The first spoken word comes about 1.4 to 2.1 s after you
  release Talk on a GPU, about 4 s on the CPU profile. The target is 1.2 s.
- **Tested only against stand-ins:** email tasks, the cloud runner, push notifications on the
  phone, the in-app desktop updater, two people's agents sharing a project, and a budget cap
  stopping a session (no live run hit a cap).
- **Not tested:** a real mailbox, a real cloud runner host, a real Firebase project, voice on
  Linux, cloud voice providers, pairing a real phone, and running the installed MSI, AppImage
  or `.deb`.
- **GitHub:** a live run on 1.0.0 cloned this repository, pushed and opened a real pull
  request. On a PC without Docker or Podman the agent cannot run shell commands, so it cannot
  run your checks: the critic then sends the change back and it retries a few times before
  asking you. Install Docker or Podman to avoid that.

The phone shows notices only while the app is open, because push is not set up yet. Email and
the cloud runner are built and pass their tests, but you are the first to run them for real.

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
Each unread message has **Mark read**; **Mark all read** over the messages marks every unread
one at once.

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

## Voice, phone and email

Push-to-talk voice chat with read-back confirmation, the Android app for approvals and remote
control of your PC, and tasks by email that run on the cloud runner while your PCs are off.
The setup guide says what to configure. See "What works and what doesn't yet" above for how
far each was tested. Speech on this PC is
chosen in Settings → Voice (or `fr setup` from a source checkout): none, CPU (any PC, slower replies)
or GPU (NVIDIA, fastest), each with its disk size shown.

In the conversation panel (the Talk button or the global hotkey) your words show as they are
recognised and the agent's reply shows as it is written, the sentence being spoken
highlighted. Press Talk while the agent answers to interrupt it; the part it had not said yet
stays visible and readable, after a small "not spoken" tag and with a dotted underline, so you
can see where it stopped speaking. The **Reply: Voice | Text**
switch next to Talk shows how the agent answers; the chosen side is highlighted. Click a side,
or tab to the switch and use the arrow keys. With **Text** the agent answers in text only,
without speech: you still talk, the reply appears as it is written, and Talk stops it. The
choice applies from your next turn and is remembered on this computer. With a screen reader, the panel reads
out your words, each finished sentence of the reply and the end of the reply.

## Where things live

Configuration, the vault, memory and data stay in your user profile (`fr dirs` prints the
paths). Updates never touch them. Secrets are stored by reference; their values never enter a
model's context, a log or git.

## When something goes wrong

`docs/maintainers/troubleshooting.md` lists the known failure modes and their fixes. `fr doctor`
checks the installation and prints what is missing.
