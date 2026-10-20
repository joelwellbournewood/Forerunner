# Sandbox

`packages/runtime/src/sandbox`: where a task's code runs. One Docker or Podman container per
coding or test task with only the task worktree mounted and a per-task network policy the
kernel enforces; a weaker process sandbox as the stand-in when no engine is reachable; an
in-memory fake for unit tests. ADR 0007 records the decision. Spec: Architecture item 9, the
platform table ("Sandboxes" row), Security "Sandboxing", module M (tests in Docker).

## Purpose

Specialists write and run code. The sandbox is the code that makes the spec's three promises
true without trusting a prompt:

1. **No host filesystem except the worktree.** The container sees `/work` (the task's git
   worktree) and nothing else from the host. `writeFile`/`readFile`/`exists` on every adapter
   go through one containment check (`contain.ts`) that refuses absolute paths, drive letters,
   UNC prefixes and any `..` that leaves the worktree, and then walks the path on disk so a
   symlink planted by the sandboxed command (or committed in a cloned repository) cannot turn a
   host-side read or write into host access. Every refusal is `path_not_allowed`.
2. **Network allowlist per task.** `{ mode: "none" }` disconnects the container
   (`--network none`). `{ mode: "allowlist", domains }` puts the container on a per-sandbox
   `--internal` network whose only exit is the task's egress proxy; the proxy allows only the
   listed hosts (same `*.example.com` patterns as a capability token's `allowedDomains`),
   answers 403 for the rest and audits every decision. A process that ignores
   `HTTP_PROXY` gets no route at all, not a quieter one.
3. **Limits in code.** CPU, memory and pid caps on the container; a wall-clock cap per command
   enforced on the host *and* inside the container; an output cap per stream.

## How it works

### Files

| File | What it holds |
| --- | --- |
| `types.ts` | `Sandbox`, `SandboxKind`, `NetworkPolicy`, `SandboxLimits`, `SandboxRunOptions`, `RunFn`, `WhichFn` |
| `contain.ts` | `containPath` (lexical), `containPathReal` (symlink-aware walk), `readWorktreeFile`, `writeWorktreeFile`, `worktreeFileExists` |
| `detect.ts` | `detectSandboxEngine()` with a per-process TTL cache on the `Clock`, `resetSandboxEngineCache()`, the `FORERUNNER_SANDBOX_ENGINE` override |
| `worktree.ts` | `WorktreeManager`: `git worktree add -B` per task under `appDirs().worktrees`, `list`, `remove` + `prune`, root guard |
| `egress-proxy.ts` | `EgressProxy`: HTTP forward + CONNECT tunnel, allowlist, token auth, source filter, upstream timeout, byte counters, audit callback |
| `container.ts` | `ContainerSandbox` (docker / podman), the argv builders (`buildContainerRunArgv`, `buildNetworkCreateArgv`, `buildEgressSidecarArgv`), `parseNetworkGateway`, `parseContainerAddress`, `stripProxyEnv`, `resolveRunnerImage`, `EgressRoute` |
| `process.ts` | `ProcessSandbox`, `PROCESS_SANDBOX_WARNING` |
| `fake.ts` | `FakeSandbox` for callers' unit tests |
| `factory.ts` | `createSandbox(opts)` → `{ sandbox, engine, warnings, detection }`, the risk-tier rule, `defaultEgressRoute` |
| `index.ts` | re-exports everything; `packages/runtime/src/index.ts` exports it from the package |

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
`cwd`, `validation` for an empty argv or a bad env name). `cwd` is relative to the worktree.
`env` is only ever what the caller passes plus the sandbox's own variables: the host
environment never reaches a command, and a per-run `env` cannot set the proxy variables the
sandbox owns (`PROXY_ENV_KEYS`: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their
lower-case forms; the container strips them, the process sandbox overrides them).
`timeoutMs` is capped by `SandboxLimits.timeoutMs`. `writeFile` normalises line endings to LF
and creates parent directories. The ADR sketched `exec/copyIn/copyOut`; the built interface is
`run/writeFile/readFile/exists`, which is what the executors need, because the worktree is a
bind mount and copying is unnecessary.

