# 0116 — A project lists its sessions

Date: 2026-11-09
Status: accepted

## Context

The owner's decision D2 of 2026-11-09 answered "Yes." to "should a project have a list of its
sessions?": every project has a list of its sessions (what each did, spent and how it ended),
each opening the session's page. Before it, the Overview showed only the last session, the
address `/projects/:id/sessions` fell back to the Overview, `GET /sessions` gave the agent's
newest 100 raw rows with the stored result, and:

- what a session did was kept in full only for the project's last session
  (`summary_cache.last_session.outcome`); an older session's row kept ids, failed and needs-you
  merged in `handoff.blocked`;
- one session read two amounts: the session page showed the row's USD counter at today's rate,
  the result's cost sentence the ledger's CHF as booked; after a rate change or a stopped run's
  late booking (R-lateusage) they differed;
- a planning call's row read "intake: Quote page (completed: 2 docs)", its failure words lived
  only on the project's latest intake state;
- an ended session read "Waiting for a Claude credential" after the credential was back, and
  "Waiting for you: approve the plan" after the plan was approved;
- a session a crash interrupted ended at the recovery's time, so one that died on Friday and was
  recovered on Monday read three days long.

## Decision

1. **Place.** Sessions is the first tab behind More ▾ (Sessions, Plan, Docs, Reviews, Costs,
   Data) at `/projects/:id/sessions`; the Overview's Last result links "All N sessions" from two
   sessions on and every session page links "All sessions". Design §6 keeps four primary tabs
   for the daily loop; the list is looked back on.
2. **The heading is the count** ("14 sessions"), never a total: the Costs tab is the one place
   for a project's totals (they also hold chat and planning outside sessions, design §5 rule
   10).
3. **A row is two lines and one link**: the gist (one sentence, at most 100 characters), then
   when, how long, task counts, how it ended, what it cost on which credential, and how it
   started when not by a plain Start. The working session(s) sit on top in the project status's
   working sentence ('Working on "Style the page" (3 of 7 done)') with "CHF … so far"; no Stop
   on the row (the session page and the header have it).
