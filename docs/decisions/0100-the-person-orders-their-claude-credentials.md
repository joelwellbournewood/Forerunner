# 0100 — The person orders their Claude credentials; every call follows the order and falls back on a usage limit; an API key never runs through Claude Code

Date: 2026-10-31
Status: accepted

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
