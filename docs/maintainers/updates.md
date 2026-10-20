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
(`path_not_allowed`); sync calls are blocked while schema versions differ (`unavailable`).
Every outward action (feed check, install, rollback, health verdict) appends an `audit_log` row.

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
  base64 32-byte seed), `signManifest(manifest, privateKeyValue, { keyId? })`,
  `signManifestWithSecret(manifest, "secret:update_signing_key", vault)` which reads the key by
  reference, signs and drops it. Key-reading errors never include the input (OpenSSL messages
  are replaced), and `Logger` redaction covers PEM blocks should one ever be logged.

### Configuration (`config.ts`)

`<config>/update.json`, validated by the `UpdateConfig` zod schema, then overridden by
environment variables:

| Field | Env | Default |
| --- | --- | --- |
| `channel` | `FORERUNNER_UPDATE_CHANNEL` | `stable` |
| `feed` (`{kind:"github",owner,repo,apiBase?,manifestAssetName?}` or `{kind:"json",url}`) | `FORERUNNER_UPDATE_FEED` = `github:<owner>/<repo>` or an http(s) URL; `FORERUNNER_UPDATE_API_BASE` | none (no updates offered) |
| `trustedKeys` | `FORERUNNER_UPDATE_TRUSTED_KEYS` = `id=base64,id2=base64` or `base64,base64` | `[]` (every release refused as `untrusted_key`) |
| `allowDowngrade` | `FORERUNNER_UPDATE_ALLOW_DOWNGRADE` | `false` |
| `healthTimeoutMs` | `FORERUNNER_UPDATE_HEALTH_TIMEOUT_MS` | `60000` |
| `autoCheck` | — | `true` |

A malformed file is a `validation` error, not a silent fallback. The build's trusted public key
is meant to be written into `update.json` by the installer (or compiled into the shell, which
then passes it in); the registry owner and repo come from the install, never from code.

### Install layout and the pointer file (`pointer.ts`, `install.ts`)

```
<data>/versions/
  current.json                 ← the pointer (atomic: temp file + fsync + rename)
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

States: `installed`, `pending_health_check`, `rolled_back`, `failed`. `current: null` means no
staged install yet (the packaged build runs). The shells read the pointer and launch
`<versions>/<current>/`; no symlink or junction is ever created, so the layout is identical on
Windows and Linux and survives copying the data directory. `writePointer` writes
`current.json.<id>.tmp` in the same directory, `fsync`s it, runs the test hook, then
`renameSync` over `current.json`: a crash before the rename leaves the old pointer intact and a
stale temp file that `cleanStalePointerTemps` removes on the next write. A corrupt pointer is a
`validation` error (never guessed around). `versionDir` refuses any version that is not a safe
single path segment. `assertInsideVersions(dirs, path)` guards every write of the install;
`<config>` and everything in `<data>` outside `versions/` (state database, memory, audit log)
are never touched, by install or by rollback.

`UpdateManager(deps)` with `UpdateManagerDeps { dirs, clock, feed, verifier, store: { release,
auditLog }, human, restarter, probe, config, runningVersion (string or function),
localSchemaVersion, platform?, fetchImpl?, humanId? }`:

| Method | Does |
| --- | --- |
| `check(by?)` → `UpdateCheck` | lists the channel, walks newest-first, stops at the first release that is not newer than `installedVersion()` (the pointer's current, else the running version); the first candidate that verifies, is schema-compatible and was not rolled back or failed here before becomes `available`; the ones skipped are `rejected: [{ version, reason, message }]`. Audits `update.check`. |
| `stage(signed)` → `StagedInstall` | verifies the manifest, picks the artefact for `platform` (`detectArtifactPlatform()`: windows-x64, linux-x64, android), streams the download to the staging directory while hashing (more bytes than the manifest says is `tampered` at once), checks size and SHA-256, unpacks a `.zip` with `unpackZip` (refuses `..` segments, absolute and drive-letter names, backslashes, NUL, symlink entries, and any entry that resolves outside the target) or keeps a non-zip artefact as one file, writes `release.json`, renames the staging directory into place. Any failure removes the staging directory. |
| `apply({ by, version? })` → `ApplyResult` | an agent actor first needs `human.ask(approval)` to answer `approved` (`pending` or `denied` → `approval_required`, audited as denied); then refuses a release that rolled back or failed here before; stages; inserts the `release` row (`status: published`, changelog, signature, artefacts) or reuses it; writes the pointer `{ current: version, previous: <old current or running version>, state: pending_health_check }`; audits `update.apply`; calls `restarter.restart({ reason: "update", targetVersion, fromVersion })`. |
| `healthCheck()` → `HealthOutcome` | the first-start check, see below. |
| `rollback({ by, reason? })` → `RollbackResult` | manual rollback to `previous` (`not_found` when there is none; agents need approval): pointer `{ current: previous, previous: null, state: installed, lastRollback: {automatic: false} }`, release row → `rolled_back`, audit `update.rollback`, `human.notify(warning)`, restart. |
| `status()` → `UpdateStatus` | running version, channel, platform, pointer, version directories on disk, trusted key ids. No network. |
| `prune()` | removes version directories that are neither current nor previous. |

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
   probe, checkedAt }`, audit `update.health` allowed.
