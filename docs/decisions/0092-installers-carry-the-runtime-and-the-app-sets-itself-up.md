# 0092 — Installers carry the runtime; the app sets itself up

Date: 2026-10-30
Status: accepted (amends ADR 0026 "Daemon lifecycle")

## Context

ADR 0026 left the Node runtime out of the desktop shell: "the fresh install installs Node 22 and
the repository; `fr daemon` is the runtime process", and the shell found it through
`FORERUNNER_INSTALL_DIR`, the install record `fr setup` writes, or `fr` on `PATH`. So the 1.0.0
MSI (4.2 MiB), AppImage and `.deb` held the window and the tray only. A new user who installed
the MSI had no daemon unless they also cloned the repository, opened PowerShell and ran
`scripts/fresh-install.ps1`. The setup guide never said so.

The first real user did that with a ZIP of the repository's default branch, which was four days
and 722 commits behind the release. The install record named that checkout, so the 1.0.0 shell
started a 0.1.0 daemon. The shell attached to whatever answered `/health`, and the 1.0.0 UI broke
on the old `/me` answer ("desktopDeviceId: expected string, received undefined"). The Updates
page said "running 0.1.0, up to date". Credentials could only be entered through `fr setup` in a
terminal. The guide said "the first start opens the setup wizard", which was true only for the
CLI.

The human's instruction (2026-10-29): a new user installs Forerunner without PowerShell, pastes
the keys into the app, and everything is up to date.

## Decision

