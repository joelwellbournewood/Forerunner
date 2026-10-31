import type { RunOptions, RunResult } from "@forerunner/platform";
import { join, run as platformRun } from "@forerunner/platform";
import { CONTAINER_WORKDIR } from "./container.ts";
import { DOCKER_INFO_FORMAT } from "./detect.ts";
import type { RunFn, WhichFn } from "./types.ts";

/**
 * A container engine stand-in for tests (U-079): answers the `docker` (or `podman`) argv the
 * detection, the readiness check, the download and `ContainerSandbox` send, from a state the
 * test sets, so no test depends on the machine's Docker. Every call is recorded.
 *
 * - `installed: false`: the CLI is not on PATH; `running: false`: `info` fails as a stopped
 *   Docker Desktop does; `osType: "windows"`: Docker Desktop on Windows containers (`run` of a
 *   bind mount to /work fails as it does there).
 * - `images`: the images on this computer; `registry`: what `pull` can fetch (layers, size),
 *   any other name is "manifest unknown"; `deniedPulls` answer "denied" (a private package).
 * - `run -d` starts a pretend container that remembers its worktree; `exec` runs the command
 *   on the host in that worktree (the `timeout` wrapper dropped), so a task's commands work.
 */
export interface FakeEngineState {
  engine: "docker" | "podman";
  installed: boolean;
  running: boolean;
  osType: "linux" | "windows";
  version: string;
  rootless: boolean;
  images: Set<string>;
  registry: Map<string, { layers: number; bytes: number }>;
  deniedPulls: Set<string>;
}

export interface FakeEngineOptions {
  engine?: "docker" | "podman";
  installed?: boolean;
  running?: boolean;
  osType?: "linux" | "windows";
  version?: string;
  rootless?: boolean;
  images?: Iterable<string>;
  registry?: Record<string, { layers?: number; bytes?: number }>;
  deniedPulls?: Iterable<string>;
}

function result(partial: Partial<RunResult>): RunResult {
  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    durationMs: 1,
    ...partial,
  };
}

export class FakeContainerEngine {
  readonly state: FakeEngineState;
  readonly calls: string[][] = [];
  /** Pretend containers: name -> host worktree. */
  readonly containers = new Map<string, string>();
  private held: { release: () => void; promise: Promise<void> } | null = null;

  constructor(opts: FakeEngineOptions = {}) {
    this.state = {
      engine: opts.engine ?? "docker",
      installed: opts.installed ?? true,
      running: opts.running ?? true,
      osType: opts.osType ?? "linux",
      version: opts.version ?? "27.3.1",
      rootless: opts.rootless ?? false,
      images: new Set(opts.images ?? []),
      registry: new Map(
        Object.entries(opts.registry ?? {}).map(([k, v]) => [
          k,
          { layers: v.layers ?? 3, bytes: v.bytes ?? 300_000_000 },
        ]),
      ),
      deniedPulls: new Set(opts.deniedPulls ?? []),
    };
  }

  /** Change the engine's state mid-test (Docker started, switched to Linux, image removed). */
  set(patch: Partial<Omit<FakeEngineOptions, "images" | "registry">>): void {
    Object.assign(this.state, patch);
  }

  /** Hold every pull at its first layer until the returned release is called. */
  holdPulls(): () => void {
    let release = () => {};
    const promise = new Promise<void>((r) => {
      release = r;
    });
    this.held = { release, promise };
    return () => {
      this.held = null;
      release();
    };
  }

  /** The calls of one subcommand (`run`, `pull`, `image`, ...). */
  callsOf(sub: string): string[][] {
    return this.calls.filter((c) => c[1] === sub);
  }

  readonly which: WhichFn = async (cmd) =>
    this.state.installed && cmd === this.state.engine ? `/usr/bin/${cmd}` : null;

