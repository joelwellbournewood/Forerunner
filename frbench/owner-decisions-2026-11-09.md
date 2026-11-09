# The owner's answers of 2026-11-09 (verbatim, then what they mean for the work)

Asked: the open questions after wave 15 run A (see NEXT-SESSION.md 'Open owner questions').

1. GitHub test token: "i updated the token in the project settings."
   - The environment variable FORERUNNER_TEST_GITHUB_TOKEN holds the new token from now on; a
     running container keeps the old value until the session restarts (environment variables
     apply at session start). Live check 3 needs a session started after the update.

2. Close forerunner-sandbox pull request #5 (the old status PR live check 2 wrote into): "if it
   will not cause problems, yes. If it will, think of a better solution."
   - Done 2026-11-09 13:49 UTC: #5 belonged to the test project "Sandbox hello page" of a bench
     whose home was deleted; nothing reads it. The fr/status branch stays.

3. Two projects on one repository (W15-112): "There should not be 2 projects in one repo. If
   there are multiple people and agents, and even if they are working on different parts of a
   bigger project, they should be working on one project. Make it such that multiple projects
   are not done on one repo, in an intelligent way."
   - Decision D1: one repository belongs to one project. Linking a repository that a project
     already uses (on this computer, or another person's project, seen from the repository
     itself) offers that project instead of making a second one; people and agents working on
     different parts of a bigger whole work in one project (wave 8's sharing is how a second
     person joins). Existing duplicates get a clear, safe way to become one.

4. A project's sessions list (W15-111): "Yes."
   - Decision D2: every project has a list of its sessions (what each did, spent, how it ended),
     each opening the session's page.

5. Chat and the open cards (W15-148, design §3.9): "chat should be able to intelligently/
   selectively recall anything that has been recorded. Chat should also be able to use more
   effort or a better model, selectively and transparently, in order to be more useful, knowing
   that this will take more time to reply. There should be something indicating what the chat is
   doing when waiting. If this can be harmonized together with viewing only open cards for short
   answers, it makes sense. We are trying to both balance and be flexible with time and tokens
   spent vs quality and relevance of the reponse."
   - Decision D3: chat answers short questions fast from a small context (this project's open
     cards and state), recalls anything recorded on demand (tools that look up history, tasks,
     sessions, cards answered, lessons, decisions, documents), and escalates effort or model
     selectively and transparently when the question needs it, saying so and showing what it is
     doing while the person waits. Spend stays within the budgets and is visible.

6. Tasks-row Redo / Try again starting work (wave7g6-triage owner_questions[0]): "I am not sure
   what you mean, explain the issue in more detail." (explained 2026-11-09; awaiting answer)

7. 'Wait' and a refused API key etc. (U-078, owner_questions[1..3]): "same here" (explained
   2026-11-09; awaiting answer)

8. A task whose estimate alone exceeds the session's work budget (W6-23): "it should get a
   warning, but it should get done anyway. when the budget will run out, it should be the case
   that the agent will do as much as it can, and wrap up in an organized and error free way such
   that the work can be continued in the next run."
   - Decision D4: such a task starts (after the Start dialog's warning), works until the budget's
     wrap-up line, then wraps up cleanly (work kept as a commit on its branch, a handoff of what is
     done and what is left), pauses with one card, and continues from there in the next run. No
     limit is passed.

9. Delete the ~14,000 old test folders in /tmp (fr-*, forerunner-test-gitconfig-*): "ok"
   - Approved. The session's auto-mode safety check blocked the deletion on 2026-11-09 13:47 UTC
     ('Shared Scratch Sweep'); not worked around. Needs the owner to allow it (a permission rule)
     or to run it themselves.

10. Delete the four merged backup branches claude/nifty-knuth-f9udt0-backup/fix-*: "try again in
    a new session using new token if needed."
    - The auto-mode safety check blocked `git push --delete` ('Git Destructive') on 2026-11-09;
      not worked around. The token is limited to forerunner-sandbox by the owner's earlier rule.
      SHAs recorded in /tmp/frbench/backup-branch-shas.txt.

## Follow-up answers, 2026-11-09 (after the explanations)

10 (again). "try to do this part yourself in a new session with my permission" (the four merged
    backup branches). Session session_01RnhAjdXMZfF5wFJuSmg7km was started for it with the four
    SHAs, plan-files and the work branch excluded.

6. Tasks-row Redo / Try again / Reopen: "I want to use C, but I have questions. will tasks start
   their own runs in general? Are you saying a task will have its own run when it is reopened? Can
   the system update and reopen and its own tasks if I dont manually do it? E.g. if I say, since it
   didnt run last time re-open it? Let me know how this should all fit together."
   - Decision D6 (option c, with the session lead's proposal of how it fits, sent to the owner on
     2026-11-09): actions that ask for the work now (Redo, Try again; also Resume of a task the
     person paused) start work the same way an Inbox answer does: the task joins the running
     session, or a session of the project starts and runs everything ready. Actions that only bring
     a task back (Reopen of a cancelled task, Make ready of a draft) start nothing: the next session
     takes them. Chat can do any of these when asked in words, with a yes/no first and an Undo
     after. The system on its own retries inside a session up to the retry limit, continues paused
     or waiting work when its limit or credential comes back, and never reopens done or cancelled
     work or retries past the limit without the person.

7. 'When my first choice runs out' (U-078):
   a) "allow the task to be completed by the API, but in a transparent way. It should also be
      possible to give a framework for what to use when ,and then the system just does it. e.g.
      use subscription until runs out --> go to API automatically, or use use subscription until
      runs out --> go to API after asking human, or go to API by default, etc..."
   b) "design it such that it works together with my answer for a). It should definitely not
      automatically do something even when told to wait or showing that it is waiting."
   c) "If a credential is refused, follow the frameowrk for a) or b) as if it has run out, but also
      give the user some kind of notification or information."
   - Decision D5: one credential policy the person sets (a small set of clear presets plus the
     order): which credential first, and what happens when it runs out — go on with the next one
     automatically, ask first (one card: continue on the API key at about CHF N, or wait for the
     reset at a time), or wait. Running out includes a usage limit, a plan-share cap and a monthly
     cap; a refused credential follows the same policy as running out and also tells the person
     (what was refused, how to fix it). Whatever the policy says is what happens, shown in words:
     when the app says it waits, nothing moves; every switch is shown on the task, the session and
     the spend, with its cost.

