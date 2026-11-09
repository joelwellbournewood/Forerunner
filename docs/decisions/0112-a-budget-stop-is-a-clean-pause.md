# 0112 — A budget stop is a clean pause: Claude Code really stops, each run hears one wrap-up at its line, a run that stops or wraps up with work left is paused, and the stop names its real limit

Date: 2026-11-02
Status: accepted (the owner's decision of 2026-11-02 on budgets, "Q3 yes"; amends ADR 0105; the
'budget-resume' area amends it with the code-side save, the resume and the card)

## Context

The owner asked what happens when a task is too big for its budget
(`/tmp/frbench/owner-answers.md`, section 3, read in the code at `c8c16fb`):

- On the subscription a budget stop did not stop Claude Code. Forerunner's refusal ended only
  its own message loop; nothing aborted the Agent SDK's query, the run left the kill switch (so
  Stop now could not reach it) and the hooks still allowed tools after the run returned. Claude
  Code could go on editing the task's folder and using the plan's allowance, uncounted.
- Subscription usage was counted per streamed message: the messages of parallel tool calls share
  one id and one usage, and a message's output count is a placeholder, so input was counted
  twice and output too low.
- The agent was never told about its budget: the 80% decision was only a warning event, so the
  model started new work until the call that would go over was refused.
- A stop dropped the run's last words: the error replaced the report, and the next run read "It
  failed: The run failed: run budget would be exceeded".
- The limit was misnamed: a stop at the month's cap, the project's budget or the subscription's
  share read as the task's own budget whenever the task's cap was below the session's, so its
  card offered "Raise the budget", and Claude Code's own spending stop read as a passing error.
- A running task could eat the share of the session kept for reviews: its cap was what the whole
  session had left.

The owner chose option B (a stop becomes a pause) with C (Continue starts the next session at
once), built in this order: first the subscription's stop, then the wrap-up, the paused outcome,
the code-side save, the card and the resume. This decision covers the engine's part; the save,
the resume and the card are 'budget-resume''s, the better estimates and the caching 'cost''s.

## Decision

1. **The subscription's stop really stops Claude Code.** Every stop of an Agent SDK run that is
   not the kill switch's (a budget, the run's time limit, an error) aborts the run's controller
   and waits until Claude Code has exited before the run returns: what it still sends is read
   and its usage booked, for at most 15 s; then the query's `close()` ends the process and the
   run waits at most 5 s more. Meanwhile the run stays registered with the kill switch, so Stop
   now or a person's move of the task ends the wait at once. Every hook refuses from the abort
   on, and the run's token is revoked when the run returns, so a tool call that arrives later is
   refused and audited. The kill switch's own stop still returns at once, as its 2 s promise
   says. Claude Code's own spending limit (`maxBudgetUsd`) sits at the run's cap plus 10% and
   USD 0.01, so Forerunner's stop comes first, and its `error_max_budget_usd` result is a stop at
   the run's budget, never a passing error. While Claude Code winds down, a late result only
   books its usage: an aborted query's own error result does not turn the stop into a failure.
2. **Usage is counted once per API message**, and the result's totals (`modelUsage`, else
   `usage`) book what the messages did not count (the real output, subagents' calls).
3. **Each work run has one wrap-up line**, fixed at its first call: its cap less a reserve, the
   larger of a fifth of the cap and the worst case of two calls (the first call's estimate
   twice, from the shared estimate function, so better estimates change it without a change
   here). The call that would take the run past the line brings the wrap-up message, once:
   "About a fifth of this task's budget is left. Start nothing new, leave the files working, and
   end your report with Where I stopped: and Left to do: as a list." On the API key it is one
   text block after the last tool results of that request, never inside a tool result; on the
   subscription it is PostToolUse's `additionalContext`, once. Only a task's run hears it; chat,
   planning and reviews never do. The brief says what the two headings are for.
4. **The tiny-budget rule** (owner-answers.md section 3, option B: "On tiny budgets 20% does not
   pay for one call, so only the code-side save happens"): when the line is at or below the
   worst case of the run's first call (the reserve is at least the cap, or leaves no room for one
   call), no wrap-up is sent and the run pauses at its budget with the code-side save only. The
   run's log line at its start says which applies and names the reserve: "This run may spend CHF
   0.40: at CHF 0.32 it is told to wrap up, keeping a reserve of CHF 0.08 to finish." or "This
   run may spend CHF 0.01, too little to wrap up (two steps may cost CHF 0.02): save only, it
   pauses at its budget with its work kept." A budget below even its first call's worst case is
   refused before that call and still says its line: "This run may spend CHF 0.02, less than its
   first step may cost (CHF 0.05): save only, it pauses at its budget before that step." (On the
   coder's Sonnet, 4 096 output tokens alone cost USD 0.041, so CHF 0.02 is such a budget.) When
   the run is told to wrap up, the log says what it spent and the reserve kept: "Told the coder
   to wrap up: it spent CHF 0.30 of CHF 0.40, and the last CHF 0.08 is kept to finish." (The
   call that would pass the line brings the wrap-up, so more than a fifth is usually left.)
