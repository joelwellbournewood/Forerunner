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
  request.
- **Docker:** tasks that get a full review (risk tier 2 and above) run only in the Docker
  sandbox. On a PC without it they wait instead of failing; Settings → **Sandbox (Docker)** says
  what to do (below, under Sessions). The switch to Linux containers and the sandbox download
  on a real Windows PC with Docker Desktop were not tested by CI.

The phone shows notices only while the app is open, because push is not set up yet. Email and
the cloud runner are built and pass their tests, but you are the first to run them for real.

## Home

The header has **Home**, **Inbox** (with how many cards need you) and **More** (Memory,
Extensions, Changes, Performance, Updates), and the gear for **Settings**. While a session
works, a chip says so: **Alice is working on "Style the page" · 2 min ›**; click it to open the
session. **Stop all (1 running)** shows only while something runs (see "Kill switch").
Without a Claude key a bar says "Claude is not connected: planning and tasks need it. You can
still add tasks." with **Connect**.

Home shows, top to bottom:

- **Needs you**: every card waiting for you in any project, one line each with **Answer**
  (it opens that card in the Inbox).
- **Working now**: who works on what in which project, for how long, with **Open**.
- **Projects**: one row each, with the project's status in one sentence, "3 of 7 done", and
  the one button that fits: **Answer**, **Open running session**, **Continue** (starts a
  session that works until nothing more can run), **Set up Docker** or **Open Tasks**.

The sentence says, first match first: "Waiting for you: approve the plan" or "Waiting for you:
2 questions"; 'Working on "Style the page" (3 of 7 done)'; 'Stuck: "Style the page" failed; 2
tasks wait on it' or "Waiting for Docker: 1 task"; "Ready to continue: 3 tasks ready";
"Drafting the plan…" or "Planning failed: Claude did not answer" with **Try again** (without a
Claude key: "Planning failed: Claude is not connected" with **Connect Claude**), or "You
rejected the plan. Nothing was written." with **Draft a new plan**; "Done: all 7 tasks. Your
files: <folder>". The project's page has the reason in full. Home and the project pages follow
the work as it happens: no reload needed.

**New project** asks for a name, a goal, a short brief and a repository link; the agent drafts a
plan for you to approve. The project starts at your default autonomy (Settings → Basics; each
project's own autonomy is under Settings → Advanced, by name) and becomes the active project.
The goal is optional when you write a brief: left empty, the brief's first sentence is the goal.
Without a repository link, a brief of a sentence or two (under 200 characters, no list) gets a
small plan: one milestone of one to three tasks and two short documents (if the agent plans
more, Forerunner asks it once more for a smaller plan). Its tasks are reviewed like any other:
the critic checks each one after the agent has done it. A longer brief or a list of features
gets a full plan.

The header names the project you are looking at. The active project (the one chat, voice and
the phone talk about outside a project page) is what you pick in the header's list, the
palette's "Switch project" or by opening a project from Home; saying "switch to …" in chat or by
voice changes it too. A project's **Chat** tab always talks about that page's project. Each
switch is listed in Changes.

The header says **connected** while Forerunner's background service answers. When it stops
answering (or refuses this window after a restart) the header says **not connected** with a
**Retry** button and a line saying why; the app keeps trying on its own and says **connected**
again as soon as the service answers.

## A project

The project's page starts with its name and its status in one sentence with its button (as on
Home). **Start session** reads **Open running session** while a session works on it. The tabs
are **Overview**, **Tasks**, **Chat** and **Files**; **More** holds **Plan**, **Docs**,
**Reviews**, **Costs** and **Data**.