## Second follow-up, 2026-11-09 (sessions, starts and the agent's own tasks)

- Session budget and joining work: option C ("Join only if it fits"): "the session keeps its
  promise and spare budget isn't wasted, I think that's probably the best."
- When sessions start (owner's words): "the management of the tasks should be able to feed into
  sessions that are already running when appropriate, and it should be dynamic as much as
  possible. But it should also be the case that the user clearly states when a session will run,
  such that they could maybe queue up tasks and then change things and then also give some text
  context into the chat or to tell the project something and only then run a session. Because now
  it might run sessions when I'm in the middle of giving it instructions but haven't yet kind of
  fully figured out what I wanted to do, and maybe I will also tell it things in between
  sessions."
- The agent's control over its own tasks: "I would also like that being talking to the agent
  would also allow the agent to have dynamic control over its tasks. So for example, if I say set
  this up and I approve a plan and then it adds a bunch of tasks, I want it to be able to fix its
  tasks. Like as part of a run, it should be able to do things like that."
- Session lead's proposal sent back (awaiting confirmation): D6 becomes 'the person says when a
  session starts' (Start, Approve and start, 'run it now' in chat, Continue on a budget card, a
  schedule they set; an optional 'start by itself when work is ready' setting, off by default);
  everything else (answers, Redo, Try again, Make ready, Resume, budget raises, a credential
  coming back) prepares work: it joins the running session if it fits (C), else waits for the
  next Start, said in one line. D7: the agent keeps its own task list right during a run and in
  chat (fix wording, split, add a missing step, reorder, change what waits for what, drop a
  duplicate), each change shown with one Undo, never raising a budget or adding work past the
  session's budget, approval by autonomy level.

## Third follow-up, 2026-11-09 (confirmed)

- "All this sounds good except the status line that notifies you if work has waited a few hours.
  I think that's not necessary. We don't need notifications like that, but it should at least be
  very clear to a user when a run is ongoing. That should also be very visually clear no matter
  where the person is."
- Confirmed: "Only when you say so" is the default, the hands-off setting optional (off).
- Confirmed: the agent changes its own tasks, the autonomy level deciding when it asks first.
- "Try to build those in."
- So: D6 = the person says when a session starts; prepared work joins a running session if it
  fits (C), else waits for the next Start; no reminder notification for waiting work. D7 = the
  agent keeps its own task list right during a run and in chat, bounded by the budget and the
  autonomy level, every change shown with one Undo. D8 = a running session is unmistakable on
  every screen (the header and navigation on every page, Home, the project, the Talk panel),
  with what it is doing and how to stop it.

## Session lead's notes after the two run C designs (2026-11-09 16:35 UTC)

Two points the D5-D8 design listed as open are already answered by the owner's confirmation of
the roll-up ("All this sounds good except the status line ..."), and are NOT open:
- A session the person started keeps going by itself until its work is done, including after a
  credential wait inside it: when the credential is back (the reset), that session goes on by
  itself (that is what 'wait' means). It is the person's own start continuing, shown on the run
  indicator while it waits ("Waiting until 15:40, then it goes on", with Cancel). It never moves
  onto another credential unless the policy says so. A NEW session after a stop the person did
  not start still needs the person (or the hands-off setting).
- The agent changes its own tasks without asking from Standard up; at Advisor and Assisted it
  asks first on one card (the session lead's proposal, confirmed by the owner).
