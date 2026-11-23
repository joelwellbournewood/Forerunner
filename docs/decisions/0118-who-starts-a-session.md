# 0118 — Who starts a session

Date: 2026-11-16
Status: accepted

## Context

The owner's decision D6 of 2026-11-09 (`/tmp/frbench/owner-decisions-2026-11-09.md`, quoted as
written). On when sessions start: "the management of the tasks should be able to feed into
sessions that are already running when appropriate, and it should be dynamic as much as possible.
But it should also be the case that the user clearly states when a session will run, such that
they could maybe queue up tasks and then change things and then also give some text context into
the chat or to tell the project something and only then run a session. Because now it might run
sessions when I'm in the middle of giving it instructions but haven't yet kind of fully figured
out what I wanted to do, and maybe I will also tell it things in between sessions." On work made
ready while a session runs, option C ("Join only if it fits"): "the session keeps its promise and
spare budget isn't wasted, I think that's probably the best." The session lead then proposed that
the person says when a session starts, an optional "start by itself when work is ready" setting
off by default, and that everything else prepares work; the owner confirmed it: "All this sounds
good except the status line that notifies you if work has waited a few hours. I think that's not
necessary." and "Try to build those in." (the session lead's record of that confirmation: "Only
when you say so" is the default, the hands-off setting optional, off). On credentials, the
owner's answer 7b: "It should definitely not automatically do something even when told to wait or
showing that it is waiting." The session lead's notes after the run C designs record what the
confirmation already answered for a session the person started (their words, not the owner's): it
"keeps going by itself until its work is done, including after a credential wait inside it: when
the credential is back (the reset), that session goes on by itself (that is what 'wait' means)
... A NEW session after a stop the person did not start still needs the person (or the hands-off
setting)." Answer 9 on pull request comments and CI results with the setting on: "fine" (they
start no session). Answer 6 on the critic's monthly calibration: "sure, but also please explain
what function this serves." (it stays monthly and on, and the running-session bar shows it).

Before this decision every answer started paid work: `resumeWork` (`session/resume-work.ts`)
asked the scheduler for a start with a non-person trigger after Try again, Go ahead without, Send
answers, Redo, Mark done anyway (when something waited), a late hooks approval, a cannot-run
card, a findings card and a rebuild card; the budget wake started a session when a raised limit
gave room; the git host watcher started one for a failed check or a comment; every credential
wait started a session at the reset, whoever had started the work. The bench walk of 2026-11-15
(`/tmp/frbench/fix-d1109-starts-engine/before`) pressed Try again on a failed card and a
`message` session ran. Quiet hours were read through a port nothing set, so they held nothing;
schedules wrote their fired key before their start left the line; a start carried no "who asked".

## Decision

1. **Who asks** (`StartRequest.by`, `triggers.ts`): `person` (Start, Approve and start,
   Continue, Use API key, "run it now" in chat after its read-back, a phone's Start press, the
   palette), `schedule` (a schedule; `personSchedule` when the person set it), `hands_off` (the
   project's "Start a session by itself") and `continuation` (the person's own session going on
   after a credential wait). Older requests read their trigger (`startByOf`): `manual` and
   `remote` are the person's, `schedule` a schedule's. The session's plan keeps it
   (`plan.startedBy`, with `continues` and `continuesAt` for a continuation).
2. **Quiet hours hold every start the person did not press**, read from the person's
   `notify_prefs.quiet_hours` in their time zone, refreshed before every tick, every start that
   is not the person's and every sentence that names their end. A held start runs once they end
   ("Ready: it runs after your quiet hours."). A schedule's fired key is written only when its
   start leaves the line, so a held or refused one comes again.
