# 0101 — Full-review tasks run only in the Docker sandbox; the app fetches the published image and tasks wait while it is not ready

Date: 2026-10-31
Status: accepted

## Context

U-079 (`docs/status/UPDATE-LOG.md`). Tasks at risk tier 2 and above get a full review (the
critic at tier 2 or 3). ADR 0007 had them run their commands in a container, or in the process
stand-in when the project setting `allowProcessSandbox` was on. On an installed app neither
worked:

- the image defaulted to `forerunner-runner:local`, which only `docker build` in a source
  checkout makes; the release workflow publishes `ghcr.io/<owner>/forerunner-runner:<version>`
  and `:latest`, and the app never used them;
- an engine that answered `docker info` counted as usable, whatever it could run: Docker
  Desktop on Windows containers refuses the bind mount to `/work`, and a Linux Docker without
  the image refuses `docker run` (exit 125);
- the task then failed with the engine's words and the retry ladder ran it again.

Since U-037 the tasks of a project without a repository take the same path, so on CI (Docker
on Linux without the image, Docker on Windows on Windows containers) every composed-runtime
test that runs a task failed. The owner decided: "better to force to use Docker, so that
reviews can be comprehensive".

## Decision

1. **Readiness, one of six states** (`packages/runtime/src/sandbox/readiness.ts`):
   `not_installed` (no `docker` or `podman` on PATH), `not_running` (`docker info` fails),
   `windows_containers` (`docker info` reports `OSType` other than `linux`), `image_missing`
   (`docker image inspect` fails), `pulling` (a download runs) and `ready`. Podman counts (it
   runs Linux containers). The detection reads `OSType` with the version
   (`{{.ServerVersion}}|{{.SecurityOptions}}|{{.OSType}}`); an engine on Windows containers is
   `engine: "none"` with `problem: "windows_containers"` and is never tried. The answer is
   kept; it is checked again at the daemon's start, before every session plans, and on
   Settings' Check again.

2. **The container only when ready.** The daemon's port (`DetectingSandboxPort`) gives the
   factory the engine only when the state is `ready`. Tiers 0 and 1 then run as before: in the
   container when ready, else in the process stand-in with its warning. Tiers 2 and 3 never
   get the stand-in: their lease is refused with `sandboxNotReadyError` (`not_supported`,
   `details.reason: "sandbox_not_ready"`, with the state, the headline and the step). The
   project setting `allowProcessSandbox` is no longer read. The one way left to run tier 2+ in
   the stand-in is the composition's test-only `sandboxProcessForEveryTier`, which no setting,
   file or environment variable sets.

3. **Waiting, not failing.** The session runner asks a `SandboxGate` before it plans. While the
   sandbox is not ready, the ready tasks at tier 2+ are left out of the plan; the session goes
   on with the others; the summary and the `session.planned` event name them with the step;
   their attempt count does not change. A lease refused after the plan (Docker quit mid-
   session) puts the task back to ready through `releaseClaim` (no `failed -> ready`, so no
   attempt), and the session goes on. The Start dialog's `GET /projects/:id/start-check` names
   the same tasks (`waitingForSandbox`). One Inbox notice (`kind: "info"`, not blocking, author
   `sandbox-gate`, `change_card.key: "sandbox.not_ready"` with the state) says Docker is needed:
   kept while open, not filed again for the same state (even after the person answered it),
   replaced when the state changes, withdrawn when the sandbox is ready. When the sandbox
   becomes ready, a tier 2+ task an older version failed with the old sandbox message
   (`OLD_SANDBOX_FAILURE`) goes back to ready with its attempt count restored.

4. **The image comes from the build.** `scripts/build-runtime-payload.mjs` writes
   `runnerImage: { repository: "ghcr.io/<owner>/forerunner-runner", tag: "<app version>",
   fallbackTag: "latest" }` into the payload's `runtime.json`, where `<owner>` is the build's
   `GITHUB_REPOSITORY_OWNER`, lowercased (or `FORERUNNER_RUNNER_IMAGE_REPOSITORY`). No owner is
   in source; a local build names none. The runtime reads it (`readBuildRunnerImage`, the
   payload root found as the registry finds it). Precedence (`resolveSandboxImage`): the
   project's `settings.sandbox.image`, `FORERUNNER_RUNNER_IMAGE`, the build's
   `<repository>:<version>`, then `forerunner-runner:local` (built, never pulled).