- **Overview**: where the project stands and what happens next. The cards of this project that
  wait for you, each with **Answer**; **Working now** (the task in flight, for how long, with
  **Open**); **Last result** (the last session's result in at most three lines, with **Open the
  session** and "Read aloud"); **Next** (the open tasks in the order a session runs them, each
  with its status, worked out when you look); **Your files** (the project's folder with **Open
  folder** in the desktop app and **Copy path**, and the files the last session changed; for a
  project linked to a GitHub repository instead: the repository with its link, and **Waiting for
  you to merge**, each pull request with **Open**, since merging on GitHub is what puts the work
  into the repository's default branch; they are grouped by who checked them: "Reviewed by the
  critic", "Accepted by you at sign-off", "Marked done without the critic's review", and
  Forerunner's own docs pull requests (the project's docs and its status), which you merge when
  you like. The Last result says how many reviewed pull requests that session left for you;
  this list is every one that waits now);
  **Decisions** (each question you answered with your answer, your name and the day: "Where
  should the page be published? Only as a local file for now. (Robin, 1 Nov)", the plan you
  approved, and the decision records in the project's folder, which open in Docs); and **Note
  for the next session** (one box; see below). Peers appear only when another agent works on the
  project.
- **Files**: the project's folder on this computer (its own folder, the folder you linked, or
  this computer's copy of its repository as merged: work still in a pull request is on the
  Overview) as a list with sizes and when each file changed.
  Click a file to read it here (text files; nothing can be changed from this tab). **Open
  folder** (desktop app) opens it in your file manager; **Copy path** copies where it is. Until
  the work writes something it says "Nothing written yet".
