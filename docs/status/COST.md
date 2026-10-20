# Cost

All spend by milestone and by model. No build budget was provided (see BLOCKERS.md), so no live
model calls have been made from the build; the fake provider has zero cost. The build agent's
own token use in the build container is recorded below as the only cost so far; its price is
not known to the agent and is shown as tokens.

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

Sub-agent token counts come from the orchestration tool's usage report per wave; they are the
build's own cost, not the product's. Live model spend by the product remains zero.

## Forecast

Not possible without a budget. The live-model share (evals, nine scenarios, model watch) is
estimated at the following per full run, at list prices, so the humans can size the budget:

| Item | Runs | Est. USD per run | Notes |
| --- | --- | --- | --- |
| Coder eval set (20 tasks, Sonnet) | per model/prompt change | 4–8 | ~20 runs × 50k tokens |
| Researcher eval set (20 tasks, Sonnet/Opus) | per model/prompt change | 6–12 | |
| Critic calibration on both sets | monthly | 5–10 | Opus at tier 2 |
| Nine scenarios × 3 runs × 2 OS | release | 60–120 | Haiku chat, Sonnet work, Opus critic |