  readonly run: RunFn = async (argv: readonly string[], opts?: RunOptions) => {
    this.calls.push([...argv]);
    const s = this.state;
    if (argv[0] !== s.engine || !s.installed)
      return result({ code: 127, stderr: `${argv[0]}: command not found` });
    if (!s.running)
      return result({
        code: 1,
        stderr:
          "error during connect: this error may indicate that the docker daemon is not running",
      });
    const sub = argv[1];
    const fail = (stderr: string, code = 1) => result({ code, stderr });
    switch (sub) {
      case "info": {
        if (s.engine === "podman") return result({ stdout: `${s.version}|${s.rootless}\n` });
        const format = argv[argv.indexOf("--format") + 1];
        const security = s.rootless ? "[name=seccomp name=rootless]" : "[name=seccomp]";
        return result({
          stdout:
            format === DOCKER_INFO_FORMAT
              ? `${s.version}|${security}|${s.osType}\n`
              : `${s.version}|${security}\n`,
        });
      }
      case "image": {
        const image = argv.at(-1) ?? "";
        return s.images.has(image)
          ? result({ stdout: `sha256:${"0".repeat(64)}\n` })
          : fail(`Error response from daemon: No such image: ${image}`);
      }
      case "manifest": {
        const image = argv.at(-1) ?? "";
        const entry = s.registry.get(image);
        if (!entry) return fail(`no such manifest: ${image}`);
        const each = Math.floor(entry.bytes / entry.layers);
        const layers = Array.from({ length: entry.layers }, () => ({ size: each }));
        return result({
          stdout: JSON.stringify([
            {
              Descriptor: { platform: { os: "linux", architecture: "amd64" } },
              SchemaV2Manifest: { layers },
            },
            {
              Descriptor: { platform: { os: "linux", architecture: "arm64" } },
              SchemaV2Manifest: { layers },
            },
          ]),
        });
      }
      case "pull": {
        const image = argv.at(-1) ?? "";
        if (s.deniedPulls.has(image))
          return fail(`Error response from daemon: Head "https://${image}": denied`);
        const entry = s.registry.get(image);
        if (!entry)
          return fail(
            `Error response from daemon: manifest for ${image} not found: manifest unknown`,
          );
        const ids = Array.from({ length: entry.layers }, (_, i) =>
          `${i}`.padStart(12, "a").slice(0, 12),
        );
        const out = (line: string) => opts?.onStdout?.(`${line}\n`);
        out(`${image.split(":").at(-1)}: Pulling from ${image.split(":")[0]}`);
        for (const id of ids) out(`${id}: Pulling fs layer`);
        const first = ids[0];
        if (first) out(`${first}: Pull complete`);
        if (this.held) await this.held.promise;
        for (const id of ids.slice(1)) out(`${id}: Pull complete`);
        out(`Status: Downloaded newer image for ${image}`);
        s.images.add(image);
        return result({ stdout: `${image}\n` });
      }
      case "run": {
        const image = argv.at(-3) ?? "";
        const mount = argv[argv.indexOf("--mount") + 1] ?? "";
        if (s.osType === "windows")
          return fail(
            `docker: Error response from daemon: invalid mount config for type "bind": invalid mount path: '${CONTAINER_WORKDIR}'.`,
            125,
          );
        if (!s.images.has(image))
          return fail(
            `Unable to find image '${image}' locally\ndocker: Error response from daemon: pull access denied for ${image}, repository does not exist or may require 'docker login'.`,
            125,
          );
        const name = argv[argv.indexOf("--name") + 1] ?? "";
        const src = /src=([^,]+)/.exec(mount)?.[1] ?? "";
        this.containers.set(name, src);
        return result({ stdout: `${"c".repeat(64)}\n` });
      }
      case "exec": {
        // docker exec [-i] --workdir /work/<cwd> [-e K=V ...] <name> [timeout -s KILL <s>] argv...
        let i = 2;
        let workdir = CONTAINER_WORKDIR;
        const env: Record<string, string> = {};
        while (i < argv.length) {
          const a = argv[i] ?? "";
          if (a === "-i") i++;
          else if (a === "--workdir") {
            workdir = argv[i + 1] ?? workdir;
            i += 2;
          } else if (a === "-e") {
            const [k, ...v] = (argv[i + 1] ?? "").split("=");
            if (k) env[k] = v.join("=");
            i += 2;
          } else break;
        }
        const name = argv[i] ?? "";
        let rest = argv.slice(i + 1);
        if (rest[0] === "timeout") rest = rest.slice(4);
        const root = this.containers.get(name);
        if (!root) return fail(`Error response from daemon: No such container: ${name}`);
        const rel = workdir.slice(CONTAINER_WORKDIR.length).split("/").filter(Boolean);
        const cwd = rel.length ? join(root, ...rel) : root;
        return platformRun(rest, {
          cwd,
          env: { PATH: process.env.PATH ?? "", ...env },
          allowFailure: true,
          timeoutMs: opts?.timeoutMs,
          input: opts?.input,
          maxOutputBytes: opts?.maxOutputBytes,
          signal: opts?.signal,
        });
      }
      case "rm":
        for (const n of argv.slice(3)) this.containers.delete(n);
        return result({});
      case "network": {
        if (argv[2] === "inspect")
          return result({
            stdout: JSON.stringify([{ IPAM: { Config: [{ Gateway: "127.0.0.1" }] } }]),
          });
        return result({});
      }
      case "inspect":
        return result({ stdout: JSON.stringify({}) });
      default:
        return fail(`fake engine: unexpected ${argv.join(" ")}`);
    }
  };
}
