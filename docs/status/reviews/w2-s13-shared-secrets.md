# w2-s13-shared-secrets: shared secrets readable by named agents, both humans approve (S.13)

Item `w2-s13-shared-secrets`, built on `wave/w2-s13-shared-secrets` and merged in `80501bf`
(5 commits, 36 files) on 2026-10-23 without a review. ADR 0065; migration 0004 (written as
0003 on the branch, renumbered at the merge). This review, 2026-10-25, reads the item's code
as it stands on `ccr-af5a431d-jc9xqj` at 894b76d, after the identity rule (ADR 0082),
Settings → Devices (w3-r2-devices) and the late approvals (ADR 0088) moved around it.

## Review

Verdict: **revise**. Score: **74**.

What was checked: the brief (`briefs/w2-s13-shared-secrets.md`) clause by clause against
`packages/vault/src/wrap.ts`, `packages/runtime/src/secrets/{shared-grants,resolver,propose,
routes}.ts`, `packages/state/src/repos/secret-grant.ts`, migration 0004,
`services/state-api/src/routes/{secrets,inbox}.ts`, the daemon wiring in `compose.ts` and
`server.ts`, `remote/presence.ts`; ADR 0065 and the shared-secret sections of security.md,
state-service.md, runtime.md, migrations.md, data-model.md; the six test files the
requirement row names. Runs: the four unit suites of the item (23 tests, green), the state
suite on Postgres (`postgres.integration.test.ts`, 56 green, `forerunner_test_r3`),
`pnpm secrets:scan` (clean, 1582 files), `node scripts/check-paths.mjs` (ok), biome on the
item's files (clean), `docs-check` against the base (ok). Mutation: both `device.revoked`
refusals in `shared-grants.ts` removed, 72 tests of the four suites still green (finding 4).

What holds: the value never leaves the owner's install in clear (one blob per (agent,
install), X25519 + HKDF-SHA256 + AES-256-GCM, the AAD binding name, owner, agent and device;
every table, response body and audit row scanned in every encoding by the tests); the other
human's card is the standard high-risk approval (signed plus biometric on a phone, the
daemon's own route on the desktop) and the answer moves the grant in the same transaction
on both paths; `blobFor` is the one read that returns a blob and the service hands it to an
admin principal only; the resolver reads the local vault first, caches nothing, and the
hooks' `grantedSecrets` rule is unchanged (the active names join the session grant at start);
revocation drops the blobs and withdraws the cards; the cloud runner has no key and fails
closed (documented); no `Date.now()`, no string paths, stable error codes, the envelope on
`secret_grant`. The brief is met except where the findings below say otherwise.

### Findings

1. **medium** — Revoking a device leaves its wrapped copies in the grant rows.
   `services/state-api/src/routes/devices.ts:162-180` (`POST /devices/:id/revoke`) and
   `packages/runtime/src/devices/manager.ts:129-199` (`DeviceManager.revoke`,
   `revokeInStore`) revoke the row and drop the session tokens; neither touches
   `secret_grant`, and `packages/state/src/repos/secret-grant.ts` has no way to drop one
   device's blobs. `serveSharedBlob` refuses a revoked device at serve time
   (`shared-grants.ts:470`), but the ciphertext stays on the row of an `active` grant, so a
   lost or retired PC install that still holds its vault (the private key) and the store
   credentials (installs talk to Postgres directly, ADR 0024) reads the blob off the table and
   unwraps it; `blobCount` keeps counting dead copies. Verified by reading both revoke paths
   and `SecretGrantRepo`; a stage-2 test revokes Bob's PC and reads the row. Smallest fix:
   `SecretGrantRepo.dropBlobsForDevice(deviceId)` over pending and active grants, called from
   both revoke paths through one `dropSharedBlobsForDevice(store, deviceId, opts)` in
   `shared-grants.ts` with a `secret.blobs_dropped` audit row; tests on the repo, the service
   route and the daemon's store path.
