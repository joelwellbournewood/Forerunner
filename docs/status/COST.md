# Cost

All spend by milestone and by model. The Anthropic key arrived on 2026-10-20 (see BLOCKERS.md)
with 100 USD of credit on it: the live-run budget is 100 USD (`FORERUNNER_LIVE_BUDGET_USD`),
warning at 80%. Split: evals and critic calibration 30 USD, nine scenarios 50 USD, reserve
20 USD. The live runs of 2026-10-20 (rows below) charged USD 5.930943 of the 100 USD over six
runs, every call in `tests/live/spend.json` (ADR 0040; the ledger is read before each call and
the caps are enforced in code); the subscription half of the phase 1 check ran on the Claude
subscription through the Agent SDK (ADR 0044), which is plan usage, not USD: those rows carry
USD 0 and the SDK's list-price estimate in their note. On 2026-10-23 the human provided a new
API key and workspace (held in the git-ignored `.env.build`) and the live-run budget became
200 USD (`FORERUNNER_LIVE_BUDGET_USD=200`, warning at 160), the per-run cap 15 USD unchanged; one
probe run of the phase 1 file on it charged USD 0.1170 (row below), the ledger standing at
USD 6.0479. The build agent's own token use in the build container is
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
| 2026-10-20 | 1–8 | build sub-agents (live harness 1.02M, remote commands and sync gate 1.50M, nine scenarios 2.98M, live-findings fixes 1.79M tokens; 27 agents) | 7,288,763 tokens (27 agents) | | | n/a | n/a |
| 2026-10-20 | 1–8 | build sub-agents (subscription path 1.56M, gate harnesses 5 and 7 1.65M, runtime gaps 1.90M tokens; 20 agents) | 5,111,915 tokens (20 agents) | | | n/a | n/a |
| 2026-10-20 | 1–8 | build sub-agents (requirements close-out 7.76M, runtime follow-ups 9.60M, security review 15.65M tokens; 26 agents; measured from the agents' transcripts as input, cache writes and output, cache reads excluded; the close-out and security waves were stopped in their fix stage for budget) | 33,010,352 tokens (26 agents) | | | n/a | n/a |
| 2026-10-21 | 1–8 | build sub-agents (security fixes 4 agents, their review 6, audit export, small-project mode and the sign-off follow-up with reviews 10; measured as above; the last fix stages were interrupted at the credit limit) | 16,835,903 tokens (20 agents) | | | n/a | n/a |
| 2026-10-23 | 1–8 | build sub-agents (wave 1: approvals spent per call, email identity and log, the B.6 review, plan approval, the Android raw-CDP attach; 5 builds, 5 independent reviews and the fix stage interrupted at the credit limit; the orchestration tool's own usage figures, measured) | 2,349,340 tokens (16 agents) | | | n/a | n/a |
| 2026-10-23 | 1–4 | build sub-agents (wave 2a: 7 items started, 3 built: PM intake, project docs by PR, cross-project promotion; the others interrupted; measured) | 1,734,165 tokens (10 agents) | | | n/a | n/a |
| 2026-10-23 | 1–8 | build sub-agents (waves 2b and 4: 3 and 3 builds completed (source discovery, the email settings page, shared secrets; install identity, private memory, Android signing), the rest interrupted; both waves were stopped before their usage was reported) | not measured | | | n/a | n/a |
| 2026-10-23 | 5 | build sub-agents (wave 3: stopped at the credit limit before any build completed; the O.9 item was finished afterwards from its branch and merged; not measured) | not measured | | | n/a | n/a |
| 2026-10-23 | 8 | triage agent (severity triage of every known issue for release criterion 4, `docs/status/reports/triage-2026-10-23.md`; measured) | 293,241 tokens (1 agent) | | | n/a | n/a |
| 2026-10-23 | 1–8 | integration agent (fifteen merges, the migration renumbering, the gate-5 stand-in, the scaffold, intake and plan-approval integration fixes, the full check; an estimate, not a reported figure) | about 200,000 tokens (1 agent) | | | n/a | n/a |
| 2026-10-23 | 1–8 | Claude Code runs on GitHub Actions earlier in the day (the first merge wave, its integration and status work, before the build moved to Managed Agents sessions; API-billed) | not reported per run | | | about 85 | about 68 at 0.8 |
| 2026-10-23 to 2026-10-24 | 1–8 | Managed Agents sessions (API-billed): the builds, independent reviews with their fix stage, and the rebases of the 27 items merged on 2026-10-23 and 2026-10-24, plus this status pass; roughly 90 sessions: a build 1 to 12 USD, a review 1 to 3 USD, a rebase 2 to 5 USD | not reported per session | | | about 230 | about 184 at 0.8 |
| 2026-10-20 | 1, 3 | claude-sonnet-5-5 | live run `2026-10-20T17:07:09Z` (`pnpm --filter @forerunner/live test:live`): phase 1 live half (3 coder tasks, 3 tier 1 reviews, the kill switch call), 10 timing requests, critic calibration (20 + 80 reviews) | 557,754 (plus 475,277 cache read, 3,821 cache write) | 143,766 | 2.657774 | 2.13 at 0.8 |
| 2026-10-20 | 1 | claude-haiku-5-5 | same run: one composed chat turn, 10 timing requests | 409 (plus 4,138 cache write) | 194 | 0.000652 | 0.00 |
| 2026-10-20 | 1, 3 | claude-sonnet-5-5 | live run `2026-10-20T17:52:18Z` (the harness after its review, `test:live -t '^(?!.*full 40-task run)'`): phase 1 live half (3 coder tasks, 3 tier 1 reviews, the kill switch call), 10 timing requests, critic calibration subset (20 reviews, 41 calls) | 150,325 (plus 121,502 cache read, 3,821 cache write) | 32,755 | 0.662051 | 0.53 at 0.8 |
| 2026-10-20 | 1 | claude-haiku-5-5 | same run: one composed chat turn, 10 timing requests | 410 (plus 4,139 cache write) | 194 | 0.000652 | 0.00 |
| 2026-10-20 | 1 | claude-sonnet-5-5 | live run `2026-10-20T17:58:04Z` (the phase 1 file alone, after the usage and kill cases were corrected): 3 coder tasks, 3 tier 1 reviews, the kill switch call | 19,736 (plus 32,502 cache read) | 6,058 | 0.106550 | 0.09 at 0.8 |
| 2026-10-20 | 1 | claude-haiku-5-5 | same run: one composed chat turn | 180 (plus 4,139 cache write) | 47 | 0.000559 | 0.00 |
| 2026-10-20 | 3 | claude-sonnet-5-5 | live run `2026-10-20T18:17:27Z` (the phase 3 file: critic calibration re-run after the ADR 0042 fix, prompt 1.1.0, subset 20 reviews and full set 80 reviews) | 471,961 (plus 626,253 cache read, 3,147 cache write) | 124,222 | 2.319181 | 1.86 at 0.8 |
| 2026-10-20 | 1 | claude-sonnet-5-5 | live run `2026-10-20T18:58:41Z` (the phase 1 file alone with the accepted critic: 3 coder tasks, 3 tier 1 reviews, the kill switch call) | 20,122 (plus 33,291 cache read, 8,871 cache write) | 5,737 | 0.115994 | 0.09 at 0.8 |
| 2026-10-20 | 1 | claude-sonnet-5-5 | live run `2026-10-20T20:04:16Z` (`tests/live/test/live-4-subscription.live.test.ts`, the subscription half): the critic's 3 tier 1 reviews on the API key (7 calls); the coder ran on the subscription, next row | 12,754 (plus 18,882 cache read, 3,147 cache write) | 3,038 | 0.067530 | 0.05 at 0.8 |
| 2026-10-20 | 1 | claude-sonnet-5-5 on the Claude subscription (Agent SDK) | same run: 3 coder tasks and the kill-switch run through the SDK driver on the `claude setup-token` value; plan usage, not USD: the SDK's own list-price figure was USD 0.1898 (0.1022 + 0.0540 + 0.0336, none reported for the killed run; the hooks' API-equivalent estimate USD 0.2034), 0.37% of the default USD 50 monthly allowance after the session | 44 (plus 360,654 cache read, 43,306 cache write) | 2,289 | 0 (plan usage) | n/a |
| 2026-10-23 | 1 | claude-sonnet-5-5 | live run `2026-10-23T09:49:08.123Z` (the phase 1 file alone on the new key and workspace, `tests/live/test/live-1-phase1.live.test.ts`): 3 coder tasks, 3 tier 1 reviews, the kill switch call (19 rows, one of them the aborted call at USD 0 with no usage reported); 4 of 5 cases passed, the kill case failing on the harness's classification of the aborted call (gates.md phase 1) | 19,865 (plus 33,291 cache read, 4,743 cache write) | 5,820 | 0.116442 | 0.09 at 0.8 |
| 2026-10-23 | 1 | claude-haiku-5-5 | same run: one composed chat turn | 177 (plus 4,111 cache write) | 45 | 0.000554 | 0.00 |
| 2026-10-24 | 1, 3, 8 | claude-sonnet-5-5 | live-model gate on the final head 422d9c0, run `2026-10-24T00:19:35.074Z` (`pnpm --filter @forerunner/live test:live`: 8 test files passed, 1 skipped; 56 live cases passed, 5 skipped; the killed call recorded `aborted`); ledger committed in bd32dda | 498,093 (plus 668,985 cache read, 4,743 cache write) | 129,550 | 2.437256 | 1.95 at 0.8 |
| 2026-10-24 | 1 | claude-haiku-5-5 | same run: 11 calls (chat turns, timing requests) | 412 (plus 4,981 cache write) | 210 | 0.000766 | 0.00 |

Sub-agent token counts come from the orchestration tool's usage report per wave; they are the
build's own cost, not the product's.

## Build spend of 2026-10-23 and 2026-10-24

The build day's own API spend was about USD 315 (about CHF 252 at 0.8): about USD 230 on
Managed Agents sessions (roughly 90 sessions for the builds, the independent reviews and their
fix stage, the three rebase rounds and this status pass; a build cost 1 to 12 USD, a review 1
to 3 USD, a rebase 2 to 5 USD) and about USD 85 of Claude Code runs on GitHub Actions earlier
in the day. These are the figures the human gave for this status pass, rounded; the sessions do
not report their spend to this repository, so there is no per-item breakdown here. The
subscription (plan) usage of the build is not metered here. None of this is the live-model
ledger below: the live-model gate of 2026-10-24 added USD 2.44 over 242 calls to
`tests/live/spend.json` (commit bd32dda), now USD 8.485961.

## Build spend of 2026-10-25

The build day ran as one orchestrating Claude Code session on the human's subscription with
about nineteen sandbox agents in git worktrees (the seven handover items, the triage re-read,
the small-fixes item, the ten independent reviews). The harness reported the agents' usage as
about 8.9 million tokens in all (about 4.9 million for the first fourteen agents, about 4.0
million for the five reviews resumed after the usage-limit stop at 12:50 UTC); the
orchestrating session's own tokens are not reported to it. No USD figure exists for the day:
subscription usage is not metered here and nothing was charged to an API key (no live-model
run; the ledger below is unchanged at USD 8.485961 of the 200 USD live budget). GitHub
Actions on the public repository's free minutes: 24 `ci.yml` runs on the integration branch
(most cancelled by the next push; 131, 144 and 151 green on both OS, 129 and 139 red and fixed
by the next commit), five `android.yml` runs (all passed) and one `fresh-install.yml` run.

## Build spend of 2026-10-25 night (cloud session)

One orchestrating Claude Code session in the cloud on the human's subscription, with sandbox
agents in git worktrees for the parallel items and the independent reviews (the live tests, the
FCM app half, the V.8 and voice helpers, their fix rounds, and nine reviews). The harness
reported roughly 4.7 million agent tokens; the orchestrating session's own tokens are not
reported to it. No USD figure: subscription usage is not metered here and nothing was charged
to an API key (no live-model call; the ledger below is unchanged at USD 11.131482 of the
human's USD 80 cap). GitHub Actions: `release.yml` run 40229971920 for the rc.1 tag, `ci.yml`
runs on the pushed heads, one dispatched `android.yml` run (40238080672, passed).

Ahead, all on the human's key from launchers on the PC: `run-timings.cmd` (live-5 about
USD 0.002, live-6 about USD 0.31 with a USD 1 ceiling, live-7 about USD 0.68 with a USD 2
ceiling), `voice-run.cmd` (about USD 0.01) and `v8-handover.cmd` (capped at USD 5 for the
session, expected USD 0.1 to 1).

## Live ledger

On 2026-10-25 the live suite ran from the human's PC under the human's lower caps of the day
(`FORERUNNER_LIVE_RUN_CAP_USD=10`, `FORERUNNER_LIVE_BUDGET_USD=80`; the key in the git-ignored
`.env.build`, never read by the session): run `2026-10-25T15:47:34.784Z` in the desktop app's
Linux shell was cut off after 9 Sonnet calls (USD 0.059167, phase 1 session; the shell stops
every process when a command returns), then run `2026-10-25T15:54:57.065Z` on Windows
(Node 24.14.1, 253 ledger rows) ran all nine files: 60 of 61 cases passed (live-4's two harness defects, fixed
in 7b150f8 and a4a84f5), USD 2.531191 for the run: phase 1 half USD 0.1152 (three-task session
0.1144, chat turn 0.0008), timing USD 0.0019, critic calibration USD 2.3531 (subset 0.4819,
full set 1.8712), subscription half USD 0.0610 on the key (the critic's calls; the coder's
three SDK runs are USD 0 `subscription` rows). Ledger after both: 1,097 rows, USD 11.076319
(USD 68.92 left under the day's 80 USD cap); no refusal, no 80% warning. The live-4 re-run
after its harness fix (run `2026-10-25T17:27:00.112Z`, Windows, the file alone) cost USD
0.055163 on the key over 6 metered rows plus 4 USD 0 `subscription` rows; the ledger,
committed from the human's PC by `finish-live.cmd` after both secret scans (77b3fd8), holds
1,107 rows and USD 11.131482 (USD 68.87 left under 80). Outside
the ledger: two one-off fast-mode calls (D.20, ADR 0057 amendment) on Opus 5.5 at 17 input / 4
output tokens each, about USD 0.0003 at the published 8 / 40, and two calls the API refused
before any tokens (no workspace header).

On 2026-10-24 the live-model gate ran on the final head 422d9c0 (run
`2026-10-24T00:19:35.074Z`): 242 calls, USD 2.438022 (Sonnet 231 calls USD 2.437256, Haiku 11
calls USD 0.000766), under the 15 USD per-run cap; the ledger, committed in bd32dda, holds
835 rows and USD 8.485961 of the 200 USD live budget (USD 191.514039 left). The paragraph below
is the ledger as it stood before that run.

`tests/live/spend.json` after the six runs of 2026-10-20 and the probe run of 2026-10-23
(committed in 1b3de7e): 593 rows, USD 6.047939 charged to the API keys (USD 5.930943 on the key
of 2026-10-20 over 569 API rows, USD 0.116996 on the key of 2026-10-23 over 20 rows: Sonnet and
Haiku calls priced from the billing table; rows with `no usage reported` are the calls the kill
switch aborted, one of them in the 2026-10-23 run, recorded `ok` by the metered provider, the
harness defect of BLOCKERS.md "Live harness") plus 4 `subscription` rows at USD 0 (the
Agent SDK runs of run `2026-10-20T20:04:16Z`: plan usage has no USD price, the SDK's list-price
figure sits in each row's note, est. USD 0.1898 in all, and the caps ignore these rows). Remaining
under the 200 USD live budget set on 2026-10-23: USD 193.952061 (under the former 100 USD
budget it would be USD 93.952061). Per run on the keys: `2026-10-20T17:07:09Z` 2.66,
`17:52:18Z` 0.66, `17:58:04Z` 0.11, `18:17:27Z` 2.32, `18:58:41Z` 0.12, `20:04:16Z`
0.07, `2026-10-23T09:49:08Z` 0.12 (of a 15 USD per-run cap each); no 80% warning, no refusal.
Run `2026-10-23T09:49:08Z` by model: Sonnet USD 0.1164 (18 metered calls and the aborted one at
USD 0), Haiku USD 0.0006 (the chat turn). By purpose: run
`2026-10-20T17:07:09Z` phase 1 half USD 0.1192 (session 0.1169, chat 0.0006, kill test 0.0018),
timing requests USD 0.0019, critic calibration USD 2.5373 (subset 0.5278, full set 2.0095); run
`2026-10-20T17:52:18Z` phase 1 half USD 0.1177 (session 0.1161, chat 0.0006, kill test 0.0011),
timing USD 0.0019, calibration subset USD 0.5431; run `2026-10-20T17:58:04Z` phase 1 half
USD 0.1071 (session 0.1066, chat 0.0006, kill test 0: the aborted call reported no usage); runs
`18:17:27Z` the phase 3 calibration re-run with the accepted critic (prompt 1.1.0) and
`18:58:41Z` the phase 1 file alone with it; run `20:04:16Z` the subscription half: USD 0.0675 on the key for the critic's 7 calls, the coder's work on the
plan. The forecast rows below for the calibration are now measured: 80 tier 1 reviews on Sonnet
cost USD 2.01, a 20-review subset USD 0.53 to 0.54.

## Forecast

Not possible without a budget. The live-model share (evals, nine scenarios, model watch) is
estimated at the following per full run, at list prices, so the humans can size the budget:

| Item | Runs | Est. USD per run | Notes |
| --- | --- | --- | --- |
| Coder eval set (20 tasks, Sonnet) | per model/prompt change | 4–8 | ~20 runs × 50k tokens |
| Researcher eval set (20 tasks, Sonnet/Opus) | per model/prompt change | 6–12 | |
| Critic calibration on both sets | monthly | 5–10 | Opus at tier 2 |
| Nine scenarios × 3 runs × 2 OS | release | 60–120 | Haiku chat, Sonnet work, Opus critic |