5. **Paused.** A task's run is paused when a budget of any level stopped it, or when it heard the
   wrap-up in this run and its report's "Left to do:" list has at least one item. A run that
   ends normally without a wrap-up in this run, or after one with nothing left ("Left to do:
   nothing"), is reviewed as usual, so a resumed run that finishes is reviewed and never loops
   into a new card. A paused run gets no critic and no failed try. Its report is kept, the
   stop's words beside it, and its two headings are kept in the run's artifacts as
   `{ handoff: { stopped, leftToDo, stoppedBy } }`, data only (it may carry web text, so it is
   quoted when read back). The Run row's outcome is `paused` for a graceful pause and stays
   `budget_exceeded` for a hard stop; neither is a sample of what the task costs.
6. **The stop names its real limit**: the task's budget, the specialist's limit, the session's
   budget, the project's budget, this month's cap or the share of the subscription Forerunner
   may use, from the refusal's level. The run's sentence says it ("The run stopped at this
   month's cap of CHF 150.00: it spent CHF 0.40, and its next step would have gone over."), and
   so do the task's status ("Paused at its budget", "Paused at this month's cap") and today's
   card. A pause at the project's budget, the month's cap or the subscription's share ends the
   session: nothing else of it can run there. That session names the limit too, never "the
   session's budget is used": its stop reason is the limit's (`budget_month`, `budget_project`,
   `budget_plan`), its badge reads "Stopped at this month's cap", its result "Stopped at this
   month's cap of CHF 0.23.", and its urgent notification says what helps (raise the monthly
   spending cap, the project budget, or wait for the subscription's usage to reset), never a
   larger session budget, which the month's cap refuses. The phone's push names it as well.
7. **A run cannot eat the review share.** A task's run may spend at most what is left of the
   session's work budget (its cap less the review reserve). With today's reserve of a fifth, a
   task that fills a whole session gets about 0.8 x 0.8 = 64% of it for work, as the owner was
   told.
8. **Until 'budget-resume' replaces it**, a paused task waits on today's budget card (Raise the
   budget, Cancel task), and a pause at the session's own budget goes the way point 8 of ADR
   0105 describes (released at the first stop, one card at the second), with its paused runs
   counted among the stops.

## Consequences

- The person's money and plan allowance stop where the budget says, and a stop is a truthful
  pause: the next run reads what the last one said, not "It failed".
- The critic no longer spends money reviewing half-done work, and the ladder no longer counts a
  budget stop as a failed try.
- On the subscription a run that stops waits up to 20 s for Claude Code to exit before the next
  task starts; Stop now still ends it at once.
- A run's wrap-up line uses the first call's estimate, which the conversation outgrows; 'cost'
  improves the estimate, and the line follows.
- The subscription's stop has no live check in the cloud (no subscription token): it is on the
  owner's checklist, step 6.
- On the subscription the wrap-up reaches Claude Code only with a tool result (PostToolUse): a
  run whose next step is its final answer ends without it and is reviewed as usual.
- A paused run's lessons are recorded like any other run's (what it learned is true whether or
  not it finished).

## Alternatives considered

- Keep today's behaviour (option A): every effect above stays.
- Raise a running session's budget between tasks (option D) or inside a run (option E): not asked
  for; Continue starts the next session at once instead ('budget-resume').
- Anthropic's task budget (option F, beta): advisory, counts tokens not francs, documented for the
  API key only; later, as a measured trial.
- Pause on every run that heard the wrap-up, whatever it listed: a resumed run that finishes would
  be paused again and never reviewed.

## Amendment 2026-11-03 ('cost'): better estimates and caching

The owner's decision of 2026-11-02 on budgets ("Q3 yes") included better estimates and caching;
this builds them. The live checks of 2026-11-02 found one research task at USD 1.32, its
conversation (with the fetched pages) re-sent uncached on every turn (L-15), and plan and start
estimates about ten times what coder and tester tasks cost, so the Start dialog left out tasks
that would fit (L-22).

1. **The agent loop caches its conversation.** Every call asks for `cache: { system, tools,
   messages }`. The Anthropic adapter marks the last block of the last message (what is new is
   written) and the last block of the last user message before the last assistant message (where
   the previous call ended, so its entry is read exactly, whatever the API's 20-block lookback
   would find), beside the system and tools marks: at most four breakpoints.
2. **The pre-call worst case prices what the cache does, never below the bill.** The prefix the
   previous call of the run read from and wrote to the cache, while that call started less than
   five minutes less a 30 s margin ago (an entry lives five minutes from the start of the request
   that wrote or read it), is priced at the cache-read price; the rest of the input at the
   cache-write price (1.25 times input; below the minimum cacheable length nothing is written and
   the input price applies, which the write price covers); the output ceiling at the output
   price. With nothing expected from the cache the whole input is priced at the write price.
   Before, the whole input was priced at the input price on the premise that cache hits only make
   the actual cheaper, which a cache write disproves. The input counted is never less than the
   cached prefix plus what was added since. Every budget check (the hooks, this ADR's two-call
   reserve, the run cap) uses the same estimate and follows without a change.
3. **A long write gets its tokens the first time.** A run that can write files and names no
   output ceiling of its own may ask up to 16,384 output tokens a call, as far as its room allows
   and never more than keeps two calls within the fifth of its budget kept to wrap up, so a small
   budget keeps 4,096 and its reserve does not grow.
4. **Estimates start where the real model's work cost.** A task with no estimate of its own starts
   at a calibrated figure per specialist (`STARTING_ESTIMATES_USD_MICRO`, from the runs of
   2026-11-01 and 2026-11-02: coder USD 0.04, tester 0.06, research 0.50, ...), not half the
   registry's per-run cap (USD 1.50 for a coder). The plan model's guess is kept within 1.5 times
   of its kind's figure; the person's questions (a task for the person) cost nothing and keep 0,
   whatever the reply guessed. The learner's multiplier may go from x0.1 to x10 (was x0.25 to x4)
   and one pseudo-sample holds it (was five): a consistent error is within x2 after three tasks of
   the kind. A task with a run that stopped at a budget (`paused`, `budget_exceeded`) is no
   sample, also once its budget was raised or it was continued and it finished: a pause is a lower
   bound. The work's cost excludes the critic's reviews, which the session's review reserve pays.
   The live feed measures against the task's own estimate (ADR 0019's amendment of 2026-10-20; the
   composed hook had drifted back to the corrected figure) and reads the task's Run rows to leave
   out what the fold leaves out (`observeTaskRuns`), so a restart changes no figure; a call a
   credential stopped (`usage_limit`) is no sample either.
