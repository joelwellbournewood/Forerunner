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
works, a bar under the header says what runs, on every page (see "Seeing what runs").
Without a Claude key a bar says "Claude is not connected: planning and tasks need it. You can
still add tasks." with **Connect** (not on the setup page Connect opens).

Home shows, top to bottom:

- **Needs you**: every card waiting for you in any project, one line each with **Answer**
  (it opens that card in the Inbox), or the card's own button when there is nothing to answer
  (a refused key's **Save a new key**).
- **Working now**: who works on what in which project, for how long, with **Open**.
- **Projects**: one row each, with the project's status in one sentence, "3 of 7 done", and
  the one button that fits: **Answer**, **Open running session**, **Continue** (starts a
  session that works until nothing more can run), **Set up Docker** or **Open Tasks**.

The sentence says, first match first: "Waiting for you: approve the plan" or "Waiting for you:
2 questions"; 'The coder works on "Style the page" (3 of 7 done)', in the words of the bar at the
top; 'Stuck: "Style the page" failed; 2
tasks wait on it' or "Waiting for Docker: 1 task"; "Ready to continue: 3 tasks ready" (without
a Claude key "Ready: 3 tasks. Claude is not connected." with **Connect Claude**, and while
sessions are stopped "Ready: 3 tasks. Sessions are stopped.", the bar at the top having
**Allow sessions again**); "Drafting the plan…" or "Planning failed: Claude did not answer" with **Try again** (without a
Claude key: "Planning failed: Claude is not connected" with **Connect Claude**), or "You
rejected the plan. Nothing was written." with **Draft a new plan**; "Done: all 7 tasks. Your
files: <folder>". On a repository, done work whose pull request is not merged yet is named:
"Done: all 3 tasks. 1 pull request waits for you to merge, and 2 need you on the Overview." with
**Open Overview** (a pull request that waits for a commit in its task's folder, was closed,
could not be rebuilt or has a failed check needs you there, and is never said to wait to be
merged). The project's page has the reason in full. Home and the project pages follow
the work as it happens: no reload needed.