1. **The installers carry the runtime.** `scripts/build-runtime-payload.mjs`
   (`pnpm runtime:payload`, run by `tauri.conf.json`'s `beforeBuildCommand`) writes
   `apps/desktop/src-tauri/runtime/`, which `bundle.resources` ships as `<resources>/runtime/`.
   The folder holds:
   - the Node.js binary that built it (`node/node[.exe]`);
   - the TypeScript sources of `@forerunner/runtime` and the nine workspace packages it imports,
     laid out as in the repository, without tests;
   - `evals/registry/`;
   - the root `package.json` (the app version);
   - a flat production `node_modules` from `pnpm deploy --prod --legacy` with
     `node-linker=hoisted`, made outside the workspace;
   - a `tsconfig.json` whose `paths` map every `@forerunner/*` import, generated from each
     package's `exports`;
   - `runtime.json` (`schema`, `version`, `platform`, `arch`, `node`, `entry`).

   `tsx` is now a dependency of the runtime, because it is what runs it. The builder:
   - removes type declarations, source maps, symbolic links and native packages built for
     another OS, CPU or libc (the musl build of the Agent SDK alone is 280 MB);
   - does not ship `node_modules/@forerunner`: an installer cannot carry symlinks, and copies
     there would load `@forerunner/runtime` twice through the packages that import it back.

   It is still the same code as `pnpm fr`, laid out the same way. The CLI resolves its version,
   catalog, registry and voice helpers relative to its own files, so they work unchanged. A
   development build has no payload: `build.rs` creates an empty `runtime/` so the resource entry
   stays valid.
2. **The shell prefers the bundled runtime** (`install.rs`). The lookup order is:
   1. the staged update, unless it is older than the bundle (an installer run over an older
      in-app update);
   2. `FORERUNNER_INSTALL_DIR`;
   3. the bundled runtime, on its own Node, with `TSX_TSCONFIG_PATH`;
   4. the install record;
   5. `fr` on `PATH`.

   A staged version without its own `node/` runs on the bundled one. The bundle comes before the
   install record, so an old checkout never runs in place of what the installer brought.
3. **An outdated daemon is replaced** (`daemon::outdated_reason`, `supervisor::stop_process`).
   When the healthy daemon the shell would attach to reports a version older than the bundle, or
   none, the shell ends it and starts the bundled runtime. On Windows it uses
   `taskkill /PID <pid> /T /F`; elsewhere `kill -TERM <pid>`; both are argv arrays. The shell then
   waits until `/health` stops answering. If the daemon cannot be stopped, a dialog says so and
   the shell attaches anyway. A newer daemon (a staged update, a developer's checkout) is kept.
   Without a bundle nothing is replaced, as before. This is the one exception to "the shell never
   kills the daemon".
4. **The app sets itself up** (`packages/runtime/src/setup/routes.ts`, `apps/ui/src/pages/SetupPage.tsx`).
   The daemon serves `GET /setup` and `POST /setup/{profile,anthropic,github,finish}`.
   - Each credential goes through `runSetup`, the same validators and vault writes as `fr setup`.
     The routes pass `installRecord: false`.
   - The environment's credential variables are ignored, so only the pasted value counts.
   - A value pasted in the wrong step is refused with a 400.
   - Each attempt writes a `setup.credential` audit row with the secret's name, never its value.
   - The answer never carries the value.
   - `finish` marks `setupAcknowledgedAt` in `config.json`. When a credential was stored since
     the daemon started, `finish` restarts it through the restart contract of ADR 0026: reason
     `setup`, exit 86, and the shell relaunches it. The model provider and billing sources are
     composed at start.

   The app opens the assistant when it starts while `showAssistant` is true (not complete and
   not acknowledged). The assistant has four steps: Welcome (name and time zone), Claude, GitHub,
   Done.
   - Each secret box has Paste, Show and "Check and save". A paste checks at once, and the field
     is cleared after sending.
   - "Create a token on GitHub" opens GitHub's form with Forerunner's permissions filled in
     (`contents=write&pull_requests=write&issues=write&statuses=read&metadata=read`).
   - Settings → Accounts and keys opens the assistant again.
5. The GitHub request lists "Commit statuses: read (to see CI results)" instead of the wrong
   "Workflows: read".
6. The repository's default branch carries the latest released code (fast-forwarded to
   `ccr-af5a431d-jc9xqj` on 2026-10-29), so "Download ZIP" is current.

## Consequences

- The installers grow:
  - the Linux `.deb` is about 196 MiB (measured; 4.2 MiB for the 1.0.0 MSI);
  - the payload is about 470 MiB on disk, mostly the Agent SDK's native `claude` binary
    (280 MB) and Node (120 MB);
  - about 6,500 files.

  Subscription sessions work out of the box.
- Installing is downloading and running one file. `scripts/fresh-install.*` stays for
  developers and CI timing.
- The first start of a fresh install compiles the sources with `tsx` (cached afterwards), so the
  shell's start budget is now 150 s. The measured start on Linux is about 5 s.
- The in-app updater still stages the release's installer file, not a runnable runtime, so on
  the desktop "Update and restart" cannot replace the running build. Installing the new MSI,
  AppImage or `.deb` over the old one is the way to update. A desktop artefact the updater can
  stage (the payload zip, with the UI) is follow-up work, recorded in `updates.md` Known issues.
- A daemon left running by an older install is ended without asking. Its sessions stop as they
  would on a restart.
- Credentials now reach the vault through the daemon API too. That API is already the boundary
  every privileged action crosses: loopback only, bearer token in `daemon.json` (0600), the token
  held by the shell. The routes accept only the three setup names, and only after the value
  passes its check.

## Alternatives considered

- **Compile the runtime into one binary (`node --experimental-sea-config`, `pkg`, Bun).** The
  native keyring module, the Agent SDK's binary and the files the runtime reads next to its
  sources (catalog, registry, voice helpers) would each need special handling. It would no
  longer be the code CI tests. Rejected for now.
- **Bundle with esbuild into one file.** Fewer files, but the same file-relative reads break.
  `tsx` over the sources is what `pnpm fr` and every test run.
- **Download the runtime on first start.** A smaller installer, but a network failure leaves an
  app that cannot start. A second artefact would need its own signature, and nothing would work
  offline.
- **Keep the scripted install and document it.** It is what failed: the guide and the release
  page did not say the MSI needs it, and it needs a terminal.
- **Attach to any healthy daemon and warn in the UI.** A broken UI with a banner is still
  broken. Replacing the outdated daemon makes the installed version the one that runs.
