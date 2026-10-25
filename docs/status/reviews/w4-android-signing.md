# w4-android-signing

Item: triage P0 #1, the Android release APK is signed by Gradle from `keystore.properties`
(written by `scripts/android-keystore.mjs` from `ANDROID_KEYSTORE_BASE64` /
`ANDROID_KEYSTORE_PASSWORD`, or a generated development key) and both workflows run
`scripts/android-apk-verify.mjs` (`apksigner verify --print-certs`) before the upload (R.1, M.3).
Built on `wave/w4-android-signing` (dd0d432, 345209e), merged in ea86d48 without a review,
touched later by 82a6295 (the verifier reads the V2/V3 signer lines). Reviewed on 2026-10-25
as it stands on the integration branch `ccr-af5a431d-jc9xqj` (60689f2), with the two passing
Android runs of the day (40182115934, 40183122342; both signed with the generated key).

## Review

Verdict: **revise**. Score: 60/100.

What the brief asked for is there and works: the Gradle file reads exactly the keys the script
writes, the release build type is signed when the file exists and left unsigned with a warning
when it is not, both workflows run the verifier between the build and the upload, the verifier
fails an unsigned APK, a debug-signed one and a signer-less exit, and the docs name the
secrets. The CI log of run 40183122342 shows the whole path (`android-keystore: development
keystore generated`, `android-apk-verify: ... verified (schemes v2)`, `signer #1 CN=Forerunner
development key`). The findings are about the release tag's path, which the item never ran.

No `apksigner` exists on this machine: the verifier's parsing was checked against the lines
the CI log printed and the fixtures 82a6295 took from a real run, not against a live run. A JDK
(keytool 21) and Gradle exist here; the Kotlin DSL was not compiled (no Android SDK), it is
compiled by the Android workflow and the two runs prove it.

### Findings

1. **high** — `.github/workflows/release.yml:85-91`. A `v*` tag with no `ANDROID_KEYSTORE_BASE64`
   secret builds the APK with the generated development key and publishes it. The keystore step
   prints a NOTE and exits 0 (`scripts/android-keystore.mjs:112-178`, the generated branch
   returns normally), the verifier refuses only the SDK's debug certificate
   (`scripts/android-apk-verify.mjs:161-166`, `DEBUG_CERT_CN`), and `publish` needs nothing
   more than a green `android` job. A development-signed APK on a GitHub Release is one nobody
   can verify against a held key and that no later release can update (Android refuses an
   update signed by another key; the key is regenerated per build and thrown away). Verified:
   the code paths above, and run 40183122342's log, which is exactly this path passing
   (`ANDROID_KEYSTORE_BASE64:` empty, `signer #1 CN=Forerunner development key`); `release.yml`
   differs from `android.yml` only in the build's targets. Smallest fix: the keystore script
   takes `--require-secret` and fails before the build when the secret is empty; the verifier
   refuses a signer with the development key's DN (`CN=Forerunner development key`, the dname
   the script generates) unless `--allow-development-key`, which only `android.yml` passes;
   `release.yml` uses both without the flag; `release.md` and an ADR 0015 amendment say so.
2. **medium** — `scripts/android-keystore.mjs:49-51` (`escapeProperty`) and `propertiesText`.
   The properties file is written in UTF-8, but Gradle loads it with
   `Properties.load(InputStream)`, which reads ISO-8859-1: a password with a non-ASCII
   character (an umlaut; the maintainer is in CH) or a control character is read as other
   characters, and the release build fails at signing with "keystore password was incorrect"
   some ten minutes in, after the Rust build. Verified with the local JDK: a file holding
   `password=pä` (UTF-8 bytes) loads as 5 characters and is not equal to `pä`; `pä` loads
   right. Smallest fix: `escapeProperty` writes every character outside printable ASCII as
   `\uXXXX` and `\n`, `\r`, `\t`, `\f` as their escapes, what `Properties.store` does.
