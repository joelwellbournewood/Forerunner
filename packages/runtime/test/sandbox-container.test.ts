import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { isForerunnerError, join, type RunOptions, type RunResult } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildContainerRunArgv,
  buildEgressSidecarArgv,
  buildNetworkCreateArgv,
  CONTAINER_WORKDIR,
  ContainerSandbox,
  DEFAULT_RUNNER_IMAGE,
  EGRESS_RELAY_PORT,
  EGRESS_RELAY_SCRIPT,
  parseContainerAddress,
  parseNetworkGateway,
  resolveRunnerImage,
  stripProxyEnv,
} from "../src/sandbox/container.ts";

const LIMITS = { cpus: 2, memoryMb: 2048, pidsLimit: 256, timeoutMs: 30_000 };

function ok(partial: Partial<RunResult> = {}): RunResult {
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

const DOCKER_NET_JSON = JSON.stringify([
  {
    Name: "x",
    Internal: true,
    IPAM: { Config: [{ Subnet: "127.0.0.0/8", Gateway: "127.0.0.1" }] },
  },
]);
const PODMAN_NET_JSON = JSON.stringify([
  { name: "x", internal: true, subnets: [{ subnet: "10.89.0.0/24", gateway: "127.0.0.1" }] },
]);

/**
 * A fake engine that answers like docker/podman would: ok for everything, JSON for the two
 * inspect calls. `reply` can override any call.
 */
function recorder(reply: (argv: readonly string[]) => RunResult | undefined = () => undefined) {
  const calls: { argv: string[]; opts: RunOptions | undefined }[] = [];
  const run = async (argv: readonly string[], opts?: RunOptions) => {
    calls.push({ argv: [...argv], opts });
    const custom = reply(argv);
    if (custom) return custom;
    if (argv[1] === "network" && argv[2] === "inspect") {
      return ok({ stdout: argv[0] === "docker" ? DOCKER_NET_JSON : PODMAN_NET_JSON });
    }
    if (argv[1] === "inspect") {
      const netName = argv.at(-1)?.replace(/-egress$/, "-net") ?? "";
      return ok({
        stdout: JSON.stringify({
          bridge: { IPAddress: "172.17.0.5" },
          [netName]: { IPAddress: "10.99.0.3" },
        }),
      });
    }
    return ok();
  };
  return { calls, run };
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.on("connect", () => {
      s.destroy();
      r(true);
    });
    s.on("error", () => r(false));
  });
}

