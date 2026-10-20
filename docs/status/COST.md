# Cost

All spend by milestone and by model. The Anthropic key arrived on 2026-10-20 (see BLOCKERS.md)
with 100 USD of credit on it: the live-run budget is 100 USD (`FORERUNNER_LIVE_BUDGET_USD`),
warning at 80%. Split: evals and critic calibration 30 USD, nine scenarios 50 USD, reserve
20 USD. The first live runs happened on 2026-10-20 (rows below): USD 3.428238 of the 100 USD
over three runs, every call in `tests/live/spend.json` (ADR 0040; the ledger is read before
each call and the caps are enforced in code). The build agent's own token use in the build container is
recorded below as well; its price is not known to the agent and is shown as tokens.

Split target once a budget exists: building 60%, testing and live evals 20%, critic reviews 10%,
reserve 10%.

| Date | Milestone | Model | Purpose | Tokens in | Tokens out | USD | CHF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-19 | 0 | build agent (Fable 5.1 session) | scaffolding, platform package | n/a | n/a | n/a | n/a |
| 2026-10-20 | 0 | build sub-agents (wave 1: state, vault, billing, testenv, scripts, requirements, ADRs, critics) | 4,271,794 tokens (in+out, 27 agents) | | | n/a | n/a |
| 2026-10-20 | 1 | build sub-agents (wave 1b: registry and evals, voice, sandbox, critics, fixes) | 2,131,852 tokens (9 agents) | | | n/a | n/a |
| 2026-10-20 | 1–4 | build sub-agents (wave 2, first attempt: UI, state service; critic, memory, commands cut off) | 1,233,723 tokens (7 agents) | | | n/a | n/a |
| 2026-10-20 | 6 | build sub-agents (wave 3a, first attempt: email, browser, injection suite cut off) | 727,159 tokens (3 agents) | | | n/a | n/a |
| 2026-10-20 | 6–7 | build sub-agents (wave 3b: extensions done; updates, notifications, Cloudflare cut off) | 772,076 tokens (5 agents) | | | n/a | n/a |
| 2026-10-20 | 2–7 | build sub-agents (wave 3c: mirror done; model watch, desktop, data cut off) | 813,066 tokens (5 agents) | | | n/a | n/a |
| 2026-10-20 | 2–7 | build sub-agents (resumed waves after the second credit stop: core loop, UI phase 2, desktop shell fixes, Android, cloud runner, approvals web, updates, extensions, notifications, Cloudflare, model watch, mirror, desktop control, data assets, foundation re-reviews, voice and sandbox fixes, wiring) | 10,723,994 tokens (8 workflows, 69 agents started, 50 finished; the rest stopped on the credit limit) | | | n/a | n/a |
| 2026-10-20 | 1, 3 | claude-sonnet-5-5 | live run `2026-10-20T17:07:09Z` (`pnpm --filter @forerunner/live test:live`): phase 1 live half (3 coder tasks, 3 tier 1 reviews, the kill switch call), 10 timing requests, critic calibration (20 + 80 reviews) | 557,754 (plus 475,277 cache read, 3,821 cache write) | 143,766 | 2.657774 | 2.13 at 0.8 |
| 2026-10-20 | 1 | claude-haiku-5-5 | same run: one composed chat turn, 10 timing requests | 409 (plus 4,138 cache write) | 194 | 0.000652 | 0.00 |
| 2026-10-20 | 1, 3 | claude-sonnet-5-5 | live run `2026-10-20T17:52:18Z` (the harness after its review, `test:live -t '^(?!.*full 40-task run)'`): phase 1 live half (3 coder tasks, 3 tier 1 reviews, the kill switch call), 10 timing requests, critic calibration subset (20 reviews, 41 calls) | 150,325 (plus 121,502 cache read, 3,821 cache write) | 32,755 | 0.662051 | 0.53 at 0.8 |
| 2026-10-20 | 1 | claude-haiku-5-5 | same run: one composed chat turn, 10 timing requests | 410 (plus 4,139 cache write) | 194 | 0.000652 | 0.00 |
| 2026-10-20 | 1 | claude-sonnet-5-5 | live run `2026-10-20T17:58:04Z` (the phase 1 file alone, after the usage and kill cases were corrected): 3 coder tasks, 3 tier 1 reviews, the kill switch call | 19,736 (plus 32,502 cache read) | 6,058 | 0.106550 | 0.09 at 0.8 |
| 2026-10-20 | 1 | claude-haiku-5-5 | same run: one composed chat turn | 180 (plus 4,139 cache write) | 47 | 0.000559 | 0.00 |

Sub-agent token counts come from the orchestration tool's usage report per wave; they are the
build's own cost, not the product's.

## Live ledger

`tests/live/spend.json` after the three runs of 2026-10-20: 342 rows, USD 3.428238 (319 Sonnet
calls USD 3.426375, 23 Haiku calls USD 0.001863; two rows with `no usage reported` for the
calls the kill switch aborted). Remaining under the 100 USD live budget: USD 96.571762; the
runs used 2.66, 0.66 and 0.11 of their 15 USD per-run cap; no 80% warning, no refusal. By
purpose: run `2026-10-20T17:07:09Z` phase 1 half USD 0.1192 (session 0.1169, chat 0.0006, kill
test 0.0018), timing requests USD 0.0019, critic calibration USD 2.5373 (subset 0.5278, full
set 2.0095); run `2026-10-20T17:52:18Z` phase 1 half USD 0.1177 (session 0.1161, chat 0.0006,
kill test 0.0011), timing USD 0.0019, calibration subset USD 0.5431; run `2026-10-20T17:58:04Z`
phase 1 half USD 0.1071 (session 0.1066, chat 0.0006, kill test 0: the aborted call reported
no usage). The forecast rows below for the calibration are now measured: 80 tier 1 reviews on
Sonnet cost USD 2.01, a 20-review subset USD 0.53 to 0.54.

## Forecast

Not possible without a budget. The live-model share (evals, nine scenarios, model watch) is
estimated at the following per full run, at list prices, so the humans can size the budget:

| Item | Runs | Est. USD per run | Notes |
| --- | --- | --- | --- |
| Coder eval set (20 tasks, Sonnet) | per model/prompt change | 4–8 | ~20 runs × 50k tokens |
| Researcher eval set (20 tasks, Sonnet/Opus) | per model/prompt change | 6–12 | |
| Critic calibration on both sets | monthly | 5–10 | Opus at tier 2 |
| Nine scenarios × 3 runs × 2 OS | release | 60–120 | Haiku chat, Sonnet work, Opus critic |
