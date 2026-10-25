# 0015 — Updates: pointer-file install layout and the release trust model

Date: 2026-10-20
Status: accepted

## Context

Spec M asks for signed builds on GitHub Releases, "Update and restart", a staged install, a
health check on restart with automatic rollback, and updates that never touch config, memory or
data. The app runs on Windows and Linux (Tauri), with an Android client on the same release
channel, so the layout must not depend on symlinks, junctions, package managers or an OS
updater. `release.md` had planned to use the Tauri updater plugin with minisign signatures,
which covers download and signature but not staging, health checks or rollback, and has no
story for connector or model updates on the same screen. The data model already has a
`release` table (version, channel, signature, status with `published → installed → rolled_back`).

## Decision

**Layout.** Every release is unpacked into its own directory `<data>/versions/<version>/`
(`release.json` beside the files). One pointer file `<data>/versions/current.json` names
`current`, `previous`, a `state` of the current version (`installed`, `pending_health_check`,
`failed`) and the last rollback (`lastRollback`; a rollback is an event on the pointer, not a
state). The pointer is written as a temp file in the same directory, fsynced and renamed over
the old one; a crash leaves the old or the new pointer, never a torn one. No symlinks or
junctions anywhere. The install may write only under `<data>/versions`; `<config>` and the rest
of `<data>` (state database, memory, audit log) are checked by hash in the tests before and
after install and rollback.

**Launcher contract.** The shells read the pointer and launch `<versions>/<current>`.
`current: null` means the packaged build runs: before the first staged install, and after a
rollback to the packaged build, whose version has no directory under `versions/` (the runtime
writes null then, so a well-formed pointer never names a missing directory; `lastRollback.to`
keeps the version). A launcher must also treat a `current` whose directory is missing, or that
is not a safe directory name, as the packaged build and fall through to its other locators; the
desktop `install.rs` does this, and the Android shell must do the same.

**Version rule.** A manifest version is bare semver: no leading `v`, no build metadata
(`1.2.0+build.7` would compare equal to `1.2.0` and collide), unchanged by `safeSegment`,
because it is the directory name. The manifest schema, the release workflow's
`buildReleaseManifest` and `versionDir` share this one rule (`isReleaseVersion`), so the feed
never offers a release the installer would then refuse to stage.

**One operation at a time.** Apply, rollback, the startup health check and prune take
`<data>/versions/install.lock` (created exclusively, holding pid, operation and start time,
removed when the operation ends). A second caller, in the same process or another (the daemon's
route and `fr update` in a terminal), is refused at once as `version_conflict` /
`in_progress` (HTTP 409), never queued. A lock whose process is gone is stale; an unreadable
one is stale only when it is older than a few seconds.

**Trust.** A release is a `SignedManifest`: a manifest (semver, channel, notes, `publishedAt`,
`minSchema`, one artefact per platform with URL, size and SHA-256) and an Ed25519 signature
(`node:crypto`) over the manifest's canonical JSON (sorted keys, no whitespace). Installs hold a
set of trusted public keys in `update.json` (`trustedKeys`), identified by `sha256(public key)`
prefixes. Order of checks, all in code and each a named refusal: signature present → key id
trusted → signature valid → version newer than the installed one (equal is
`already_installed`; older is `downgrade` unless a human turned `allowDowngrade` on) → local
schema version at least `minSchema` → not rolled back or failed on this install before →
downloaded bytes match size and SHA-256 (more bytes than declared is refused during the
stream) → zip entries inside the target, no `..`, absolute, drive-letter, backslash or symlink
entries. The feed (GitHub Releases, listing the signed manifest as an asset
`forerunner-release.json`, or a plain `releases.json`) is untrusted transport; owner, repo and
API base come from configuration.

**Health and rollback.** After "Update and restart" the pointer says `pending_health_check`.
On every start the runtime runs the startup health check: nothing to do unless pending; a
running version different from `current` (the new build did not start) or a failed/timed-out
probe (daemon `/health` by default, `fr doctor --json` otherwise) rolls back by rewriting the
pointer to `previous`, marks the release row `rolled_back` with the reason, posts an inbox item
and restarts. Success marks the pointer and the row `installed`. A release that rolled back is
never offered again on that install; the fix is a new release.

**Humans and agents.** A human applies or rolls back from the UI or CLI directly. An agent
needs a human's approval through the `UpdateHumanPort` (a `human_request` row keyed by the
operation and version); `pending` or `denied` is `approval_required`, and the agent's retry
after the inbox answer is served from that row, so one question is asked once. Every feed
query, apply, rollback, refused concurrent attempt and health verdict is an audit row; the
updates screen reuses the last check for a short window instead of querying and auditing on
every view.

