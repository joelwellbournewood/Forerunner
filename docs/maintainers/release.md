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

Triggered by a pushed tag matching `v*` only (the manual `workflow_dispatch` was removed on
2026-10-25: it built the branch with the branch name as the version and had no tag to publish).

| Job | Runner | Produces | Notes |
| --- | --- | --- | --- |
| `desktop` | `ubuntu-22.04`, `windows-latest` | `bundle/msi/*.msi`, `bundle/appimage/*.AppImage`, `bundle/deb/*.deb` (`if-no-files-found: error`) | `pnpm --filter @forerunner/desktop tauri build --ci` with the signing env below; its `beforeBuildCommand` builds the UI and the bundled runtime (below), then `node scripts/runtime-payload-smoke.mjs` starts that runtime the way the shell does and fails the job unless it answers `/health` with the payload's version, `/me` with `desktopDeviceId` and `/setup`. Then the installed-app check (below) installs the built installers and starts them with `--self-test`; `publish` needs this job, so an installer that does not start is never published. Ubuntu 22.04 is the oldest supported glibc for the AppImage. Only the installers are uploaded: `bundle/appimage/` and `bundle/deb/` also hold the AppDir and the deb's staging tree (hundreds of `.so` files, icons, `copyright`), which rc.3 uploaded with `bundle/*/*` and published, so its publish job hit GitHub's secondary rate limit before the APK went up (run 40248159390). |
| `android` | `ubuntu-latest` | `apk/**/*.apk` | `android-actions/setup-android` with `packages: platform-tools` (the legacy `tools` package it installs by default is gone from the SDK repository, cb6097e), then `node scripts/android-keystore.mjs --require-secret` (the release keystore from the secrets; without `ANDROID_KEYSTORE_BASE64` the step fails and no development key is generated), then `node scripts/android-google-services.mjs` (writes `google-services.json` from `GOOGLE_SERVICES_JSON_BASE64` when set, so the APK carries FCM push; optional), then `tauri android build --apk --ci`, then `node scripts/android-apk-verify.mjs` (`apksigner verify --print-certs`; an unsigned, debug-signed or development-signed release APK fails the job before the upload) |
| `runner-image` | `ubuntu-latest` | `ghcr.io/<owner>/forerunner-runner:<version>` and `:latest` | `services/cloud-runner/Dockerfile`; the tag is the git tag without `v` |
| `publish` | `ubuntu-latest` | the GitHub Release | downloads the build artefacts by name (`desktop-*` into `artifacts/desktop-<os>/`, `android` into `artifacts/android/`; an unfiltered download also fetched docker/build-push-action's build record, which failed to download and failed rc.1's run 40229971920, so the image step also sets `DOCKER_BUILD_RECORD_UPLOAD: false`; `scripts/release-notes.test.ts` checks both), runs `node scripts/release-notes.mjs "$GITHUB_REF_NAME" > RELEASE_NOTES.md` with the job-level presence flags `ANDROID_KEYSTORE_BASE64` and `UPDATE_SIGNING_KEY` (`'present'` or empty, never the values; the same flags reach the manifest step's `release-notes.mjs` run, whose output becomes the signed manifest's notes, so both say the same; `WINDOWS_CERTIFICATE` is deliberately not passed while the Windows signing step is not wired), then, after the signed manifest, runs `node scripts/release-files.mjs artifacts` (step id `files`): it picks the `.msi`, `.AppImage`, `.deb`, `.apk` and `forerunner-release.json` under `artifacts/` (the manifest step's `find artifacts -name` picks see the same layout), fails when an installer or the APK is missing or two picked files share a name (release assets are flat), writes `artifacts/SHA256SUMS.txt` over exactly those files by the flat names they are published under (so `sha256sum -c SHA256SUMS.txt --ignore-missing` works in a download folder; never the sums file itself), and returns them plus the sums file as the `files` output. `softprops/action-gh-release` uploads `${{ steps.files.outputs.files }}`, `docs/user-guide.md` and `docs/setup-guide.md`; no glob, so nothing else under `artifacts/` can reach the release. A tag containing `-` (for example `v1.0.0-rc.1`) is published as a pre-release. |

`scripts/release-notes.mjs <tag>` prints Markdown: the `CHANGELOG.md` section for the tag
(falling back to `Unreleased` with a visible note), a table of the artefacts actually found
under `artifacts/` (or the expected kinds when run locally), the runner image name, the signing
status read from the environment (presence only, never values), and how to verify checksums.

### Signing

| What | Mechanism | Secret(s) | When the secret is missing |
| --- | --- | --- | --- |
| Update signatures (Tauri updater) | Not enabled in 1.0: the Tauri updater plugin is not installed and `bundle.createUpdaterArtifacts` is not set, so Tauri writes no `.sig` files and these secrets sign nothing. In-app updates go through the signed release manifest (next row). To enable it later: add `@tauri-apps/plugin-updater`, set `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json` and `createUpdaterArtifacts` ("How to change it") | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (generated with `pnpm --filter @forerunner/desktop tauri signer generate -w forerunner.key`; may be set ahead of the plugin) | The release notes say "unsigned (the Tauri updater is not enabled; ...)"; nothing else changes. |
| Release manifest (ADR 0015) | The publish job signs `forerunner-release.json` (artefact names, hashes, sizes, channel, notes) with `fr update sign --key-file`; the in-app updater verifies it against `update.trustedKeys` (by default the project key `26fae7f48427e5eb`, the public half of this secret; ADR 0015 amendment of 2026-10-25) before it downloads anything. The step's `if:` reads the job-level flag `HAS_UPDATE_SIGNING_KEY` (`secrets.UPDATE_SIGNING_KEY != ''`), because a step's `if:` cannot see that step's own `env:`; until 2026-10-25 it read the step's own `env.UPDATE_SIGNING_KEY`, which by GitHub's documented `if:` semantics would always have skipped it (no release had run yet to show it; `scripts/release-notes.test.ts` now checks every `if:` in the workflow against its job's and the workflow's env) | `UPDATE_SIGNING_KEY` (the file `fr update keygen --out release.key` writes; publish the printed public key for `update.trustedKeys`) | No manifest is published; the in-app updater cannot install the release; the release notes say "not signed (no `UPDATE_SIGNING_KEY`; ...)". |
| Windows installer (Authenticode) | The PFX is imported into the runner's certificate store and Tauri signs the MSI with `bundle.windows.certificateThumbprint` (or a `signCommand` for an HSM/Azure Trusted Signing setup) | `WINDOWS_CERTIFICATE` (base64 PFX), `WINDOWS_CERTIFICATE_PASSWORD` | The MSI is unsigned; SmartScreen warns at install; `release-notes.mjs` prints "unsigned (no certificate provided)" and a SmartScreen note. This is the state of 1.0 unless a certificate arrives (`docs/status/BLOCKERS.md`). |
| Android APK | `apps/mobile/src-tauri/gen/android/app/build.gradle.kts` loads `rootProject.file("keystore.properties")` (the Android project root, `gen/android`, where `scripts/android-keystore.mjs` writes it) into `signingConfigs.create("release")` (`storeFile` resolved against that root, `keyAlias`, `storePassword`, `keyPassword`) and sets it on the `release` build type; a key missing from the file fails the configuration naming it. Without the file the build still configures, Gradle warns, and the release APK is left unsigned (`-unsigned.apk`, not installable); the `debug` build type keeps the SDK's debug key as generated. Before the build, `scripts/android-keystore.mjs` decodes the secret and checks with `keytool -list -storepass:env` that it opens with the password and holds the alias, so a wrong secret, password or alias fails the step in a second (Gradle would find it at the end of the build); the properties file is written as `Properties.store` would (ISO-8859-1, `\uXXXX` for anything else), because Gradle reads it with `Properties.load(InputStream)`, so the password may hold any character. After the build, `scripts/android-apk-verify.mjs` runs `apksigner verify --verbose --print-certs` on every release APK and fails the job when one is unsigned, names no signer, carries the `CN=Android Debug` certificate, or carries the build-generated development key (`CN=Forerunner development key`) without `--allow-development-key`; the signer DN and SHA-256 land in the job log for the human to compare with the key they hold. | `ANDROID_KEYSTORE_BASE64` (the PKCS12/JKS keystore, base64), `ANDROID_KEYSTORE_PASSWORD` (store and key password; alias `forerunner`, override with `ANDROID_KEYSTORE_ALIAS`) | Two workflows, two answers (ADR 0015, amendment of 2026-10-25). `release.yml` (a `v*` tag or a dispatch) runs the keystore script with `--require-secret` and fails before the build: a release never ships a development-signed APK, which nobody could verify against a held key and no later release could update (Android refuses an update signed by another key, and the generated key is thrown away with the runner). `android.yml` (pull requests, pushes, fork PRs whose secrets are empty) lets the script generate a development keystore with `keytool` (JDK from `JAVA_HOME` or `PATH`), a random password that is written only to the gitignored `keystore.properties`, and a NOTE; its verify step passes `--allow-development-key`. That APK installs by sideloading but is not for distribution; the generated key is kept in the vault for a stable identity across builds once the vault export exists (BLOCKERS.md). |
| Android FCM push config (ADR 0085 point 9) | Not a signature, but a build secret handled the same way. `scripts/android-google-services.mjs` (in `android.yml` and `release.yml`, before the build) decodes the secret, checks that it is a Firebase config with an Android client for `app.forerunner.mobile` (a wrong secret fails the step) and writes `gen/android/app/google-services.json` (mode 0600, gitignored, never committed; `pnpm secrets:scan` flags a Google API key shape). `build.gradle.kts` adds `firebase-messaging`, the `src/fcm` sources and the Google services plugin only when the file exists (`apps.md`, "Push"). | `GOOGLE_SERVICES_JSON_BASE64` (`base64 -w0 google-services.json`, the file the Firebase console downloads for the Android app) | Optional in both workflows: nothing is written, the build log says `google-services.json not found`, and the APK ships the polling stand-in (in-app notices while the app is open). |
| Checksums | `SHA256SUMS.txt` over the published artefacts and the manifest, by their published names (`scripts/release-files.mjs`) | none | always produced |

`scripts/android-keystore.mjs [--android-dir <dir>] [--require-secret]` is pure Node: paths
through `node:path`, `keytool` started with an argv array (no shell) and the password passed
through `-storepass:env` so it never appears in a process listing; stdout never contains a
secret; a keytool failure is reported with the password redacted. With the secret it writes the
keystore, runs `keytool -list -keystore <file> -alias <alias> -storepass:env` and, when that
fails, removes the keystore, writes no properties file and exits 1 with keytool's reason
("keystore password was incorrect", "Alias <x> does not exist", "Unrecognized keystore
format"); only then does it write `keystore.properties`. `--require-secret` makes a missing
`ANDROID_KEYSTORE_BASE64` an error instead of a generated key (the release workflow). Without
the flag and the secret it generates the development key, or keeps an existing keystore with
its properties file (a generated one, or the release key of an earlier run with the secret on
the same checkout; delete both files to regenerate). `escapeProperty` writes values the way
`java.util.Properties.store` does: `\\`, `\t` `\n` `\r` `\f`, a leading space as `\ `, and
every UTF-16 unit outside printable ASCII as `\uXXXX`, so a password with an umlaut reaches
Gradle intact (`Properties.load(InputStream)` reads ISO-8859-1, not UTF-8). The generated key's
DN is `CN=Forerunner development key, O=Forerunner, C=CH` (`DEVELOPMENT_CERT_CN`, exported for
the verifier).

`scripts/android-apk-verify.mjs [--apk-root <dir>] [--apksigner <path>] [--allow-debug]
[--allow-development-key]` is the signature check both workflows run right after the Android
build and before the artefact upload. It walks `gen/android/app/build/outputs/apk` for every
`*.apk` under a `release` directory (the emulator smoke's debug APKs are not its business),
finds `apksigner` in the newest `build-tools` under `ANDROID_HOME` or `ANDROID_SDK_ROOT` (else on
`PATH`; `apksigner.bat` on Windows), runs `verify --verbose --print-certs` with an argv array
and no shell, and exits 1 with apksigner's reason when no release APK exists, one does not
verify, apksigner names no signer, the signer is the SDK's debug certificate (`--allow-debug`
lifts only that rule, for a local check), or the signer is the build-generated development key
(`--allow-development-key` lifts only that one; `android.yml` passes it, `release.yml` never
does, so a release key must not carry the development DN). The output is the certificate's DN
and SHA-256, nothing secret. Tauri regenerates only `tauri.build.gradle.kts` and
`tauri.properties` on each build (`gen/android/.gitignore`); `build.gradle.kts` is committed
and keeps the signing config.

### Versions and the changelog

`CHANGELOG.md` follows Keep a Changelog. Every release needs a `## [X.Y.Z] - YYYY-MM-DD`
section; entries accumulate under `## [Unreleased]` while work lands. The version lives in the
root `package.json`, `apps/desktop/src-tauri/tauri.conf.json` (`version`, shown in the MSI and
AppImage metadata), `apps/mobile/src-tauri/tauri.conf.json` and the Cargo manifests of the two
shells; keep them equal to the tag. `node scripts/release-version.mjs --check` says whether they
agree; `--set <tag>` writes them (and `bundle.windows.wix.version` of the desktop config, the
numeric core, because WiX takes numbers only). The version is committed: run
`--set <version>` in the commit you tag (a pre-release: `1.0.0-rc.2` everywhere, `1.0.0` in the
MSI). Every build job of `release.yml` runs `--check --expect "$GITHUB_REF_NAME"` (in bash; the
Windows runner's default shell is pwsh) before it builds and fails when the tagged commit carries
another version, because the daemon runs from the checkout and would report it. The daemon,
`fr` and the cloud runner read the root `package.json` (`packages/runtime/src/version.ts`,
`APP_VERSION`, "0.0.0" when it is missing); `FORERUNNER_VERSION` overrides it.
`scripts/release-version.test.ts` checks the files agree, `APP_VERSION` is theirs, and the
workflow checks before both builds. Known issue: a Debian package ranks `1.0.0-rc.2` above
`1.0.0` (dpkg reads `rc.2` as a revision) and Android gives both the versionCode 1000000, so a
sideloaded `.deb` or APK of the final release is not offered over a release candidate by the OS
package manager; uninstall the candidate first (the in-app updater compares by the manifest and
is not affected).

### Staged install, health check, rollback (module M, phase 7)

The contract as first planned around the Tauri updater plugin. ADR 0015 replaced the plugin
with the pointer-file install layout and an Ed25519-signed release manifest: the updater is
`packages/runtime/src/update/` (`updates.md`), and the desktop shell's launcher
(`apps/desktop/src-tauri/src/install.rs`, `current.json`) and restart supervisor
(`restart.rs`) apply it. The steps below keep the behaviour (stage, verify, swap, health check,
rollback); `updates.md` is the current description of how each is done.

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
rollback (passing, `docs/status/gates.md`). A human can still roll back by hand by installing
the previous release from GitHub Releases over the current one; data directories are untouched.

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

### The bundled runtime (ADR 0092)

Every installer carries the runtime, so a new user installs one file and the app starts its own
daemon: no git, pnpm, PowerShell or Node.js on the machine. `tauri.conf.json`'s
`beforeBuildCommand` runs `pnpm -w run runtime:payload` (`scripts/build-runtime-payload.mjs`)
after the UI build; it writes `apps/desktop/src-tauri/runtime/` (gitignored), which
`bundle.resources` ships as `<resources>/runtime/` (`C:\Program Files\Forerunner\runtime`,
`/usr/lib/Forerunner/runtime`, inside the AppImage). The builder:

1. `pnpm --filter @forerunner/runtime deploy --prod --config.inject-workspace-packages=true
   --config.node-linker=hoisted` (the shared lockfile's versions; `--legacy` would resolve the
   ranges afresh) into a fresh directory beside the repository, outside the workspace (a target
   inside it makes pnpm link a stray `packages/runtime/<target>/node_modules/.bin`) and on the
   same drive (on Windows a target on another drive is glued onto the workspace path), and
   moves its flat `node_modules` in;
2. drops `node_modules/.*`, `node_modules/@forerunner`, symbolic links, `*.d.ts`, `*.d.mts`,
   `*.d.cts`, `*.map`, `*.tsbuildinfo`, and native packages for another OS, CPU or libc
   (`isForeignPlatformPackage`: the musl builds on Linux; the Agent SDK's alone is 280 MB);
3. copies the sources of `@forerunner/runtime` and the workspace packages it imports (by
   `workspace:` dependencies, transitively; no `test/`, `scripts/` or `node_modules/`) into
   `packages/<name>/`, `evals/registry/`, and a root `package.json` with the app version;
4. writes `tsconfig.json` with a `paths` entry per export of each shipped package
   (`workspacePaths`; tsx resolves `@forerunner/*` through it, so the packages load once);
5. copies the Node binary that runs the builder (`--node <path>` for another) to
   `node/node[.exe]` and checks it runs;
6. writes `runtime.json` (`schema`, `version`, `platform`, `arch`, `node`, `entry`) last; the
   shell reads its version, and the runtime takes it as the sign that it runs from an install
   (the registry then lives in `<data>/registry`, seeded from the bundle at every start;
   `adding-a-specialist.md`).

The result on Linux x64 (1.0.0 sources, Node 22.22): 6,535 files, 471 MiB, most of it the
Agent SDK's native `claude` (280 MB) and Node (118 MB); the `.deb` is 196 MiB. The payload is
built per runner, so each installer carries its own OS's binaries. `pnpm runtime:payload --out
<dir>` builds one anywhere for a look; `node scripts/runtime-payload-smoke.mjs [dir]` starts it.

### Installed-app check (ADR 0092, amendment of 2026-10-30)

1.0.1's MSI passed every check and still never started once installed into
`D:\AGENT\Forerunner`: Tauri's verbatim `\\?\D:\...` resource path reached Node. The payload
smoke test never goes through `resource_dir()`, so the installed app itself is now started
before a release.

`scripts/installed-check.ps1 -Msi <msi>` (windows-latest) installs the MSI with `msiexec /qn`
into each of these places:
- the default `Program Files` folder;
- `D:\AGENT\Forerunner`;
- `D:\My Apps\Forerünner Ä`;
- a path of about 100 characters (with the runtime's deepest file it stays under the
  260-character limit Windows Installer works within);
- `D:\AGENT\Forerunner` started through `\\localhost\D$\...` (counts only when the admin
  share is reachable).

For each place it denies the user write access to the folder (`icacls /deny`), runs
`<exe> --self-test --report <json>` with `FORERUNNER_HOME` on C:, prints the report, and
uninstalls. `scripts/installed-check.sh <deb> <AppImage>` (ubuntu-22.04) installs the `.deb` and
runs `/usr/bin/forerunner-desktop --self-test` as the runner user (`/usr/lib/Forerunner` is
read-only for it), then runs the AppImage from `My Apps/Forerünner Ä` with
`APPIMAGE_EXTRACT_AND_RUN=1`. Both scripts write a line per case to the job summary and exit 1
when a required case fails. `desktop.yml` and `release.yml` run them right after the payload
smoke test.

### Fresh install scripts (gate: "fresh install in under 15 minutes")

These are for developers and for the CI timing gate. A user installs the MSI, AppImage or
`.deb`, which carry everything (above).


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

### The API build workflow (`.github/workflows/build-item.yml`)

`build-item.yml` (added by the maintainer on 2026-10-23) runs one bounded build, review or fix
of a Forerunner item on a hosted runner through `anthropics/claude-code-action`, billed to the
repository's `ANTHROPIC_API_KEY` secret (with `ANTHROPIC_WORKSPACE_ID` as a repository variable
for a user-scoped key) instead of a Claude Code plan. It is dispatched by hand with the item id,
the stage (`build`, `review` or `fix`), the full prompt for that stage, the base branch a new
`wave/<item>` branch starts from (the default is the integration branch of the day; change it
when that branch moves), the model, a USD spend cap and a turn cap; it checks out or creates
`wave/<item>`, installs dependencies (and the Tauri Linux libraries and Rust when `rust` is
set), runs the stage with a prefix-allowlisted tool set, and pushes the branch when the run
ends, committing anything left uncommitted as a `wip:` snapshot that is marked not verified. It
never touches the release branch; the integration session merges `wave/<item>` after the item's
review file under `docs/status/reviews/` says `accept` or its findings are fixed. The stage
prompts and the item briefs it was run with are kept on the `build-briefs` branch.

### Other operational scripts

| Script | Used by | Does |
| --- | --- | --- |
| `scripts/dev-postgres.sh` / `.ps1` | developers, `AGENTS.md` | starts Postgres for the integration tests: a server already answering on 5432 is reused, else Docker container `forerunner-pg` (`postgres:16`), else the local service/cluster (`pg_ctlcluster`, `systemctl`, the `postgresql*` Windows service, `pg_ctl` with `PGDATA`); creates `forerunner_test`, sets the password, prints the `FORERUNNER_TEST_PG` line to export. `--status`, `--stop`. |
| `scripts/gates-verify.ts` (`pnpm gates:verify`) | the build loop, CI (to be added to `check`) | parses `docs/status/gates.md` and `docs/requirements.md`; prints every gate with its evidence state; exits 1 when a passed check lacks command, date, result or CI link, a passed release criterion lacks a command, date and CI link, a criterion is passed while a requirement is not done, or a requirement is done without a test path |
| `scripts/sync-registry.ts` | registry maintainers | dry run by default: diff of `evals/registry/` against `FORERUNNER_REGISTRY_DIR` (or the sibling `../forerunner-registry`); `--apply` copies, `--pull` reverses the direction, `--prune` deletes target-only files, `--force` overrides the guard that refuses to overwrite a registry edited since the hash recorded in `evals/registry/.sync.json`. No network. |
| `scripts/handover-live.ts` | the human, for V.8 (from a launcher that loads `.env.build`) | the live handover run on a dedicated install: `--profile <name> --repo <owner/name> [--budget-usd <usd>] [--dry-run]`, with `FORERUNNER_HOME` pointing at a directory of its own. It runs the non-interactive setup, connects the repository as a source and accepts it into a project (reused on reruns), enables `settings.handover`, sets autonomy 2, and runs `fr jobs handover --force`. It opens real pull requests: the doc set scaffold when the repository lacks it, and the handover PR. The last line is `HANDOVER RESULT: <status>`, and the exit is 0 only for `passed`. See `testing.md` "Live handover run (V.8)". |
| `scripts/check-paths.mjs` | CI as `pnpm lint:paths` | fails on hand-built paths outside `packages/platform`: string concatenation with `/` or `\\` next to a path-like identifier, and `node:path` imports. `// path-ok <why>` skips a line. |
| `scripts/release-notes.mjs`, `scripts/release-files.mjs`, `scripts/android-keystore.mjs`, `scripts/android-apk-verify.mjs` | `release.yml`, `android.yml` | see above |
| `scripts/docs-check.mjs`, `secret-scan.mjs`, `link-check.mjs` | `ci.yml` | docs stay true, credential shapes, Markdown links (see `testing.md`) |

## How to change it

- **Cut a release.** Move the `Unreleased` entries into a `## [X.Y.Z] - date` section, bump
  the versions listed above, merge, then `git tag vX.Y.Z && git push origin vX.Y.Z`. Watch the
  four jobs; the Release appears as a draft-free release (pre-release when the tag has a `-`).
- **Add or drop an artefact.** `bundle.targets` in the desktop `tauri.conf.json`, the
  `upload-artifact` paths in `release.yml` (the file pattern, never a whole bundle directory),
  `REQUIRED_EXTENSIONS` in `scripts/release-files.mjs` (or nothing is published for it), the
  expected lists in `scripts/release-notes.test.ts` and `scripts/release-files.test.ts`, and
  `kindOf()` in `scripts/release-notes.mjs` so the table names it.
- **Wire the Windows certificate when it arrives.** Add a `windows-latest` step before the
  build that decodes `WINDOWS_CERTIFICATE` to a `.pfx`, imports it
  (`Import-PfxCertificate -CertStoreLocation Cert:\CurrentUser\My`), and set
  `bundle.windows.certificateThumbprint`, `digestAlgorithm: "sha256"` and `timestampUrl` in
  `tauri.conf.json` (or `signCommand` for a cloud signer). Delete the pfx file in the same step.
  Then add `WINDOWS_CERTIFICATE` to the env of the publish job's "Checksums and release notes"
  step so `release-notes.mjs` reports "signed"; it is left out until the signing step exists, so
  the notes never call an unsigned MSI signed.
- **Provide or rotate the Firebase config (FCM push).** In the Firebase console, Project
  settings, the Android app `app.forerunner.mobile`, download `google-services.json`; store
  `base64 -w0 google-services.json` as the Actions secret `GOOGLE_SERVICES_JSON_BASE64` and
  delete the local copy (it is a build secret; never commit it). The next run's
  `android-google-services` step prints the project id and package, and the Gradle log says
  `google-services.json found: FCM push is built in`. Removing the secret returns the next APK
  to the polling stand-in. The sending side (the service account behind
  `FORERUNNER_FCM_SERVICE_ACCOUNT_REF` on the state service) is in `state-service.md`.
- **Provide or rotate the Android release key.** Create the keystore once
  (`keytool -genkeypair -keystore forerunner.jks -alias forerunner -keyalg RSA -keysize 2048
  -validity 10000 -storetype PKCS12`), store `base64 -w0 forerunner.jks` as
  `ANDROID_KEYSTORE_BASE64` and the password as `ANDROID_KEYSTORE_PASSWORD` (plus
  `ANDROID_KEYSTORE_ALIAS` when the alias is not `forerunner`); keep the file in the vault,
  never in git. The password may hold any character (the properties file escapes it); the store
  and the key password must be the same value, and the key's DN must not be the development
  key's (`CN=Forerunner development key`), which the release verify step refuses. A wrong
  secret, password or alias fails the keystore step of the next run within seconds, with
  keytool's reason and nothing left on the runner; until the secrets exist, a `v*` tag fails
  at that step by design (`--require-secret`), so a release needs them even when only the
  desktop builds matter. The next run's verify step prints the signer DN and SHA-256: compare
  them with `keytool -list -v -keystore forerunner.jks`. A rotated key changes the signer, so
  phones with the old key installed must uninstall first (Android refuses an update signed by
  another key); say so in the release notes. The properties file written by
  `android-keystore.mjs` carries `storeFile`, `keyAlias`, `password`, `storePassword` and
  `keyPassword`; the Gradle file reads `storeFile`, `keyAlias`, `storePassword` and
  `keyPassword` through `keystoreProperty(name)`, so a new key name is added in both places and
  asserted in `scripts/android-keystore.test.ts`.
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

- `scripts/build-runtime-payload.test.ts` (ADR 0092): `paths` for every export of every shipped
  package, a string or missing export as the package root, the workspace closure through the
  import cycles (testenv left out), an unknown package refused, foreign-platform packages
  (musl, another OS or CPU) dropped while the target's and ordinary packages stay, declarations
  and maps pruned and code kept, the node name per OS and the CLI entry. The payload itself is
  started by `scripts/runtime-payload-smoke.mjs` in `desktop.yml` and `release.yml` after every
  `tauri build`, on Windows and Linux.
- `scripts/fresh-install.test.ts`: `bash -n`, `--help`, `--dry-run` from the checkout lists all
  eight steps and runs nothing, `--with-desktop` adds the Tauri libraries, outside a checkout
  without `FORERUNNER_REPO_URL` exits 2 with the instruction and no hardcoded organisation,
  with the URL it would clone into `FORERUNNER_INSTALL_DIR`; `dev-postgres.sh --status` on an
  unused port exits 1; the two `.ps1` files parse with the PowerShell parser and
  `fresh-install.ps1 -DryRun -NonInteractive` exits 0 when `pwsh` exists (skipped with a visible
  reason otherwise; Windows CI runs them).
- `scripts/android-google-services.test.ts`: the secret decoded, checked and written mode
  0600 with only the project id and package printed; nothing written without it (an empty
  secret counts as unset) and a hand-placed file kept; not-JSON, no project id and a foreign
  package refused without quoting the content; the Gradle gating, no Firebase in the main
  source set, the gitignore entries, and both workflows running the step before the build.
- `scripts/android-keystore.test.ts`: keytool resolution, properties escaping (specials, and
  `\uXXXX` plus `\t` `\n` `\r` `\f` for what `Properties.load` cannot read as UTF-8, the file
  pure ASCII), decoding from the secret with the `keytool -list` check's argv, environment and
  no shell, alias override reaching the check, a rejected keystore failing with the redacted
  reason and leaving no file, a missing keytool explained, missing password fails without
  echoing the secret, `requireSecret` refusing the generated and the kept key but not the
  secret; generation with a real `keytool` (skipped when none is installed) keeping the
  password out of stdout, idempotent with the "existing keystore" wording, and the generated
  key fed back through the secret path passing the real check while a wrong password and a
  wrong alias fail it; redaction of a keytool failure and the development DN in the dname; then
  the Gradle file: it loads `keystore.properties` from the Android project root guarded by its
  existence, declares the `release` signing config from exactly the keys the script writes with
  the store file resolved against that root and a missing key failing by name, sets it on the
  release build type and warns when the file is absent, keeps the Tauri-generated content and
  the debug build type as generated, and carries no password or store path; and both
  workflows: keystore step, then the build, then the unconditional `android-apk-verify.mjs`
  step, then the artefact upload, with `build-tools;34.0.0` installed and every
  `setup-android` step naming `packages: platform-tools`; `release.yml` with `--require-secret`
  and no `--allow-development-key`, `android.yml` the other way round, `--allow-debug` in
  neither. (No Android SDK or Gradle exists on the build box, so the Kotlin DSL is asserted
  textually and compiled by the Android workflow.)
- `scripts/android-apk-verify.test.ts`: build-tools version order, apksigner resolution
  (`ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `PATH`; `.bat` on Windows), release APKs found
  and debug ones left alone, apksigner output parsing (schemes, signers, `DOES NOT VERIFY`, the
  V2/V3 signer lines of an APK without a v1 signature), and the run against a fake apksigner:
  argv array without a shell and the signer reported, no release APK fails, an unsigned APK
  fails with apksigner's reason, the debug certificate fails unless `--allow-debug`, the
  development key fails unless `--allow-development-key` (the debug key still refused with it,
  a release key passing without any flag), a signer-less exit 0 fails, every APK is checked, a
  missing apksigner is explained.
- `scripts/release-notes.test.ts`: changelog parsing (CRLF too), section lookup by tag,
  signing status (the release manifest line from `UPDATE_SIGNING_KEY`, presence only), the body
  with artefact table, owner, SmartScreen note, checksums; and three checks of `release.yml`:
  every step `if:` reads only names its job or the workflow declares; the manifest step runs on
  `HAS_UPDATE_SIGNING_KEY` and signs with the key from its own env; both `release-notes.mjs` runs
  see the presence-only `ANDROID_KEYSTORE_BASE64` and `UPDATE_SIGNING_KEY` flags and never
  `WINDOWS_CERTIFICATE`; the desktop upload names only `*.msi`, `*.AppImage` and `*.deb` and
  fails without files; the release step's `files:` is the `files` output plus the two docs,
  with no glob; the sums step runs `release-files.mjs` after the manifest; the manifest step's
  `find artifacts` picks are intact.
- `scripts/release-files.test.ts`: over a downloaded layout carrying rc.3's bundle debris (an
  AppDir with a `.so` and icons, the deb staging tree with `copyright`, a stale sums file) it
  picks only the three installers, the APK and the manifest; no manifest without a key; a
  missing installer or APK fails; a duplicate name fails; the sums by published name, never
  the sums file; the `files` output written to `GITHUB_OUTPUT` matches the returned list.
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
- `@forerunner/platform` is not resolvable from `scripts/` (the root package has no workspace
  dependency on it), so `gates-verify.ts` and `sync-registry.ts` import it by relative path
  (`../packages/platform/src/*.ts`). Switch to the package name once the root depends on it.
- The generated Android development key is per machine until the vault stores it (BLOCKERS.md).
