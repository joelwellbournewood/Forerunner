# 0119 — The agent keeps its task list right

Date: 2026-11-16
Status: accepted

## Context

The owner's decision D7 of 2026-11-09 (`/tmp/frbench/owner-decisions-2026-11-09.md`, quoted as
written): "I would also like that being talking to the agent would also allow the agent to have
dynamic control over its tasks. So for example, if I say set this up and I approve a plan and then
it adds a bunch of tasks, I want it to be able to fix its tasks. Like as part of a run, it should
be able to do things like that." The session lead proposed "the agent keeps its own task list
right during a run and in chat (fix wording, split, add a missing step, reorder, change what waits
for what, drop a duplicate), each change shown with one Undo, never raising a budget or adding work
past the session's budget, approval by autonomy level"; the owner answered "All this sounds good
except the status line that notifies you if work has waited a few hours." and "Try to build those
in."; the session lead recorded the confirmation as "the agent changes its own tasks, the autonomy
level deciding when it asks first". On work that joins a running session, D6's option C
(ADR 0118): "the session keeps its promise and spare budget isn't wasted".

Before this decision a plan, once approved, changed only by the person. A specialist that found
its task was two jobs, or that a step the work needed was missing, could say so in its report; the
words reached nobody who could act on them. The critic's notes about problems a task did not
cause were kept on the review and read by no planner. The commands had no split, no step before a
task and no drop of a duplicate; the change log had no source for a session's own change.

This ADR is run C's sub-run C4 (`d1109-selftasks-run`, the run). Chat's own task changes (C6,
`d1109-selftasks-chat`) and the held branch of the call on a resting credential (C5,
`d1109-cred-engine`) build on it.

## Decision

1. **A class of its own** (`plan_fix`, `enforcement/autonomy.ts`): the agent's fixes of its own
   task list are free from Standard (level 2) up and ask first at Advisor and Assisted. An
   extension can never declare it.
2. **The brief asks for evidence**: every specialist's brief ends with one line asking it to end
   its report with "For the task list:" and one line per point when the task list itself is
   wrong ("Say only what you saw; the project's agent decides."); rung 2 of the retry ladder
   points to it.
3. **A check at a task boundary**: between two tasks of a session, when a report carried such
   lines, the critic left notes the task did not cause, or notes were kept from a session that
   ended (on the project, across a restart), the session makes one planning call: no tools, no
   paths, no secrets, the planning model at effort medium, 4096 tokens, at most three checks a
   session. Its cost counts in the session's spend; no call is made when its cap does not fit the
   room left after the session's promise. One check of a project at a time.
4. **The evidence is data**: the lines are quoted in the message inside the data envelope; a line
   that reads like an instruction (the injection scan plus the steering patterns: budgets and
   money, settings and review levels, the autonomy level, other projects, starting, merging,
   deploying, dropping every task, a new role) is never sent to a model, is counted and is
   quoted to the person; alone, no call is made.
5. **What the reply may say**: five kinds (edit, split, add, order, drop), read strictly.
6. **The fence** decides whatever the model returns: only Draft and Ready tasks of this project,
   named by their exact title; a split keeps the task as its first part and carries every
   acceptance criterion; a drop only of a duplicate that never ran; no cycle; at most 12 changes
   and 6 new tasks a check and 10 a session. It asks first (whatever the level) for a flagged
   line, for the person's own task, for a new task's specialist that reaches further than the
   source's (the specialist reach rule), for work for ops-deploy or the person, for a specialist
   the approved plan has none of, and for more than one drop at once.