describe("buildContainerRunArgv", () => {
  const base = {
    image: "forerunner-runner:local",
    name: "forerunner-task-1-abcd1234",
    worktree: join("home", "me", "worktrees", "task-1"),
    limits: LIMITS,
    taskId: "task-1",
  };

  it("docker, network none (snapshot)", () => {
    expect(
      buildContainerRunArgv({
        ...base,
        engine: "docker",
        network: { mode: "none" },
        env: { CI: "1" },
      }),
    ).toEqual([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      "forerunner-task-1-abcd1234",
      "--label",
      "forerunner.sandbox=1",
      "--label",
      "forerunner.task=task-1",
      "--mount",
      `type=bind,src=${base.worktree},dst=/work`,
      "--workdir",
      "/work",
      "--network",
      "none",
      "--cpus",
      "2",
      "--memory",
      "2048m",
      "--pids-limit",
      "256",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "-e",
      "CI=1",
      "-e",
      "FORERUNNER_SANDBOX=container",
      "forerunner-runner:local",
      "sleep",
      "infinity",
    ]);
  });

  it("docker, allowlist: the sandbox's internal network and proxy variables, no host alias (snapshot)", () => {
    const proxyUrl = "http://forerunner:tok@172.19.0.1:40001";
    const argv = buildContainerRunArgv({
      ...base,
      engine: "docker",
      network: { mode: "allowlist", domains: ["github.com", "*.npmjs.org"] },
      proxyUrl,
      networkName: "forerunner-task-1-abcd1234-net",
      user: "1000:1000",
    });
    expect(argv).toEqual([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      "forerunner-task-1-abcd1234",
      "--label",
      "forerunner.sandbox=1",
      "--label",
      "forerunner.task=task-1",
      "--mount",
      `type=bind,src=${base.worktree},dst=/work`,
      "--workdir",
      "/work",
      "--network",
      "forerunner-task-1-abcd1234-net",
      "--cpus",
      "2",
      "--memory",
      "2048m",
      "--pids-limit",
      "256",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--user",
      "1000:1000",
      "-e",
      `HTTP_PROXY=${proxyUrl}`,
      "-e",
      `HTTPS_PROXY=${proxyUrl}`,
      "-e",
      `http_proxy=${proxyUrl}`,
      "-e",
      `https_proxy=${proxyUrl}`,
      "-e",
      `ALL_PROXY=${proxyUrl}`,
      "-e",
      "NO_PROXY=",
      "-e",
      "no_proxy=",
      "-e",
      "FORERUNNER_SANDBOX=container",
      "forerunner-runner:local",
      "sleep",
      "infinity",
    ]);
    // The task container never gets a route to the host: no host-gateway alias, no bridge.
    expect(argv).not.toContain("--add-host");
    expect(argv).not.toContain("bridge");
  });

  it("podman: same shape, optional SELinux relabel (snapshot)", () => {
    const proxyUrl = "http://forerunner:tok@10.89.0.1:40002";
    const argv = buildContainerRunArgv({
      ...base,
      engine: "podman",
      network: { mode: "allowlist", domains: ["github.com"] },
      proxyUrl,
      networkName: "forerunner-task-1-abcd1234-net",
      selinuxRelabel: true,
      limits: { timeoutMs: 1000 },
    });
    expect(argv).toEqual([
      "podman",
      "run",
      "-d",
      "--rm",
      "--name",
      "forerunner-task-1-abcd1234",
      "--label",
      "forerunner.sandbox=1",
      "--label",
      "forerunner.task=task-1",
      "--mount",
      `type=bind,src=${base.worktree},dst=/work,relabel=private`,
      "--workdir",
      "/work",
      "--network",
      "forerunner-task-1-abcd1234-net",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "-e",
      `HTTP_PROXY=${proxyUrl}`,
      "-e",
      `HTTPS_PROXY=${proxyUrl}`,
      "-e",
      `http_proxy=${proxyUrl}`,
      "-e",
      `https_proxy=${proxyUrl}`,
      "-e",
      `ALL_PROXY=${proxyUrl}`,
      "-e",
      "NO_PROXY=",
      "-e",
      "no_proxy=",
      "-e",
      "FORERUNNER_SANDBOX=container",
      "forerunner-runner:local",
      "sleep",
      "infinity",
    ]);
  });

  it("refuses allowlist mode without the internal network, invalid env names and a comma in the worktree path", () => {
    expect(() =>
      buildContainerRunArgv({
        ...base,
        engine: "docker",
        network: { mode: "allowlist", domains: ["github.com"] },
        proxyUrl: "http://x:1",
      }),
    ).toThrow(/internal network/);
    expect(() =>
      buildContainerRunArgv({
        ...base,
        engine: "docker",
        network: { mode: "none" },
        env: { "BAD NAME": "x" },
      }),
    ).toThrow(/invalid environment variable name/);
    expect(() =>
      buildContainerRunArgv({
        ...base,
        engine: "docker",
        network: { mode: "none" },
        worktree: "a,b",
      }),
    ).toThrow(/comma/);
  });
});

