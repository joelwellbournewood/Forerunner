# 0089 — Model watch: paid evals need the human's consent, and the watch runs once a week, not once a boot

Date: 2026-10-26
Status: accepted

## Context

On 2026-10-26 a fresh install on the human's Windows PC (`fr setup --non-interactive`, then
`fr daemon`, a FORERUNNER_HOME made only for a voice test) ran the weekly model watch at once,
evals included. The coder and researcher eval sets ran on Sonnet 5.5 at medium and low effort,
plus Opus calls: hundreds of calls on the human's API key, about USD 8.60 across two short
daemon sessions between 00:40 and 02:10Z. Nobody asked for it. Each coder eval also warned
"sandbox: process (no container engine)", so the coder tasks ran their commands in the process
stand-in.

The causes:

1. The scheduler kept the last firing of an `every` schedule in process memory only
   (`lastEvery`, starting at minus infinity). The weekly model watch therefore fired at the
   first tick of every daemon process, 30 seconds after start, and again after each restart.
   ADR 0060 had fixed this for the monthly calibration (`scheduler-fired.json`, a first
   sighting after the due day waits), but not for `every`.
2. `ModelWatch.run()` always ran the evals: the baseline and one lower-effort probe per eval
   target (coder, researcher) on every run, up to `evalBudgetUsdMicro` (5 USD) per run (ADR
   0019). Nothing asked the human first. Spec D says the watch "runs the eval set on new
   candidates ... Human approves". The human approved the switch, but nobody had approved
   the spend that produced the evidence.
3. The eval runner opened its sandbox lease with an empty project id and the brief's risk tier
   (1 for the coder set). The factory refuses the process stand-in only at tier 2 and above,
   so on a machine without Docker or Podman the coder commands ran in the process stand-in
   and nobody had allowed that.
4. The daemon's `close()` did not stop a model watch run. The run's model calls kept going
   until the store closed under them.

The caps were in force: every eval call goes through the hooks with the human as owner, so
the month cap stops it and the ledger row counts in the human's month. But a month past its
80% line only finishes current work. The eval runner started a new task after each one, so
evals kept going until the stop line.

## Decision

1. **Weekly means weekly.** An `every` schedule may set `persist: true`. Its last firing is
   then kept as an ISO timestamp in the scheduler's `FiredKeys` store
   (`<data dir>/scheduler-fired.json` in the daemon), so a restarted daemon waits out the
   rest of the interval. A stored time in the future (the clock was corrected back) is
   clamped to now, so the schedule waits one interval rather than never firing. The model watch's schedule sets it. The first tick on a fresh install
   still runs the watch, but only its free part (item 2).
2. **Paid evals run only with the human's consent.** A model watch run checks the provider
   model lists and the price list and proposes repricings, as before. It runs no eval unless
   one of these holds:
   - the run is an explicit "run evaluations": `run({ evals: true })`, `fr models watch
     --evals`, `POST /model-watch/run { "evals": true }`;
   - the human answers `evaluate` on a report that is pending or reminded. The watch then calls
     `onEvalsRequested`, and the daemon starts `run({ evals: true })` in the background. An
     `adopt` is never consent to spend: "yes", "ok" and "approve" map to `adopt`, which applies
     the report's rows and starts nothing (review of 2026-10-26). An `evaluate` on a report
     that is already being evaluated, ignored or adopted is refused (`validation`);
   - the human's opt-in setting `model_watch.run_evals` (`human.notify_prefs.model_watch`, a
     `settings.set` key, medium risk, undoable) is on. **Default off.**

   Without consent the report records `evals_deferred: { reason, planned[] }`: every eval it
   would have run, with specialist, model, effort and role. The request's options become
   `adopt, evaluate, ignore, remind`. A report asks the human only when it has a
   recommendation, a price row, or a withheld eval on a *new* candidate. The weekly
   lower-effort probes alone never raise a request. A candidate the human already ignored on
   a report that withheld its evals is not asked about again, and neither is its new price
   row. A repricing of an existing model still asks.

   **Paid runs are single-flight.** `ModelWatch` keeps one paid run in flight. A second paid
   run asked for while it runs (two `evaluate` answers, an `evaluate` during a scheduled run
   with the opt-in on, two `--evals` calls) joins it and gets the same report. The decision
   whether a run is paid is taken in call order, so two calls made together always see each
   other.
