# Core experience: what Forerunner must feel like

Design target for the fix round that started 2026-11-01, written from seven hands-on walks of
the real daemon and UI in Chromium (stand-in model; no API key that day). Fixes are judged
against this, not the spec's requirement list; on what a person sees it wins until the owner
says otherwise. "Before" quotes are verbatim texts the app showed.

## 1. The loop

A person uses Forerunner for five things, in this order, over and over:

1. **Give work.** Describe a project or a change, in a few words.
2. **See progress.** Know at a glance whether the agent is working, on what, and for how long.
3. **Answer what needs you.** One list, each item one sentence with buttons that say what they do.
4. **See results.** What was built, where the files are, what is left.
5. **Steer by chat.** Ask "what is going on?", "why did X fail?", "make X wait for Y", "stop".

Everything on a primary screen serves one of these; the rest moves behind **More** (hidden,
never deleted). Three promises hold everywhere:

- **Work keeps going by itself** until it is done or something truly needs the person. Pressing
  Start once per task is a bug.
- **Nothing is stuck silently.** If no work can happen, exactly one place says why in one
  sentence and offers the button that unblocks it.
- **What the app says is true now.** No snapshot from earlier, no promise the code does not keep.

## 2. Words the person sees

### Task status (one map, used by the badge, the filter, the Start dialog, chat and every text)

| Stored state and situation                  | Shown as                                   |
|---------------------------------------------|--------------------------------------------|
| draft                                       | Draft (no session picks it up)             |
| ready, can run                              | Ready                                      |
| ready, a dependency is not done yet         | Waiting for "X"                            |
| ready, a dependency failed or was cancelled | Stuck: "X" failed / was cancelled          |
| ready, full review and Docker not ready     | Waiting for Docker                         |
| claimed, in_progress                        | Running (2 min)                            |
| in_review                                   | Being reviewed                             |
| needs_human with an open Inbox card         | Needs your answer (link to the card)       |
| needs_human, no card (the person paused it) | Paused by you                              |
| failed                                      | Failed: one-line reason                    |
| done                                        | Done (or "Done: accepted without review")  |
| cancelled                                   | Cancelled                                  |

Raw names (`needs_human`, `in_progress`, `claimed`, `tier 2`, `ladder`, `verdict`) never appear.

### Project status (one sentence, derived; replaces the four header badges)

First match wins:

1. "Waiting for you: approve the plan" / "Waiting for you: 2 questions" (links to the card)
2. "Working on "Style the page" (3 of 7 done)"
3. "Stuck: "Style the page" failed; 4 tasks wait on it" / "Waiting for Docker: 1 task"
4. "Ready to continue: 3 tasks ready"
5. "Drafting the plan…" / "Planning failed: no Claude key [Fix]"
6. "Done: all 7 tasks. Your files: <path>"

Stage, health colour, "active" and autonomy level are not shown on the project header or card.
Autonomy lives in Settings with its name ("Standard: asks before risky changes").

## 3. Screens in the loop

Each screen: its one job, what it shows and must not show, its actions (plain label plus a
one-line explanation shown with the button) and its states.

### 3.1 Shell (header and navigation)

- **Job:** get anywhere in the loop in one click and know whether the agent is working.
- **Shows:** nav **Home · Inbox (n)** and **More ▾**; a gear for Settings; the project being
  viewed (not a hidden "active" project); a running chip "Alice is working on "Style the page"
  · 2 min ›" that opens the session; **Talk** (the one chat, §3.9).
- **Must not show:** a red Stop all when nothing runs; "connected" when the service is gone.
- **Actions:** **Stop all (1 running)**, only while something runs, asks once: "Stops every
  running session now. No session starts until you allow it again." **Allow sessions again**:
  "Lets sessions start again", with **Continue where it stopped** beside it.
- **States:** idle; running (chip); stopped (bar "Sessions are stopped" with Allow); service
  gone ("Forerunner's background service is not answering. [Retry]"); no Claude key (bar
  "Claude is not connected: planning and tasks need it. You can still add tasks. [Connect]").

### 3.2 Home

- **Job:** what needs me, and how is each project doing.
- **Shows, top to bottom:** **Needs you** (every open card from every project, one line each
  with its main button); **Working now** (if a session runs); **Projects**, one row each:
  name, status sentence (§2), "5 of 6 done", and one action (Answer / Open / Continue).
