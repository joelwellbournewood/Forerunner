# Cost

All spend by milestone and by model. The Anthropic key arrived on 2026-10-20 (see BLOCKERS.md)
with 100 USD of credit on it: the live-run budget is 100 USD (`FORERUNNER_LIVE_BUDGET_USD`),
warning at 80%. Split: evals and critic calibration 30 USD, nine scenarios 50 USD, reserve
20 USD. Live spend so far: USD 2.54 (the first critic calibration, below; the harness in
`tests/live` records every run in `tests/live/spend.json` and refuses a run past its 15 USD
per-run cap). The fake provider has zero cost. The build agent's own token use in the build
container is recorded below; its price is not known to the agent and is shown as tokens.

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
| 2026-10-20 | 3 | claude-sonnet-5-5 (critic, tier 1, critic@1.0.0) | live critic calibration, 10-task coder subset (`tests/live`, run 2026-10-20T17:07:09Z): 20 reviews, 10/10 defects caught, 7/10 clean accepted | | | 0.53 | n/a (rate not recorded by the harness yet) |
| 2026-10-20 | 3 | claude-sonnet-5-5 (critic, tier 1, critic@1.0.0) | live critic calibration, full set 20 coder + 20 researcher (`tests/live`, same run): 80 reviews in 850 s, 40/40 defects caught, 15/40 clean accepted (gate FAIL; ADR 0041) | | | 2.01 | n/a |
| pending | 3 | claude-sonnet-5-5 (critic, tier 1, critic@1.1.0+9e712bfa) | live critic calibration re-run after ADR 0041 (the runner's checks as evidence, fixtures as source files, confidence floor); expected within the 15 USD per-run cap, about 2 to 3 USD by the first run; needs the build box's key | | | pending | pending |

Sub-agent token counts come from the orchestration tool's usage report per wave; they are the
build's own cost, not the product's. Live model spend by the product so far: USD 2.54, all
critic calibration (the per-review median was 10.4 s and about 2.5 cents at tier 1 on Sonnet);
the live harness's `spend.json` is the ledger of record for live runs.

## Forecast

Not possible without a budget. The live-model share (evals, nine scenarios, model watch) is
estimated at the following per full run, at list prices, so the humans can size the budget:

| Item | Runs | Est. USD per run | Notes |
| --- | --- | --- | --- |
| Coder eval set (20 tasks, Sonnet) | per model/prompt change | 4–8 | ~20 runs × 50k tokens |
| Researcher eval set (20 tasks, Sonnet/Opus) | per model/prompt change | 6–12 | |
| Critic calibration on both sets | monthly | 2–3 at tier 1 on Sonnet (measured 2.01 on 2026-10-20); 5–10 at tier 2 on Opus | tier 1 is the production pick for the gate |
| Nine scenarios × 3 runs × 2 OS | release | 60–120 | Haiku chat, Sonnet work, Opus critic |