3. **Everything else prepares work** (`session/prepared-work.ts`, `prepareWork`): every answer,
   every Tasks-row action that makes a task ready (Make ready, Resume, Go ahead without, Reopen,
   Redo, Try again), New task when ready, a chat change, a budget raise or reset and a Claude
   credential that serves again for work outside a person's session. Prepared work joins the
   project's running session when it fits that session's promise (point 4), else it waits for
   the next Start; the line it says is one of `preparedLine`'s ("It joins the session that is
   running.", "Ready: it joins this session if budget is left after its own tasks, else your
   next Start.", "Ready: it runs at your next Start.", "Ready: sessions are stopped; it runs at
   your next Start once you allow them again."). A card's Done line keeps the outcome
   (`change_card.start`) and says it ("Trying "X" again: it runs at your next Start."). An Inbox
   option that prepares work says before it is pressed what pressing it does, read when the card
   is shown by the same steps `prepareWork` takes (`preparedContextOf`, `preparedExplain`):
   "...; it joins the running session if it fits." while a session of the project runs, "...; a
   session starts for it by itself." with the hands-off setting on, "...; it runs at your next
   Start." otherwise.
4. **A session's promise** (`session/promise.ts`, `session/live-sessions.ts`): at its start a
   session promises the runnable tasks and the followers its work budget holds after them, in the
   plan's order (`cutFollowers`); the Start dialog shows the same split (`laterBeyond`: "1 more
   waits for a later Start"). A newcomer joins only when the work budget less what was spent and
   less the remaining estimates of its own and joined tasks holds the newcomer's estimate; a
   follower it does not hold is named once ("Left for your next Start: …") and waits. Nothing
   joins a session that is stopping (Stop after this task, a wrap-up) or in its last look.
