# Security

Threat model, the secrets vault (`packages/vault`), secrets by reference, and the injection
test suite. Sections that belong to other areas say so and are filled by the PR that builds
them.

## Purpose

Forerunner holds credentials that can spend money and change code (API keys, subscription
tokens, GitHub PATs, deploy tokens, SSH keys, passwords of agent-owned accounts) and lets
language models drive tools with them. The rules the code enforces:

1. A value lives in the vault only. It is never written to the state store, git, logs,
   approval cards, audit entries or model context; those carry the name (`secret:github_pat`).
2. A run can use a secret only when its capability token names it. The model never decides
   that; the runtime hooks do (`docs/maintainers/runtime.md`).
3. Tool outputs and logs are scrubbed of every value a run resolved, and the repository secret
   scan (`pnpm secrets:scan`) fails CI on credential shapes.
4. Each human's vault is theirs: the other person's agent never reads it. Shared secrets are a
   grant layered on top, approved by both humans (to be filled by state-service / runtime).

### Threat model for secrets

| Threat | Where it is stopped |
| --- | --- |
| Model asks a tool to print, email or commit a secret | The model only ever holds the reference; the hook injects the value into the tool call, and `afterToolCall` scrubs every resolved value out of the output before the model sees it. |
| Secret in a log line, error or crash dump | `Logger` redacts credential shapes; vault errors carry names, paths and reasons, never values; `SecretResolver.redact` scrubs resolved values; `test/no-leak.test.ts` proves it across every failure path. |
| Secret written to the state store or git | The vault is the only writer of values; `secret_ref` rows store name, scope and grants; the secret scan runs on the repository and on log directories. |
| Secret or raw tool parameter in an audit export (`GET /audit/export` on the daemon and the state service, `fr audit export`; spec S.9, ADR 0050) | The export writes the `audit_log` row's `input_summary` and `result_summary` exactly as the hooks stored them (redacted by `redactForDisplay`, capped by `summarize` at write time) and no other column about the call; the file is scoped to the caller's own rows (their human and their agents; another human's agent is not found); CSV cells that a spreadsheet would evaluate are neutralised (`docs/maintainers/runtime.md`, "Audit log export"). |
| Vault file copied off a machine (laptop theft, runner image leak) | Entries are AES-256-GCM under a key derived from a 32-byte device key or a passphrase. On the runner the key is not on disk at all. |
| Vault file edited in place (entry swapped, byte flipped, check forged) | Each entry's name is authenticated data; any change fails authentication with `validation` / `integrity`; the key-check value makes a wrong key distinguishable from tampering. |
| Agent of human A reads the vault of human B | Separate OS users or installs have separate keyring services and vault files; the runtime passes a run only the token of its owner (to be filled by runtime / state-service). |
| Signed-in human of one daemon writes another human's agent's email settings (points the agent at their own address, enables commands) over a shared state | `packages/capabilities/src/email/routes.ts`: with `humanFor` and `identity` every route under `/agents/:agentId` refuses (403, `tool_not_allowed`, `not_owner`) a human who is not the agent's owner; a mount that identifies humans without an identity port fails closed (`identity_port_missing`) instead of skipping the check; every refusal is an `email.settings` audit row with `allowed = false` and `result_summary` `{ status: "refused", reason }`, and stands (403, a `warn` line) when that row cannot be written (`docs/maintainers/email.md`, "How it is wired"; ADR 0084; `test/security-email.test.ts`, `test/security-email-routes-identity.test.ts`). |
| Prompt injection via web page, email, repo file | to be filled by capabilities (injection suite) |
| Phone lost | to be filled by apps (scoped session tokens, revoke from desktop) |

## How it works

### Backends (`packages/vault/src`)

| Backend | File | Store | Used when |
| --- | --- | --- | --- |
| `KeyringVault` | `keyring.ts` | Windows Credential Manager, Secret Service on Linux (GNOME Keyring, KWallet), macOS Keychain, through `@napi-rs/keyring` | desktop installs; chosen when the probe succeeds |
| `EncryptedFileVault` | `file.ts` | `appDirs().config/vault.json` plus `vault.key` (device key) | cloud runner (locked until the device sends the key); desktop fallback without a keyring |
| `MemoryVault` | `memory.ts` | process memory | tests, `FORERUNNER_VAULT_BACKEND=memory` |

`openVault({ profile?, prefer?, path?, passphrase?, env? })` in `open.ts` picks the backend:
`FORERUNNER_VAULT_BACKEND` if set, else `prefer` (default `keyring`), else the file vault when
the keyring probe fails. It logs the backend and the reason for a fall back, never a value.
`profile` turns the keyring service into `forerunner-<profile>` and the file into
`vault.<profile>.json` (the two-install test environment: `test-a`, `test-b`).

Names: `^[a-z][a-z0-9_.:-]{0,127}$` (`types.ts`, `assertSecretName`). Values: non-empty
strings up to 64 Ki characters. Everything else is a `ForerunnerError("validation")`.

Per OS:

| | Windows | Linux |
| --- | --- | --- |
| Keyring | Credential Manager (generic credentials, service `forerunner`); blobs are capped at 2560 bytes so long values are chunked into `<name>#<i>` | Secret Service over D-Bus (GNOME Keyring, KWallet). Pinned to Secret Service: without one (headless, no session bus) the probe fails and the file vault is used. The kernel keyring is never used because it does not survive a reboot. |
| File vault | `%APPDATA%\forerunner\config\vault.json` and `vault.key`; modes are ignored, the profile directory ACL protects them | `$XDG_CONFIG_HOME/forerunner/vault.json`, `vault.key` 0600, directory 0700 |
| Unlock | OS login | OS login (keyring) or the key file / passphrase (file vault) |

`FORERUNNER_HOME` moves everything under one directory (tests and the two-install environment).

### Keyring details

Keychains cannot list, so each service holds an `__index__` entry (JSON array of names). `set`
writes the entry and then the index; `delete` the index and then the entry; one in-process
mutex serialises all operations. The availability probe writes, reads back and deletes a
random `__probe__<hex>` entry with a timeout (default 10 s through the `Clock`, so a locked
keyring showing a prompt cannot hang the runtime). Every store error becomes
`ForerunnerError("unavailable")` with the store's message (which never contains a value).

### Encrypted file vault details

```
{ "version": 1,
  "kdf": { "salt": b64, "N": 16384, "r": 8, "p": 1 },
  "check": { "iv", "tag", "ct" },           // constant encrypted under the key: wrong-key detection
  "entries": { "<name>": { "iv", "tag", "ct" } } }
```

Key = scrypt(device key or passphrase, salt, N, r, p) -> 32 bytes. Each entry is AES-256-GCM
with a random 96-bit nonce and `forerunner-vault:v1:<name>` as additional authenticated data,
so a ciphertext moved to another name fails. Writes are atomic: temp file in the same
directory, fsync, rename. Plaintext stays in Buffers that are zeroed after use; the string
returned to the caller is the one copy that cannot be erased.

States: `new EncryptedFileVault(opts)` starts **locked** (every operation throws
`ForerunnerError("unavailable", "vault locked")`); `EncryptedFileVault.open(opts)` returns it
unlocked with a passphrase, a given key, or the device key from `vault.key` (created on first
use). On POSIX a `vault.key` found with any group or other bit (restored from a backup, copied
with `cp`, written by another tool) is tightened to 0600 and a warning logged before it is
used, the way ssh treats a private key; one that cannot be tightened is refused (`validation`,
`reason: "key_permissions"`). The KDF block is bounded on read (`SCRYPT_BOUNDS`: N a power of
two in 2^10..2^20, r in 1..32, p in 1..16): a file outside them is `validation` with `reason:
"corrupt"`, never a raw scrypt error escaping `open()` or a memory bomb through a huge N
(`maxmem` follows N). `lock()` zeroes the key material. `exportKey()` returns a copy of the device key;
`importKey(key, { persist })` / `unlock(key)` accept it. Passphrase vaults have no exportable
key (`not_supported`).

### Unlock flow for the cloud runner

1. The human's device creates the runner vault locally (`EncryptedFileVault.open({ path })`),
   stores the secrets the runner may use, and keeps `exportKey()` (32 bytes) in its own OS
   keyring.
2. `vault.json` goes to the runner; `vault.key` never does. The runner opens the vault locked.
3. At runner start the runner asks for an unlock; the human approves on their device (or an
   auto-unlock window is active), the device sends the key over the authenticated device
   channel, the runner calls `unlock(key)` and keeps the key in memory only.
4. Lock on stop, on kill switch, or when the window ends. A wrong or stale key fails with
   `validation` / `wrong_key` and the runner stays locked.

The transport, approval and auto-unlock window are to be filled by cloud-runner and
state-service; the vault side is complete.

### Shared secrets between two humans (`wrap.ts`; spec S.13, ADR 0065)

A secret one human owns (an org deploy token) can be made readable by named agents of the
other human without the value ever leaving the owner's install in clear.

- **Install wrapping key.** Every install (the PC daemon, later a cloud runner) holds an
  X25519 pair: the private key as a vault entry under `INSTALL_WRAP_KEY_NAME`
  (`forerunner.install_wrap_key`, keyring or encrypted file, never a plain file), the public
  key on its `device` row (`wrap_public_key`, migration 0003). `ensureInstallWrapKey(vault)`
  creates it on first use; the daemon registers it with its desktop device row at compose.
- **Wrapping.** `wrapSecret(value, recipientPublicKey, binding)`: a fresh ephemeral X25519
  pair and a 32-byte salt per blob, `HKDF-SHA256(X25519(ephemeral, install), salt,
  "forerunner-shared-secret:v1")`, AES-256-GCM with the AAD
  `1:<ownerHumanId>:<name>:<agentId>:<deviceId>`. The blob (`WrappedSecret`: version,
  ephemeral public key, salt, iv, ciphertext, tag; all base64) is safe to store, serve and
  log. `unwrapSecret(blob, installPrivateKey, binding)` is the only way back; another key,
  another binding (served for another agent, copied to another install) or a tampered field
  is `validation` with reason `integrity` and no plaintext. `isWrappedSecret` /
  `parseWrappedSecret` bound the fields; `valueEncodings(value)` lists the encodings the leak
  tests scan for.
- **Who holds what.** The owner's vault holds the value; the shared state holds one blob per
  (agent, install) on a `secret_grant` row plus the approvals; the named agent's install
  holds its private key. The state service and the phones see ciphertext and names only.
  The grant flow (both humans, the standard approval card, serving rules, revocation) is in
  `packages/runtime/src/secrets/` (runtime.md, "Shared secrets") and the service routes in
  state-service.md.

### Secrets by reference (`refs.ts`)

- `isSecretRef(v)`: true only for a whole string `secret:<valid name>`. `"token is
  secret:github_pat"` is plain text and stays untouched; `secret:GitHub` (invalid name) is also
  plain text, so a typo can never leak anything, it just fails at the tool.
- `resolveSecretRefs(input, vault, granted, audit?)`: deep-walks arrays and plain objects,
  replaces references whose name is in `granted` with the vault value, throws
  `secret_not_granted` (before any vault read) otherwise and `not_found` for a granted name that
  is not stored. Returns a new structure; the input is never mutated; class instances (Date,
  Buffer) pass through by identity; nesting deeper than 64 is refused.
- `redactValues(text, values)`: removes every value and its JSON-escaped, URL-encoded, base64,
  base64url (padded and unpadded: JWT segments, some Basic-auth clients, `@base64d` pipelines)
  and hex (both cases) forms, longest first. Values shorter than 4 characters are not scrubbed
  (they would destroy ordinary text and are not secrets).
- `SecretResolver(vault, audit?)`: per-run object with `resolve(input, granted)` and
  `redact(text)`; it remembers the values it resolved. It matches the runtime's `SecretsPort`
  and is what `packages/runtime` wires into `beforeToolCall` / `afterToolCall`.

### What is never logged

Values, in any form. Allowed in logs and errors: backend, service name, file path, secret
name, error reason (`wrong_key`, `integrity`, `corrupt`, store messages such as
`AccessDenied`). `test/no-leak.test.ts` is the executable version of this list.

### Capability tokens, autonomy, kill switch

See `runtime.md`. Injection suite, browser and email hardening: to be filled by capabilities.

## How to change it

- **Add a backend.** Implement `Vault` from `types.ts`, validate names with
  `assertSecretName` and values with `assertSecretValue`, throw `ForerunnerError` codes
  (`validation`, `unavailable`, `not_found`, `internal`), add it to `openVault` and to
  `VaultBackend`, and add its round-trip and no-leak coverage to the tests.
- **Change the name rules.** `SECRET_NAME_PATTERN` in `types.ts` is the single source; `refs.ts`
  derives the reference pattern from it. Keep internal keyring accounts (`__index__`,
  `__probe__*`, `<name>#<i>`) impossible under the new rule.
- **Raise the KDF cost.** Change `DEFAULT_SCRYPT` in `file.ts`; existing files keep their
  stored parameters until they are re-created. `maxmem` is computed from N and r.
- **Change the file format.** Bump `FILE_VAULT_VERSION`, add a migration in `parseDocument`
  and keep the AAD prefix versioned; document it in `migrations.md`.
- **Keyring limits.** `KEYRING_CHUNK_CHARS` (1024) sits under the Windows 1280-unit cap; the
  per-operation timeout is `timeoutMs` on `KeyringVaultOptions`.
- **New reference forms** (for example `secret:name#field`): extend `isSecretRef` and
  `resolveSecretRefs` together and add a mid-string negative test for the new form.

## Tests

`pnpm vitest run --project unit packages/vault`

| File | Covers |
| --- | --- |
| `test/names.test.ts` | name and value validation |
| `test/memory.test.ts` | memory backend |
| `test/file.test.ts` | round-trip, layout, no plaintext on disk, 0600 on POSIX, default paths, wrong key and wrong passphrase, tamper (ciphertext, tag, swapped entry, check value), corrupt and newer files, atomic writes (parseable after every write, no temp files, stale temp ignored, concurrent writers), lock/unlock, exportKey/importKey, the runner flow |
| `test/keyring.test.ts` | index maintenance, profiles, chunking (Windows cap simulated), index chunking, header-lookalike values, incomplete chunk detection, store failures, timeout through `SimulatedClock`, probe detection; a real-keyring round trip that runs only where a probe succeeds (`it.skipIf`, the describe title shows the reason) |
| `test/open.test.ts` | backend selection, fall back with logged reason, env override, forced keyring failing loudly, invalid env value |
| `test/refs.test.ts` | reference syntax, nested resolution, immutability, not-granted before vault read, not-found, depth cap, `redactValues` forms, `SecretResolver` |
| `test/no-leak.test.ts` | captures Logger sinks, console and every thrown error across all backends and failure paths; asserts no value (or its base64) appears |
| `test/wrap.test.ts` | spec S.13: raw 32-byte X25519 pairs, the install key created once in the vault under its reserved name (a non-key entry is refused), wrap/unwrap round trip to the recipient and nobody else, every binding field (name, owner, agent, device) fails closed, tampered ciphertext / tag / iv / salt / ephemeral key, a wrong version and malformed blobs are `validation` without the value in the error or the logs, fresh ephemeral key and salt per wrap, values up to the cap and multi-byte text |
| `test/security-vault.test.ts` | the security review: a vault file copied without its key is refused (`wrong_key`) and no key is written next to it, the locked state names the path and never a value, a world-readable key file is tightened to 0600 before use, a tampered KDF block is `corrupt` and never a raw crypto error, an ungranted name is refused before any vault read, the resolver's edge cases, and base64url and hex forms are scrubbed |

Fixtures are random `v-<hex>` values; anything credential-shaped in tests is built by
concatenation and marked `// not-a-secret` so `pnpm secrets:scan` stays clean.

Injection suite, capability token and autonomy enforcement tests: see `runtime.md` and
`testing.md` (to be filled by capabilities for the injection suite).

## Known issues

- Values are strings at the API boundary; the string the caller receives cannot be zeroed.
  Keep its lifetime short (resolve immediately before the tool call, drop after).
- Windows: file modes are advisory; the vault relies on the user profile ACL. The Credential
  Manager also stores secrets per Windows user, which is the intended boundary.
- Linux without a Secret Service (servers, containers, some minimal desktops) uses the file
  vault; the device key then sits next to the data at 0600 (put back to 0600, with a warning,
  when found wider). This is weaker than a keyring and is logged at startup.
- Keyring and file operations are serialised per process only. Two processes writing the same
  file vault at once (desktop app and a local runner on one profile) are not coordinated; use
  separate profiles.
- The real-keyring test skips on CI runners without a session bus; keyring behaviour is
  exercised there through the fake store only. A desktop run (`pnpm vitest run --project unit
  packages/vault`) on a machine with a keyring runs the full suite.
- The runner unlock transport and the auto-unlock window are not part of this package (see the
  table above for owners). The cloud runner does not yet register an install wrapping key on
  its `runner` device row (its vault is locked until the unlock protocol ran), so a shared
  secret reaches an agent on its owner's PC install; a runner is a follow-up (ADR 0065).
- The install wrapping key is a vault entry (`forerunner.install_wrap_key`) and shows in
  `list()`; it is not a user secret and must not be granted to a run.