3. **medium** — `scripts/android-keystore.mjs:97-113`. In secret mode the script writes
   whatever the secret decodes to and checks nothing: a wrong `ANDROID_KEYSTORE_PASSWORD`, a
   wrong alias, or a secret that is not the base64 of a keystore (`Buffer.from(x, "base64")`
   skips invalid characters, so only the 32-byte floor stands between a pasted password and the
   build) each fail inside Gradle at the end of the build. Verified with the local JDK that
   `keytool -list -keystore <file> -alias <alias> -storepass:env VAR` reports each case in under
   a second with exit 1 ("Alias <x> does not exist", "keystore password was incorrect",
   "Unrecognized keystore format") and never prints the password; keytool is already what the
   script runs for the generated key and both workflows set up a JDK before the step. Smallest
   fix: after decoding, run that check with an argv array; on failure remove the keystore, write
   no properties file and throw the redacted reason.
4. **medium** — `.github/workflows/release.yml:76`. `android-actions/setup-android@v3` with its
   default `packages` installs the legacy `tools` package the SDK repository no longer carries;
   `android.yml` was fixed in cb6097e on 2026-10-20 ("The first dispatch of the Android workflow
   failed in the SDK setup action, which installs the legacy 'tools' package by default") but
   the item added its two steps to `release.yml` without porting that line, so the release
   workflow's `android` job most likely fails before the keystore step and no tag can publish an
   APK at all. Inferred from cb6097e and the action's default, not reproduced: `release.yml` has
   never run (BLOCKERS "Android keystore" row names "a `release.yml` run" as the next step).
   Smallest fix: `with: packages: platform-tools` as in `android.yml`, and a test that every
   `setup-android` step in both workflows names its packages.
5. **low** — `scripts/android-keystore.mjs:120-126`. With both files present and no secret the
   script logs "keeping the existing development keystore" and the development NOTE; after an
   earlier run with the secret on the same checkout the kept key is the release key. A local
   path only (CI checkouts are fresh). Verified by reading the branch. Smallest fix: the wording
   ("keeping the existing keystore ...: a generated development key, or the release key of an
   earlier run with the secret").
6. **low** — `docs/maintainers/release.md:29,44`. The Signing table says that without the secret
   "the release APK is then signed with that key (`CN=Forerunner development key`, so the verify
   step passes)" for both workflows, and the `android` job row of the release workflow table
   says the same; after finding 1 the release workflow refuses, and the doc must say which
   workflow does what. Fix with finding 1.

### Checked and found sound

- `keystore.properties` is ignored by `gen/android/.gitignore`, `*.jks` by the root
  `.gitignore`; `git ls-files gen/android` lists neither; both upload paths are `apk/**/*.apk`
  and the Rust cache covers `target/` only. No key material reaches git, an artefact or a cache.
- Logs: the keystore step's `env:` lines are masked by Actions; the script prints paths, the
  alias and the byte count; a keytool failure is redacted (test); the verifier prints the DN
  and the SHA-256, nothing else. The Gradle `error(...)` names the missing key, not a value.
- The verifier: an unsigned APK (apksigner exit 1) fails; the debug certificate fails (the test
  caught a mutation that removed the check); a signer-less exit 0 fails; every release APK is
  checked; `debug` directories are skipped, so the emulator's `--debug` build (e2e/run.mjs) is
  not touched; `--allow-debug` is passed by neither workflow.
- The workflow test caught a mutation that added `continue-on-error: true` to the release
  verify step; the upload comes after the verification in both files.
- A fork PR (empty secrets) takes the generated-key path and passes `android.yml`, as intended;
  `ANDROID_KEYSTORE_BASE64` without a password throws without echoing the secret (test); a
  leftover `keystore.jks` without its properties file is regenerated; secret mode overwrites both.
- The Gradle file: `rootProject.file("keystore.properties")` is `gen/android`, where the script
  writes; `storeFile` is an absolute path, so `rootProject.file(...)` keeps it; a missing key
  fails the configuration by name; the debug build type is as generated; the Tauri content is
  kept (`tauri.build.gradle.kts` and `tauri.properties` are the regenerated files).
- The signed-update manifest (ADR 0015): `parseArtifactSpec` hashes the file it is given and
  names it by basename; `action-gh-release` uploads `artifacts/**/*` by basename, so the
  manifest's android `url` and `sha256` match the uploaded APK. One universal APK is built
  (no `--target`, no split), so `pick '*.apk'` is unambiguous today.
- Nothing is hardcoded to an org, account or user path; the generated DN names the product.
- The brief's clauses: the Gradle signing config, the extended keystore test, the verifier
  in both workflows, release.md and apps.md (the Known issues entries closed, the secrets
  documented): all present.