5. **The subscription's estimates.** The Agent SDK path prices its first call from the brief and
   Claude Code's own prompt (about 20,000 tokens) instead of the step cap, and each next call from
   the whole prompt the last one sent (cached) and its reply.

Alternatives considered: trimming page text once it was used (it rewrites the cached history, so
every later turn writes it all again; with the cache the text costs a tenth of the input price a
turn); the one-hour cache (twice the write price, for turns seconds apart); top-level automatic
caching alone (one moving breakpoint, read only through the 20-block lookback). Consequences: a
call can still cost more than its estimate if the provider drops a cache entry early, or a routed
provider moves a run to another credential mid-run (another cache); the next call's estimate
reads what happened. The calibration is Sonnet 5.5's; another model's prices move the cost, and
the learner corrects it per kind.

## Amendment 2026-11-08 ('budget-resume'): the work is saved in code, the next run continues from it, one card with Continue

The owner's decision of 2026-11-02 on budgets ("Q3 yes": code-side save with "where I stopped /
left to do", resume from it, a card naming the real limit with "Continue (CHF N more)" that
starts the next session at once, Cancel that sets the work aside and names the stuck tasks)
builds on the pause above. Before, the executor returned before any commit for every outcome but
done, so a paused run's files stayed uncommitted in the task's worktree; the next run's
`checkout -B <branch> origin/<base>` carried them over or, when main had changed the same file,
git refused and the task failed (Try again failed the same way); in a project's folder the next
task's snapshot took them in. The next brief said only "It paused at a budget"; the card offered
"Raise the budget" (a session that "tries again"), also at the month's cap where the started
session stopped at once; a session-budget stop filed nothing the first time (C-36).