### Path containment (`contain.ts`)

The host-side file helpers of the container and process sandboxes operate on a directory that
model-controlled code changes at the same time, so two checks exist:

- `containPath(worktree, relPath)` is lexical: NUL bytes, absolute paths, drive letters, UNC
  prefixes and any `..` that climbs out are refused. It is the right check for a `cwd` that
  the container resolves in its own mount namespace, and for the in-memory fake.
- `containPathReal(worktree, relPath)` runs the lexical check, then `realpath`s the worktree
  root and walks the path component by component with `lstat`. Every symlink (junction on
  Windows) is resolved and re-checked against the real root; a dangling link is resolved
  lexically against its own directory and walked again; a chain longer than 40 links is
  refused; the walk stops at the first component that does not exist yet, because nothing
  below it can be a link. The returned `host` is the real path to use for I/O.

`readWorktreeFile`, `writeWorktreeFile` and `worktreeFileExists` use `containPathReal`.
`writeWorktreeFile` opens the final component with `O_NOFOLLOW` where the OS has it (Linux,
macOS), so a link planted between the walk and the write cannot redirect it (`ELOOP` becomes
`path_not_allowed`); Windows has no such flag and relies on the walk. A link that stays inside
the worktree is followed and the real path is used. The process sandbox resolves its `cwd` the
same way, because the child runs on the host.

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

1. `ContainerSandbox` when an engine is reachable. On rootful Docker on Linux it adds
   `--user <host uid>:<gid>` and `HOME=/tmp` so files in the worktree stay owned by the user,
   and it picks the egress route (below).
2. Otherwise `ProcessSandbox`, **unless `riskTier >= 2` and the project setting
   `allowProcessSandbox` is off**: then it throws `ForerunnerError("not_supported")` with the
   detection reason. This is the spec's "tasks at risk tier 2+ refuse to run code in it" rule,
   enforced here and tested in `test/sandbox-factory.test.ts`.

It returns `warnings[]` for the session log: the process-sandbox warning (see below) and a note
when the image fell back to the local default.

### Engines per OS

| OS | Engine | Egress route | Notes |
| --- | --- | --- | --- |
| Windows 10/11 | Docker Desktop (WSL2 backend) | sidecar | `docker` CLI on PATH. The engine runs in a VM, so the relay sidecar reaches the Windows host as `host.docker.internal`; the proxy listens on `0.0.0.0` and Windows Firewall may ask once for node. |
| Windows 10/11 | Podman (podman machine) | sidecar | `podman` CLI; the relay reaches the host as `host.containers.internal`. |
| Linux | Docker rootful | gateway | The host owns the internal network's bridge, so the proxy binds its gateway address and no extra container is needed. Container runs as the host `uid:gid`. |
| Linux | Docker rootless | sidecar | The bridge lives in a user namespace; `--add-host host.docker.internal:host-gateway` (Docker 20.10+) gives the relay a route to the host. No `--user`. |
| Linux | Podman rootless (default on Fedora) | sidecar | `host.containers.internal` is injected by Podman. SELinux hosts need `FORERUNNER_SANDBOX_SELINUX=1` (adds `relabel=private` to the mount). |
| Any | none | | process sandbox with the warning; refused for tier 2+ unless allowed. |

`defaultEgressRoute(detection)` returns `gateway` for a rootful engine on native Linux and
`sidecar` everywhere else; `FORERUNNER_EGRESS_ROUTE` or the `egress.route` option overrides it.

### The container (`container.ts`)

`ContainerSandbox.create` starts one long-lived container per task and `exec`s every command
into it. Every engine call is an argv array (`@forerunner/platform` `run`); there is no shell
string anywhere. The `run` argv, snapshot-tested in `test/sandbox-container.test.ts`:

