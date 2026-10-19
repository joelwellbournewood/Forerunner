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

## Forecast

Not possible without a budget. The live-model share (evals, nine scenarios, model watch) is
estimated at the following per full run, at list prices, so the humans can size the budget:

| Item | Runs | Est. USD per run | Notes |
| --- | --- | --- | --- |
| Coder eval set (20 tasks, Sonnet) | per model/prompt change | 4–8 | ~20 runs × 50k tokens |
| Researcher eval set (20 tasks, Sonnet/Opus) | per model/prompt change | 6–12 | |
| Critic calibration on both sets | monthly | 5–10 | Opus at tier 2 |
| Nine scenarios × 3 runs × 2 OS | release | 60–120 | Haiku chat, Sonnet work, Opus critic |
