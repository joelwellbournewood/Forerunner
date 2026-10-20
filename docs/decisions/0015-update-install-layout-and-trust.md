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
`current`, `previous`, a `state` (`installed`, `pending_health_check`, `rolled_back`, `failed`)
and the last rollback. The shells read the pointer and launch `<versions>/<current>`; the
packaged build runs while `current` is null. The pointer is written as a temp file in the same
directory, fsynced and renamed over the old one; a crash leaves the old or the new pointer,
never a torn one. No symlinks or junctions anywhere. The install may write only under
`<data>/versions`; `<config>` and the rest of `<data>` (state database, memory, audit log) are
checked by hash in the tests before and after install and rollback.

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
needs a human's approval through the `UpdateHumanPort` (a `human_request` row); `pending` or
`denied` is `approval_required`. Every check, apply, rollback and health verdict is an audit
row.

**Schema compatibility.** `minSchema` in the manifest is the oldest state schema the release's
migrations can upgrade from. Between installs, sync is gated: compatible only when both are at
the same `schema_migrations` version and at least `minSchema`; the lower side must update, and
`SyncGate` blocks sync calls and emits pause/resume events.

## Consequences

- Rollback is a pointer rewrite and a restart; the previous version stays on disk until
  `prune()`. Two versions of the app are always present after an update.
- The release workflow gains one step: write the manifest, sign it with the key held by secret
  reference (`fr update sign`), upload it as a release asset. The Tauri updater plugin is not
  used; its pubkey/endpoint configuration in `release.md` is superseded by this ADR.
- The shells need a small launcher that reads `current.json` and starts the named directory,
  and a `Restarter` implementation; until they exist `fr update apply` stages and asks for a
  manual restart.
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