```
docker run -d --rm --name forerunner-<task>-<hex8>
  --label forerunner.sandbox=1 --label forerunner.task=<taskId>
  --mount type=bind,src=<worktree>,dst=/work[,relabel=private] --workdir /work
  --network none | --network forerunner-<task>-<hex8>-net   # per NetworkPolicy
  --cpus N --memory Nm --pids-limit N                       # from SandboxLimits, when set
  --security-opt no-new-privileges --cap-drop ALL
  [--user uid:gid]
  [-e HTTP_PROXY=<url> -e HTTPS_PROXY=<url> -e http_proxy=<url> -e https_proxy=<url>
   -e ALL_PROXY=<url> -e NO_PROXY= -e no_proxy=]            # allowlist mode
  -e KEY=VALUE ...                                          # caller's env only
  -e FORERUNNER_SANDBOX=container
  <image> sleep infinity
```

The task container never gets `--add-host` or the engine's default network: in allowlist mode
its only network is the sandbox's own internal one.

**Allowlist mode, step by step.** Before the task container starts:

1. `docker network create --internal --label forerunner.sandbox=1 [--label forerunner.task=…]
   forerunner-<task>-<hex8>-net`. An internal network has no gateway route to the outside and
   no DNS forwarding; containers on it reach only each other.
2. The `EgressProxy` starts on the host with the task allowlist and a fresh per-sandbox token.
3. One of two routes connects the container to the proxy (`EgressRoute`):
   - **gateway** (rootful engines on native Linux): `docker network inspect` gives the
     network's IPv4 gateway, which the host owns; the proxy binds that address (falls back to
     `0.0.0.0` with a `warn` line when the host cannot bind it) and the container's proxy URL
     is `http://forerunner:<token>@<gateway>:<port>`. No extra container. A network without a
     parseable gateway is an `unavailable` error that names `FORERUNNER_EGRESS_ROUTE=sidecar`.
   - **sidecar** (VM-based and rootless engines): the proxy binds `0.0.0.0`; a relay container
     `forerunner-<task>-<hex8>-egress` starts on the engine's default network
     (`bridge` / `podman`, plus `--add-host host.docker.internal:host-gateway` on Docker) with
     `--cap-drop ALL`, `no-new-privileges`, 128 MiB and 64 pids, running `node -e
     <EGRESS_RELAY_SCRIPT>`: a plain TCP relay from port 3128 to
     `host.docker.internal` / `host.containers.internal` (or `FORERUNNER_EGRESS_HOST`) and the
     proxy's port. `docker network connect` joins it to the internal network, `docker inspect`
     reads its address there, and the container's proxy URL is
     `http://forerunner:<token>@<relay address>:3128`. The relay image is the task image
     (it needs `node`) unless `FORERUNNER_EGRESS_IMAGE` names another.
4. The task container starts on the internal network with the proxy variables above.

Anything created before a failure (network, sidecar, proxy) is removed again before the error
is thrown, whether the engine exited non-zero or `run` itself rejected (spawn error, abort).

Commands: `docker exec [-i] --workdir /work/<cwd> [-e K=V ...] <name> timeout -s KILL <s> <argv...>`.
The per-run `env` goes through `stripProxyEnv` first. The coreutils `timeout` wrapper inside
the container is what actually kills a runaway command: the `exec` client dying on the
host-side timeout would not. A command the wrapper killed (exit 124/137 at the deadline) is
reported with `timedOut: true`. Images without coreutils pass `timeoutWrapper: false`.
`destroy()` runs `docker rm -f` on the task container and the sidecar, `docker network rm` on
the internal network and closes the proxy; it is idempotent and the worktree on the host
survives.

`writeFile`/`readFile`/`exists` act on the host side of the bind mount through
`containPathReal`; the container sees the change at once and the other way round.