3. **Paid model watch work is new work under the caps.** Before every eval task the runner
   checks the human's outer caps (`DynamicCaps`, the task's budget as the estimate), with the
   billing of the eval source (its kind and, for a subscription, the plan share and its cap),
   so the plan level is checked too.
   Anything but `allow` means the month or the plan is past its 80% line or at its cap, and
   no further task starts (`budget_exceeded`). Every model call is still checked by the
   hooks. A run that ends `killed` ends the eval set. A run that ends `budget_exceeded` ends
   it only when the outer caps no longer allow: a task over its own budget fails that task
   and the set goes on. A cap stop or a kill ends the
   watch run's remaining evals: none reaches the runner, and each is reported skipped with
   the reason.
4. **No eval command runs in the process stand-in unless the human allowed it.** A lease
   whose engine is `process` is refused before any model call (`not_supported`, details
   `reason: "process_sandbox_not_allowed"`). The whole eval set ends there and the report
   shows the reason. The human's switch is `model_watch.allow_process_sandbox` (default off).
   Turning it on is high risk: `settings.set` needs the device to confirm, not a tap. Eval
   sets with no command (the researcher set) open no lease and are unaffected. The switch
   also applies to the specialist approval gate's evals (ADR 0071), which share the runner.
   The gate records the refusal as `sandbox_unavailable` and a cap stop as `cap_reached`,
   each with what to do (ADR 0071 amendment of 2026-10-26).
5. **A stopping daemon stops the watch.** `ModelWatchDeps.signal` is the daemon's stop. Every
   run is aborted with it, the eval runner passes it to the loop driver (`RunRequest.signal`,
   which ends the run `killed` and makes no call once aborted), and `ModelWatch.settled()`
   resolves once the runs in flight have ended. `RuntimeApp.close()` aborts first and awaits
   `settled()` before it closes anything else. An aborted run writes no report.

ADR 0019's thresholds and its 5 USD per-run cap are unchanged. They now bound a run the human
consented to. Spec D's "Human approves" covers the spend as well as the switch.

## Consequences

- A fresh install spends nothing on the model watch until the human says so. The first
  weekly check is free and shows up in the inbox only if it found something to decide.
- A switch recommendation needs one more answer than before: `evaluate`, then `adopt` on the
  report that carries the evidence. Adopting a report whose evals were withheld applies its
  price rows only. An install that wants the old weekly behaviour turns on
  `model_watch.run_evals`.
- Lower-effort savings (spec D.21) are found only when the human runs evaluations or opts
  in. The weekly report no longer finds them on its own.
- On a machine without a container engine the coder eval set does not run until the human
  allows the process stand-in or installs Docker or Podman. The researcher set still runs.
- `fr models watch` alone runs the evals only when the `model_watch.run_evals` opt-in is on;
  otherwise it is the free check. `--evals` always runs them.
- Memory consolidation is also a weekly `every` schedule and still fires at the first tick
  of each process. It does not run the evals. Whether it should persist too is left to its
  own module.

## Amendment 2026-10-26: the first run is the baseline, not news

### Context

The run before last on the same fresh install ran only the free check, as item 1 intends. It
still opened a decision in the inbox: "Model watch 2026-10-26: 10 new, 0 retired, 0
repriced, 0 unpriced", asking adopt, evaluate, ignore or remind. In the voice session that
followed, the conversation agent raised it in most replies.

None of the ten models was news. "New" meant "listed by the provider and on no ladder rung".
The Models API lists every model the account can call, and the ladder uses four of them. The
other ten were all priced, and with no price list configured (the default) a price can only
come from the table the install shipped with. So every one became a candidate, and the
withheld candidate evals were enough to ask the human (item 2). Every fresh install asked
the same question at its first boot, and every later week again until the human ignored it.

### Decision

6. **The first listing of a provider is its baseline.** The first run that lists a provider
   records the listing (`recordModelWatchBaseline`, a `release` row on channel
   `model_watch_baseline`, one per provider, never moved after). Its models are not new in
   that run. A run in which every listed provider is recorded this way is a baseline run: it
   runs no eval, even with the `model_watch.run_evals` opt-in or an explicit `evals: true`,
   and asks nothing (`nothing_to_decide`). Its report names the providers in
   `baseline_providers` and its summary says "baseline recorded". Later runs compare against
   the baseline.
