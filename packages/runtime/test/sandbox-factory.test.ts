import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, type RunResult, SimulatedClock } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContainerSandbox } from "../src/sandbox/container.ts";
import { resetSandboxEngineCache } from "../src/sandbox/detect.ts";
import { createSandbox, defaultEgressRoute } from "../src/sandbox/factory.ts";
import { PROCESS_SANDBOX_WARNING } from "../src/sandbox/process.ts";

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

describe("createSandbox", () => {
  let worktree: string;
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => {
    calls.push([...argv]);
    if (argv[0] === "docker" && argv[1] === "info") return ok({ stdout: "27.0.0|[name=seccomp]" });
    return ok();
  };
  const base = {
    taskId: "t-1",
    limits: { timeoutMs: 10_000 },
    network: { mode: "none" } as const,
    clock: new SimulatedClock(),
    run,
    hostIds: () => ({ uid: 1000, gid: 1000 }),
  };

  beforeEach(async () => {
    resetSandboxEngineCache();
    calls.length = 0;
    worktree = await mkdtemp(join(tmpdir(), "fr-fac-"));
  });
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("picks the container when an engine is reachable", async () => {
    const which = async (c: string) => (c === "docker" ? "/usr/bin/docker" : null);
    const { sandbox, engine, warnings, detection } = await createSandbox({
      ...base,
      worktree,
      riskTier: 3,
      which,
      processEnv: { FORERUNNER_RUNNER_IMAGE: "registry.example/runner:1" },
    });
    try {
      expect(engine).toBe("docker");
      expect(detection.engine).toBe("docker");
      expect(sandbox.kind).toBe("container");
      expect(warnings).toEqual([]);
      const runArgv = calls.find((c) => c[1] === "run");
      expect(runArgv).toContain("registry.example/runner:1");
      if (process.platform === "linux") {
        expect(runArgv?.[runArgv.indexOf("--user") + 1]).toBe("1000:1000");
        expect(runArgv).toContain("HOME=/tmp");
      }
    } finally {
      await sandbox.destroy();
    }
  });

  it("warns about the image fallback when nothing names one", async () => {
    const { sandbox, warnings } = await createSandbox({
      ...base,
      worktree,
      riskTier: 0,
      which: async () => "/usr/bin/docker",
      processEnv: {},
    });
    try {
      expect(warnings).toEqual(["sandbox: image not configured, using forerunner-runner:local"]);
    } finally {
      await sandbox.destroy();
    }
  });

  it("refuses the process sandbox for risk tier >= 2 unless allowProcessSandbox is on", async () => {
    const detection = { engine: "none" as const, reason: "docker: not on PATH", checkedAt: "" };
    await expect(
      createSandbox({ ...base, worktree, riskTier: 2, detection }),
    ).rejects.toMatchObject({
      code: "not_supported",
      details: { riskTier: 2, taskId: "t-1" },
    });
    await expect(
      createSandbox({ ...base, worktree, riskTier: 3, detection, allowProcessSandbox: false }),
    ).rejects.toMatchObject({
      code: "not_supported",
    });
    const allowed = await createSandbox({
      ...base,
      worktree,
      riskTier: 2,
      detection,
      allowProcessSandbox: true,
    });
    try {
      expect(allowed.engine).toBe("process");
      expect(allowed.sandbox.kind).toBe("process");
      expect(allowed.warnings).toEqual([`${PROCESS_SANDBOX_WARNING}: docker: not on PATH`]);
    } finally {
      await allowed.sandbox.destroy();
    }
  });

  it("uses the process sandbox for low tiers when no engine is reachable, with the warning", async () => {
    const { sandbox, engine, warnings } = await createSandbox({
      ...base,
      worktree,
      riskTier: 1,
      which: async () => null,
    });
    try {
      expect(engine).toBe("process");
      expect(warnings[0]).toContain(PROCESS_SANDBOX_WARNING);
      expect(calls.filter((c) => c[1] === "info")).toHaveLength(0);
    } finally {
      await sandbox.destroy();
    }
  });

  it("FORERUNNER_SANDBOX_ENGINE=process forces the process sandbox even when docker is present", async () => {
    const { sandbox, engine, detection } = await createSandbox({
      ...base,
      worktree,
      riskTier: 1,
      which: async () => "/usr/bin/docker",
      processEnv: { FORERUNNER_SANDBOX_ENGINE: "process" },
    });
    try {
      expect(engine).toBe("process");
      expect(detection.override).toBe("process");
      expect(calls).toEqual([]);
    } finally {
      await sandbox.destroy();
    }
  });
});