7. **By level**: from Standard up each change is made as the project's agent, one Changes row with
   the source `session` and its Undo, no Inbox line (the session's one Update counts them:
   "Quote page: did 3 tasks; changed 2 tasks."). At Advisor and Assisted, or when the fence asks,
   the set is ONE suggestion card per project ("Quote page: the agent suggests 2 changes to the
   tasks"): "Make these changes" makes them as the person, one Changes row, one Undo, each change
   checked again on the tasks now and a change that no longer applies left out and named; "Keep
   the tasks" changes nothing and the same set is not filed again that session; a newer
   suggestion replaces an older one. Filing the card does not stop the session.
8. **Nothing starts, nothing grows**: no budget, cap or wrap-up line is passed; new tasks join the
   running session only by the admit rule (ADR 0118: a part of a promised task within its
   estimate is the session's own; anything else joins if it fits after the promise, else waits
   for the person's next Start, said once: "Left for your next Start: ..."); no answer starts a
   session; no running task is changed and no other project is touched.
9. **What the person reads**: the check's one line in the session log ('Checked the task list
   after "Create the page": no change (CHF 0.03).'), each change's sentence, the result's 'Changed
   2 tasks: split "Style the page"; added "Check the links".' and the Update.

## Consequences

- The change log has a fourth source (migration 0009); the Changes page shows it as "In the app"
  until chat's task changes give it its own words (C6).
- `task.split` is not a chat tool until C6 (`chatTool: false`); `task.create` gains `before` and
  `why`, `task.transition` gains `duplicate_of`; a composed row's Undo says each change's own
  words in one sentence.
- The injection suite gains a `report` channel (report-001..006, controls 101 and 102); its
  report-003 found that "Autonomous" and "turn the review level off" read as plain notes, fixed.
- The bench's stand-in plays the check (`task-check <project id>`; `FORERUNNER_BENCH_TASK_LIST`).
- Known gaps: the reason given with a change does not yet reach the next brief as data, and a
  note an agent queues is recorded as the person's (L3-left-13); the brief's quoted parts (a
  kept-work check's output, a handoff note) have no injection channel yet (C2-left-14).

## Alternatives considered

- **The specialist changes the task list itself** (a tool in its run): rejected; a specialist sees
  one task and its folder, and a tool would let a page or file it reads reach the plan directly.
  It reports; the project's agent, behind the fence, decides.
- **Every change on its own card**: rejected; the owner asked for the agent to fix its tasks, and
  at Advisor and Assisted one card with one Undo is what the person can answer in one look.
- **Pause the session until the person answers**: rejected; option C keeps the promise, and the
  approved changes join by the admit rule when the answer comes.

## Amends

- Spec J's autonomy table (`docs/spec/forerunner-spec.md`), ADR 0030 (the command registry: a
  session source and `planFix`), ADR 0053 (an approved plan can change during its session, by
  the agent within this fence), ADR 0100 (the check is a planning call: interactive purpose) and
  ADR 0112 (a check's call is counted in the session's spend and never past its wrap-up line).
  Each carries a dated note.

## Amendment 2026-11-16 ('d1116-budget-all', ADR 0112's amendment of that date)

A split shares what is left of the task's budget after its work and its reviews (its figure holds
both), and the task check stays the session's spend: its Run row and ledger rows name no task.

## Amendment 2026-11-16 (d1109-selftasks-chat, run C sub-run C6: the chat part)

The owner, verbatim (D7, 2026-11-09): "I would also like that being talking to the agent would
also allow the agent to have dynamic control over its tasks"; confirmed: "the agent changes its
own tasks, the autonomy level deciding when it asks first".

- "fix the tasks" (the parser's pattern, English and German, no model call before it) and the
  chat model's `fix_tasks` tool (its only parameter the project) run this ADR's check with the
  person's line of the turn as the request (verbatim, at most 500 characters, in its own data
  envelope) and the notes kept on the project as the evidence. The rules' first paragraph has a
  chat variant (prompt `task-check@1.1.0`).
- Point 7 in chat: from Standard up each change is made at once as the agent's (source `chat`,
  one Changes row and one Undo each, no Inbox line); at Advisor and Assisted, when the fence
  asks first, or in a turn whose lookups returned records, the set is one read-back with Yes and
  No (one card in the Inbox), whose Yes after a restart makes it with no second check.
- Changes the person names in their own words stay their instruction and are read back; several
  in one turn are one question and one card.
- The check from chat is booked to the project, refused before the call when its cap does not fit
  the room the project's budget and the month cap leave, held by the credential policy (ADR 0120:
  no call, nothing booked, one sentence), one at a time per project; it starts no session.
- Where a change is stored and shown it says the agent made it; the session page has an Undo on
  each change line; Changes reads "In a session"; the suggestion card lists its changes open.
- The check's model is chosen as the intake's (the planning row, the principal's override, the
  project's highest model). An added step marks only itself as written by the agent.
- Open owner question (default built): "Fix the tasks" is chat only (and the agent's own check
  during a run), no button on the Tasks tab.

## Amendment 2026-11-17 (d1109-selftasks-chat, run C sub-run C6: after the area's review)

- A change read back for a yes, and the suggestion card's list, say what each change does: an
  edit names the fields it changes ('Change "Publish the page": priority to High.'), a new title
  alone is 'Rename "X" to "Y".', never "reword" (design section 3.9, section 5 rules 4 and 9).
  The session result names an edit as "edited".
- "review the tasks" and "go through the tasks" are not the parser's "fix the tasks" (a person
  often means "show me" them, and the check is paid and changes tasks at once from Standard);
  nor is a line whose words after "for", "in", "of" or "on" name none of the person's projects
  ("check the tasks for errors"). Both go to the chat model, which calls fix_tasks when the
  person asks for a fix.
