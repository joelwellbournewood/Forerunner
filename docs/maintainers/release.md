# Release

Signing, the release workflow, staged rollout and rollback, the operational scripts in
`scripts/`, and what to do when a signing secret is missing. The spec's release steps
(Build agent manual, "Release steps") are the checklist at the end of this file.

## Purpose

A release is a git tag `vX.Y.Z` that `.github/workflows/release.yml` turns into a GitHub
Release with: the Windows installer (MSI), the Linux AppImage and `.deb`, the Android APK,
`SHA256SUMS.txt`, release notes built from `CHANGELOG.md`, the user guide and the setup guide,
plus the cloud-runner image pushed to the GitHub container registry. The same image also runs
the shared state service (`pnpm state-api`). Nothing in the pipeline names an organisation,
account or host: the registry owner comes from `github.repository_owner`, the clone URL from
the checkout, every secret from the repository's secrets.

Humans approve every release (spec: "Agents open PRs; humans approve every release"). Nothing
is published to app stores or public package registries without a human go.

## How it works

### The release workflow (`.github/workflows/release.yml`)

Triggered by a pushed tag matching `v*`, or by hand (`workflow_dispatch` with the tag).

| Job | Runner | Produces | Notes |
| --- | --- | --- | --- |
| `desktop` | `ubuntu-22.04`, `windows-latest` | `bundle/msi/*`, `bundle/appimage/*`, `bundle/deb/*` | `pnpm --filter @forerunner/desktop tauri build --ci` with the signing env below. Ubuntu 22.04 is the oldest supported glibc for the AppImage. |
| `android` | `ubuntu-latest` | `apk/**/*.apk` | `node scripts/android-keystore.mjs` prepares the keystore, then `tauri android build --apk --ci` |
| `runner-image` | `ubuntu-latest` | `ghcr.io/<owner>/forerunner-runner:<version>` and `:latest` | `services/cloud-runner/Dockerfile`; the tag is the git tag without `v` |
| `publish` | `ubuntu-latest` | the GitHub Release | downloads every artefact, writes `SHA256SUMS.txt` (`sha256sum` over `artifacts/`), runs `node scripts/release-notes.mjs "$GITHUB_REF_NAME" > RELEASE_NOTES.md`, then `softprops/action-gh-release` uploads `artifacts/**/*`, `docs/user-guide.md` and `docs/setup-guide.md`. A tag containing `-` (for example `v1.0.0-rc.1`) is published as a pre-release. |

`scripts/release-notes.mjs <tag>` prints Markdown: the `CHANGELOG.md` section for the tag
(falling back to `Unreleased` with a visible note), a table of the artefacts actually found
under `artifacts/` (or the expected kinds when run locally), the runner image name, the signing
status read from the environment (presence only, never values), and how to verify checksums.

### Signing

| What | Mechanism | Secret(s) | When the secret is missing |
| --- | --- | --- | --- |
| Update signatures (Tauri updater) | Tauri signs every bundle with a minisign key; the app's updater verifies the signature against `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json` before installing | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Bundles build unsigned; the in-app updater (phase 7) refuses them; release notes say "unsigned". Generate the pair once with `pnpm --filter @forerunner/desktop tauri signer generate -w forerunner.key`, store the private key and password as secrets, commit only the public key into `tauri.conf.json`. |
| Windows installer (Authenticode) | The PFX is imported into the runner's certificate store and Tauri signs the MSI with `bundle.windows.certificateThumbprint` (or a `signCommand` for an HSM/Azure Trusted Signing setup) | `WINDOWS_CERTIFICATE` (base64 PFX), `WINDOWS_CERTIFICATE_PASSWORD` | The MSI is unsigned; SmartScreen warns at install; `release-notes.mjs` prints "unsigned (no certificate provided)" and a SmartScreen note. This is the state of 1.0 unless a certificate arrives (`docs/status/BLOCKERS.md`). |
| Android APK | Gradle signs the release APK with the keystore described in `apps/mobile/src-tauri/gen/android/keystore.properties` | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` (alias `forerunner`, override with `ANDROID_KEYSTORE_ALIAS`) | `scripts/android-keystore.mjs` generates a development keystore with `keytool` (JDK from `JAVA_HOME` or `PATH`), a random password that is written only to the gitignored `keystore.properties`, and prints a NOTE. The APK installs by sideloading but is not for distribution; the generated key is kept in the vault for a stable identity across builds once the vault export exists (BLOCKERS.md). |
| Checksums | `SHA256SUMS.txt` next to the artefacts | none | always produced |

`scripts/android-keystore.mjs` is pure Node: paths through `node:path`, `keytool` started with
an argv array (no shell) and the password passed through `-storepass:env` so it never appears
in a process listing; stdout never contains a secret; a keytool failure is reported with the
password redacted. Running it twice keeps the existing development key.

### Versions and the changelog

`CHANGELOG.md` follows Keep a Changelog. Every release needs a `## [X.Y.Z] - YYYY-MM-DD`
section; entries accumulate under `## [Unreleased]` while work lands. The version lives in the
root `package.json`, `apps/desktop/src-tauri/tauri.conf.json` (`version`, shown in the MSI and
AppImage metadata), `apps/mobile/src-tauri/tauri.conf.json` and the Cargo manifests of the two
shells; keep them equal to the tag.

