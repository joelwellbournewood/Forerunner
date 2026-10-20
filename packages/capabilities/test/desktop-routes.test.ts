import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import { MemoryAudit } from "@forerunner/runtime";
import { describe, expect, it } from "vitest";
import { FakeDesktopAdapter } from "../src/desktop/adapters/fake.ts";
import { MemoryAllowlistStore } from "../src/desktop/allowlist.ts";
import { DesktopController } from "../src/desktop/controller.ts";
import { RecordingIndicator } from "../src/desktop/indicator.ts";
import {
  createDesktopRoutes,
  type DesktopRouteApp,
  type DesktopRouteContext,
  type DesktopRouteHandler,
  desktopErrorStatus,
} from "../src/desktop/routes.ts";

interface CallOptions {
  params?: Record<string, string>;
  body?: unknown;
  human?: string;
}

/** The slice of Hono the routes use, with a direct call helper (no HTTP, no hono dependency). */
class FakeApp implements DesktopRouteApp {
  readonly routes = new Map<string, DesktopRouteHandler>();
  get(path: string, handler: DesktopRouteHandler): void {
    this.routes.set(`GET ${path}`, handler);
  }
  put(path: string, handler: DesktopRouteHandler): void {
    this.routes.set(`PUT ${path}`, handler);
  }
  post(path: string, handler: DesktopRouteHandler): void {
    this.routes.set(`POST ${path}`, handler);
  }
  async call(key: string, opts: CallOptions = {}): Promise<{ status: number; body: unknown }> {
    const handler = this.routes.get(key);
    if (!handler) throw new Error(`no route ${key}`);
    let status = 200;
    let out: unknown;
    const c: DesktopRouteContext = {
      req: {
        param: (name) => opts.params?.[name],
        query: () => undefined,
        json: async () => opts.body,
        header: (name) => (name === "x-human" ? opts.human : undefined),
      },
      json: (body, s) => {
        status = s ?? 200;
        out = body;
        return new Response(JSON.stringify(body), { status });
      },
    };
    await handler(c);
    return { status, body: out };
  }
}

function world(opts: { humanFor?: boolean } = {}) {
  const clock = new SimulatedClock();
  const audit = new MemoryAudit();
  const adapter = new FakeDesktopAdapter();
  const controller = new DesktopController({
    adapter,
    binding: async () => ({ enabled: true, autonomy: 3, allowlist: [] }),
    indicator: new RecordingIndicator(),
    audit,
    clock,
  });
  const allowlist = new MemoryAllowlistStore({ h1: ["code"] });
  const app = createDesktopRoutes(
    {
      controller,
      allowlist,
      clock,
      audit,
      detect: async () => ({
        platform: "linux",
        displayServer: "x11",
        adapter,
        found: { xdotool: "/usr/bin/xdotool" },
        missing: ["wmctrl"],
        notes: [],
      }),
      ...(opts.humanFor ? { humanFor: (c) => c.req.header?.("x-human") } : {}),
    },
    new FakeApp(),
  );
  return { app, controller, allowlist, audit };
}

