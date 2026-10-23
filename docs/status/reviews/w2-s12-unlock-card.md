# Review: w2-s12-unlock-card

Branch `wave/w2-s12-unlock-card`, reviewed at 3c5717b against `origin/ccr-4d8a843c-1k9syk`
(c713755; the branch's merge base is 049ed52).

## Review

Verdict: **revise**. Score: 72/100 (as built at 3c5717b).

The protocol work is sound and well tested: the WebCrypto `wrapVaultKey` in
`@forerunner/vault` unwraps byte for byte on the real runner and the encrypted file vault
(`services/cloud-runner/test/vault-unlock.test.ts`), the card renders in both inboxes with the
brief's fields and buttons, deny never touches the key, the phone runs the biometric prompt
first and never queues the answer, and the approvals web page is read-only with the reason.
What is wrong: the daemon's wrap route is a key-export oracle for any caller with the daemon
token, the auto-unlock only works while the inbox screen happens to be open, and the
documented way to get the runner's key onto the desktop does not exist, so on a real install
the desktop card is always read-only.

Requirements checked:

- Unlock card in both inboxes (runner, project, time, challenge age; Unlock once / allow for
  1 h, 8 h, 24 h / clear / Deny): met (`UnlockCard.tsx`, `unlock-card.test.tsx`,
  `mobile-unlock.test.tsx`).
- Answering calls the device-side function with the key from the OS keyring through the shell
  bridge, the key never in the web layer longer than the call: met on Android
  (`secureStoreRunnerKeys`, zeroed in `finally`); on the desktop the daemon wraps it (ADR 0068
  explains why not a Rust command: the shell exposes no IPC, `capabilities/default.json`
  grants `core:default` only, verified). But the daemon route trusts a challenge from the body
  (finding 1).
- The answer signed and sent like other answers, the window stored with the answer: met
  (desktop `POST /requests/:id/answer`; phone device-signed with the biometric flag; window
  recorded only after acceptance). Verified that both the daemon's and the state service's
  answer routes accept an object answer (`AnswerRequestBody` / `AnswerBody`: `z.unknown()`).
- Auto-unlock: when a window is active the app answers the next challenge automatically
  through `shouldAutoAnswer` with a notice: partly met (finding 2: only while the inbox
  screen is mounted).
- A shell without a keyring (approvals web) shows the card read-only with the reason: met
  (`apps/approvals-web/test/inbox.test.tsx`, `noKeyringBridge` on the `/m` browser bundle).
- Tests named by the brief: present and green (18 tests in the two ui files at 3c5717b).
- Docs (apps.md, cloud-runner.md, security.md, runtime.md), ADR 0068, requirements S.12,
  BLOCKERS S.12, PROGRESS: present; the stand-in they name is wrong (finding 3).
- Semantic conflicts with the base: the base (c713755) moved on; `git merge-tree` shows one
  textual conflict (finding 4); no other overlap in behaviour (the base's `w4-desktop-confirm`
  touches device confirmations of commands, not request answers).

Findings:

1. **medium (security)** `packages/runtime/src/secrets/runner-unlock-routes.ts:71-76`:
   `POST /runner-unlock/wrap` takes the challenge card from the request body and wraps the
   runner's vault key to whatever X25519 public key that card names. No runner, no stored
   request, no inbox entry is needed: any holder of the daemon token can post a card with its
   own key pair and decrypt the vault key, which ADR 0068 itself rejects as "a daemon route
   returning the key" one step removed. Verified: the branch's own
   `packages/runtime/test/runner-unlock-routes.test.ts` "wraps the stored key to the
   challenge" builds a card that was never filed anywhere and unwraps the stored key from the
   200 answer. Fix: the body names the open request (`requestId`); the daemon loads it from
   its store and wraps only to the challenge on an open `credential` request of this human,
   with a test that a free-standing card, an answered request, another human's request and a
   non-unlock request are all refused.
2. **medium** `apps/ui/src/pages/InboxPage.tsx:281` and
   `apps/ui/src/mobile/screens/InboxScreen.tsx:41`: `useAutoUnlock` runs inside the inbox
   page / screen, so the "auto-unlock window" answers only while the human has the inbox open.
   On any other screen a runner that restarts inside the window waits for its 10-minute
   challenge to expire, refiles, and gives up after three attempts. Verified with a throwaway
   test (deleted): window record open, an unlock request in the fake daemon, `renderApp("/")`
   (home), 1.5 s later no `POST /requests/:id/answer`. Fix: run the auto-answer at the app
   level (desktop `Shell`, phone `MobileShell`) from the inbox the app keeps anyway, with one
   shared window record so the page and the shell agree, and a test that answers from the
   home screen on both.
3. **medium** `docs/status/BLOCKERS.md:44`, `docs/maintainers/cloud-runner.md:427`,
   `docs/decisions/0068-runner-unlock-card-window-and-key-bridge.md:87`: the stand-in for
   getting the runner's key onto the desktop is "storing the key on the device with
   `pnpm fr`", but `fr` has no command that writes a secret (`pnpm fr --help`: setup, status,
   doctor, kill, daemon, dirs, update, models, mirror, sources, audit; the wizard only stores
   the GitHub and model credentials). So on a real install the daemon never finds
   `cloud_runner_vault_key:<runner>` and the desktop card is always read-only. Fix: an
   `fr runner-key import|status|remove` command that stores the runner's `vault.key` (raw 32
   bytes or base64) in the same vault the daemon opens, never printing it, with a test; docs
   and the status rows name it.
4. **low** `apps/ui/test/fake-daemon.ts:149`: the `runnerKeys` option is appended at the end of
   `FakeDaemonOptions`, exactly where the base (c713755) appends its `me` option, so the branch
   no longer merges cleanly (`git merge-tree --write-tree HEAD origin/ccr-4d8a843c-1k9syk`:
   "CONFLICT (content): Merge conflict in apps/ui/test/fake-daemon.ts"). Fix: place the option
   away from the base's hunk.
