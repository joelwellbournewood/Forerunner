# 0091 — The chat turn's budget: three first calls, between USD 0.05 and USD 0.25

Date: 2026-10-26
Status: accepted

## Context

Each conversation turn runs the loop driver under its own small budget (session and run cap).
Until this change it was a fixed USD 0.05 (`ConversationDeps.turnBudgetUsdMicro`, unset in every
composition). The loop's precheck prices a call before it is made: the input as sent at the input
price plus the whole `max_tokens` at the output price.

The real-audio voice run of 2026-10-26 had a spoken reply cut off at 400 output tokens, most of
them thinking, so the chat cap went to 1024 (`CHAT_MAX_TOKENS`) and a chat turn at low effort
asks thinking off. On Haiku 5.5 a 1024 cap is priced at about USD 0.0005, so USD 0.05 is ample.
A principal can move chat to Opus 5.5 (USD 4 in, 20 out per million tokens in the built-in price
table), which cannot turn thinking off. There the cap alone is priced at about USD 0.02, and a
turn with about 6'000 tokens of context (USD 0.024 of input) was refused before its first call.

The first fix (review of 1ae4d66) raised the default budget to three first-call estimates with no
upper bound. On Opus 5.5 with about 150'000 tokens of context that gives about USD 1.9 for one
chat turn, 38 times the old figure, with no human decision behind it.

## Decision

When no turn budget is configured, a chat turn's budget is

    min(CHAT_TURN_BUDGET_CEILING_USD_MICRO, max(DEFAULT_TURN_BUDGET_USD_MICRO,
        CHAT_TURN_CALL_ROOM × estimate(first call input, max_tokens)))

with USD 0.05, 3 calls and USD 0.25 (`packages/runtime/src/conversation/agent.ts`). Three calls
cover an answer, or a command tool call and its answer, with room to spare. A configured
`turnBudgetUsdMicro` is used as given. A turn whose first call alone does not fit is refused by
the precheck before anything is spent; the reply names the budget and says to ask with less pasted
text or to switch chat to a cheaper model (`budgetRefusedReply`), and the `chat.reply` row has
outcome `budget_exceeded`. That advice is given only when the turn's own budget refused (the
`SessionBudget` marks its refusals with `details.source` `LOCAL_BUDGET_SOURCE`); a project or
month cap refusing the call keeps its own message, since a shorter question would not get past
it. Every `chat.reply` row records `turnBudgetUsdMicro`.

## Consequences

- Haiku 5.5 turns keep USD 0.05 until the context passes about 160'000 tokens.
- A realistic Opus 5.5 turn (about 6'000 tokens of context) gets about USD 0.13 and runs.
- Very large contexts on expensive models are refused with a reason instead of costing up to
  USD 2 a turn. The human's and project's outer caps still apply on top.
- The ceiling is a constant, not a setting; a composition that needs another bound sets
  `turnBudgetUsdMicro`.

## Alternatives considered

- Keep USD 0.05 and shrink the output cap to fit: it brings the truncation back on exactly the
  models that cannot turn thinking off.
- Size the cap with the loop's `maxTokensCeiling`: its first call reads the model's limit from the
  Models API (up to 5 s), a latency a voice turn cannot afford.
- No ceiling: rejected above (USD 1.9 for one turn on Opus 5.5 with a large context).

## Amendment 2026-11-15: the claim guard's step stays inside the turn (l3-chat-claims)

Live check 3 (L3-run-1): the chat model answered "research may read any public website again"
with "I've asked for confirmation" and called no tool. A reply that claims a change or a yes no
command of the turn backs now gets one more model step with a short nudge
(`ConversationAgent.chat`, `CLAIM_NUDGE` in `src/conversation/claims.ts`). That step is part of
the same turn: it runs under the same `SessionBudget` (this ADR's budget, its step cap and its
deadline) and the same capability token, and only while the turn's four model calls
(`CHAT_MAX_MODEL_CALLS`, the loop's `maxTurns` before) are not used up; its cost is booked on the
turn's `chat.reply` row with the first run's. No step is added when the turn's four calls are
used up or the person stopped the turn; a step the turn's budget or deadline refuses ends
unfinished. Either way, as when the claim comes back after the step, the claim is replaced with
what the turn really did (`claimNudge` and `trueLine` say it from the turn's command results):
the change sentences of the commands that ran, or the read-back of the turn's Yes/No card, or
"Nothing changed, and nothing waits for your yes. Say it again to try once more." (with "the
change I asked about earlier still waits for your yes" when an earlier card does). So the turn's
spend bound is unchanged; a turn whose reply makes no unbacked claim costs exactly what it did,
and a negated sentence ("I've changed nothing") is no claim and costs no step.

## Amendment 2026-11-15: room for a lookup (d1109-chat-recall)

A chat turn may now search with `recall`, open a hit with `recall_open`, answer and make a
change, with the claim guard's nudge after it: the turn's model calls go from 4 to 6
(`CHAT_MAX_MODEL_CALLS`) and the default budget's room from 3 to 5 calls priced as the first
(`CHAT_TURN_CALL_ROOM`). The USD 0.25 ceiling stays (an Opus turn with about 6,000 tokens of
context is held at it), and a Haiku turn keeps USD 0.05 until its context passes about 95,000
tokens. No new spending path: a lookup is a call of the turn, booked like any other.