- **Must not show:** critic grade, autonomy, stage, spend bars, "Make active".
- **Actions:** **New project**: "Describe what you want; the agent drafts a plan for you to
  approve." **Continue** (on a project with ready tasks): "Starts a session that works until
  nothing more can run."
- **States:** empty ("No projects yet. [New project]"). Home follows `inbox.changed`,
  `session.*` and `project.changed` without a reload; stale data is a bug.

### 3.3 New project and the plan card

- **Job:** turn a few sentences into an approved plan.
- New project asks Name, Goal, Brief (optional repository). After Create the project page says
  "Drafting the plan…", then "Waiting for you: approve the plan [Open]".
- **The plan card** (in the Inbox and on the project page) shows the plan **once**: the tasks
  in order, who does each ("coder", "you: answer 2 questions"), the cost ("about CHF 1"), and
  "Needs Docker" next to a full-review task when Docker is not ready. The decision record is
  rendered as text, never raw markdown. No Change-card JSON.
- **Actions:**
  - **Approve and start**: "Writes these N tasks and starts working on them now."
  - **Change the plan** (opens a text box): "Tell the agent what to change; it drafts a new
    plan for you to approve."
  - **Reject**: "Nothing is written. You can draft a new plan later from the project page."
- **States:** drafting; ready for approval; failed ("Planning failed: <reason in words>.
  [Try again]"); rejected ("You rejected the plan. Nothing was written. [Draft a new plan]").
- A one-line brief gets a small plan (one to three tasks, a README); the doc set is scaffolded
  silently, not listed.

### 3.4 Project: Overview (was Summary)

- **Job:** where this project stands and what happens next.
- **Shows:** the status sentence; this project's **Needs you** cards; **Working now** (current
  task, elapsed, Open); **Last result** (the session summary, §5, max 3 lines); **Next** (the
  ready tasks in run order, then what waits on what, max 3 lines, computed when shown);
  **Your files** (folder path, **Open folder**, and the files changed by the last session);
  **Decisions** as plain question → answer pairs (max 5, "all" links to the record);
  **Note for the next session** (one text box).
- **Must not show:** the next-session queue form with types and priorities, Peers in solo
  mode, "Stage planning", raw decision JSON, counts that are zero.
- **Actions:** **Start** / **Continue** (when ready tasks exist): as on Home. **Open running
  session** replaces Start while one runs. **Open folder**: "Opens the project's folder."
- **States:** planning, waiting for you, working, stuck (one sentence, one button), done
  ("Done: all 7 tasks. Your files: <path> [Open folder]").

### 3.5 Project: Tasks

- **Job:** see every task's state and change any task.
- **Shows:** one row per task in run order: title, status (§2), specialist, cost, critic
  result. Rows update live while sessions run. Clicking a row opens the **task drawer**: what it
  asks (outcome, criteria), what it waits for, its runs (specialist, what it read, wrote and
  ran, the report, the error), files changed (openable), the review in plain words, the PR.
- **Must not show:** raw ids ("claimed by 01a196d2-…", "request 01a196fe-…"), the cap line on
  finished tasks, the move buttons of the state graph.
