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
  entries are shown as what the agent's check noted, never as a line of a report.
