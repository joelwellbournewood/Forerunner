# 0068 — Runner unlock card: the auto-unlock window rule and the key bridge contract

Date: 2026-10-23
Status: accepted

## Context

Spec S.12: "Vault, cloud runner: encrypted blob, key held by the human's device. Human approves
unlock per runner start, or sets an auto-unlock window." ADR 0033 fixed the protocol: the runner
files a blocking, high-risk `credential` request whose `change_card` is a one-time challenge
(X25519 public key, nonce, expiry); the device answers with the 32-byte vault key wrapped to it
(X25519 + HKDF-SHA256 + AES-256-GCM); the answer may set or clear
`human.notify_prefs.cloud_runner.auto_unlock_until`. The runner side and a node:crypto device
function (`answerUnlockChallenge`) were built and tested, but no screen answered a challenge:
the inboxes showed the card as raw JSON with `unlock` / `deny` buttons, and a plain "unlock"
answer is refused by the runner as `malformed`.

Three things had to be decided:

1. Where the key comes from on each device, and how much of the app may see it. The desktop
   web view talks only to the daemon (ADR 0011, 0025); the desktop Tauri shell exposes no IPC
   command to the web view at all (its capability file grants `core:default` only). The daemon
   already holds the OS keyring through `@forerunner/vault`. The Android shell already exposes a
   Keystore-wrapped secure store (`secure_store_get`, ADR 0032). The web views cannot import
   node:crypto.
2. Which window the device auto-answers from. The phone cannot read `human.notify_prefs` (the
   state service's `/me` does not carry it).
3. Whether the window relaxes ADR 0045's rule that a high-risk answer from a phone needs the
   biometric assertion.

## Decision

**One device implementation, WebCrypto only.** `packages/vault/src/runner-unlock.ts` holds the
device side with no imports: `parseUnlockChallenge`, `wrapVaultKey` (async, WebCrypto X25519,
HKDF, AES-GCM, byte for byte the protocol of ADR 0033), the constants, the window rule
(`autoUnlockUntilOf`, `shouldAutoAnswer`, `autoUnlockWindowEnd`: at most a week, the runner's
`MAX_AUTO_UNLOCK_WINDOW_MS`), the key names and `decodeStoredKey`. The runner imports its
constants and the window rule from there, so the two ends cannot drift; a cloud-runner test
proves a WebCrypto answer unlocks the real runner and encrypted file vault.

**The bridge contract.** The inbox talks to a `RunnerKeyBridge`
(`apps/ui/src/lib/runner-unlock.ts`): `status(runnerId)` says whether this device can answer
(and why not), `wrap(card, { requestId, now, autoUnlockUntil? })` returns the wrapped answer. A bridge never
returns the key. Implementations:

- Desktop: `daemonRunnerKeys(client)`. The daemon reads `cloud_runner_vault_key:<runner>` from the
  install's vault (`GET /runner-unlock/:runnerId/key`, `POST /runner-unlock/wrap { requestId }`),
  wraps it and zeroes it inside the handler, and writes one `runner.unlock_answer_wrapped` audit
  row. The page names the request; the daemon takes the challenge from that stored request (open,
  `credential`, this human's) and never from the body, so a holder of the daemon token cannot
  have the key wrapped to a key pair of its own choosing (review finding 1). The key
  never enters the web view. (The brief named a Rust secret command; the desktop shell has none
  and adding a keyring crate plus a webview-callable command would widen the shell's IPC surface
  for no gain over the daemon, which already holds the keyring.)
- Android: `secureStoreRunnerKeys(shellSecureStore)` reads `runner-vault-key-<runner>` from the
  Keystore-wrapped store for the one call, wraps it with WebCrypto and zeroes the bytes in
  `finally`. The base64 string the IPC returns is the one copy JavaScript cannot erase; it is not
  stored, logged or rendered.
- No keyring (the browser fallback of the `/m` bundle): `noKeyringBridge(reason)`; the card is
  read-only with the reason. A device without the runner's key is read-only the same way.

The UI sends the wrapped answer as the request's answer through the existing paths (desktop:
`POST /requests/:id/answer` on the daemon; phone: the signed state-service answer), so the
decision log and the runner's verification are unchanged.

**The card.** Runner, project, filing time, the challenge's age and time left; Unlock once,
Unlock and allow for 1 / 8 / 24 h, Unlock and clear the window, Deny. Deny sends `"deny"` and
never touches the bridge. An expired challenge offers nothing (the runner withdraws it and files
a fresh one).

**The window rule.** The runner's copy (`notify_prefs`) decides what the runner does: re-unlock
from its cached key inside the window, forget at the end. On the device, auto-answer is driven by
the window **this device set** with an accepted answer, recorded locally (desktop: browser
storage `runnerUnlockWindow.<human>`; phone: `forerunner.mobile.<install>.runnerUnlockWindow`),
recorded only after the service accepted the answer and dropped by "clear". While it is open the
next challenge (a runner that restarted and lost its cached key) is answered once, leaving the
window as it is, and a notice says so; each request is tried once and a failure leaves the card.
The auto-answer runs once per app at the shell (desktop `RunnerAutoUnlock` in `Shell`, the
phone's `MobileShell`), not in the inbox screen, so it works whatever screen is open: a runner
waits at most ten minutes per challenge and three attempts, and a window that only worked with
the inbox open would not be a window (review finding 2).
A device that did not set the window asks. This keeps auto-answer an explicit consent on the
device that answers, and works on the phone, which cannot read `notify_prefs`.

**Biometrics are not relaxed.** On the phone the unlock request is high risk, so every answer,
including the automatic one and Deny, runs the biometric prompt first and is never queued in the
outbox (ADR 0045). The window saves the choice, not the fingerprint.

## Consequences

- The key exists in clear on the desktop only inside the daemon process (as before, in the
  vault), and on the phone in JavaScript for one call.
- A device must hold the runner's key before it can answer. On the desktop
  `fr runner-key import <runner> <file>` stores the runner vault's `vault.key` (raw or base64)
  under `cloud_runner_vault_key:<runner>` in the vault the daemon opens, never printing it (review
  finding 3); the phone has no import screen yet (BLOCKERS S.12).
- Two devices can both hold windows; each auto-answers only inside its own. Clearing on one
  device clears the runner's copy (the answer carries `null`) but not the other device's record;
  that device's next automatic answer then reaches a runner that keeps no cached key, which is
  still a per-start approval by a device the human configured.
- The approvals web app (a separate bundle with no keyring) already showed credential requests
  without answers; it now names the runner and says to unlock from the desktop or Android app.

## Alternatives considered

- **A Tauri command on the desktop returning the key to the web view.** Puts the key in the web
  layer and needs a new native keyring dependency and an IPC grant; the daemon already has the
  keyring.
- **A daemon route returning the key.** Anyone with the daemon token could read it; the wrap route
  hands out only an answer bound to one runner key pair and one challenge.
- **Auto-answer from the human's `notify_prefs` on every device.** The phone cannot read it, and a
  window set on one device would make every device answer without any consent there.
- **Skipping the biometric prompt inside the window.** Would make the phone's high-risk rule
  depend on a setting; rejected.