- **Actions** (offered per status; each dialog has "Note for the agent (optional): goes into
  the task's next brief" and every action has one Undo right after it):

  | Status            | Action                     | One-line explanation |
  |-------------------|----------------------------|----------------------|
  | Draft             | **Make ready**             | A session will pick it up. |
  | Draft/Ready/Waiting/Failed/Paused | **Edit**   | Change the wording, priority, budget, review level or specialist. |
  | Ready/Waiting/Stuck | **Change what it waits for** | Pick the tasks that must finish first. |
  | Ready/Waiting     | **Pause**                  | No session runs it until you press Resume. |
  | Paused by you     | **Resume**                 | It is ready again; the next session can run it. |
  | Running           | **Stop**                   | Its run stops now and it is paused; the session goes on with the rest. |
  | Failed            | **Try again**              | Back to ready; your note goes into the next attempt. |
  | Needs your answer | **Answer**                 | Opens its card in the Inbox. |
  | Done              | **Redo**                   | Reopens it; say what is wrong and the next attempt fixes it. |
  | Cancelled         | **Reopen**                 | Brings it back as ready. |
  | any but Done/Cancelled | **Cancel**            | Drops it. Names the tasks that wait on it: "2 tasks will be stuck." |

  Removed from the person's buttons: Mark failed, Send to review, Mark done, Needs me. A done
  without review is only offered in the Inbox, labelled as such.
- **New task** asks Title, What done looks like, Waits for, Priority (Low/Medium/High), Review
  level ("Light review: the critic reads the work, nothing runs in isolation" / "Full review:
  needs Docker, not running on this computer"), Who does
  it ("Let the agent choose" / a specialist / "Me: ask me in the Inbox").
- **States:** empty ("No tasks yet. [New task] or describe them in Chat"); running (live row);
  changed meanwhile (the dialog reloads the row: "This task changed: it is now Running").

### 3.6 Start dialog

- **Job:** say what a session will do before it starts.
- **Shows:** "This session runs "Create index.html" (about CHF 0.12) and continues with up to
  6 more as they become ready (about CHF 0.80)." Budget prefilled with the real default
  ("CHF 5.00"). At most three blocker lines ("Waiting for Docker: "Check every file loads"
  [Settings]"), then "and 3 more".
- **Must not show:** a list of what will not run when something will; raw statuses.
- **Actions:** **Start**: "Works until nothing more can run, the budget is used, or you stop
  it." Disabled with the reason and the unblocking button when nothing can run ("Nothing can
  run: "Step 3" needs your answer [Open it]"), when sessions are stopped ([Allow sessions
  again]) or when Claude is not connected ([Connect Claude]). Budget 0, negative or above what
  is left this month is refused in words.
- **After Start** the person stays where they were; the running chip and Overview show it.
  While one runs, a second Start reads "Starts after the current session".

### 3.7 Session page

- **Job:** watch one session and stop it.
- **Shows:** title "Quote page · session at 14:05"; status ("Working", "Done", "Stopped by
  you", "Interrupted: Forerunner closed"); **Current task** card with specialist, elapsed time
  and live step lines ("read index.html", "wrote styles.css", "ran node --check: ok"); spend
  and steps updated live; the log in person-level lines (§5), at most about 8 per task;
  internal events under **Details**; after the end, the result (§5).
- **Must not show:** a UUID title, event type names, raw markdown, text cut mid-word,
  notification delivery lines, "Steps 0 / 200" while work happens.
- **Actions:** **Stop after this task** (default): "Finishes the current task, then ends."
  **Stop now**: "Stops the current task at once. It goes back to Ready; what it wrote so far
  stays in the folder." Asks once.
- **States:** running, ended, stopped, interrupted (after a crash: ended by the next start,
  never shown as running again).

### 3.8 Inbox

- **Job:** everything that waits on the person, and short news.
- **Shows two lists:** **Needs you** (cards) and **Updates** (one line each). After answering,
  the card is replaced for a while by "Done: <what happens next>" ("Plan approved: 5 tasks
  written, the session started"). **Answered** (collapsed) lists what was answered.
- **A card** has: a title naming the project and task; one or two sentences of what and why,
  in the specialist's own words where there are any; the options as buttons with a one-line
  consequence each; the safe/likely option primary, destructive ones secondary and confirmed.
  A text box only where free text is accepted. No Change-card JSON. No "high risk · approval"
  badges; risk is said in words when it matters ("Raising the cap needs this computer's OK").
- **What becomes a card** (and nothing else counts as "needs you"): the plan to approve;
  questions from a specialist or for a person task; a task that failed (after its retries) or
  failed and blocks other tasks; a full-review task waiting for Docker (per project); risky
  changes waiting for approval.
- **What becomes an Update:** one line per session ("Quote page: did 5 tasks, nothing left.
  [Open]"), things the app did by itself. Never echoes of the person's own clicks or chat
  commands; never project switches the person made.
- **Card options, plain:**
  - Failed task: **Try again** ("Starts a session that tries again; add a note if you
    know what to change"), **Mark done anyway** ("Closes it although nothing passed review.
    The 2 tasks after it will run."), **Cancel task** ("Drops it; the 2 tasks after it will be
    stuck").
  - Questions: one field per question, **Send answers** ("The task goes on with your answers
    now"), **Go ahead without** ("The specialist decides and says what it assumed"),
    **Cancel task**.
  - Docker wait: **Set up Docker** (Settings, with the steps for this computer), **Cancel
    task**. No light-review shortcut: ADR 0101 (the owner's decision) keeps full-review tasks in
    the Docker sandbox; see ADR 0102.
- **Answering resumes work.** Every answer that makes a task runnable starts (or queues) a
  session, the same way for every card. A card whose task has moved on is closed with a line
  saying so; it never lingers as "blocking".

### 3.9 Chat (project Chat tab and the Talk panel: one conversation)

- **Job:** ask about the project and change it in words.
- **One conversation per project**, stored by the daemon, shown the same in the Chat tab and
  in Talk (Talk shows the project on screen). It survives reloads and restarts, Yes/No cards
  included.
- **What it knows on every turn:** the recent conversation; the project's tasks with their
  status (§2), what each waits for and why it failed; the last session's result by name; the
  open cards in full; where the files are. It can look up more (a task's runs and report, a
  review, a file list) with read-only tools.
- **What it can do:** add a task (ready), change what a task waits for, pause, resume, cancel,
  reopen, try again, start, stop, answer a card, leave a note for the next session. Changes are
  read back once in one line: "Make "Write the FAQ" wait for "Write the README"? [Yes] [No]".
  A stop is the one exception: "stop", "stop after this task" and "stop everything" act at once,
  with no read-back (stopping is immediate, the safe direction); the header's Stop all button,
  which a click can hit by mistake, asks once (§3.1).
- **During a session** a question is answered from the live state; an instruction ("skip the
  README") becomes a change with a read-back. Nothing is silently forwarded to whatever
  specialist runs next.
- **Under the input:** three example phrases ("what is left?", "add a task: …", "stop after
  this task"). **Make this a task** only under the person's own lines.
- **Must not show:** "first token 0 ms" on commands, `task.create:` chips, "Undo." as text
  next to an Undo button, voice-install errors, "reply yes to the email" when email is off.
- **States:** no Claude key ("I can still add, move and start tasks; questions need Claude
  [Connect]"); a card waiting (stays until answered or dismissed; another line does not drop
  it); "yes" with no card ("Yes to what?").

### 3.10 Files

- **Job:** see and open what the work produced.
- **Shows:** the project's folder (or repository checkout) as a tree with change dates; per task
  (in the drawer) the files it changed; **Open folder** / **Open** in the desktop shell, the path
  to copy in a browser; text files inline, read-only; a repository project's PRs, opening in
  the system browser. Empty: "Nothing written yet".

## 4. How a session behaves (the engine's tests assert each sentence)

1. **Start.** The first session after approving a plan follows the approved order. Later
   sessions take ready tasks by priority, then age.
2. **Keep going.** After each task the session looks again and takes: tasks that just became
   ready (their dependencies finished), tasks the critic sent back (the next attempt, in this
   same session), tasks the person made ready meanwhile. It stops only when nothing it can run
   is left, the session budget is used (a fifth kept for reviews), the person stops it, or the
   wall clock runs out. A 7-task chain is one Start.
3. **Retries happen inside the session**, up to the retry limit. After the last one the task
   gets one card (§3.8). The person hears once, not once per attempt.
4. **Failures say what failed.** A run that errors is "Failed: the model call failed" (the
   error in words), never the model's first sentence. A transient error (network, rate limit)
   is retried once at once. A failed task that blocks others gets a card.
5. **Blockers are named once, briefly**, at the end: "Stopped: "Style the page" needs your
   decision (Inbox)." Never a list of every waiting task with stale statuses.
6. **What a specialist is told.** Every brief carries: the project's goal and the person's
   brief, pointers to `docs/overview.md` and the decision record; the task's outcome and
   criteria; for each task it waited on, its title, the files it changed and its one-line
   result; on a retry, the previous attempt's own report or error and the open findings (the
   "findings below" line only when findings follow); the person's notes on the task and for
   the session; answers the person gave or "the person chose to go ahead without answering".
7. **Notes and the approved first session are used up only by work that finished**; a session
   that is stopped, crashes or runs nothing puts them back.
8. **Nothing runnable means no session**: the dialog refuses with the reason; nothing is
   consumed, reviewed or graded.
9. **Stopping.** "Stop after this task" ends at the next task boundary. "Stop now" ends the
   run at once; the task goes back to Ready. Quit behaves like Stop now and records
   "Forerunner was closed", not "kill switch". Stop all freezes until allowed again.
10. **Crash recovery.** At start the service ends every session a dead process left running
    ("Interrupted: Forerunner closed"), releases its claims, puts its task back to Ready and
    posts one Update. Stop on a session not running in this process ends it. "Agent Alice
    already has an active session <uuid>" is never shown to a person.
11. **Background jobs never take the person's place.** The monthly critic calibration runs as
    the critic agent, never on an install's first day, never without a working model, and
    never blocks Start.
12. **Docker.** A full-review task without Docker waits ("Waiting for Docker", one card per
    project, §3.8); the rest of the plan goes on.
13. **Done means done.** A milestone whose tasks are all done is done; a project whose tasks
    are all done says "Done" and where the files are.
14. **Live.** Each model and tool call updates spend and steps and emits one step line; the
    Tasks tab, Overview, Home and the header follow it.

## 5. Writing rules for everything the system writes

For summaries, log lines, cards, Updates, notifications, task reasons, decisions, read-backs,
dialogs, errors, and the status texts given to the chat model.

1. **Length.** Status sentence ≤ 80 characters. Button ≤ 3 words, verb first. Consequence line
   ≤ 100 characters. Card body ≤ 2 sentences. Session result ≤ 3 lines. Update ≤ 1 line.
   Notification: title ≤ 60, body ≤ 140. Log line ≤ 1 line. Longer detail goes under Details.
2. **What needs you first**, then what happened, then what is next.
3. **Names, not ids.** Task titles in quotes, the project's name, "you", the agent's name.
   Never a UUID, request id, run id, prompt hash, event type or file path to internals.
4. **True now.** Computed when written or shown; never a list captured before the work ran.
5. **No zero counts.** Name up to three items; beyond that "and 4 more".
6. **Plain words.** No raw states, tier, ladder, verdict, ceiling, rung, "(s)" plurals,
   "Undo." as text, markdown asterisks, JSON, stack traces, module or secret names.
7. **CHF everywhere**, two decimals, "about" for estimates. Never USD.
8. **Errors** are one sentence of what went wrong plus what to do: "Claude did not answer
   (network). Try again." not the exception text.
9. **No promises the code does not keep.** If the hint says "the agent reads it", a test shows
   the text in the next brief.
10. **One place per fact.** The session result lives on the project; elsewhere links to it.
    Do not post the same paragraph to the session page, Overview, Inbox and notification.
11. **Do not echo the person.** Their own clicks are in Changes, not in the Inbox.

### Before and after (verbatim "before" texts from the walks)

- **Session result.** Before: "Session completed. Waiting on other tasks: "Show a random quote
  on every load in script.js" waits on "Create the page skeleton in index.html" (ready);
  "Style the page in styles.css" waits on "Create the page skeleton in index.html" (ready); …
  Done: 1. Failed: 0. Needs you: 0. Sent back by the critic: 0. In review: 0. Not started: 0
  of 1 planned. Spent CHF 0.01." After: "Did 5 tasks: index.html, script.js, styles.css,
  README.md and a check. Nothing left. CHF 0.80." With a blocker: ""Style the page" failed 4
  times and needs your decision. 2 tasks done; 1 waits on it. CHF 0.06."
- **Start dialog.** Before: "Not in this session:" plus 6 lines of `"X" waits on "Y" (ready).`
  After: "This session runs "Create index.html" (about CHF 0.12) and continues with 6 more as
  they become ready (about CHF 0.80)."
- **Retry card.** Before: "Retry ladder exhausted for "Style the page in styles.css" after 4
  failed attempt(s) (ceiling opus): [stand-in model] Sent back for rework: the worker reports
  it could not do the work." with buttons accept / revise / cancel. After: title ""Style the
  page" failed 4 times"; body "The designer said: "The work needs something I do not have
  here." "Check every file loads" waits on it."; buttons Try again / Mark done anyway / Cancel
  task, each with its consequence line.
- **Decision.** Before: ""Decide where the page is published" needs your answers. No
  specialist works on it: answer the questions below. … {"answers":[{"question":"Where should
  the page be published: …","answer":"Only as a local file for now; maybe GitHub Pages
  later."}]} (not: Cancel the task) by 01a196fe-2aa9-7114-a15e-2024baa5e65e". After: "Where is
  the page published? Only as a local file for now; maybe GitHub Pages later. (Robin, 1 Nov)"
- **Failed task reason.** Before: "I'll look at what is already in the folder first." After:
  "Failed: Claude did not answer (model call failed). [Try again]"
- **Task row.** Before: "retry ladder exhausted after 4 failed attempt(s) at opus (ceiling
  opus): human decides" and "claimed by 01a196d2-bbed-71cf-9d62-a3a3da0464b8". After: "Needs
  your decision: tried 4 times [Answer]" and "Running (Alice, 2 min)".
- **Move dialog.** Before: "ready → needs_human" and "Recorded on the task and in the change
  log; your agent reads it." After: "Pause "Create notes/todo.md"? No session runs it until you
  press Resume." and "Note for the agent (optional): goes into the task's next brief."
- **Log line.** Before: "Finished task: done (CHF 0.00). **Summary** [stand-in model] I could
  not complete this task. … **Criteria** - styles.css e". After: "The designer could not style
  the page: "the work needs something I do not have here". Trying again."
- **Stop.** Before: "error  Error: killed session stopped during task" and "Notified you:
  'Kill switch: one session stopped'". After: "Stopped by you during "Create the page
  skeleton". It is ready again." Crash, before (red, in the Start dialog): "agent Alice already
  has an active session 01a1970f-07e2-72ce-8b72-bfeb7c9e3615". After (one Update at start):
  "Your last session was interrupted when Forerunner closed. "Create the page skeleton" is
  ready again. [Continue]"
- **Budget.** Before: "Left out for budget: … (about $0.78) …; this session's work budget was
  $0.50". After: "Left for next time: "Add a share button" (about CHF 0.43); this session's
  CHF 0.90 was used."
- **Notification.** Before: "An approval is needed (work is blocked)". After: "Quote page:
  "Style the page" needs your decision". Delivery problems ("telegram skipped (no Telegram
  chat id), signal skipped …") never appear in a session log; they show once in Settings.
- **Chat read-back.** Before: "Undo: Say undo or tap Undo in the change log. Say yes to
  confirm, or reply yes to the email." plus the same text in a yellow card. After, once: "Start
  a session on Quote page (up to CHF 5)? [Yes] [No]"
- **Rejected plan.** Before: "Intake proposal 01a196f6-3772-… was rejected on
  2026-11-01T11:55:03.649Z: nothing from the proposal was written; …". After: "You rejected the
  plan. Nothing was written. [Draft a new plan]"

## 6. Primary and More

Primary navigation: **Home, Inbox**, the gear for **Settings**, and **Talk**. Behind **More ▾**
(same routes and screens, hidden from the bar): **Memory, Extensions, Changes, Performance,
Updates**. Project tabs: **Overview, Tasks, Chat, Files**; behind **More ▾**: **Plan, Docs,
Reviews, Costs, Data**.

Settings opens on **Basics**: your name and the agent's name, Claude, GitHub, budget per
session, monthly cap, default autonomy (by name), quiet hours, Docker status. Everything else
(models, credential order, voice, devices, sources, daemon connection, desktop allowlist,
fast mode, the generic settings table) is under **Advanced**, collapsed. Money fields accept
any amount in CHF with a point or a comma; 0 is explained ("0 means no cap").

Why: the walks showed the loop spread over five places and buried under eight equal screens.
Memory, Performance, Reviews and Costs show internals a person does not act on day to day;
Changes is where Undo lives, reached from the Undo links themselves; Updates matters once a
release. Each stays one click away and keeps its tests. Nothing is deleted.

## 7. Out of scope, and how a fix is judged

Voice, phone, email, the installer, release checks, extensions, peers and teams, GitHub Projects
mirroring: hidden where they had a primary place, must not break, no new work unless a
core-loop walk is blocked by them.

A fix is done when a fresh agent walks its journey on the bench (real daemon, real UI in
Chromium) and every screen it passes matches this document: the one job, the actions and their
explanations, the states and the writing rules. Screenshots before and after go with the fix,
with tests at the boundary the person uses (`docs/maintainers/validation.md`).
