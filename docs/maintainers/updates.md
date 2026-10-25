# Updates

Signed releases, the staged install with its pointer file, the first-start health check with
automatic rollback, the updates screen (app, connectors, models) and the schema-compatibility
gate for sync. Code: `packages/runtime/src/update/` (exported from `src/update/index.ts`).
ADR 0015 records the layout and the trust model. `release.md` covers the release workflow that
produces the artefacts this module consumes.

## Purpose

Spec M: "Release channel: signed builds published to GitHub Releases. App shows 'Update
available', changelog, 'Update and restart'. Staged install, health check on restart, automatic
rollback on failure. Config, memory and data untouched by updates. Connector and model updates
surface in the same updates screen. Shared state schema changes use versioned migrations; both
apps must be on a compatible version before sync resumes." Phase 7 gate: a deliberately broken
build rolls back on its own (scenario 7, "Bad update").

Every rule is enforced in code: an unsigned, untrusted, tampered, downgraded, schema-incompatible
or previously rolled-back release is refused by a `ForerunnerError("validation")` whose
`details.reason` names the cause; an agent cannot install or roll back without a human's
approval (`approval_required`); the install can only write under `<data>/versions`
(`path_not_allowed`); one install operation runs at a time, across processes (`version_conflict`,
reason `in_progress`); the sync gate refuses every sync with the shared state while the schema
versions differ (`unavailable`: a session start, the peer feed, the mirror run and the
application of answered approvals, wired through `sync.ts` into `compose.ts`, the session
runner and the daemon). Every outward action (feed check that reaches the feed, install,
rollback, health verdict, a sync pause, resume or refusal) appends an `audit_log` row.

## How it works

### Feed formats (`feed.ts`)

`ReleaseFeed { kind; latest(channel); list(channel) }`, channels `stable` and `beta`. Lists are
newest first by semver (`semver.ts`, no dependency: `parseSemver`, `compareSemver`,
`sortVersionsDesc`). Feeds return untrusted documents; nothing in a feed decides trust.

| Feed | Source | Notes |
| --- | --- | --- |
| `GitHubReleasesFeed({ owner, repo, apiBase?, manifestAssetName?, token?, fetchImpl? })` | `GET {apiBase}/repos/{owner}/{repo}/releases?per_page=30`, then each non-draft release's asset named `forerunner-release.json` (`DEFAULT_MANIFEST_ASSET_NAME`) by its `browser_download_url` | owner, repo and API base come from `update.json` or `FORERUNNER_UPDATE_FEED=github:<owner>/<repo>`; nothing is hardcoded. The manifest's own `channel` field decides the channel; the GitHub pre-release flag is advisory. Unreadable or malformed manifests are skipped with a warning. Works unchanged against the fake git host and GitHub Enterprise. |
| `JsonFeed({ url, fetchImpl? })` | `GET url` returning `{ "schema": 1, "releases": [SignedManifest, ...] }` | A static `releases.json` on any HTTPS host or object store. |
| `MemoryReleaseFeed(releases)` | in memory | tests, and installs with no feed configured. |

`feedFromConfig(config.feed, { fetchImpl?, token? })` builds the configured one. An unreachable
or failing feed is `ForerunnerError("unavailable", retryable)`; a malformed document `validation`.

### Manifest and signature (`manifest.ts`, `sign.ts`, `verify.ts`)

```json
{
  "manifest": {
    "schema": 1,
    "version": "1.2.0",
    "channel": "stable",
    "publishedAt": "2026-10-20T10:00:00.000Z",
    "notes": "## 1.2.0\n- changelog in Markdown",
    "minSchema": 1,
    "artifacts": [
      { "platform": "windows-x64", "name": "forerunner-1.2.0-windows-x64.zip", "url": "https://.../forerunner-1.2.0-windows-x64.zip", "sha256": "<64 hex>", "size": 12345678 },
      { "platform": "linux-x64", "name": "...", "url": "...", "sha256": "...", "size": 0 },
      { "platform": "android", "name": "forerunner-1.2.0.apk", "url": "...", "sha256": "...", "size": 0 }
    ]
  },
  "signature": { "alg": "ed25519", "keyId": "<16 hex>", "signature": "<base64, 64 bytes>" }
}
```

- `version` is a *release version* (`isReleaseVersion` in `semver.ts`): bare semver without a
  leading `v` and without build metadata, unchanged by `safeSegment`, because it is also the
  install directory name. One rule for the manifest schema, `buildReleaseManifest` (which strips
  a leading `v`) and `versionDir`, so the feed never offers a release the installer would refuse
  to stage; such a manifest is `malformed`.
- `canonicalJson(manifest)`: keys sorted at every level, no whitespace, `undefined` dropped. The
  signature is Ed25519 (`node:crypto`, no dependency) over the UTF-8 bytes of that string, so a
  change to the version, notes, an artefact hash, a URL or `minSchema` invalidates it.
- `keyId` = first 16 hex characters of `sha256(raw 32-byte public key)` (`keyIdOf`). Trusted
  keys (`update.trustedKeys`) are `{ id?, publicKey }` with the public key as base64 of the raw
  bytes or a PEM SubjectPublicKeyInfo; a missing `id` is derived.