7. **Only the baseline decides what is news.** A listed model is new when it is on no ladder
   rung and not in its provider's baseline. The price table does not decide it: a model the
   table prices but the provider lists only after the baseline is news, and one in the
   baseline is not news whether the table prices it or not. (The first version of this
   amendment also counted the shipped table as known; review of 2026-10-26 dropped that.)
8. **An upgraded install seeds its baseline from its reports.** A provider without a baseline
   row on an install that has reports takes the listing of the earliest report that listed it
   without an error. After a baseline is recorded (seeded or new), every pending report whose
   new models are all in the baseline, with no recommendation of its own (a repricing or an
   eval result stays a question), is closed: its request is withdrawn and the report marked
   `nothing_to_decide`. The daemon does this seed-and-close at start as well, not only in a
   run (follow-up of 2026-10-26, below).
9. **An "evaluate" answer evaluates that report's candidates.** The daemon starts
   `run({ evals: true, forReport })`: the report's candidate models are named and evaluated
   whether or not they are news now, so a baseline (seeded or not) never swallows the consent.
   A run with named models is never a baseline run. `fr models watch --evals --model
   <provider/id>` names a listed, priced, off-ladder model the same way. Naming a model
   without `--evals` (or `evals: true`) is refused (`validation`). Named runs are paid runs:
   the run's eval budget caps them, and single flight holds: a paid run asked for while
   another runs joins it when that run already covers its named models, else it waits for it
   to end. Two paid runs never overlap.

Retired models and repricings are still compared with the ladder and the table on every run,
the baseline run included. A repricing found by a baseline run is in its report but asks
nothing until the next run finds it again.

### Consequences

- A fresh install's first boot writes a "baseline recorded" report and puts nothing in the
  inbox. The conversation agent has nothing to bring up.
- A model the provider listed at the first run but the ladder did not use is not a candidate
  on its own later; `fr models watch --evals --model <provider/id>` puts it to the evals.
- An install upgraded from before this amendment keeps comparing against its earliest
  report's listing, and its pending requests about models in that listing are withdrawn.
- A provider registered later gets its own baseline on its first listing; the run still
  reports news from the providers that had one.
- The baseline is store-wide: installs sharing a state store share it.

### Follow-up 2026-10-26: seed and close at daemon start

An install made that morning on older code had the pending "10 new" request opened at
10:30Z. After the update and a restart it stayed open, and the voice agent kept raising it:
the seed and close ran only inside a watch run, and the persisted weekly schedule had fired
at 10:29Z, so the next run was a week away. The daemon now runs the free, local part of item
8 at start (`ModelWatch.seedBaselinesAtStart`): a registered provider without a baseline row
is seeded from the earliest report that listed it, and if any was seeded the covered pending
requests are closed with the same guarded close the run uses (an answered request is never
overridden). It lists no provider, calls no model or eval, writes no report and is
idempotent, so it runs on every boot. Rejected: running a full watch at start when a
baseline is missing (a provider call, and a report the human did not ask for) and clearing
the persisted schedule on upgrade (the same, a week early).

### Alternatives considered

- **Compare with the previous report's listing.** Rejected: a candidate would be new for one
  run only, and the `evaluate` answer starts a later run, in which it would no longer be a
  candidate.
- **Keep the table rule only.** It fixes this incident, but a model released after the build
  would still be asked about on the first boot, before the human has used the install at all.
- **Baseline plus the table rule.** Rejected in review: a model the table prices but the
  provider starts listing later is real news, and the table would hide it.

## Alternatives considered

- **Keep the evals and lower the per-run budget.** Rejected: any figure above zero is spend
  the human did not ask for, and the incident was about consent, not size.
- **Delay the first run by a week instead of consent.** Rejected: it hides the problem for a
  week and still spends without asking.
- **Ask before every scheduled run (a blocking request).** Rejected: a weekly nag for probes
  that rarely change anything. The report asks only when there is a candidate, and the
  opt-in covers installs that want it automatic.
- **Raise the eval leases to risk tier 2 so the factory refuses the stand-in.** Rejected:
  the tier is the task's, the rule belongs to the caller, and the human needs a switch that
  says what it does.