2. **medium** — The daemon's revoke has no owner check. `compose.ts:3102`
   (`revoke: (grantId) => sharedSecretService.revoke(grantId, human.id)`) reaches
   `revokeSharedGrant` (`shared-grants.ts:408-436`), which never compares
   `grant.owner_human_id` with `by`. On a shared store Bob's desktop app (`POST
   /secrets/shared/:id/revoke` on Bob's daemon; its `GET /secrets/shared` lists the grants
   Bob must approve, so the ids are at hand) revokes a grant Ada owns, including one that also
   names Carol's agent, and the row reads `ended_reason: "revoked by the owner"`. The service's
   route refuses a device that is not the owner (`secrets.ts:174`); the daemon path does not.
   Verified by reading; the stage-2 test calls the daemon's route for a grant another human
   owns. Smallest fix: `revokeSharedGrant` refuses a `by` that is not the owner with
   `tool_not_allowed` (the code `DeviceManager` uses for "not the signed-in human's"), mapped
   to 403 in `routes.ts`; `by: null` (the service acting for the owner) stays allowed.
3. **medium** — The install's own private wrapping key is a shareable name.
   `propose.ts:33,48` and `routes.ts:112` accept any name matching `SECRET_NAME_PATTERN`,
   `forerunner.install_wrap_key` included, and read it from the vault like a user secret; an
   owner who shares it hands the recipient install the key that opens every blob ever wrapped
   to the owner's install (secrets third humans shared with the owner's agents). security.md's
   Known issues say the entry "must not be granted to a run" but nothing enforces it. Verified
   by reading (no check against `INSTALL_WRAP_KEY_NAME` on either path). Covered elsewhere:
   the small-fixes item is adding the `forerunner.*` refusal on the grant paths
   (`assertSecretName`, `extensions/registry.ts`, `secrets/routes.ts`) right now, so it is not
   built here. Semantic point for that item: `ensureInstallWrapKey` stores and reads the key
   through `vault.set` / `vault.get`, so the refusal has to sit on the grant and share paths
   (or in a separate `assertGrantableSecretName`), not inside the backends' name check.
4. **low** — The revoked-device refusals are untested. `serveSharedBlob`
   (`shared-grants.ts:470`) refuses a revoked install and `proposeSharedGrant`
   (`shared-grants.ts:229`) refuses a blob for one; with both `device.revoked` checks removed
   the four suites (72 tests) stay green. Smallest fix: the tests of finding 1 cover both
   (serve after a revoke, propose to a revoked install).
5. **low** — The `secret_ref` mirror removes a pre-existing local grant. `mirrorEnded`
   (`shared-grants.ts:538`) drops every agent the grant named from `granted_to` unless another
   active grant of the name keeps it, including the owner's own agent that
   `SecretRefRepo.grant` (S.14) had granted before the shared grant named it alongside the
   other human's. Verified by reading; a stage-2 test grants locally, shares with both agents,
   revokes. Smallest fix: on an end the mirror removes the other humans' agents and leaves
   the owner's own (their membership is the owner's local rule), with the scope flip as is.
6. **low** — Proposal and revocation are not transactional. `proposeSharedGrant`
   (`shared-grants.ts:264-312`) writes the grant row, then one card per human, then patches
   `request_ids`; `revokeSharedGrant` ends the row, withdraws the cards and updates the
   mirror; neither runs inside `store.transaction`, unlike the answer path. A failure between
   the writes leaves a pending grant without cards (nobody can approve it; the owner can still
   revoke) or a revoked grant whose cards stay open (a later answer finds the grant not
   pending and does nothing). Verified by reading. Smallest fix: both run in
   `store.transaction` when the store offers one; a test with a store whose card insert
   fails asserts no grant row remains.
7. **low** — security.md:154 says `wrap_public_key` arrives with "migration 0003"; the
   migration is `0004-shared-secrets.ts` (migrations.md:30, PROGRESS.md). ADR 0065 §1 says
   0003 too (written before the renumbering). Smallest fix: the doc line, and a dated
   amendment to the ADR.
8. **low** — ADR 0065 §2 and its alternatives say the value "is not wrapped to itself", but
   `proposeSharedSecret` (`propose.ts:38-63`) wraps to every keyed install of every named
   agent's owner, so naming the owner's own agent (the "local grant with the same plumbing" of
   §3) produces a blob wrapped to the owner's own install. Harmless (the resolver reads the
   local vault first and never uses it; the owner's install can read it anyway). Smallest fix:
   the ADR amendment states it.
9. **low** — The service cannot tell which human's install is calling: `POST /secrets/shared`
   takes `ownerHumanId` from the body, `answerRequestAs` lets an admin principal answer any
   card (`assertRequestOwner` restricts devices only), the admin revoke attributes to the
   owner (`secrets.ts:180`); every install presents the same admin token and
   `X-Forerunner-Install` is advisory (ADR 0009, ADR 0024). An install is trusted with the
   store anyway (it writes the rows directly), the blob is useless without the recipient's
   private key, and ADR 0065 §4 says so. Not a defect; state-service.md's Known issues should
   say it in one sentence.
10. **low** — Known issues missing from the docs: a vault reset gives the install a new
    wrapping key (`registerDesktopDevice` patches the row), old blobs then fail
    `validation`/`integrity` and the hooks deny the tool call until the owner re-shares; on
    the cloud runner (no key) a shared name in the session grant resolves to `not_found`
    ("not in the vault"), closed but misleading; a grant activated mid-session is usable from
    the next session; there is no human-removal flow in the codebase, so a departing human's
    installs are ended by revoking their devices (finding 1) and the owner revoking the
    grants; a named principal's specialists derive their token from it and read the shared
    secret like a local one. Smallest fix: docs.
