## title

Email commands at sending mode off: one reading decided, enforced and tested

## requirements

T.1 (S.16 to S.20, T.2 context)

## adr

0081

## brief

BLOCKERS.md row T.1 replies to the owner in mode off: **partly built** (requirements close-out 2026-10-20): the command toggle is its own setting and its own gate (`packages/capabilities/test/closeout-email-commands.test.ts`, `email-commands.test.ts`; `services/cloud-runner/test/email-watch.test.ts` 'watches nothing while email commands are off') and a reply to the owner goes out in read only, draft only, allowlist and full discretion with the send caps at zero and without an approval ticket (`closeout-email-commands.test.ts`); in mode `off` `EmailPolicy.checkSend` refuses even the reply to the owner (`email-policy.test.ts`, 'allowed in every mode except off') while `EmailWatch.start` reads only the command toggle, so an owner who leaves commands on at mode off gets a task started with no acknowledgement; the spec's modes table ('Off: sends nothing') and its commands section ('replies to you are always allowed') conflict there and no ADR decides it. Stand-in: the setup text says email commands need a sending mode other than off; every command leaves an `email.command` audit row the owner can read. Needed: an ADR picking one reading (the watcher refuses to start at mode off, or the policy lets a reply to the owner through at mode off while commands are on) with its test; then T.1 `done`. Spec T.1: 'Email commands are a separate toggle from the sending modes (S.16 to S.20). Replies to the owner are always allowed.' Note: the machine is shared with other builders; a test that fails only on a timeout under load is re-run once before it is treated as real.

## hints

Read packages/capabilities/src/email/policy.ts (checkSend, modes), commands.ts, settings, services/cloud-runner/src/email-watch.ts (start reads the toggle), the tests named, and docs/decisions/0013-agent-email.md. Decide (ADR 0081) and build one consistent reading; the safer and more useful one: at mode off the mailbox sends nothing, so email commands cannot be on at mode off: turning commands on at mode off is refused by the settings validation with a plain message (and the settings page, which another builder is building on wave/w2-email-page, will read the same validation: keep it in the store/policy layer), switching the mode to off with commands on turns commands off with an audit row and a notification to the owner, and EmailWatch.start refuses to start at mode off with the reason in the log and the health view; replies to the owner stay always allowed in every other mode (already tested). Tests: email-policy / settings tests for the refusal and the automatic switch-off with the audit row, email-watch.test.ts for the refusal to start at mode off, closeout-email-commands kept green. Docs: email.md, cloud-runner.md. Also apply the leftover B.6 residual ONLY if another builder has not: do not; it is on wave/w1-b6-review.

## paths

packages/capabilities/src/email/policy.ts, packages/capabilities/src/email/settings.ts, services/cloud-runner/src/email-watch.ts, tests
