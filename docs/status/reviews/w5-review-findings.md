# Review: w5-review-findings

Branch `wave/w5-review-findings`, reviewed at e68219e against the base
`ccr-4d8a843c-1k9syk` (b1804e3). Stage: REVIEW AND FIX (item w5-review-findings).

## Review

Verdict: **revise**. Score: **80/100**.

The build fixes the wave-1 findings it lists, at the root and with tests that fail without the
fix (spot-checked by mutation, below). Two defects remain: one introduced by the change itself
(the cloud runner now spends a plan approval whose session never starts, silently), and one
pre-existing secret leak the build found, listed as open and "unverified by a test", which is
reproducible with a short test and is a privacy defect on the always-human money path.

Requirements checked (brief: fix every open finding of the five wave-1 reviews, highest
severity first, with the test the finding names, the doc or ADR sentence corrected, one line per
finding in BLOCKERS.md "Open review findings of 2026-10-23", requirement rows consistent):

- w1-plan-approval HIGH, `request.answer` reaches `syncApprovals`: `CommandPorts.requestAnswered`
  wired in compose.ts; removing the call in `request.ts` fails both new cases of
  `plan-approval-daemon.test.ts` (verified by mutation). runtime.md sentence corrected. Met.
- w1-plan-approval HIGH, shared mark between the daemon and the cloud `InboxTrigger`:
  `markPlanAnswer` (version-conditional) shared, the trigger skips marked rows; dropping the
  `planAnswerApplied` filter fails two `inbox-trigger.test.ts` cases (mutation). Met, but see
  finding 1: sharing the mark makes a cloud start failure consume the approval.
- w1-plan-approval MEDIUM, empty plan files no request (`runner.ts`): two closeout-autonomy
  cases. Met.
- w1-plan-approval MEDIUM, superseded approvals in one sync: met (`plan-approval.test.ts`).
- w1-plan-approval MEDIUM, overlapping syncs: promise chain in compose.ts plus the conditional
  mark; replacing `update` by a blind `patch` in `markPlanAnswer` fails three plan-approval
  cases (mutation). Met.
- w1-plan-approval MEDIUM, `start_failed` on a background rejection: met on the PC daemon
  (`reportingPlanStartFailures` around compose.ts `runSession`); not on the cloud runner
  (finding 1).
- w1-plan-approval MEDIUM, the follow-up uses the filing session's cap: met (daemon and trigger).
- w1-plan-approval LOW x2 (per-row try/catch; misnamed test): met.
- w1-b6-review HIGH, `projectCard.nextMilestone` skips cancelled: reverting `openMilestone`
  fails `small-project.test.ts` (mutation). Met. LOW x2 (ADR 0051 sentence, `sample` guard): met.
- and-cdp MEDIUM, `waitFor` visible: the attached-only mutation now fails `cdp.test.ts`
  (verified). MEDIUM `eval` under CSP: the function source is spliced in, the page has no
  eval. LOW x4: met (describeFailure, ADR 0054 Consequences, stable-box wait, `cdp.d.mts`).
- w1-approvals MEDIUM, docs say a late answer is never reused: ADR 0052, runtime.md rewritten,
  behaviour logged open in BLOCKERS. LOW Cloudflare key: `ToolExecutionContext.approvalKey`;
  met for the key, but the same input mismatch also leaks a secret onto the port's own card
  (finding 2).
- w1-email-identity-log: ADR 0039 addendum, `PRIVATEKEY` masking with its test, the others shown
  fixed before this item (c1fc96a, ADR 0084, ADR 0066). Met.
- Status docs: BLOCKERS.md section "Open review findings of 2026-10-23" with one line per
  finding; requirement rows J.6, J.7, E.1, B.6, S.4, S.6, S.15 consistent with the code (J.7
  `done`, tests listed). Met.
- Checks at e68219e: `pnpm typecheck` 0, `pnpm lint` 0 (warnings only),
  `node scripts/docs-check.mjs --base origin/ccr-4d8a843c-1k9syk` ok (41 files); unit tests of
  the touched packages (runtime, commands, capabilities, platform, cloud-runner, apps/mobile/e2e):
  174 files, 1610 passed, 1 skipped.

Findings:

1. **[medium] services/cloud-runner/src/runner.ts:597-623 (with inbox-trigger.ts:221).** An
   approved plan whose cloud session fails after the scheduler took it is spent with nothing
   run and no word to the human. The inbox trigger now claims the plan request and marks it with
   the scheduler's answer; the runner's `requestDecided` answers `started` as soon as the PC
   check passed (`decide(req, "started")`, then `return runSession(r)`), and `runSession`
   rejecting in the background (`claim_conflict` from `SessionRunner.start` while a session of
   the agent is still `running` in the shared store, `provider_auth`, a vault unlock that fails)
   only lands in `scheduler.log`. The card stays `outcome: "started"` with `applied_at`, so the
   PC daemon's sync and every later trigger check skip it. Before this change the unmarked row
   was at least picked up again by the daemon at its next boot; the daemon side got
   `reportingPlanStartFailures` for exactly this, the cloud runner did not. The trigger's own
   `failed` outcome (the PC check throws) is likewise marked `start_failed` with no warning and
   no audit row. Verified with a throwaway-then-kept case in `runner.test.ts` (an approved plan,
   a stale `running` cloud session of the agent): the trigger logs "asking for a session", the
   session start throws `claim_conflict`, and after 5 s the card is still not `start_failed` and
   no warning exists. Fix: wrap the runner's scheduler start in `reportingPlanStartFailures`
   (covering the PC-check throw and the background rejection) and make the reporter's "warn
   once" independent of who wrote `start_failed` first.
2. **[medium] packages/capabilities/src/cloudflare/approvals.ts:154 (deploy.ts:834,
   tools.ts `actorOf`).** A Cloudflare approval the port files itself puts the secret's
   resolved value on the inbox card. The deployer passes `actor.tool.input`, which is the input
   after the hooks resolved its `secret:` references, and the port's insert copies
   `displayForm(req.input)` into `change_card.input`. On the always-human money path (a Worker
   deploy with `logpush: true`, Durable Object migrations, a usage model, a plan change) the port
   always files its own one-shot row, so a deploy whose bindings name `secret:<name>` writes the
   value into `human_request.change_card`, which the inbox, the phone and the shared state
   serve (spec S.4: values never leave the vault except into the tool call). The build found
   this and left it open as unverified. Verified with a `cloudflare-wiring.test.ts` case
   (autonomy 2, staging Worker with `logpush: true` and a `secret_text` binding by reference,
   through the real hooks and the tool): the money row's card does not carry the reference
   (it carries the resolved input). Fix: hand the tool the hooks' own display copy of the
   input (before resolution) next to `approvalKey`, show that on the card, and fall back to the
   resolved input only for a direct caller that resolved nothing.