describe("egress route selection", () => {
  let worktree: string;
  beforeEach(async () => {
    resetSandboxEngineCache();
    worktree = await mkdtemp(join(tmpdir(), "fr-fac-route-"));
  });
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("defaults to the gateway route only for rootful engines on native Linux", () => {
    expect(defaultEgressRoute({ rootless: false }, "linux")).toBe("gateway");
    expect(defaultEgressRoute({ rootless: true }, "linux")).toBe("sidecar");
    expect(defaultEgressRoute({ rootless: false }, "windows")).toBe("sidecar");
    expect(defaultEgressRoute({ rootless: false }, "macos")).toBe("sidecar");
  });

  it("creates the internal network and passes the route, env overrides and sidecar image to the container", async () => {
    const calls: string[][] = [];
    const run = async (argv: readonly string[]) => {
      calls.push([...argv]);
      if (argv[1] === "network" && argv[2] === "inspect") {
        return ok({
          stdout: JSON.stringify([{ IPAM: { Config: [{ Gateway: "127.0.0.1" }] } }]),
        });
      }
      if (argv[1] === "inspect") {
        return ok({
          stdout: JSON.stringify({
            [argv.at(-1)?.replace(/-egress$/, "-net") ?? ""]: { IPAddress: "10.7.0.2" },
          }),
        });
      }
      return ok();
    };
    const detection = { engine: "docker" as const, reason: "ok", rootless: false, checkedAt: "" };
    const gw = await createSandbox({
      taskId: "r",
      worktree,
      limits: { timeoutMs: 1000 },
      network: { mode: "allowlist", domains: ["github.com"] },
      riskTier: 3,
      detection,
      run,
      processEnv: { FORERUNNER_EGRESS_ROUTE: "gateway", FORERUNNER_RUNNER_IMAGE: "img:1" },
      hostIds: () => null,
    });
    try {
      const sb = gw.sandbox as ContainerSandbox;
      expect(sb.egressRoute).toBe("gateway");
      expect(calls[0]?.slice(0, 4)).toEqual(["docker", "network", "create", "--internal"]);
      expect(calls.some((c) => c[1] === "run" && c.includes("node"))).toBe(false);
    } finally {
      await gw.sandbox.destroy();
    }
    calls.length = 0;
    const sc = await createSandbox({
      taskId: "r2",
      worktree,
      limits: { timeoutMs: 1000 },
      network: { mode: "allowlist", domains: ["github.com"] },
      riskTier: 3,
      detection,
      run,
      processEnv: {
        FORERUNNER_EGRESS_ROUTE: "sidecar",
        FORERUNNER_EGRESS_BIND: "127.0.0.1",
        FORERUNNER_EGRESS_HOST: "10.0.2.2",
        FORERUNNER_EGRESS_IMAGE: "relay:2",
        FORERUNNER_RUNNER_IMAGE: "img:1",
      },
      hostIds: () => null,
    });
    try {
      const sb = sc.sandbox as ContainerSandbox;
      expect(sb.egressRoute).toBe("sidecar");
      expect(sb.proxy?.host).toBe("127.0.0.1");
      const sidecar = calls.find((c) => c[1] === "run" && c.includes("node"));
      expect(sidecar).toContain("relay:2");
      expect(sidecar).toContain("FR_EGRESS_UPSTREAM_HOST=10.0.2.2");
      expect(sb.proxyAddress?.host).toBe("10.7.0.2");
    } finally {
      await sc.sandbox.destroy();
    }
  });
});
