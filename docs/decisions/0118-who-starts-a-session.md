# 0118 — Who starts a session

Date: 2026-11-16
Status: accepted

## Context

The owner's decision D6 of 2026-11-09: "only the user should start the session, the user clearly
states when a session will run", with option C for work made ready while a session runs ("it
joins the running session if it fits, else it waits for the next Start"), the hands-off setting
optional and off by default ("Off by default with the hands-off setting optional. Yes, that
sounds good."), and, for a session the person started: "A session the person started keeps
going by itself until its work is done, including after a credential wait inside it". CI results
and pull request comments start nothing, also with the setting on ("fine", answer 9).

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
   (`change_card.start`) and says it ("Trying "X" again: it runs at your next Start.").
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
   of 14:05.". Quiet hours hold it; Cancel (`POST /projects/:id/continuation/cancel`), Stop all
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
