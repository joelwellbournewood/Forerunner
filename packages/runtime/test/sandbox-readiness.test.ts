import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DetectingSandboxPort, sandboxHealth } from "../src/daemon/sandbox-port.ts";
import { resetSandboxEngineCache } from "../src/sandbox/detect.ts";
import { FakeContainerEngine } from "../src/sandbox/fake-engine.ts";
import {
  isPullableImage,
  parseBuildRunnerImage,
  readBuildRunnerImage,
  resolveSandboxImage,
} from "../src/sandbox/image.ts";
import {
  isSandboxNotReady,
  PullProgress,
  parseManifestSize,
  SandboxReadinessService,
} from "../src/sandbox/readiness.ts";
import { sandboxNextStep, sandboxWords } from "../src/sandbox/readiness-types.ts";

/**
 * U-079: where the Docker sandbox stands, as Settings → Sandbox (Docker) shows it, from a fake
 * engine's `docker info` / `docker image inspect` / `docker pull` answers. Windows containers
 * never count as available; a build-named image is pulled at the app's version, else at latest.
 */
const BUILD = {
  repository: "ghcr.io/some-owner/forerunner-runner",
  tag: "1.0.5",
  fallbackTag: "latest",
};
const VERSIONED = "ghcr.io/some-owner/forerunner-runner:1.0.5";
const LATEST = "ghcr.io/some-owner/forerunner-runner:latest";

function service(
  engine: FakeContainerEngine,
  image = resolveSandboxImage({ env: {}, build: BUILD }),
) {
  return new SandboxReadinessService({
    env: {},
    clock: new SimulatedClock("2026-10-31T10:00:00Z"),
    image,
    run: engine.run,
    which: engine.which,
    platform: "windows",
    arch: "x64",
  });
}