describe("desktop routes", () => {
  it("status reports the controller and what the platform is missing", async () => {
    const { app } = world();
    const r = await app.call("GET /desktop/status");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      capability: "desktop-control",
      adapter: "fake",
      revoked: false,
      indicatorOn: false,
      detection: { platform: "linux", available: true, missing: ["wmctrl"] },
    });
  });

  it("reads and writes the per-human allowlist, validating and auditing the change", async () => {
    const { app, allowlist, audit } = world();
    expect(
      (await app.call("GET /desktop/allowlist/:humanId", { params: { humanId: "h1" } })).body,
    ).toEqual({
      humanId: "h1",
      entries: [{ app: "code" }],
    });
    const put = await app.call("PUT /desktop/allowlist/:humanId", {
      params: { humanId: "h1" },
      body: { entries: ["exe:notepad", { windowClass: "Gimp", note: "images" }] },
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      humanId: "h1",
      entries: [{ exe: "notepad" }, { windowClass: "gimp", note: "images" }],
    });
    expect(await allowlist.get("h1")).toHaveLength(2);
    expect(audit.entries.at(-1)).toMatchObject({
      tool: "desktop_allowlist",
      humanId: "h1",
      allowed: true,
    });
    const bad = await app.call("PUT /desktop/allowlist/:humanId", {
      params: { humanId: "h1" },
      body: { entries: [{ note: "nothing" }] },
    });
    expect(bad.status).toBe(400);
    expect(await allowlist.get("h1")).toHaveLength(2);
    const missing = await app.call("GET /desktop/allowlist/:humanId", { params: {} });
    expect(missing.status).toBe(400);
  });

  it("allowlist changes need a signed-in human when the daemon identifies one", async () => {
    const { app } = world({ humanFor: true });
    const anon = await app.call("PUT /desktop/allowlist/:humanId", {
      params: { humanId: "h1" },
      body: { entries: ["code"] },
    });
    expect(anon.status).toBe(403);
    const ok = await app.call("PUT /desktop/allowlist/:humanId", {
      params: { humanId: "h1" },
      body: { entries: ["code"] },
      human: "h1",
    });
    expect(ok.status).toBe(200);
  });

  it("a signed-in human reaches only their own allowlist; resume needs a human, revoke stays open", async () => {
    const { app, allowlist, controller } = world({ humanFor: true });
    const other = await app.call("PUT /desktop/allowlist/:humanId", {
      params: { humanId: "h1" },
      body: { entries: ["firefox"] },
      human: "h2",
    });
    expect(other.status).toBe(403);
    expect(await allowlist.get("h1")).toEqual([{ app: "code" }]);
    const read = await app.call("GET /desktop/allowlist/:humanId", {
      params: { humanId: "h1" },
      human: "h2",
    });
    expect(read.status).toBe(403);
    const own = await app.call("GET /desktop/allowlist/:humanId", {
      params: { humanId: "h1" },
      human: "h1",
    });
    expect(own.status).toBe(200);
    // Revoke is fail-safe and open to anyone; resume widens and needs a signed-in human.
    const revoked = await app.call("POST /desktop/revoke", { body: {} });
    expect(revoked.status).toBe(200);
    expect(controller.status().revoked).toBe(true);
    const anonResume = await app.call("POST /desktop/resume");
    expect(anonResume.status).toBe(403);
    expect(controller.status().revoked).toBe(true);
    const resumed = await app.call("POST /desktop/resume", { human: "h1" });
    expect(resumed.status).toBe(200);
    expect(controller.status().revoked).toBe(false);
  });

  it("revoke stops the controller live and resume lifts it", async () => {
    const { app, controller, audit } = world();
    const r = await app.call("POST /desktop/revoke", { body: { reason: "panel" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      reason: "panel",
      interrupted: 0,
      dropped: 0,
      status: { revoked: true, revokedReason: "panel" },
    });
    expect(controller.status().revoked).toBe(true);
    expect(audit.entries.at(-1)).toMatchObject({ tool: "desktop_revoke", inputSummary: "panel" });
    const noBody = await app.call("POST /desktop/revoke", { body: undefined });
    expect(noBody.body).toMatchObject({ reason: "revoked from the panel" });
    const resumed = await app.call("POST /desktop/resume");
    expect(resumed.body).toMatchObject({ revoked: false });
    expect(controller.status().revoked).toBe(false);
  });

  it("maps error codes to HTTP statuses", () => {
    expect(desktopErrorStatus(new ForerunnerError("validation", "x"))).toBe(400);
    expect(desktopErrorStatus(new ForerunnerError("tool_not_allowed", "x"))).toBe(403);
    expect(desktopErrorStatus(new ForerunnerError("not_found", "x"))).toBe(404);
    expect(desktopErrorStatus(new ForerunnerError("internal", "x"))).toBe(500);
  });
});
