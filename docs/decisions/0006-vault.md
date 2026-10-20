# 0006 — Vault: OS keychain via @napi-rs/keyring with an encrypted file store fallback

Date: 2026-10-20
Status: accepted

## Context

The spec (Architecture item 8, "Secrets vault" table, platform table) asks for the OS keychain
locally (Windows Credential Manager, libsecret on Linux), an encrypted store for the cloud
runner whose key is held by the human's device, and secrets by reference: agents name a
secret, the runtime injects the value into the tool call, the value never enters model
context, logs or git. Everything must work on Windows and Linux from one code path, with no
org, host or user path baked in.

## Decision

`packages/vault` exposes one `Vault` interface (`set/get/delete/list/has`, names matching
`^[a-z][a-z0-9_.:-]{0,127}$`) with three backends and one chooser:

| Backend | Where | Why |
| --- | --- | --- |
| `KeyringVault` | desktop installs | `@napi-rs/keyring` wraps keyring-rs: Credential Manager, Secret Service (GNOME Keyring, KWallet) and macOS Keychain behind one API, prebuilt binaries for every target we ship, no node-gyp at install time. The OS unlocks it with the user's login, which is what the spec's "Unlock: OS login" means. |
| `EncryptedFileVault` | cloud runner; desktop when no keyring answers | One JSON file, AES-256-GCM per entry with the entry name as authenticated data, key derived with scrypt from a 32-byte device key or a passphrase. The runner holds the blob and starts locked; the human's device sends the key at unlock time. |
| `MemoryVault` | tests, `FORERUNNER_VAULT_BACKEND=memory` | nothing persists |

`openVault()` probes the keyring (write, read back, delete a random internal name) and falls
back to the file vault with a logged reason; `FORERUNNER_VAULT_BACKEND` forces a backend, and
forcing `keyring` where none exists fails loudly instead of downgrading silently.

Details that are not obvious:

- **Index entry.** Keychains cannot enumerate, so each service keeps `__index__`, a JSON array
  of names, in the same service. `set` writes the entry and then the index; `delete` removes
  the name from the index and then the entry. A crash between the two steps leaves at worst an
  entry that `get` finds but `list` does not; the next `set` of that name repairs the index.
  All operations of one process are serialised with a mutex so the index read-modify-write
  never interleaves. `findCredentials(service)` exists in keyring-rs but is not implemented
  uniformly across stores, so the index is the portable answer.
- **Chunking.** Windows caps a generic credential blob at 2560 bytes (1280 UTF-16 units).
  Values longer than 1024 characters, including SSH keys and the index itself when it grows,
  are split into `<name>#<i>` entries behind a header in `<name>`. Linux and macOS take the
  same path so there is one code path to test.
- **Linux store pinned to Secret Service.** keyring-rs would otherwise fall back to the kernel
  keyring (keyutils), which is lost at logout or reboot; a vault that forgets secrets on reboot
  is worse than the encrypted file. Without a Secret Service the probe fails and the file vault
  takes over.
- **Service name.** `forerunner`, or `forerunner-<profile>` so the two-install test
  environment (`forerunner-test-a`, `forerunner-test-b`) shares one OS keyring without
  colliding. The file vault uses `vault.<profile>.json` for the same reason.
- **scrypt parameters.** `N=16384, r=8, p=1` (16 MiB, tens of milliseconds): libsodium's
  "interactive" level, chosen because unlocking happens at every app start and the device-key
  path already has 256 bits of entropy, so the KDF matters only for passphrases. Parameters
  are stored in the file, so new vaults can raise them without migrating old ones. Tests pass
  `N=1024`.
- **Key check value.** The file carries `check`, an encryption of a constant under the derived
  key, so a wrong key is reported as `wrong_key` even on an empty vault and is distinguishable
  from a tampered entry (`integrity`).
- **node:crypto instead of libsodium.** The spec says "libsodium-encrypted"; AES-256-GCM from
  `node:crypto` gives the same guarantees (authenticated encryption, random nonces) with no
  native dependency and no second crypto library to audit. Recorded here as a deliberate
  deviation in mechanism, not in property.
- **Atomic writes.** Temp file in the same directory, fsync, rename over the target, directory
  fsync where the OS allows it. `vault.key` is written 0600 and the directory 0700 on POSIX;
  Windows ignores modes and the per-user profile directory ACL protects the files instead.
- **Secrets by reference.** `resolveSecretRefs` replaces only whole-string `secret:<name>`
  values whose name is in the run's granted set; `secret_not_granted` is thrown before any
  vault read, and the input is never mutated. `SecretResolver` remembers the values it handed
  out so `redactValues` can scrub them (plain, JSON-escaped, URL-encoded and base64 forms) from
  tool outputs and logs. This is the adapter the runtime's `SecretsPort` is wired to.

## Consequences

- Every backend is unit-tested without a real keyring (fake entry factory); the real keyring
  suite runs only where a probe succeeds and skips visibly otherwise, so CI on Linux runners
  without a session bus still proves the fallback.
- A `no-leak` test captures logs, console and every error across all backends and failure
  paths and asserts no stored value appears. The repository secret scan covers the rest.
- Grants, scopes and "who may read" live in the state store's `secret_ref` table and in the
  capability token, not in the vault: the vault is name -> value only.
- Shared secrets across two humans (spec: "both humans approve the grant") are a runtime and
  state-service concern layered on top: the value sits in the owner's vault and is injected
  only into runs whose token names it.

## Alternatives considered

- `keytar`: unmaintained, needs node-gyp on install. `@napi-rs/keyring` has a keytar
  compatibility layer if a dependency ever needs it.
- Tauri's `tauri-plugin-stronghold` or `keyring` plugin: ties the vault to the desktop shell,
  but the runtime and the cloud runner are Node processes without a Tauri shell.
- Envelope encryption (random data key wrapped by the passphrase key): allows passphrase
  changes without re-encrypting entries. Not needed for 1.0; vaults are small and re-encrypting
  on a passphrase change is a one-line loop over `list()`.
- Kernel keyring (keyutils) as the Linux fallback: volatile across reboots, rejected.
