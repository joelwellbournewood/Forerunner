# Forerunner user guide

What Forerunner does for you day to day, and where to look when something needs you. For
installation and first run see `setup-guide.md`. This guide ships with every release and grows
with it; a section marked "coming in this release" names a feature whose final shape lands with
a later milestone of the 1.0 build.

## The idea in one paragraph

You have an agent (Alice by default; rename it under Settings → **Your agent**) that works on
your projects in sessions: it reads the
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
wait on you, and the latest critic grade. "New project" asks for a name, a goal, a short brief
and a repository link; the project starts at your default autonomy (Settings) and becomes the
active project.

The active project is always shown in the header. It is one project for every channel: what
you pick in the header (or the palette's "Switch project", or Make active on Home) is the
project chat, voice and the phone talk about, and saying "switch to …" in chat or by voice
changes the header too. Opening a project's page does not change it; that page's **Chat** tab
always talks about that page's project. Each switch is listed in Changes.

A project reads **blocked** only while something waits for your answer in the Inbox. A task
that needs you but has no Inbox card (for example one you marked "Needs me") shows as
**needs you: <task>**; click it to open the project's tasks.

The header says **connected** while Forerunner's background service answers. When it stops
answering (or refuses this window after a restart) the header says **not connected** with a
**Retry** button and a line saying why; the app keeps trying on its own and says **connected**
again as soon as the service answers.

## A project

- **Summary**: one screen the agent keeps current. "Read aloud" speaks it.
- **Plan**: milestones and their dependencies.
- **Tasks**: every task with status, specialist, cost, verdict and links to the pull request
  and the review. Transitions you may make by hand are buttons. Each move is listed in Changes
  with the reason you gave; the line under the filters says what moved, with **Undo** while it
  can be taken back (a cancelled task is reopened; a task marked done stays done).
  **Cancel**, **Mark failed**, **Needs me** or **Send to review** on a task a session is working
  on stops that task's run at once; the session goes on with its other tasks and leaves the
  task as you set it, and its summary names the task you moved. The same move from the phone
  or Chat stops the run within a few seconds. A task shows the tasks it waits on by title
  ("after …"); **Depends on…** changes them, from a list of the project's tasks. A task that
  waits on a cancelled or failed task says so, since no session runs it until you change what
  it depends on (or mark the failed one ready again). A task cannot wait on itself, on a
  cancelled task, or on a task that already waits on it. A task's priority is **Low**,
  **Medium** or **High**; High runs first. New tasks are Medium unless you pick another; in
  Chat say it at the end: "add a task: fix the login, priority high".
- **Docs**: the standard document set the agent maintains.
- **Reviews**: critic findings and grades over time.
- **Costs**: spend by model, specialist and task, in CHF, with the savings from caching and
  context compression.
- **Data**: files and datasets the project knows about; agents see metadata and samples, never
  whole files.
- **Chat**: a quick chat with the fast model about this project. A small change you ask for
  (a task, a note for the next session) is made at once and its reply has an **Undo** button;
  a bigger one is read back first and waits for your **Yes**. "Make this a task" turns a
  message into a ready task, which the next session works on. Each project keeps its
  own conversation in this window: switching tabs or reloading keeps it, a Yes/No question you
  have not answered yet included.

**A project without a repository** works in its own folder on this computer (where its docs
are): the agents read and write there, and the critic reviews what each task changed. To give
it a GitHub repository, click **Create a repository** on the project page: it shows the name
(from the project's), your GitHub account (or an organization you name) and private, and **Yes**
creates it with your GitHub token, puts the project's folder in it as the first commit and links
it; from then on tasks work on branches with pull requests. "create a repository" in Chat does
the same. When a session plans code work for such a project, your agent asks in the Inbox
(**Create the repository** or **Not now**); "Not now" is not asked again. At autonomy 4
(Autopilot) the agent creates a private repository itself and tells you. A public repository
always needs your confirmation on this device.

**Next session** on the Summary tab holds notes, tasks, corrections and ideas for the next
session; "note: ...", "correction: ..." or "idea: ..." in Chat adds one too. Each reaches the
brief of the task it names, by the task's title or id ("Add the login page: reuse the session
cookie"), or of every task when it names none ("Write in British English"). The session log
says which task got which. The first-session plan you approve with a new project's setup
decides the first session: it runs those tasks, in that order, and later sessions go by
priority.

With the GitHub Projects mirror turned on in a project's settings, Forerunner asks once in the
Inbox before it creates the board. **Do not mirror this project** turns the mirror off for that
project, and nothing is asked again; turn it on again in the settings (or `fr mirror enable`)
to be asked again.

## Sessions

A session starts on a schedule, on a trigger (a pull request comment, CI, an email command) or
by hand. The live view shows the event stream in plain words, the current task and specialist,
the step count and the running cost against the cap; escalations are highlighted. Raw output is
behind a toggle. A session that has ended shows **finished**: its log is complete and the
page no longer waits for events. A session stops cleanly when it reaches 80% of its cap (it finishes the
current task and starts nothing new), when its wall clock runs out, or when you stop it.

A start while your agent is in another session waits its turn: waiting starts (yours, an
approved plan's, a CI or pull request trigger) run one after the other in the order they came,
and none replaces another. **Start session** says how many wait before yours.

A session plans the ready tasks that fit its budget, highest priority first; a task too large
for the budget is left out and the smaller ones after it still run. **Start session** says
before you start when no ready task can run (each one that waits on another task, and each
one larger than the budget, by name) and what to do; the session's summary names the same.

When a session ends, its summary, the last line of its log and the notification count the same
things: tasks done, failed, needing you, sent back by the critic for another attempt, waiting
in review, and not started. A session where nothing was done because its tasks failed or were
sent back gets a lower grade from the critic's session review.

## Inbox

Human requests and agent messages across all projects, blocking ones first. A request shows the
context, why it matters, the options (multiple choice when possible) and whether it blocks work.
Answered decisions go to the decision log and are not asked again unless something changes.
On a card whose answer must be one of its options (a sign-off, a plan, an approval), a typed
answer that is none of them is not taken: the card stays and says "Choose one of: …" with its
options; type one of them or click its button. A question that asks for your own words takes
any text.
When the critic cannot review a task (its model is unreachable, for example), the task waits
in review and a card asks you: **rework** runs it again in the next session and the critic
reviews the new run, **accept** takes the work as it is without a review, **cancel** cancels
the task.
Each unread message has **Mark read**; **Mark all read** over the messages marks every unread
one at once.

## Autonomy and budgets

Money is shown in CHF everywhere you read it: cards, the session log, summaries, notifications
and the Inbox. The **review level** of a task (its risk tier) says how carefully the critic
checks the work: checks only (0), a light review (1), a full review (2), a full review and your
sign-off (3).

Each project has an autonomy level from 0 (advisor: plans only) to 4 (autopilot: everything
except destructive, financial and credential actions). The default is 2: routine reversible
actions are free, everything else is approved by you. Some actions always need a human at any
level: deleting repositories or data, force-pushing to main, spending real money, sharing
secrets, changing permissions, granting a new capability, sending money, entering passwords on
third-party sites.

Budgets exist per month, per project, per session, per task and per run. The runtime refuses a
model call that would cross a cap; it never relies on the agent noticing.

On a Claude subscription, Settings → **Claude subscription allowance** says how much
API-equivalent use your plan covers a month, in CHF. Forerunner cannot see your plan's real
usage, so it estimates against this amount and stops subscription work at 95% of it; an API
key takes over when you have one. The default (USD 50, about CHF 40) is low on purpose: enter
what your plan covers, or a Max plan's work stops early.

A task's own budget (New task, **Budget**) is what its runs stop at: all its runs together
never spend more. The Tasks tab shows it under the task's cost ("of CHF 4.00 budget"). A task
without a budget stops each run at its specialist's limit, and the Tasks tab says so ("no
budget; each run stops at CHF 2.40 (coder limit)"). The estimate a plan shows is only a
forecast. When a task reaches its budget it waits for you with what it spent: raise the budget
and set it back to ready, split it, or cancel it; the session goes on with the other tasks.

When a task fails twice, the third attempt goes to another specialist that can do the same
work (the coder's to the migration specialist, the tester's to the coder, and so on); the
session log says so. When no other specialist can, the task waits for you on the Tasks tab
with what to do (split it into smaller tasks, or cancel it) instead of running the same way a
third time.

Research on the web needs a Claude subscription: runs billed to an API key have no web tools.
On an install with an API key only, project setup plans no web research, and a task given to
the researcher waits for you, saying so, instead of failing and being retried.

Every setting is in **Settings → All settings** with a plain name and its own control: your
default autonomy for new projects, the monthly spending cap, quiet hours (a time range, or off),
where notifications go, reading urgent notifications aloud, the monthly critic calibration, the
model watch's evaluations; and per project the autonomy, the project budget, the budget per
session, the highest model its runs may use, small-project mode, the monthly handover test,
Opus fast mode and speed or quality. Every change shows the same change card as in chat and is
listed in Changes. The language is shown but cannot be changed yet: the app works in English.
**Desktop control: allowed applications** lists the programs your agent may use when desktop
control is on; any other program needs your yes in the Inbox each session.

In **Settings → Models**, each row says the highest model it runs at. Chat and planning always
run at standard speed, so they offer no speed choice; chat never runs above opus. A specialist
set to fable runs fable only in a project whose highest model is fable.

## Changes and undo

**Changes** lists every change made in the app, in chat, by voice or by email: who asked, the
words used, what changed, and **Undo** while it can still be taken back. An undo needs the same
confirmation as the change it makes: undoing a lowered monthly cap raises it, so it waits for
your confirmation on this PC (or the phone with biometric), and so does putting back a wider
email mode; undoing a raise acts at once. When an undo cannot work any more (the task was
finished since, a session already read the note), the change says why instead of offering
Undo, and nothing ever says "Undone" when nothing changed.

## Kill switch

The tray icon and the red button in the header stop every session of one agent or of
everyone, revoke the run tokens and freeze claims within two seconds. "Everyone" means your
agents on this computer: on a shared project the other people's sessions keep running, and the
tasks they hold stay theirs. Nothing starts until you
click **Resume** (the same button, or the tray) or start a session from the phone; the stop
lasts across restarts until then. **Stop** on one session, from its page or the phone, ends
that session only and leaves the kill switch on. Starting a session while Stop all is on says
so: press **Resume** first.

The command palette opens with **Ctrl+K** (**⌘K** on a Mac) and has **Start session** for the
active project.

## Closing and quitting

Closing the window keeps Forerunner running in the tray, so sessions, scheduled work, the phone
app and email commands keep working. The first time, a notification says so.

To stop it completely, right-click the tray icon and choose **Quit Forerunner**. It stops the
background service and everything it started; while a session runs it asks first. This also
works while Forerunner is still starting or when the background service no longer answers.
After Quit nothing of Forerunner runs, so you can delete the install folder or install another
version. If you open Forerunner again while it is quitting, it waits until everything has
stopped and then starts afresh.

## Voice, phone and email

Push-to-talk voice chat with read-back confirmation, the Android app for approvals and remote
control of your PC, and tasks by email that run on the cloud runner while your PCs are off.
The setup guide says what to configure. Pairing a phone needs Forerunner's shared state service
first (a server of yours that the phone and the PC both reach); until it is set up, Settings →
Devices shows the steps still missing and takes the service's admin token. See "What works and what doesn't yet" above for how
far each was tested. On the phone's **Reviews** tab, **Approve** on a reviewed task does what
the card's accept (or yes) button does in the Inbox, and **Reject** what its revise / rework
(or no) button does: the work goes back for another attempt with the findings to address.
Speech on this PC is
chosen in Settings → Voice (or `fr setup` from a source checkout): none, CPU (any PC, slower replies)
or GPU (NVIDIA, fastest), each with its disk size shown. A cloud voice provider (Deepgram, Without it, Talk says "install voice in
Settings → Voice" and why (while an install runs: wait for it to finish); type instead meanwhile.
Email is set on the Email page (Settings → Capabilities → Email) and nowhere else; it is your
agent's mailbox, so the page has a card for your agent only.
Cartesia, ElevenLabs) is added in Extensions; paste its API key on its row there. The agent's
mailbox password goes into the password box on Settings → Capabilities → Email. Both are kept
in this computer's credential store and never shown again.

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

## Extensions and Settings

Each thing has one place. **Settings** is how Forerunner itself works; **Extensions** is what
your agents may reach beyond their built-in tools.

- **Settings**: your agent's name, the model and its key or subscription (set in the setup),
  budgets and autonomy, **Voice** (installing local voice, CPU or GPU, and which voice providers
  are in force), **Email** (your agent's mailbox and mode, on the Email page) and your paired
  devices.
- **Extensions**: each extra capability with what it is granted (tools, domains, secrets,
  scopes), what it has cost, and an On/Off switch that takes effect at once, also for a session
  that is running: the sandboxed browser, desktop control, Cloudflare deploys, the cloud voice
  providers (Deepgram, Cartesia, ElevenLabs: used instead of local voice while on, each with its
  key) and connectors (MCP servers) such as filesystem, fetch and GitHub.
- **Adding one.** Extensions → **Add** → **Add** on an entry of the catalog opens a confirmation
  right there with what it may do: its tools, the secrets and domains it uses, its scopes and its
  risk. **Confirm on this device** grants it (this PC is your paired device; a grant is a
  high-risk change), and nothing more is asked in the Inbox. **Cancel** adds nothing. The Inbox
  still asks about grants you did not just see: an extension added from a URL (after it was
  started once to list its tools), wider permissions for an extension, or anything an agent
  proposes.
- The **GitHub** connector gives agents extra GitHub tools (issues, pull requests, search). The
  built-in GitHub features (your repositories, pull requests, the Projects mirror) do not need
  it.
- Local voice and the model provider had rows in Extensions that switched nothing. They are no
  longer there; the first start of this version removes such a row an earlier version added.

## Your agent's name

Settings → **Your agent**: type a new name (one line, up to 60 characters) and click **Save**. The
app, notifications, the agent's commits and its email signature use it at once, the phone within
30 seconds; its projects, sessions and memory stay with it.

## Where things live

Configuration, the vault, memory and data stay in your user profile (`fr dirs` prints the
paths). Updates never touch them. Secrets are stored by reference; their values never enter a
model's context, a log or git.

## Updates

**Check for updates** on the Updates page asks the release feed; installing is its own click.
While sessions run, **Update and restart** and **Roll back and restart** first say how many
sessions the restart would stop and wait for your yes. **Run evaluations** (when the model watch
held back paid evaluations) says what the runs may cost, in CHF, before it runs them.

## When something goes wrong

`docs/maintainers/troubleshooting.md` lists the known failure modes and their fixes. `fr doctor`
checks the installation and prints what is missing.