5. **The version tag, else latest.** The app does not know whether the registry has an image
   for its version (a development build between releases has none). The download tries
   `:<version>`; when the registry says "manifest unknown" (not found), it marks the tag
   unpublished for this process and pulls `:latest`, which the sandbox then uses. A refused
   pull ("denied", "unauthorized") is not taken as not found: it says the package must be
   public or needs `docker login`. Offline, a `:latest` already on the computer stands in. A
   restart starts again from the version tag (one cheap manifest lookup).

6. **The download.** `docker pull <image>` as a background job (`SandboxReadinessService`),
   like the voice install (ADR 0090): one at a time (a second Download follows the first),
   events replayable by sequence (`step`, `layers` done of total, `log`, `warning`, `error`,
   `result`), cancelled by the daemon's stop. It starts by itself when a session finds tier 2+
   tasks waiting and the image is all that is missing, and from Settings' Download. The size is
   read from the registry (`docker manifest inspect --verbose`, the layers of the host's
   platform) only for the Settings card, once per image, so neither the daemon's start nor a
   plan waits on a registry.

7. **Settings → Sandbox (Docker)** (`apps/ui/src/pages/SandboxSettingsCard.tsx`) shows the
   state, why (full-review tasks run their tests and builds in it, isolated from the computer,
   so the critic sees real results), the steps for the state from one words module
   (`sandbox/readiness-types.ts`: the summary, the Start dialog, the notice and the card say
   the same), the image and its size, how many tasks wait, Download with progress and Check
   again. Routes: `GET /sandbox`, `POST /sandbox/check`, `POST /sandbox/pull`,
   `GET /sandbox/pull/events` (`SANDBOX_ROUTES` in `DAEMON_ROUTES`). `/health`'s `sandbox`
   gains `state`, and `available` means ready.

8. **Tests pin the sandbox they mean.** `FakeContainerEngine` (`sandbox/fake-engine.ts`)
   answers the `docker` argv the detection, the readiness check, the pull and the container
   sandbox send, from a state the test sets (not installed, not running, Windows containers,
   images, registry, denied pulls); its `exec` runs the command on the host in the worktree.
   Composed-runtime tests either pass it, pin `sandboxDetection` to no engine, or pass the
   test-only `sandboxProcessForEveryTier`; none depends on the machine's Docker.

## Consequences

- A person without Docker gets tier 0 and 1 work done as before and sees the tier 2+ tasks
  wait with one notice and plain steps; nothing fails for want of Docker.
- The GHCR package `forerunner-runner` must be public, or every person needs `docker login
  ghcr.io`; that is an owner action (`docs/maintainers/release.md`).
- The image is about as large as the runner image (`services/cloud-runner/Dockerfile`); the
  first full-review task waits for that download.
- The model watch's `model_watch.allow_process_sandbox` (ADR 0089) still lets tier 0 and 1
  eval leases use the stand-in; tier 2+ eval leases are refused like tasks.
- The Agent SDK path (a subscription pick) runs no sandbox lease; its tier 2+ tasks wait for
  the sandbox too, because the gate is before the plan and the driver is picked per run.
- Only a real Windows PC with Docker Desktop proves the switch to Linux containers, the WSL 2
  download and the bind mount of a Windows path; CI runs the selection, the states and the
  waiting with the stand-in engine.

## Alternatives considered

- Keep the process fallback behind the project setting: the owner decided against it (reviews
  of tier 2+ work must see real test and build results in isolation).
- Fail the task with a clear message: a person without Docker would see failures and retries
  for work that only needs Docker started; waiting keeps the plan and the attempt count.
- Pin the exact image digest in the build: the release builds the image in a separate job
  from the desktop installers, so the digest is not known when the payload is built; the
  version tag is.
- Ship the image inside the installer: well over a gigabyte for every person, including those
  without Docker.
