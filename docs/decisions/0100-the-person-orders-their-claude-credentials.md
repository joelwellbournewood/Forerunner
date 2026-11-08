# 0100 — The person orders their Claude credentials; every call follows the order and falls back on a usage limit; an API key never runs through Claude Code

Date: 2026-10-31
Status: accepted (amended 2026-11-03: a refused credential, waiting at a limit, the mid-session setting)

## Context

U-078, the owner on U-048: "it should be possible to prioritize usage with whatever tokens the
user wants to use first. Also, when using the API, promo credits can only be used when NOT in
Claude Code. Figure out a good and workable way to implement this."

What the code did before this ADR:

- Task runs picked a source per task (`RouterTaskBilling`, ADR 0044) by a fixed kind order per
  purpose (sessions: subscription first). The person could not change it.
- Chat, the PM intake, the critic, the model watch and the monthly jobs used one provider built
  at start (ADR 0098): the Messages adapter when an API key existed, else `ClaudeCodeProvider`.
  They never used the subscription while a key existed and never fell back. Their ledger rows
  named one fixed source (on a subscription-only install with kind `api`).
- The SDK driver accepted `credential.kind === "api_key"` and set `ANTHROPIC_API_KEY`; Claude Code
  prefers that variable over `CLAUDE_CODE_OAUTH_TOKEN`, so nothing in code kept a key out of
  Claude Code.
- A subscription's "You've hit your limit" mapped to `provider_rate_limit` (a throttle), an
  empty API credit balance to `provider_error`; the loop driver dropped both codes. Nothing
  could move to the next credential, and a task stopped that way failed and used a retry.

How the two providers report that a credential's limit is reached (read 2026-10-31):

- **Claude Code** (the binary Agent SDK 0.3.304 ships, 2.1.304; strings and the SDK's
  `sdk.d.ts`): for a subscriber it emits `rate_limit_event` messages
  (`SDKRateLimitInfo`: `status` `allowed` | `allowed_warning` | `rejected`, `resetsAt` in epoch
  seconds taken from the `anthropic-ratelimit-unified-reset` header, `rateLimitType` such as
  `five_hour`, `seven_day`). The failed turn is an assistant message with
  `error: "rate_limit"` and a text such as "You've hit your limit · resets 3pm"; Claude Code
  sets `apiError: "usage_limit_reached"` internally. `error: "billing_error"` is its "credit
  balance is too low". A `rate_limit` with neither is a short throttle.
- **The Messages API** (platform.claude.com/docs/en/api/errors and /api/rate-limits): a tier's
  monthly spend cap is a 429 `rate_limit_error` without `retry-after`, with
  `error.details.error_code: "enforced_spend_limit_reached"` and "You will regain access on
  <date> at <hh:mm> UTC."; a spend limit the person set is a 400 `invalid_request_error`
  starting "You have reached your specified (workspace) API usage limits" and naming when
  access resumes; a billing problem is 402 `billing_error`; an empty prepaid balance reads
  "Your credit balance is too low to access the Anthropic API". A plain 429 with `retry-after`
  is a per-minute rate limit, which the SDK retries.

## Decision

1. **The person's order is a human setting.** `human.notify_prefs.billing_order`: a list of
   their credential kinds, first used first (`subscription`, `api_key`, `plan_credits`; each
   once). It is written by the command registry's `settings.set billing_order` (low risk: no
   confirmation card; Changes lists it with Undo; `SettingSpec.display` words it), from
   Settings through `POST /settings/billing-order`, which also writes a
   `settings.billing_order` audit row. It lives in the state store, so it survives a restart,
   and `seedBillingSources` never touches it. Source priorities were not used: they order rows
   within a kind, are written by the seed, and an order of kinds is what the person chooses.
2. **The router applies it to every purpose.** `RouteContext.order` ranks the survivors; a kind
   it does not name comes after the named ones in the purpose's own order. The per-purpose
   `preference` still decides which kinds a purpose may use at all; the owner and disabled
   invariants hold. Without an order: task runs keep the policy's order (subscription first),
   and the non-task calls keep ADR 0098's choice (`CALL_FALLBACK_ORDER`: the API key, plan
   credits, then the subscription). Nothing changes for an install whose person never chose.