describe("network and sidecar argv builders", () => {
  it("creates an internal, labelled network (snapshot)", () => {
    expect(buildNetworkCreateArgv("docker", "forerunner-t-abcd1234-net", "t")).toEqual([
      "docker",
      "network",
      "create",
      "--internal",
      "--label",
      "forerunner.sandbox=1",
      "--label",
      "forerunner.task=t",
      "forerunner-t-abcd1234-net",
    ]);
    expect(buildNetworkCreateArgv("podman", "n")).toEqual([
      "podman",
      "network",
      "create",
      "--internal",
      "--label",
      "forerunner.sandbox=1",
      "n",
    ]);
  });

  it("runs the relay sidecar on the engine's default network, locked down, relaying to the host proxy (snapshot)", () => {
    expect(
      buildEgressSidecarArgv({
        engine: "docker",
        image: "forerunner-runner:local",
        name: "forerunner-t-abcd1234-egress",
        taskId: "t",
        upstreamHost: "host.docker.internal",
        upstreamPort: 40001,
        user: "1000:1000",
      }),
    ).toEqual([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      "forerunner-t-abcd1234-egress",
      "--label",
      "forerunner.sandbox=1",
      "--label",
      "forerunner.role=egress",
      "--label",
      "forerunner.task=t",
      "--network",
      "bridge",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--memory",
      "128m",
      "--pids-limit",
      "64",
      "--user",
      "1000:1000",
      "-e",
      "FR_EGRESS_UPSTREAM_HOST=host.docker.internal",
      "-e",
      "FR_EGRESS_UPSTREAM_PORT=40001",
      "-e",
      `FR_EGRESS_LISTEN_PORT=${EGRESS_RELAY_PORT}`,
      "forerunner-runner:local",
      "node",
      "-e",
      EGRESS_RELAY_SCRIPT,
    ]);
    const podman = buildEgressSidecarArgv({
      engine: "podman",
      image: "img",
      name: "s",
      upstreamHost: "host.containers.internal",
      upstreamPort: 1,
    });
    expect(podman[podman.indexOf("--network") + 1]).toBe("podman");
    expect(podman).not.toContain("--add-host");
    // The relay is a program argument, never a shell string: no interpolation of host/port.
    expect(EGRESS_RELAY_SCRIPT).not.toContain("${");
    expect(EGRESS_RELAY_SCRIPT).toContain("FR_EGRESS_UPSTREAM_HOST");
  });

  it("parses the gateway from docker and podman network inspect output", () => {
    expect(parseNetworkGateway(DOCKER_NET_JSON)).toBe("127.0.0.1");
    expect(
      parseNetworkGateway(
        JSON.stringify([
          { IPAM: { Config: [{ Subnet: "172.19.0.0/16", Gateway: "172.19.0.1" }] } },
        ]),
      ),
    ).toBe("172.19.0.1");
    expect(parseNetworkGateway(PODMAN_NET_JSON)).toBe("127.0.0.1");
    expect(
      parseNetworkGateway(
        JSON.stringify([
          { subnets: [{ subnet: "fd00::/64", gateway: "fd00::1" }, { gateway: "10.89.1.1" }] },
        ]),
      ),
    ).toBe("10.89.1.1");
    expect(parseNetworkGateway("[]")).toBeNull();
    expect(parseNetworkGateway("not json")).toBeNull();
    expect(parseNetworkGateway(JSON.stringify([{ IPAM: { Config: [] } }]))).toBeNull();
  });

  it("parses a container's address on one network", () => {
    const json = JSON.stringify({
      bridge: { IPAddress: "172.17.0.5" },
      n: { IPAddress: "10.1.2.3" },
    });
    expect(parseContainerAddress(json, "n")).toBe("10.1.2.3");
    expect(parseContainerAddress(json, "other")).toBeNull();
    expect(parseContainerAddress("{", "n")).toBeNull();
    expect(parseContainerAddress(JSON.stringify({ n: { IPAddress: "" } }), "n")).toBeNull();
  });

  it("stripProxyEnv drops only the variables the sandbox owns", () => {
    expect(
      stripProxyEnv({
        HTTPS_PROXY: "http://evil:1",
        NO_PROXY: "*",
        no_proxy: "*",
        all_proxy: "x",
        KEEP: "1",
      }),
    ).toEqual({ KEEP: "1" });
    expect(stripProxyEnv()).toEqual({});
  });
});