describe("sandbox readiness (U-079)", () => {
  beforeEach(() => resetSandboxEngineCache());

  it("not installed: no docker or podman on PATH, with the Docker Desktop steps", async () => {
    const engine = new FakeContainerEngine({ installed: false });
    const r = await service(engine).check({ force: true });
    expect(r.state).toBe("not_installed");
    expect(r.detection.engine).toBe("none");
    const words = sandboxWords({
      state: r.state,
      platform: "windows",
      image: r.image,
      pullable: true,
    });
    expect(words.headline).toBe("Docker is not installed on this computer.");
    expect(words.steps[0]).toContain("Install Docker Desktop");
    expect(engine.callsOf("run")).toEqual([]);
  });

  it("not running: the CLI is there but `docker info` cannot reach the engine", async () => {
    const engine = new FakeContainerEngine({ running: false });
    const r = await service(engine).check({ force: true });
    expect(r.state).toBe("not_running");
    expect(r.reason).toContain("docker daemon is not running");
    expect(
      sandboxNextStep({ state: r.state, platform: "windows", image: r.image, pullable: true }),
    ).toBe("start Docker Desktop, then Check again in Settings → Sandbox (Docker)");
  });

  it("Windows containers never count as available, and no container is ever tried", async () => {
    const engine = new FakeContainerEngine({ osType: "windows", images: [VERSIONED] });
    const readiness = service(engine);
    const r = await readiness.check({ force: true });
    expect(r.state).toBe("windows_containers");
    expect(r.detection.engine).toBe("none");
    expect(sandboxHealth(r)).toMatchObject({ available: false, kind: "process", engine: "none" });
    expect(
      sandboxWords({ state: r.state, platform: "windows", image: r.image, pullable: true })
        .steps[0],
    ).toBe("Right-click the Docker icon in the taskbar and choose Switch to Linux containers.");
    // The CI failure (`invalid mount path: '/work'`) cannot happen: a tier 0 task gets the
    // stand-in, a tier 2 task waits.
    const worktree = await mkdtemp(join(tmpdir(), "fr-u079-win-"));
    try {
      const port = new DetectingSandboxPort({
        env: {},
        clock: new SimulatedClock(),
        store: { project: { get: async () => null } } as never,
        readiness,
        run: engine.run,
        which: engine.which,
      });
      const req = (risk_tier: number) => ({
        task: { id: `t${risk_tier}`, project_id: "p", risk_tier },
        worktree,
        allowedDomains: [],
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      });
      const low = await port.open(req(0));
      expect(low.engine).toBe("process");
      await low.sandbox.destroy();
      const refused = await port.open(req(2)).catch((e: unknown) => e);
      expect(isSandboxNotReady(refused)).toBe(true);
      expect(String((refused as Error).message)).toContain(
        "switch Docker Desktop to Linux containers",
      );
      expect(engine.callsOf("run")).toEqual([]);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("image missing: Docker is ready, the build's image is not here; the size comes from the registry", async () => {
    const engine = new FakeContainerEngine({
      registry: { [VERSIONED]: { bytes: 640_000_000, layers: 4 } },
    });
    const readiness = service(engine);
    const checked = await readiness.check({ force: true });
    // The registry is not asked on a check (the daemon's start, before a plan) ...
    expect(checked.downloadBytes).toBeNull();
    expect(engine.callsOf("manifest")).toEqual([]);
    // ... only for the card, once per image.
    const r = await readiness.withSize();
    await readiness.withSize();
    expect(engine.callsOf("manifest")).toHaveLength(1);
    expect(r.state).toBe("image_missing");
    expect(r.image).toBe(VERSIONED);
    expect(r.engine).toBe("docker");
    expect(r.detection.engine).toBe("none");
    expect(r.downloadBytes).toBe(640_000_000);
    expect(
      sandboxWords({
        state: r.state,
        platform: "windows",
        image: r.image,
        pullable: true,
        downloadBytes: r.downloadBytes,
      }).steps[0],
    ).toBe(
      "Click Download the sandbox in Settings → Sandbox (Docker) (about 640 MB); the progress shows there.",
    );
  });

  it("CI's Linux Docker without the image: the local default is built, not downloaded", async () => {
    const engine = new FakeContainerEngine();
    const readiness = service(engine, resolveSandboxImage({ env: {}, build: null }));
    const r = await readiness.check({ force: true });
    expect(r.state).toBe("image_missing");
    expect(r.image).toBe("forerunner-runner:local");
    expect(r.choice.pullable).toBe(false);
    await expect(readiness.startPull()).rejects.toMatchObject({ code: "claim_conflict" });
    expect(engine.callsOf("pull")).toEqual([]);
    expect(
      sandboxWords({ state: r.state, platform: "linux", image: r.image, pullable: false }).steps[0],
    ).toContain("docker build -t forerunner-runner:local");
  });

  it("pulling, then ready: the download's layers are counted and the state follows", async () => {
    const engine = new FakeContainerEngine({ registry: { [VERSIONED]: { layers: 3 } } });
    const readiness = service(engine);
    const states: string[] = [];
    readiness.onChange((next) => states.push(next.state));
    expect((await readiness.check()).state).toBe("image_missing");
    const release = engine.holdPulls();
    const job = await readiness.startPull();
    expect(job.state).toBe("running");
    expect(readiness.current()?.state).toBe("pulling");
    // A second Download follows the same download.
    expect((await readiness.startPull()).id).toBe(job.id);
    release();
    await readiness.settled;
    await readiness.check();
    expect(readiness.current()?.state).toBe("ready");
    expect(states).toEqual(["image_missing", "pulling", "ready"]);
    const events = readiness.eventsAfter(0).map((e) => e.event);
    expect(events.filter((e) => e.type === "layers").at(-1)).toEqual({
      type: "layers",
      done: 3,
      total: 3,
    });
    expect(events.at(-1)).toMatchObject({ type: "result", ok: true, image: VERSIONED });
    expect(engine.callsOf("pull")).toEqual([["docker", "pull", VERSIONED]]);
  });

  it("a development build: the registry has no image for this version, so latest is pulled and used", async () => {
    const engine = new FakeContainerEngine({ registry: { [LATEST]: { layers: 2 } } });
    const readiness = service(engine);
    await readiness.check();
    await readiness.startPull();
    await readiness.settled;
    const r = await readiness.check();
    expect(r.state).toBe("ready");
    expect(r.image).toBe(LATEST);
    expect(engine.callsOf("pull")).toEqual([
      ["docker", "pull", VERSIONED],
      ["docker", "pull", LATEST],
    ]);
    expect(readiness.eventsAfter(0).map((e) => e.event)).toContainEqual({
      type: "step",
      message: `the registry has no ${VERSIONED}; downloading ${LATEST} instead`,
    });
  });

  it("a private package: the failure says the package must be public or needs a login", async () => {
    const engine = new FakeContainerEngine({ deniedPulls: [VERSIONED] });
    const readiness = service(engine);
    await readiness.check();
    await readiness.startPull();
    await readiness.settled;
    expect(readiness.current()?.state).toBe("image_missing");
    const result = readiness.eventsAfter(0).at(-1)?.event;
    expect(result).toMatchObject({ type: "result", ok: false });
    expect((result as { message: string }).message).toContain("the package must be public");
  });

  it("Podman counts (it runs Linux containers)", async () => {
    const engine = new FakeContainerEngine({
      engine: "podman",
      rootless: true,
      images: [VERSIONED],
    });
    const r = await service(engine).check({ force: true });
    expect(r).toMatchObject({ state: "ready", engine: "podman" });
  });

  it("Check again sees Docker started and switched to Linux containers", async () => {
    const engine = new FakeContainerEngine({ running: false, images: [VERSIONED] });
    const readiness = service(engine);
    expect((await readiness.check({ force: true })).state).toBe("not_running");
    engine.set({ running: true, osType: "windows" });
    // Within the detection cache's minute, only a forced check (Check again) sees the change.
    expect((await readiness.check({ force: true })).state).toBe("windows_containers");
    engine.set({ osType: "linux" });
    expect((await readiness.check({ force: true })).state).toBe("ready");
  });
});

describe("the image the build names (U-079)", () => {
  it("runtime.json's runnerImage, else nothing; no owner in code", () => {
    expect(parseBuildRunnerImage({ runnerImage: BUILD })).toEqual(BUILD);
    expect(parseBuildRunnerImage({ schema: 1 })).toBeNull();
    expect(parseBuildRunnerImage({ runnerImage: { repository: "-x", tag: "1" } })).toBeNull();
    const files: Record<string, string> = {
      [join("/payload", "runtime.json")]: JSON.stringify({ schema: 1, runnerImage: BUILD }),
    };
    expect(
      readBuildRunnerImage(join("/payload", "packages", "runtime", "src"), (f) => files[f] ?? null),
    ).toEqual(BUILD);
    expect(readBuildRunnerImage(join("/repo", "packages"), () => null)).toBeNull();
  });

  it("config, then FORERUNNER_RUNNER_IMAGE, then the build's version tag with latest as fallback, then the local default", () => {
    expect(
      resolveSandboxImage({
        configured: "registry.example/r:2",
        env: { FORERUNNER_RUNNER_IMAGE: "x/y:1" },
        build: BUILD,
      }),
    ).toMatchObject({ image: "registry.example/r:2", source: "config", fallback: null });
    expect(
      resolveSandboxImage({ env: { FORERUNNER_RUNNER_IMAGE: "x/y:1" }, build: BUILD }),
    ).toMatchObject({ image: "x/y:1", source: "env" });
    expect(resolveSandboxImage({ env: {}, build: BUILD })).toEqual({
      image: VERSIONED,
      fallback: LATEST,
      source: "build",
      pullable: true,
    });
    expect(resolveSandboxImage({ env: {}, build: null })).toEqual({
      image: "forerunner-runner:local",
      fallback: null,
      source: "local",
      pullable: false,
    });
    expect(isPullableImage("forerunner-runner:local")).toBe(false);
  });

  it("the download size of the host's platform from `docker manifest inspect --verbose`", () => {
    const entry = (architecture: string, sizes: number[]) => ({
      Descriptor: { platform: { os: "linux", architecture } },
      SchemaV2Manifest: { layers: sizes.map((size) => ({ size })) },
    });
    const json = JSON.stringify([entry("arm64", [1, 2]), entry("amd64", [100, 200])]);
    expect(parseManifestSize(json, "amd64")).toBe(300);
    expect(
      parseManifestSize(JSON.stringify({ OCIManifest: { layers: [{ size: 5 }] } }), "amd64"),
    ).toBe(5);
    expect(parseManifestSize("not json", "amd64")).toBeNull();
  });

  it("layer progress from docker's and podman's pull lines", () => {
    const p = new PullProgress();
    p.line("1.0.5: Pulling from some-owner/forerunner-runner");
    p.line("aaaaaaaaaaa0: Pulling fs layer");
    p.line("aaaaaaaaaaa1: Already exists");
    expect([p.done, p.total]).toEqual([1, 2]);
    p.line("aaaaaaaaaaa0: Pull complete");
    expect([p.done, p.total]).toEqual([2, 2]);
    const q = new PullProgress();
    q.line("Copying blob sha256:0123456789abcdef");
    q.line("Copying blob sha256:fedcba9876543210 done");
    expect([q.done, q.total]).toEqual([1, 2]);
  });
});

afterEach(() => resetSandboxEngineCache());