**New project** asks for a name, a goal, a short brief and a repository link; the agent drafts a
plan for you to approve. The project starts at your default autonomy (Settings → Basics; each
project's own autonomy is under Settings → Advanced, by name) and becomes the active project.
Changes lists the creation once ("Created the project … and made it the active project."); its
**Undo** removes the project and makes the project you had before the active one again. "Go
back" in chat returns to the project you were on before New project. After the Undo the name is
free for a new project, the project's open cards leave the Inbox, and Changes shows its rows as
"… (removed)", without Undo. A removed project starts nothing, by itself or by a press: its page
(from an old notification or a bookmark) says "This project was removed." with no Start session,
a start asked for anyway is refused with 'The project "…" was removed, so nothing of it runs.',
work that waited for a Claude credential or a monthly handover of it no longer starts, and a
plan still being drafted when you pressed Undo is never filed. While a session of the project
runs, its Undo waits: Changes says "Cannot be undone now: a session of … is running. Stop it
first."
The goal is optional when you write a brief: left empty, the brief's first sentence is the goal.
Without a repository link, a brief of a sentence or two (under 200 characters, no list) gets a
small plan: one milestone of one to three tasks and two short documents (if the agent plans
more, Forerunner asks it once more for a smaller plan). Its tasks are reviewed like any other:
the critic checks each one after the agent has done it. A longer brief or a list of features
gets a full plan.

**One repository is one project.** A GitHub repository or a folder belongs to one project: every
spelling of a repository counts as the same one (`https://github.com/o/site.git`, `o/site`,
`git@github.com:o/site`), and a folder inside a linked folder counts as that folder. New project
on a repository another project uses makes nothing and says so: 'o/site is already the project
"Site". Open it, or add this to it as new work.' with **Open it**, **Add to it** (when you wrote
a brief or a goal) and **Cancel**. **Add to it** sends your brief to Site's planner, which plans
only the work that is not already in the project (no second set of documents) and files the plan
in the Inbox as for any brief; its card says what the new tasks cost and nothing about documents,
since approving it writes tasks only. The same holds when you ask in chat or by voice ("make a project
for o/site": chat answers the sentence and offers Site), for Sources and for the Data tab's
GitHub import. A link on another git host is refused: 'Forerunner works with repositories on
github.com, not gitlab.com. Link a GitHub repository or a folder.'

**Working with someone on one repository.** When the repository already is a Forerunner project
on another computer (a colleague's, or your own earlier install), New project says so, for
example 'o/kite is already the Forerunner project "Kite club", which is not on this computer;
last active on GitHub on 3 Nov. Work on it together, or take it over if nobody works on it any
more.' **Work together** makes "Kite club" here as the same project: nothing on GitHub changes,
each of you keeps your own tasks and merges your own pull requests, this computer never touches
the other Forerunner's pull requests, and each Forerunner keeps its own comment on the project's
pinned status issue on GitHub (below, "The status issue").
Its Overview says 'Shared on GitHub with another Forerunner: each keeps its own tasks.'
**Take it over** is for a project nobody works on any more: the repository then names your
project (its next docs pull request replaces the other project's marker and says so in one line;
the other project's pull requests stay as they are). It is offered only when no other GitHub
account updated one of that project's pull requests in the last 14 days; otherwise the offer says
'another GitHub account worked on it on 8 Nov. One repository is one project, so work on it
together here.' If GitHub cannot be read when you create the project, the project is made, and
its Overview tells you later if the repository turns out to be another Forerunner's.

A project made before this version (or while GitHub could not be read) whose repository names a
Forerunner project on another computer shows one line on its Overview: 'o/kite is also the
Forerunner project "Kite club", which is not on this computer.' with **Take it over** (or, when
another GitHub account worked on it within 14 days, the day it did and no button). The press
takes it over at once; Changes lists 'Took over o/kite from "Kite club".' with **Undo** until
the docs pull request that names your project is on GitHub: while it is open the row says
'Cannot be undone now: its pull request on GitHub already names this project. Close it there
first.', and once it is merged 'Cannot be undone now: the repository already names this project
on GitHub.' In chat,
"take over o/kite" is read back with Yes and No first; an agent never takes a repository over by
itself. When the docs pull request that names your project could not be opened (GitHub
refused it, or this computer's copy could not be made), the take-over says so: 'Took over
o/kite from "Kite club" here, but the docs pull request that names this project could not be
opened, so GitHub still names "Kite club".' The project's Overview and Docs tab say the same,
also when the project was made with Take it over, until the default branch on GitHub names your
project. Forerunner does not try that pull request again by itself: the line ends once a pull
request that puts your project in `.forerunner/project.json` is merged, or when you Undo the
take-over on Changes (for a project made with Take it over, the Undo of its New project). The docs
pull request always starts from the default branch: when GitHub still has an old
`fr/docs-scaffold` branch that is not your project's (a closed pull request's, another project's
or a person's), Forerunner leaves it as it is and opens its pull request on
`fr/docs-scaffold-<your project's name>`; it replaces only a branch of your own project's. If you
take a repository over while your project's own docs pull request is open, that pull request is
rebuilt on the default branch with the new marker (your edits on it kept) and gets the take-over
line as a comment. After the **Undo** of a project you made with Take it over, New project on that
repository offers Work together and Take it over again. A project you work on together never writes docs:
a doc it does not have reads 'The other Forerunner of "Kite club" writes this doc on GitHub;
this project does not write docs.' on the Docs tab, with no "missing" mark.

**When two projects use one repository.** Projects made before one repository was one project
(or two folders inside each other) can share a repository. The Overview of each says so, for
example '"Site" and "Kite club" both work in o/site.', with **Make one project** and the line
"You choose which to keep; the other's tasks, plan and cards move into it." Both keep working
until you choose; nothing is stopped or held. The dialog shows each project's tasks, open pull
requests, what it spent, its budgets, who merges and what research may read, and you pick
**Keep "Site"** (or the other). It says what moves ('The tasks, plan, cards and pull requests
of "Kite club" move into "Site".') and what stays ('"Kite club" keeps its sessions, changes and
spending to read; no budget changes.'), and which setting applies to the moved work. **Make one
project** moves everything in one step: Changes lists 'Made one project: "Kite club" joined
"Site".' with **Undo** ('"Kite club" is its own project again.'). Open pull requests of the
moved tasks keep working: Merge and the reviews go on from "Site".

A project that joined another is closed: its page says 'Joined into "Site" on 9 Nov.' with
**Open it**, and nothing starts from it. It takes no new work: its Tasks tab has no New task
and says 'Its tasks are in "Site".' with **Open it**, its Chat is kept to read ('This chat is
kept to read; ask about its work in the Chat of "Site".'), and so is Talk on its pages (the same
line with **Open it**, no message box and no Talk button; the hotkey and the palette's Talk
start no voice turn there), and its Overview has no note for a next session. A task, a note or a change asked for it anyway is answered '"Kite club" joined
"Site", so its work runs there.' and nothing is written. "Site"'s Overview says 'Includes the work of "Kite
club".', its Sessions tab '"Kite club" had 3 sessions before it joined.' with Open, and its
Costs tab 'Spent in "Kite club" before it joined: CHF 3.20'. Chat answers about "Site" with
what "Kite club" did before it joined. In chat, "make Site and Kite club one project, keep
Site" is read back with Yes and No first; chat never chooses the project to keep for you.

**When a project here is another Forerunner's project on GitHub.** A project made before the
one-repository rule (or while GitHub did not answer) can use a repository that is already
another person's Forerunner project. Its Overview says so ('o/kite is also the Forerunner
project "Kite club", which is not on this computer.') and offers **Work together** first, with
'This project's tasks, plan and cards move into "Kite club"; both Forerunners work on it.' The
dialog reads GitHub again and says what the press does ('"Site" becomes "Kite club", the project
GitHub knows: its tasks, plan and cards move into it, and this Forerunner works on it together
with the other one.') and its one write on GitHub: 'On GitHub only the old status pull request
#4 of "Site" is closed, with one line saying why; nothing of the other Forerunner is
touched.' (or 'Nothing on GitHub changes now.'). **Work together** moves everything in one step; Changes has its **Undo** ('"Site"
is its own project again.'), also after Forerunner starts again. When GitHub does not answer,
the dialog and the press say 'GitHub did not answer, so the project cannot be checked. Try
again.' and nothing moves. In chat, "work on o/kite together" is read back first: 'Work on "Kite
club" together: this Forerunner joins it as the same project. Nothing on GitHub changes now.'
with Yes and No. When your project's guide could not be updated on GitHub because every branch
it may write its docs on holds someone else's pull request, the Overview says so in one line:
'The repository guide on GitHub was not updated: every branch this project may write its docs on
holds someone else's pull request.'

**Add to it** (New project on a repository a project here uses) lands on that project at once;
its page says 'Drafting the plan from your brief…' until the plan waits in your Inbox. A new
brief for it meanwhile is answered 'A plan for "Site" is being drafted; answer it once it waits
in your Inbox.' If you quit Forerunner before the plan is drafted, the page says 'Planning
failed: Forerunner closed before the plan from your brief was drafted.' when you open it again;
**Try again** drafts it from the same brief. A plan that failed or waited for Claude is drafted
again from the brief you gave with Add to it, not from the project's first brief.

A new task you ask for in chat in your own words is added at once, with Undo; one whose title or
description the chat wrote itself is read back first ('Add "Write the FAQ" to Help?').

Making one project waits while something of either project is under way, and says what to do
first: 'A session is working on "Kite club". Make one project when it ends.', 'The plan of
"Kite club" waits for your answer. Answer it first.', 'A pull request of "Kite club" is being
merged. Try again in a minute.', 'A session of "Kite club" waits to go on at 15:40. Make one
project after it ran, or cancel it first.' Undo waits the same way while a session works on the
kept project, while a moved pull request is being merged, or when a task depends on one that
came from the other project ('"Shop page" waits for "Cart", which came from "Kite club":
change that first').

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
Home, except a start: **Start session** beside it is the page's one start button).
**Start session** reads **Open running session** while a session works on it. The tabs
are **Overview**, **Tasks**, **Chat** and **Files**; **More** holds **Sessions**, **Plan**,
**Docs**, **Reviews**, **Costs** and **Data**. A tab keeps the Tasks tab's filters, so you find
them as you left them; an open file or task stays on its own tab.

- **Overview**: where the project stands and what happens next. The cards of this project that
  wait for you, each with **Answer**; **Working now** (the task in flight, for how long, with
  **Open**); **Last result** (the last session's result in at most three lines, with **Open the
  session** and "Read aloud", and **All 3 sessions** once the project has had two or more; when
  something it left for you has moved on since, a line says what it is now, such as 'Since then:
  "Write the README" is done.'); **Next** (the open tasks in the order a session runs them, each
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
  Overview) as a list with sizes and when each file changed. A project without a repository
  keeps its folder's history in git: `git log` there shows 'Workspace before "<task>"' before
  each run and, at the end of each session, 'Did "<task>"' with "Committed by Forerunner at the
  end of the session started 2026-11-15 12:09 UTC.", never an id.
  Click a file to read it here (text files; nothing can be changed from this tab). **Open
  folder** (desktop app) opens it in your file manager; **Copy path** copies where it is. Until
  the work writes something it says "Nothing written yet". For a repository project the line on
  top says when the copy was last brought up to date ("As merged on GitHub, updated 14:05."):
  Forerunner does that after every merge, the ones it makes and the ones you make on GitHub
  (within about a minute), with no session needed, and the list follows without a reload. The
  copy is Forerunner's own, under its data folder (it does not link your own working folder):
  keep your own files in its Local only folder, not beside the merged ones. If you changed a
  file in the copy that a merge changes too, or left a file where a merge brings one, Forerunner
  never overwrites it: the copy stops following and the line says so and why ("This computer's
  copy of o/r has not followed merges since 14:05. You changed README.md in this copy, and a merge
  changed it too: move your change out of the way and the copy follows again."). A file an editor
  saved with Windows line endings (CRLF) counts as your own change, even when its text looks the
  same. Move your change away and the copy follows again within about a minute, as it does after
  a merge.
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
  budget**), **Needs your sign-off** (a deploy or a migration the critic accepted waits for
  your OK: its card offers **Accept the work**, **Send it back** and **Cancel task**; the row
  offers **Answer** and **Cancel**) and **Needs your decision: it could not run** (its card in the Inbox says
  why; the row offers **Answer** and **Cancel**, and **Edit** is in the task), **Needs your
  decision** on a task whose review could not finish or found something still open (its card
  offers **Try again**, **Mark done anyway** and **Cancel task**; the row offers **Answer** and
  **Cancel**), **Paused by you**, **Failed: why**, **Done** (or **Done: accepted without
  review**), **Cancelled**. A task is **Done** only
  after the critic reviewed it; the row then says how it was checked: **Reviewed** (the critic
  read the work and the project's files against each point, and the project's own build and
  tests ran when it has them, whatever the language: its package.json scripts, pytest, cargo
  test or go test, and `node --test` for JavaScript test files that no package.json test script
  runs, such as a `wc.test.js` written with Node's own test module) or **Reviewed and tried** (the work was also used as you would use it: a page
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
  and it is paused; the session goes on with the rest, and if nothing else ran its result says
  'You paused "X"; nothing else ran.' with no Inbox line about your own click), **Try again** (a failed task), **Answer**
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
  next brief once (for a cancelled task, once you reopen it); with the field left empty the
  agent is told nothing (the button you pressed is not passed on as your words). Two tasks with
  the same title are named apart in Chat by what tells them apart: "Write the guide #17", "Write
  the guide (the paused one)" or "(the older one)"; a word Chat gave you keeps working after the
  task is paused or gets its pull request. Every action has one **Undo** right after it
  that puts the task back as it was, its card in the Inbox included; each is listed in
  Changes. Click a task's title to open it: what done looks like and the criteria, what it
  waits for and what waits on it, its runs (who ran each one, with **Open the session**, that
  run's report with **The whole report** when it is long, and the files it changed: click one to
  open it on the Files tab; in a project linked to a repository the files are in the task's pull
  request. A research run lists the web pages it read and those it could not read, and why.
  While the task runs, its last steps show there as they happen ("read index.html", "wrote
  styles.css"), and the run's amount follows what it spends, as the row's cost does. The critic's run is marked as the review; a review that was stopped says so and
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
  task that already waits on it). The line after it says when the task runs ('"Write the FAQ"
  now waits for "Write the README". It runs after it is done, at your next Start.'); when it
  waits for nothing any more it runs at your next Start, or joins the session that is running if
  it fits. In Chat: "make the FAQ wait for the README", "let the FAQ run on its own". **New task** asks the title, what done looks like, what it
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
  task that is done has nothing open). A finding the critic named no fix for shows what it found
  and no "To fix" line, here, in the task's drawer and on the cards. The critic's evidence is
  under **Details**; its check of each session's summary is folded under **Session checks**. The "review" link in a task's
  drawer opens its review highlighted.
- **Costs** (under More): spend by model, specialist and task, in CHF, with the savings from
  caching and context compression (a kind that saved nothing is not listed, and a project that
  saved nothing shows no savings).
- **Data** (under More): files and datasets the project knows about; agents see metadata and
  samples, never whole files.
- **Chat**: ask about this project and change it in words. It knows the conversation so far,
  every task with its status (what it waits for, why it failed), the last session's result, what
  runs now, the cards waiting for you and where the files are, and it can look up a task's runs
  and review. Ask "what is going on?", "what failed and why?", "what is left?". Tell it what to
  change: "add a task: …" (a ready task, with **Undo**; "add a task to Site: …" adds it to Site
  from any project's Chat, and after "switch to Site", "add a task there: …" does too; with no
  project named yet and several projects Chat asks "Which project: Notes or Site?" with a button
  for each, and the one you press gets the task; other words before a colon stay the task's own:
  "add a task to fix the login: users cannot sign in"), "make the FAQ task depend on the README
  task", "skip the LICENSE task" or "cancel …" (it is cancelled, as with Cancel on its row: a run
  or review going on stops and what it changed is removed, or its pull request stays open on
  GitHub, named with what to do: "#43 stays open on GitHub: close it there if you do not want it.";
  the read-back says which; the Overview then lists that pull request under "Cancelled, still open
  on GitHub" with **Open** and no Merge until you close it on GitHub, and Chat names it too), "skip … for now" or "pause …" (a pause), "resume …", "try … again",
  "start working now" (the reply links the session it started), "stop" (stops the running
  session now; its task is ready again), "stop after this task",
  "stop everything" (Stop all) and "resume" (allows sessions again), "note: …" for the next
  session, "summary". "open Site" opens Site's Chat from any project's Chat; "switch to Site"
  makes Site the active project and, said in Notes' Chat, keeps you in Notes' Chat with one line,
  "Switched the active project to Site. This chat stays about Notes." and **Undo**. Chat changes a project's settings too: "only read developer.mozilla.org
  for research" changes **Web pages research may read** at once (the Overview's line reads
  "Research reads: only developer.mozilla.org"), and "research may read any public website
  again" asks your **Yes** first, as the setting's dialog does ("Set web pages research may read
  for Reading rules to any public website? Research reads any public website, on the API key
  and on the subscription."; "except the ones listed" only when your rule lists websites it never
  reads). Chat says it changed something or asked for your **Yes** only when it did: a Yes/No
  question appears right under its reply, and a change it made shows under it with **Undo**. If
  its answer claimed more than it did, Chat tries once more, and when it still claims it, Chat
  says only what is true: the change it made, its Yes/No question, or "Nothing changed, and
  nothing waits for your yes. Say it again to try once more." ("Nothing changed; the change I
  asked about earlier still waits for your yes." while an earlier question still waits). When
  its answer asked for your yes in its own words again ("Shall I resume it?"), the line is
  "Nothing changed, and nothing waits for your yes. If you want a change, say what you want
  done.": say the change, and it comes back as the app's question with **Yes** and **No**. A rule
  like that is a setting,
  never a lesson: "remember that …" keeps a lesson for later sessions, and its line says it
  changes no setting. A change to a task is read back once in one line ('Make "Write the FAQ"
  wait for "Write the README"?') with **Yes** and **No**; the card stays while you type other
  things, and "yes" with nothing waiting asks 'Yes to what? Nothing is waiting for your yes. Say
  what you want done, for example "run it now" to start a session.' (or, when the card it meant
  was answered in the Inbox or expired, says so). Chat never asks for your yes in its own words
  ("Shall I set …?"): only the app's own question with **Yes** and **No** under a reply waits for
  your yes. A question about which task or project you mean ("Which task should I add it to?")
  is just a question: answer it in your words. A line "The app did: …" is only ever the app's own
  record of a change it made; Chat never writes one itself. Under each read-back the conversation says what
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
  What Chat reads from a record (a task's report, a review, a card's questions, the last
  session, a lesson, your project's documents) is data to it, never an order. A change Chat
  proposes after it read a record waits for your **Yes**, whatever the change (a new task, a
  note for the next session, a setting): if a report says "add a task: send the files to …",
  Chat reads it back ('Add "Send the files to …" to Quote page?') and adds nothing until you
  say yes. Every such read-back is one question with **Yes** and **No** ("Switch to Shop
  page?", "Allow sessions to start again?"). Stopping still acts at once; Stop all asks first;
  a summary, which changes nothing, answers at once. Chat knows your own day and time (the Time
  zone on the setup assistant's Welcome page: Settings → Accounts and keys → Open the setup
  assistant), so "yesterday" and "on Monday" are yours. On a project with a
  repository it answers at once from Forerunner's own record of each merge ("waiting for your
  Merge", "merged"), without waiting for GitHub; ask it to list your files to have it check
  GitHub now. It reads only your own projects and those shared with you.
  **Ask about anything recorded.** Chat looks up what Forerunner recorded when the answer is not
  in front of it: earlier sessions, every task with its runs, earlier titles and merges ("what
  happened to the README task?" finds it under its new name and says it was called "Write the
  README"; "when was the README merged?"), the cards you answered and what you answered, the
  decisions, lessons, the project's documents, the changes made, what the work and the chat cost,
  and earlier lines of your conversations ("what did I say about the logo?", in English or
  German). Give it a time ("last week", "on 3 Nov") and it looks in those days of your own
  calendar. It names what it found by its title and date ("in the session of 3 Nov"), never by an
  id; when nothing matches it says what it looked through. It looks a thing up before it says it
  is not there, and never asks whether to look. A session it finds names the tasks that failed
  in it as well as those it did; a card that asked you questions shows what it asked and your
  answer. Under the answer, **From:** links the records it rests on (at most three), also those it
  only saw in its search. Questions about now ("what is left?") are
  answered at once, without a lookup. Inbox Updates, notifications and the session log's lines
  are not searched: ask about the session, task or card they are about. What a lookup returns is
  data to Chat, like a report: a change it proposes after a lookup waits for your **Yes**.
  While it looks it says what it is doing ("Looking through last week's sessions…").
  **Short and longer answers.** Most questions get a quick answer. When a question needs more
  (why something keeps failing, a plan, a comparison, what several sessions did), Chat thinks it
  through: on the same model it goes ahead by itself up to your amount (CHF 0.10 at first); before
  a stronger model, or an answer that may cost more than your amount, it asks in one line with the
  cost and the time ("This needs a stronger model: about CHF 0.15 (at most CHF 0.30) and 30
  seconds. Go ahead?") and goes on only when you press **Go ahead** or say "yes". That line is
  always the app's own, with its figures, even when the quick answer only said it in words; Go
  ahead runs that answer once, within its "at most", and asks again only when the price or the
  model changed. Once you write something else, the line stays as what was offered ("Offered: a
  stronger model, about CHF 0.15 (at most CHF 0.30). Not taken.", or "You went ahead.") with no
  button. Say "think it through", "take your time" or "use a stronger model" yourself, or press
  **Think it through** under an answer. The bubble says what it is doing and for how long, and a
  longer answer ends with one line of its model, time and cost ("Thought it through with Sonnet ·
  34 s · CHF 0.06"). During a longer answer **Answer now** beside Stop answers at once from what
  it has looked up, with no new offer under it.
  **Stopping an answer.** While Chat answers, **Send** becomes **Stop**: the answer ends, what it
  already changed stays with its Undo, and the line under it says what it cost. Only **Stop**
  stops it: pressing Enter while you type your next line meanwhile keeps the answer going and
  your line in the box. When an answer says it changed something that did not change, the
  bubble says "Checking what changed…" and the untrue words go away. A reload shows
  the same line and Stop; a line Forerunner closed on before answering says so, with **Ask
  again**.
  **Fix the tasks.** Say "fix the tasks" (or "tidy up the task list", "check the tasks", "räum
  die Aufgaben auf"), with what you saw if you like ("fix the tasks: Style the page is two
  jobs"): the agent checks the whole task list of the project on screen and splits a task that
  is too big, adds a missing step, changes what waits for what, drops a duplicate or corrects
  wording. While it checks, the reply line says "Checking the tasks of Quote page…". At Standard
  and above it makes the changes at once and lists each with its own **Undo** ("I changed 3 tasks
  of Quote page."); at Advisor and Assisted, when a change touches a task you added yourself, or
  after the agent looked something up in that turn, it asks once with **Yes** and **No** ("Make
  these 3 changes to the tasks of Quote page? …"), naming what each change does ('change "Publish
  the page": priority to High'). The line under the reply says what the check
  cost in CHF, booked to the project. Nothing starts a session. It says so instead when it cannot
  run: "Fixing the tasks needs Claude: connect it in Settings, Basics.", "Fixing the tasks would pass this project's budget;
  nothing changed.", "The agent is checking the tasks of Quote page now; ask again in a moment."
  or, when your rule for Claude waits, "Fixing the tasks waits for Claude: your subscription is at
  its limit until 15:40. Nothing changed." In Talk with no project on screen it asks which
  project first. Changes you name yourself in one line ("make Publish wait for Style and raise
  its priority") are read back as one question.

**A project linked to a GitHub repository**: each task works on a branch of its own and opens a
pull request when it is done; Forerunner makes the commits, pushes and opens the pull request
(the agents are told so), and the session page lists each pull request with its branch. A
repository just created on GitHub, with nothing in it, gets a first commit from Forerunner on its
default branch (the project's docs, or a README), so its tasks have something to start from; if
that cannot be done, the task says so ("… is empty and Forerunner could not make its first commit
…") and what to do. The project's status file (`docs/status.md`) stays in the app: each
session's update is under **Docs**, Status, named by when the session started ("Session started
2026-11-15 05:46 UTC") with how it ended and what it spent ("Done. Spent CHF 0.09."); on GitHub
the status is the project's pinned status issue (below), never with what it cost. After every merge (in the app or on GitHub) and at the end of each session Forerunner
brings this computer's copy of the repository up to date, so **Docs** and **Files** show what
is merged on GitHub, including what you merged a minute ago. Docs that wait in a pull request say so on the Docs tab, with the link; only this
project's docs pull requests are listed, never one another project left on the same
repository. Two projects on one repository share that status branch: while one project's
status pull request is open, the other project never adds to it, comments on it or lists it,
and keeps its own status under **Docs** in the app (Docs shows it there, as with the setting
off); once that pull request is merged or closed, its next session opens its own.
The same goes for the pull request of the standard docs.
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
  itself where Forerunner merges. A **Merge** you press on #8 a moment after merging #4 there,
  before Forerunner's next look, does the rebuild first and answers "Merging #8." as usual.
- **#4 closed without merging, or its task redone or cancelled**: #8 is rebuilt without #4. It was
  reviewed with #4's changes, so it no longer merges by itself: one Inbox card says so ("#8 was
  rebuilt without #4, which was closed. It was reviewed with #4's changes, so it waits for you:
  look at it, then merge it or redo the task."). Look at it on GitHub, then merge it
  yourself, or press **Redo** on its task. The card's Details say the same: "Look at #8 on GitHub:
  it no longer holds the changes of #4", "Then press Merge here, or Redo to do the task again from
  main". This happens also when you press **Merge** on #8 a moment after closing #4, before
  Forerunner's next look at GitHub: the press checks #8 first and answers with that sentence at
  once; nothing is merged, and #4's closed work never reaches the default branch through #8. Once
  #8 (or any pull request a card is about) is merged, by you on GitHub or with Merge in the app,
  its cards close by themselves; under Answered they read "Closed: #8 was merged.".
- If #8 cannot be rebuilt without #4 (it changes #4's own files), its branch stays as it was and
  one card says so ("#8 could not be rebuilt without #4, which was closed: both change
  src/page.ts. It waits for you: redo the task, or merge it on GitHub only if you want #4's
  changes too.").
- While #8's task folder is busy (a run, a merge under way, a change nobody committed), its
  rebuild waits and is tried again at every check (about a minute), also after Forerunner
  restarts; until it ran, nothing merges #8, not even your Merge (the row waits). When what
  holds it is a change nobody committed in the task's folder, the row says so: "#8 waits for
  changes left in its task's folder: take them out or redo the task." (its task row: "Accepted ·
  merge waits for you"). Take them out (move a file you want to keep somewhere else, put a
  changed file back as it was): the rebuild runs at the next check and the row then says what
  came of it (rebuilt without a closed pull request, it waits for your Merge again). Or press
  **Redo**: the task is done again without them, reviewed again, and waits for your Merge. The
  row says this at the check that finds them, before you press Merge, and shows the folder with
  **Open folder**; Merge pressed then is kept: once the folder is clean and #8 is rebuilt, it
  merges, unless the rebuild dropped work its review read (then the row says so and waits for you). If you commit in that
  folder, Forerunner never drops your commit: the rebuild waits and the row says "#8 waits for
  a commit made in its task's folder: push it to GitHub or undo it." Push it (the next check
  rebuilds #8 with your commit, and #8 waits for your look, since the review did not read it:
  the row says "#8 changed after the review: look at the new commits, then merge it yourself or
  redo the task." and offers no Merge, and a Merge you pressed while it waited is dropped, with
  a card that says so) or undo it in the folder (`git reset --hard origin/<branch>`). The same
  holds for any commit pushed to #8's branch on GitHub: a rebuild never makes it reviewed. A
  **Redo** or a **Try again** never drops a commit you made in a task's folder either, also for
  a task whose last run failed before it opened a pull request: when the next run of that task
  would start its branch again (from GitHub's copy, or from main), it stops before any work and
  costs nothing; the task's row says "Needs your decision: it could not run" and its Inbox card
  says why: "Its task folder has a commit that is not on GitHub: push it or undo it, then press
  Try again." (when the task starts again from main: "…, and doing the task again from main would
  drop it: undo it or keep it on another branch, then press Try again."). The session goes on
  with its other tasks. Do what the card says (to keep the commit on another branch: `git branch
  my-copy` in the folder), then press **Try again** on the card. In a chain
  (#8 builds on #6, which builds on #4), #8 follows #6 once #6 is rebuilt; while #6 cannot be
  rebuilt yet (its folder is busy, or its rebuild conflicts), #8 waits for it too, with no card
  of its own, and nothing merges #8 meanwhile.

**A pull request that no longer merges cleanly.** When another merge changes the same lines as a
task's open pull request, Forerunner says so once: the Overview row shows "#8 conflicts with main
in index.html: resolve the conflict on GitHub, or redo the task." instead of Merge, the task's row
on the Tasks tab says "Accepted · conflicts with main" (the same sentence in its drawer), and one
Inbox card ('"Add the page" conflicts with main') offers **Redo** (the task is done again from
main) and **Leave it open**. Redo does the task again from main (its next run starts the branch afresh, and
the same pull request gets the new work); the critic reviews it, and you then press Merge as usual.
**Redo** on the task's row in the Tasks tab does the same to the card (it closes, and the next
session does the task again from main), but starts no session by itself; its line says so
('Reopened "Add the page" to redo it from main: the next session works on it again. Its card in
the Inbox was withdrawn.'), and its **Undo** puts the task back to done and the card back in the
Inbox, as it was. Once the task is done
again and its pull request merges cleanly, a notice still open from before closes too.
If the conflict goes away without a change to the pull request (the other change is taken out of
main again), the row and its card say again what they said before (a rebuild's warning, for
example) and offer Merge again; a card filed only for the conflict closes. If you resolve it on GitHub with a
commit of your own, that commit is not what the critic reviewed: the row then says "#8 changed
after the review: look at the new commits, then merge it yourself on GitHub, or redo the task from its row in Tasks." and offers no
Merge, and the card says the same; merge it on GitHub, or press **Redo**.

**A conflict the agent cannot resolve while it works.** Its card offers **I resolved it**, **Drop
the branch and retry from scratch** and **Cancel the task**. If you resolve it in the task's
folder the card names, you may answer **I resolved it** before git's last step (the rebase's
continue, or the merge's commit): Forerunner finishes that step with your resolution and opens or
updates the pull request. A file that still holds conflict markers brings the card back, with
your rebase or merge left as it was. A resolution that keeps only main's side leaves nothing to
merge: the task fails ("#8 no longer changes anything on main, so it was closed.") and #8 is
closed with its branch kept, instead of going to review empty. **I resolved it** and **Drop the
branch and retry from scratch** each start a session for the task (or queue one behind the
session that runs), and the card's Done line says so; **Cancel the task** starts nothing.

**Redo** of a task whose pull request was already merged or closed opens a new pull request from
a new branch (the old name with "-r2"), so a branch GitHub kept after the merge never gets in
the way; the old pull request stays as it was. **Redo** on a rebuild's card (either card above)
does the task again from the default branch: its next run starts the branch afresh from there
(as "Drop the branch and retry from scratch" does), and #8 gets the new work, with only the
task's own commit on top of the default branch. If that redo pauses before its review (a budget,
a question), its next run continues the work done since the redo, never the old branch. If that
redo changes nothing (the default
branch already has what the task asks for), the task fails as any task with no change does
("Failed: The redo from main changed nothing, so #8 was closed.", with **Try again**, **Mark
done anyway** and **Cancel task** on its card): #8 is closed on GitHub with a comment saying why,
its branch is kept, and nothing empty is offered for Merge. The same holds for any redo or
rework whose change the default branch already has by the time it is pushed (someone made the
same change there): "Failed: #8 no longer changes anything on main, so it was closed."; press
**Mark done anyway** if that is what you wanted.

**Merging: you press Merge, or Forerunner merges after review.** Each repository project has a
setting **Who merges accepted work** (Settings, Other settings; the Overview's line "Merging: you
press Merge · Change" links there). By default, **You press Merge**: each task's pull request waits
on the Overview under **Waiting for you to merge**, and the task's row on the Tasks tab says
"Accepted · waiting for you to merge". Press **Merge** on a row: the answer comes at once
("Merging #2, #3 and #4 in order."), the rows say "Merging…", and a moment later "Merged #2, #3 and
#4." and the task rows say **Merged**. A pull request that builds on others ("Merges #2 and #3
first.") merges those first, each with a merge commit, so each is marked merged on GitHub. A
pull request whose checks still run says "#4 merges when its checks pass." and merges by itself
once they pass, also after a restart (the Inbox's Updates then say 'Merged #4: "Add the page".'
and a notification tells you); one that builds on it says "#5 merges after #4, once #4's
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
out**, where **Merge** merges it; the row then says "Taken out in #9". While #9 is open the row
offers no **Redo**, and asking for one in Chat says to merge or close #9 first; once #9 is merged
or closed, **Redo** is offered again. If later work changed the
same lines, nothing is opened: the answer and one Inbox notice ("<task>" could not be taken out,
with the files and what to do; **Got it** closes it) say which files, and you undo it on GitHub by
hand or ask in Chat for a task that does it. A merge made in a way Forerunner cannot undo safely is
refused with one sentence ("#4 was merged in a way Forerunner cannot undo safely; undo it on
GitHub."). A pull request of one commit looks the same squash-merged or rebase-merged, so the
take-out says only that it was merged. Merging or closing the take-out pull request on GitHub is
seen within about a minute; closing it without merging offers the button again.

**How Forerunner merges** (on your Merge, or by itself in the automatic mode). It merges exactly the version
the critic accepted: a commit pushed to the branch afterwards is never merged by Forerunner, and
the pull request waits for you with one Inbox card that says why in one sentence ("#4 changed
after the review: look at the new commits, then merge it yourself on GitHub, or redo the task from its row in Tasks.", under the title '"X" changed after the review'); **I merged
it** and **Leave it open** close the card. A Merge you press on such a pull request answers that
sentence at once (never "Merging #4." first), and a card whose pull request is then merged on
GitHub closes by itself. It always makes a merge commit, so a pull
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
it; from then on tasks work on branches with pull requests. Closing the dialog without **Yes**
(× or Escape) answers its card **No**, so nothing is left waiting in the Inbox. "create a
repository" in Chat does
the same. When a session plans code work for such a project, your agent asks in the Inbox
(**Create the repository** or **Not now**); "Not now" is not asked again. It asks at every
autonomy level, Autopilot too, and so does a "create a repository" the agent decides on in
Chat: nothing is created under your GitHub account without your yes. The offer does not hold
any work, so the project's line does not count it as a question. A public repository always
needs your confirmation on this device. There is one card per repository, whichever way you
ask first: while a card for it waits in the Inbox (from Chat, the agent, or a **Preview** on the
project page you closed), no second one is filed, and once the project has a repository every
card still asking for one closes ("Closed: it no longer needs you.").

**Note for the next session** on the Overview is one box: type what the agent should know
and **Save note**; "note: ...", "correction: ..." or "idea: ..." in Chat adds one too. A note
reaches the brief of the task it names, by the task's title ("Add the login page: reuse the
session cookie"), or of every task when it names none ("Write in British English"). The session
log says which task got which ('Gave 1 note to "Add the login page".'). Notes waiting for the next session are listed under the box with
**Dismiss**. The first-session plan you approve with a new project's setup decides the first
session: it runs those tasks, in that order, and later sessions go by priority. Its Details say
the session's size once, as its promise ("It promised 3 tasks, about CHF 0.34."), after the line
that says how they were chosen ("Plan: the first session you approved with the project plan, in
its order.").

When you give a brief, Forerunner drafts a plan from it and puts it in the Inbox for your
approval (see "Inbox" below: Approve and start, Change the plan, Reject). Above the project's
tabs you see where it stands: "Drafting the plan from your brief…" (it usually takes about a minute), "Waiting for you: approve
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
after it name that specialist, including "The writer could not do …" when its own try fails too.
When a report or a review showed that the task list needs a fix, the log says the check once
('Checked the task list after "Create the page": no change (CHF 0.03).', or the changes it made,
each with its Undo on the Changes page, or "suggested 2 changes in the Inbox"; see Autonomy and
budgets). **Details**
adds the internal steps in words (the brief, memory, each tool call, each start and finish of a
retry, the notifications sent) and the level filters; escalations are highlighted. Under it,
**Show the raw events** adds each line's event type and the raw data the app records, for a bug
report. A step that was refused says what and why: "was not allowed to write
/tmp/players-readme.json (outside the project's folder)". The page's title says when the session began ("Quote page · session at
14:05"); every time on it is written in 24 hours, the log's too. While it runs, a badge says
how the page follows it: **Live**, or **Updates every 5 s** when live updates do not work in
this window. A session that has ended shows its status only: its log is complete and the page
no longer waits for events. A session stops cleanly when it reaches 80% of its cap (it finishes the
current task and starts nothing new), when its wall clock runs out, or when you stop it.

A start while your agent is in another session waits its turn: waiting starts (yours, an
approved plan's, a CI or pull request trigger) run one after the other in the order they came,
and none replaces another. **Start session** says how many wait before yours. A project with
nothing to run is refused even then: another project's session makes none of its tasks ready,
so its start would only end at once.

**Start** opens a dialog that says what the session will do: "This session runs "Create
index.html" (about CHF 0.12) and continues with up to 6 more as they become ready", or, with
tasks that are ready now, "... and 2 more (about CHF 0.40)". The budget
is filled in with the project's default; 0, a negative amount or more than is left of your
monthly cap is refused in words. "Note for this session" goes into the brief of every task the
session runs. When nothing can run, Start is greyed out and the dialog says why in one sentence
with the button that fixes it (Allow sessions again, Open it, Open Tasks, Set up Docker,
Connect Claude); a task that waits on one that failed or was cancelled is named with it
('"Write the guide" waits on "Draft the outline", which failed, so it cannot run.'). After Start
you stay where you were; the dialog says it started, with **Open the session** and **Close**
(to start another session, open it again). A task that does not fit after the tasks ordered
before it is named "(about CHF 1.20) may be left for next time: the tasks that run first take
about CHF 1.50 of this session's work budget of CHF 2.40"; several such tasks are one line,
naming up to three and then how many more. A task with a budget of its own is counted at most at
what is left of that budget, since its runs never spend more.

**A task larger than one session still runs.** When a ready task needs more than the session's
work budget on its own, Start stays on and the dialog warns in an amber note: '"Build the shop"
needs about CHF 6.00, more than this session's work budget of CHF 4.00: it works until that
budget is used, keeps its work, and asks you to continue.' It runs in its turn like any task:
by priority, then the plan's order. With tasks before it, the plan line reads 'This session runs
"A" (about CHF 0.12), then works on "Build the shop" with what is left.' and the warning says
'after "A" it works with about CHF 2.80'; first in order it reads 'This session works on "Build
the shop" until its work budget is used; "B" runs after it only if budget is left.', and the note
adds '"B" comes after it: it runs if "Build the shop" leaves budget, else in your next session.'
The session's log says the take once ('Took "Build the shop", larger than this session's work
budget, with about CHF 2.80 left.'). It works until that budget is used, keeps its work and
pauses with one card in the Inbox; the tasks after it run in the same session with what it
leaves of the work budget (if it fails at once they run too), and a task too big for what is left
waits, the result saying '"B" (about CHF 0.30) waits for your next session: "Build the shop" left
CHF 0.04 of this one.' A larger task the tasks before it leave less than a
fifth of the work budget for waits for the next session. **Your next Start goes on with it**: a
task that paused at a session's budget is taken in its turn by the next session you start, from
where it stopped, and its card closes ("Your session of 14:05 went on with it."); the card's
**Continue** is for going on at once. While its coder still gets further, a task that pauses at
the coder's limit per run goes on at once in the same session ('The coder goes on with "Build
the shop" from where it stopped.'). The plan card
says it under the task before you approve ("More than a session's work budget (CHF 4.00): it
pauses with its work kept and asks you to continue."), and "start a session" in the chat reads
the same warning back with its question. A task that goes on from work it kept is counted at what
is left of its estimate ('"Build the shop" needs about CHF 2.00 more (CHF 4.00 spent so far)'); a
task you redo or try again starts over and is counted at its whole estimate.

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
lower grade from the critic's session review. When its work only waits for you, the review's
line under Details says so ("Session review: the work waits for your answers (grade 70, 2
findings)."): answer the card in the Inbox and the work goes on. A session review sends nothing
back: when it notes something, such as the planned tasks costing more than their estimate, its
line says what it noted, and under **More ▾ → Reviews → Session checks** it reads "noted" (or
"accepted", "needs you"), its findings "noted", with no "To fix" line: there is nothing for you
to fix there. A planned task that the session split, or dropped as the same as
another, counts as replaced, not as planned work left undone ("Session review measured: 1 of 1
planned task done, 1 replaced; …"); once the first part of a split task has run, it counts as it
ran, done, failed or waiting for you.

**Every session of a project** is listed under **More ▾ → Sessions** (also **All 3 sessions** on
the Overview's Last result, and **All sessions** on every session page). The heading is the
count ("14 sessions"); the Costs tab has the totals. A session working now sits on top with what
it does ('Working on "Style the page" (3 of 7 done)') and what it has cost so far. Below it, one
row per session, newest first: what it did in one sentence ('Did 2 tasks: "Create index.html" and
"Style the page".', '"Long report" paused at its budget of CHF 0.40.', "Nothing finished."), then
when it started, how long it worked, its task counts ("1 done, 1 failed"; "2 needed you" with
"1 still needs you" while one of them still waits), how it ended ("Done",
"Stopped by you", "Interrupted: Forerunner closed") and what it cost, with the credential that
paid ("CHF 0.80 on your API key", "CHF 0.80 of your Claude subscription's allowance"); a session
you did not start says how it started ("started on its schedule"). Every session you started is
listed, also one that stopped at once to wait for Claude before anything ran ("Nothing finished."
· "Stopped to wait for a Claude credential"), and the session that goes on with it later says so
("goes on with your session of 09:00"). A session that started by itself and found nothing to do
is not listed. Drafting the plan from your
brief is a row too ("Drafted a plan of 5 tasks; you approved it.", or "Planning failed: …" with
the words the project page showed). A session Forerunner closed during counts only the time it
worked, not the time Forerunner was closed. **Show older sessions** shows 20 more; the rows you
see stay on the list while a session starts or ends, with the new one at the top. A row opens the
session's page. When chat about the project cost anything, one line under the list says so
("Chat about this project: CHF 0.30.") with **Open Chat**. A session's amount is the same on its
row, its page and the Overview, read from the cost ledger when you look: a later rate or a cost
booked after the session ended moves all three together; a message already sent keeps the amount
it said then.

A session's page lists **Tasks in this session**: each task it worked on, what happened to it
there ("Done", "Failed", "Paused at its budget of CHF 0.40", or "Paused before its budget of CHF
0.40 ran out" when it stopped to wrap up first), what it is now when that changed
("now: Done") and what this session spent on it; while a task runs, its amount follows the
session's spend within a second. A title opens the task with its runs. A session
that ended to wait for a Claude credential reads "Stopped to wait for a Claude credential", and
one that ended with a plan for you to approve "Ended with a plan for you to approve", which stay
true once the credential is back or the plan approved. Drafting the plan has a page of its own,
"Quote page · planning at 14:05", reading "Drafting the plan", "Plan drafted" or "Planning
failed".

**Stopping and crashes.** A session's page has two stops. **Stop after this task** (the usual
one) lets the task in flight finish, starts no other, and ends the session ("Stopped after the
task, as asked"). **Stop now** asks once, then stops the task at once: it goes back to Ready with
"Stopped by you", and what it wrote so far stays in the project's folder. A step Stop now cuts
off is still billed for what Claude had read by then; that amount is counted once and the same
everywhere: on the task, the session, Costs and what is left this month. A task the critic was
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
line in the Inbox ('Your last session was interrupted when Forerunner closed. "X" is ready
again.') with **Continue** ("Opens Start with the rest of your last session and the CHF 4.20 left
of its budget."): it opens the Start dialog, whose Start goes on with that session and what is left
of its budget, never more; Continue is offered while one of its tasks is still ready, no
session of the project runs and none began since (once one did, it went on with the work, and the
line keeps only Mark read); pressing it marks the line read. The next Start works at once too. Its page still says what it finished and what it
spent before Forerunner closed ("Interrupted: Forerunner closed: 1 done. CHF 0.01."), with the same
amount in "Spent of this session's budget", and the Overview shows it as the last session. Stop on a session that nothing runs any more
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
lately and what came of it, true when you read it: once the task is done its line says so
('Answers saved in the decision record; "Add the phone number" is done.'), and names what waits on
the task only while something still does. If your
answers came after their task had already finished, the entry says so and offers **Redo with
these answers**: the task opens again and its next attempt reads them.

The cards you meet most:

- **The plan** from a new project's brief: the tasks in order, who does each, about what each
  costs ("cost not known" where the plan has no estimate), "Needs Docker" beside a task that
  needs a full review while Docker is not running, under a task where it runs and why when
  that is worth knowing ("Runs on your API key: only it can ask you questions while it works
  here.", "On your subscription this task's tests will not run: commands cannot run there."; New task says the same
  when you pick who does it),
  "No specialist here is named ..." beside a task whose specialist this install does not have
  (it would wait for you: change who does it after you approve), the total and what it covers ("About CHF 1.04
  for 2 of the 3 tasks the agent does; the other one has no estimate yet."), and the decision it
  records in one or two sentences, with **The full decision record** one click away. When your
  brief says you will give Forerunner something yourself ("I will give you the real menu, hours
  and address"), the plan starts with a task for you ("Give the real menu, hours and address",
  "you: answer its questions") and the work that uses it waits for your answers instead of
  using placeholders. What your project gives its own people ("we will send subscribers a
  weekly email") is the work, not something you give. Each task's "about CHF ..." is what the
  Start dialog will say for it: once Forerunner has seen what tasks of that kind really cost,
  both use what it learned. **Approve and start** writes the tasks and
  starts working on them now (or, when the work waits for your answers first, says so and puts
  their card in your Inbox: "the work starts once you answer its questions in the Inbox").
  While it writes them the card says so ("Writing the plan…", and on a repository "Writing the
  plan and its docs pull request…", which takes a few seconds).
  **Change the plan** opens a box: say what to change and the agent drafts a new plan
  for you to approve; it is told the plan you read, so "drop the first task" works. To start
  without the task for you, say so ("drop the task that asks me for content", "I have nothing
  to give, use placeholders"): the new plan has none, and later changes do not bring it back. Your words are kept: if that draft fails, or Forerunner closes before it
  is done, **Try again** on the project page drafts it with them, and a second change on the
  new plan adds to the first. **Reject** writes nothing; the project page then says "You
  rejected the plan. Nothing was written." with **Draft a new plan**.
- **A task that failed**: after its tries (the critic sent it back each time) or when its run
  failed ("Claude did not answer"), one card, never one per try. **Try again** makes it ready to
  try again; type a note first if you know what to change, and the next attempt reads it.
  **Mark done anyway** closes it although nothing passed review (asked once; the task then reads
  "Done: accepted without review") and the tasks after it can run. **Cancel task** drops it and
  says which tasks after it will be stuck.
- **The critic's sign-off** on a task that needs your review: **Accept the work**, **Send it
  back** (it is ready again and the next run reworks it with the critic's findings), **Cancel
  task**.
- **Questions** for you or from a specialist: see "When Forerunner needs you" below.

Answering never starts a session: only you do (Start, Approve and start, Continue, Use API key,
"run it now" in chat after you said yes, a schedule you set). An answer that makes a task ready
joins the session that is running if that session's budget has room for it; otherwise it waits
for your next Start, and the card's Done line says which ("Trying "Write the FAQ" again: it runs
at your next Start."). The option itself says so before you press it, as things stand when you
look: "Tries again with your note, if any; it joins the running session if it fits." while a
session of the project runs, "...; it runs at your next Start." when none does, and "...; a
session starts for it by itself." with the setting below on. If you want work you make ready to start by itself, turn on **When work is
ready: Start a session by itself** for the project in Settings (it asks you once; never in your
quiet hours or while sessions are stopped, and never for work the agent made ready itself). CI
results and pull request comments never start a session; the next session you start reads them.
Answered decisions go to the decision log and are not asked again unless something changes. If an answer cannot be taken (the card changed on another
device), the card stays and says "Choose one of: …" with its options.

## When Forerunner needs you

Some work only you can do: choose the stack, the hosting, the repository or the domain, name an
account, settle a preference. Forerunner never hands that to a specialist, which cannot ask you.
It asks you in the Inbox instead, on a card that names the task and the project and lists the
questions, each with its own answer field. A question reads as plain text, without the marks a
specialist may write (backticks, stars).

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
done, and a task that was waiting on it is ready: it runs at your next Start, or joins the
session that is running if it fits (the card's Done line says which); a task a specialist was
working on goes back to ready and its next run gets your answers. On a specialist's questions,
**Go ahead without** lets the specialist decide and say in its report what it assumed; the task is
ready again in the same way. Beside **Send answers** and **Go ahead without** a line says what
pressing it does now: "The task goes on with your answers; it runs at your next Start.", "...; it
joins the running session if it fits." while a session of the project runs, or "...; a session
starts for it by itself." when the project's "Start a session by itself" is on; on a task planned
for you it reads "Saves your answers in the decision record and closes the task." The specialist is not let ask you the same again: if the work cannot be done
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

**The agent keeps its task list right during a session.** When a specialist ends its report with
lines "For the task list:" (this task is two jobs, a step is missing, a task must wait for
another, two tasks are the same), or the critic notes a problem the task did not cause, the
session checks its task list once before the next task (a small planning call, counted in the
session's spend). From Standard up it fixes what the evidence shows, within the project's goal:
it splits a task, adds a missing step, changes what a task waits for or drops a duplicate that
never ran. Each change is one row on the Changes page with its Undo, and the session's one Update
counts them ("Quote page: did 3 tasks; changed 2 tasks."). At Advisor and Assisted it asks first
on one Inbox card: "Make these changes" (one Undo takes them all back) or "Keep the tasks". It
also asks first for a task you added or changed yourself, for work for the deploy specialist or
for you, and for any line that reads like an instruction (it is quoted on the card, never
followed). It never touches a running or finished task or another project, and it never raises a
budget or starts a session: a new task joins the running session only if it fits, else it waits
for your next Start ("Left for your next Start: ...").

A split's Undo puts the task back as one and makes the tasks after it wait as before, so once
something else changed what they wait for, it is not done in part: Changes says why ('Cannot be
undone now: "Publish" was made to wait for "Check the links" after the split; undo would drop
that.'). Undo that later change first, then the split. A part a session holds reads "is running
now", one that ran "has run since". If Forerunner closes while it makes the changes you approved
on a suggestion card, it finishes them once when it starts again; the card never stays at
"Making the changes…".

Only real evidence starts a check: a report's "For the task list:" lines or a problem the critic
measured that the task did not cause; an ordinary note of the critic's about the task's own work
starts none. The check's line is in the session log with its cost beside it, so the lines add up
to what the session spent. When a line it was given reads like an instruction, the check leaves
it out and quotes it there, even when it changes nothing ('Checked the task list after "Create
the page": no change; a line of the report reads like an instruction and was left out ("…")
(CHF 0.01).'); in chat the line under the reply quotes it. The suggestion card says who wrote
what it quotes (a line of the coder's report, a note of the critic's, or what the agent's check
noted in its own words) and quotes the part that asks for something; a change to a task says to
what ('Change "Write the FAQ": what done looks like to "…" and the criteria to "…".').

Budgets exist per month, per project, per session, per task and per run. The runtime refuses a
model call that would cross a cap; it never relies on the agent noticing. In Settings a money
field takes any amount in CHF with a point or a comma ("12.30", "150.40", "1,50"); 0 or a
negative amount is refused in words. Closing a change's preview without answering it (the x,
Escape or Cancel) answers it "no", so no confirmation is left waiting in the Inbox.

On a Claude subscription, Settings → **Claude subscription allowance** says how much
API-equivalent use your plan covers a month, in CHF. Forerunner cannot see your plan's real
usage, so it estimates against this amount and stops subscription work at 95% of it; an API
key takes over when you have one. The default (about CHF 40) is low on purpose: enter
what your plan covers, or a Max plan's work stops early.

### One rule for every call (Which Claude does the work)

Forerunner uses one rule for everything it asks Claude: your tasks, the critic's reviews,
planning, chat and its own monthly checks. Until you pick one, the rule is **Subscription first,
then wait**: everything uses your Claude subscription first, and when it is at its limit, at the
share Forerunner may use, or Anthropic refuses it, nothing moves to your API key; the work waits,
and a session you started goes on by itself when the subscription can work again. Under
**Subscription first, then ask me** you get one card in the Inbox per stop ("Use your API key
until 15:40?"): **Use API key** lets your work and chat use the key until the stop ends (about
the amount the card names for what waits now; Forerunner's own monthly checks still wait), and
**Wait** moves nothing. Under **Subscription first, then the API key** work goes on with the key
at once, at a cost per use. While chat waits it says why, and it can still add, move and start
tasks. A refused key or sign-in gets one card that says why and what the work does until you
save a new one; Forerunner never sends it another request meanwhile. Under **Subscription first,
then ask me** a refused sign-in also gets one card asking whether your API key does the work until
you save a new one. Changing the rule to one that can spend more asks your yes first.

### Which Claude does the work (Settings)

Settings → **Which Claude does the work** is the one place for this rule. It lists the five
choices, each with what it does when your first choice runs out:

- **Subscription first, then wait** (used until you choose): your subscription does everything it
  can here; when it runs out, nothing moves to your API key and the work waits for it.
- **Subscription first, ask before API key**: when your subscription runs out, one card asks: go
  on with your API key at its cost, or wait.
- **Subscription first, then API key**: your API key takes over at once, and you are told the cost.
- **API key first, then subscription** and **API key only**: your API key does the work, at a cost
  per use; when it runs out, your subscription takes over, or the work waits.

Under the choices each saved credential has its row: what it does under your choice ("Does the
work", "Takes over when your subscription runs out") and its state now ("Works now", "At its limit
until 15:40", "Share used until Tue 1 Dec" with **Change the allowance**, "Refused: save a new
sign-in" with its link). A choice that can spend more reads back what it does and asks you to tap
**Change** first; one that spends less is set at once. Both are in Changes with an Undo. While you
said yes to your API key for a stop, the section says so ("Your work and chat use your API key
until 15:40: you said yes.") with **Stop using it**. What each credential can do here (read web
pages, search, run commands) is under Advanced.

### When Claude runs out

The Start dialog says what happens if your first choice runs out while the session works. When it
is already out and your choice waits or asks, it offers **Use API key** (the session runs on the
key until the stop ends, about the cost it names; no session budget is raised) and **Start at
15:40** (nothing moves before; the session starts then), the one your choice leans to first.
**Start at 15:40** is your answer for this stop: the Inbox does not ask you about your API key
again until then. **Use API key** is offered only when the start would run something; with
nothing ready, or with Stop all on, the dialog says why and offers neither. When
your own session already waits to go on, the dialog says "Your session of 14:05 goes on by itself
at 15:40." and **Use API key** lets it go on now. The plan card in the Inbox says the same once at
its foot. Under "Subscription first, then API key", or once you said yes to your API key for this
stop, each task's line on the card names the key that does it meanwhile, never a wait. In
Settings, **Stop using it** ends your yes: what already runs on your API key finishes, and new
work waits for your subscription. If a task's own budget may leave too little for its review, the
dialog names that task before you start; its review then waits for Continue.

With your subscription at its limit and your choice "ask before API key", the work waits for your
answer on one card in the Inbox ("Use your API key until 15:40?"); the bar at the top of every
page says so with **Answer**, and the card names what the waiting work costs on the key ("about
CHF 0.40"). If your choice moves work onto the key by itself, you get one notification for that
stop with its cost.

Every time on the screens is in your time zone (the one in Settings), the same as the app's
sentences ("Waits until 11:40"), whatever zone this computer is set to.

If Anthropic refused your key or sign-in, the Start dialog says "Nothing can run until you save a
new API key in Settings." and offers no Start; every Start says the same and starts nothing:
Continue, the phone, chat's "start a session" and a Start sent to Forerunner's service, whether
or not a session of yours waits to go on (a waiting session says it goes on once you save a new
one). A Start from the phone that meets this lifts no Stop all; while Stop all is on, the other
Starts say that first, as the dialog does.

Under "Subscription first, then ask me", while your subscription is out and your API key could
run, the project's line says "Ready: 2 tasks; your subscription is at its limit until 02:51;
Start asks first"; the plan card's tasks say "Approve and start asks before your API key is
used.". After **Start at 04:28** the Start dialog says "Starts at 04:28 (your subscription's
limit)." with **Cancel the wait**.

When your subscription has used its share for the month, **Start on 1 Dec** keeps your start for
the month's start: no session runs before, and one starts then by itself. **Change the allowance**
is beside the wait on the run bar, the project's status line and the session page.

Under "API key first, then subscription" with your key at its limit, the Start dialog says so and
that the session runs on your subscription ("Your API key is at its limit until 11:57, so this
runs on your subscription (about CHF 0.07)."), and **Start** runs it there. Work that only your
API key can do here (code tasks whose commands you set to the API key, a task that needs your
answers while it works) waits for the key instead: the dialog then says only "Nothing can run
until 11:57 (your API key's limit). Press Start at 11:57 and the work starts then.", and New
task and the plan card say the same wait.

The card, the Start dialog's **Use API key** and the plan card's last line give one figure for
the same waiting work: the tasks that wait, the ones that follow them, and the critic's reviews of
each, never more than the session's work budget. The dialog still names the tasks it runs above
the stop. Your yes lets the waiting work go on; other ready work joins a session that runs only
if it fits its budget, as anything you make ready does.

A waiting task's row says why and until when: "Waits until 15:40 (your subscription's limit)",
"Waits until Tue 1 Dec (your subscription's share)" with **Change the allowance**, "Waits for your
answer: use your API key?" with **Answer**. The project's status line says it once ("Waiting for
you: use your API key?"). A task only one of your credentials can do here says so: "Waits for your
API key: only it can read web pages here.", with what holds the key and when it is back under it;
the status line and the bar at the top say the same.

Reaching the share of your subscription that Forerunner may use in the middle of a task is
running out too, and your choice decides what happens, as for a usage limit: the work goes on
with your API key from where it stopped, one card asks you first, or the work waits until the
1st of the month (a session you started then goes on by itself). The task keeps what it did and
is not counted as a failed try. If you raise Settings → **Claude subscription allowance** above
what was used, the stop ends at once, and the saved line says what happens now ("Your
subscription's allowance is raised: your session of 14:05 goes on now.", or "... 2 tasks are
ready again for your next Start.").

When work moves onto your API key (your choice, or your yes), the session log says it once:
'"Style the page" goes on with your API key from where it stopped: your subscription is at its
limit until 15:40.' (after your yes: '..., and you said yes.'); later tasks of the same stop are
in Details, and "Your Claude subscription can work again; the next tasks use it." when it serves
again. Under the session's spend: "On your API key since 14:20 (your subscription's limit): CHF
0.42 so far."; once it ended: "Your API key took over at 14:20 (your subscription's limit): CHF
0.42 of CHF 0.62.". The task's drawer reads "On your API key after your subscription's limit · CHF
0.43" on that run, and Costs has **By credential** ("Your API key: CHF 1.20", "Your Claude
subscription: CHF 2.10 (estimate, 12% of its allowance)"; a few calls under a centime read "less
than CHF 0.01").

While chat waits for your subscription it says so and offers **Use API key** for that one question
("Answers this question on your API key: about CHF 0.02."); the press answers that question once,
on the key, in its place (it shows once, with the answer under it), and the answer's note says
so. It gives no standing yes: the next question waits again.

An expired or signed-out Claude sign-in is read as a refusal however Claude Code reports it:
the task is never marked Failed for it, chat does not ask the refused sign-in again, and Costs
lists no model for the refused call.

While the only credential that may answer is refused, chat says so and what to do ("Anthropic
refused your API key, so I have not answered. Save a new key in Settings; until then I can still
add and change tasks."), and "start a session" gets the Start dialog's sentence ("Nothing can run
until you save a new API key in Settings.") instead of a question it could not keep, also when
the session you started met the refusal and waits to go on. When an
answer fails for another reason, chat says so in one sentence with **Ask again** ("Claude did not
answer this time; ask again in a moment."); a failed answer never shows "Answered with ..." or
**Think it through**, and a call you stop is counted on the credential that made it.

If Anthropic refuses your API key or your Claude sign-in (a revoked key, an expired sign-in),
one card says so in the Inbox ("Anthropic refused your API key. Save a new one in Settings."),
Settings shows the credential as **Refused** (Accounts and keys says "Anthropic refused your
API key." with **Save a new key**, never "connected" through it), and Forerunner stops using it.
Under **Subscription first, then wait** (used until you choose) your tasks wait for a new one
("Waits for a new Claude sign-in"): nothing moves onto your other credential, so a refused
subscription never turns into API spend. Under **Subscription first, then API key** your tasks go
on with the other credential, and the card says so. When a new one is saved the card closes with
what became of the waiting work ("A new one is saved; the work that waited for it goes on.", or
"A new key is saved." when nothing waited). Chat, project
setup and reviews use your other credential either way. No task fails because of
it, and neither does the plan of a new project: its page says "Planning waits for a new API
key: save one in Settings." instead of "Planning failed", with no Try again. Save a new key
with **Save a new key** on the card or on the project page (the setup assistant, open on its
Claude step: "Anthropic refused the saved API key. Paste a new one below."): the card
closes, the mark goes, your session that waited for it goes on by itself (other waiting work
runs at your next Start), and the plan is drafted and waits in the Inbox for your approval. At a usage limit a plan waits the same way
("Planning waits until 15:40 (your subscription's limit) and starts by itself.") and is
drafted at that time. Home and the project page say what a project waits for ("Waiting for a
new API key: 2 tasks"), and so does the Start dialog ("Nothing can run until you save a new API
key in Settings.", with **Save a new key**) instead of what a session would run.
When a task is paused at the project's budget, this month's cap or your subscription's share
and nothing else can run, the Start dialog says that limit and what changes it ("Nothing can run:
"Write the motto" paused at the project's budget of CHF 0.06; raise it in Settings." with **Open
Settings**), never "needs your answer", and no "Give your agent work first" (your work is there;
only the limit holds it); a task that waits on one you paused says "... which you
paused." with **Open Tasks**. The list under it says what each waiting task waits on the same
way: '"Write the rules" waits on "Write the motto", paused at the project's budget of CHF 0.06,
so it cannot run. Raise the project's budget in Settings, or change what it waits for on the
Tasks tab.', or '..., which you paused, so it cannot run. Resume "Write the song", or ...'; only
a task whose card in the Inbox asks something "needs your answer". While a session runs, chat's
read-back of making a task ready says
what that session does with it ("It is larger than this session's budget, so it runs at your
next Start." for one above its whole budget). The status note in the project's folder says the
money as the result does ("Spent less than CHF 0.01.").
Opening the Start dialog changes nothing: when your credential rests until a reset and no
session has met that yet, the dialog says "Nothing can run until 15:40 (your API key's limit).
Press Start and the work starts then." and the button reads **Start at 15:40**; press it (or
**Continue where it stopped**) and your Start is kept: no session runs now, the dialog says "A
session of Quote page starts at 15:40.", the project's line reads "Starts at 15:40 (your API key's
limit): 1 task", and at 15:40 the session starts once, as yours (your quiet hours do not hold
it: you chose that time), also after Forerunner was closed and opened again. Then the dialog
says "Nothing can run until 15:40 (your API key's limit); then your session goes on." with
**Cancel the wait**, and a second Start says "A session of Quote page starts at 15:40.". A start
you ask for in chat during such a wait is kept the same way: chat asks "Start a session on Quote
page at 15:40 (up to CHF 5.00)?", your yes keeps it ("A session of Quote page starts at
15:40.", no session now) and Undo drops that start only; once it has run at 15:40, or you
cancelled it, Undo says there is nothing to undo; a question you ask chat meanwhile ends "...; a Start
now runs at 15:40.". While your own session waits to go on, or a Start is kept, the project's
header offers no Start session (Cancel on the wait drops it, and Start comes back). Only
looking starts nothing. The
project's line says it too: "Ready: 1 task; nothing runs until 15:40 (your API key's limit)"
with **Continue**, and where New task, the plan card or Settings say where a specialist runs,
they say "Waits until 15:40 (your API key's limit). Press Start and the work starts then."
(creating a task keeps no wait, so nothing starts by itself until you press Start). A task's
run that Anthropic refused reads "Stopped: Anthropic refused your API key" (or "your
subscription sign-in") in its drawer. If
you add a Claude subscription instead of a new key, your session that waited goes on by itself on
the subscription when your order lets it go there (with no order chosen, tasks use the
subscription first), with no restart, and once no work waits on the refused key its card closes
("Closed: the work that waited for it goes on with your Claude subscription."; it comes back if
work needs that key again); under **Subscription first, then wait** a first choice that rests or
was refused still holds its work. A session you start while a new project's plan is being drafted waits for the planning to
finish ("queued") and then runs. A review waits the same way: when the critic's review of a finished
task meets a limit or a refusal and no other credential can do it, the task goes back to Ready
without counting as a failed try, its row reads "Waits until 15:40, ...", no card is filed
beside the credential's own, and at that time its session has the critic review the work
without running the specialist again (unless the files it wrote changed meanwhile).

Until you choose, everything (tasks, Chat, project setup and reviews) uses the subscription first.

### Where a task runs

Your order decides, and a task goes to another credential only when the first cannot do it
properly. The two do not do the same things here; Settings → Advanced has a small table,
**What each can do here**:

| | API key | Claude subscription |
|---|---|---|
| Read web pages | Yes | Yes |
| Search the web | Yes | Yes |
| Run commands (its tests) | Yes, in the sandbox | No |
| Ask you while it works | Yes | No: it lists its questions in its report |
| What it costs | Money per use | Your plan's limits, no money per use |

- **Research** (the researcher) needs to read pages and to search. Both credentials do both
  (Forerunner's own page reader runs on the subscription too), so research follows your order
  and the plan card has nothing to say. If your account's administrator has switched web search
  off for your API key, the table says "No: switched off for this API key" under search, and
  research runs on the subscription when you have one; with the API key alone the plan card says
  "it reads web pages here but cannot search, so it reads known addresses". The science evaluator
  reads pages and has no
  search, on either credential.
- **A task that needs your answers** (its words say it needs your decision) runs where it can
  ask you while it works: the API key ("Runs on your API key: only it can ask you questions
  while it works here.").
- **Code tasks** stay on your first choice. On a subscription they cannot run commands, so
  their own tests do not run, and on a project whose dependencies must be installed the
  project's own checks cannot run before the review either; the plan card then says "On your
  subscription this task's tests will not run: commands cannot run there." The setting **Code tasks
  that need commands** (Settings → Advanced, Other settings) sends them to the API key instead
  ("The API key (runs their tests; costs money)"; Forerunner asks you to confirm).

New task says the same sentence when you pick who does it, for the words you typed: a task whose
words need your answer ("uses the owner's choice of hosting") says "Runs on your API key: only it
can ask you questions while it works here." before you press Create.

A task's own budget (New task, **Budget**) is what the task may cost, all of it together: its
work, the critic's reviews of it and any fixes after the critic sent it back all count, and
together they never spend more. The Tasks tab, the task's drawer and Costs show that one figure,
with the budget under it on the Tasks tab ("of CHF 0.20 budget", or "CHF 0.20 budget used up"
once nothing is left; its tooltip says "Its work, the critic's reviews and any fixes all count.
The task pauses at this budget and keeps its work."); a task moved in by **Make one project**
keeps its whole figure there. Each run keeps room in the budget for the review that follows it,
when the budget is large enough, and its line in the session's log says so ("This run may spend
CHF 0.20 (CHF 0.04 of the task's budget is kept for its review): ..."). A budget too small for
the work and its review still gets the work done: the run uses what is left, and the review then
waits for you (below). A task
without a budget stops each run at its specialist's limit, and the Tasks tab says so ("each
run stops at CHF 2.40 (the coder's limit)"; a task you left to the agent's choice names no
specialist there); a done or cancelled task shows no limit. The estimate a
plan shows is only a
forecast. It starts from what that kind of work cost on the real model (a page or a coder
task a few centimes, a test task a little more, a research task that reads web pages about
CHF 0.40), whatever the plan model guessed, and grows with the task's size as its outcome and
checks describe it: each file it names, tests to write, "at least six cases" and a long list of
checks make it larger, up to four times (a tool in four files with its tests is about CHF 0.11,
a footer line a few centimes). It learns from every task that finishes, per unit of that size,
so a large task does not make the small ones look dear: after three tasks of a kind it is
within about twice what they really cost. The estimate holds the task's review as well as its
work (a light review a couple of centimes, a full review more), and it learns both, so the plan
line and the Start dialog price a task as its budget counts it; with reviews in, fewer tasks fit
one session's budget than before. The session review sets what the planned tasks cost, their
work, reviews and fixes, against that estimate, and names the session's own checks apart ("cost
CHF 0.28 (the planned tasks CHF 0.20 against an estimate of CHF 0.19, the session's own checks
CHF 0.02)"); a session planned before this reads as it did. That estimate is
the one the plan line and the Start dialog showed you: a task the critic sent back and the
session did again counts once, and when the second try makes the work cost much more than
planned, the review says so ("with one task tried twice", "with 2 tasks tried again").
Questions the plan asks you cost nothing and the plan counts them at CHF 0.00. A task that stopped at its budget does
not count toward what the estimates learn, even after you raise its budget and it finishes,
since its first run did not finish its work; restarting the app changes none of these figures.
Each step of a task reuses what the step before sent (Claude keeps the conversation for five
minutes and charges a tenth of the price for what it already has), so a long task pays the full
price only for what is new; a step that writes a whole file can do so in one go when the task's
budget leaves room. When a task reaches its budget it pauses and the session goes on with the
other tasks. The Inbox gets one card, '"Contact page" paused at its budget of CHF 0.40', or, when
the agent stopped to wrap up before the budget ran out, '"Contact page" paused before its budget
ran out' with what it spent ("It spent CHF 0.31 of its budget of CHF 0.40."), then where it
stopped and what is left in its own words, each point whole on its own line (**Where it
stopped**: "contact.html has the form."; **Left to do**: "check the links"; three at most, then
"and 2 more"), and two buttons: **Continue (CHF 0.40 more)** (adds that much to its budget,
the same amount again or at least its estimate, and starts a session at once that goes on from
where it stopped) and **Cancel task**. At a session's budget Continue asks for what the work left
needs to fit a session ("Starts a session now with CHF 3.00; without it, your next Start takes
it in its turn."). When the run changed code, the card's first sentence also says whether the
project's own checks pass on the work it kept ("...; the project's test fails on its work.");
they ran once in the task's sandbox, cost nothing, and their output goes to the next run, never
onto the card. A spend past the task's estimate is said too ("It has spent CHF 6.10, more than
its estimate of CHF 6.00."). After a pause that got no further than the one before (no file
changed, the same list), the card asks: '"Build the shop" paused again without getting further'
with "Its last run changed no file and left the same list: continue with a note on what to do
differently, or cancel it."; type a note above **Continue** and it goes into the next run's
brief. Such a task never goes on by itself, not at your next Start and not when a limit is
raised. The Tasks tab reads "Paused at its budget" (or "Paused before its budget ran out" when it
heard the wrap-up) with "Continue or cancel in the Inbox." ("Your next Start goes on with it, or
Continue in the Inbox." at a session's budget), with Answer (the card), Edit (set another budget
yourself) and Cancel.

A budget stop is a pause, not a failure. Before a task's run reaches its budget, the agent is
told once to wrap up, with how much of its budget it has used: it starts nothing new, leaves the
files working and ends its report with "Where I stopped:" and "Left to do:". The reserve for that
is a fifth of the run's budget, or the cost of two calls when that is more; the session's log
(Details) says at the start of each run where its wrap-up comes ("This run may spend CHF 0.40:
before a step that could take it past CHF 0.32 it is told to wrap up, keeping a reserve of CHF
0.08 to finish."). Since one step can cost a lot (a long file, a large page), the wrap-up can come
before the run has spent that much, and the log says so ("Told the researcher to wrap up: it spent
CHF 0.02 of CHF 0.15, and its next step could take it past CHF 0.07."). A reply cut off at its
length limit is paid for and has a line of its own ("The writer's reply was cut off at its length
limit, so nothing of it could be used (CHF 0.05); it was asked again."), and an agent that writes
files is then asked to write one file per reply. A budget too small
for even that is "save only": nothing is said to the agent, and the run pauses at its budget; one
smaller than a single step's cost says so and pauses before that step. Under a project budget or
a monthly spending cap that has less left than the run could otherwise spend, the run's figure is
what is left of it ("This run may spend CHF 0.06, the rest of the project's budget: ..."), so
it wraps up inside that limit with its work kept instead of being stopped there. A run that stopped at a
budget, or that wrapped up with work left, is paused: the critic does not review half-done work,
it does not count as a failed try, and its report stays in the task. A run that wraps up with
nothing left is reviewed as usual. "Left to do" counts only what the task's acceptance criteria
still need: "Nothing for the acceptance criteria" or "nothing the criteria require" is nothing, and an optional extra the agent
suggests is kept as a note, so finished work goes to its review instead of waiting on a card. A
line that says the work is not done ("Nothing the task requires has been tested", "Nothing for
the criteria: tests and docs remain", "Nothing for the task: mostly done", "None of the
deliverables included") is work left: the task pauses and its card offers Continue. When the
agent's words leave it unclear whether anything is left, the task pauses too: Continue or Cancel
task is your choice. The card and the task name the limit that stopped it: the
task's budget, the specialist's limit, the session's budget, the project's budget, this month's
cap or the share of your Claude subscription Forerunner may use. A stop at the session's budget,
the project's budget, the month's cap or the subscription's share ends the session, and the
session says which ("Stopped at this month's cap" on its page, "Stopped at this month's cap of
CHF 150.00." in its result and the Inbox). At the month's cap, the project's budget or the
subscription's share the card offers no Continue (a bigger task budget would not help): it says
how the task goes on ("It goes on by itself once you raise the monthly cap in Settings, or on 1
December."), links Settings, and the task goes on by itself once you raised that limit (or
removed it) in Settings, or the new month began; until then it stays paused with its card.
The same holds when the limit is reached by the critic's review rather than by the run: the
task pauses at that limit with the same card ('"Contact page" paused before its review: the
project's budget of CHF 0.01 has no room for it.' in the log; the card says "The work is done;
its review waits for room in the budget."; the log does not say the critic started a review
that never ran), it does not count as a failed
try, and once it goes on its next session reviews the work without running the specialist
again (its log says only that the critic reviewed it), unless the files it wrote changed
meanwhile: then the specialist does it again first. The task's own budget is such a limit too,
since it counts the review: a review that would pass what is left of it pauses the task with
its work kept, and **Continue** on its card adds what the review needs (its usual cost and one
step's worst case), so one Continue is enough. A task the critic sent back whose budget is spent
says so ("The critic sent it back, and its budget of CHF 0.20 is spent (CHF 0.20 so far):
Continue in the Inbox gives it more for the changes the critic asked for.").

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
stopped": the run's note, the files it changed and its to-do list, with its first item as the
next step, and whether the project's checks passed on that work (the end of a failed check's
output is quoted to it as data). A run that stopped before it could write a note says so and
lists the files. When Forerunner tells a run to wrap up, it asks it to finish the step it is on,
leave the files building and working, and undo or keep out of use a change it cannot finish. **Cancel** on a paused task sets its work aside
and names the tasks that will be stuck ("Drops it. Its work so far is set aside unless a later
task built on it; Undo brings it back."); in a project's folder that another task has built on
since, its files stay and the line says why. A task paused before its run wrote anything has no
work to set aside: its card says "It stopped before it wrote anything." and its Cancel says only
"Drops it." (with the tasks that will be stuck). Undo, or Reopen later, brings the work back, and its
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

Research reads the web on both credentials, the API key and a Claude subscription, with
Forerunner's own page reader: the researcher and the science evaluator read web pages by their
address, with a GET and no passwords or cookies, at most 2 MB per page. Whatever a project says,
research never reads this computer (Forerunner itself included) or your home or office network.

**Web pages research may read** is one setting per project (Settings, per project; the project's
Overview shows it as "Research reads: any public website · Change", and Change opens the same
dialog). It is either:

- **Any public website** (the default), with an optional list of websites research never reads;
- **Only these websites**, a list that may not be empty (research would be stuck). Use it when a
  project must keep to its own sources, for example only developer.mozilla.org.

Each website on a list also covers its subdomains: example.com covers www.example.com and
docs.example.com. Type a site or paste an address: the dialog shows what it will save
("https://example.com/page becomes example.com"), and an entry it cannot take is named with its
reason before you save (an IP address, a name on this computer or your network, and in "Only
these websites" an entry as broad as co.uk or github.io, under which anyone can have a site).
Nothing you type is dropped silently. A change that lets research read more (back to any public
website, a site added to the list, a block taken off) asks for your yes first; one that lets it
read less applies at once. The agent browser's own site list is a separate thing and changes
nothing research reads. A block list written before this setting existed is shown and enforced
here too. The plan for a project with "Only these websites" plans no research that needs another
website, and when that list has nothing on it the plan card says under each research task:
'Reads no website: this project's "only these websites" list is empty. Add websites in Settings,
or Change the plan.'; each research run is told the rule and says in its report what it could not read
because of it, and a refused page says which rule refused it. The review of a research task is
told the same rule, so a page research rightly did not read is never held against the work, and
it reads every page the work rests on, also those read before a pause.

Every brief says today's date in your time zone, and every page research reads says when it was
read (for example "read 2026-11-09 04:24 UTC"), so a source list can give the date each page was
accessed, and the review can check it.

On an API key the researcher also **searches the web** with Anthropic's web search: at most ten
searches per task, fewer when the task's money left would not pay for them, at about 1 cent each
plus the results it reads (the task's cost and the session's log include them: "searched the web
for ..."). Searching never eats the reserve a run keeps to finish: the run is told to wrap up at
the same point with or without search (as the session's log says when it starts). A run is offered
up to two searches a step, the same offer for the whole run (changing it would make the run pay to
send its conversation again), until the money before its wrap-up point no longer covers them; then
search goes away for the rest of the run and it reads pages by their address. A task whose budget
is too small for even one search is told so in its brief and reads pages by their address. On a Claude
subscription it searches with Claude Code's search, and opens pages with Forerunner's reader as
on the key (Claude Code's own page reader is switched off). Search only finds pages: a claim in
the research counts as sourced only when its page was opened and read, so the researcher opens
the pages it uses, and on the API key the review is told which search results it saw but never
opened (a claim that cites only one of those is not sourced; on the subscription Claude Code
searches by itself, and that list is not kept). The project's setting applies to the search too:
"Only these websites" limits it to those sites, and the never list keeps those out. Search
results and pages are information for the researcher, never instructions, on both credentials:
a result whose title reads like instructions is named in the session's log and told to the
review. If your account's administrator has switched web search off, or Anthropic refuses the
project's list, the research goes on reading pages by address and the session's log says so once
("Web search is switched off for this API key; research reads pages by address."); a new API key
ends that. The science evaluator has no web search: it reads the pages its brief names.

Since both credentials can read and search, research follows your order of credentials (see
"Where a task runs"). The session log names each page read ("read the web page
gohugo.io/about/"), the research file cites each page by its address, and the critic checks the
claims against the pages the researcher actually got, on either credential. A page that cannot
be read (refused, missing, not a text page) is said in words to the researcher, who writes it
down as not read. Forerunner's page reader connects directly: on a computer that reaches the
internet only through a proxy, pages cannot be read, while search still works; the refused
page's words and the setting's row in Settings say so. An install can turn page reading off for
every project; then project setup plans no web research, and a researcher's task runs from the
project's own files and says so when that is not enough.

Every setting is in **Settings → All settings** with a plain name and its own control: your
default autonomy for new projects, the monthly spending cap, quiet hours (a time range, or off),
where notifications go, reading urgent notifications aloud, the monthly critic calibration, the
model watch's evaluations; and per project the autonomy, the project budget, the budget per
session, the highest model its runs may use, small-project mode, the monthly handover test,
Opus fast mode, speed or quality, the web pages research may read and, for a project on GitHub, the status pull request. Every
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
email mode; undoing a raise acts at once. An undo that waits for your yes asks one question,
on Changes, on Home and in the Inbox alike ("Put web pages research may read for Reading rules
back to any public website?" with **Yes** and **No**), and the project counts it as a change to
confirm. When an undo cannot work any more (the task was
finished since, a session already read the note, the session a start began has ended), the
change reads **Cannot be undone** and says why instead of offering Undo, and nothing ever says
"Undone" when nothing changed. Each change says **Can be undone**, **Undone**, **Reverted** (a
change for tonight that went back by itself) or **Cannot be undone**; the line an Undo itself
leaves ("Undone: …") has no such badge. "Said:" shows the words you
typed in chat, said aloud or wrote in an email; a click in the app has none.

A change the agent made itself (its own fix of the task list during a session, or "fix the
tasks" in chat) names the agent, not you; one made during a session reads **In a session**. On a
session's page each change line has its own **Undo** (or says why it cannot be undone), and the
task's drawer says what the agent did, under its status: "Added by the agent: …", "Split from
"Style the page" by the agent." or "Dropped by the agent: same as "Add the README"."; a task you
added or changed yourself has no such line. The agent's suggested changes on an Inbox card
are listed open, so you read them before **Make these changes** or **Keep the tasks**.

## Seeing what runs

While a session works, a bar directly under the header says so on every page and at every
window size: **Quote page · the coder works on "Style the page"**, with how long it has been
doing that and **Stop ▾**. The words follow the session as it goes: '... · the critic checks
"Style the page"', '... · picks the next task', '... · wraps up "X" at its budget', '... · stops
after "X"'; a session you started for another project that waits for this one adds '· then
Garden site'. Click the words to open the session. **Stop ▾** offers **Stop after this task**,
**Stop now** (asked once) and **Stop all** (asked once, see "Kill switch"). The window's title
starts with ● and the project's name while a session runs. Home's and the Overview's
**Working now** show the same line with the same Stop, and so does the first line of **Talk**.

Once a month the critic checks itself on examples whose right answers are known; while it does,
the bar reads **Forerunner · the critic's monthly check on known examples**, and Stop's menu
says what it is for and what it may spend; its **Stop now** stops the check at once, and that
month's report is then not written.

When a session of yours stopped to wait for Claude (a usage limit, a refused key) and goes on by
itself when Claude is back, the bar reads **Quote page · waiting until 15:40, then it goes on**
with **Cancel** instead of Stop; Cancel means nothing starts when Claude is back and its tasks
wait for your Start. The same wait shows on the project's line (without a Cancel of its own: the
bar's and the Overview's Working now are the place for it) and on that session's page (with
Cancel, or once cancelled **Continue**, which opens Start with the rest of that session and what
is left of its budget). While a session works, the session page's Current task says what the bar
says ('The critic checks "Style the page"', "Picks the next task"), and during a project's first
session the Overview's Last result reads "Running now: Open the session". After Cancel, the session's result on its page, on the Overview (and in
Read aloud), its Update line in the Inbox and Chat ("summary", or a question about the last
session) say "...; then it runs at your next Start." instead of "then your session goes on",
at once, with no reload of the page. The project's line also says what waits to start: "Starts at
15:40" for a Start you pressed while Claude was out (with Cancel), "Starts after your quiet
hours", 'Starts after the session on "Quote page"' (as soon as you press Start there, no reload
needed; with **Cancel**, and the project offers no second **Start session** while it waits: a
second press elsewhere keeps the one start and says 'A session of Bird notes already starts
after the session on "Quote page".'), or "Ready: 3 tasks wait for your Start".

After an answer in the Inbox that readied work for your next Start, its Done line offers
**Start**, which opens that project's Start dialog; it is not shown while a session of that
project runs.

On the desktop the tray says the same: its first line (and its tooltip) is what runs now, the
icon gets a blue dot while a session runs, and the window's title reads "Forerunner — Quote page
is working" ("Forerunner — the critic's monthly check" while only that runs). A session that only
waits to go on shows its words there but no dot.

## Kill switch

**Stop all**, in the Stop menu of the bar under the header, asks once ("Stops every running
session now. No session starts until you allow it again."), then stops every
session of your agents on this computer, revokes the run tokens and freezes claims within two
seconds; the tray's **Stop all sessions** does the same. On a shared project the other people's sessions keep running,
and the tasks they hold stay theirs. A bar then says **Sessions are stopped** until you press
**Allow sessions again** (lets sessions start again) or **Continue where it stopped** (allows
them and starts a session again on the projects Stop all stopped, if they still have work that
can run; other projects are left alone, and so is a session you stopped or undid yourself); the tray, "resume" in
Chat or a start from the phone allow them too. The stop lasts across restarts until then. A
session's own page has **Stop after this task** and **Stop now** (see "Sessions"); they end that
session only and leave the rest running. Starting a session while sessions are stopped says
so, with **Allow sessions again**.

The command palette opens with **Ctrl+K** (**⌘K** on a Mac) and has **Start session** for the
project on screen, or for the active project when no project is open. It lists **Stop all** only while something runs, and asks first as the Stop
menu does; while sessions are stopped it offers **Allow sessions again**.

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
can see where it stopped speaking. A spoken answer only ever says whole sentences: when an answer
runs out of room or time, the agent stops at its last whole sentence and never says half of
one. The **Reply: Voice | Text**
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
  budget per session of each project, the monthly cap, **Chat asks first** before a stronger
  model or an answer over your amount (CHF 0.10 at first; below it Chat thinks longer when it
  helps, on the same model; 0 makes it ask before every longer answer, and the Changes row says so
  after the amounts: "from CHF 0.10 to CHF 0.00: chat asks before every longer answer"; a lower
  amount applies at once, a higher one asks your Yes), the default autonomy by name ("Standard:
  routine, reversible actions run; the rest asks you"), quiet hours, and **Sandbox (Docker)**
  (whether full-review tasks can run, the step to take, the sandbox download). Everything else is
  under **Advanced** (collapsed; click it to open): the subscription allowance, which Claude
  credential is used first, appearance and shortcuts, the connection to the background service,
  your paired devices, sources, Opus fast mode, models, **Voice** (installing local voice, CPU or
  GPU, and which voice providers are in force), the desktop allowlist, **Email** (your agent's
  mailbox and mode, on the Email page) and the other settings, each project's autonomy among
  them. Only settings you can change are listed; autonomy is always chosen by its name. Money is
  in CHF, with a point or a comma. Opus fast mode quotes Anthropic's price per million tokens
  in CHF at the day's rate ("about CHF 6.40 / 32.00 per million input / output tokens instead
  of CHF 3.20 / 16.00"); Anthropic lists it as USD 8 / 40 against USD 4 / 20, a 2x surcharge. A project's budget can be 0, which means no budget
  (only the monthly cap limits it); the monthly cap cannot be 0, since it is the limit that
  stops all spending (raising it needs this computer's OK), and a session's budget cannot be 0
  either: a session plans its work within it, so enter the most a session may spend. A new
  install's cap is CHF 150.00. A change card shows the new value in words, with what it changes
  as the sentence under it; a setting that is on or off says "on" or "off".
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

### Merges that happened on GitHub, and one project after Make one project

- If you close a pull request on GitHub while a later task's pull request still holds its change,
  and you merge that later one there, the first task reads "Merged through #48": its change
  reached main all the same. Its card offers **Take this work out** (a pull request that takes
  only that change out of main; nothing changes until you merge it) and **Keep it**.
- A card about a pull request you close on GitHub closes by itself ("Closed: #33 was closed on
  GitHub."). A cancelled task's pull request you close there reads as closed without merging.
- **Merge** reads GitHub first: a commit pushed a moment ago, a check that failed or a conflict
  is said at once, and nothing is merged. A pull request you merged on GitHub already reads "#59
  was merged on GitHub already.". If the pull request you press builds on one you closed on
  GitHub a moment ago, the task of the closed one reads "Accepted · pull request closed" in Tasks
  right after your press.
- In Costs, **Accepted** is counted against tries: a run that paused at its budget and the run
  your Continue started are one try, so a task accepted after one Continue reads "1 / 1".
- **Make one project** names the Status pull request setting and counts only the pull requests
  still open. After it, the kept project lists the other's open status pull request with Merge.
  The other project's page names it in the header, says where its files are and where its tasks
  went on, and Costs counts a moved task's own runs.

### Chat changes are yours, and wait for your answer (2026-11-23)

A change you ask for in Chat is read back once with Yes and No. After your Yes it is yours:
Changes names you as the one who made it, and the Inbox does not repeat it. A read-back
waits until you answer it, also for days and after Forerunner restarts; if what it names changed
meanwhile (another change, or the task was cancelled or finished), your Yes changes nothing and
Chat says what changed, so you can ask again. When you answer it, in Chat or in the Inbox, the
header's count and the Inbox follow at once, and an open Chat drops its Yes and No; a question
still waiting in the same project stays in the header ('Waiting for you: "Confirm the
stack"'). The same holds for a setting or a budget you asked for in Chat: if it was changed in
Settings meanwhile, your Yes says so ("The monthly cap is CHF 120.00 now, not CHF 150.00 as I
read it back. Nothing was changed; ask again if you still want it."). After "fix the tasks",
your Yes still makes the changes when a session finished another task meanwhile; it says "The
tasks changed since I checked them" only when a task the changes name changed, or a task was
added or removed. An Undo you confirm in Chat says what is back ("Undone: the monthly cap is
back to CHF 150.00."). A change made with your yes beside one the agent asked for is listed on
Changes under both names ("J and Alice"). A note for a task's next brief is read back too when
Chat wrote it for you, and only your own note is ever read as your instruction. When you ask in
Chat to try a failed task again with words for it ("try the digest page again and use the old
layout"), Chat answers its card's Try again with those words as its note, read back first
('... Note for its next brief: "Use the old layout."'), and the next attempt reads them.

The reviewer reads and runs checks but writes no file: its findings are its report, which you
read in the task's drawer. New task and Edit say so when you pick it, naming the file your
words ask for ("The reviewer writes no file, so review.md is not written: ..."), and so does
Chat when it reads back a task for the reviewer; to have a file written, pick another
specialist or let the agent choose. The name of a tool or a site, such as Node.js, ASP.NET or
example.com, is never taken for a file, so a review of "the Node.js setup" gets the plain line.

### Your own words in a chat note stay yours (2026-11-24)

When you give words for a task's next attempt in Chat ("pause the FAQ and tell it to wait for
the logo", "try the digest page again and tell it to use the old layout"), those words are your
note: Chat does not read them back to you, the Yes says "Your note goes into its next brief.",
and the next attempt reads them as yours. A failed task's card is answered with Try again and
your note. Mark done anyway takes no note: "mark the digest page done anyway, the client
accepted it as it is" answers the card's Mark done anyway, and Chat's question ends "Your note is
not kept." so you know before you say yes. A note Chat wrote without your words is still read
back first ('Note for its next brief: "..."') and stays the agent's; its words never become the
task's reason on the drawer. A
card that needs this computer's OK is answered on the card only; Chat then says where your note
goes ("type your note there with Try again") or that it was not kept. A suggestion card's
Answered line says what was really changed, and when the changed tasks wait for a task only you
can do it says so ('it waits for "Send the logo", which is yours to do') instead of promising
that your next Start runs them. A Take this work out cut short when Forerunner closed is finished
the next time it starts.

### Pull requests you close, a docs pull request tried again, and branch names (2026-11-24)

- A cancelled task's pull request that is still open on GitHub has **Close** on the Overview:
  it closes the pull request on GitHub (you can reopen it there) and keeps its branch. If GitHub
  refuses the saved token, the token cannot write to the repository or GitHub does not answer,
  the row says so and nothing changes.
- When you took over a repository and its docs pull request could not be opened, the Overview
  and Docs say so with **Try again**. It opens the docs pull request that names this project, or
  says why it still could not (the token cannot push, or another project's docs pull request is
  open; close that one on GitHub first).
- A task with a dot in its title, such as "Update yarn.lock", gets a branch GitHub accepts.
- **Take this work out** on a task whose change reached main through another pull request works
  at once; if that change came in without a merge commit, it says you undo it by hand or ask in
  Chat for a task that does it.
- After a pull request you closed reached main through a later one, the Overview's last result
  and Chat say exactly that ("#47's change reached main through #48."), never that #47 was
  merged.
- A pull request rebuilt without the one it built on is listed under "Rebuilt since the
  critic's review": look at it before you merge.

### The repository guide, decisions by day, and docs pull requests that are not yours (2026-11-24)

- Every repository a project of yours uses gets **AGENTS.md** and a one-line **CLAUDE.md** with
  its docs. AGENTS.md is the guide for people and their agents: it says the repository is your
  Forerunner project, that someone who wants to work on it links it in their own Forerunner and
  chooses **Work together**, where things are, which branch nobody pushes to, who presses Merge,
  the checks to run, and what an agent does when it leaves work unfinished. Forerunner writes
  only its own part, between two hidden marks; whatever you wrote in AGENTS.md stays as you
  wrote it.
- Forerunner keeps the guide current: when something it says changes (the project's name or
  goal, who merges, the checks), the next session's end opens one docs pull request with the new
  guide. Nothing changed, nothing is opened, also after a restart.
- There is no docs/status.md in your repository any more: the project's status is in the app
  (Docs, Status). An untouched status file Forerunner wrote earlier is taken out in its next docs
  pull request; one you wrote yourself stays.
- If you work on a project **together** with another Forerunner, its guide and docs are that
  Forerunner's: your Docs tab says "The other Forerunner keeps these docs on GitHub; this project
  keeps only its status." above the docs, each row says "The other Forerunner of "<name>" writes
  this doc on GitHub; this project does not write docs.", and your Forerunner never writes them.
- New decisions are files named by the day, such as `docs/decisions/2026-11-24-hosting.md`, so
  two people's decisions never clash. Your answers to the plan's questions in the Inbox go to the
  project's decision record, and the card names the file.
- A task pull request that changes AGENTS.md or CLAUDE.md says so at the top: read it before you
  merge, since other people's agents follow it.
- A docs pull request on your repository that names no project (one somebody else opened) is
  never written to by your Forerunner. The Overview lists it apart, under "Also open on GitHub",
  as "Docs pull request #N" with Open and no Merge: "#N names no project, so it is only listed
  here: open it on GitHub to see whose it is."
- **Try again** on a take-over now says what stopped it: another docs pull request is open (close
  it on GitHub), the scaffold's branches hold another project's docs (delete fr/docs-scaffold on
  GitHub), GitHub did not answer (try again in a moment), or the saved token cannot push. A
  take-over you made with a brief whose plan's docs pull request could not be opened shows the
  same line with Try again.

**The status issue (2026-11-24).** Each repository project has one pinned issue on GitHub,
"Forerunner status: <project>". Your Forerunner keeps one comment there and edits it in place:
what it works on now (each task's title, the files it names, since when and until when), which
of its pull requests wait for Merge, what is paused (what is done and left, and whether the
checks pass on the kept work) and what its last session did. Another person's Forerunner on the
same project keeps its own comment beside yours; neither edits the other's, and the issue's
summary at the top is rebuilt from the comments. Nothing about money, no email address and no
@mention is ever written there. The issue is opened by the first Forerunner that starts a task or
ends a session on the repository, never when you link it or press Work together. Settings,
Advanced, Other settings, **Status issue on GitHub** shows where it is ("Status on GitHub: issue
#12 (pinned).") and turns it off for the project ("Status stays in the app: the status issue is
turned off for "Team site" in Settings."); on a public repository the row says "Everyone who can
see this repository can read it." The Docs tab's Status row says "In the app; also on GitHub:
issue #12". When GitHub cannot take it, the status stays in the app with one sentence: "Status
stays in the app: issues are turned off on owner/repo.", "Status stays in the app: Forerunner may
not write issues on owner/repo (the GitHub key needs Issues: read and write).", or "Status on
GitHub: last updated 14:05; it updates when GitHub answers." What waited goes out when GitHub
answers, also after you quit and start Forerunner again, without opening a screen; quitting while
a task runs takes its line off your comment. A key that can no longer see the repository reads as
the second of these sentences, and Forerunner tries again at your next task or session. A repository whose
`.forerunner/project.json` names another Forerunner project gets no status from a project of
yours that is not worked on together with it ("Status stays in the app: o/kite is the Forerunner
project "Kite club"; Work together on the Overview shares its status issue."). If someone edits
your comment on GitHub, you get one Update and your Forerunner writes its own text there again; a
closed issue is never reopened ("The status issue #12 was closed on GitHub; reopen it there to
use it again."). The status pull request of earlier versions is gone: one your Forerunner opened
for the project is closed with one line.
