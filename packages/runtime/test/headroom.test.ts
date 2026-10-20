import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { ForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEADROOM_PROJECT_HEADER,
  HeadroomAdapter,
  headroomFromEnv,
  headroomHeaders,
  headroomNotice,
  headroomSdkEnv,
  isLoopbackUrl,
  type ManagedChild,
  ManagedHeadroomProcess,
  managedHeadroomArgv,
  NoHeadroom,
  resolveHeadroomUrl,
  selectCompression,
} from "../src/context/headroom.ts";
import { FakeHeadroom } from "./context-helpers.ts";

interface ProxyState {
  /** Body of /health; null answers 500. */
  health: unknown;
  stats: unknown;
  /** Never answer (a wedged proxy). */
  hang: boolean;
}

interface FakeProxy {
  server: Server;
  url: string;
  state: ProxyState;
  close(): Promise<void>;
}

/** In-process stand-in for `headroom proxy`: /health and /stats on a loopback port. */
async function fakeProxy(): Promise<FakeProxy> {
  const state: ProxyState = {
    health: { status: "healthy", ready: true },
    stats: { projects: { p1: { tokens_saved: 1200 } }, lifetime: { tokens_saved: 1200 } },
    hang: false,
  };
  const server = createServer((req, res) => {
    if (state.hang) return;
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      if (state.health === null) {
        res.statusCode = 500;
        res.end('{"error":"boom"}');
        return;
      }
      res.end(JSON.stringify(state.health));
      return;
    }
    if (req.url === "/stats") {
      res.end(JSON.stringify(state.stats));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    state,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const notInstalled = async () => null;
const installed = async () => "/usr/local/bin/headroom";

describe("headroom: configuration", () => {
  it("resolves the URL from FORERUNNER_HEADROOM_URL, else the port, else Headroom's default", () => {
    expect(resolveHeadroomUrl({})).toBe("http://127.0.0.1:8787");
    expect(resolveHeadroomUrl({ FORERUNNER_HEADROOM_PORT: "9999" })).toBe("http://127.0.0.1:9999");
    expect(resolveHeadroomUrl({ FORERUNNER_HEADROOM_URL: "http://localhost:8787/" })).toBe(
      "http://localhost:8787",
    );
    expect(resolveHeadroomUrl({ FORERUNNER_HEADROOM_URL: "http://[::1]:8787" })).toBe(
      "http://[::1]:8787",
    );
    expect(() => resolveHeadroomUrl({ FORERUNNER_HEADROOM_PORT: "abc" })).toThrow(ForerunnerError);
  });

  it("rejects a non-loopback proxy with validation: the proxy sees the API credential", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackUrl("http://127.1.2.3")).toBe(true);
    expect(isLoopbackUrl("http://localhost")).toBe(true);
    expect(isLoopbackUrl("http://0.0.0.0:8787")).toBe(false);
    expect(isLoopbackUrl("http://proxy.example:8787")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    let caught: unknown;
    try {
      resolveHeadroomUrl({ FORERUNNER_HEADROOM_URL: "http://proxy.example:8787" });
    } catch (e) {
      caught = e;
    }
    expect((caught as ForerunnerError).code).toBe("validation");
    expect(
      () => new HeadroomAdapter({ env: { FORERUNNER_HEADROOM_URL: "ftp://127.0.0.1" } }),
    ).toThrow(/loopback/);
    const r = headroomFromEnv({ FORERUNNER_HEADROOM_URL: "http://10.0.0.5:8787" });
    expect(r.error?.code).toBe("validation");
    expect(r.port).toBeInstanceOf(NoHeadroom);
  });

  it("builds the managed argv, the project header and the SDK environment from the ADR", () => {
    expect(managedHeadroomArgv(8787)).toEqual([
      "headroom",
      "proxy",
      "--host",
      "127.0.0.1",
      "--port",
      "8787",
      "--mode",
      "cache",
      "--no-ccr",
      "--lossless",
      "--no-cache",
    ]);
    expect(headroomHeaders("proj-1")).toEqual({ [HEADROOM_PROJECT_HEADER]: "proj-1" });
    expect(headroomSdkEnv("http://127.0.0.1:8787", "proj-1")).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      ANTHROPIC_CUSTOM_HEADERS: "X-Headroom-Project: proj-1",
    });
  });
});

