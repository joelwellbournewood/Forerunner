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
   of its kind's figure. The learner's multiplier may go from x0.1 to x10 (was x0.25 to x4) and
   one pseudo-sample holds it (was five): a consistent error is within x2 after three tasks of the
   kind. A task with a run that stopped at a budget (`paused`, `budget_exceeded`) is no sample: a
   pause is a lower bound. The work's cost excludes the critic's reviews, which the session's
   review reserve pays. The live feed measures against the task's own estimate (ADR 0019's
   amendment of 2026-10-20; the composed hook had drifted back to the corrected figure).
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