1. **The work is saved in code.** A run that stops before its work is done (a pause; also a
   question for the person, a credential's limit and a stop, which left the same uncommitted
   files) leaves one commit on the task's own branch in its worktree, "Work in progress: <title>
   (paused at its budget)", with the run's "Where I stopped" and "Left to do" in the message;
   `refs/forerunner/wip/<task>` marks it. In a project's folder a pause is one commit of its own
   in the folder, so the next task's snapshot (and the session's commit at its end) does not
   take it in. A failed run's leftovers are set aside under `refs/forerunner/failed/<task>`, so
   the next attempt starts clean (W6-24).
2. **Pushed only when the person says so.** The project setting "Push unfinished work to GitHub"
   (`push_unfinished_work`, off by default: a push starts the repository's automatic checks and
   co-workers see the branch) pushes the work in progress to the task's branch too, through the
   same guard as every push (no Local only file ever leaves this computer, ADR 0113).
3. **The next run continues from it.** It checks out the task's own branch (never `-B` from the
   host), brings in what a person pushed to it and the base when it moved, by merging, never
   rebasing (ADR 0111's no-replay rule); a conflict files the existing rebase-conflict card, never
   a git error. In a project's folder the task's next run keeps its work in progress out of its
   snapshot while no later task built on it, so its review reads the whole work. The marker goes
   when the work goes to review, when the branch starts again from the base, and on a cancel.
4. **The next brief starts with "## Where the last run stopped"**: that its work is in the
   folder and it continues from it, its note, the files it changed and its to-do list, each
   quoted as data; a run that left no note (a tiny budget, a hard stop) says so and lists the
   files. A resumed run that ends with "Left to do: nothing" is reviewed, never paused again.
5. **One card per pause, at the first stop of any kind.** '"X" paused at its budget of CHF 0.40'
   (the real limit), "Done: ...; left: ..." from the run's note, and **Continue (CHF N more)**:
   the same amount again (the task's budget, the specialist's limit per run, the session's
   budget), at least the task's estimate, rounded up to whole CHF 0.01 so the button says what it
   adds; it raises the task's budget (or gives the session that
   continues it that much, for a stop at the session's budget) and starts the next session at
   once (`resumeWork` with `budgetUsdMicro`); and **Cancel task**. A stop at the session's budget
   pauses with the same card at the first stop and ends the session (C-36's count and its
   three-option card are gone). At this month's cap, the project's budget or the subscription's
   share there is no Continue: the card says where to change it (Settings) and when the month
   resets, and the task goes on by itself once that limit changed and has room (`wakeBudgetWaits`,
   before every scheduler tick): the person raised or removed it in Settings, or a new month
   began. Room alone is no change: a pause at an outer limit comes when the next call's worst
   case would reach it, which can leave the spend under its 80% line, and waking on room there
   started a session every tick that paused again at once (the review of budget-resume). A card
   filed before this change keeps its options.
6. **Cancel sets the work aside.** Cancel of a paused task (its row, its card, the chat) sets its
   work in progress aside (in a repository the branch goes back to its start and a pushed branch
   leaves the host; in a project's folder only while no later task built on it, else its files
   stay and the line says why); Undo, or Reopen later, brings it back as work in progress. The
   dialog and the answer name the tasks that will be stuck. The Cancel line is one place
   (`daemon/cancel-words.ts`) within 100 characters (W6-7); in a project linked to the person's
   own folder it says what the run wrote stays there (C-37); Undo of a cancel promises no session
   (C-30).

Consequences: a paused task's history shows its work in progress (and a merge of main) in its
pull request; the WIP and failed refs are local to the task's worktree and the project's folder.
Not built here: pricing Claude Code's `modelUsage` at each model's own price, and booking usage a
stopped run reports after its token was revoked (both still logged, as before).

## Amendment 2026-11-08 (the leftovers of wave 7, 'leftovers7-session'): a refused review pauses too

Point 5 said a paused run gets no critic and no failed try, but a review the budget refused was
still a verdict: when a task's run fit and its critic review did not (the project's budget, the
month's cap, the session's own), the critic made the refused run an `escalate` with the finding
"Critic review did not complete (budget_exceeded)", the retry ladder ran the specialist again,
each review was refused the same way, and the task ended on '"X" failed 4 times' with Try again /
Mark done anyway / Cancel task (bench, project budget USD 0.01: four coder runs, four refused
reviews).