- Two requests at once make one check: the second says the check runs and makes no call.

## Amendment 2026-11-22 (l4-selftasks-check, run L4 sub-run L4b: live check 4)

Live check 4 (2026-11-17, the real model) found the check paid for on harmless notes, hiding
what it left out, refusing a second missing step and keeping a Yes that changed nothing. The
owner's D7 (2026-11-09, verbatim): "I want it to be able to fix its tasks. Like as part of a
run, it should be able to do things like that."

- Point 3 (dated note): the evidence is exactly a report's "For the task list:" lines, a critic
  finding the task did not cause (it ends "(not caused by this task)": the runtime measured it)
  and notes kept from before. An ordinary critic note about the task's own work is no evidence:
  it makes no check and is not kept. The check after the session's last task stays (point 8).
- Point 9 (dated note): the check's line is a person-level line of the session log with its
  cost on its own row (its CHF beside it, so the person-level lines add up to the session's
  spend); a check that made no call (every line read like an instruction) stays under Details.
- Point 4 (dated note): a line that reads like an instruction is quoted to the person even when
  the check changes nothing: on the check's own line in the session log ("no change; a line of
  the report reads like an instruction and was left out ("…")"), and in chat under the reply
  (the footer, which is never sent back to a model). No new Inbox card. The model's own flagged
  entries are shown as what the agent's check noted, never as a line of a report, unless the
  evidence it was sent holds that line; a quote shows the line's request (the sentence that
  reads like an instruction or asks for something), cut at a word. The suggestion card names who
  wrote what it quotes the same way (a line of a report, a note of the critic's, the agent's
  check).
- Amendment 2026-11-17, its edit line (dated note): an edit's line on the suggestion card and in
  chat's read-back also says to what it changes what done looks like and the criteria ('Change
  "Write the FAQ": what done looks like to "…" and the criteria to "…".'); before, the person was
  asked for a Yes without seeing the new words (live check 4, LC-C18).
- Point 6 (dated note): a change may name a task an earlier add of the same reply makes (an add
  after it, a task made to wait for it): the fence checks each change on the state after the ones
  before it, as this point says, and the second missing step of one report is made in the same
  check. What the fence or the commands refuse is listed in words on a Details line of its own.
- Point 5 (dated note, widened on purpose): the check's message also carries what each task it
  may change and each task the evidence comes from (a Done one included) is to do, and the
  person's brief, inside a data envelope of their own; an added task that does work a Done task
  left undone carries that task's details word for word, and its brief and review say which task
  it continues. Before, run C's rule gave titles, criteria, status words and report lines only,
  and a step added for the person's booking form lost the fields and the address they gave.
- Point 6 (dated note, words): the fence's reasons name a specialist as a person does ("the
  writer", "the deployment specialist"), and say "the plan you approved" only for a project
  whose plan from the brief the person approved ("no task of Word count is for the writer yet"
  otherwise). Chat's read-back says why it asks first only at a level that would have made the
  changes at once; at Advisor and Assisted every change is read back anyway.
- Point 7 (dated note): Make one project moves the closed project's kept notes to the kept one,
  which keeps one open suggestion card (the older ones close as replaced; Undo opens them again).
- Point 9 (dated note, words): a left-out line is quoted at a word and without ids; a critic's
  note is named as the critic's; Costs names the check's spend "checking the task list", not
  "planning".
- Point 9 (dated note, 2026-11-22, the review of fix/l4-selftasks-check): a left-out line is quoted
  up to 100 characters (`QUOTE_MAX`), cut at a word with "…", also on the line of a check that
  changed nothing. The line was kept out of the check's request whole, so the part the quote cuts
  off was never acted on. Run L4's acceptance asked for the line whole; quoting it whole, or with a
  higher cap on that one line, is the session lead's to decide (one constant).

## Amendment 2026-11-23 (l4-selftasks-chat, run L4): chat's part

A change the person names in chat is theirs once they say yes (run C decision 52); the agent's
own fixes (fix_tasks' set, the session's) stay the agent's. A "fix the tasks" read-back waits
until it is answered, across a restart; its Yes after the task list changed says so and offers
the check again (run C decision 53). A merged card of fix_tasks and another change keeps the
planFix rules. A set refused at one change says that none was made.