### Staged install, health check, rollback (module M, phase 7)

The contract the updater implements; today the release channel and signatures exist, the in-app
updater does not yet (see Known issues).

1. **Check.** The app reads the latest release's updater manifest (`latest.json` uploaded by
   the release workflow once the updater plugin is on) and shows "Update available" with the
   changelog section from the release notes.
2. **Stage.** On "Update and restart", the bundle is downloaded into `appDirs().cache/updates/
   staging/<version>/`, its SHA-256 compared with `SHA256SUMS.txt` and its minisign signature
   verified against the public key compiled into the app. Nothing is replaced until both pass.
3. **Swap.** The current bundle is copied to `appDirs().cache/updates/previous/` and the staged
   one installed (MSI upgrade on Windows, AppImage/.deb replacement on Linux). Config, memory
   and data directories (`appDirs().config`, `.data`) are never touched by the installer.
4. **Health check.** The new build starts, runs schema migrations, and must answer the local
   daemon's health endpoint and complete the startup checklist within 60 s.
5. **Rollback.** If the health check fails, the app reinstalls `previous/`, restarts, and posts
   an inbox item with the failure. Schema migrations are forward-only; a rollback across a
   migration restores the pre-migration database copy taken in step 3 (`data/state.sqlite.bak`).

Scenario 7 ("Bad update") in `tests/e2e/` installs a deliberately broken build and expects the
rollback. Until the updater ships, a human rolls back by installing the previous release from
GitHub Releases over the current one; data directories are untouched.