4. Failure with a `previous`: pointer → `{ current: previous, previous: null, state: installed,
   lastRollback: { from, to, reason, at, automatic: true } }`, release row → `rolled_back` with
   the reason in `health`, audit `update.rollback`, `human.notify(error)` (an inbox item),
   `restarter.restart({ reason: "rollback" })`. Outcome `rolled_back`.
5. Failure without a `previous` (first install): pointer → `failed`, row → `failed`,
   notification; outcome `failed_no_previous`.

The rolled-back version's directory stays until `prune()`; the release is never offered again
on this install (`previously_rejected`): the fix is a new release.

### Ports (`ports.ts`)

| Port | Production | Tests |
| --- | --- | --- |
| `UpdateHumanPort { ask(req) → { outcome: approved/denied/pending, requestId? }; notify(note) }` | `HumanRequestUpdatePort(humanRequestRepo, humanId)`: `ask` inserts a `human_request` row (kind `approval`, risk high, blocking) and answers `pending` (the human answers from the inbox; the caller treats pending as not approved); `notify` inserts a non-blocking `info` row | `FakeUpdateHumanPort(outcome)` records asks and notifications |
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
checkFeed? })` fills it; an unreachable feed yields `state: unknown` with `lastError`, never
a failed page.

`createUpdateRoutes({ ...viewDeps, humanId })` is a Hono sub-app the daemon mounts behind its
bearer-token middleware: `GET /updates` (asks the feed), `GET /updates/status` (no network),
`POST /updates/apply { version? }` → 202 `{ version, previous, state, restarting: true }`,
`POST /updates/rollback { reason? }` → 202. Errors map `not_found` 404, `validation` 409,
`approval_required`/`path_not_allowed` 403, `unavailable` 503, `not_supported` 400. Every UI
action is attributed to `humanId`.

### CLI (`cli.ts`)

`registerUpdateCli(program, { manager?, out?, err? })` adds `fr update` with `check`, `apply
[--version]`, `rollback [--reason]`, `status`, `health` (exit 1 after a rollback; the shells call
it after a relaunch), `keygen --out <file>` (private key to an owner-only file, public key and
key id printed, refuses to overwrite) and `sign --manifest --key-file --out`. All take `--json`
where output matters. The default manager is `composeUpdateManager()`.

### Schema compatibility and the sync gate (`compat.ts`)

`isSchemaCompatible(local, peer, minSchema)` → `{ compatible, reason: ok | local_below_min |
peer_below_min | version_mismatch, action: none | update_local | update_peer, message }`.
Migrations are forward-only, so two installs sync only when both are at the same
`schema_migrations` version and both are at least the running release's `minSchema`; the lower
side has to update. `SyncGate(clock)`: `evaluate(local, peer, minSchema)` sets the paused flag
and emits `sync_paused` / `sync_resumed` events (`on(listener)`, `events`) only on a change;
`assertCanSync()` throws `ForerunnerError("unavailable", retryable)` while paused. The state
service client calls `evaluate` at startup, from the peer feed and after every update, and
`assertCanSync` before each sync call.

## How to change it

- **Cut a release (signing).** Once per project: `fr update keygen --out release.key`, store the
  file's content in the vault (`secret:update_signing_key`) or as the CI secret
  `UPDATE_SIGNING_KEY`, and put the printed public key into every install's `update.json`
  (`trustedKeys`) or the shell's compiled-in default. Per release, after `release.yml` built the
  artefacts and `SHA256SUMS.txt`: write the unsigned manifest (version, channel, notes from the
  changelog section, `minSchema` = the oldest schema the release's migrations can upgrade from,
  one artefact per platform with the Release asset URL, size and sha256), then
  `fr update sign --manifest manifest.json --key-file <secret written to a temp file> --out
  forerunner-release.json` (or `signManifestWithSecret` in a script) and upload
  `forerunner-release.json` as a Release asset. The CI step must never print the key; the signed
  manifest contains no secret. Pre-releases carry `channel: beta`.
- **Rotate the signing key.** Add the new public key to `trustedKeys` in a release signed with
  the old key, ship it, then sign later releases with the new key and drop the old one.
- **Add a platform.** Extend `ARTIFACT_PLATFORMS` (manifest), `detectArtifactPlatform`
  (install) and the shells' launchers; non-zip artefacts are kept as one file for the shell's
  installer to run.
- **Change the pointer.** Bump `schema` in `CurrentPointer`, keep `readPointer` able to read the
  old shape (or refuse it with a clear message), and update ADR 0015.
- **Change the health check.** Implement `HealthProbe`; keep the timeout on the injected Clock
  so the timeout test stays deterministic.
- **Wire the daemon and the shells.** The orchestrator mounts `createUpdateRoutes` in
  `daemon/server.ts`, registers `registerUpdateCli` in `cli/main.ts`, exports `./update/index.ts`
  from the package index, calls `healthCheck()` on daemon start, and passes a real `Restarter`
  (Tauri relaunch) and the `ExtensionCatalog` / `ModelWatchReport` adapters.
- **Add a refusal reason.** Extend `VerifyRefusal` in `verify.ts`; the UI shows
  `rejected[].reason` verbatim.

## Tests

`packages/runtime/test/update-*.test.ts` (40 tests, `pnpm vitest run --project unit
packages/runtime/test/update-verify.test.ts packages/runtime/test/update-install.test.ts
packages/runtime/test/update-screen.test.ts`), all against a fake release server on 127.0.0.1
(`node:http`, `update-helpers.ts`: GitHub-shaped release list, assets, `releases.json`,
byte overrides for tampering, a hand-built zip writer for zip-slip and symlink entries), a
`sqlite::memory:` store, a `SimulatedClock`, a test key generated per process and a harness
whose restarter "boots" into the staged version.

- `update-verify.test.ts`: semver precedence; canonical JSON; sign/verify round trip (base64
  and PEM keys, key ids); refusals unsigned, untrusted key, forged key id, tampered artefact
  hash, edited notes, malformed, bad signature bytes; downgrade, already installed, schema too
  old, artefact mismatch; signing by secret reference without echoing the key; both feeds over
  the fake server (channels, drafts, unreadable manifests, unavailable); configuration file and
  env overrides.
- `update-install.test.ts`: `check`; the staged layout, pointer, release row, audit row,
  restart request, no symlinks and config/memory/data hashes unchanged; health pass; status and
  prune; downgrade refused and allowed; not found; unsigned/wrong-key/tampered/schema-too-old
  releases rejected on the wire and nothing left behind; artefact bytes or size mismatch
  refused; zip-slip and symlink entries refused (unit and through `apply`); agent approval
  denied/pending/approved; automatic rollback with row, notification, audit, restart and
  unchanged protected directories; timeout on the simulated clock; running-version mismatch;
  no previous version; manual rollback and its approval; pointer crash simulation between temp
  write and rename, stale temp cleanup, corrupt pointer, unsafe version names; platform
  detection; the CLI commands including keygen (private key never printed) and sign.
- `update-screen.test.ts`: the three sections on one screen validated by the zod view;
  connector update rule; pending, rolled back, rejected and unknown states; routes (GET, apply,
  rollback, already installed, not found); `isSchemaCompatible` matrix; `SyncGate` pause,
  block, resume and listeners; pointer contains no path separators.

Mutation checks done while writing: removing the artefact hash check fails the tamper test;
skipping the rollback write fails the four rollback tests.

## Known issues

- Not wired yet: the daemon does not mount the routes or run the health check, the CLI does
  not register `fr update`, and `packages/runtime/src/index.ts` does not export the module
  (the orchestrator does this). The shells' `Restarter` (Tauri relaunch into
  `<versions>/<current>`) and the launcher that reads `current.json` do not exist yet; until
  then `fr update apply` stages and asks the user to restart.
- `release.yml` does not yet build the signed `forerunner-release.json` asset; `release.md`
  describes the Tauri/minisign plan, which this module replaces with the Ed25519 manifest
  (ADR 0015). The workflow step is: write the manifest, `fr update sign`, upload.
- `HumanRequestUpdatePort.ask` always answers `pending` (the inbox answers asynchronously); an
  agent-initiated update therefore needs a second `apply` after the human approved, driven by
  the conversation/command layer.
- Android installs through the system package installer; the staged layout stores the APK and
  the shell has to hand it over. Rollback on Android keeps the previous APK in `versions/`.
- `docs-check` maps `packages/runtime/` to `runtime.md`, `sandbox.md`, `adding-a-provider.md`
  and `adding-a-specialist.md`; this file must be added to that mapping in
  `scripts/docs-check.mjs` and to `docs/maintainers/README.md`.

## Requirements covered

| ID | Clause | Where |
| --- | --- | --- |
| M.3 | signed builds from GitHub Releases; "Update available", changelog, "Update and restart" | `feed.ts`, `verify.ts`, `sign.ts`, `screen.ts` (`AppUpdateView.available.changelog`), `UpdateManager.apply` + `Restarter` |
| M.4 | staged install, health check on restart, automatic rollback; config, memory and data untouched | `install.ts`, `pointer.ts`, `health.ts`; `protectedHashes` tests |
| M.5 | connector and model updates on the same updates screen | `screen.ts` (`connectors`, `models`), `ExtensionCatalog`, `ModelWatchReport` |
| M.6 | both installs on a compatible schema version before sync resumes | `compat.ts` (`isSchemaCompatible`, `SyncGate`), `minSchema` in the manifest and `assertSchemaCompatible` |
| K.6 (part) | Extensions panel: version and updates | `ConnectorUpdateView` |
| R.1 (part) | updates through the same release channel on Android | `android` artefact platform, same feed and verifier |
| S.1, S.6 | limits in code; granting/changing the installed software by an agent needs a human | `requireApproval`, refusals |
| S.9 | append-only audit of every outward action | `update.check`, `update.apply`, `update.rollback`, `update.health` rows |
