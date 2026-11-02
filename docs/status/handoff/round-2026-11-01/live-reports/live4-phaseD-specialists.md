# Live walk 4: phase D, every specialist on the real model (helper session), 2026-11-02 01:34-02:04 UTC

USD 0.54 over 47 calls (specialists 0.33, critic 0.21), all claude-sonnet-5-5. Code at 3455a24..e20c0b2-era
branch tip (before wave 3). Projects without a brief, one task each, light review unless noted.

| Specialist | Ran? | Work | Critic | Cost/time |
|---|---|---|---|---|
| researcher | No: refused at once (needs_human) on an API key | none | none | 0 |
| writer-marketing | yes | docs/copy.md meets every criterion; placeholders marked; scratch notes.md left at root | accept 88 (miscounts the headline) | ~0.07 / 20 s |
| designer | yes | palette + type scale, contrast ratios correct; styles.css good | accept 92 (recomputed ratios) | ~0.10 / 60 s |
| data-analyst | yes | monthly totals and best month exactly right; valid SVG; "Lesson:" lines leaked into report.md | accept 88 but "I could not see data/sales.csv" | ~0.09 / 40 s |
| migration-specialist | yes | config.yaml right, json removed, node test.js passes; flat-YAML parser stated | accept 92 but "comes from the worker's report only" | ~0.07 / 39 s |
| science-evaluator | No: same refusal (twice); as data-analyst it ran: "not supported", +10.58%, CI 4.9-16.7% (correct) | | accept 88 "input data not shown to me" | ~0.09 / 40 s |
| reviewer | yes | both planted bugs at the right lines with fixes; wrote review.md via node -e in run_command (no write_file) | accept 80 "app.js was not in the request" | ~0.05 / 39 s |
| ops-deploy | full review: waits for Docker (expected); at light review: sound Dockerfile + runbook, says criterion 1 not verified | | accept 86, task Done anyway | ~0.07 / 40 s |

Exact texts: researcher badge "Paused", drawer "The researcher works from the web (cc:WebFetch, cc:WebSearch), but
runs billed to an API key get…. Press Resume to let a session run it." (reason cut mid-sentence); session
"Finished task: needs human (CHF 0.00)", "Session review: accepted (grade 100, 0 finding(s))"; Inbox Update
"… needs your decision (Inbox)." but no card in Needs you. Ops-deploy Start dialog "Nothing can run: … is
waiting for Docker … Docker is installed but not running." (Docker is not installed); drawer "Full review needs
Docker, not running on this computer. Set it up, or edit to a light review."

Problems: (1) MAJOR a refused/needs_human task never reaches the Inbox; (2) MAJOR "Paused"/"Press Resume" dead
end, reason cut at ~200 chars with tool names, stale reason after editing the specialist, New task offers
researcher/science-evaluator on an API key without warning; (3) MAJOR data-only science tasks refused (registry
lists cc:WebFetch); (4) MAJOR the critic judges only the diff and gets no command output (4 of 6 accepts on the
worker's word); (5) MAJOR Done with a criterion "not verified" (ops-deploy) and the drawer suggests a light
review for a deploy; (6) MAJOR git fails in run_command where GIT_CONFIG_* is set (scrubEnv in
packages/runtime/src/agent/sdk.ts:549 strips GIT_CONFIG_KEY_n but keeps GIT_CONFIG_COUNT); (7) MAJOR result not
reachable (fixed since by wave 3's Files tab and Open folder) and work staged but never committed; (8) minor
session review "accepted (grade 100)" for 0 of 1 tasks; (9) minor Start dialog untrue about Docker; (10) minor
"Lesson:" lines and scratch notes.md in deliverables; (11) minor reviewer writes via run_command; (12) minor a
closed Settings preview left an approval card; (13) polish: Settings risk words, raw JSON on the calibration
card, CHF 150.40 default, "No Claude credential is saved yet" on the bench, "Checks only" in the review list,
"Stop now" on a finished session.