**Schema compatibility.** `minSchema` in the manifest is the oldest state schema the release's
migrations can upgrade from. Between installs, sync is gated: compatible only when both are at
the same `schema_migrations` version and at least `minSchema`; the lower side must update, and
`SyncGate` blocks sync calls and emits pause/resume events. The gate is code in the update
module; wiring it into the state service client's sync path is a separate, pending step
(`updates.md`, Known issues).

## Consequences

- Rollback is a pointer rewrite and a restart; the previous version stays on disk until
  `prune()`. Two versions of the app are always present after an update.
- The release workflow gains one step: write the manifest, sign it with the key held by secret
  reference (`fr update sign`), upload it as a release asset. The Tauri updater plugin is not
  used; its pubkey/endpoint configuration in `release.md` is superseded by this ADR.
- The shells need a small launcher that reads `current.json`, starts the named directory and
  falls back to the packaged build when `current` is null or its directory is missing, and a
  `Restarter` implementation; until they exist `fr update apply` stages and asks for a manual
  restart.
- A rollback to the packaged build leaves `current: null`; `installedVersion()` then reports
  the running build's version, and the next update records that version as `previous`.
- Downgrades are a deliberate, flagged action; the UI never offers one as "available".
- Migrations stay forward-only; a rollback across a migration restores the pre-migration
  database copy as `release.md` describes, outside this module.

## Alternatives considered

- **Tauri updater plugin (minisign).** Downloads and verifies, then replaces the binary in
  place: no staging, no previous version to return to, no health check; rollback would mean
  re-downloading. Kept as the inspiration for signing, replaced by the manifest.
- **Symlink `current -> versions/x`.** Simplest on Linux; junctions on Windows need privileges
  in some configurations and break when the data directory is copied or synced. A JSON pointer
  is portable and testable.
- **OS package managers (MSI upgrade, apt).** Needed for the first install, not for in-app
  updates: no health-check-and-rollback semantics, and no Android equivalent.
- **Signing the artefacts only (SHA256SUMS + signature).** Does not bind the version, channel,
  notes or `minSchema`; a swapped manifest could point a signed artefact at the wrong channel.
  Signing the whole manifest binds everything the installer decides on.

## Amendment (2026-10-25, review of w4-android-signing): the Android release key

**Context.** Since ea86d48 the release APK is signed by Gradle from `keystore.properties`,
written by `scripts/android-keystore.mjs` from the CI secrets `ANDROID_KEYSTORE_BASE64` and
`ANDROID_KEYSTORE_PASSWORD`, or, without them, from a development keystore the script
generates with a fresh random password on every runner. Both workflows verified the signature
with `apksigner` but neither distinguished the two keys, so a `v*` tag without the secret
published a development-signed APK: the manifest of this ADR would have bound a version to an
artefact that no later release can update (Android refuses an update signed by another key,
and the generated key is gone with the runner) and that nobody can compare with a held key.

**Decision.** The Android artefact of a release carries the key from the secret, never the
generated one, enforced in code at two points of `release.yml`: `android-keystore.mjs
--require-secret` fails before the build when `ANDROID_KEYSTORE_BASE64` is empty (no
development key is generated or kept), and `android-apk-verify.mjs` without
`--allow-development-key` fails after the build when a signer's DN is the development key's
(`CN=Forerunner development key`, the dname the script generates, exported as
`DEVELOPMENT_CERT_CN`). `android.yml` (pull requests, pushes, fork PRs whose secrets are
empty) keeps building with the development key and passes `--allow-development-key`; the SDK's
debug certificate is refused in both. The secret is checked before the build with `keytool
-list -storepass:env` (password, alias, keystore format), and the properties file is written
as `java.util.Properties.store` writes it (ISO-8859-1 with `\uXXXX` escapes), because Gradle
reads it with `Properties.load(InputStream)`.

**Consequences.** A release cannot be cut without the Android secrets, even when only the
desktop builds matter; `release.md` says how to create them. A release key whose DN happened
to be the development key's would be refused; the DN is the script's, so none should. A
stable development identity across CI builds (the vault-held generated key of the BLOCKERS
"Android keystore" row) stays open and is unaffected: it would be a second secret, not the
generated key.

**Alternatives considered.** A warning in the job log or the release notes (the state before
this amendment): the APK was still published, and an un-updatable artefact is worse than a
missing one. An expected fingerprint (`ANDROID_KEYSTORE_SHA256`) compared with the signer's
SHA-256: stronger, but a third value to keep in step with the keystore; the `keytool -list`
check already proves the APK carries the key the secret holds, since that key is the only one
Gradle is given. Letting the publish job drop the APK when it is development-signed: a release
with a missing platform and no failing signal, the pattern this amendment removes.