describe("resolveRunnerImage", () => {
  it("prefers configuration, then FORERUNNER_RUNNER_IMAGE, then the local fallback", () => {
    expect(resolveRunnerImage("ghcr.io/someone/runner:1", { FORERUNNER_RUNNER_IMAGE: "x" })).toBe(
      "ghcr.io/someone/runner:1",
    );
    expect(resolveRunnerImage(undefined, { FORERUNNER_RUNNER_IMAGE: "registry.example/r:2" })).toBe(
      "registry.example/r:2",
    );
    expect(resolveRunnerImage("  ", {})).toBe(DEFAULT_RUNNER_IMAGE);
    expect(DEFAULT_RUNNER_IMAGE).toBe("forerunner-runner:local");
    expect(DEFAULT_RUNNER_IMAGE).not.toMatch(/ghcr\.io|docker\.io/);
  });
});

describe("ContainerSandbox with a fake engine", () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await realpath(await mkdtemp(join(tmpdir(), "fr-csb-")));
  });
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("starts the container, execs with the timeout wrapper, pins cwd, and removes it on destroy", async () => {
    const rec = recorder();
    const sb = await ContainerSandbox.create({
      engine: "docker",
      worktree,
      limits: LIMITS,
      network: { mode: "none" },
      taskId: "t1",
      run: rec.run,
      image: "node:22-bookworm-slim",
    });
    expect(sb.kind).toBe("container");
    expect(sb.name).toMatch(/^forerunner-t1-[0-9a-f]{8}$/);
    expect(sb.proxy).toBeNull();
    expect(sb.networkName).toBeNull();
    expect(sb.egressRoute).toBeNull();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.argv.slice(0, 6)).toEqual([
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      sb.name,
    ]);
    expect(rec.calls[0]?.argv).toContain("node:22-bookworm-slim");

    await sb.run(["node", "-e", "1"], {
      cwd: "sub/dir",
      timeoutMs: 2_500,
      env: { FOO: "bar" },
      input: "x",
    });
    expect(rec.calls[1]?.argv).toEqual([
      "docker",
      "exec",
      "-i",
      "--workdir",
      `${CONTAINER_WORKDIR}/sub/dir`,
      "-e",
      "FOO=bar",
      sb.name,
      "timeout",
      "-s",
      "KILL",
      "3",
      "node",
      "-e",
      "1",
    ]);
    expect(rec.calls[1]?.opts).toMatchObject({ allowFailure: true, input: "x", timeoutMs: 8_000 });

    // Per-run timeout is capped by the sandbox limit.
    await sb.run(["true"], { timeoutMs: 999_999 });
    expect(rec.calls[2]?.argv).toContain("30");

    // A bad env name is refused before anything runs; execArgvFor checks it too.
    await expect(sb.run(["true"], { env: { "BAD NAME": "1" } })).rejects.toMatchObject({
      code: "validation",
    });
    expect(() => sb.execArgvFor(["true"], { env: { "BAD NAME": "1" } })).toThrow(/invalid/);

    await sb.destroy();
    expect(rec.calls.at(-1)?.argv).toEqual(["docker", "rm", "-f", sb.name]);
    await sb.destroy();
    expect(rec.calls.filter((c) => c.argv[1] === "rm")).toHaveLength(1);
    await expect(sb.run(["true"])).rejects.toMatchObject({ code: "unavailable" });
    await expect(sb.exists("x")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("allowlist, gateway route: internal network first, proxy on its gateway, container attached to it, all removed on destroy", async () => {
    const rec = recorder();
    const sb = await ContainerSandbox.create({
      engine: "docker",
      worktree,
      limits: LIMITS,
      network: { mode: "allowlist", domains: ["github.com"] },
      taskId: "gw",
      run: rec.run,
    });
    try {
      expect(sb.egressRoute).toBe("gateway");
      expect(sb.networkName).toBe(`${sb.name}-net`);
      expect(sb.sidecarName).toBeNull();
      expect(sb.proxy).not.toBeNull();
      // Bound to the gateway address the engine reported (127.0.0.1 in the fake).
      expect(sb.proxy?.host).toBe("127.0.0.1");
      expect(sb.proxyAddress).toEqual({ host: "127.0.0.1", port: sb.proxy?.port });
      const seq = rec.calls.map((c) => c.argv.slice(0, 3).join(" "));
      expect(seq).toEqual(["docker network create", `docker network inspect`, `docker run -d`]);
      expect(rec.calls[0]?.argv).toEqual([
        "docker",
        "network",
        "create",
        "--internal",
        "--label",
        "forerunner.sandbox=1",
        "--label",
        "forerunner.task=gw",
        sb.networkName,
      ]);
      const argv = rec.calls[2]?.argv ?? [];
      expect(argv[argv.indexOf("--network") + 1]).toBe(sb.networkName);
      expect(argv).not.toContain("--add-host");
      expect(argv.find((a) => a.startsWith("HTTP_PROXY="))).toBe(
        `HTTP_PROXY=http://forerunner:${encodeURIComponent(sb.proxy?.token ?? "")}@127.0.0.1:${sb.proxy?.port}`,
      );
    } finally {
      await sb.destroy();
    }
    const tail = rec.calls.slice(-2).map((c) => c.argv);
    expect(tail).toEqual([
      ["docker", "rm", "-f", sb.name],
      ["docker", "network", "rm", sb.networkName],
    ]);
    expect(await portOpen(sb.proxy?.port ?? 0)).toBe(false);
  });

  it("allowlist, sidecar route: relay container on both networks, task container pointed at its internal address", async () => {
    const rec = recorder();
    const sb = await ContainerSandbox.create({
      engine: "podman",
      worktree,
      limits: LIMITS,
      network: { mode: "allowlist", domains: ["github.com"] },
      taskId: "sc",
      run: rec.run,
      image: "img:1",
      user: "1000:1000",
      egress: { route: "sidecar", bindHost: "127.0.0.1" },
    });
    try {
      expect(sb.egressRoute).toBe("sidecar");
      expect(sb.sidecarName).toBe(`${sb.name}-egress`);
      expect(sb.proxyAddress).toEqual({ host: "10.99.0.3", port: EGRESS_RELAY_PORT });
      const seq = rec.calls.map((c) => c.argv.slice(0, 3).join(" "));
      expect(seq).toEqual([
        "podman network create",
        "podman run -d", // sidecar
        "podman network connect",
        "podman inspect --format",
        "podman run -d", // task
      ]);
      const sidecar = rec.calls[1]?.argv ?? [];
      expect(sidecar).toContain(sb.sidecarName);
      expect(sidecar).toContain("img:1");
      expect(sidecar).toContain("FR_EGRESS_UPSTREAM_HOST=host.containers.internal");
      expect(sidecar).toContain(`FR_EGRESS_UPSTREAM_PORT=${sb.proxy?.port}`);
      expect(rec.calls[2]?.argv).toEqual([
        "podman",
        "network",
        "connect",
        sb.networkName,
        sb.sidecarName,
      ]);
      expect(rec.calls[3]?.argv).toEqual([
        "podman",
        "inspect",
        "--format",
        "{{json .NetworkSettings.Networks}}",
        sb.sidecarName,
      ]);
      const task = rec.calls[4]?.argv ?? [];
      expect(task[task.indexOf("--network") + 1]).toBe(sb.networkName);
      expect(task.find((a) => a.startsWith("HTTPS_PROXY="))).toContain(
        `@10.99.0.3:${EGRESS_RELAY_PORT}`,
      );
    } finally {
      await sb.destroy();
    }
    expect(rec.calls.slice(-3).map((c) => c.argv)).toEqual([
      ["podman", "rm", "-f", sb.name],
      ["podman", "rm", "-f", sb.sidecarName],
      ["podman", "network", "rm", sb.networkName],
    ]);
  });

  it("a custom sidecar image and advertised host are honoured", async () => {
    const rec = recorder();
    const sb = await ContainerSandbox.create({
      engine: "docker",
      worktree,
      limits: LIMITS,
      network: { mode: "allowlist", domains: [] },
      run: rec.run,
      egress: {
        route: "sidecar",
        bindHost: "127.0.0.1",
        sidecarImage: "relay:1",
        advertisedHost: "10.0.2.2",
      },
    });
    try {
      const sidecar = rec.calls[1]?.argv ?? [];
      expect(sidecar).toContain("relay:1");
      expect(sidecar).toContain("FR_EGRESS_UPSTREAM_HOST=10.0.2.2");
    } finally {
      await sb.destroy();
    }
  });

  it("cleans up the network, the sidecar and the proxy when a later step fails or rejects", async () => {
    // Task container fails to start on the gateway route.
    const failing = recorder((argv) =>
      argv[1] === "run" ? ok({ code: 125, stderr: "Unable to find image" }) : undefined,
    );
    await expect(
      ContainerSandbox.create({
        engine: "docker",
        worktree,
        limits: LIMITS,
        network: { mode: "allowlist", domains: [] },
        run: failing.run,
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("Unable to find image"),
    });
    const netName = failing.calls[0]?.argv.at(-1);
    expect(failing.calls.at(-1)?.argv).toEqual(["docker", "network", "rm", netName]);

    // `run` itself rejects (spawn ENOENT) while the sidecar is up: everything goes away.
    let ports: number[] = [];
    const rejecting = recorder((argv) => {
      if (argv[1] === "run" && argv.includes("sleep")) throw new Error("spawn docker ENOENT");
      if (argv[1] === "run") ports = argv.map((a) => Number(a.split("=")[1] ?? "")).filter(Boolean);
      return undefined;
    });
    await expect(
      ContainerSandbox.create({
        engine: "docker",
        worktree,
        limits: LIMITS,
        network: { mode: "allowlist", domains: [] },
        run: rejecting.run,
        egress: { route: "sidecar", bindHost: "127.0.0.1" },
      }),
    ).rejects.toThrow(/ENOENT/);
    const names = rejecting.calls.map((c) => c.argv);
    const sidecar = names[1]?.[5];
    expect(names.slice(-2)).toEqual([
      ["docker", "rm", "-f", sidecar],
      ["docker", "network", "rm", names[0]?.at(-1)],
    ]);
    const proxyPort = ports.find((p) => p > 1024 && p !== EGRESS_RELAY_PORT);
    expect(proxyPort).toBeDefined();
    expect(await portOpen(proxyPort ?? 0)).toBe(false);
  });

  it("refuses a gateway it cannot determine instead of leaving the container unproxied", async () => {
    const rec = recorder((argv) =>
      argv[1] === "network" && argv[2] === "inspect" ? ok({ stdout: "[]" }) : undefined,
    );
    await expect(
      ContainerSandbox.create({
        engine: "docker",
        worktree,
        limits: LIMITS,
        network: { mode: "allowlist", domains: ["github.com"] },
        run: rec.run,
      }),
    ).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("gateway") });
    expect(rec.calls.some((c) => c.argv.includes("sleep"))).toBe(false);
    expect(rec.calls.at(-1)?.argv.slice(0, 3)).toEqual(["docker", "network", "rm"]);
  });

  it("a per-run env cannot override the proxy variables in allowlist mode", async () => {
    const rec = recorder();
    const sb = await ContainerSandbox.create({
      engine: "docker",
      worktree,
      limits: LIMITS,
      network: { mode: "allowlist", domains: ["github.com"] },
      run: rec.run,
    });
    try {
      await sb.run(["node", "-e", "1"], {
        env: { HTTPS_PROXY: "http://evil:1", NO_PROXY: "*", no_proxy: "*", KEEP: "1" },
      });
      const exec = rec.calls.at(-1)?.argv ?? [];
      expect(exec[1]).toBe("exec");
      expect(exec).toContain("KEEP=1");
      expect(
        exec.some((a) => /^(HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY)=/.test(a)),
      ).toBe(false);
    } finally {
      await sb.destroy();
    }
  });

  it("marks a command killed by the in-container timeout wrapper as timed out", async () => {
    const rec = recorder((argv) =>
      argv[1] === "exec" ? ok({ code: 137, durationMs: 1_000 }) : undefined,
    );
    const sb = await ContainerSandbox.create({
      engine: "docker",
      worktree,
      limits: { timeoutMs: 1_000 },
      network: { mode: "none" },
      run: rec.run,
    });
    const r = await sb.run(["sleep", "30"]);
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(137);
    await sb.destroy();
  });

  it("writeFile/readFile/exists go through the bind mount on the host with path containment", async () => {
    const rec = recorder();
    const sb = await ContainerSandbox.create({
      engine: "docker",
      worktree,
      limits: LIMITS,
      network: { mode: "none" },
      run: rec.run,
    });
    await sb.writeFile("src/a.txt", "line1\r\nline2\r\n");
    expect(await readFile(join(worktree, "src", "a.txt"), "utf8")).toBe("line1\nline2\n");
    expect(await sb.readFile("src/a.txt")).toBe("line1\nline2\n");
    expect(await sb.exists("src/a.txt")).toBe(true);
    expect(await sb.exists("src/missing.txt")).toBe(false);
    await writeFile(join(worktree, "host.txt"), "from host");
    expect(await sb.readFile("host.txt")).toBe("from host");

    for (const bad of ["../escape.txt", "/etc/passwd", "src/../../x", "C:\\x"]) {
      let err: unknown;
      try {
        await sb.writeFile(bad, "x");
      } catch (e) {
        err = e;
      }
      expect(isForerunnerError(err, "path_not_allowed"), bad).toBe(true);
      err = undefined;
      try {
        await sb.readFile(bad);
      } catch (e) {
        err = e;
      }
      expect(isForerunnerError(err, "path_not_allowed"), bad).toBe(true);
    }
    await expect(sb.run(["true"], { cwd: "../other" })).rejects.toMatchObject({
      code: "path_not_allowed",
    });
    await expect(sb.readFile("nope.txt")).rejects.toMatchObject({ code: "not_found" });
    await sb.destroy();
  });

  it("refuses host-side file access through a symlink that leaves the worktree", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "fr-csb-out-")));
    try {
      await writeFile(join(outside, "secret.txt"), "HOST SECRET");
      await mkdir(join(worktree, "inner"));
      const dirType = process.platform === "win32" ? "junction" : "dir";
      let linked = true;
      try {
        await symlink(outside, join(worktree, "link"), dirType);
        await symlink(join(worktree, "inner"), join(worktree, "stay"), dirType);
      } catch {
        linked = false;
      }
      if (!linked) return;
      const rec = recorder();
      const sb = await ContainerSandbox.create({
        engine: "docker",
        worktree,
        limits: LIMITS,
        network: { mode: "none" },
        run: rec.run,
      });
      try {
        await expect(sb.readFile("link/secret.txt")).rejects.toMatchObject({
          code: "path_not_allowed",
        });
        await expect(sb.writeFile("link/pwned.txt", "x")).rejects.toMatchObject({
          code: "path_not_allowed",
        });
        await expect(sb.exists("link/secret.txt")).rejects.toMatchObject({
          code: "path_not_allowed",
        });
        await sb.writeFile("stay/ok.txt", "inside");
        expect(await readFile(join(worktree, "inner", "ok.txt"), "utf8")).toBe("inside");
        expect(await sb.readFile("stay/ok.txt")).toBe("inside");
      } finally {
        await sb.destroy();
      }
      expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("HOST SECRET");
      await expect(readFile(join(outside, "pwned.txt"))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
