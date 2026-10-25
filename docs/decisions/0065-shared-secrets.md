# 0065 — Shared secrets: wrapped to the named agents' install keys, both humans approve, served by reference

Date: 2026-10-23
Status: accepted

## Context

Spec S.13 ("Secrets vault"): shared secrets such as an org deploy token are "encrypted,
readable by named agents only. Both humans approve the grant." The `secret_ref` table carried
`scope: "shared"` and per-agent grants without values, but nothing encrypted a value for
another install, asked both humans, or handed the value to the other install; each human
kept the token in their own vault (BLOCKERS.md, S.13). The constraints: values never enter
the shared state, a log, a phone or model context (spec S.14, R.7, the vault's threat model);
installs talk to Postgres directly and to the state service with one shared admin token (ADR
0009, ADR 0024), so the service cannot tell installs apart cryptographically; "sharing
secrets" always needs a human (spec Security), and "granting a capability" is a high-risk
confirmation (ADR 0009). `node:crypto` is the only crypto dependency of the vault (ADR 0006).

## Decision

1. **An install wrapping key per install.** Every install holds an X25519 pair: the private
   key is a vault entry (`forerunner.install_wrap_key`: keyring or encrypted file, so never a
   plain file), the public key is registered on the install's `device` row
   (`wrap_public_key`, migration 0003). The daemon creates it at compose and registers it
   with its desktop row whenever remote control is on (the default on a shared state) or was
   asked for explicitly; the cloud runner keeps its own `runner` row and gets no key yet.
   Phones and web pages have no key and are never wrap targets.
2. **The value is wrapped on the owner's install, once per (agent, install).** The scheme is
   the runner unlock's (ADR 0033) with a long-term recipient key: a fresh ephemeral X25519
   pair and salt per blob, HKDF-SHA256, AES-256-GCM, and an AAD binding the blob to the
   version, the owner, the secret name, the agent and the device. A blob served for another
   agent or copied to another install fails authentication; the blob is the only thing the
   proposal body, the `secret_grant` row, the service and the resolving install's audit rows
   ever carry. The owner's install keeps the clear value in its own vault; it is not wrapped
   to itself.
3. **Both humans approve, through the standard card.** The owner approves by proposing from
   their install (the proposal is their act; the vault is theirs). Every other human whose
   agent is named gets a `human_request` of kind `approval`, risk `high` (a device answers
   signed with the biometric assertion), options `approve` / `deny`, with a
   `shared_secret_grant` change card. The grant is `pending` until every one of them
   approved and `active` only then; one `deny` makes it `cancelled`, drops the blobs and
   withdraws the other cards; the owner revokes at any time, from the install or their own
   signed device. The answer and the grant move in one transaction, in the state service's
   answer route and in the daemon's. With nobody to ask (only the owner's agents are named)
   the grant is active at once: that is a local grant with the same plumbing.
4. **Served by reference, enforced on both paths.** `SecretGrantRepo.blobFor` is the one
   read that returns a blob: active grant, named agent, the device the copy was wrapped for.
   `serveSharedBlob` wraps it with the audit rows (`secret.blob_served`, `secret.blob_refused`)
   and `secret_not_granted` on refusal; the service's `GET /secrets/shared/blob` is admin only
   (a device never holds a secret) and the daemon's `StoreSharedSecretService` uses the same
   function. Because every install presents the same admin token, the service's install
   check is advisory (the `X-Forerunner-Install` header in the audit row); the confidentiality
   boundary is the wrapping: a blob is useless without the private key of the install it was
   made for.
5. **The resolver is a vault adapter; the hooks are unchanged.** `SharedSecretVault` reads the
   install's own vault first, then the served blob, unwrapped with the private key read from
   the vault at that moment; nothing is written to the local vault or to disk. The names of
   the agent's active grants join the run token's `grantedSecrets` at session start, so the
   hooks' granted-names rule, the injection into tool inputs and the output redaction work as
   for a local secret. Resolution writes `secret.shared_resolved`.
6. **`secret_ref` mirrors active grants** (`scope: "shared"`, the agents in `granted_to`), so
   "which secrets may this agent use" stays one read.

## Consequences

- A named agent on its owner's PC install reads the secret while the owner keeps the only
  clear copy; revocation is immediate for the next resolution (the blob is gone) but cannot
  take back a value a running tool call already received, as with any secret.
- A new install of the approver (a second PC, later a runner) has no copy until the owner
  shares again; the targets are listed at proposal time, not followed afterwards.
- The cloud runner does not register a wrapping key yet (its vault is locked until the unlock
  protocol ran); wiring `ensureInstallWrapKey` after the unlock is a follow-up.
- The owner's proposal is a daemon route and a runtime call, not yet a registry command with
  a change card and not yet a screen in the app.

## Alternatives considered

- **Encrypting to a shared symmetric key held by both humans**: needs a key exchange of its
  own and leaves both installs able to read every secret either shares; per-recipient
  wrapping keeps "readable by named agents only" literal.
- **Wrapping to the owner's install too** (the hint's "plus the owner's own"): the owner's
  vault already holds the value and the resolver reads it first; a self-blob would add a
  second clear path for no reader.