**Image.** `resolveRunnerImage(configured, env)`: the project or app configuration, then
`FORERUNNER_RUNNER_IMAGE`, then `forerunner-runner:local`. No registry owner is ever assumed.
The image is the runner image from `services/cloud-runner/Dockerfile` (the same image serves
the cloud runner, as the spec asks); build it locally with
`docker build -t forerunner-runner:local -f services/cloud-runner/Dockerfile .`.

### Worktrees (`worktree.ts`)

`new WorktreeManager({ root: appDirs().worktrees })`:

- `create({ repoDir, branch, taskId, base = "HEAD" })` runs
  `git -C <repo> worktree add -B <branch> <root>/<safeSegment(taskId)> <base>` and writes a
  sidecar `<segment>.worktree.json` (task, repo, branch, created_at) next to it. `branch` and
  `base` must be non-empty, without whitespace and not start with `-` (a base such as
  `--detach` would reach git as an option); otherwise `validation`. Creating twice for the same
  task is a `validation` error; remove first.
- `list()` reads the sidecars (and, for a worktree that lost its sidecar, the `.git` file).
- `remove(path, { force })` refuses anything outside the root (`path_not_allowed`), reports
  `not_found` for a directory under the root that is not a worktree (no sidecar and no `.git`
  file) without touching it, and otherwise runs `git worktree remove [--force]`, then
  `git worktree prune`, then deletes the sidecar. Without `force`, a dirty worktree is kept and
  the error says so.

### Network policy and the egress proxy (`egress-proxy.ts`)

`EgressProxy.start({ allow, bindHost, token, onDecision, upstreamTimeoutMs })` is a small Node
HTTP proxy:

- plain `GET http://host/...` requests are forwarded when `host` matches the allowlist,
  otherwise answered `403`;
- `CONNECT host:443` (HTTPS) opens a tunnel for allowed hosts, otherwise `403` and the socket
  closes; TLS stays end-to-end, the proxy only sees the host name;
- every decision goes to `onDecision({ host, port, allowed, method, remote, at })` (the
  executor writes it to the audit log) and to the `sandbox:egress` logger; `stats()` returns
  bytes in/out and allowed/denied counts;
- an allowed upstream that does not connect or answer within `upstreamTimeoutMs` (default
  30 s) gets `504` (`502` when the kernel reports no route at once), so a black-holed host
  cannot pin a tunnel open until the 120 s idle timeout;
- when `token` is set, clients must send `Proxy-Authorization: Basic forerunner:<token>`
  (missing or wrong → `407`, no decision recorded). The token is random per sandbox and only
  stops other containers and host processes on the same private network from borrowing the
  task's allowlist; it grants nothing beyond that allowlist, which is why it is acceptable that
  it appears in the container's `HTTP_PROXY` variable and therefore in `docker inspect` and in
  the host's process list while `docker run` executes. It never enters model context;
- connections from addresses outside loopback / RFC 1918 / link-local / ULA are dropped
  before any request is read (`isPrivateAddress`, overridable with `allowFrom`).

For a container the proxy binds the internal network's gateway (gateway route) or `0.0.0.0`
(sidecar route); `FORERUNNER_EGRESS_BIND` overrides either. For the process sandbox it binds
`127.0.0.1`. Host names in the allowlist are resolved by the proxy on the host, because the
internal network forwards no DNS.

Git, curl, pip, npm, pnpm, cargo and most SDKs honour `HTTP_PROXY`/`HTTPS_PROXY`. Node's
built-in `fetch` does not (Node 22); inside an allowlist sandbox a direct `fetch` fails with
no route (the integration test checks exactly that), and scripts that need the network set
`setGlobalDispatcher(new EnvHttpProxyAgent())` from `undici`, or use `http.request` against the
proxy as the tests do.

### The process sandbox (`process.ts`)