5. **The hands-off setting** (`start_by_itself`, per project, off unless set; "When work is
   ready: Start a session by itself | Wait for my Start"): turning it on asks the person's yes
   with what it does; turning it off acts at once; only the person sets it (the chat's agent is
   refused in one sentence). On, prepared work the person or the system made ready starts one
   session for it (`by: "hands_off"`, the project's session cap), never for the agent's own
   tasks, never in quiet hours or while sessions are stopped; a start that cannot run now is kept
   on the project (`summary_cache.start_pending`) across a restart and asked again once it can,
   once.
6. **The continuation** (`limits.waiting[].kept` on the billing source): a session the person
   started (or a continuation, or a schedule the person set) that ends to wait for its Claude
   credential keeps one continuation with the rest of its budget; at the reset (or when a new
   credential is saved, or another credential may serve the work) the wake starts it once
   (`by: "continuation"`, `trigger: "budget_reset"`), its first line "Goes on with your session
   of 14:05.". Quiet hours hold it, and every sentence that says when it goes on (the session's
   end, the task rows, the log, the project's status, the Start check) names the later of the
   reset and the end of the quiet hours ("Waits until 17:00 (after your quiet hours); then your
   session goes on."). Cancel (`POST /projects/:id/continuation/cancel`), Stop all
   and removing the project drop it; none is kept for a session the person stopped, one that was
   wrapping up, or one with nothing of its budget left. One wait per project: a Start pressed
   while it waits starts nothing and says when it goes on ("Your session of 10:00 goes on by
   itself at 15:00."). Continue on an ended session (`POST /sessions` with `continues`) goes on
   with the rest of its budget, refused in words when none is left. The words of a wait say what
   happens: "; then your session goes on." for the person's session, "; then it runs at your next
   Start." for other work.
7. **Chat** (S-11): `session.start` said in chat or voice is read back for the person's yes at
   any budget (`askFromChat`); the parser reads "run it now", "start it", "run the tasks",
   "let's run it", "starte es" and "jetzt ausführen" as a start. The definitions the chat model
   reads say that answers and task changes start nothing (asserted word for word).
8. **CI results and pull request comments** reach the agent's inbox and are audited as
   `waits_start`; they start nothing, with the setting on or off.
9. **Edits apply before a task starts, never during its run** (S-8): at the claim the runner
   takes the claimed row's title and the specialist the person set over the plan's, before the
   specialist is chosen and the start line is said; its wording, criteria and notes are read
   there too. An edit of a running task is refused ('"X" is running now: it is not changed
   mid-run; your note goes into its next attempt.') and the note it carries is kept. The
   estimate the session promised stays as planned (re-pricing it at the claim is left: the
   area's report names it).
10. **A Start pressed while the credential is out is kept** ("Start at 15:40",
   `RuntimeApp.continuations.keepStart`, `keepStartAtReset`): when the Claude credential the work
   needs rests at its usage limit, nothing is kept for the project and no session of it runs,
   `POST /sessions` (the Start dialog, Continue where it stopped, the phone) keeps one person
   start on the wait (`kept.by: "person"`, with the budget, the session it continues and the
   note given) and answers `kept` with when ("A session of Quote page starts at 15:40."); no
   session runs now (before, one ran only to meet the wait). At the stop's end the wake starts it
   once, by the person: quiet hours do not hold it, since the person chose that time. The Start
   button reads "Start at 15:40" and the project's status "Starts at 15:40 (your subscription's
   limit): 1 task"; Cancel the wait drops it like a continuation. It survives a restart and is
   made once.
11. **The one exception on this computer: the critic's monthly calibration.** It is a schedule
   nobody pressed Start for (on by default, `by: "schedule"`, ADR 0060): it grades the golden
   eval set so the critic's catch rate and drift are known, does no project work and spends
   within its own cap. The owner kept it monthly and on (answer 6); quiet hours hold it like every
   schedule, and the running-session indicator shows it with words saying what it does
   (d1109-run-visible, sub-run C5).
12. **D8, what runs now is visible everywhere (appended 2026-11-16, d1109-run-visible, sub-run
   C5).** The owner, 2026-11-09: "it should at least be very clear to a user when a run is
   ongoing. That should also be very visually clear no matter where the person is." One run state
   in the daemon's words (`daemon/run-indicator.ts`, `GET /running`, the `run.changed` event,
   `/health.running`): 'Quote page · the coder works on "Style the page"', '... · the critic
   checks "X"', '... · picks the next task', '... · wraps up "X" at its budget', '... · stops
   after "X"', "· then Garden site" for a person's start that waits behind it, and the critic's
   monthly check (point 11) as "Forerunner · the critic's monthly check on known examples" with
   one sentence of what it is for in the credential it runs on, stoppable with Stop now and Stop
   all. It is shown as one element under the header on every page and at every width (with Stop
   after this task, Stop now and Stop all), as Home's and the Overview's Working now, as Talk's
   first line, in the Sessions list's working row, in the tray (its first item, its tooltip, a dot
   on its icon) and in the window's title. **A person's session waiting to go on** after a
   credential wait (point 5, the continuation) is shown too, with **Cancel**: "Quote page ·
   waiting until 15:40, then it goes on" (after a refusal "waiting for a new API key, then it
   goes on"; when quiet hours end later, their end), and Cancel drops the continuation ("Nothing
   starts when Claude is back; its tasks wait for your Start."); a Start kept for the reset (point
   10) reads "Starts at 15:40" with Cancel on the project's line and on the page of the session
   that ended to wait. The project's line says what waits to start ("Starts after your quiet
   hours", 'Starts after the session on "Quote page"', "Ready: 3 tasks wait for your Start"), and
   an Inbox answer that readied work for the next Start offers Start beside its Done line while no
   session of that project runs. A waiting session leaves the window's title and the tray's dot
   as when nothing runs: they mean a session runs now. Every sentence is at most 80 characters,
   names no id and no raw state; the phone shows the same words later from `GET /running`.

## Consequences

- A paid session never starts without the person's press, their schedule or their setting; the
  log, the Sessions list ("started by itself when work was ready", "goes on with your session of
  10:00") and every line say which.
- An answer is cheap to give: it never starts work by surprise. The cost is a Start more for a
  person who wanted the old behaviour; the hands-off setting gives it back per project.
- `resumeWork` is gone; every answer path calls `prepareAnswer` with the daemon's
  `PreparePort`, and a one-shot without the port says nothing about a session.
- The quiet-hours reader, the kept continuation and the kept hands-off start survive a restart
  and are made once (each leaves its record as its start leaves the line, and goes back if the
  start fails).
- The chat's tool text grew by 156 tokens a turn (the four task moves' clause, `session_start`'s
  read-back and `settings_set`'s new key).
- **Known gap: the cloud runner.** `services/cloud-runner/src/inbox-trigger.ts` still asks its
  scheduler for a session with trigger `message` on a new message from another agent or an
  answered request (spec E.1), so an answer given while a project runs on the cloud runner
  starts work there. The cloud runner was out of scope this round; it is brought in line with
  this decision in a later round. Nothing on this computer depends on it.
- **Known gap: a start said in chat during a stop.** Chat's `session.start` (after its yes) is
  not kept for the reset as a Start pressed in the dialog is (point 10): its session meets the
  wait and keeps the person's continuation, which quiet hours then hold. Its read-back and its
  words stay true.

## Alternatives considered

- **Answers start a session when nothing runs** (the old design 3.8): rejected by the owner.
- **Option A (prepared work never joins a running session)**: rejected; option C keeps what the
  person makes ready while a session runs in it when its budget has room.
- **Option B (it always joins)**: rejected; it would break the session's promise and its budget.
- **A continuation for every credential wait**: rejected; only the person's own session goes on.
- **Settings-wide hands-off**: rejected for now; per project, off (the owner's default).

## Amends

0053 (plan approval: Approve and start is the person's start; Approve alone prepares), 0060
(monthly jobs: a schedule's fired key is written when its start leaves the line, held by quiet
hours), 0075 (git host triggers start nothing), 0088 (a late hooks approval prepares its task),
0100 (a credential wait goes on by itself only for the person's session), 0102 point 2 (the Tasks
tab's actions prepare work and say what happens next), 0112 (a raised or reset budget prepares
the paused task; Continue is the person's start). Appended to 0116 point 14 (the Sessions list's
words for `hands_off` and `continuation`).

## Amendment 2026-11-22: a dependency change says when the task runs (l4-chat-depth, run L4)

Live check 4 (L4-session-3): 'make the FAQ task depend on the README task', yes, answered
'"Write the FAQ" now waits for "Write the README".' and nothing about when it runs; removing the
last task it waited for prepared no work, against point 3 ("a chat change prepares work and says
a line"). `task.dependencies` now says when a ready task runs: one that still waits says after
what and when ("It runs after it is done, at your next Start.", "..., in this session if budget is
left, else your next Start." while a session of the project runs), read-only; one this change made
runnable is prepared as any move that makes a task ready (it joins the running session if it fits,
else "It runs at your next Start."). The Tasks drawer's **Change what it waits for** runs the same
command, so it says the same. A paused, draft or done task gets no line.

## Amendment 2026-11-23 (l4-starts-sessions, run L4, L4-money-203): a task too large for the session

The admit of a running session (option C) has a fourth answer, `too_large`: a task whose
estimate alone is more than the session's whole work budget never joins it (D4: it runs in its
turn at the person's next Start), so its line never says it may join. Before, it got the same
`no_room` as a task that only lacked room now, and Make ready on a CHF 1.10 draft during a CHF
1.00 session said "It joins this session if budget is left after its own tasks, else your next
Start." (live check 4, LC-C18). Now: '"X" is ready. It is larger than this session's budget, so
it runs at your next Start.' (`preparedLine('too_large')`); an answer's Done line says the same,
and its Start offer shows once no session of the project runs. Several tasks answered at once
read `too_large` only when none of them joined or may join.

## Amendment 2026-11-23 (l4-starts-sessions, run L4, L4-money-204): a raised limit wakes at the write

A task paused at the project's budget or this month's cap goes on once the person raised that
limit (S-3, ADR 0112): until now only the scheduler's refresh before each tick (up to 30 s)
woke it, so ten seconds after a raise the Start dialog still said 'Nothing can run: "Write the
club motto in motto.txt" needs your answer.' (live check 4, L3-run-10), and Settings' line named
only the new amount. Now `budget.set` asks the daemon to wake such tasks right after it writes
the limit (`CommandPorts.limitChanged`), and the start check, `POST /sessions` and chat's start
check wake first; the tick stays the fallback (a new month, the subscription's share). The wake
prepares the work (it joins a running session if it fits, else waits for the person's next
Start; the hands-off setting starts one as built): it never starts a session by itself. The
change's sentence says what became of the tasks ("1 paused task is ready again: it runs at your
next Start.").

