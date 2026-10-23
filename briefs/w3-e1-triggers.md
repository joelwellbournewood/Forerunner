## title

CI results and PR comments start sessions: a poller over the git host fires the ci and pr_comment triggers

## requirements

E.1 (E.2, E.3 context)

## adr

0075

## brief

BLOCKERS.md row E.1 CI-result and PR-comment session triggers: **partly built**: manual, schedule, message or human answer, and verified email start sessions (`session.test.ts`, `services/cloud-runner/test/inbox-trigger.test.ts`, `packages/capabilities/test/email-commands.test.ts`); `ci` and `pr_comment` exist as trigger kinds (`SESSION_TRIGGERS`) but nothing fires them: no poller or webhook calls `Scheduler.request` on a check run or a PR comment. Stand-in: the next scheduled or manual session reads CI status and PR comments through the git host (`github.ts`, check runs). Needed: the poller against the fake git host firing both kinds; then E.1 `done`. Spec E.1: 'Session triggers: manual start, schedule, new message or human answer, CI result, PR comment, verified email from the owner (module T).' Note: the machine is shared with other builders; a test that fails only on a timeout under load is re-run once before it is treated as real.

## hints

Read packages/runtime/src/session/triggers.ts (Scheduler.request, StartRequest, quiet hours), the git host port and the GitHub adapter (check runs / combined status per ref, PR comments / review comments listing with since; the fake host in testenv/src/githost supports check runs, comments and webhooks with HMAC), the PR rows the runtime keeps (which PRs belong to which agent/task), the daemon's composition (where watchers run on the clock: RemoteCommandWatcher, the approvals poll) and the content rule (a PR comment is data, never an instruction: the session brief quotes it; anything instruction-like is flagged like email content, see the injection scan in packages/runtime/src/injection). Build: a GitHostWatcher on the Clock (interval configurable, FORERUNNER_GITHOST_POLL_MS) that, for every open PR of the install's agents, polls check-run conclusions and new comments since the last cursor (persisted so a restart does not re-fire), fires Scheduler.request with trigger `ci` (a failed or completed check on the agent's PR, with the check name and conclusion in the reason) or `pr_comment` (a new comment by someone other than the agent itself, quoted in the brief as data, scanned for injection and flagged), dedupes per check run id / comment id, respects quiet hours and the one-active-session rule (a conflict is logged, not thrown), and records each firing as an audit row; an optional webhook receiver on the daemon for the same events (HMAC verified, same dedupe) is a bonus only if cheap. Tests: packages/runtime/test/githost-watcher.test.ts against the fake git host on the simulated clock (a failed check fires ci once; a comment fires pr_comment once with the quote; the agent's own comment does not; a restart keeps the cursor; quiet hours defer; an instruction in a comment is flagged and never followed), a compose/daemon wiring test. Docs: runtime.md (triggers, daemon), capabilities.md if the port grows. ADR 0075: polling vs webhooks and the dedupe rule.

## paths

packages/runtime/src/session/triggers.ts, packages/runtime/src/session, packages/capabilities/src/githost, packages/runtime/src/daemon/compose.ts, tests