describe("headroom: adapter against an in-process proxy", () => {
  const open: FakeProxy[] = [];
  afterEach(async () => {
    for (const p of open.splice(0)) await p.close();
  });

  async function proxy(): Promise<FakeProxy> {
    const p = await fakeProxy();
    open.push(p);
    return p;
  }

  it("is available only when /health says healthy and ready, and reads tokens_saved per project", async () => {
    const p = await proxy();
    const adapter = new HeadroomAdapter({
      env: { FORERUNNER_HEADROOM_URL: p.url },
      clock: new SimulatedClock(),
      which: installed,
    });
    expect(await adapter.probe()).toEqual({ status: "healthy", available: true, url: p.url });
    expect(await adapter.tokensSaved("p1")).toBe(1200);
    expect(await adapter.tokensSaved("unknown")).toBe(0);

    p.state.health = { status: "healthy", ready: false };
    expect(await adapter.probe()).toMatchObject({ status: "unhealthy", available: false });
    p.state.health = { status: "degraded", ready: true };
    expect((await adapter.probe()).available).toBe(false);
    p.state.health = null;
    expect(await adapter.probe()).toMatchObject({ status: "unhealthy", detail: "HTTP 500" });
    p.state.stats = "not json";
    expect(await adapter.tokensSaved("p1")).toBe(0);
  });

  it("tells not installed from not running when nothing listens, and never assumes", async () => {
    const p = await proxy();
    const url = p.url;
    await p.close();
    open.splice(open.indexOf(p), 1);
    const clock = new SimulatedClock();
    const absent = new HeadroomAdapter({
      env: { FORERUNNER_HEADROOM_URL: url },
      clock,
      which: notInstalled,
    });
    expect(await absent.probe()).toMatchObject({ status: "not_installed", available: false });
    expect(await absent.tokensSaved("p1")).toBeNull();
    const stopped = new HeadroomAdapter({
      env: { FORERUNNER_HEADROOM_URL: url },
      clock,
      which: installed,
    });
    expect(await stopped.probe()).toMatchObject({ status: "not_running", available: false });
    const broken = new HeadroomAdapter({
      env: { FORERUNNER_HEADROOM_URL: url },
      clock,
      which: async () => {
        throw new Error("which failed");
      },
    });
    expect((await broken.probe()).status).toBe("not_installed");
  });

  it("gives up after the probe timeout on a wedged proxy and reports it unhealthy", async () => {
    const p = await proxy();
    const clock = new SimulatedClock();
    const adapter = new HeadroomAdapter({
      env: { FORERUNNER_HEADROOM_URL: p.url },
      clock,
      which: installed,
      timeoutMs: 500,
    });
    p.state.hang = true;
    const pending = adapter.probe();
    await clock.advance(600);
    expect(await pending).toMatchObject({ status: "unhealthy", available: false });
    expect((await pending).detail).toContain("500 ms");
  });

  it("survives the proxy dying mid-session: the next probe fails and savings read null", async () => {
    const p = await proxy();
    const adapter = new HeadroomAdapter({
      env: { FORERUNNER_HEADROOM_URL: p.url },
      clock: new SimulatedClock(),
      which: installed,
    });
    expect((await adapter.probe()).available).toBe(true);
    expect(await adapter.tokensSaved("p1")).toBe(1200);
    await p.close();
    open.splice(open.indexOf(p), 1);
    expect(await adapter.probe()).toMatchObject({ status: "not_running", available: false });
    expect(await adapter.tokensSaved("p1")).toBeNull();
  });
});

describe("headroom: selection", () => {
  it("uses the proxy only when the policy asks for it and the probe passed; otherwise native with a notice, never silent", async () => {
    const healthy = new FakeHeadroom("healthy");
    expect(await selectCompression("native", healthy)).toEqual({
      policy: "native",
      mode: "native",
      headroomUsed: false,
      headroom: null,
      notice: null,
    });
    expect((await selectCompression("off", healthy)).mode).toBe("off");
    expect(healthy.probes).toBe(0);

    const used = await selectCompression("headroom", healthy);
    expect(used).toMatchObject({ mode: "headroom", headroomUsed: true, notice: null });
    expect(used.headroom?.url).toBe(healthy.url);

    for (const status of ["not_installed", "not_running", "unhealthy", "disabled"] as const) {
      const sel = await selectCompression("headroom", new FakeHeadroom(status));
      expect(sel.mode).toBe("native");
      expect(sel.headroomUsed).toBe(false);
      expect(sel.policy).toBe("headroom");
      expect(sel.notice).toContain("Headroom");
      expect(sel.notice).toContain("native");
      expect(sel.headroom?.status).toBe(status);
    }
    const throwing = await selectCompression("headroom", {
      url: "http://127.0.0.1:1",
      async probe() {
        throw new Error("socket exploded");
      },
      async tokensSaved() {
        return null;
      },
    });
    expect(throwing.mode).toBe("native");
    expect(throwing.notice).toContain("socket exploded");
    expect(headroomNotice({ status: "healthy", available: true, url: "" })).toBe(
      "Headroom: in use",
    );
    expect(await new NoHeadroom("off for tests").probe()).toMatchObject({
      status: "disabled",
      detail: "off for tests",
    });
  });
});

describe("headroom: managed process", () => {
  it("spawns the proxy with the ADR argv, telemetry off, logs to the app log dir and stops it", () => {
    const logDir = mkdtempSync(join(tmpdir(), "fr-headroom-"));
    try {
      const spawned: { argv: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
      let exit: ((code: number | null) => void) | null = null;
      const killed: ManagedChild[] = [];
      const child: ManagedChild = {
        pid: 4242,
        stdout: null,
        stderr: null,
        once(_event, listener) {
          exit = listener;
        },
      };
      const managed = new ManagedHeadroomProcess({
        port: 8790,
        logDir,
        env: { PATH: "/bin", HEADROOM_TELEMETRY: "1" },
        spawn: (argv, opts) => {
          spawned.push({ argv, env: opts.env });
          return child;
        },
        kill: (c) => killed.push(c),
      });
      expect(managed.running).toBe(false);
      expect(managed.start()).toBe(true);
      expect(managed.start()).toBe(true);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.argv).toEqual(managedHeadroomArgv(8790));
      expect(spawned[0]?.env?.HEADROOM_TELEMETRY).toBeUndefined();
      expect(spawned[0]?.argv).not.toContain("--log-messages");
      expect(managed.running).toBe(true);
      managed.stop();
      expect(killed).toEqual([child]);
      expect(managed.running).toBe(false);
      managed.stop();
      expect(killed).toHaveLength(1);
      // A process that exits on its own is forgotten; a failing spawn is reported, not thrown.
      expect(managed.start()).toBe(true);
      (exit as ((code: number | null) => void) | null)?.(1);
      expect(managed.running).toBe(false);
      const failing = new ManagedHeadroomProcess({
        port: 8791,
        logDir,
        spawn: () => {
          throw new Error("ENOENT");
        },
      });
      expect(failing.start()).toBe(false);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
