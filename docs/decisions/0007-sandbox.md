# 0007 — Sandboxes: Docker or Podman through one adapter, process sandbox as the stand-in

Date: 2026-10-20
Status: accepted

## Context

Spec: code runs in Docker with only the task's worktree mounted and a network allowlist;
Windows uses Docker Desktop on WSL2 or Podman, Linux Docker or Podman rootless. The build
container has a Docker daemon only when started by hand; CI runners on Windows have no Linux
container engine for `docker run` of our image; developers may have Podman.

## Decision

`packages/runtime/src/sandbox/` defines `Sandbox { run(argv, opts), writeFile, readFile, exists, destroy }`
(as built; the first draft named `exec`, `copyIn` and `copyOut`, which collapsed into `run` and the two file calls)
with three adapters chosen by `detectSandboxEngine()`:

1. `ContainerSandbox`: `docker` or `podman` CLI (argv arrays, no shell). Image is the runner
   image from `services/cloud-runner/Dockerfile`. Mounts only the worktree, `--network none`
   by default, or a per-task allowlist enforced by the kernel: the task container joins a
   per-sandbox `--internal` network whose only way out is an egress proxy sidecar
   (`forerunner-egress`) that allows the token's `allowedDomains` and nothing else. CPU and memory limits
   from the task.
2. `ProcessSandbox`: a child process with a scrubbed environment, `cwd` pinned to the worktree,
   path checks by the enforcement hooks, no secrets in env, wall-clock and output caps. Used
   when no container engine is reachable. It is weaker and says so: the session log records
   `sandbox: process (no container engine)`, and tasks at risk tier 2+ refuse to run code in it
   unless the project setting `allowProcessSandbox` is on.
3. `FakeSandbox`: in-memory, for unit tests.

Integration tests run the container adapter when an engine is reachable and skip visibly
otherwise; CI on Linux runs it with the Docker service.

## Consequences

- The same image serves the cloud runner and the sandbox, as the spec asks.
- Windows CI exercises the process sandbox and the adapter selection logic; container
  behaviour is covered on Linux CI.

## Alternatives considered

- gVisor or Firecracker: stronger isolation, not available on Windows developer machines.
- WSL2-only on Windows: covered by Docker Desktop, no separate code path.