- `ReleaseVerifier(trustedKeys)`:
  - `verifyManifest(document)` → `{ manifest, keyId }` or a refusal `malformed`, `unsigned`,
    `untrusted_key` (key id not configured), `bad_signature` (signature does not match the
    canonical bytes: tampered or re-signed with another key under a trusted id);
  - `assertNotDowngrade(candidate, current, allowDowngrade)` → `already_installed` for the same
    version, `downgrade` for an older one unless `allowDowngrade` is on;
  - `assertSchemaCompatible(manifest, localSchemaVersion)` → `schema_too_old` when the local
    `schema_migrations` version is below the release's `minSchema`;
  - `assertArtifactMatches(artifact, size, sha256)` → `tampered`.
  `refusalReason(error)` returns the reason string of any of these (`VerifyRefusal`).
- `sign.ts` is the release workflow's half: `generateSigningKeyPair()` (base64 raw public key,
  base64 32-byte seed), `buildReleaseManifest({ version, channel, publishedAt, notes,
  minSchema, artifacts: [{ platform, file, url, name? }] })` which hashes the built files on
  disk (`hashFileSync`, streamed in 1 MiB reads) so sizes and SHA-256s are never typed by hand
  and refuses duplicate platforms or an empty set, `signManifest(manifest, privateKeyValue,
  { keyId? })`, and `signManifestWithSecret(manifest, "secret:update_signing_key", vault)` which
  reads the key by reference, signs and drops it. Key-reading errors never include the input
  (OpenSSL messages are replaced), and `Logger` redaction covers PEM blocks should one ever be
  logged.

### Configuration (`config.ts`)

`<config>/update.json`, validated by the `UpdateConfig` zod schema, then overridden by
environment variables:

| Field | Env | Default |
| --- | --- | --- |
| `channel` | `FORERUNNER_UPDATE_CHANNEL` | `stable` |
| `feed` (`{kind:"github",owner,repo,apiBase?,manifestAssetName?}` or `{kind:"json",url}`, or `null` for no feed) | `FORERUNNER_UPDATE_FEED` = `github:<owner>/<repo>` or an http(s) URL; `FORERUNNER_UPDATE_API_BASE` | `DEFAULT_UPDATE_FEED` = `github:joelwellbournewood/Forerunner` (the project's GitHub Releases); `null` turns the feed off |
| `trustedKeys` | `FORERUNNER_UPDATE_TRUSTED_KEYS` = `id=base64,id2=base64` or `base64,base64` | `DEFAULT_TRUSTED_KEYS` = the project's update key `26fae7f48427e5eb` (`T4+qibk62TL/GuTszYxLstqgKDPTgNIYtXFAaJTwXaA=`, the public half of release.yml's `UPDATE_SIGNING_KEY`); an explicit list (also `[]`) replaces it, never adds to it |
| `allowDowngrade` | `FORERUNNER_UPDATE_ALLOW_DOWNGRADE` | `false` |
| `healthTimeoutMs` | `FORERUNNER_UPDATE_HEALTH_TIMEOUT_MS` | `60000` |
| `autoCheck` | — | `false`; parsed for older files and read by nothing: the feed is asked only by the human (below) |