- **Plan** (under More): milestones and their dependencies.
- **Tasks**: every task, in the order a session runs them (a task after the tasks it waits for,
  then by priority), with its status in words, who does it, its cost and the critic's call. The
  status says what is going on: **Ready**, **Waiting for "Write the README"**, **Stuck: "X"
  failed**, **Waiting for Docker** (a full review needs Docker, and it is not running), **Running
  (Alice, 2 min)**, **Being reviewed**, **Needs your answer** (its card is in the Inbox),
  **Needs your decision: tried 4 times** (it failed after its tries; its card is in the Inbox,
  and the row offers **Answer**, **Try again** and **Cancel**), **Paused by you**, **Failed:
  why**, **Done** (or **Done: accepted without review**), **Cancelled**. The rows follow a running session
  by themselves. Each task offers what fits its status, each with a line saying what it does:
  **Make ready** (a draft), **Pause** / **Resume**, **Stop** (a running task: its run stops now
  and it is paused; the session goes on with the rest), **Try again** (a failed task), **Answer**
  (opens its card in the Inbox) or **Go ahead without** (the specialist decides and says what it
  assumed; not offered on a task only you can do), **Redo** (a done task: say what is wrong),
  **Reopen** (a cancelled task) and **Cancel** (it names the tasks that wait on it and will be
  stuck). Every action asks for an optional **note for the agent**, which goes into the task's
  next brief (for a cancelled task, once you reopen it), and has one **Undo** right after it
  that puts the task back as it was, its card in the Inbox included; each is listed in
  Changes. Click a task's title to open it: what done looks like and the criteria, what it
  waits for and what waits on it, its runs (who ran each one, with that run's report and the
  files it changed; the critic's run is marked as the review), the critic's review in words,
  its pull request, and **Edit**
  (the wording, priority, budget, review level and who does it; for example a full-review task
  waiting for Docker can go to a light review) and **Change what it waits for** (the project's
  tasks by title; a failed one is flagged; a task cannot wait on itself, a cancelled task or a
  task that already waits on it). **New task** asks the title, what done looks like, what it
  waits for, the review level ("Light review: the critic reads the work, nothing runs in
  isolation"; "Full review: needs Docker" says when Docker is not running on this computer),
  who does it (let the agent choose, a specialist, or **Me: ask me in the Inbox**: its questions
  are a card in the Inbox at once and no session runs it; a title such as "Confirm the hosting
  with me" counts as yours too), the
  priority (**Low**, **Medium** or **High**; High runs first) and a budget in CHF ("1.50" or
  "1,50"). In Chat say the priority at the end: "add a task: fix the login, priority high".
  The filters (status, who does it, a search) stay in the address, so they are still set when
  you come back to the tab.
- **Docs** (under More): the standard document set the agent maintains, and the decision
  records in docs/decisions.
- **Reviews** (under More): the critic's verdict on each task in words ("accepted", "sent
  back"), its grade in the verdict's colour, and what is still to fix, counted once per task (a
  task that is done has nothing open). The critic's evidence is under **Details**; its check of
  each session's summary is folded under **Session checks**. The "review" link in a task's
  drawer opens its review highlighted.
- **Costs** (under More): spend by model, specialist and task, in CHF, with the savings from
  caching and context compression.
- **Data** (under More): files and datasets the project knows about; agents see metadata and
  samples, never whole files.
- **Chat**: ask about this project and change it in words. It knows the conversation so far,
  every task with its status (what it waits for, why it failed), the last session's result, what
  runs now, the cards waiting for you and where the files are, and it can look up a task's runs
  and review. Ask "what is going on?", "what failed and why?", "what is left?". Tell it what to
  change: "add a task: …" (a ready task, with **Undo**), "make the FAQ task depend on the README
  task", "skip the LICENSE task" (a pause), "resume …", "cancel …", "try … again", "start working
  now", "stop" (stops the running session now; its task is ready again), "stop after this task",
  "stop everything" (Stop all) and "resume" (allows sessions again), "note: …" for the next
  session, "summary". A change to a task is read back once in one line ('Make "Write the FAQ"
  wait for "Write the README"?') with **Yes** and **No**; the card stays while you type other
  things, and "yes" with nothing waiting asks "Yes to what?" (or, when the card it meant was
  answered in the Inbox or expired, says so). Under each read-back the conversation says what
  became of it: you said yes, you said no, or not answered. "start a session" when nothing can
  start (Stop all is on, Claude is not connected, no task can run, the plan from your brief still
  waits for your approval) says why at once, as the Start dialog does. Asked about a project
  whose plan from the brief is still being drafted, waits in the Inbox, or failed, Chat says so
  (after a failure: the reason and **Try again** on the project page) instead of "no tasks yet".
  Replies show bold, lists and code as formatting, never as asterisks; so do the session page's
  lines with a specialist's or the critic's words and the reports in a task's details. File
  names and commands (`__tests__/quote.test.js`, `test/**/*.test.js`) show exactly as written.
  During a session a question is
  answered from what runs now; nothing you type is handed silently to the specialist. "Make
  this a task" under one of your own lines turns it into a ready task. Each project has its own
  conversation, kept by Forerunner: a reload or a restart keeps it, and **Talk** on this
  project's pages shows the same one. Before you have added a Claude key, Chat still runs the
  commands that need no model; anything else is answered with where to add the key: Settings →
  Accounts and keys → Open the setup assistant.

**A project linked to a GitHub repository**: each task works on a branch of its own and opens a
pull request when it is done; Forerunner makes the commits, pushes and opens the pull request
(the agents are told so), and the session page lists each pull request with its branch. A
repository just created on GitHub, with nothing in it, gets a first commit from Forerunner on its
default branch (the project's docs, or a README), so its tasks have something to start from; if
that cannot be done, the task says so ("… is empty and Forerunner could not make its first commit
…") and what to do. The project's status file (`docs/status.md`) goes in a pull request of its
own, "docs: project status", which each session adds to; it never goes into a task's reviewed
pull request. Docs that wait in a pull request say so on the Docs tab, with the link.

**A project without a repository** works in its own folder on this computer (where its docs
are): the agents read and write there, and the critic reviews what each task changed. At the
end of each session the folder's history records what the session did (one commit), so the
folder is never left with uncommitted work; a `.gitignore` keeps caches such as `__pycache__`
and `node_modules` out of it. To give
it a GitHub repository, click **Create a repository** on the project page: it shows the name
(from the project's), your GitHub account (or an organization you name) and private, and **Yes**
creates it with your GitHub token, puts the project's folder in it as the first commit and links
it; from then on tasks work on branches with pull requests. "create a repository" in Chat does
the same. When a session plans code work for such a project, your agent asks in the Inbox
(**Create the repository** or **Not now**); "Not now" is not asked again. At autonomy 4
(Autopilot) the agent creates a private repository itself and tells you. A public repository
always needs your confirmation on this device.

**Note for the next session** on the Overview is one box: type what the agent should know
and **Save note**; "note: ...", "correction: ..." or "idea: ..." in Chat adds one too. A note
reaches the brief of the task it names, by the task's title ("Add the login page: reuse the
session cookie"), or of every task when it names none ("Write in British English"). The session
log says which task got which. Notes waiting for the next session are listed under the box with
**Dismiss**. The first-session plan you approve with a new project's setup decides the first
session: it runs those tasks, in that order, and later sessions go by priority.

When you give a brief, Forerunner drafts a plan from it and puts it in the Inbox for your
approval (see "Inbox" below: Approve and start, Change the plan, Reject). Above the project's
tabs you see where it stands: "Drafting the plan from your brief…", "Waiting for you: approve
the plan" with **Open**, "Planning failed" with what went wrong in words ("Claude did not
answer (model call failed).", "Claude's plan could not be read. Forerunner asked Claude twice.",
"Your Claude usage limit is reached. Try again once it resets.") and **Try again**, or "You
rejected the plan. Nothing was written." with **Draft a new plan**. Without a Claude key the
failure says so; add one in Settings → Accounts and keys → Open the setup assistant, then Try
again. When Claude's first answer cannot be used (not a plan, cut off, a part missing),
Forerunner tells Claude what was wrong and asks once more before it says planning failed; both
calls count in the project's spend. A long explanation in the plan is shortened, never a reason
to lose the plan.

With the GitHub Projects mirror turned on in a project's settings, Forerunner asks once in the
Inbox before it creates the board. **Do not mirror this project** turns the mirror off for that
project, and nothing is asked again; turn it on again in the settings (or `fr mirror enable`)
to be asked again.

## Sessions

A session starts on a schedule, on a trigger (a pull request comment, CI, an email command) or
by hand. The live view shows the current task and specialist, the step count and the running
cost against the cap, and a log of what a person follows a session by, one line each: "The coder
started "Create the page skeleton" (about CHF 0.14).", "Changed index.html.", "The critic
accepted "Create the page skeleton".", "The designer could not do "Style the page": "The work
needs something I do not have here". Trying again." and how it ended ("Session over: 2 done, 1
needs you. CHF 0.06."). A task the critic sends back is tried again in the same session; each
try is one line, and "The writer takes over …" says when another specialist tries it. **Details**
adds the internal steps (the brief, memory, each tool call, each start and finish of a retry, the
notifications sent), each line's event type, the level filters and the raw output; escalations
are highlighted. A session
that has ended
shows **finished**: its log is complete and the
page no longer waits for events. A session stops cleanly when it reaches 80% of its cap (it finishes the
current task and starts nothing new), when its wall clock runs out, or when you stop it.

A start while your agent is in another session waits its turn: waiting starts (yours, an
approved plan's, a CI or pull request trigger) run one after the other in the order they came,
and none replaces another. **Start session** says how many wait before yours.

**Start** opens a dialog that says what the session will do: "This session runs "Create
index.html" (about CHF 0.12) and continues with up to 6 more as they become ready". The budget
is filled in with the project's default; 0, a negative amount or more than is left of your
monthly cap is refused in words. "Note for this session" goes into the brief of every task the
session runs. When nothing can run, Start is greyed out and the dialog says why in one sentence
with the button that fixes it (Allow sessions again, Open it, Open Tasks, Set up Docker,
Connect Claude). After Start you stay where you were; **Open the session** opens its page.

**One Start keeps going.** A session works until nothing it can run is left: after each task it
looks again and takes the tasks that just became ready (what they waited for is done), a task
the critic sent back (the next attempt runs in the same session, up to the retry limit; after
the last one you get one card), and tasks you made ready meanwhile. So a chain of seven tasks
is one Start. It stops when nothing more can run, the session's budget is used (a fifth is kept
for reviews), you stop it, or its time runs out. A run that fails because Claude did not answer
(the network, a rate limit) is tried again once at once; if it fails again the task reads
"Failed:" with what went wrong, never the model's first sentence.

The first session after you approve a plan follows the plan's order; later sessions take ready
tasks by priority. A task too large for what is left of the budget is left for next time and
the smaller ones still run. A session that finds nothing it can run uses nothing up: your notes
for the next session and the approved first session stay for the next one, and nothing is
graded. Notes are used up only by a task that finished.

**The result** has at most three lines: what needs you first ("Style the page" needs your
decision (Inbox); "Add script.js" failed: Claude did not answer), then what was done (Did 5
tasks: ...), then how it ended and what is next ("Nothing left.", "Left for next time: ...",
"2 tasks wait on it.") with the cost in CHF. The Inbox gets one line per session naming the
project; the full result is on the project.

**Full-review tasks wait for Docker.** A task at risk tier 2 or 3 runs its tests and builds in
the Docker sandbox, isolated from your computer, so the critic sees real results. While the
sandbox is not ready (Docker not installed or not started, Docker Desktop on Windows
containers, or the sandbox not downloaded yet), such a task waits: the session runs your other
tasks, **Start session** and the summary name it under "Waiting for Docker" with the next step,
and the Inbox has one notice saying Docker is needed. Nothing fails and no retry is used. Open
Settings → **Sandbox (Docker)**: it shows the step (install Docker Desktop, start it, switch it
to Linux containers, **Download the sandbox** with its size and progress), and **Check again**
after each one. The task runs in the next session once the card says Ready. A task that an
earlier version marked failed for want of a sandbox goes back to ready by itself then.

A session where nothing was done because its tasks failed or were sent back gets a lower grade
from the critic's session review.

**Stopping and crashes.** A session's page has two stops. **Stop after this task** (the usual
one) lets the task in flight finish, starts no other, and ends the session ("Stopped after the
task, as asked"). **Stop now** asks once, then stops the task at once: it goes back to Ready with
"Stopped by you", and what it wrote so far stays in the project's folder. The session reads
"Stopped by you", not an error, and the Inbox gets no line about your own click unless the
session finished something first. **Stop all** in the header (or the tray, `fr kill`, a kill from
your phone, or "stop everything" typed in Chat) stops every session the same way: they read
"Stopped: Stop all", their tasks go back to Ready with that reason, and no session starts until
you press **Allow sessions again** (or say "resume" in Chat). "stop" typed in Chat, or Stop from
your phone, is Stop now; "stop after this task" in Chat is Stop after this task.
Quitting Forerunner while a session runs reads "Stopped: Forerunner was closed". If Forerunner
crashed while a session ran, the next start of Forerunner ends that session ("Interrupted:
Forerunner closed"), puts its task back to Ready ("Forerunner closed while it ran") and posts one
line in the Inbox; the next Start works at once. Stop on a session that nothing runs any more
ends it the same way.

## Inbox

Everything that waits on you, and short news. Two lists:

- **Needs you (n)**: one card per thing only you can settle, blocking ones first. The number is
  the same in the header's Inbox badge. Each card says which project and task it is about (the
  task opens on the Tasks tab), what is going on in one or two sentences (in the specialist's own
  words where there are any, and which tasks wait on it), and its buttons. Each button says what
  it does on the line beside it. A button that drops work or closes it without a review asks once
  before it acts. A text box appears only where your own words are taken (a question); other
  cards take their buttons. Longer detail, such as what the critic found, is under **Details**.
- **Updates**: one line per thing that happened (a session's result, something the app did by
  itself), with **Mark read** and **Mark all read**.

After you answer, the card is replaced by one line saying what happens next ("Done: Trying
"Style the page" again: a session started."). **Answered** at the bottom lists what you answered
lately and what came of it, and cards that were closed because you moved their task. If your
answers came after their task had already finished, the entry says so and offers **Redo with
these answers**: the task opens again and its next attempt reads them.

The cards you meet most:

- **The plan** from a new project's brief: the tasks in order, who does each, about what each
  costs ("cost not known" where the plan has no estimate), "Needs Docker" beside a task that
  needs a full review while Docker is not running, the total and what it covers ("About CHF 1.04
  for 2 of the 3 tasks the agent does; the other one has no estimate yet."), and the decision it
  records in one or two sentences, with **The full decision record** one click away. **Approve and start** writes the tasks and starts working on
  them now. **Change the plan** opens a box: say what to change and the agent drafts a new plan
  for you to approve. Your words are kept: if that draft fails, or Forerunner closes before it
  is done, **Try again** on the project page drafts it with them, and a second change on the
  new plan adds to the first. **Reject** writes nothing; the project page then says "You
  rejected the plan. Nothing was written." with **Draft a new plan**.
- **A task that failed**: after its tries (the critic sent it back each time) or when its run
  failed ("Claude did not answer"), one card, never one per try. **Try again** starts a session
  that tries again; type a note first if you know what to change, and the next attempt reads it.
  **Mark done anyway** closes it although nothing passed review (asked once; the task then reads
  "Done: accepted without review") and the tasks after it can run. **Cancel task** drops it and
  says which tasks after it will be stuck.
- **The critic's sign-off** on a task that needs your review: **Accept the work**, **Send it
  back** (a session reworks it with the critic's findings), **Cancel task**.
- **Questions** for you or from a specialist: see "When Forerunner needs you" below.

Answering resumes work: every answer that makes a task runnable starts a session of its project,
or queues one behind the session that runs. Answered decisions go to the decision log and are not
asked again unless something changes. If an answer cannot be taken (the card changed on another
device), the card stays and says "Choose one of: …" with its options.

## When Forerunner needs you

Some work only you can do: choose the stack, the hosting, the repository or the domain, name an
account, settle a preference. Forerunner never hands that to a specialist, which cannot ask you.
It asks you in the Inbox instead, on a card that names the task and the project and lists the
questions, each with its own answer field.

- **A task planned for you** (the plan says it "asks you in the Inbox") is asked as soon as the
  plan is approved, or when Forerunner starts. No specialist runs and nothing is spent.
- **A specialist that needs your answer while working** asks you on the same kind of card and
  stops; the task waits.
- **A run that reports it needs your answers** is not retried: its questions are filed at once,
  with the critic's note, instead of a sign-off.

Type your answers and click **Send answers**; leave a question blank if you have no answer yet.
Your answers are written to the project's decision record (`docs/decisions/0001-…` in the
project's workspace folder) and the decision log. A task planned for you is then
done, and if a task was waiting on it, a session starts and works on that task (the card's Done
line says so); a task a specialist was working on goes back to ready, a session starts, and its
next run gets your answers. On a specialist's questions, **Go ahead without** lets the specialist decide
and say in its report what it assumed; the task goes on in a session. **Cancel task** cancels it
instead (asked once, naming the tasks that wait on it). You can also answer in your own words
from the phone; one text then answers all the questions.

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
model call that would cross a cap; it never relies on the agent noticing. In Settings a money
field takes any amount in CHF with a point or a comma ("12.30", "150.40", "1,50"); 0 or a
negative amount is refused in words. Closing a change's preview without answering it (the x,
Escape or Cancel) answers it "no", so no confirmation is left waiting in the Inbox.

On a Claude subscription, Settings → **Claude subscription allowance** says how much
API-equivalent use your plan covers a month, in CHF. Forerunner cannot see your plan's real
usage, so it estimates against this amount and stops subscription work at 95% of it; an API
key takes over when you have one. The default (USD 50, about CHF 40) is low on purpose: enter
what your plan covers, or a Max plan's work stops early.

### Which Claude credential is used first

With both a Claude subscription and an API key saved, Settings → **Claude: which to use first**
lists them in the order Forerunner uses them, for everything: tasks, Chat, project setup,
reviews and the model watch. **Move up** and **Move down** change the order; the change is in
Changes, where you can undo it. Each row says:

- how it is used: the subscription always runs **through Claude Code**; an API key always goes
  **straight to the API**, which is where promotional API credits apply (they do not apply to
  use through Claude Code, so Forerunner never sends an API key there);
- whether it can be used now, and why not: this month's allowance is reached, its monthly cap
  is reached, it rests after a usage limit (until the time shown), or no key is saved;
- what it has spent this month: the subscription as a share of its allowance, an API key in CHF.

When the first one cannot be used, the next one is. If Claude says the subscription's usage
limit is reached, the subscription rests until the time Claude gives (an hour when it gives
none), the call is made again with the API key, and the session log says so; a task stopped
that way goes back to ready and runs on the next credential, without counting as a failed
attempt. Until you choose an order, tasks use the subscription first and Chat, project setup
and reviews use the API key first.

A task's own budget (New task, **Budget**) is what its runs stop at: all its runs together
never spend more. The Tasks tab shows it under the task's cost ("of CHF 4.00 budget"). A task
without a budget stops each run at its specialist's limit, and the Tasks tab says so ("each
run stops at CHF 2.40 (coder limit)"); a done or cancelled task shows no limit. The estimate a
plan shows is only a
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

**Stop all (1 running)** in the header shows only while a session runs. It asks once ("Stops
every running session now. No session starts until you allow it again."), then stops every
session of your agents on this computer, revokes the run tokens and freezes claims within two
seconds; the tray does the same. On a shared project the other people's sessions keep running,
and the tasks they hold stay theirs. A bar then says **Sessions are stopped** until you press
**Allow sessions again** (lets sessions start again) or **Continue where it stopped** (allows
them and starts a session on every project that has work that can run); the tray, "resume" in
Chat or a start from the phone allow them too. The stop lasts across restarts until then. A
session's own page has **Stop after this task** and **Stop now** (see "Sessions"); they end that
session only and leave the rest running. Starting a session while sessions are stopped says
so, with **Allow sessions again**.

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
the card's Accept the work / Mark done anyway (or yes) button does in the Inbox, and **Reject**
what its Send it back / Try again (or no) button does: the work goes back for another attempt
with the findings to address.
Speech on this PC is
chosen in Settings → Voice (or `fr setup` from a source checkout): none, CPU (any PC, slower replies)
or GPU (NVIDIA, fastest), each with its disk size shown. A cloud voice provider (Deepgram, Without it, Talk says "Voice is not installed.
Install it in Settings → Voice, or type below."; type instead meanwhile.
Email is set on the Email page (Settings → Capabilities → Email) and nowhere else; it is your
agent's mailbox, so the page has a card for your agent only.
Cartesia, ElevenLabs) is added in Extensions; paste its API key on its row there. The agent's
mailbox password goes into the password box on Settings → Capabilities → Email. Both are kept
in this computer's credential store and never shown again.

In the conversation panel (the Talk button or the global hotkey) you talk or type about the
project on screen: it shows the same conversation as that project's Chat tab (on Home, the
conversation that is about no one project). Your words show as they are
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

- **Settings** opens on **Basics**: your name and your agent's name, whether Claude and GitHub
  are connected (with **Connect Claude** when Claude is not, and the setup assistant), the
  budget per session of each project, the monthly cap, the default autonomy by name ("Standard:
  routine, reversible actions run; the rest asks you"), quiet hours, and **Sandbox (Docker)**
  (whether full-review tasks can run, the step to take, the sandbox download). Everything else is
  under **Advanced** (collapsed; click it to open): the subscription allowance, which Claude
  credential is used first, appearance and shortcuts, the connection to the background service,
  your paired devices, sources, Opus fast mode, models, **Voice** (installing local voice, CPU or
  GPU, and which voice providers are in force), the desktop allowlist, **Email** (your agent's
  mailbox and mode, on the Email page) and the other settings, each project's autonomy among
  them. Only settings you can change are listed; autonomy is always chosen by its name.
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

Settings → Basics → **Your name** changes how the app and your agent address you.

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
