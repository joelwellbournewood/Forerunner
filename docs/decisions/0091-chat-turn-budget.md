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
outcome `budget_exceeded`. Every `chat.reply` row records `turnBudgetUsdMicro`.

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