4. **Order and paging.** Newest first by start (created_at, then id), 20 a page, at most 50,
   "Show older sessions" with an opaque keyset cursor (the last row's start and id), which stays
   valid across a restart; a session starting meanwhile never shifts or repeats a row. On screen
   too: once older pages are shown, the tab reads on down to the oldest row shown and keeps the
   cursor after it, so a session that ends meanwhile joins the top and pushes no row out of view.
5. **Listed**: every session of the project that ran a task, spent money or works now, planning
   calls included; never the conversation's row, never a session that ended without a run and
   without a ledger row (an automatic start that found nothing is not news, design §4.8).
6. **Chat** is one line under the list ("Chat about this project: CHF 0.30." with Open Chat),
   only when above zero: chat is one conversation, not sessions (design §3.9).
7. **One figure per session, read when it is shown**: the cost ledger's CHF sum for the session
   as booked (ADR 0008, U-074), used by the row, by `SessionView.spent` (the session page's
   "Spent of this session's budget") and by the result's cost sentence on the session page and
   the Overview, which `resultTextNow` rebuilds at read time from the stored outcome's
   `spentChfMicro` with the result's own cost builder and replaces with the one for the ledger's
   sum. **No stored text is rewritten.** A stored text without that exact sentence (a row from
   before this ADR) is shown as stored, beside the ledger's figure. **An Update or a
   notification already sent keeps the amount it said**: it is news of that moment.
8. **Credential words**: "CHF 0.80 on your API key", "CHF 0.80 of your Claude subscription's
   allowance" (a subscription is measured against its allowance, never charged), "CHF 0.80 of
   your plan credits", "CHF 0.80 on your API key and your Claude subscription" when both paid;
   none on the stand-in; amounts under a centime read "less than CHF 0.01".
9. **The record.** At its end every session writes `handoff.outcome` (the named
   `LastSessionOutcome`) on its own row, from the runner and from the recovery; a planning call
   writes `handoff.planning` (its failure words, redacted and without ids); the plan's size and
   fate are read from the plan card whose `session_id` is the row's. Rows written before this ADR
   fall back to `handoff.done` (named from the tasks) and `handoff.blocked` ("2 left for you").
10. **How it ended**: one map, the session page's (`sessionStatusText`), with past tense for an
    ended session's two present-tense states ("Stopped to wait for a Claude credential", "Ended
    with a plan for you to approve"); a planning call's page reads "Drafting the plan", "Plan
    drafted", "Planning failed".
11. **Length**: a session a dead process left (ended by the recovery or a later Stop) ends at
    the last line it logged (`handoff.last_worked_at`), not at the recovery.
12. **The session page** lists "Tasks in this session" (title opening the task's drawer, what
    happened there, "now: …" when different, the CHF this session spent on it, which follows
    the session's spend while a task runs) and links "All sessions".
13. **Routes**: `GET /projects/:id/sessions` and `GET /sessions/:id/tasks` are new; `GET
    /sessions` keeps its shape (planning words and the one figure only). Every word is the
    daemon's (ADR 0102: the screens and the phone show the daemon's words), in
    `packages/runtime/src/daemon/session-list.ts`.
14. **Who started it**: `startedByWords` reads `plan.startedBy` (`{ by: "person" | "schedule" |
    "hands_off" | "continuation", continues? }`, written by the start's engine from run C3)
    first, then the trigger for older rows: "started on its schedule", "started from your
    phone", "started by a pull request comment", "started by CI". A plain Start, an answer's,
    Continue's or a limit change's start (trigger `message`) and the old credential wake
    (`budget_reset`) say nothing. The words for `hands_off` and `continuation` are added in the
    same function by the area that writes them.
15. **Rows never move between projects**: a project joined into another keeps its sessions, and
    the ledger is never rewritten.

## Consequences

- A project's sessions read the same after a restart and after later sessions; nothing is
  re-derived from logs.
- The session page, the list and the Overview cannot show two amounts for one session.
- Later areas change only named functions of `session-list.ts`: the chat's recall reads
  `sessionGist`, `spentWords` and `projectSessionsView`; the joined project's line is added in
  `projectSessionsView`; the start's engine adds its words in `startedByWords`; the run view
  re-points `workingWords`.
- The feature only reads and spends nothing; no budget, cap or plan-share rule changes. Task
  titles and failure words are shown as text and given to no model here.

## Alternatives considered

- **A fifth primary tab**: rejected; design §6 keeps four for the daily loop.
- **A total in the heading**: rejected; it would differ from Costs by the chat spend (one fact in
  two places).
- **Rewriting the stored result after a late booking**: rejected; fragile, and an Update already
  sent would disagree with its own session.
- **Offset paging**: rejected; a session starting between two pages would shift and repeat rows.
- **Keying "started by itself" on the trigger alone**: rejected; it would be untrue for an
  answer's start or a Continue, which carry the trigger `message`.

## Amendment 2026-11-16 (ADR 0118, d1109-starts-engine): point 14's words for the new starts

`startedByWords` reads `plan.startedBy` as the start's engine writes it: `hands_off` is "started
by itself when work was ready", `continuation` is "goes on with your session of 14:05" (its
`continuesAt`, else "goes on with your earlier session"); `person` says nothing, except "started
from your phone" for a phone's start; `schedule` is "started on its schedule". A session's first
log line for a continuation is "Goes on with your session of 14:05.".

## Amendment 2026-11-16 (ADR 0117 amended, d1109-onerepo-join): a project that joined another

When the person makes one project of two that used one repository (ADR 0117's amendment of
this date), the closed project's sessions stay its own: they are not moved, so each row still
says what that session did, spent and how it ended in the project it ran in. The kept project's
list says they exist instead: `ProjectSessionsView.joined` has one line per project that joined
it, on the first page only ('"Kite club" had 3 sessions before it joined.'), with Open to that
project's Sessions tab, which still lists them. The heading's count stays this project's own;
no joined session is counted twice or shown in the kept project's rows. After Undo the line is
gone. The chat's recall of the kept project reads the joined project's sessions as well
(`conversation/scope.ts` `withJoined`), so "what did Kite club's last session do" is answered
from "Site".

Dated note, 2026-11-22 (l4-money-pause, run L4, L4-money-104 and L4-selftasks-107): the session's size is its promise on every screen: the plan's clause counts no task that comes after a larger one as cut, and the session review measures the promise's tasks against the promise's figure plus what joined it.

Dated note, 2026-11-22 (review of l4-money-pause, L4-github-110): the session's Details say its size once, as the promise ("It promised 3 tasks, about CHF 0.34."). With a promise, the Plan line says only how the tasks were chosen ("Plan: the first session you approved with the project plan, in its order."; before: "Plan: 1 task, about CHF 0.09 ... 1 task in its order" beside the promise of 3), and notes given to a task read "Gave 1 note to "X".", never "for the next session".

## Amendment 2026-11-23 (l4-starts-sessions, run L4, L4-money-201): point 5, who is listed

Live check 4 (LC-C21) pressed Start with only a refused API key: the session met the key's mark,
stopped at once to wait (no run, no ledger row), and the Sessions tab said "No sessions yet."
while the Overview's Last result opened it and the next session said it "goes on with your
session of 07:24", a row the list never showed. Point 5 now reads: listed is every session of
the project that ran a task, spent money, works now or planned (as before), and also every
session the person started (`plan.startedBy.by` 'person') or that goes on with one
('continuation'), and every session that ended to wait for its Claude credential
(`handoff.stop_reason` 'credential_wait'), with or without a run. An automatic start (the
schedule, the hands-off setting) that ended without a run and without a ledger row because it
found nothing stays out: it is not news (design §4.8). Rows written before `plan.startedBy`
keep the old rule. The heading's count and the Overview's "All N sessions" use the same rule.

## Amendment 2026-11-23 (l4-starts-sessions, run L4, L4-money-213): one count for what needed you

A row of a session that ended with tasks that needed the person read '2 needed you · Ended: 1
task needs you' (live check 4): two counts for one thing, one from the session's record, one from
what waits now. The row keeps the record's count and says what still waits in one count: '2 needed
you · 1 still needs you' ('Done' once nothing waits). The session page's badge is unchanged (L-21).