Used only when no engine is reachable (or `FORERUNNER_SANDBOX_ENGINE=process`). It runs the
command as a child process with:

- environment = `scrubEnv(process.env)` (every credential-looking variable removed, `PATH`,
  `HOME`, locale kept) + the sandbox `env` + the per-run `env`, then the proxy variables and
  `FORERUNNER_SANDBOX=process` on top (a run cannot override the proxy);
- `cwd` pinned inside the worktree through `containPathReal` (a link leaving the worktree is
  `path_not_allowed`, a missing directory `not_found`);
- wall-clock and output caps from the platform runner (`killTree` on timeout);
- an `EgressProxy` on `127.0.0.1` with the task allowlist, or an empty allowlist for
  `{ mode: "none" }` so every attempt by a well-behaved client is refused and audited.

It cannot stop a process from opening sockets directly, reading other host paths or seeing the
scrubbed-but-present environment; that is why it logs
`sandbox: process (no container engine)` at `warn` on creation, why `createSandbox` returns
the same line in `warnings` for the session log, and why tier 2+ tasks refuse it.

### Fake (`fake.ts`)

`new FakeSandbox({ files, rules, defaultResult, network })` keeps files in a `Map` keyed by
posix relative path (lexical containment), returns scripted `RunResult`s
(`script(match, result)`, later scripts win; `match` is a command name, a substring, a RegExp
or a predicate) and records `calls`. Executors and tools test against it.

### Configuration

| Variable | Effect | Default |
| --- | --- | --- |
| `FORERUNNER_SANDBOX_ENGINE` | `docker`, `podman` (probe only that) or `process` (skip containers) | auto |
| `FORERUNNER_RUNNER_IMAGE` | image when the project/app config names none | `forerunner-runner:local` |
| `FORERUNNER_EGRESS_ROUTE` | `gateway` or `sidecar` | `gateway` on rootful Linux engines, else `sidecar` |
| `FORERUNNER_EGRESS_BIND` | interface the proxy listens on for containers | the internal network's gateway (gateway route) / `0.0.0.0` (sidecar) |
| `FORERUNNER_EGRESS_HOST` | gateway route: host in the container's proxy URL; sidecar route: host the relay connects to | the gateway address / `host.docker.internal` / `host.containers.internal` |
| `FORERUNNER_EGRESS_IMAGE` | image for the relay sidecar (needs `node`) | the task image |
| `FORERUNNER_SANDBOX_SELINUX` | `1` adds `relabel=private` to the mount (Fedora, SELinux) | off |

Per-task inputs come from the task and the project: `limits` (cpus, memoryMb, pidsLimit,
timeoutMs), `network` (the capability token's `allowedDomains` become the allowlist; an empty
list is `{ mode: "none" }`), `riskTier`, `allowProcessSandbox`.

## How to change it

- **Change the image.** Edit `services/cloud-runner/Dockerfile`, rebuild
  (`docker build -t forerunner-runner:local -f services/cloud-runner/Dockerfile .`), or set
  `FORERUNNER_RUNNER_IMAGE` / the project setting to a published tag. The sandbox needs
  `sleep`, `timeout` (coreutils), `node` for the relay sidecar (or set `FORERUNNER_EGRESS_IMAGE`)
  and whatever the task runs; nothing else is assumed.
- **Add a limit.** Extend `SandboxLimits`, add the flag in `buildContainerRunArgv` and the
  snapshot in `test/sandbox-container.test.ts`; the process sandbox should enforce or document
  it.
- **Add an engine.** Add a probe in `detect.ts`, the `hostAlias` and `defaultNetworkName` in
  `container.ts`, the route choice in `defaultEgressRoute`, a row in the table above and argv
  snapshots.
- **Add an egress route.** Extend `EgressRoute`, the branch in `ContainerSandbox.create` that
  produces the proxy URL as the container sees it, `defaultEgressRoute`, and a fake-engine
  test in `test/sandbox-container.test.ts` that records the engine calls in order. Keep the
  rule that the task container only ever joins the internal network.