Staged rollout: tag a release candidate first (`v1.0.0-rc.1` publishes as a pre-release, the
updater's default channel ignores pre-releases), install it on both reference machines, run the
nine scenarios, then tag `v1.0.0`.

### The cloud runner image and the state service

`services/cloud-runner/Dockerfile` builds one image used as the sandbox image in CI
(`ci.yml`, job `sandbox-image`) and as the cloud runner. `runner-image` pushes it to GHCR with
`GITHUB_TOKEN`; no personal token is needed. Deploy with
`docker run -d --name forerunner-runner -v forerunner-data:/data -e FORERUNNER_STATE_URL=postgres://… ghcr.io/<owner>/forerunner-runner:<version>`;
the state service is the same image with `pnpm state-api` as the command (see
`state-service.md` and `cloud-runner.md`). Rollback is `docker run` with the previous tag.

### Fresh install scripts (gate: "fresh install in under 15 minutes")

`scripts/fresh-install.sh` (Linux: Ubuntu/Debian via apt, Fedora/RHEL via dnf) and
`scripts/fresh-install.ps1` (Windows 10/11 via winget, falling back to choco) are the scripted
install that `.github/workflows/fresh-install.yml` times weekly and on every change to them.
Both are idempotent and non-interactive with `--non-interactive` / `-NonInteractive`, print
every step with its elapsed seconds, and exit 3 when the total is over 900 s. Steps:

1. prerequisites: git, curl (Linux), Node.js >= 22.13 installed through the system package
   manager when missing (NodeSource `node_22.x` apt repository with its key stored in
   `/etc/apt/keyrings`, `dnf install nodejs22` or the `nodejs:22` module; `winget install
   OpenJS.NodeJS.22` then `OpenJS.NodeJS.LTS`; `choco install nodejs-lts`), corepack;
2. repository: the checkout the script lives in, else the checkout of the current directory,
   else `FORERUNNER_INSTALL_DIR` (default `~/forerunner`) if it is one, else a clone of
   `FORERUNNER_REPO_URL` into it; with no URL known it prints how to set one and exits 2;
3. pnpm through `corepack prepare pnpm@<version from package.json> --activate` (falls back to
   `npm install -g pnpm@…` when corepack cannot write its shims);
4. `pnpm install --frozen-lockfile`; 5. `pnpm typecheck`; 6. `pnpm test:unit` (both skipped
   with `--skip-tests`, which the gate does not allow);
7. desktop prerequisites: Linux installs the Tauri system libraries only with `--with-desktop`;
   Windows prints what the desktop build needs (Rust, MSVC build tools, WebView2);
8. `pnpm fr setup --non-interactive --profile install-check` creates the application
   directories and config (credentials are added later with `pnpm fr setup`), then `pnpm fr dirs`.

`--dry-run` prints every step and command without changing anything; the unit test runs it.
Evidence for the gate is the workflow's job summary line `fresh install took Ns`.

### Other operational scripts

| Script | Used by | Does |
| --- | --- | --- |
| `scripts/dev-postgres.sh` / `.ps1` | developers, `AGENTS.md` | starts Postgres for the integration tests: a server already answering on 5432 is reused, else Docker container `forerunner-pg` (`postgres:16`), else the local service/cluster (`pg_ctlcluster`, `systemctl`, the `postgresql*` Windows service, `pg_ctl` with `PGDATA`); creates `forerunner_test`, sets the password, prints the `FORERUNNER_TEST_PG` line to export. `--status`, `--stop`. |
| `scripts/gates-verify.ts` (`pnpm gates:verify`) | the build loop, CI (to be added to `check`) | parses `docs/status/gates.md` and `docs/requirements.md`; prints every gate with its evidence state; exits 1 when a passed check lacks command, date, result or CI link, a passed release criterion lacks a command, date and CI link, a criterion is passed while a requirement is not done, or a requirement is done without a test path |
| `scripts/sync-registry.ts` | registry maintainers | dry run by default: diff of `evals/registry/` against `FORERUNNER_REGISTRY_DIR` (or the sibling `../forerunner-registry`); `--apply` copies, `--pull` reverses the direction, `--prune` deletes target-only files, `--force` overrides the guard that refuses to overwrite a registry edited since the hash recorded in `evals/registry/.sync.json`. No network. |
| `scripts/check-paths.mjs` | CI as `pnpm lint:paths` | fails on hand-built paths outside `packages/platform`: string concatenation with `/` or `\\` next to a path-like identifier, and `node:path` imports. `// path-ok <why>` skips a line. |
| `scripts/release-notes.mjs`, `scripts/android-keystore.mjs` | `release.yml`, `android.yml` | see above |
| `scripts/docs-check.mjs`, `secret-scan.mjs`, `link-check.mjs` | `ci.yml` | docs stay true, credential shapes, Markdown links (see `testing.md`) |

## How to change it

- **Cut a release.** Move the `Unreleased` entries into a `## [X.Y.Z] - date` section, bump
  the versions listed above, merge, then `git tag vX.Y.Z && git push origin vX.Y.Z`. Watch the
  four jobs; the Release appears as a draft-free release (pre-release when the tag has a `-`).
- **Add or drop an artefact.** `bundle.targets` in the desktop `tauri.conf.json`, the
  `upload-artifact` paths in `release.yml`, and `kindOf()` in `scripts/release-notes.mjs` so
  the table names it.
- **Wire the Windows certificate when it arrives.** Add a `windows-latest` step before the
  build that decodes `WINDOWS_CERTIFICATE` to a `.pfx`, imports it
  (`Import-PfxCertificate -CertStoreLocation Cert:\CurrentUser\My`), and set
  `bundle.windows.certificateThumbprint`, `digestAlgorithm: "sha256"` and `timestampUrl` in
  `tauri.conf.json` (or `signCommand` for a cloud signer). Delete the pfx file in the same step.
  `release-notes.mjs` flips to "signed" automatically because it reads the same secret.
- **Wire the Android signing config.** `apps/mobile/src-tauri/gen/android/app/build.gradle.kts`
  must load `rootProject.file("keystore.properties")` into a `signingConfigs.create("release")`
  (`storeFile`, `keyAlias`, `password` for both store and key) and set it on the release build
  type, as Tauri's signing guide shows. The properties file written by `android-keystore.mjs`
  carries `storeFile`, `keyAlias`, `password`, `storePassword` and `keyPassword`.
- **Turn the updater on (phase 7).** Add `@tauri-apps/plugin-updater`, set
  `plugins.updater.pubkey` and `endpoints` (the GitHub Releases `latest.json`), add the
  `createUpdaterArtifacts` bundle option, and implement steps 2 to 5 above in the desktop shell.
- **Change what the fresh install does.** Edit both scripts in the same PR; keep the step list,
  the dry-run output and the exit codes identical, and update the tests in
  `scripts/fresh-install.test.ts`. Never add a step that prompts.
- **Add a release criterion or gate column.** `scripts/gates-verify.ts` reads the tables by
  header name (`Check/Status/Command/Date/Result/CI` and `#/Criterion/Status/Evidence`); keep
  those names or extend `parseGates`.

### Release steps for 1.0 (from the Build agent manual)

1. `pnpm gates:verify` is clean and every criterion row in `docs/status/gates.md` is passed with
   command, date, result and CI link.
2. `CHANGELOG.md` has the `[1.0.0]` section; versions bumped; `docs/user-guide.md` and
   `docs/setup-guide.md` current.
3. Tag `v1.0.0`; the workflow builds the MSI, AppImage, `.deb`, APK, runner image, state service
   (same image), checksums and release notes, and pushes the image to GHCR.
4. Verify the Release page: every artefact present, `SHA256SUMS.txt` matches, signing status in
   the notes matches the secrets that existed (unsigned MSI noted when no certificate).
5. Send the release notes by the contact rule. No app store or public registry publication
   without a human go.

## Tests

- `scripts/fresh-install.test.ts`: `bash -n`, `--help`, `--dry-run` from the checkout lists all
  eight steps and runs nothing, `--with-desktop` adds the Tauri libraries, outside a checkout
  without `FORERUNNER_REPO_URL` exits 2 with the instruction and no hardcoded organisation,
  with the URL it would clone into `FORERUNNER_INSTALL_DIR`; with a stale pnpm 8.6.7 first on
  PATH (fake pnpm, corepack and npm in a fixture checkout) the pnpm step installs the
  `packageManager` version through npm, or stops at step 3 naming the copies on PATH when npm
  does not fix it (troubleshooting.md, entry 1a); `dev-postgres.sh --status` on an
  unused port exits 1; the two `.ps1` files parse with the PowerShell parser and
  `fresh-install.ps1 -DryRun -NonInteractive` exits 0 when `pwsh` exists (skipped with a visible
  reason otherwise; Windows CI runs them).
- `scripts/android-keystore.test.ts`: keytool resolution, properties escaping, decoding from the
  secret, alias override, missing password fails without echoing the secret, generation with a
  real `keytool` (skipped when none is installed) keeping the password out of stdout and
  idempotent, redaction of a keytool failure.
- `scripts/release-notes.test.ts`: changelog parsing (CRLF too), section lookup by tag,
  signing status, the body with artefact table, owner, SmartScreen note, checksums.
- `scripts/gates-verify.test.ts`: fixtures for every failure mode plus a parse of the real
  `gates.md` and `requirements.md`.
- `scripts/sync-registry.test.ts`: hashing with normalised line endings, dry run, push, guard,
  force, pull, prune, target resolution.
- `scripts/check-paths.test.ts`: comment/regex stripping, every rule and every exclusion.
- `.github/workflows/fresh-install.yml` is the timing gate itself; `release.yml` can be
  exercised with `workflow_dispatch` on a throwaway tag.

Run: `pnpm vitest run --project unit scripts`.

## Known issues

- The Windows signing step is not wired (no certificate exists); the workflow passes the
  secret through but Tauri does not read `WINDOWS_CERTIFICATE` on its own. See "How to change it".
- The updater plugin is not configured (`plugins: {}` in the desktop `tauri.conf.json`);
  staged install, health check and rollback are phase 7 work.
- `apps/mobile/src-tauri/gen/android/app/build.gradle.kts` does not yet read
  `keystore.properties`, so release APKs are not signed with the prepared key until the signing
  config is added (debug builds work).
- `release.yml` uploads `docs/user-guide.md`, which does not exist yet.
- `lint:paths` (`node scripts/check-paths.mjs`) must be added to the root `package.json` and to
  `ci.yml` to enforce the path rule; it is clean on the current tree.
- `@forerunner/platform` is not resolvable from `scripts/` (the root package has no workspace
  dependency on it), so `gates-verify.ts` and `sync-registry.ts` import it by relative path
  (`../packages/platform/src/*.ts`). Switch to the package name once the root depends on it.
- The generated Android development key is per machine until the vault stores it (BLOCKERS.md).
