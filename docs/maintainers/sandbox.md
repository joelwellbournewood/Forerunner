# Sandbox

`packages/runtime/src/sandbox`: where a task's code runs. One Docker or Podman container per
coding or test task with only the task worktree mounted and a per-task network policy; a
weaker process sandbox as the stand-in when no engine is reachable; an in-memory fake for unit
tests. ADR 0007 records the decision. Spec: Architecture item 9, the platform table
("Sandboxes" row), Security "Sandboxing", module M (tests in Docker).

## Purpose

Specialists write and run code. The sandbox is the code that makes the spec's three promises
true without trusting a prompt:

1. **No host filesystem except the worktree.** The container sees `/work` (the task's git
   worktree) and nothing else from the host. `writeFile`/`readFile`/`exists` on every adapter
   go through one containment check (`contain.ts`) that refuses absolute paths, drive letters,
   UNC prefixes and any `..` that leaves the worktree with `path_not_allowed`.
2. **Network allowlist per task.** `{ mode: "none" }` disconnects the container
   (`--network none`). `{ mode: "allowlist", domains }` routes the container through an egress
   proxy on the host that allows only the listed hosts (same `*.example.com` patterns as a
   capability token's `allowedDomains`) and audits every decision.
3. **Limits in code.** CPU, memory and pid caps on the container; a wall-clock cap per command
   enforced on the host *and* inside the container; an output cap per stream.

## How it works

### Files

| File | What it holds |
| --- | --- |
| `types.ts` | `Sandbox`, `NetworkPolicy`, `SandboxLimits`, `SandboxRunOptions`, `RunFn`, `WhichFn` |
| `contain.ts` | `containPath(worktree, relPath)` → `{ host, rel }`, the single path-containment check |
| `detect.ts` | `detectSandboxEngine()` with a per-process TTL cache on the `Clock`; `FORERUNNER_SANDBOX_ENGINE` override |
| `worktree.ts` | `WorktreeManager`: `git worktree add -B` per task under `appDirs().worktrees`, `list`, `remove` + `prune`, root guard |
| `egress-proxy.ts` | `EgressProxy`: HTTP forward + CONNECT tunnel, allowlist, token auth, source filter, byte counters, audit callback |
| `container.ts` | `ContainerSandbox` (docker / podman), `buildContainerRunArgv`, `resolveRunnerImage`, `DEFAULT_RUNNER_IMAGE` |
| `process.ts` | `ProcessSandbox`, `PROCESS_SANDBOX_WARNING` |
| `fake.ts` | `FakeSandbox` for callers' unit tests |
| `factory.ts` | `createSandbox(opts)` → `{ sandbox, engine, warnings, detection }`, the risk-tier rule |
| `index.ts` | re-exports everything (the orchestrator exports it from the package index) |

### The `Sandbox` interface

```ts
interface Sandbox {
  readonly kind: "container" | "process" | "fake";
  readonly worktree: string;          // absolute host path
  readonly network: NetworkPolicy;    // { mode: "none" } | { mode: "allowlist", domains }
  run(argv, { cwd?, env?, timeoutMs?, input?, maxOutputBytes?, signal? }): Promise<RunResult>;
  writeFile(relPath, content); readFile(relPath); exists(relPath);
  destroy(): Promise<void>;
}
```

`run` always resolves with the platform `RunResult` (`code`, `stdout`, `stderr`, `truncated`,
`timedOut`, `durationMs`); a non-zero exit is a result, not an exception. It throws only when
the sandbox itself is unusable (`unavailable` after `destroy`, `path_not_allowed` for a bad
`cwd`, `validation` for an empty argv). `cwd` is relative to the worktree. `env` is only ever
what the caller passes plus the sandbox's own variables: the host environment never reaches a
command. `timeoutMs` is capped by `SandboxLimits.timeoutMs`. `writeFile` normalises line
endings to LF and creates parent directories. The ADR sketched `exec/copyIn/copyOut`; the
built interface is `run/writeFile/readFile/exists`, which is what the executors need, because
the worktree is a bind mount and copying is unnecessary.

### Choosing the engine (`detect.ts`, `factory.ts`)

`detectSandboxEngine({ env, which, run, clock, ttlMs })` probes
`docker info --format {{.ServerVersion}}|{{.SecurityOptions}}` (rootless shows up in the
security options) and then `podman info --format {{.Version.Version}}|{{.Host.Security.Rootless}}`.
It skips a CLI that is not on PATH, never throws (an unreachable daemon is
`{ engine: "none", reason: "<daemon error>" }`) and caches the answer per process for 60 s on
the injected `Clock` (`resetSandboxEngineCache()` for tests or after an install).
`FORERUNNER_SANDBOX_ENGINE=docker|podman` probes that engine only; `=process` skips the probes.

`createSandbox({ taskId, worktree, limits, network, riskTier, allowProcessSandbox, env, image,
... })` picks:

1. `ContainerSandbox` when an engine is reachable.
2. Otherwise `ProcessSandbox`, **unless `riskTier >= 2` and the project setting
   `allowProcessSandbox` is off**: then it throws `ForerunnerError("not_supported")` with the
   detection reason. This is the spec's "tasks at risk tier 2+ refuse to run code in it" rule,
   enforced here and tested in `test/sandbox-factory.test.ts`.

It returns `warnings[]` for the session log: the process-sandbox warning (see below) and a note
when the image fell back to the local default.

### Engines per OS

| OS | Engine | Notes |
| --- | --- | --- |
| Windows 10/11 | Docker Desktop (WSL2 backend) | `docker` CLI on PATH; the proxy listens on the Windows host and the container reaches it as `host.docker.internal` (Docker Desktop resolves it). Windows Firewall may ask once for node. |
| Windows 10/11 | Podman (podman machine) | `podman` CLI; the container reaches the host as `host.containers.internal`. |
| Linux | Docker (rootful or rootless) | Rootful: the container runs as the host `uid:gid` (`--user`) with `HOME=/tmp` so files in the worktree stay owned by the user. Rootless: user mapping is automatic; no `--user`. `--add-host host.docker.internal:host-gateway` needs Docker 20.10+. |
| Linux | Podman rootless (default on Fedora) | `host.containers.internal` is injected by Podman. SELinux hosts need `FORERUNNER_SANDBOX_SELINUX=1` (adds `relabel=private` to the mount). |
| Any | none | process sandbox with the warning; refused for tier 2+ unless allowed. |

### The container (`container.ts`)

`ContainerSandbox.create` starts one long-lived container per task and `exec`s every command
into it. Every engine call is an argv array (`@forerunner/platform` `run`); there is no shell
string anywhere. The `run` argv, snapshot-tested in `test/sandbox-container.test.ts`:

```
docker run -d --rm --name forerunner-<task>-<hex8>
  --label forerunner.sandbox=1 --label forerunner.task=<taskId>
  --mount type=bind,src=<worktree>,dst=/work --workdir /work
  --network none | --network bridge (podman: podman)      # per NetworkPolicy
  --cpus N --memory Nm --pids-limit N                      # from SandboxLimits, when set
  --security-opt no-new-privileges --cap-drop ALL
  [--user uid:gid]
  [--add-host host.docker.internal:host-gateway            # docker + allowlist
   -e HTTP_PROXY=... -e HTTPS_PROXY=... -e http_proxy=... -e https_proxy=... -e ALL_PROXY=...
   -e NO_PROXY= -e no_proxy=]
  -e KEY=VALUE ...                                         # caller's env only
  -e FORERUNNER_SANDBOX=container
  <image> sleep infinity
```

Commands: `docker exec [-i] --workdir /work/<cwd> [-e K=V ...] <name> timeout -s KILL <s> <argv...>`.
The coreutils `timeout` wrapper inside the container is what actually kills a runaway command:
the `exec` client dying on the host-side timeout would not. A command the wrapper killed (exit
124/137 at the deadline) is reported with `timedOut: true`. Images without coreutils pass
`timeoutWrapper: false`. `destroy()` runs `docker rm -f <name>` and closes the proxy; it is
idempotent and the worktree on the host survives.

`writeFile`/`readFile`/`exists` act on the host side of the bind mount (after `containPath`);
the container sees the change at once and the other way round.

**Image.** `resolveRunnerImage(configured, env)`: the project or app configuration, then
`FORERUNNER_RUNNER_IMAGE`, then `forerunner-runner:local`. No registry owner is ever assumed.
The image is the runner image from `services/cloud-runner/Dockerfile` (the same image serves
the cloud runner, as the spec asks); build it locally with
`docker build -t forerunner-runner:local -f services/cloud-runner/Dockerfile .`.

### Worktrees (`worktree.ts`)

`new WorktreeManager({ root: appDirs().worktrees })`:

- `create({ repoDir, branch, taskId, base = "HEAD" })` runs
  `git -C <repo> worktree add -B <branch> <root>/<safeSegment(taskId)> <base>` and writes a
  sidecar `<segment>.worktree.json` (task, repo, branch, created_at) next to it. Creating twice
  for the same task is a `validation` error; remove first.
- `list()` reads the sidecars (and, for a worktree that lost its sidecar, the `.git` file).
- `remove(path, { force })` refuses anything outside the root (`path_not_allowed`), runs
  `git worktree remove [--force]`, then `git worktree prune`, then deletes the sidecar. Without
  `force`, a dirty worktree is kept and the error says so.

### Network policy and the egress proxy (`egress-proxy.ts`)

`EgressProxy.start({ allow, bindHost, token, onDecision })` is a small Node HTTP proxy:

- plain `GET http://host/...` requests are forwarded when `host` matches the allowlist,
  otherwise answered `403`;
- `CONNECT host:443` (HTTPS) opens a tunnel for allowed hosts, otherwise `403` and the socket
  closes; TLS stays end-to-end, the proxy only sees the host name;
- every decision goes to `onDecision({ host, port, allowed, method, remote, at })` (the
  executor writes it to the audit log) and to the `sandbox:egress` logger; `stats()` returns
  bytes in/out and allowed/denied counts;
- when `token` is set, clients must send `Proxy-Authorization: Basic forerunner:<token>`
  (missing or wrong → `407`, no decision recorded); the token is random per sandbox and is only
  in the container's `HTTP_PROXY` URL, never in model context;
- connections from addresses outside loopback / RFC 1918 / link-local / ULA are dropped
  before any request is read (`isPrivateAddress`, overridable with `allowFrom`).

For a container the proxy binds `0.0.0.0` (override `FORERUNNER_EGRESS_BIND`) so the container
network can reach it, and the container is told `host.docker.internal` (Docker, with
`--add-host ...:host-gateway`) or `host.containers.internal` (Podman); override the name with
`FORERUNNER_EGRESS_HOST` when the engine runs in a VM with a different route. For the process
sandbox it binds `127.0.0.1`.

Git, curl, pip, npm, pnpm, cargo and most SDKs honour `HTTP_PROXY`/`HTTPS_PROXY`. Node's
built-in `fetch` does not (Node 22); scripts that need it set
`setGlobalDispatcher(new EnvHttpProxyAgent())` from `undici`, or use `http.request` against the
proxy as the tests do.

### The process sandbox (`process.ts`)

Used only when no engine is reachable (or `FORERUNNER_SANDBOX_ENGINE=process`). It runs the
command as a child process with:

- environment = `scrubEnv(process.env)` (every credential-looking variable removed, `PATH`,
  `HOME`, locale kept) + the sandbox `env` + the per-run `env`, then the proxy variables and
  `FORERUNNER_SANDBOX=process` on top (a run cannot override the proxy);
- `cwd` pinned inside the worktree (`containPath`; a missing directory is `not_found`);
- wall-clock and output caps from the platform runner (`killTree` on timeout);
- an `EgressProxy` on `127.0.0.1` with the task allowlist, or an empty allowlist for
  `{ mode: "none" }` so every attempt by a well-behaved client is refused and audited.

It cannot stop a process from opening sockets directly, reading other host paths or seeing the
scrubbed-but-present environment; that is why it logs
`sandbox: process (no container engine)` at `warn` on creation, why `createSandbox` returns
the same line in `warnings` for the session log, and why tier 2+ tasks refuse it.

### Fake (`fake.ts`)

`new FakeSandbox({ files, rules, defaultResult, network })` keeps files in a `Map` keyed by
posix relative path (same containment rules), returns scripted `RunResult`s
(`script(match, result)`, later scripts win; `match` is a command name, a substring, a RegExp
or a predicate) and records `calls`. Executors and tools test against it.

### Configuration

| Variable | Effect | Default |
| --- | --- | --- |
| `FORERUNNER_SANDBOX_ENGINE` | `docker`, `podman` (probe only that) or `process` (skip containers) | auto |
| `FORERUNNER_RUNNER_IMAGE` | image when the project/app config names none | `forerunner-runner:local` |
| `FORERUNNER_EGRESS_BIND` | interface the proxy listens on for containers | `0.0.0.0` |
| `FORERUNNER_EGRESS_HOST` | host name the container uses to reach the proxy | per engine |
| `FORERUNNER_SANDBOX_NETWORK` | network for allowlist mode instead of the engine default | `bridge` / `podman` |
| `FORERUNNER_SANDBOX_SELINUX` | `1` adds `relabel=private` to the mount (Fedora, SELinux) | off |

Per-task inputs come from the task and the project: `limits` (cpus, memoryMb, pidsLimit,
timeoutMs), `network` (the capability token's `allowedDomains` become the allowlist; an empty
list is `{ mode: "none" }`), `riskTier`, `allowProcessSandbox`.

## How to change it

- **Change the image.** Edit `services/cloud-runner/Dockerfile`, rebuild
  (`docker build -t forerunner-runner:local -f services/cloud-runner/Dockerfile .`), or set
  `FORERUNNER_RUNNER_IMAGE` / the project setting to a published tag. The sandbox needs
  `sleep`, `timeout` (coreutils) and whatever the task runs; nothing else is assumed.
- **Add a limit.** Extend `SandboxLimits`, add the flag in `buildContainerRunArgv` and the
  snapshot in `test/sandbox-container.test.ts`; the process sandbox should enforce or document
  it.
- **Add an engine.** Add a probe in `detect.ts`, the `hostAlias` and default network in
  `container.ts`, a row in the table above and argv snapshots.
- **Tighten the allowlist to the kernel level.** Today allowlist mode uses the engine's default
  bridge network plus proxy variables; a process that ignores `HTTP_PROXY` can still reach the
  network directly. The planned step (ADR 0007 "egress sidecar") is a `--internal` network for
  the task container plus a proxy container on both networks; `buildContainerRunArgv` already
  takes `networkName`, so only the sidecar lifecycle is missing. Until then the tool hooks'
  `domainFields` checks and the audit of every proxied request are the enforcement layers, and
  the doc and session log say so.
- **Change the tier rule.** `createSandbox` in `factory.ts` and the test
  "refuses the process sandbox for risk tier >= 2".

## Tests

Unit (`pnpm vitest run --project unit packages/runtime/test/sandbox-*.test.ts`, no engine,
no network beyond loopback):

- `sandbox-contain.test.ts`: containment accepts inside paths, refuses `..`, absolute, drive
  and UNC paths.
- `sandbox-detect.test.ts`: docker found with rootless flag, podman fallback, daemon-down
  reason, never throws, TTL cache on `SimulatedClock`, the three override values, unknown
  override ignored.
- `sandbox-worktree.test.ts`: real temp git repository: create on a new branch under the safe
  segment, list, remove and prune, double create refused, removal outside the root refused,
  dirty worktree kept without force, sidecar loss, explicit base.
- `sandbox-egress.test.ts`: local target server: allowed host forwarded with bytes counted,
  blocked host 403 without contacting it, wildcard patterns, 407 without token, CONNECT
  tunnel for an allowed host, CONNECT refused with 403, source filter, deny-all, URL/env
  helpers, `isPrivateAddress`.
- `sandbox-container.test.ts`: argv snapshots for docker none / docker allowlist / podman,
  invalid env names, image precedence with no hardcoded owner, create/exec/destroy with a
  recorded fake engine (timeout wrapper, cwd, env, stdin, cap by limits, idempotent destroy),
  proxy wiring per engine, failed `run` → `unavailable`, wrapper kill → `timedOut`, host-side
  file access with containment.
- `sandbox-process.test.ts`: env scrubbed (credential-shaped fixtures built by concatenation),
  PATH kept, proxy variables set and not overridable, cwd pinned and escapes refused, timeout,
  output cap, exit codes as results, deny-all proxy for `none`, LF writes, warning logged.
- `sandbox-fake.test.ts`, `sandbox-factory.test.ts`: fake behaviour; container picked when an
  engine answers (image from env, `--user` on Linux), fallback warning, tier rule, process
  sandbox with warning, `FORERUNNER_SANDBOX_ENGINE=process`.

Integration (`pnpm vitest run --project integration packages/runtime/test/sandbox.integration.test.ts`):
with a reachable engine and `node:22-bookworm-slim` (pulled on demand) it runs
`node -e "console.log(1+1)"` → `2`, checks host→container and container→host through the
mount, stdin, env, `CapEff` all zero and `NoNewPrivs`, that only `/work` is mounted from the
host, the in-container timeout, and that `destroy` removes the container; proves
`--network none` blocks `fetch`; and, when the engine can route `host-gateway`, that
allowlist mode passes an allowed host and gets 403 for a blocked one through the real proxy.
Without an engine, without the image (network policy) or without `host-gateway` the suite or
the single test skips with the reason in its name. Linux CI runs it with the Docker service;
Windows CI covers the process sandbox and selection logic.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `sandbox: process (no container engine): docker: Cannot connect to the Docker daemon ...` | Daemon not running or the user is not in the `docker` group. Start Docker Desktop / `systemctl --user start docker` (rootless) / `sudo systemctl start docker`, then `fr doctor`. The cache clears after 60 s. |
| Same with `docker not on PATH; podman not on PATH` | Install Docker Desktop (Windows: WSL2 backend enabled) or Podman; on Windows make sure the CLI is on PATH for the user running Forerunner, not only inside WSL. |
| `task at risk tier 2 needs a container sandbox and none is reachable` | By design. Fix the engine, lower the tier, or turn on the project setting `allowProcessSandbox` (and accept the weaker sandbox). |
| Windows: container cannot reach the proxy (allowlist tasks fail with connection refused) | Docker Desktop resolves `host.docker.internal` to the Windows host; the proxy must be allowed through Windows Firewall for node, or set `FORERUNNER_EGRESS_BIND` to the WSL vEthernet address. For Podman set `FORERUNNER_EGRESS_HOST=host.containers.internal`. |
| Linux: `unable to derive the IP value for host-gateway` | The engine has no bridge network or IP forwarding is off (seen in CI sandboxes). `--network none` tasks still work; allowlist tasks need the bridge (`docker network create bridge` is not enough: enable `net.ipv4.ip_forward`). The integration test skips this case. |
| Rootless Podman: `permission denied` on files in the worktree or `relabel` errors | SELinux: set `FORERUNNER_SANDBOX_SELINUX=1`. User mapping is automatic in rootless mode; do not pass `--user`. |
| Files in the worktree owned by root after a task (rootful Docker) | The factory passes `--user uid:gid` on Linux; if you created the sandbox directly, pass `user`. |
| `Unable to find image 'forerunner-runner:local'` | Build it (see "Change the image") or set `FORERUNNER_RUNNER_IMAGE`. The warning `sandbox: image not configured` in the session log points here. |
| `timeout: not found` on every command | The image has no coreutils; pass `timeoutWrapper: false` (the host-side cap still applies but cannot kill the in-container process). |
| `worktree already exists, remove it first` | A previous session crashed. `WorktreeManager.list()` shows it; `remove(path, { force: true })` after saving anything needed. |

## Known issues

- Allowlist mode is proxy-based: the container is on the engine's default network and only
  clients that honour `HTTP_PROXY`/`HTTPS_PROXY` are filtered. See "Tighten the allowlist" for
  the planned internal network + sidecar.
- Node 22's global `fetch` ignores proxy variables, so node scripts inside an allowlist sandbox
  reach the network only through an explicit `EnvHttpProxyAgent`.
- The process sandbox is a stand-in: no filesystem isolation, no socket filtering, no cgroup
  limits (cpus/memoryMb/pidsLimit are ignored and documented as container-only).
- `killTree` on Linux falls back to the direct pid for non-detached children (see
  platform-notes); the container path kills through `docker rm -f` and the in-container
  `timeout`, so this only concerns the process sandbox.
- Podman on Windows is covered by the same argv path but has not been run in CI (no Windows
  CI engine); the selection logic and argv snapshots are.

## Requirements covered

- S.7 (Sandboxing: Docker with only the worktree mounted and a network allowlist): container
  adapter, mount containment, `--network none`, allowlist via egress proxy with audit;
  `packages/runtime/test/sandbox-container.test.ts`, `sandbox-egress.test.ts`,
  `sandbox.integration.test.ts`. Remaining clause: kernel-level allowlist (sidecar), tracked
  above.
- Architecture item 9 and the platform table "Sandboxes" row (Docker Desktop on WSL2 or Podman
  on Windows; Docker or Podman rootless on Linux): `detect.ts`, `factory.ts`, the per-OS table.
- M.2, "tests in Docker" clause: `Sandbox.run` is what the PR task executor uses to run a
  project's tests in the runner image; the rest of M.2 (PR flow, critic tier, approval) lives
  in capabilities and critic.
- ADR 0007 consequences: the process sandbox warning in the session log and the tier 2+ rule
  (`sandbox-process.test.ts`, `sandbox-factory.test.ts`).