- **Change containment.** `contain.ts` is the single place; both adapters and the symlink
  fixtures in `test/sandbox-contain.test.ts` depend on it. Never relax `containPathReal` to the
  lexical check for a host-side read or write.
- **Change the tier rule.** `createSandbox` in `factory.ts` and the test
  "refuses the process sandbox for risk tier >= 2".

## Tests

Unit (`pnpm vitest run --project unit packages/runtime/test/sandbox-`, no engine, no network
beyond loopback):

- `sandbox-contain.test.ts`: lexical containment accepts inside paths, refuses `..`,
  absolute, drive, UNC and NUL paths; a symlink fixture (link leaving the worktree, link
  staying inside, dangling link out, self-loop; junctions on Windows): read, write and exists
  through an escaping link refused with `path_not_allowed`, the outside file untouched, inside
  links followed to their real path, paths that do not exist yet allowed, missing worktree
  `not_found`.
- `sandbox-detect.test.ts`: docker found with rootless flag, podman fallback, daemon-down
  reason, never throws, TTL cache on `SimulatedClock`, the three override values, unknown
  override ignored.
- `sandbox-worktree.test.ts`: real temp git repository: create on a new branch under the safe
  segment, list, remove and prune, double create refused, removal outside the root refused,
  dirty worktree kept without force, sidecar loss, explicit base, `--detach`/`-q`/empty base
  and `--orphan` branch refused before git runs, `remove` of a non-worktree directory
  `not_found` with and without force.
- `sandbox-egress.test.ts`: local target server: allowed host forwarded with bytes counted,
  blocked host 403 without contacting it, wildcard patterns, 407 without token, CONNECT
  tunnel for an allowed host, CONNECT refused with 403, source filter, deny-all, URL/env
  helpers, `isPrivateAddress`; upstream timeout: a silent upstream gets 504 within the budget
  and its socket is closed, a black-holed CONNECT answers 502/504 instead of hanging.
- `sandbox-container.test.ts`: argv snapshots for docker none / docker allowlist (internal
  network, proxy variables, no `--add-host`, no bridge) / podman with SELinux relabel; network
  create and sidecar argv snapshots (locked down, relay script a program argument, podman
  without `--add-host`); gateway and container-address parsers; `stripProxyEnv`; image
  precedence with no hardcoded owner; with a recorded fake engine: create/exec/destroy
  (timeout wrapper, cwd, env, stdin, cap by limits, idempotent destroy), gateway route order
  (`network create`, `network inspect`, `run`) and teardown order with the proxy port closed,
  sidecar route order (`network create`, sidecar `run`, `network connect`, `inspect`, task
  `run`) with the relay address in the proxy URL, custom sidecar image and advertised host,
  cleanup of network/sidecar/proxy when the task `run` exits non-zero or rejects, refusal when
  no gateway can be parsed, per-run proxy variables stripped, wrapper kill → `timedOut`,
  host-side file access with containment and the symlink fixture.
- `sandbox-process.test.ts`: env scrubbed (credential-shaped fixtures built by concatenation),
  PATH kept, proxy variables set and not overridable, cwd pinned and escapes refused, timeout,
  output cap, exit codes as results, deny-all proxy for `none`, LF writes, warning logged, file
  access and cwd through an escaping symlink refused while an inside link is followed.
- `sandbox-fake.test.ts`, `sandbox-factory.test.ts`: fake behaviour; container picked when an
  engine answers (image from env, `--user` and `HOME` on Linux), fallback warning, tier rule,
  process sandbox with warning, `FORERUNNER_SANDBOX_ENGINE=process`; `defaultEgressRoute` per
  platform and rootless flag; the factory creates the internal network and passes
  `FORERUNNER_EGRESS_ROUTE/BIND/HOST/IMAGE` through to the container.