1. **A review a budget refused before its verdict is no review.** The critic writes its Run row
   (`budget_exceeded`) and no Review or finding, and throws the refusal (`refusedReviewError`);
   a refusal after the verdict was recorded still completes the review, as before.
2. **The task pauses at that limit, as a run does.** The session moves it to `needs_human` with
   the limit's title, files point 6's one card (at the project's budget, the month's cap or the
   subscription's share: Cancel task and Open Settings, it goes on by itself once the limit
   changed; at the session's budget: Continue), says '"X" paused before its review: the
   project's budget of CHF 0.01 has no room for it.', counts no try and ends the session at a
   stop that ends sessions (the critic's own run cap is the session's budget). When the task goes
   on, its next session runs it again (it continues from its work) and the critic reviews it
   once.

Not built: a session that reviews a paused task without running it again (its run's result is
not kept for a later review); the run costs one more specialist call.

## Amendment 2026-11-08 (the leftovers of wave 7, 'leftovers7-web'): late usage and each model's price

What "Not built here" left above is built. (1) **Late usage is booked** (R-lateusage): booking
what a run already spent needs no live token (`EnforcementHooks.afterModelCall` books first,
checking only the token's signature, and checks the live token after, unless the run is already
stopping), so a message that arrives after Stop all revoked the run's token, or while Claude
Code winds down, reaches the ledger and the session's spend, and never allows a new call. A
killed run (the kill switch, a person's move of the task) still returns at once; what Claude
Code reports after that is read in the background for at most `SDK_STOP_WAIT_MS`, booked, and
added to the run's Run row. The task's own spent figure is not raised by it (the runner adds the
run's returned cost before the tail arrives). (2) **Each model at its own price**
(R-modelusage): a message is priced at its own model, and the result's `modelUsage` is booked
per model at that model's price, less what the messages already booked for it; the ledger row
names the model. A model the price table does not know is priced as the run's model.

## Amendment 2026-11-09 (the run-side leftovers of waves 12 and 14, 'leftovers7-tailrun')

1. **The tail reaches the task's spent figure (TR-13).** A killed run's late usage was booked in
   the ledger, the session's spend and the Run row, but the task's `actual_cost_usd_micro` was
   written by the runner from the row it read after the run returned, so the tail never reached
   it (and a late write would have raced that one). Both additions now go through
   `task.addCost` (one `UPDATE ... + ?` statement, as `session.recordSpend`): the runner adds the
   run's cost, `lateRunCost` adds the tail after the Run row. The task's spent figure equals the
   ledger's sum for the task.
2. **A review paused at a budget says the work is done (TR-14).** The card of a review a limit
   refused (point 6 of the amendment of 'leftovers7-session') carries `review_waits`, and its body
   says "The work is done; its review waits for room in the budget." instead of the run pause's
   "It stopped before it could say where it stood; its work so far is kept."
3. **Still not built: a review-only pass (TR-15).** When only the review was refused, the next
   session still runs the specialist again before the critic reviews (one more specialist call;
   at the task's own budget Continue may have to be pressed twice). What it needs: (a) the run's
   result kept for the review (summary, final report, changed files, PR and branch, web sources
   and search results, checks) on the specialist's Run row (`artifacts`, a `review_pending`
   entry, so no migration) with the head it reviewed (the branch's commit, or the project
   folder's commit of the paused work); (b) the runner, before `execute`, taking a task whose
   latest work run has an unconsumed `review_pending` entry, an unchanged attempt and an unchanged
   head, and going straight to `reviewTask` with that result, then clearing the entry whatever the
   verdict; (c) the executor preparing the review's workspace without running the specialist
   (`PrTaskExecutor` checks the branch out into a worktree; a project folder is already in
   place), since the critic's project checks and its tries run in that workspace; (d) a restart
   test (compose twice: the review-only pass after a restart, the model-call log showing one
   specialist call in all). A changed head or attempt falls back to today's rerun.

## Amendment 2026-11-09 (wave 15, the run side: 'w15-run')

1. **One rule for the write cap and the cut-off retry (W15-13; amends point 3 of the 'cost'
   amendment and U-085).** Live check 2 found a CHF 0.20 coder told "about a fifth of this task's
   budget is left" after spending CHF 0.05, pausing with nothing written (RUN-1), and a CHF 0.48
   research run paying for a reply that was thrown away (F8). The write cap was a flat tenth of
   the run's cap on every call (on Sonnet 5.5 the 4,096 floor for any run under about USD 1.70),
   so the first long write was cut; the cut reply, its complete `write_file` calls included, was
   discarded; and the retry asked four times the limit with no room check and kept it as the
   floor of every later call, whose worst case then passed the line. Now a file-writing run's
   call and the call after a cut are paid only from the money below the run's wrap-up line, as
   web search is (ADR 0107's amendment of 2026-11-08), after the call's searches: once the first
   call fixed the line, the cap is fitted to `line - spent - searches`, so a larger cap never
   brings a wrap-up the floor would not. The first call keeps to half the fifth kept to wrap up,
   since its own worst case fixes the reserve ("a small budget keeps 4,096" holds for that call
   only). The raised limit is the retried call's only. A cut reply's complete tool calls before
   the cut one are kept and run (a cut call never runs; a reply with server blocks goes back only
   whole, so nothing of it is kept), and the next request says the cut call did not run; when the
   money below the line cannot raise the limit, it says to send less in one reply. After the
   wrap-up the reserve pays, as it does every call of a run that finishes.
2. **"Left to do" counts only what the criteria still need (W15-14; amends point 5).** A
   researcher that heard the wrap-up and ended with "Left to do: - Nothing for the acceptance
   criteria. - Optionally, add a section to answer.md" was paused at its budget with its work
   done and no review (live check 2, F4): `parseHandoff` took any line but a bare "nothing" as
   an item. "Nothing"/"none" with what it is about (the criteria, the brief, the task) or with a
   reason that says it is done is nothing, and an optional extra goes to the handoff's
   `optional` notes, never a reason to pause; "Nothing works yet" or "None of the tests pass"
   stays work, and so does a "nothing" that goes on to name work ("Nothing - but the README is
   incomplete", "Nothing in the task works yet") or a hedge alone ("Maybe fix the failing
   build"). The wrap-up and the brief's line ask for only what the criteria still need, as a
   list, or "nothing", with no optional extras.
3. **Searches near the line (W15-15; amends the 'web-search' note in ADR 0107).** A run is no
   longer offered fewer searches call by call as it nears its line: its fixed offer stands while
   the money below the line covers it whole, then goes for the rest of the run (ADR 0107's
   amendment of 2026-11-09, point 2).
4. **The wrap-up's words say what is true (W15-16; amends points 3 and 4).** The wrap-up comes
   before the step that could take the run past its line (its spend plus that step's worst
   case), so on a small budget it can come early: the log said "at CHF 0.07 it is told to wrap
   up" and the run was told at CHF 0.02, and the model heard "About a fifth of this task's budget
   is left" with 87% left (live check 2, F4). The start line now reads "This run may spend CHF
   0.15: before a step that could take it past CHF 0.07 it is told to wrap up, keeping a reserve
   of CHF 0.08 to finish.", the told line "Told the researcher to wrap up: it spent CHF 0.02 of
   CHF 0.15, and its next step could take it past CHF 0.07.", and the model hears "Wrap up now:
   this run has used 15% of what it may spend, and its next step could take it past the share
   kept to finish. Start nothing new, ..." (`wrapUpText`, worded when it is sent; the share is of
   the run's cap, which on a continued run is what is left of the task's budget; the brief's line
   says "If Forerunner tells you to wrap up"). The trigger itself is unchanged. An amount under a
   centime in these sentences and in the pause and stop sentences reads "less than CHF 0.01".
5. **A stopped run teaches the estimates nothing (W15-19; amends point 4 of the 'cost'
   amendment).** After Stop now the task goes back to Ready, but the runner's task.finished hook
   fed the stopped call's partial cost to the live learner, so the plan card and the Start dialog
   gave other figures for the same task until a restart, whose fold takes finished tasks only,
   moved them back (live check 2, RUN-2). A stopped call (`killed`) is no sample, and a task whose
   stopped run no completed run followed is none in either feed; once a later run completes the
   task, the stopped run's cost counts in its sample.
6. **One figure per task, live (W15-20, W15-21; amends point 1 of the 'leftovers7-tailrun'
   amendment).** The Tasks row and the drawer showed the work's cost while Costs > By task showed
   the ledger's, the critic's reviews included (live check 2, RUN-3), and a running task read CHF
   0.00 until its run ended (RUN-4). `actual_cost_usd_micro` stays the work-only figure the task's
   budget counts; the screens show `TaskView.spent`, the ledger's figure for the task, so the row,
   the drawer and Costs agree. Each model call's cost reaches the task and its Run row as the call
   ends (the rest at the run's end, no double count), and a spend increment does not bump the
   task's version, so a person's action during a run never fails on it.

## Amendment 2026-11-09 (wave 15, 'w15-review'): the review-only pass (TR-15) is built

Point 3 of the amendment of 'leftovers7-tailrun' is built as it designed, for a review refused at a
budget and, the same class, for one a credential refused (live check 2, RUN-6: after the project's
budget was raised the writer ran again before the waiting review, although the card said the work
was done).

1. **The run's result is kept** on its Run row (`artifacts`, a `reviewPending` entry; no
   migration): the attempt, the specialist, its summary and report, the changed files, the pull
   request and branch, the site rule it ran under and the search results it saw; the pages it read
   are kept on the row with their text (`reviewSources`, ADR 0107's amendment of this day). The
   head is the work itself: a hash of the changed files as they are in the task's workspace, so a
   session's commit at its end (a project's folder) is no change, and any edit of those files is.
2. **The next session reviews it without a run** while the attempt and the hash are unchanged and
   the executor can make the workspace ready (`prepareReview`: a repository task's worktree back on
   its branch, nothing fetched or pushed; a project's folder in place). The entry is cleared when
   the pass takes it, whatever the verdict; a review refused again keeps a new one. The log has no
   start or finished line for the specialist; the critic's verdict is the session's line for it.
   In a project's folder the critic's diff is the task's files since its last snapshot.
3. **Anything else falls back to today's rerun**: another attempt, a changed file, a worktree that
   is gone or on a branch git cannot check out, a project linked to a folder on the person's own
   computer (its executor offers no `prepareReview`).

The card's "The work is done; its review waits for room in the budget." (TR-14) is now true:
the specialist does not run again for a review that waited.