A malformed file is a `validation` error, not a silent fallback: `fr update` fails on it, and a
long-running daemon (`updateConfigOrClosed`) starts with updates off (no feed, no trusted key,
never the built-in ones, so a fork's file with one typo does not trust the upstream key) and the
Updates screen shows "update.json ignored (updates are off): <reason>" as its `lastError`. The project's feed and update
key are built in as defaults (the human's decision of 2026-10-25, ADR 0015 amendment) so a
fresh install, a friend's included, finds and verifies official releases with no setup; a fork
or a private build replaces both in `update.json` or the environment. If the update key is
rotated, a release signed by the old key must ship the new key in `DEFAULT_TRUSTED_KEYS` first.

**Checks are manual.** Nothing asks the feed on its own: not the daemon start, the tray, the
scheduler or the start checklist (which reads the local `release` rows), and not opening the
Updates screen. The tray's item is "Updates…", which only opens that screen. The feed is asked only by the human's "Check for updates" button
(`POST /updates/check`), by `fr update check`, and by "Update and restart" (`apply`
re-checks the version it installs). Installing is always a separate human click.

### Install layout and the pointer file (`pointer.ts`, `install.ts`)

```
<data>/versions/
  current.json                 ← the pointer (atomic: temp file + fsync + rename)
  install.lock                 ← only while apply/rollback/health/prune runs (pid, operation, start)
  1.1.0/                       ← one directory per release
    release.json               ← the signed manifest as fetched
    app/...                    ← the unpacked zip artefact (or the single .msi/.apk file)
  1.2.0/
  .staging-1.2.0-<id>/         ← only while downloading/verifying; removed on any failure
```

`current.json`:

```json
{ "schema": 1, "current": "1.2.0", "previous": "1.1.0", "state": "pending_health_check",
  "updatedAt": "...", "lastRollback": { "from": "...", "to": "...", "reason": "...", "at": "...", "automatic": true } | null }
```

States (of the version `current` names): `installed`, `pending_health_check`, `failed`; a
rollback is recorded in `lastRollback`, and the screen derives its `rolled_back` state from
that. **Launcher contract (ADR 0015):** `current: null` means the packaged build runs: before
the first staged install, and after a rollback to the packaged build, whose version has no
directory under `versions/` (`rollbackCurrent(dirs, to)` writes null in that case, so a
well-formed pointer never names a missing directory; `lastRollback.to` still records the
version). A launcher must also treat a `current` whose directory is missing as the packaged
build and fall through (the desktop `install.rs` does: a missing staged directory is "not a
staged version"). `UpdateManager.installedVersion()` is the pointer's `current`, else the
running version. The shells read the pointer and launch `<versions>/<current>/`; no symlink or
junction is ever created, so the layout is identical on Windows and Linux and survives copying
the data directory. `writePointer` writes
`current.json.<id>.tmp` in the same directory, `fsync`s it, runs the test hook, then
`renameSync` over `current.json`: a crash before the rename leaves the old pointer intact and a
stale temp file that `cleanStalePointerTemps` removes on the next write. A corrupt pointer is a
`validation` error (never guessed around). `versionDir` refuses any version that is not a
release version (`hasVersionDir` answers false for one). `assertInsideVersions(dirs, path)`
guards every write of the install; `<config>` and everything in `<data>` outside `versions/`
(state database, memory, audit log) are never touched, by install or by rollback.

**One operation at a time (`lock.ts`).** `apply`, `rollback`, `healthCheck`, `stage` and
`prune` run under `<data>/versions/install.lock` (`withInstallLock` / `withInstallLockSync`):
the file is created exclusively (`wx`) with the holder's pid, operation and start time and
removed when the operation ends, however it ends. A second caller, in the same process or
another one (the daemon's route and `fr update` in a terminal), is refused at once with
`ForerunnerError("version_conflict")`, `details.reason: "in_progress"`, `retryable`, never
queued, and the refusal is audited for apply and rollback. A lock whose pid is gone
(`isPidAlive`: signal 0; `EPERM` counts as alive) is stale and replaced; an unreadable lock is
stale only when older than ten seconds on the injected clock (another process may be between
create and write). The route maps it to 409.

`UpdateManager(deps)` with `UpdateManagerDeps { dirs, clock, feed, verifier, store: { release,
auditLog }, human, restarter, probe, config, runningVersion (string or function),
localSchemaVersion, platform?, fetchImpl?, humanId?, checkCacheMs? }`:

| Method | Does |
| --- | --- |
| `check(by?, { fresh? })` → `UpdateCheck` | lists the channel, walks newest-first, stops at the first release that is not newer than `installedVersion()` (the pointer's current, else the running version); the first candidate that verifies, is schema-compatible and was not rolled back or failed here before becomes `available`; the ones skipped are `rejected: [{ version, reason, message }]`. The result is reused for `checkCacheMs` (default 60 s, `DEFAULT_CHECK_CACHE_MS`; 0 disables) while the installed version is unchanged, with `cached: true`: the screen asks on every view without a feed request or an audit row. `fresh: true` (the CLI, `apply`) always asks the feed; `invalidateCheck()` runs after apply, rollback and a health verdict. Only a real feed query audits `update.check`. |
| `stage(signed)` → `StagedInstall` | verifies the manifest, picks the artefact for `platform` (`detectArtifactPlatform()`: windows-x64, linux-x64, android), streams the download to the staging directory while hashing (more bytes than the manifest says is `tampered` at once), checks size and SHA-256, unpacks a `.zip` with `unpackZip` (refuses `..` segments, absolute and drive-letter names, backslashes, NUL, symlink entries, and any entry that resolves outside the target) or keeps a non-zip artefact as one file, writes `release.json`, renames the staging directory into place. Any failure removes the staging directory. |
| `apply({ by, version? })` → `ApplyResult` | under the install lock. Trust first: the manifest is verified (signature, downgrade, schema) and a release that rolled back or failed here before is refused, each audited as denied, before anyone is asked; then an agent actor needs `human.ask({ kind: approval, key: "update.apply:<version>" })` to answer `approved` (`pending` or `denied` → `approval_required`, audited as denied), so no refused release ever becomes an inbox item; then stages; inserts the `release` row (`status: published`, changelog, signature, artefacts) or reuses it; writes the pointer `{ current: version, previous: <old current or running version>, state: pending_health_check }`; audits `update.apply`; calls `restarter.restart({ reason: "update", targetVersion, fromVersion })`. |
| `healthCheck()` → `HealthOutcome` | the first-start check, see below. |
| `rollback({ by, reason? })` → `RollbackResult` | under the install lock. Manual rollback to `previous` (`not_found` when there is none; agents need approval, key `update.rollback:<from>:<to>`): pointer `{ current: previous when its directory exists else null, previous: null, state: installed, lastRollback: {automatic: false} }`, release row → `rolled_back` with `health: { ok: false, detail, manual: true, checkedAt, reportedBy: { human, agent } }` (the reporter, for peer installs' refusals), audit `update.rollback`, `human.notify(warning)`, restart. |
| `status()` → `UpdateStatus` | running version, channel, platform, pointer, version directories on disk, trusted key ids. No network. |
| `prune()` | under the install lock: removes version directories that are neither current nor previous. |

`detectArtifactPlatform(platform, arch)` throws `not_supported` for anything else (the manager
then reports `platform: null` and refuses to stage).

### Health check and rollback (`health.ts`)

`HealthProbe { name; check({ version, signal }) → { ok, detail, checks? } }`:

- `DaemonHealthProbe({ dirs, fetchImpl? })`: reads `daemon.json` from the runtime directory and
  calls the daemon's `/health` (ADR 0011); `ok` must be true and, when the route reports a
  version, it must equal the version under test.
- `DoctorHealthProbe({ argv, required? })`: runs `fr doctor --json` (any argv array, no shell)
  and requires exit 0 and every (or every `required`) check ok.
- `DefaultHealthProbe({ dirs, doctorArgv?, fetchImpl? })`: the daemon when `daemon.json`
  exists, else the doctor.
- `StaticHealthProbe(result | fn)`: tests.

`runStartupHealthCheck(deps)` (what `UpdateManager.healthCheck()` and `fr update health` call)
is run by the shell on **every** start and does nothing unless `current.json` is
`pending_health_check`:

1. If the running version differs from the pointer's `current`, the new build did not start
   (the shell fell back to the old one): that is a failure with that reason, no probe is run.
2. Otherwise the probe runs under `healthTimeoutMs` on the injected `Clock` (`probeWithTimeout`);
   a timeout or a thrown probe is a failed result.
3. Success: pointer → `installed`, release row → `installed` with `health: { ok: true, detail,
   probe, checkedAt, reportedBy: { human: humanId, agent: null } }` (`reportedBy` names the
   install whose check produced the verdict; the shared row's author is whoever first
   recorded the release, which may be a peer), audit `update.health` allowed.
4. Failure with a `previous`: pointer → `{ current: previous (null when it has no directory:
   the packaged build), previous: null, state: installed, lastRollback: { from, to, reason, at,
   automatic: true } }`, release row → `rolled_back` with the reason and `reportedBy` in `health`, audit
   `update.rollback`, `human.notify(error)` (an inbox item), `restarter.restart({ reason:
   "rollback", targetVersion: to })`. Outcome `rolled_back`.
5. Failure without a `previous` (first install): pointer → `failed`, row → `failed`,
   notification; outcome `failed_no_previous`.

The rolled-back version's directory stays until `prune()`; the release is never offered again
(`previously_rejected`): the fix is a new release. The rule (`assertNotRejectedBefore`) reads
the `release` row, which every install on the same state shares (ADR 0046), so a peer's
rollback refuses the release here too, before any download. The refusal says which install
reported the verdict and when rather than claiming it happened here: `rejectionReport(row,
humanId)` takes the reporter from `health.reportedBy`, which the automatic rollback
(`health.ts`) and the manual one both write (a `reportedBy` naming no human means the reporter
is unknown, not that the author stands in), else, for a row an older updater wrote, from the
row's author (the install that first recorded the release), and the time from
`health.checkedAt`, else `updated_at`; `mine` is true when the reporter's human is this
install's. The row carries no install id, so a second install of the same human (a laptop
beside the PC) reads as `mine` too; the wording therefore claims the human, never the machine.
`previouslyRejectedMessage` reads `release 1.2.0 was rolled back (reported by this install's
human, human <id>, on <at>); cut a new release`, `... on another install (reported by human
<id> on <at>) ...`, or, for a row that names no install, `... on an install sharing this
release table on <at> (reporter not recorded) ...`; a `failed` row says `failed its health
check` in place of `was rolled back`. The refusal's `details` carry `peer`, `reportedBy {
human, agent }` and `reportedAt` for the screen; `check()` lists the text under `rejected`,
and the audit row's `result_summary` is the same text.

### Ports (`ports.ts`)

| Port | Production | Tests |
| --- | --- | --- |
| `UpdateHumanPort { ask(req) → { outcome: approved/denied/pending, requestId? }; notify(note) }` | `HumanRequestUpdatePort(humanRequestRepo, humanId)`: an ask carries a stable `key` (`update.apply:<version>`, `update.rollback:<from>:<to>`) stored in the row's `change_card`; `ask` first looks for the newest `approval` row the updater created for that key: `answered` → `approved` when the answer is a yes (`isYes`: `yes`/`approve`/`{ choice: "approve" }`…), else `denied`; `open` → `pending` with that row's id and no duplicate; none, expired or withdrawn → a new blocking `human_request` row (kind `approval`, risk high, options yes/no) and `pending`. So the agent's retry after the human answered from the inbox goes through (or is refused) without a second inbox item. `notify` inserts a non-blocking `info` row | `FakeUpdateHumanPort(outcome)` records asks and notifications |
| `Restarter { restart({ reason, targetVersion, fromVersion }) }` | the desktop and Android shells relaunch into `current.json`'s version ("Update and restart"); the CLI uses `RecordingRestarter` and tells the user to restart | `RecordingRestarter`, and the test harness's `BootingRestarter` which "relaunches" into the target version |
| `ExtensionCatalog { latestVersions(refs) → CatalogEntry[] }` | the registry (`forerunner-registry`) adapter, wired by the orchestrator | `StaticExtensionCatalog(entries)` |
| `ModelWatchReport { latest() → ModelWatchEntry[] }` | the weekly model watch module (phase 7, elsewhere) | `StaticModelWatchReport(entries)` |

`composeUpdateManager(opts)` (`compose.ts`) builds a manager from this install's configuration:
setup config for the state URL, `update.json` + env, the configured feed, `ReleaseVerifier`,
`HumanRequestUpdatePort`, `DefaultHealthProbe`, `RecordingRestarter` unless a shell passes
its own, `localSchemaVersion` from the store's migration result.

### The updates screen (`screen.ts`)

`UpdatesView` (zod): `app: AppUpdateView` (current and running version, channel, `state` one of
`up_to_date | available | pending_health_check | rolled_back | failed | rejected | unknown`,
`available: { version, changelog, publishedAt, sizeBytes, artifactName, minSchema } | null`,
`previousVersion`, `rejected[]`, `lastRollback`, `lastError`, `checkedAt`), `connectors:
ConnectorUpdateView[]` (extension rows whose catalog version is newer: semver comparison when
both sides are semver, otherwise any difference, `isConnectorUpdate`), `models:
ModelUpdateView[]` (new models, price changes, deprecations, recommendations with evidence),
`generatedAt`. `composeUpdatesView({ manager, clock, extensions?, catalog?, modelWatch?,
checkFeed?, fresh?, checkedBy? })` fills it. By default (`checkFeed` false) it is local state
only: the pointer facts and `manager.lastCheckResult()` (the last feed query's result for what
is installed now, however old, null after an apply or rollback), never a feed request or an
audit row. `checkFeed: true` asks the manager (`fresh` bypasses its cache, `checkedBy` is the
audited actor); an unreachable feed yields `lastError` next to the last good check's result
(the same one `GET /updates` shows; `state: unknown` when there is none), never a failed page.
A fresh install follows `stable`; release candidates are published on `beta`.

`createUpdateRoutes({ ...viewDeps, humanId })` is a Hono sub-app the daemon mounts behind its
bearer-token middleware: `GET /updates` and `GET /updates/status` (local state, no network),
`POST /updates/check` (the "Check for updates" button: a fresh feed query audited as the
human, answers the view; 200 with `lastError` when the feed is unreachable),
`POST /updates/apply { version? }` → 202
`{ version, previous, state, restarting: true }`, `POST /updates/rollback { reason? }` → 202.
Errors map `not_found` 404, `validation` and `version_conflict` (another operation in
progress) 409, `approval_required`/`path_not_allowed` 403, `unavailable` 503, `not_supported`
400. Every UI action is attributed to `humanId`.

### CLI (`cli.ts`)

`registerUpdateCli(program, { manager?, vault?, out?, err? })` adds `fr update` with `check`
(always a fresh feed query), `apply [--version]`, `rollback [--reason]`, `status`, `health` (exit 1 after a rollback; the
shells call it after a relaunch), `keygen --out <file>` (private key to an owner-only file,
public key and key id printed, refuses to overwrite), `manifest --version --channel
--notes-file --min-schema --base-url --artifact <platform>:<file> [--artifact ...]
[--published-at] --out` (the unsigned manifest with hashes and sizes computed from the built
files; the artefact URL is `<base-url>/<file basename>`; `parseArtifactSpec` splits on the
first colon so Windows drive letters survive) and `sign --manifest (--key-file <file> |
--key-secret secret:<name>) --out`. `--key-secret` reads the key from the vault by reference
(`vault` dep, default `openVault()`); the key never appears in the output or the signed file.
All take `--json` where output matters. The default manager is `composeUpdateManager()`.

### Schema compatibility and the sync gate (`compat.ts`)

`isSchemaCompatible(local, peer, minSchema)` → `{ compatible, reason: ok | local_below_min |
peer_below_min | version_mismatch, action: none | update_local | update_peer, message }`.
Migrations are forward-only, so two installs sync only when both are at the same
`schema_migrations` version and both are at least the running release's `minSchema`; the lower
side has to update. `SyncGate(clock)`: `evaluate(local, peer, minSchema)` sets the paused flag
and emits `sync_paused` / `sync_resumed` events (`on(listener)`, `events`) only on a change;
`assertCanSync()` throws `ForerunnerError("unavailable", retryable)` while paused.

### The wired gate (`sync.ts`)

Installs share state by opening the same store (`stateUrl`, Postgres for two installs, SQLite
for one), so the peer side of the comparison is the store itself: its `schema_migrations`
table holds the highest migration any install applied. `openStore` migrates forward on open,
so an install whose code ships more migrations than the store carries moves the store ahead
of its peers, and an install whose code ships fewer (a peer updated first) sees the store ahead
of itself. This install's side is `MIGRATIONS.length`, the migration count its code ships; the
state service reports the same store version as `compatibleSchemaVersion` on `/health`.

`SchemaSync({ store, clock, humanId, localSchemaVersion?, minSchema? })` holds the one
`SyncGate` of a process (`RuntimeApp.schemaSync`). `refresh(source)` reads the store's
version (`appliedVersions`) and `learn(peerSchemaVersion, source)` takes one that was read
already; both go through `SyncGate.evaluate`, which pauses or resumes only on a change.
`minSchema` defaults to 1, the oldest migration, since every release's migrations start there;
`localSchemaVersion` is overridable for tests only (`ComposeOptions.schemaSync`).

| When | Who calls | Effect |
| --- | --- | --- |
| compose (every daemon start and CLI one-shot) | `composeRuntime` → `refresh("startup")` | a mismatch pauses before anything else is wired |
| every peer feed (session start, before every task, `GET /projects/:id/peers`) | `buildPeerFeed` → `learn(schemaVersion, "peer_feed")`, then `assertCanSync("peer_feed")`; the feed carries `schemaVersion` | a peer's migration is learned on the next read |
| after an update's health check | `fr daemon` → `refresh("update")` when `healthCheck()` was pending | the new code's version against the store |
| before each sync | `assertCanSync(what)` in `SessionRunner.start` (before the session row exists), the scheduler's `startSession`, `RuntimeApp.syncApprovals`, `RuntimeApp.mirrorSync`, the scheduler's mirror runs (`mirrorStartHandler` gets a gated `mirror.sync`, audit site `mirror.sync`), the peer feed | `ForerunnerError("unavailable", retryable)` with the compat in `details`; the daemon answers 503 |

The model watch and the memory consolidation are local jobs the same scheduler starts (this
install's providers, this human's memory); `startSession` routes them before it asks the gate,
so a paused install still runs them.

A pause is audited once (`sync.paused`, `allowed: false`, `denied_reason` the compat reason,
the versions and the source in `input_summary`) and surfaced once as a non-blocking `info`
request for the human (`author_agent: "sync-gate"`, `change_card.key: "sync.paused"`, `steps`
naming which install has to update): the open item is reused on every later check and across
daemon restarts, never repeated per tick. Each refused call site is audited once per pause
(`sync.refused`, `input_summary.what`), not per call, so a scheduler that asks every 30 s writes
one row. A resume (`sync.resumed`, `allowed: true`) and every compatible start withdraw the
open item. A paused install still composes (the updates screen and `fr update` are how it gets
fixed); it skips the approval sync at compose and logs why. `/health.sync` shows the state
(`SyncHealth`: `paused`, `local`, `peer`, `minSchema`, `action`, `message`, `checkedAt`).

The installer's own `assertSchemaCompatible` stays in force on top: a release needs a schema
the local store can reach.

## How to change it

- **Cut a release (signing).** Once per project: `fr update keygen --out release.key`, store the
  file's content in the vault (`secret:update_signing_key`) or as the CI secret
  `UPDATE_SIGNING_KEY`, and put the printed public key into every install's `update.json`
  (`trustedKeys`) or `DEFAULT_TRUSTED_KEYS`. Per release, after `release.yml` built the
  artefacts and `SHA256SUMS.txt`:
  1. `fr update manifest --version <tag without v> --channel stable|beta --notes-file
     <changelog section> --min-schema <oldest schema the release's migrations can upgrade from>
     --base-url https://<host>/<owner>/<repo>/releases/download/<tag> --artifact
     windows-x64:<msi or zip> --artifact linux-x64:<appimage or zip> --artifact android:<apk>
     --out manifest.json` (hashes and sizes come from the files; the URL of each artefact is
     the base URL plus the file name, which is what the Release asset upload produces);
     the `--version` after the subcommand is the release's: `fr` enables positional options, so
     its own `--version` (the program's) counts only before a subcommand (rc.2's publish job
     wrote no manifest before that; `update-cli-program.test.ts`);
  2. `fr update sign --manifest manifest.json --key-secret secret:update_signing_key --out
     forerunner-release.json` on a machine whose vault holds the key, or `--key-file <the CI
     secret written to a temp file>` in the workflow (or `signManifestWithSecret` in a script);
  3. upload `forerunner-release.json` as a Release asset next to the artefacts.
  The CI step must never print the key; the signed manifest contains no secret. Pre-releases
  carry `channel: beta`. The fake git host test (`update-githost.test.ts`) performs exactly
  these API calls and then installs from the result.
- **Rotate the signing key.** Add the new public key to `trustedKeys` in a release signed with
  the old key, ship it, then sign later releases with the new key and drop the old one.
- **Add a platform.** Extend `ARTIFACT_PLATFORMS` (manifest), `detectArtifactPlatform`
  (install) and the shells' launchers; non-zip artefacts are kept as one file for the shell's
  installer to run.
- **Change the pointer.** Bump `schema` in `CurrentPointer`, keep `readPointer` able to read the
  old shape (or refuse it with a clear message), keep the launcher contract (`current: null` or
  a missing directory = packaged build) and update ADR 0015 and the shells' launchers
  (`apps/desktop/src-tauri/src/install.rs`).
- **Change the version rule.** `isReleaseVersion` is the single rule for the manifest schema,
  `buildReleaseManifest` and `versionDir`; change it in one place and keep the "check never
  offers what apply cannot stage" test green.
- **Change the health check.** Implement `HealthProbe`; keep the timeout on the injected Clock
  so the timeout test stays deterministic.
- **Add a sync call site.** Anything new that reads from or writes to the shared state on
  behalf of a peer (a watcher, a route, a schedule) calls
  `await rt.schemaSync.assertCanSync("<what>")` first; `what` is the audit row's
  `input_summary.what` and is audited once per pause. Add the site's name to the sorted list
  the compose-level test in `sync-gate.test.ts` expects.
- **Add a peer version source.** Where a peer's schema version arrives by another road (a
  state service handshake, a device row), call `rt.schemaSync.learn(version, source)` with a
  new `SchemaSyncSource`; the gate changes state only on a change, so calling it often is free.
- **Wire the daemon and the shells.** The orchestrator mounts `createUpdateRoutes` in
  `daemon/server.ts`, registers `registerUpdateCli` in `cli/main.ts`, exports `./update/index.ts`
  from the package index, calls `healthCheck()` on daemon start, and passes a real `Restarter`
  (Tauri relaunch) and the `ExtensionCatalog` / `ModelWatchReport` adapters.
- **Add a refusal reason.** Extend `VerifyRefusal` in `verify.ts`; the UI shows
  `rejected[].reason` verbatim.

## Tests

`packages/runtime/test/update-*.test.ts` (60 tests, `pnpm vitest run --project unit
packages/runtime/test/update-verify.test.ts packages/runtime/test/update-install.test.ts
packages/runtime/test/update-screen.test.ts packages/runtime/test/update-health.test.ts
packages/runtime/test/update-githost.test.ts`), all against stand-ins on 127.0.0.1: a fake
release server (`node:http`, `update-helpers.ts`: GitHub-shaped release list, assets,
`releases.json`, byte overrides for tampering, a hand-built zip writer for zip-slip and symlink
entries), the testenv `FakeGitHost`, a `sqlite::memory:` store, a `SimulatedClock`, a test key
generated per process and a harness whose restarter "boots" into the staged version.
`packages/runtime/test/wiring.test.ts` (the orchestrator's) covers the daemon side: the mounted
routes, `fr update` on the program and the daemon exiting with `RESTART_EXIT_CODE` on apply.

- `update-verify.test.ts`: semver precedence; the release-version rule (manifest refuses build
  metadata, a leading `v`, an identifier `safeSegment` would change; `buildReleaseManifest`
  strips the `v` and refuses metadata); canonical JSON; sign/verify round trip (base64
  and PEM keys, key ids); refusals unsigned, untrusted key, forged key id, tampered artefact
  hash, edited notes, malformed, bad signature bytes; downgrade, already installed, schema too
  old, artefact mismatch; signing by secret reference without echoing the key;
  `buildReleaseManifest` and `hashFileSync` (multi-buffer file, duplicate platform, empty set,
  bad version or URL, missing file); both feeds over the fake server (channels, drafts,
  unreadable manifests, unavailable); configuration file and env overrides.
- `update-install.test.ts`: `check`; the staged layout, pointer, release row, audit row,
  restart request, no symlinks and config/memory/data hashes unchanged; health pass; status and
  prune; downgrade refused and allowed; not found; unsigned/wrong-key/tampered/schema-too-old
  releases rejected on the wire and nothing left behind, and an agent's request for one is
  refused before any approval is asked; artefact bytes or size mismatch refused; zip-slip and
  symlink entries refused (unit and through `apply`); agent approval denied/pending/approved;
  automatic rollback with row, notification, audit, restart and unchanged protected
  directories; timeout on the simulated clock; running-version mismatch; no previous version;
  manual rollback and its approval; a previously rejected release names the reporting install
  (a second `UpdateManager` of another human over the same store with its own directories,
  running build and shell: after an automatic rollback the first install's `check` and
  `apply` say "(reported by this install's human, human human-j, on <checkedAt>)" and the
  peer's "on another install (reported by human human-j on <checkedAt>)", `details.peer`,
  `reportedBy` and `reportedAt` on both, the peer's refusal audited under its own human with
  that text, nothing staged or restarted there; when the peer applied and passed first, so the
  row's author is the peer, the install whose health check rolled back is still the one named,
  on its own refusal and on the peer's once the peer is below the release again; a manual
  rollback writes `health.reportedBy`; a row with no reporter is refused "on an install
  sharing this release table ... (reporter not recorded)"; a `failed` row reads "failed its
  health check"); pointer
  crash simulation between temp write and rename,
  stale temp cleanup, corrupt pointer, unsafe version names; platform detection; the CLI
  commands including keygen (private key never printed), manifest (hashes from files, bad
  spec refused) and sign by file and by secret reference (key never printed, missing secret
  refused); a signed manifest with build metadata or a leading `v` (`signRaw` in the helpers
  bypasses the schema) is `malformed` for `check` and `apply` alike, audited, nothing staged;
  two parallel `apply` calls → one staged and restarted, the other `version_conflict`
  `in_progress` and audited, one release row, lock released; a held lock refuses rollback,
  health check and prune; a dead process's lock is cleared, a fresh unreadable one is held, an
  old unreadable one is stale; rollback (automatic and manual) to the packaged build writes
  `current: null` and never a missing directory, `installedVersion()` stays the running
  version, the next apply records the packaged version as `previous`, a rollback to a staged
  previous keeps its name; `HumanRequestUpdatePort` with a real `human_request` repo: pending
  inserts one row, a repeated ask does not duplicate it, "no" denies, an expired row is asked
  again, "approve" lets the same apply through with no new row, `notify` is a non-blocking
  info row.
- `update-screen.test.ts`: the three sections on one screen validated by the zod view;
  connector update rule; pending, rolled back, rejected and unknown states; routes (GET, apply,
  rollback, already installed, not found; a second apply during the first answers 409); the
  check cache (two views = one feed request and one audit row, `fresh` bypasses, the window
  expires on the injected clock, apply invalidates); `isSchemaCompatible` matrix; `SyncGate`
  pause, block, resume and listeners; pointer contains no path separators.
- `update-health.test.ts`: `DaemonHealthProbe` against a fake `/health` on 127.0.0.1 (missing
  or unreadable `daemon.json`, ok, version mismatch, not ok, 503, unreachable, timeout on the
  simulated clock aborting the request); `DoctorHealthProbe` running `node -e` (all ok, a
  failing check, `required` subset, non-zero exit, unparsable output); `DefaultHealthProbe`
  selection; `probeWithTimeout` with a throwing probe and timer cleanup; `runStartupHealthCheck`
  over a `sqlite::memory:` store writes `health.reportedBy` naming this install's human on the
  `rolled_back` and `failed` rows while the row's author (a peer that first recorded the
  release) stays, and `{ human: null }` when the install has no human.
- `update-githost.test.ts`: the release workflow's API calls against the testenv fake git host
  (create release, upload the artefact and the signed manifest as assets), then
  `GitHubReleasesFeed` lists the manifest, the manager stages from the host's
  `browser_download_url` and the health check passes; a private repository is refused without
  a token and listed with one.

- `sync-gate.test.ts` (`pnpm vitest run --project unit packages/runtime/test/sync-gate.test.ts`):
  on a `sqlite::memory:` store, an install whose code is one migration behind the store: sync
  refused while schema versions differ (the peer feed and a session start answer
  `unavailable`, no session row, one `sync.paused` audit row, one `sync.refused` row per call
  site, one non-blocking inbox item naming "update this install", nothing added by further
  ticks, refusals or a restart of the same install); allowed again after the update (the
  restarted process at the store's version resumes, withdraws the item, builds the feed with
  `schemaVersion` and runs a session); a peer's migration learned from the peer feed
  (`sync_paused` from source `peer_feed`) and a peer rollback resuming in place
  (`sync.resumed` row, item withdrawn, listeners never block); the other side
  (`update_peer`, "Update the other install"); `local_below_min`. Through the composed runtime
  on a file store: `/health.sync`, `GET /projects/:id/peers` 503 `unavailable`,
  `syncApprovals`, `mirrorSync`, the scheduler's start and a scheduled mirror run (a `tick()` of
  the schedule `refreshMirrorSchedules` registered) refused before a session row exists, the
  memory consolidation the same tick fires not held,
  the four call sites audited once, then a second compose at the store's version serving all
  of them with the item withdrawn.

Mutation checks done while writing: removing the artefact hash check fails the tamper test;
skipping the rollback write fails the four rollback tests; moving verification after the
approval request fails the "refused before any approval" assertion; dropping
`assertCanSync` from the peer feed or from `SessionRunner.start` fails the "sync refused"
cases; skipping the open-item lookup in `ensureRequest` fails the "not every tick" assertion.

## Known issues

- Wired by the daemon (`runtime.md`, "Local daemon"): the routes are mounted, `fr daemon` runs
  the health check once it listens, `fr update` is registered and the package index exports the
  module as the `updates` namespace. The daemon's `Restarter` writes `<runtime>/restart.json`
  and exits with `RESTART_EXIT_CODE` (86); the desktop shell's supervisor relaunches on it
  (`apps/desktop/src-tauri/src/restart.rs`, `decide_after_exit`; `actions.rs`,
  `watch_external_restart`, for a daemon the shell did not start) and its launcher starts the
  version `current.json` names (`install.rs`, `staged_version_dir`). `fr update apply` from the
  CLI stages the version and asks the user to restart (`update/cli.ts`): the CLI process is
  not the daemon the shell supervises.
- `release.yml` builds and uploads the signed `forerunner-release.json` asset in its publish
  job (`fr update manifest` from the downloaded artefacts, `fr update sign --key-file` with the
  `UPDATE_SIGNING_KEY` secret written to a temp file and removed after); the step is skipped
  when the secret is absent, so a release without the secret is unsigned and no install will
  take it. `release.md`'s staged-install steps keep the earlier Tauri/minisign wording (with a
  note pointing here); this module replaces that plan with the Ed25519 manifest (ADR 0015).
- The sync gate learns of a peer's migration when this install next reads the shared state
  (a session start, a peer feed before a task, `GET /projects/:id/peers`, the health check
  after an update); an idle daemon with no session due keeps its last verdict until then.
  The phone and web clients of the state service have their own check (the service answers
  `409 schema_mismatch` to a declared `x-forerunner-schema`); the gate here covers the
  runtime's store path only.
- `HumanRequestUpdatePort.ask` answers `pending` until the human answers from the inbox; the
  answer is consumed by the next `apply`/`rollback` with the same key, but nothing re-issues
  that call by itself: the conversation/command layer (or the agent) has to retry after the
  inbox item is answered.
- The check cache is per process: `fr update apply` in a terminal changes the pointer, and the
  daemon's cached check is reused until its window expires or the installed version differs
  (the cache is keyed by it), at most `checkCacheMs`.
- Android installs through the system package installer; the staged layout stores the APK and
  the shell has to hand it over. Rollback on Android keeps the previous APK in `versions/`.
- `GitHubReleasesFeed` fetches one manifest asset per release on every `list`; with many
  releases on the channel that is one request each (bounded by `perPage`, default 30). A
  cache keyed by release id would remove the repeat fetches.
- `health.reportedBy` names a human, not an install: the release row has no install column,
  so two installs of one human over one state cannot be told apart in a refusal (the text
  says "this install's human"). Recording an install id there (and comparing on it) would
  need one the runtime knows about itself; it has none today.

## Requirements covered

| ID | Clause | Where |
| --- | --- | --- |
| M.3 | signed builds from GitHub Releases; "Update available", changelog, "Update and restart" | `feed.ts`, `verify.ts`, `sign.ts`, `screen.ts` (`AppUpdateView.available.changelog`), `UpdateManager.apply` + `Restarter` |
| M.4 | staged install, health check on restart, automatic rollback; config, memory and data untouched | `install.ts`, `pointer.ts`, `health.ts`; `protectedHashes` tests; a rolled-back release refused on every install of the shared state, the refusal naming the reporting install and time (`rejectionReport`) |
| M.5 | connector and model updates on the same updates screen | `screen.ts` (`connectors`, `models`), `ExtensionCatalog`, `ModelWatchReport` |
| M.6 | shared state schema changes use versioned migrations; both apps on a compatible version before sync resumes | `compat.ts` (`isSchemaCompatible`, `SyncGate`), `sync.ts` (`SchemaSync` over the store's `schema_migrations`), wired in `compose.ts` (sessions, approvals, manual and scheduled mirror runs), `session/runner.ts`, `session/peers.ts`, `daemon/server.ts`, `cli/main.ts`; `minSchema` in the manifest and `assertSchemaCompatible` keep a release from staging onto a store it cannot reach; `sync-gate.test.ts` |
| K.6 (part) | Extensions panel: version and updates | `ConnectorUpdateView` |
| R.1 (part) | updates through the same release channel on Android | `android` artefact platform, same feed and verifier |
| S.1, S.6 | limits in code; granting/changing the installed software by an agent needs a human | `requireApproval`, refusals |
| S.9 | append-only audit of every outward action | `update.check`, `update.apply`, `update.rollback`, `update.health` rows |