Integration (`pnpm vitest run --project integration packages/runtime/test/sandbox.integration.test.ts`):
with a reachable engine and `node:22-bookworm-slim` (pulled on demand) it runs
`node -e "console.log(1+1)"` → `2`, checks host→container and container→host through the
mount, that a symlink the command plants (`ln -s /etc etc-link`) cannot redirect a host-side
read, stdin, env, `CapEff` all zero and `NoNewPrivs`, that only `/work` is mounted from the
host, the in-container timeout, and that `destroy` removes the container; proves
`--network none` blocks `fetch`; and, in allowlist mode on the route the factory would pick,
that the sandbox network is internal, a proxied request to an allowed host (a loopback target
on the host, allowlisted as `127.0.0.1`) returns 200 and a blocked host 403 with both decisions
audited, that a direct `fetch` from the container fails, that the host's loopback service is
unreachable without the proxy, that the proxy answers 407 without the token, and that the
network and the sidecar are gone after `destroy`. Without an engine or without the image
(network policy) the suite skips; on the sidecar route without `host-gateway` the allowlist
test skips, each with the reason in its name. Linux CI runs it with the Docker service (gateway
route); the sidecar route is covered by the fake-engine tests and was run by hand against the
same daemon. Windows CI covers the process sandbox and the selection logic.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `sandbox: process (no container engine): docker: Cannot connect to the Docker daemon ...` | Daemon not running or the user is not in the `docker` group. Start Docker Desktop / `systemctl --user start docker` (rootless) / `sudo systemctl start docker`, then `fr doctor`. The cache clears after 60 s. |
| Same with `docker not on PATH; podman not on PATH` | Install Docker Desktop (Windows: WSL2 backend enabled) or Podman; on Windows make sure the CLI is on PATH for the user running Forerunner, not only inside WSL. |
| `task at risk tier 2 needs a container sandbox and none is reachable` | By design. Fix the engine, lower the tier, or turn on the project setting `allowProcessSandbox` (and accept the weaker sandbox). |
| `cannot determine the gateway address of network ...; set FORERUNNER_EGRESS_ROUTE=sidecar` | The engine reported no IPv4 gateway for the internal network (IPv6-only or custom IPAM). Use the sidecar route. |
| `warn` line `egress proxy cannot bind the network gateway; listening on the fallback` | The host does not own the bridge (engine in a VM, rootless, or a remote daemon over a socket): the gateway route was chosen but cannot work reliably. Set `FORERUNNER_EGRESS_ROUTE=sidecar`. |
| Sidecar route: `unable to derive the IP value for host-gateway` | Docker older than 20.10 or no bridge with an address (seen in CI sandboxes). `--network none` tasks still work; the integration allowlist test skips this case. |
| Sidecar exits at once / `node: not found` | The task image has no `node`; set `FORERUNNER_EGRESS_IMAGE` to any image that has it (for example `node:22-bookworm-slim`). |
| Windows: allowlist tasks fail with connection refused or time out | Docker Desktop resolves `host.docker.internal` to the Windows host; the proxy must be allowed through Windows Firewall for node, or set `FORERUNNER_EGRESS_HOST` to the WSL vEthernet address. For Podman the default is `host.containers.internal`. |
| An allowlisted host answers `502`/`504` through the proxy | The decision was "allowed" (and audited); the host's resolver could not resolve the name, or the upstream did not connect or answer within 30 s. Fix DNS or the target; it is not an allowlist problem. |
| `sandbox path refused (symlink x leaves the worktree)` | A link inside the worktree points outside it. By design: the task works on files inside the worktree only; copy what it needs into the repository. |
| Rootless Podman: `permission denied` on files in the worktree or `relabel` errors | SELinux: set `FORERUNNER_SANDBOX_SELINUX=1`. User mapping is automatic in rootless mode; do not pass `--user`. The sidecar route is chosen automatically. |
| Files in the worktree owned by root after a task (rootful Docker) | The factory passes `--user uid:gid` on Linux; if you created the sandbox directly, pass `user`. |
| `Unable to find image 'forerunner-runner:local'` | Build it (see "Change the image") or set `FORERUNNER_RUNNER_IMAGE`. The warning `sandbox: image not configured` in the session log points here. |
| `timeout: not found` on every command | The image has no coreutils; pass `timeoutWrapper: false` (the host-side cap still applies but cannot kill the in-container process). |
| `worktree already exists, remove it first` | A previous session crashed. `WorktreeManager.list()` shows it; `remove(path, { force: true })` after saving anything needed. |
| `not a worktree (no sidecar and no .git file)` | `remove()` only removes what `create()` made. Delete a stray directory under the worktree root by hand. |
| Containers or networks named `forerunner-*` left behind | A crash before `destroy`. `docker ps -a --filter label=forerunner.sandbox=1` and `docker network ls --filter label=forerunner.sandbox=1` list them; `rm -f` / `network rm` them. |