3. **Every non-task call is routed.** `RoutedProvider` replaces the single provider (an injected
   provider in tests still serves everything). Per call it asks `RouterTaskBilling.pick` with
   the caller's purpose (`chat`, `interactive` for the intake, `critic`, `batch` for the model
   watch and its evals) and runs the call on that source's provider: the Messages adapter on
   the source's own key for `api_key` and `plan_credits`, `ClaudeCodeProvider` with the token
   for `subscription` (ADR 0098 per call). `message_end.billing` names the source, its ledger
   kind and a subscription's plan share after the call; the loop driver books the call's ledger
   row to it, so the subscription's plan share and the key's monthly spend stay right. A task's
   loop run uses the picked source's own provider and is never re-routed.
4. **Fallback.** A source cannot serve when its plan share is at the cap, its monthly limit is
   reached, its credential is missing, or it rests. A provider answer of
   `provider_usage_limit` (item 6) makes it rest: `limits.restingUntil` on its row, the
   reported reset when it is ahead, else one hour (at most 32 days), and a `billing.rest`
   audit row; the probe reports the rest and the router skips the source (`cooldown`) until
   then, after a restart too. A non-task call that met the limit before anything streamed is
   made once more on the next source; a second limit, or one after the reply began, is the
   call's error. A task run that met it rests the source and goes back to `ready` by its
   claim's release, never through `failed` (the only move that counts an attempt), so the
   retry ladder, the critic follow-up and `task.attempt` are untouched; the next pick uses the
   next source. Every fallback is a `billing.fallback` event in the session log with a plain
   sentence ("The Claude subscription reached its usage limit and rests until 2026-10-31 11:00
   UTC; the API key answered instead.") and an audit row.
5. **An API key never runs through Claude Code.** `SdkAgentDriver` refuses an `api_key`
   credential, or an API key handed over as a token, with `ForerunnerError("provider_auth")`
   and sets only `CLAUDE_CODE_OAUTH_TOKEN`; `ClaudeCodeProvider` refuses any token that is not
   `sk-ant-oat…`; `scrubEnv` drops every variable that would make Claude Code authenticate or
   bill another way (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, other OAuth, refresh, gateway
   and session tokens, their file-descriptor forms, `CLAUDE_CODE_USE_*`), and the session's
   extra variables lose them too. The cloud runner has no Agent SDK path; its runtime's calls
   are routed as runner `cloud`. Evals and the model watch use the routed provider.
6. **One stable code for "this credential's limit is reached": `provider_usage_limit`**, with
   `resetAt` when the provider named one. The Messages adapter maps 402, the credit balance,
   the spend limit and the spend cap (reading "regain access on ... UTC", else `retry-after`);
   both Claude Code paths map `billing_error` and a `rate_limit` that Claude Code reported as
   the plan's limit (a rejected `rate_limit_event`, or its "hit your limit" text). A throttle
   stays `provider_rate_limit`.
7. **Settings shows it.** "Claude: which to use first" lists the credentials in order, each
   with how it is used ("Through Claude Code" / "Straight to the API: promotional credits
   apply"), whether it can be used now and why not, and what it spent this month (the
   subscription as a share of its allowance, a key in CHF), with Move up / Move down and the
   line "When one cannot be used, the next one is."

## Consequences

- A person with both credentials decides which pays first, for tasks and every other call; a
  limit on one no longer stops work while the other can serve.
- Without a chosen order the two defaults differ (tasks: subscription first; chat and reviews:
  key first), as before; the Settings section says so, and one move sets a single order.
- A key's promotional API credits are only ever spent off Claude Code, and a key in the
  person's environment can never take over Claude Code's billing.
- Each subscription-routed chat call starts a Claude Code subprocess (ADR 0098), so "subscription
  first" makes chat replies a second or two slower than "API key first".
- What a usage limit looks like is read off the shipped binary and the API docs; the exact
  text and the timing of `rate_limit_event` can change with a Claude Code release. The
  classification also accepts the text, and an unrecognised limit stays an error the person
  sees (no silent loop). A live check with a real token and key stays with the live harness.
- A rest outlives a restart; a rest set from a wrong reset time ends at most after 32 days, and
  a source whose limit lifted early is skipped until the rest ends.

## Alternatives considered

- **Source priorities as the order.** Rejected: priorities order rows within a kind, the seed
  writes them, and the router ranks kinds first; overloading them would have changed the
  ranking for every install, chosen or not.
- **Retry the failed task at once within the same session.** Rejected: the owner asked that the
  task go back to ready; the session's plan and budget were made for the first credential.
- **Keep the rest in memory only.** Rejected: Quit stops the service (ADR 0094), so a rest
  would be forgotten daily and the first call after each start would meet the limit again.
- **Fall back on any provider error.** Rejected: a refused token or a bad request would hop
  credentials and hide the cause; only the limit codes move on.

## Amendment (2026-11-03, phase E wave 7, area "credential-limits": the owner's decision of 2026-11-02)

The owner's decision of 2026-11-02 on credentials ("refused-key detection and one card; wait at
a limit with the reset time and start by itself; honest words"; owner-answers.md section 2)
changes points 4 and 6 and adds what a refused credential does. What the code did before it:

- A refused key or an expired sign-in (401, 403, Claude Code's `authentication_failed`) became
  `provider_error` "model call failed" in the loop and on the SDK path: a passing error, tried
  again at once, then a failed task with its card; the next task picked the same refused key.
- With no credential that could serve (one credential at its limit, or every one resting), the
  router's "no billing source available for session work on the pc runner" made every remaining
  task of the session fail, each with that sentence on its own card.
- A task stopped by a limit went back to ready, was held out of the session, and its sentence
  said it "runs on the next credential"; nothing started it when the limit reset, and the
  session's other tasks moved onto the next credential (with a second one saved).

Decision, amending point 4 for task runs and adding three points:

8. **A refused credential is marked and named once.** `provider_auth` survives the loop and the
   SDK path with the provider's words (`isClaudeCodeRefusal`: an assistant error of a refusal
   kind, or a result reading as a 401 or an expired sign-in). `RouterTaskBilling.refuse` marks
   the source (`limits.refusedAt`, `refusedKey`: the first 16 hex characters of the refused
   credential's SHA-256, never the value, `refusedWhy`), writes a `billing.refused` audit row
   and files one Inbox card per credential ("Anthropic refused your API key" / "... your Claude
   sign-in"; "Save a new one in Settings."; a link to the setup assistant, no answer to give),
   filed once while the mark stands. The router skips the source (`refused`) until a new
   credential is saved; a different credential in the vault ends the mark by itself (the
   fingerprint), and the setup assistant ends it at once (`credentialSaved`) and closes the
   card. A task the refusal stopped goes back to ready without counting a try and is never
   retried as a passing error; chat, planning and reviews (`RoutedProvider`) mark the source the
   same way and make the call once more on the next source. Settings shows the source as
   "Refused".
9. **Work waits; it never fails for want of a credential.** When no credential that may serve a
   task can now (each rests or is refused; under 'Wait', point 10, the first choice rests), the
   task goes back to ready without counting a try, the session ends on one sentence instead of a
   row of failed tasks ("Waits until 15:40 (your subscription's limit) and starts by itself.",
   or "Waits for a new API key: save one in Settings."), the task's row says the same
   ("Waits until 15:40, your subscription's limit"), and the project is kept on the source it
   waits for (`limits.waiting`, so it survives a restart). Before every scheduler tick
   (`RuntimeApp.billing.waits.wake`) every project whose source can serve again (its rest ended,
   or a new credential was saved) gets one session start (`budget_reset`) while it has ready
   work; saving a new credential in the setup assistant wakes it at once. The time is said in
   the person's time zone.
10. **"When my first choice runs out mid-session" (`human.notify_prefs.mid_session_limit`).**
    `wait`, the default (the owner's decision of 2026-11-02, owner-answers.md section 2: "the
    default is to wait and start again by itself ... switching moves work from plan limits onto
    money"): nothing moves onto another credential: a first choice that rests holds the task
    runs' picks (`RouteContext.waitOnRest`, `details.waitFor`), so the stopped task and the
    session's other tasks whose first choice it is wait for its reset and start by themselves,
    whether or not another credential is saved. `use_other`: the stopped task goes on at once in
    the same session on the next credential that can do it, and so does the rest of the session
    (point 4 as before, without holding the task out). A refused credential is no "running
    out": the next one serves under both values. Task runs only; chat, planning and reviews
    keep point 4's one-time move to the next source, and the setting's row says so. Settings
    changes it through `settings.set mid_session_limit` (medium risk: `use_other` asks a yes).
    The owner confirms the meaning with a second credential in U-078 (built: (a) nothing moves;
    option (b): only the stopped task waits while the others go on). Changing the answer
    changes one rule in the pick (`waitOnRest`) and the sentences.
11. **Honest words after a limit.** The session log says what is really scheduled: "Your
    Claude subscription reached its usage limit; "X" waits until 15:40 (your subscription's
    limit) and starts by itself." (wait), "...; "X" continues on your API key now." (use the
    other one, or a refusal with another credential), "Anthropic refused your API key; "X"
    waits for a new API key: save one in Settings." The router's own sentence never reaches a
    person (`failureWords` of `unavailable`).
12. **Planning waits too (the review of credential-limits, 2026-11-03).** A new project's brief
    is usually the first call that meets a refused key, and the card's "The work that needs it
    waits and starts by itself then" must hold for it as well. A background draft (`enqueue`)
    whose planning call met a refusal, a usage limit or no credential that can serve asks the
    routed provider what a planning call would wait for now (`RoutedProvider.waitNow`, a pick
    that only reads); when the only credential that may serve it is refused or resting, the
    intake is no failure: `summary_cache.intake.wait` keeps what it waits for, the project is
    kept on that source's `limits.waiting` like task work, and `GET /projects/:id/intake` says
    `state: "waiting"` with the words ("Planning waits for a new API key: save one in
    Settings." with a "Save a new key" link, or "Planning waits until 15:40 (your subscription's
    limit) and starts by itself."). The project page, Home, the Start dialog and the chat say the
    same, with no Try again (it cannot work while the credential is refused or resting). The
    wake (`RuntimeApp.billing.waits.wake`, point 9) drafts the plan again once the credential
    serves: a new key saved, or the limit's reset; a planning call holds the agent's one session,
    so when the same wake starts a task session the plan keeps its wait for the next tick. The
    project status sentence also says when a project's tasks wait for a credential ("Waiting for
    a new API key: 2 tasks [Save a new key]", "Waiting until 15:40 (your subscription's limit):
    2 tasks"); before, it fell through to "0 of 2 done".

13. **The credential chooser (credential-chooser, 2026-11-03; the owner's decision of 2026-11-02:
    "the person's order decides; another credential only when the first cannot do the task
    properly (plan card says why)").** What a task needs of its credential is compared with what
    each credential can do on this install. `capabilitiesOf(kind, facts)`
    (`wiring/billing-pick.ts`, the one place later areas change for their kind): the API key reads
    web pages when the page reader is on, does not search yet ('web-search' turns it on), runs
    commands in the sandbox and can ask the person; the subscription searches, opens no page yet
    ('sites'), runs commands only with host commands and cannot ask the person while it works.
    `needsOf` (`session/credential-choice.ts`): research's hard needs are page reading and
    search; asking the person is a hard need of a task whose own words need their answers (until
    they answered or went ahead without); running commands only makes the work better. The pick
    keeps the credentials that meet every hard need and the person's order decides among them;
    when none meets them all (research today), the ones that meet the most, page reading before
    search, in the person's order. 'Wait' (point 10) holds to the first choice that can do the
    task; the next group serves only when none of the first can now. The plan card (each plan
    task's `runsOn` in `GET /inbox`), New task and Settings say the result in one set of
    sentences ("Runs on your API key: only it can read web pages here.", "Runs on your API key:
    only it can ask you questions while it works here.", "On your subscription its tests will
    not run: it cannot run commands there."), and Settings shows "What each can do here", the
    capability function's output. This replaced ADR 0107 point 7's "research on the API key
    first", a session-lead default the owner's decision superseded.
14. **"Code tasks that need commands" (`human.notify_prefs.code_commands`).** `first_choice`,
    the default (the owner's): such a task runs on the first credential in the order; on a
    subscription it cannot run commands, so its own tests do not run, and the project's checks
    run before the critic only when the task's folder has its dependencies installed
    (`project-checks.ts`), which a run without commands cannot do. So for a project whose
    `package.json` names dependencies the plan card says "On your subscription its tests will not
    run: it cannot run commands there." `api_key`: running commands becomes a hard need, so the
    task goes to the API key (money; medium risk, a yes first). **Owner question (U-078):** should
    running commands become a hard need for code tasks on a project with dependencies to install?
    (a) keep the default as built; (b) make it a hard need for such projects, which sends most
    code work to the API key (money); (c) a third value, "the API key when the project has
    dependencies". Changing the answer changes `needsOf` and the setting's values, not the
    chooser.
15. **A refused first choice under 'Wait' (the session lead's default for the U-078 owner
    question, 2026-11-03; it amends point 10's "a refused credential is no running out").** A
    refused subscription files its card and its task work waits for the person (a new sign-in)
    instead of moving onto the API key, which costs money; under "use the other one" it moves to
    the next credential and the card says so ("Save a new one in Settings. Until then your tasks
    go on with your API key, which costs money."). The rule is the same for a refused API key
    (its work waits for a new key; with "use the other one" it goes on with the subscription), so
    'Wait' keeps one meaning: nothing moves onto the other credential. In code: the router's
    `waitOnRest` holds to a refused first choice like a resting one (`details.waitFor` with
    `reason: "refused"`, `until: null`); the card's words are read when it is shown
    (`RequestWordsContext.credentialGoesOn`). Chat, planning and reviews still use the next
    source (point 4). The owner may still choose otherwise in U-078: (a) as built; (b) a refused
    credential's work always moves to the other one (point 10 before), the card saying when that
    costs money.

Consequences: a refused key costs one call and one card, not two failed tasks and four calls; a
limit never fails a task, and the work starts by itself at the reset, after a restart too; with
the default, plan-limit work never becomes API spend without the person's choice. A task held
for a resting first choice may wait while a second credential could have served (the owner's
choice). A manual Start while the credential still rests ends at once with the same sentence. The
bench exercises all of it with no real key (`--provider bench-api`: the routed provider over the
vault's keys, the Messages API stand-in in testenv answering a refused key with 401 and a limited
one with the spend cap until its reset).

## Amendment 2026-11-08 (the leftovers of wave 7, 'leftovers7-session'): reviews wait too

Point 9 says work waits and never fails for want of a credential, and point 12 says the same for
planning; a critic review that met a credential at its limit or refused, with no other credential
to serve it (the routed provider moves a review once, point 4), still became an `escalate`
verdict (or, when the critic threw, a "could not be reviewed" card beside the credential's own),
the retry ladder counted it as a failed try, and nothing reviewed the task at the reset.

16. **A review a credential refused waits like the work.** The critic writes its Run row
    (`usage_limit`, or `credential_refused` for a refusal) and no Review or finding, and throws
    the refusal; the critic port asks the routed provider what a review would wait for now
    (`waitNow`), else reads the refused call's source, and keeps the task's project on that
    source (`RoutedProvider.noteWait`, `limits.waiting`). The session gives the task back to ready
    without a try, says the wait's sentence ("Your API key reached its usage limit; "X" waits
    until 16:40 (your API key's limit) and starts by itself."), and files no card; at the reset,
    or once a new credential is saved, the wake (point 9) starts a session that runs the task
    again and the critic reviews it once. A refusal with nothing known to wait for keeps the
    review-failed card.
17. **Only the tasks that must wait wait (point 10 as written).** A task stopped by a credential,
    or whose pick waits before it runs, goes back to ready with the reason
    `CREDENTIAL_WAIT_REASON`, and the session goes on with the rest of its queue: each task's own
    pick decides whether it runs now (its first choice serves: a research task whose first choice
    is the API key while the subscription rests) or waits too, without a call. The session ends
    `credential_wait` with the wait's sentence once nothing else can run. Only the waiting tasks'
    rows say "Waits until ..." (`taskDisplay` reads the reason beside the project's wait), and a
    second task waiting for the same credential is a detail line of the log (`repeat`). Before,
    the session ended at the first wait and skipped its queue, and every ready task of the
    project read "Waits until ...". This is the built answer (a) of U-078 applied as point 10
    says; the open question (b) is unchanged. The log's start line is written when the run
    starts (`TaskExecutor.execute`'s `onStarted`, after the pick and any hand-over), so a task
    whose pick waits has none.
