## title

The cloud runner's vault unlock is answered from the desktop and Android inbox: the unlock card with the auto-unlock window

## requirements

S.12 (S.10, S.11, ADR 0033 context)

## adr

0068

## brief

BLOCKERS.md row S.12 device-side vault unlock in the shells: **partly built**: the runner side and the device-side functions are complete and tested against the real encrypted file vault (`services/cloud-runner/test/vault-unlock.test.ts`: one-time challenge, key wrapped to it, wrong, stale and tampered answers refused, expiry, deny, the auto-unlock window set with the answer, the key never in a log line or a store row); no desktop or Android screen calls `answerUnlockChallenge` or `shouldAutoAnswer`, and the real runner host is its own row. Stand-in: the device-side call from a script on the human's machine. Needed: the unlock card in the inbox of the desktop and Android apps (answer with the key from the OS keyring, set or clear the window), tested in `apps/ui/test`, then one unlock on the real host (not possible here); then S.12 `done`. Spec S.12: 'Vault, cloud runner: encrypted blob, key held by the human's device. Human approves unlock per runner start, or sets an auto-unlock window.'

## hints

Read services/cloud-runner/src (the unlock protocol: how the challenge is filed (a human_request? a device message?), answerUnlockChallenge and shouldAutoAnswer and what they need: the vault key from the device's keyring, the challenge, the window), docs/decisions/0033-cloud-runner-unlock-and-precedence.md, apps/ui/src/pages/InboxPage.tsx and apps/ui/src/mobile/screens/InboxScreen.tsx (how request kinds render and answer, the signed answer path on the phone, the biometric rule for high risk of ADR 0045), apps/ui/src/shell or the Tauri inject (how the desktop shell exposes the OS keyring: apps/desktop/src-tauri/src/secret.rs; the Android KeystorePlugin via apps/ui/src/mobile/shell-bridge.ts), and the daemon/state-service routes the device uses. Build: (1) an unlock card in both inboxes when a runner start files an unlock challenge: shows the runner, the project, the time, the challenge age, buttons Unlock once / Unlock and allow for N hours (the window: 1h, 8h, 24h, clear) / Deny; (2) answering calls the device-side function with the vault key fetched from the OS keyring through the shell bridge (desktop: the Rust secret command; Android: the Keystore plugin), never the key through the web layer in clear longer than the call, the answer signed and sent to the state service like other answers, the window stored with the answer; auto-unlock: when a window is active, the app answers the next challenge automatically through shouldAutoAnswer and shows a notice; (3) a shell without a keyring (approvals web) shows the card read-only with the reason. Tests: apps/ui/test/unlock-card.test.tsx (desktop: card renders, unlock once answers with the key from the fake bridge and the key never appears in the DOM or the fake service's calls beyond the wrapped answer, window set and cleared, deny, auto-answer within the window, read-only without a keyring), apps/ui/test/mobile-unlock.test.tsx for the phone. Docs: apps.md, cloud-runner.md, security.md. ADR 0068 for the window rule and the bridge contract.

## paths

apps/ui/src/pages/InboxPage.tsx, apps/ui/src/mobile/screens/InboxScreen.tsx, apps/ui/src/mobile/shell-bridge.ts, services/cloud-runner/src, tests