## Known issues

- Node 22's global `fetch` ignores proxy variables, so node scripts inside an allowlist
  sandbox get no network at all unless they use an explicit `EnvHttpProxyAgent` or talk to
  the proxy directly. That is the intended failure mode, but tasks that script `fetch` need to
  know it.
- The internal network forwards no DNS; names are resolved by the proxy on the host, so the
  host's resolver decides what an allowlisted name means.
- On the gateway route, when the host cannot bind the gateway address the proxy falls back to
  `0.0.0.0` and only warns; whether the container can then reach it depends on the engine's
  routing. Prefer the sidecar route on such hosts.
- Windows has no `O_NOFOLLOW`: the symlink walk refuses planted links, but a link created
  between the walk and the final open is not caught by the open itself.
- The sidecar route runs `node` from the task image; an image without it needs
  `FORERUNNER_EGRESS_IMAGE`. The relay is a plain TCP forwarder; the proxy (with the token and
  the source filter) is still the only place that decides.
- The process sandbox is a stand-in: no filesystem isolation, no socket filtering, no cgroup
  limits (cpus/memoryMb/pidsLimit are ignored and documented as container-only).
- `killTree` on Linux falls back to the direct pid for non-detached children (see
  platform-notes); the container path kills through `docker rm -f` and the in-container
  `timeout`, so this only concerns the process sandbox.
- Podman on Windows is covered by the same argv path but has not been run in CI (no Windows
  CI engine); the selection logic and argv snapshots are.
- ADR 0007 still describes the interface as `exec/copyIn/copyOut` and the allowlist as an
  egress sidecar only; the built interface is `run/writeFile/readFile/exists` and the sidecar
  is one of two routes (the gateway route needs no extra container). The ADR amendment is
  pending.

## Requirements covered

- S.7 (Sandboxing: Docker with only the worktree mounted and a network allowlist): container
  adapter with the worktree as the only mount and symlink-aware host-side file helpers,
  `--network none`, allowlist enforced by the internal network with the egress proxy as the
  only exit and an audit of every decision; `packages/runtime/test/sandbox-contain.test.ts`,
  `sandbox-container.test.ts`, `sandbox-egress.test.ts`, `sandbox-factory.test.ts`,
  `sandbox.integration.test.ts`.
- Architecture item 9 and the platform table "Sandboxes" row (Docker Desktop on WSL2 or Podman
  on Windows; Docker or Podman rootless on Linux): `detect.ts`, `factory.ts`, the per-OS table.
- M.2, "tests in Docker" clause: `Sandbox.run` is what the PR task executor uses to run a
  project's tests in the runner image; the rest of M.2 (PR flow, critic tier, approval) lives
  in capabilities and critic.
- ADR 0007 consequences: the process sandbox warning in the session log and the tier 2+ rule
  (`sandbox-process.test.ts`, `sandbox-factory.test.ts`).
