import { type RunResult, SimulatedClock } from "@forerunner/platform";
import { beforeEach, describe, expect, it } from "vitest";
import { detectSandboxEngine, resetSandboxEngineCache } from "../src/sandbox/detect.ts";

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

interface Fakes {
  onPath: Set<string>;
  replies: Record<string, RunResult>;
  calls: string[][];
}

function fakes(opts: Partial<Fakes> = {}): Fakes & {
  which: (c: string) => Promise<string | null>;
  run: (argv: readonly string[]) => Promise<RunResult>;
} {
  const f: Fakes = {
    onPath: opts.onPath ?? new Set(),
    replies: opts.replies ?? {},
    calls: opts.calls ?? [],
  };
  return {
    ...f,
    which: async (c) => (f.onPath.has(c) ? `/usr/bin/${c}` : null),
    run: async (argv) => {
      f.calls.push([...argv]);
      const r = f.replies[argv[0] ?? ""];
      if (!r) throw new Error(`unexpected ${argv.join(" ")}`);
      return r;
    },
  };
}

describe("detectSandboxEngine", () => {
  beforeEach(() => resetSandboxEngineCache());

  it("finds docker from `docker info` and reads rootless from the security options", async () => {
    const f = fakes({
      onPath: new Set(["docker", "podman"]),
      replies: {
        docker: result({ stdout: "27.1.0|[name=seccomp,profile=builtin name=rootless]\n" }),
      },
    });
    const d = await detectSandboxEngine({
      env: {},
      which: f.which,
      run: f.run,
      clock: new SimulatedClock(),
    });
    expect(d.engine).toBe("docker");
    expect(d.version).toBe("27.1.0");
    expect(d.rootless).toBe(true);
    expect(f.calls).toEqual([
      ["docker", "info", "--format", "{{.ServerVersion}}|{{.SecurityOptions}}"],
    ]);
  });

  it("falls back to podman when docker is not on PATH", async () => {
    const f = fakes({
      onPath: new Set(["podman"]),
      replies: { podman: result({ stdout: "5.2.1|true\n" }) },
    });
    const d = await detectSandboxEngine({
      env: {},
      which: f.which,
      run: f.run,
      clock: new SimulatedClock(),
    });
    expect(d.engine).toBe("podman");
    expect(d.version).toBe("5.2.1");
    expect(d.rootless).toBe(true);
    expect(f.calls.map((c) => c[0])).toEqual(["podman"]);
  });

  it("reports none with the daemon error when the CLI exists but the daemon is down", async () => {
    const f = fakes({
      onPath: new Set(["docker"]),
      replies: {
        docker: result({
          code: 1,
          stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        }),
      },
    });
    const d = await detectSandboxEngine({
      env: {},
      which: f.which,
      run: f.run,
      clock: new SimulatedClock(),
    });
    expect(d.engine).toBe("none");
    expect(d.reason).toContain("Cannot connect to the Docker daemon");
    expect(d.reason).toContain("podman not on PATH");
  });

  it("never throws, even when the probe itself fails", async () => {
    const d = await detectSandboxEngine({
      env: {},
      which: async () => {
        throw new Error("which exploded");
      },
      run: async () => {
        throw new Error("run exploded");
      },
      clock: new SimulatedClock(),
    });
    expect(d.engine).toBe("none");
    expect(d.reason).toContain("which exploded");
  });

  it("caches the answer per process until the TTL passes on the Clock", async () => {
    const clock = new SimulatedClock();
    const f = fakes({
      onPath: new Set(["docker"]),
      replies: { docker: result({ stdout: "27.0.0|[]" }) },
    });
    const a = await detectSandboxEngine({
      env: {},
      which: f.which,
      run: f.run,
      clock,
      ttlMs: 60_000,
    });
    const b = await detectSandboxEngine({
      env: {},
      which: f.which,
      run: f.run,
      clock,
      ttlMs: 60_000,
    });
    expect(a).toBe(b);
    expect(f.calls).toHaveLength(1);
    await clock.advance(59_000);
    await detectSandboxEngine({ env: {}, which: f.which, run: f.run, clock, ttlMs: 60_000 });
    expect(f.calls).toHaveLength(1);
    await clock.advance(2_000);
    const c = await detectSandboxEngine({
      env: {},
      which: f.which,
      run: f.run,
      clock,
      ttlMs: 60_000,
    });
    expect(f.calls).toHaveLength(2);
    expect(c.engine).toBe("docker");
  });

  it("FORERUNNER_SANDBOX_ENGINE=podman probes only podman", async () => {
    const f = fakes({
      onPath: new Set(["docker", "podman"]),
      replies: {
        docker: result({ stdout: "27.0.0|[]" }),
        podman: result({ stdout: "5.0.0|false" }),
      },
    });
    const d = await detectSandboxEngine({
      env: { FORERUNNER_SANDBOX_ENGINE: "podman" },
      which: f.which,
      run: f.run,
      clock: new SimulatedClock(),
    });
    expect(d.engine).toBe("podman");
    expect(d.rootless).toBe(false);
    expect(d.override).toBe("podman");
    expect(f.calls.map((c) => c[0])).toEqual(["podman"]);
  });

  it("FORERUNNER_SANDBOX_ENGINE=process skips every probe", async () => {
    const f = fakes({
      onPath: new Set(["docker"]),
      replies: { docker: result({ stdout: "27.0.0|[]" }) },
    });
    const d = await detectSandboxEngine({
      env: { FORERUNNER_SANDBOX_ENGINE: "process" },
      which: f.which,
      run: f.run,
      clock: new SimulatedClock(),
    });
    expect(d.engine).toBe("none");
    expect(d.override).toBe("process");
    expect(f.calls).toHaveLength(0);
  });

  it("ignores an unknown override value and probes normally", async () => {
    const f = fakes({
      onPath: new Set(["docker"]),
      replies: { docker: result({ stdout: "27.0.0|[]" }) },
    });
    const d = await detectSandboxEngine({
      env: { FORERUNNER_SANDBOX_ENGINE: "firecracker" },
      which: f.which,
      run: f.run,
      clock: new SimulatedClock(),
    });
    expect(d.engine).toBe("docker");
    expect(d.override).toBeUndefined();
  });
});