- **The owner's own approval as a second card**: the proposal is made from the owner's install
  with the owner's vault, which is the owner's act; a second card on the same device would be
  theatre. The agent cannot propose on its own: the route is the daemon's human-facing API
  and "sharing secrets" stays in the always-human class of the hooks.
- **Per-install service credentials** so the service could enforce "its own install"
  cryptographically: a change to ADR 0009's admin principal that touches every install; the
  AAD binding gives the guarantee that matters (a served blob only opens where it was meant to)
  without it.
- **Storing blobs on `secret_ref`**: the grant has its own lifecycle (approvals, status, who
  must answer) and many blobs; a row of its own keeps `secret_ref` the small "who may use what"
  table it is.

## Amendment 2026-10-25 (review `w2-s13-shared-secrets`)

The item was merged without a review; `docs/status/reviews/w2-s13-shared-secrets.md` has the
findings. What changed in the decision:

- **Migration number.** `device.wrap_public_key` and `secret_grant` are migration **0004**,
  not 0003 as §1 says: the sources migration (ADR 0056) shipped first on the release branch.
- **A revoked install loses its copies.** Decision 3 ended a grant on a refusal or the owner's
  revoke; nothing ended one install's copies when the human revoked that install (Settings →
  Devices → Revoke, a lost PC). The serve rule refused a revoked device, but the ciphertext
  stayed on the row of an active grant, and an install still holding its vault and the store
  credentials could read and unwrap it. Both device-revocation paths (the service's
  `POST /devices/:id/revoke` and the daemon's store fallback) now call
  `dropSharedBlobsForDevice`: every pending or active grant drops the blobs wrapped to that
  device, the grant stays (a human whose only install is gone resolves nothing until the
  owner shares again, as for a second install registered later), one `secret.blobs_dropped`
  audit row names the grants.
- **Only the owner revokes, on both paths.** The service's route refused a device that is not
  the owner; the daemon's route (and `revokeSharedGrant` itself) took any caller, so on a
  shared store the recipient's daemon could end a grant it only had to approve. `by` must now
  be the owner (`tool_not_allowed`, 403); `null` is the service acting for the owner after
  its own check. The recipient's lever stays the card's deny.
- **One transaction.** A proposal (the grant row, its cards, `request_ids`, the mirror, the
  audit rows) and a revocation (the row, the cards, the mirror, the audit row) each run inside
  `store.transaction` when the store offers one, as the answer path always did.
- **The mirror and the owner's own agents.** When a grant ends, `secret_ref.granted_to` loses
  the other humans' agents it named (unless another active grant keeps them) and keeps the
  owner's own agents: their membership is the owner's local rule (S.14), which a shared grant
  that named them alongside the other human's must not take away when it ends.
- **A self-blob when the owner's own agent is named.** Decision 2 says the value is not
  wrapped to the owner's install; that holds when only the other human's agents are named.
  Naming the owner's own agent (decision 3's "local grant with the same plumbing") wraps a
  copy to every keyed install of its owner, the proposer's included; the resolver never uses
  it (the local vault answers first).
- **Unchanged, restated.** The service cannot tell which human's install proposes, answers as
  admin or revokes (one admin token, ADR 0009); the boundary is the wrapping plus the trust an
  install already has in the store (decision 4). The `forerunner.*` names, the install's own
  wrapping key first, are refused on every share, grant and reference path since the same day
  (the amendment above, `secret_reserved`); `ensureInstallWrapKey`'s own vault reads and writes
  of the name keep working through the storage-level check.

## Amendment 2026-10-25: the install wrapping key's name is reserved

The install wrapping key is a vault entry (`forerunner.install_wrap_key`) that `list()`
returns, and no grant path refused it by name (triage 2026-10-25, security.md (7)). Worse than
the triage's "defense in depth": `proposeSharedSecret` read the vault by the proposed name, so
a proposal naming it would have wrapped this install's private key to the other install.

Decision: names under `RESERVED_SECRET_PREFIX` (`forerunner.`, `@forerunner/vault` `types.ts`)
are the runtime's own and never a user secret. `assertSecretName`, the check every grant path
and every `secret:` reference goes through, refuses them with the new stable code
`secret_reserved`; the backends store under `assertStorableSecretName` (the syntax rule only),
which is what `ensureInstallWrapKey` relies on. Refused by name: `resolveSecretRefs` before the
grant is consulted, `TokenIssuer.issue` (no run token grants one; `derive` cannot add what the
parent lacks), the extension registry at add, approval and re-permissioning
(`refuseReservedSecrets`), `proposeSharedGrant` / `proposeSharedSecret` / `serveSharedBlob`
(403 on the daemon's and the service's routes), and `fr vault set`. A future runtime-owned
entry takes a name under the prefix and inherits the rule. Tests: `packages/vault/test/names.test.ts`,
`refs.test.ts`; `packages/runtime/test/token.test.ts`, `extensions-registry.test.ts`,
`shared-secret-resolver.test.ts`, `shared-secret-wiring.test.ts`;
`services/state-api/test/shared-secrets.test.ts`.