## Amendment 2026-11-23 (fixup-l4-selftasks-chat, run L4): the brief has an injection channel

The known gap above (C2-left-14) is closed: `pnpm test:injection` has a `brief` channel that
plants text in a paused run's note, one item of its "Left to do" list and a failed project check's
output on its kept work, renders the next run's brief with the real `taskContextBlock` and judges
that the text is quoted as data on labelled lines and that the obedient specialist's calls are
refused (brief-001..003, controls 101 and 102). report-008 checks that a task for the researcher
after the coder's work waits on the card with the reach reason. The reason given with a change
reaching the next brief is unchanged.

## Amendment 2026-11-23 (l4-chat-carried, run L4): carried items

- Point 7 (dated note, C4-left-7): a suggestion card a crash left between its mark
  ("Making the changes…") and its apply is settled at the next start: applied once (its one
  change log row is found when the apply had run, else the changes are checked and made now),
  never twice and never left at "Making the changes…" (validation rule 4).
- Point 6 (dated note, C4-left-6 and L4-selftasks-129; ADR 0030 point 6, undo is state-based): a
  split's Undo puts back what the tasks after it waited for and cancels the parts, so after a
  later change to what one of them waits for (a step added before it) the Undo is refused in
  words naming that change, never done in part; undoing the later change first lets the split go
  back. A part a session holds reads "is running now", not "has run since".
- Point 9 (dated note, SC-13): the session review counts a planned task that was split, or
  dropped as the same as another, while the session ran as replaced, never as planned and left
  undone ("1/1 planned, 1 replaced"): a correct fix must not lower the session's grade. An undone
  change counts as before.

## Amendment 2026-11-23 (fixup-l4-chat-carried, run L4): a split task's first part that ran is measured

Point 9 above held a split task as replaced for the whole session. A split keeps the task as its
first part, so a first part that then ran and failed, or waits for the person, left every measure
and a session whose only planned work failed read "accepted (grade 100, 0 findings)". A split task
is replaced only while its first part has not run in the session (draft or ready, no work run, not
sent back or paused); once it ran it is measured as it ran. A task dropped as the same as another
stays replaced. The session page's line names the count: "Session review measured: 1 of 1 planned
task done, 1 replaced; …", or "1 planned task replaced; …" when that was the whole plan.

## Amendment 2026-11-23 (l4-selftasks-carried, run L4): what a fix set's Yes is judged on

Session lead decision 2026-11-23 (L4f-left-2), after the owner's 2026-11-17 answer that every
chat read-back waits until it is answered: a "fix the tasks" read-back's Yes is judged on the
tasks its set names (present, status, title, outcome, what they wait for) and on which tasks the
list holds. A session that finishes, or reprioritises, a task the set does not name leaves the
Yes valid; a named task that changed, or a task added to or removed from the list, gives "The
tasks changed since I checked them; say "fix the tasks" to check again." and changes nothing.
The fingerprint keeps each task apart (`v2|<id>=<hash>,...`, readback-check.ts); a card stored
with the older whole-list form is judged on the whole list, as then. The named task's priority
is compared by the card's own read-back (`changedSince`).

Every close of a chat read-back (a Yes or No in chat or the Inbox, a refused Yes, the phone,
email, a lapse) tells the screens once from the executor (`onClosed`): inbox.changed,
project.changed and, when no turn of that conversation is running, conversation.changed for the
conversation the card was read back in, so no header or Inbox badge keeps a stale "Waiting for
you" (L4f-left-1). The redirect guards judge a note by who wrote it, the person or the model,
also after a restart (L4-selftasks-120).

## Amendment 2026-11-24 (fixup-l4-selftasks-carried, run L4): a note goes with the card's answer

The review of the amendment above found that a move said in chat with a note, on a task whose
card offers the move, became the card's answer and lost the note unsaid, while the card's Try
again reads "Tries again with your note, if any". The note now goes with an option that takes
one (Try again, Send it back: the card's words say `input: "note"`): `moveAsCardAnswer` passes
it to `request.answer`'s new `note`, the read-back ends 'Note for its next brief: "Use the old
layout."' so the Yes covers it, and the card is answered `{ choice, note }` as the Inbox answers
it, so its handler queues the note for the task's next brief (the same queued note, quoted as
data in the brief, that the Inbox's Try again with a note gives). An option that takes no note
(Mark done anyway, Cancel task) answers with the option alone and its read-back names no note.
A card that needs the paired device is still answered on its card in the Inbox, whose Try
again has the note field.
