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
- **Docker:** tasks that get a full review run only in the Docker
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
tasks wait on it' or "Waiting for Docker: 1 task"; "Ready to continue: 3 tasks ready" (without
a Claude key "Ready: 3 tasks. Claude is not connected." with **Connect Claude**, and while
sessions are stopped "Ready: 3 tasks. Sessions are stopped.", the bar at the top having
**Allow sessions again**); "Drafting the plan…" or "Planning failed: Claude did not answer" with **Try again** (without a
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
  session** and "Read aloud"; when something it left for you has moved on since, a line says what
  it is now, such as 'Since then: "Write the README" is done.'); **Next** (the open tasks in the order a session runs them, each
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
  the work writes something it says "Nothing written yet". For a repository project the line on
  top says when the copy was last brought up to date ("As merged on GitHub, updated 14:05."):
  Forerunner does that after every merge, the ones it makes and the ones you make on GitHub
  (within about a minute), with no session needed, and the list follows without a reload. The
  copy is Forerunner's own, under its data folder (it does not link your own working folder):
  keep your own files in its Local only folder, not beside the merged ones.
- **Local only** (on Files, for a repository project): a folder inside this computer's copy,
  "Never uploaded. Agents can read and change it." Put files there that the work may use but
  that must stay out of the repository (notes, data, drafts). An agent reads what its task needs
  from it, and what it reads goes to Claude like the rest of the work: keep passwords and keys
  out of it. **Open folder** beside it opens that folder. Each task's run gets a copy of it in
  its own folder and gives back what it changed or added; a file it deleted stays with you. If
  you change a file there while a run uses it, your version stays and the agent's is kept beside
  it as "notes (from <task title>).txt", and the task's result says so. Forerunner never uploads
  it: a branch that holds any of it is not pushed, and the task says so. A repository that
  already has a folder called "Local only" gets none ("No Local only folder here: …"). If the
  repository starts to have one later (someone commits a file into "Local only" on GitHub), none
  of your files there is lost: they stay on this computer and are never uploaded, a file of yours
  with the same name as one of the repository's is renamed "notes (yours).txt", and Files says
  which. Agents no longer get them then.
- **Plan** (under More): milestones and their dependencies.
- **Tasks**: every task, in the order a session runs them (a task after the tasks it waits for,
  then by priority), with its status in words, who does it, its cost and the critic's call. The
  status says what is going on: **Ready**, **Waiting for "Write the README"**, **Stuck: "X"
  failed**, **Waiting for Docker** (a full review needs Docker, and it is not running), **Running
  (Alice, 2 min)**, **Being reviewed**, **Needs your answer** (its card is in the Inbox),
  **Needs your decision: tried 4 times** (it failed after its tries; its card is in the Inbox,
  and the row offers **Answer**, **Try again** and **Cancel**), **Paused at its budget** (or
  at the limit that stopped it: **Paused at this month's cap**, **Paused at the project's
  budget**) and **Needs your decision: it could not run** (its card in the Inbox says
  why; the row offers **Answer** and **Cancel**, and **Edit** is in the task), **Needs your
  decision** on a task whose review could not finish or found something still open (its card
  offers **Try again**, **Mark done anyway** and **Cancel task**; the row offers **Answer** and
  **Cancel**), **Paused by you**, **Failed: why**, **Done** (or **Done: accepted without
  review**), **Cancelled**. A task is **Done** only
  after the critic reviewed it; the row then says how it was checked: **Reviewed** (the critic
  read the work and the project's files against each point, and the project's own build and
  tests ran when it has them, whatever the language: its package.json scripts, pytest, cargo
  test or go test) or **Reviewed and tried** (the work was also used as you would use it: a page
  it made was opened in a browser, a command line tool it made was run with sample input, for
  example `node wc.js <file>` with a small text file, or a server it made was started and the
  routes its brief names were called; a route the brief says answers 401 or 404, or refuses,
  is expected to). Tools and servers are tried where the task's commands run: in the Docker
  container when Docker is ready (always for a full review), with the network off; otherwise
  on this computer outside a container, where only programs that follow the proxy settings are
  kept off the network, and **See what was checked** says so. A tool is tried only when its
  brief, a criterion or its README says exactly how to run it (in backticks, or in a sentence
  such as "Usage: node wc.js <file>."); otherwise **See what was checked** says it was not
  tried and why. A tool the brief says keeps running (it watches a folder) is stopped after a
  few seconds, and that is no problem. Nothing a try started keeps running after it, also when
  you stop the session while a server is being tried, and the project's tests leave your
  folder as the work left it. If a task changed the project's test, build or lint script, the
  check runs the script as it was before the task, and the changed one beside it. Work whose report still asks you something (for example a
  chart whose data file is missing) is never Done: it waits for your answer with a card in the
  Inbox. A project test that failed or a page that threw an error keeps the task from Done until
  a new run of that test passes or the page opens without the error, whatever the next attempt
  changed; the critic's word alone never clears it. An error on a page that the task's files do
  not run (it only styled the page, say) is not held against the task: **See what was checked**
  shows it as "not caused by this task". When a test failed before the task's change, the
  specialist says so and the task asks you in the Inbox. The rows follow a running session
  by themselves. Each task offers what fits its status, each with a line saying what it does:
  **Make ready** (a draft), **Pause** / **Resume**, **Stop** (a running task: its run stops now
  and it is paused; the session goes on with the rest), **Try again** (a failed task), **Answer**
  (opens its card in the Inbox) or **Go ahead without** (the specialist decides and says what it
  assumed; not offered on a task only you can do), **Redo** (a done task: say what is wrong),
  **Take this work out** (a task whose pull request is merged; see below),
  **Reopen** (a cancelled task) and **Cancel** (it names the tasks that wait on it and will be
  stuck; on a task that is running or being reviewed its run or review stops at once, and what
  it changed is taken out of the project's folder before the next task starts, so nothing builds
  on work you dropped; **Undo** reopens the task and puts its changes back unless the same
  files changed since (a session that goes on often changes them within seconds: then Undo says
  so and the task's next run does the work again), and the answers you gave in the Inbox
  meanwhile stay in the decision record; a task that already has a pull request keeps it open.
  The dialog and the line after Cancel say what happens: a task in review with no review going
  on in the app, because its card waits for you or another computer reviews it, keeps its files,
  its dialog says only "Drops it." and the line only "Cancelled". A Cancel from the first moment
  a task reads **Being reviewed** stops the review at once: the critic makes no further call).
  If you quit Forerunner while a task is **Being reviewed**, it reads **Ready** when you open it
  again, the Inbox's Update names it ("… is ready again"), and the next **Start** runs and
  reviews it. Every action asks for an optional **note for the agent**, which goes into the task's
  next brief (for a cancelled task, once you reopen it), and has one **Undo** right after it
  that puts the task back as it was, its card in the Inbox included; each is listed in
  Changes. Click a task's title to open it: what done looks like and the criteria, what it
  waits for and what waits on it, its runs (who ran each one, with **Open the session**, that
  run's report with **The whole report** when it is long, and the files it changed: click one to
  open it on the Files tab; in a project linked to a repository the files are in the task's pull
  request. A research run lists the web pages it read and those it could not read, and why.
  While the task runs, its last steps show there as they happen ("read index.html", "wrote
  styles.css"). The critic's run is marked as the review; a review that was stopped says so and
  who stopped it), the critic's review in words
  with **See what was checked** (the project's checks with their output, each page tried with
  what it showed and its screenshots, each command run with its sample input and output, each
  server started with the calls and replies, and anything that could not be run or tried, and
  why, for example "the project's Python tests were not run: pytest is not installed where the
  checks run"; the screenshots are kept in Forerunner's data folder under `evidence`, only those
  of the task's latest review: a new review replaces them),
  its pull request, and **Edit**
  (the wording, priority, budget, review level and who does it; for example a full-review task
  waiting for Docker can go to a light review, except a deploy or a data migration, which keeps
  the full review and your sign-off: Edit offers it only the full review levels, and when such
  a task was set below the full review, the form says that saving moves it to the full review;
  a level you leave as it is is saved as it was) and **Change what it waits for** (the project's
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
  task", "skip the LICENSE task" or "cancel …" (it is cancelled, as with Cancel on its row: a run
  or review going on stops and what it changed is removed, or its pull request stays open; the
  read-back says which), "skip … for now" or "pause …" (a pause), "resume …", "try … again",
  "start working now" (the reply links the session it started), "stop" (stops the running
  session now; its task is ready again), "stop after this task",
  "stop everything" (Stop all) and "resume" (allows sessions again), "note: …" for the next
  session, "summary". A change to a task is read back once in one line ('Make "Write the FAQ"
  wait for "Write the README"?') with **Yes** and **No**; the card stays while you type other
  things, and "yes" with nothing waiting asks "Yes to what?" (or, when the card it meant was
  answered in the Inbox or expired, says so). Under each read-back the conversation says what
  became of it: you said yes, you said no, or not answered. You can answer an Inbox card in
  Chat too ("approve the plan"; "try the contact page again", "cancel …" or "mark … done" on a
  task whose card offers **Try again**, **Cancel task** or **Mark done anyway**): Chat reads it
  back in the card's own words ('Approve and start (Plan for "Bakery": 3 tasks)? Writes these 3
  tasks and starts working on them now.') and your **Yes** answers the card; the Inbox, Home
  and the project's header keep that one card, with no second card about it and no
  notification. A card that needs this computer's OK (a task that failed after its retries
  with a serious problem the critic found) is answered on its card: Chat says "Answer it on its
  card in the Inbox: "…" failed 4 times. Nothing else was filed." A move with a note ("try …
  again, note: …") is read back as the move. "start a session" when nothing can
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
…") and what to do. The project's status file (`docs/status.md`) stays in the app: each
session's update is under **Docs**, Status ("kept in the app"), and no pull request is opened
for it. After every merge (in the app or on GitHub) and at the end of each session Forerunner
brings this computer's copy of the repository up to date, so **Docs** and **Files** show what
is merged on GitHub, including what you merged a minute ago. To have it on GitHub instead, turn on **Status pull request** for the project (Settings,
Advanced, Other settings): each session then adds its update to one pull request of its own,
"docs: project status", which you merge when you like; it never goes into a task's reviewed
pull request. Docs that wait in a pull request say so on the Docs tab, with the link; only this
project's docs pull requests are listed, never one another project left on the same
repository.
A task that waits for another whose pull request you have not merged yet starts from that work:
its branch includes it, so a check finds the page it checks. Its own pull request still goes to
the default branch and says so in its first lines ("Builds on #4 (not merged yet): this pull
request includes its changes. Merge #4 first, or use Merge in Forerunner, which merges them in
order."). Merge them in that order: GitHub's **Squash and merge** on either one first would make
the other conflict where the later task changed the earlier one's files. The critic reviews only
what the task itself changed, and its files in the task drawer are its own. If the work it
builds on conflicts (two pull requests change the same lines), it does not start: its card says
which pull requests and files, and you merge them on GitHub, resolving the conflict, then press
**Try again**.

When the work a pull request builds on changes, Forerunner rebuilds that pull request's branch
within a minute or two (at the next look at GitHub), so it never carries work that is gone and
never repeats work that is already in the default branch:

- **#4 merged with a merge commit** (Forerunner's Merge, or GitHub's "Create a merge commit"):
  nothing changes; #8 then shows only its own changes on GitHub, and its "Builds on" line drops #4.
- **#4 merged with Squash or Rebase on GitHub**: #8 is rebuilt on the default branch with only
  its own commits (GitHub shows a force-push on it) and the "Builds on" line goes. Its own change
  is the one the critic accepted, so nothing else changes: it still waits for you, or merges by
  itself where Forerunner merges.
- **#4 closed without merging, or its task redone or cancelled**: #8 is rebuilt without #4. It was
  reviewed with #4's changes, so it no longer merges by itself: one Inbox card says so ("#8 was
  rebuilt without #4, which was closed. It was reviewed with #4's changes, so it waits for you:
  look at it before you merge it, or send it back."). Look at it on GitHub, then merge it
  yourself, or press **Redo** on its task.
- If #8 cannot be rebuilt without #4 (it changes #4's own files), its branch stays as it was and
  one card says so ("#8 could not be rebuilt without #4, which was closed: both change
  src/page.ts. It waits for you: redo the task, or merge it on GitHub only if you want #4's
  changes too.").

**Redo** of a task whose pull request was already merged or closed opens a new pull request from
a new branch (the old name with "-r2"), so a branch GitHub kept after the merge never gets in
the way; the old pull request stays as it was.

**Merging: you press Merge, or Forerunner merges after review.** Each repository project has a
setting **Who merges accepted work** (Settings, Other settings; the Overview's line "Merging: you
press Merge · Change" links there). By default, **You press Merge**: each task's pull request waits
on the Overview under **Waiting for you to merge**, and the task's row on the Tasks tab says
"Accepted · waiting for you to merge". Press **Merge** on a row: the answer comes at once
("Merging #2, #3 and #4 in order."), the rows say "Merging…", and a moment later "Merged #2, #3 and
#4." and the task rows say **Merged**. A pull request that builds on others ("Merges #2 and #3
first.") merges those first, each with a merge commit, so each is marked merged on GitHub. A
pull request whose checks still run says "#4 merges when its checks pass." and merges by itself
once they pass, also after a restart; one that builds on it says "#5 merges after #4, once #4's
checks pass." (its task row: "Accepted · merges after #4") and follows it. When a Merge stops
before everything merged, the line above the rows says so ("#4 and #5 are not merged yet: each row
below says why.") and each row says why. Where Forerunner cannot merge (a rule it cannot meet,
merge commits turned off, what it builds on is not accepted yet), the row says why in one sentence
instead of offering Merge. With **Merge automatically after review**, Forerunner merges each
accepted task's pull request by itself and its row says **Merged**; Settings asks you to confirm
it first and says what it means: the merges show under your own GitHub name, a comment on a
merged pull request starts nothing, and if the repository's main goes online by itself (website
hosting, for example) every accepted task goes live. When main changed after the review and the
repository has no automatic checks, nothing tests the two together, so that pull request waits
for your Merge with one sentence. The autonomy level no longer decides merging (Trusted does not
merge by itself). Forerunner's own docs pull requests merge only when you press Merge, as they
are on GitHub now. If the pull requests cannot be listed, the Overview says why: no GitHub token
(with **Connect GitHub**), a token GitHub refused, or GitHub not answering.

**Open this version** on a row puts that pull request's files in a folder on this computer, so
you can try it before you merge it: the row then says "#7 as it would be merged. Changes here are
not kept." with the folder, **Open folder** and **Copy path**. When main changed since the pull
request was made, the folder holds both, as merging would give them; when the two do not merge
cleanly it holds the pull request's own version and says so. Nothing runs there by itself, your
Local only folder is not in it, and nothing you change there is uploaded or kept: one project has
one such folder at a time (the next Open this version replaces it), and it is removed when the
pull request is merged or closed.

**Take this work out** on a merged task (its row says **Merged**; the button is on the row and
in the task's drawer) opens a pull request "Take out: <task>" that takes that task's changes out
of main: on a branch of its own, so nothing changes in main until you merge it. It undoes the
merge the way it was made: a merge commit, a squash or a rebase you did on GitHub. The dialog,
the answer and the pull request name the finished tasks that built on it ("Add the receipt"
built on it: check it still works once #9 is merged). The task's row then says "Taken out in #9
(waiting for you to merge)", and the pull request waits on the Overview under **Taking work
out**, where **Merge** merges it; the row then says "Taken out in #9". If later work changed the
same lines, nothing is opened: the answer and one Inbox notice say which files, and you undo it
on GitHub by hand or ask in Chat for a task that does it. A merge made in a way Forerunner cannot
undo safely is refused with one sentence ("#4 was merged in a way Forerunner cannot undo safely;
undo it on GitHub."). Closing the take-out pull request on GitHub without merging it offers the
button again.

**How Forerunner merges** (on your Merge, or by itself in the automatic mode). It merges exactly the version
the critic accepted: a commit pushed to the branch afterwards is never merged by Forerunner, and
the pull request waits for you with one Inbox card that says why in one sentence ("#4 changed
after the review: look at the new commits, then merge it yourself or send it back."); **I merged
it** and **Leave it open** close the card. It always makes a merge commit, so a pull
request that carries another's work brings that work to the default branch as it is, and GitHub
marks the other pull request merged too; it never rebases or force-pushes a branch, and when the
default branch moved meanwhile the two are combined by the merge commit. It reads the branch's
rules first and never goes around them, even when your GitHub token is an admin's: a repository
that needs an approving review ("This repository needs an approving review before merging, and
GitHub does not let you approve your own pull request: merge it on GitHub once someone else
approved it."), a code owner, signed commits or a merge queue, or that does not allow merge
commits, is left for you to merge, with one card that says that sentence. A rule that the branch
be up to date brings the default branch into it by merging first. When the checks on GitHub
still run, the merge waits and happens by itself once they pass, also if this computer slept or
the app was closed meanwhile, with no card; after about a day of waiting (the checks still
running, or GitHub not answering) it is left to you with a card that says which. A merge that
waits for you always says why.

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
(**Create the repository** or **Not now**); "Not now" is not asked again. It asks at every
autonomy level, Autopilot too, and so does a "create a repository" the agent decides on in
Chat: nothing is created under your GitHub account without your yes. The offer does not hold
any work, so the project's line does not count it as a question. A public repository always
needs your confirmation on this device.

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
try is one line, and "The writer takes over …" says when another specialist tries it; the lines
after it name that specialist, including "The writer could not do …" when its own try fails too. **Details**
adds the internal steps (the brief, memory, each tool call, each start and finish of a retry, the
notifications sent), each line's event type, the level filters and the raw output; escalations
are highlighted. A session
that has ended
shows **finished**: its log is complete and the
page no longer waits for events. A session stops cleanly when it reaches 80% of its cap (it finishes the
current task and starts nothing new), when its wall clock runs out, or when you stop it.

A start while your agent is in another session waits its turn: waiting starts (yours, an
approved plan's, a CI or pull request trigger) run one after the other in the order they came,
and none replaces another. **Start session** says how many wait before yours. A project with
nothing to run is refused even then: another project's session makes none of its tasks ready,
so its start would only end at once.

**Start** opens a dialog that says what the session will do: "This session runs "Create
index.html" (about CHF 0.12) and continues with up to 6 more as they become ready". The budget
is filled in with the project's default; 0, a negative amount or more than is left of your
monthly cap is refused in words. "Note for this session" goes into the brief of every task the
session runs. When nothing can run, Start is greyed out and the dialog says why in one sentence
with the button that fixes it (Allow sessions again, Open it, Open Tasks, Set up Docker,
Connect Claude). After Start you stay where you were; **Open the session** opens its page.
A task that does not fit is named one of two ways: "needs about CHF 3.00, more than this
session's work budget of CHF 2.40" when it alone is too large, or "(about CHF 1.20) may be left
for next time: the tasks that run first take about CHF 1.50 of this session's work budget of
CHF 2.40" when it only does not fit after them. A task with a budget of its own is counted at
most at what is left of that budget, since its runs never spend more.

**One Start keeps going.** A session works until nothing it can run is left: after each task it
looks again and takes the tasks that just became ready (what they waited for is done), a task
the critic sent back (the next attempt runs in the same session, up to the retry limit; after
the last one you get one card), and tasks you made ready meanwhile. So a chain of seven tasks
is one Start. It stops when nothing more can run, the session's budget is used (a fifth is kept
for reviews; a task whose run the session's budget stopped pauses with one card,
'"Long report" paused at this session's budget of CHF 4.00', and **Continue (CHF 4.00 more)**
starts a session of that amount at once that goes on from where it stopped; see "A budget stop
is a pause" below), you stop it, or its time runs out. A run that fails because Claude did not answer
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

**You hear about each thing once.** A task that needs your answer, failed after its retries or
waits for Docker has its card in the Inbox, and the card's notification is the one you get
about it: the tries inside the session are not announced, and the session's own notification
and its Inbox line say only what the cards do not (for example "did 2 tasks: …"). A session
whose only news is a card sends nothing of its own. When you press **Stop now** yourself, no
notification comes back to tell you; the session page says "Stopped by you". Stop all, Quit
and a session that used up its budget are still announced.

**Full-review tasks wait for Docker.** A task with a full review runs its tests and builds in
the Docker sandbox, isolated from your computer, so the critic sees real results. While the
sandbox is not ready (Docker not installed or not started, Docker Desktop on Windows
containers, or the sandbox not downloaded yet), such a task waits: the session runs your other
tasks, **Start session** and the summary name it under "Waiting for Docker" with the next step,
and the Inbox has one notice saying Docker is needed. Nothing fails and no retry is used. Open
Settings → **Sandbox (Docker)**: it shows the step (install Docker Desktop, start it, switch it
to Linux containers, **Download the sandbox** with its size and progress), and **Check again**
after each one. The task runs in the next session once the card says Ready. A task that an
earlier version marked failed for want of a sandbox goes back to ready by itself then.

A session where nothing was done because its tasks failed, were sent back or wait for you gets a
lower grade from the critic's session review.

**Stopping and crashes.** A session's page has two stops. **Stop after this task** (the usual
one) lets the task in flight finish, starts no other, and ends the session ("Stopped after the
task, as asked"). **Stop now** asks once, then stops the task at once: it goes back to Ready with
"Stopped by you", and what it wrote so far stays in the project's folder. A task the critic was
reviewing goes back to Ready too, and the next session runs and reviews it again. The session reads
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
  needs a full review while Docker is not running, under a task where it runs and why when
  that is worth knowing ("Runs on your API key: only it can read web pages here.", "On your
  subscription its tests will not run: it cannot run commands there."; New task says the same
  when you pick who does it),
  "No specialist here is named ..." beside a task whose specialist this install does not have
  (it would wait for you: change who does it after you approve), the total and what it covers ("About CHF 1.04
  for 2 of the 3 tasks the agent does; the other one has no estimate yet."), and the decision it
  records in one or two sentences, with **The full decision record** one click away. When your
  brief says you will give Forerunner something yourself ("I will give you the real menu, hours
  and address"), the plan starts with a task for you ("Give the real menu, hours and address",
  "you: answer its questions") and the work that uses it waits for your answers instead of
  using placeholders. What your project gives its own people ("we will send subscribers a
  weekly email") is the work, not something you give. **Approve and start** writes the tasks and
  starts working on them now (or, when the work waits for your answers first, says so and puts
  their card in your Inbox: "the work starts once you answer its questions in the Inbox").
  **Change the plan** opens a box: say what to change and the agent drafts a new plan
  for you to approve; it is told the plan you read, so "drop the first task" works. To start
  without the task for you, say so ("drop the task that asks me for content", "I have nothing
  to give, use placeholders"): the new plan has none, and later changes do not bring it back. Your words are kept: if that draft fails, or Forerunner closes before it
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
- **A run that reports it needs your answers** is not retried: its questions are filed at once
  instead of a sign-off, however the report lists them (with or without bullets). The card
  quotes why the specialist asks ("The specialist said: "The email address is a placeholder,
  because the brief gave no real one."").

Type your answers and click **Send answers**; leave a question blank if you have no answer yet.
Your answers are written to the project's decision record (`docs/decisions/0001-…` in the
project's workspace folder) and the decision log. A task planned for you is then
done, and if a task was waiting on it, a session starts and works on that task (the card's Done
line says so); a task a specialist was working on goes back to ready, a session starts, and its
next run gets your answers. On a specialist's questions, **Go ahead without** lets the specialist decide
and say in its report what it assumed; the task goes on in a session, also when you press it while
another task runs. The specialist is not let ask you the same again: if the work cannot be done
at all without your answer (a file that is missing), you get one card that says why in its own
words, where you can answer or cancel the task, without a second **Go ahead without**. A task
planned for you has no specialist to decide in your place, so its card has no Go ahead without:
"go ahead" typed on the phone or said in Chat is refused with "This card needs your answers:
type them, or Cancel task.", and the card and the task wait (if you have no answer, type what
the next task should do instead, for example "use placeholder text"). **Cancel task** cancels it
instead (asked once, naming the tasks that wait on it). You can also answer in your own words
from the phone; one text then answers all the questions.

## Autonomy and budgets

Money is shown in CHF everywhere you read it: cards, the session log, summaries, notifications
and the Inbox. The **review level** of a task says how carefully the critic
checks the work: a **Light review**, a **Full review** (the work runs in the Docker sandbox), or a
**Full review and your sign-off**. Every task gets at least the light review, and the project's
own build and tests run for every code task whatever its level. Settings use the same words:
**Settings → Models** names the critic's rows "light review" and "full review", and the monthly
critic calibration and the handover test (Settings → Advanced) choose a review level by name.

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
lists them in the order Forerunner uses them for tasks, Chat, project setup, reviews and the
model watch. **Move up** and **Move down** change the order; the change is in Changes, where
you can undo it. A task goes to the other credential only when the first cannot do it properly
(see "Where a task runs" below). Each row says:

- how it is used: the subscription always runs **through Claude Code**; an API key always goes
  **straight to the API**, which is where promotional API credits apply (they do not apply to
  use through Claude Code, so Forerunner never sends an API key there);
- whether it can be used now, and why not: this month's allowance is reached, its monthly cap
  is reached, it rests after a usage limit (until the time shown; waiting work starts by itself
  then), Anthropic refused it (**Refused**: save a new one under Accounts and keys), or no key
  is saved;
- what it has spent this month: the subscription as a share of its allowance, an API key in CHF.

When the first one cannot be used, the next one is, for Chat, project setup and reviews. If
Claude says a credential's usage limit is reached, it rests until the time Claude gives (an
hour when it gives none), and the session log says so in one sentence. For tasks, the setting
**When my first choice runs out mid-session** (Settings → Advanced, Other settings) decides:

- **Wait** (the default): nothing moves onto your other credential. The task goes back to
  Ready without counting as a failed attempt, the session ends with "Waits until 15:40 (your
  subscription's limit) and starts by itself.", each task's row reads "Waits until 15:40, your
  subscription's limit", and at that time a session of the project starts by itself, also
  after Forerunner was closed and opened again.
- **Use the other one**: the task goes on at once, in the same session, on your other
  credential ("continues on your API key now"). This moves work from your plan's limits onto
  money, so Forerunner asks you to confirm the change.

If Anthropic refuses your API key or your Claude sign-in (a revoked key, an expired sign-in),
one card says so in the Inbox ("Anthropic refused your API key. Save a new one in Settings."),
Settings shows the credential as **Refused** (Accounts and keys says "Anthropic refused your
API key." with **Save a new key**, never "connected" through it), and Forerunner stops using it.
With **Wait** (the default) your tasks wait for a new one ("Waits for a new Claude sign-in"):
nothing moves onto your other credential, so a refused subscription never turns into API
spend. With **Use the other one** your tasks go on with the other credential, and the card
says so ("Until then your tasks go on with your API key, which costs money."). Chat, project
setup and reviews use your other credential either way. No task fails because of
it, and neither does the plan of a new project: its page says "Planning waits for a new API
key: save one in Settings." instead of "Planning failed", with no Try again. Save a new key
with **Save a new key** on the card or on the project page (the setup assistant): the card
closes, the mark goes, and the waiting work starts by itself: the tasks run, and the plan is
drafted and waits in the Inbox for your approval. At a usage limit a plan waits the same way
("Planning waits until 15:40 (your subscription's limit) and starts by itself.") and is
drafted at that time. Home and the project page say what a project waits for ("Waiting for a
new API key: 2 tasks").

Until you choose an order, tasks use the subscription first and Chat, project setup
and reviews use the API key first.

### Where a task runs

Your order decides, and a task goes to another credential only when the first cannot do it
properly. The two do not do the same things here; Settings → **Claude: which to use first**
ends with a small table, **What each can do here**:

| | API key | Claude subscription |
|---|---|---|
| Read web pages | Yes | Not yet |
| Search the web | Yes | Yes |
| Run commands (its tests) | Yes, in the sandbox | No |
| Ask you while it works | Yes | No: it lists its questions in its report |
| What it costs | Money per use | Your plan's limits, no money per use |

- **Research** (the researcher) needs to read pages and to search. Only the API key does both
  here, so research runs there when one is saved, and the plan card says so ("Runs on your API
  key: only it can read web pages here."). With the API key alone there is nothing to say. If
  your account's administrator has switched web search off, the key reads pages only and the
  table says "No: switched off for this API key" under search (and the plan card "it can read
  web pages here but not search"). The science evaluator reads pages and has no search: with
  only a subscription it is told it has no web access and works from the project's files.
- **A task that needs your answers** (its words say it needs your decision) runs where it can
  ask you while it works: the API key ("Runs on your API key: only it can ask you questions
  while it works here.").
- **Code tasks** stay on your first choice. On a subscription they cannot run commands, so
  their own tests do not run, and on a project whose dependencies must be installed the
  project's own checks cannot run before the review either; the plan card then says "On your
  subscription its tests will not run: it cannot run commands there." The setting **Code tasks
  that need commands** (Settings → Advanced, Other settings) sends them to the API key instead
  ("The API key (runs their tests; costs money)"; Forerunner asks you to confirm).

New task says the same sentence when you pick who does it.

A task's own budget (New task, **Budget**) is what its runs stop at: all its runs together
never spend more. The Tasks tab shows it under the task's cost ("of CHF 4.00 budget"). A task
without a budget stops each run at its specialist's limit, and the Tasks tab says so ("each
run stops at CHF 2.40 (coder limit)"); a done or cancelled task shows no limit. The estimate a
plan shows is only a
forecast. It starts from what that kind of work cost on the real model (a page or a coder
task a few centimes, a test task a little more, a research task that reads web pages about
CHF 0.40), whatever the plan model guessed, and it learns from every task that finishes: after
three tasks of a kind it is within about twice what they really cost. Questions the plan asks
you cost nothing and the plan counts them at CHF 0.00. A task that stopped at its budget does
not count toward what the estimates learn, even after you raise its budget and it finishes,
since its first run did not finish its work; restarting the app changes none of these figures.
Each step of a task reuses what the step before sent (Claude keeps the conversation for five
minutes and charges a tenth of the price for what it already has), so a long task pays the full
price only for what is new; a step that writes a whole file can do so in one go when the task's
budget leaves room. When a task reaches its budget it pauses and the session goes on with the
other tasks. The Inbox gets one card, '"Contact page" paused at its budget of CHF 0.40', with
what its run did and what is left in its own words ("Done: contact.html has the form; left:
check the links.") and two buttons: **Continue (CHF 0.40 more)** (adds that much to its budget,
the same amount again or at least its estimate, and starts a session at once that goes on from
where it stopped) and **Cancel task**. The Tasks tab reads "Paused at its budget" with "Continue
or cancel in the Inbox.", with Answer (the card), Edit (set another budget yourself) and
Cancel.

A budget stop is a pause, not a failure. Before a task's run reaches its budget, the agent is
told once that about a fifth of its budget is left: it starts nothing new, leaves the files
working and ends its report with "Where I stopped:" and "Left to do:". The reserve for that is a
fifth of the run's budget, or the cost of two calls when that is more; the session's log
(Details) says at the start of each run where its wrap-up comes ("This run may spend CHF 0.40:
at CHF 0.32 it is told to wrap up, keeping a reserve of CHF 0.08 to finish."). A budget too small
for even that is "save only": nothing is said to the agent, and the run pauses at its budget; one
smaller than a single step's cost says so and pauses before that step. A run that stopped at a
budget, or that wrapped up with work left, is paused: the critic does not review half-done work,
it does not count as a failed try, and its report stays in the task. A run that wraps up with
nothing left is reviewed as usual. The card and the task name the limit that stopped it: the
task's budget, the specialist's limit, the session's budget, the project's budget, this month's
cap or the share of your Claude subscription Forerunner may use. A stop at the session's budget,
the project's budget, the month's cap or the subscription's share ends the session, and the
session says which ("Stopped at this month's cap" on its page, "Stopped at this month's cap of
CHF 150.00." in its result and the Inbox). At the month's cap, the project's budget or the
subscription's share the card offers no Continue (a bigger task budget would not help): it says
how the task goes on ("It goes on by itself once you raise the monthly cap in Settings, or on 1
December."), links Settings, and the task goes on by itself once you raised that limit (or
removed it) in Settings, or the new month began; until then it stays paused with its card.

**A paused task keeps its work.** Forerunner's own code saves what the run did, whatever the
agent did with the wrap-up: in a project linked to a GitHub repository it is one commit on the
task's own branch on this computer, "Work in progress: Write the guide (paused at its budget)",
with "Where I stopped" and "Left to do" in its message; in a project's folder it is one commit of
its own in that folder, so the next task does not take it in as its starting point. Nothing is
pushed to GitHub unless you turn on the project's **Push unfinished work to GitHub** (Settings,
off by default: a push starts the repository's automatic checks and others see the branch; a
file in Local only is never pushed). The next run of the task continues from that work: in a
repository it starts from the task's branch (with main merged in when it moved; if main changed
the same lines, you get the usual conflict card), and its brief starts with "Where the last run
stopped": the run's note, the files it changed and its to-do list (a run that stopped before it
could write a note says so and lists the files). **Cancel** on a paused task sets its work aside
and names the tasks that will be stuck ("Drops it. Its work so far is set aside unless a later
task built on it; Undo brings it back."); in a project's folder that another task has built on
since, its files stay and the line says why. Undo, or Reopen later, brings the work back, and its
next run continues from it. Cancel of a running task in a project linked to your own folder says
that what it wrote stays in your folder. A task's run never spends more than what
is left of the session's work budget (the fifth kept for reviews stays for them), so a task that
fills a whole session gets about 64% of it for its work. On a Claude subscription a budget stop really stops Claude Code: the run
ends only once Claude Code has exited, and Stop now still ends it at once.

When a task fails twice, the third attempt goes to another specialist that can do the same
work (the coder's to the migration specialist, the tester's to the coder, and so on); the
session log says so. When no other specialist can, the task waits for you instead of running
the same way a third time.

Every task that waits for you has exactly one card in the Inbox. A task that could not run and
asked nothing (no other specialist can take it, a specialist that does not exist, the researcher
on an API key, which gives it no web tools) gets '"Research three garden clubs" could not run'
with why in one or two sentences and two buttons: **Try again** (a session tries again: change
what stopped it first, for example who does it with **Edit** on the Tasks tab) and **Cancel
task**. Nothing waits silently with only a "Resume" that would run into the same stop.

Research works with an API key too. The researcher and the science evaluator read web pages
by their address: public pages only (never this computer or your local network), with a GET
and no passwords or cookies, at most 2 MB per page, and nothing on the project's block list.
On an API key the researcher also **searches the web** with Anthropic's web search: at most ten
searches per task, fewer when the task's money left would not pay for them, at about 1 cent each
plus the results it reads (the task's cost and the session's log include them: "searched the web
for ..."). Searching never eats the reserve a run keeps to finish: the run is told to wrap up at
the same point with or without search (a fifth of its budget left, as the session's log says when
it starts), and close to that point it is offered fewer searches, then none. Search only finds pages: a claim in the research counts as sourced only when its page
was opened and read, so the researcher opens the pages it uses, and the review is told which
search results it saw but never opened (a claim that cites only one of those is not sourced).
The project's block list applies to the search too ("*.example.com" there means example.com and
its subdomains). Search results and pages are information for the researcher, never
instructions: a result whose title reads like instructions is named in the session's log and
told to the review. If your account's administrator has switched web search off, or Anthropic
refuses the project's site list, the research goes on reading pages by address and the session's
log says so once ("Web search is switched off for this API key; research reads pages by
address."); a new API key ends that. An install can turn search off for every project
(`FORERUNNER_WEB_SEARCH=off`). With an API key
saved, research tasks run on it (see "Where a task runs"). With only a Claude subscription, the
researcher can search the web through Claude Code but cannot open the pages itself (Forerunner
refuses its page reading there); the plan card and New task say so, and its brief tells it to
cite the results it used and say what it could not check. The science evaluator has no web
search: on a subscription alone it is told it has no web access. There is no screen for a project's site list or block list yet; a
project that must stay closed can only be closed for the whole install (page reading off, as
said below). The session log
names each page read ("read the web page gohugo.io/about/"), the research file cites each page
by its address, and the critic checks the claims against the pages the researcher actually
got. A page that cannot be read (refused, missing, not a text page) is said in words to the
researcher, who writes it down as not read. An install can turn page reading off
(`FORERUNNER_WEB_FETCH=off`); then project setup plans no web research, and a researcher's task
runs from the project's own files and says so when that is not enough.

Every setting is in **Settings → All settings** with a plain name and its own control: your
default autonomy for new projects, the monthly spending cap, quiet hours (a time range, or off),
where notifications go, reading urgent notifications aloud, the monthly critic calibration, the
model watch's evaluations; and per project the autonomy, the project budget, the budget per
session, the highest model its runs may use, small-project mode, the monthly handover test,
Opus fast mode, speed or quality and, for a project on GitHub, the status pull request. Every
change shows the same change card as in chat and is
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
finished since, a session already read the note, the session a start began has ended), the
change reads **Cannot be undone** and says why instead of offering Undo, and nothing ever says
"Undone" when nothing changed. Each change says **Can be undone**, **Undone**, **Reverted** (a
change for tonight that went back by itself) or **Cannot be undone**; the line an Undo itself
leaves ("Undone: …") has no such badge. "Said:" shows the words you
typed in chat, said aloud or wrote in an email; a click in the app has none.

## Kill switch

**Stop all (1 running)** in the header shows only while a session runs. It asks once ("Stops
every running session now. No session starts until you allow it again."), then stops every
session of your agents on this computer, revokes the run tokens and freezes claims within two
seconds; the tray does the same. On a shared project the other people's sessions keep running,
and the tasks they hold stay theirs. A bar then says **Sessions are stopped** until you press
**Allow sessions again** (lets sessions start again) or **Continue where it stopped** (allows
them and starts a session again on the projects Stop all stopped, if they still have work that
can run; other projects are left alone, and so is a session you stopped or undid yourself); the tray, "resume" in
Chat or a start from the phone allow them too. The stop lasts across restarts until then. A
session's own page has **Stop after this task** and **Stop now** (see "Sessions"); they end that
session only and leave the rest running. Starting a session while sessions are stopped says
so, with **Allow sessions again**.

The command palette opens with **Ctrl+K** (**⌘K** on a Mac) and has **Start session** for the
active project.

## Links

In the desktop app, a link that leaves Forerunner (a pull request, "Get Docker Desktop", a page
named in a task) opens in your browser, also when you hold Ctrl or Shift while clicking. The
app's own links stay in its one window: a Ctrl-click or Shift-click on one (Inbox, a project)
works like a plain click and shows that page in the same window. **Open folder** opens a
project's folder in your file manager; nothing in the app opens or runs a file.

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
