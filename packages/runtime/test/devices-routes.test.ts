import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, silenceSqliteExperimentalWarning } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAEMON_ROUTES } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  DEVICE_AUDIT,
  DeviceListView,
  DeviceManager,
  type DeviceServiceConfig,
  PairingStartView,
  pairingLink,
  RevokeDeviceView,
} from "../src/devices/index.ts";
import { createDeviceRoutes } from "../src/devices/routes.ts";
import { SHARED_SECRET_AUDIT } from "../src/secrets/shared-grants.ts";
import { ScriptedProvider } from "./helpers.ts";

silenceSqliteExperimentalWarning();

const SERVICE = "https://state.example.test";
/** Built by concatenation so the secret scan never sees a credential shape. */
const ADMIN = ["admin", "token", "for", "device", "routes"].join("-"); // not-a-secret
const CODE = "ABCD2345";

type Loose = Record<string, unknown> & { code?: string; message?: string };
const json = (method: string, path: string, body?: unknown) =>
  new Request(`http://local${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const read = async (r: Response): Promise<Loose> => (await r.json()) as Loose;

interface FakeDevice {
  id: string;
  ownerHumanId: string;
  name: string;
  platform: string;
  kind: string;
  lastSeen: string | null;
  revoked: boolean;
  revokedAt: string | null;
  pairedAt: string;
  version: number;
}

/**
 * A stand-in for the state service's admin routes with the same shapes and refusals as
 * `services/state-api/src/routes/devices.ts` (the real routes are exercised end to end by
 * `services/state-api/test/desktop-devices.test.ts`). Records every call with its bearer.
 */
function fakeService(devices: FakeDevice[]) {
  const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    const raw = await c.req.raw
      .clone()
      .text()
      .catch(() => "");
    calls.push({
      method: c.req.method,
      path: new URL(c.req.url).pathname + new URL(c.req.url).search,
      auth: c.req.header("authorization") ?? null,
      body: raw ? JSON.parse(raw) : null,
    });
    if (c.req.header("authorization") !== `Bearer ${ADMIN}`) {
      return c.json({ code: "unauthorized", message: "missing or invalid token" }, 401);
    }
    return next();
  });
  app.post("/pairing/start", async (c) => {
    const body = (await c.req.json()) as { humanId: string; kind?: string };
    return c.json(
      { code: CODE, expiresAt: "2026-10-23T09:10:00.000Z", kind: body.kind ?? "phone" },
      201,
    );
  });
  app.get("/devices", (c) => {
    const humanId = c.req.query("humanId");
    return c.json({ devices: devices.filter((d) => !humanId || d.ownerHumanId === humanId) });
  });
  app.post("/devices/:id/revoke", (c) => {
    const d = devices.find((x) => x.id === c.req.param("id"));
    if (!d) return c.json({ code: "not_found", message: "device not found" }, 404);
    d.revoked = true;
    d.revokedAt = "2026-10-23T09:01:00.000Z";
    d.version += 1;
    return c.json({ device: d, tokensRevoked: 2 });
  });
  const fetchFn: typeof fetch = async (input, init) =>
    app.request(String(input), init as RequestInit);
  return { app, calls, fetch: fetchFn };
}

const device = (id: string, ownerHumanId: string, kind = "phone"): FakeDevice => ({
  id,
  ownerHumanId,
  name: `${kind} ${id}`,
  platform: kind === "phone" ? "android" : "linux",
  kind,
  lastSeen: "2026-10-23T08:55:00.000Z",
  revoked: false,
  revokedAt: null,
  pairedAt: "2026-10-01T09:00:00.000Z",
  version: 1,
});

/**
 * The daemon's Settings -> Devices routes (spec R.2): list, start a pairing (the code, its
 * expiry and the fr:// link the QR encodes) and revoke at once, through the state service with
 * the admin token the daemon alone holds, or over the shared store when no service is set.
 */
describe("device routes over the state service", () => {
  let store: StateStore;
  const clock = new SimulatedClock("2026-10-23T09:00:00.000Z");
  let ada = "";

  beforeAll(async () => {
    store = await openStore({ url: "sqlite::memory:", clock });
    ada = (await store.human.insert({ name: "Ada", email: "ada@example.test" })).id;
  });
  afterAll(async () => {
    await store.close();
  });

  const routesWith = (service: DeviceServiceConfig | null, current: string | null = "dev_pc") =>
    createDeviceRoutes({
      devices: new DeviceManager({
        store,
        clock,
        humanId: ada,
        currentDeviceId: () => current,
        service,
      }),
    });

  it("starts a pairing: 201 with the code, expiry and the fr:// link; the admin token stays here", async () => {
    const svc = fakeService([]);
    const app = routesWith({ baseUrl: `${SERVICE}/`, adminToken: async () => ADMIN, ...svc });
    const res = await app.fetch(json("POST", "/devices/pairing", { kind: "phone" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const view = PairingStartView.parse(body);
    expect(view).toEqual({
      code: CODE,
      expiresAt: "2026-10-23T09:10:00.000Z",
      kind: "phone",
      humanId: ada,
      serviceUrl: SERVICE,
      link: pairingLink(SERVICE, CODE, ada),
    });
    expect(new URL(view.link).searchParams.get("c")).toBe(CODE);
    expect(JSON.stringify(body)).not.toContain(ADMIN);
    expect(svc.calls).toEqual([
      {
        method: "POST",
        path: "/pairing/start",
        auth: `Bearer ${ADMIN}`,
        body: { humanId: ada, kind: "phone" },
      },
    ]);
    // The code is a one-time secret: the audit row has the kind and the expiry only.
    const audit = await store.auditLog.list({ tool: DEVICE_AUDIT.pairingStarted });
    expect(audit.at(-1)?.input_summary).toBe("kind=phone");
    expect(JSON.stringify(audit)).not.toContain(CODE);
  });

  it("refuses a bad body with 400 and answers 503 unavailable without the service, the token or a reachable host", async () => {
    const svc = fakeService([]);
    const ok = routesWith({ baseUrl: SERVICE, adminToken: async () => ADMIN, ...svc });
    const bad = await ok.fetch(json("POST", "/devices/pairing", { kind: "tablet" }));
    expect(bad.status).toBe(400);
    expect((await read(bad)).code).toBe("validation");

    const none = await routesWith(null).fetch(json("POST", "/devices/pairing", {}));
    expect(none.status).toBe(503);
    const noneBody = await read(none);
    expect(noneBody.code).toBe("unavailable");
    expect(noneBody.message).toContain("FORERUNNER_STATE_API_URL");

    const noToken = routesWith({ baseUrl: SERVICE, adminToken: async () => null, ...svc });
    const missing = await noToken.fetch(json("POST", "/devices/pairing", {}));
    expect(missing.status).toBe(503);
    expect((await read(missing)).message).toContain("admin token");
    expect(svc.calls).toHaveLength(0);

    const wrong = routesWith({ baseUrl: SERVICE, adminToken: async () => "wrong", ...svc });
    const refused = await wrong.fetch(json("POST", "/devices/pairing", {}));
    expect(refused.status).toBe(503);
    const refusedBody = await read(refused);
    expect(refusedBody.message).toBe("state service answered 401 unauthorized");
    expect(JSON.stringify(refusedBody)).not.toContain("wrong");

    const down = routesWith({
      baseUrl: SERVICE,
      adminToken: async () => ADMIN,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const unreachable = await down.fetch(json("GET", "/devices"));
    expect(unreachable.status).toBe(503);
    expect((await read(unreachable)).message).toContain("state service unreachable");
  });

  it("lists the human's devices from the service, this install marked current, another human's filtered", async () => {
    const svc = fakeService([
      device("dev_phone", ada),
      device("dev_pc", ada, "desktop"),
      device("dev_bob", "hum_bob"),
    ]);
    const app = routesWith({ baseUrl: SERVICE, adminToken: async () => ADMIN, ...svc });
    const res = await app.fetch(json("GET", "/devices"));
    expect(res.status).toBe(200);
    const view = DeviceListView.parse(await res.json());
    expect(view.pairingAvailable).toBe(true);
    expect(view.devices.map((d) => [d.id, d.current])).toEqual([
      ["dev_phone", false],
      ["dev_pc", true],
    ]);
    expect(svc.calls[0]?.path).toBe(`/devices?humanId=${ada}`);
  });

  it("revokes at once through the service; this install's own device and another human's are refused", async () => {
    const devices = [device("dev_phone", ada), device("dev_pc", ada, "desktop")];
    const svc = fakeService([...devices, device("dev_bob", "hum_bob")]);
    const app = routesWith({ baseUrl: SERVICE, adminToken: async () => ADMIN, ...svc });
    const res = await app.fetch(json("POST", "/devices/dev_phone/revoke"));
    expect(res.status).toBe(200);
    const view = RevokeDeviceView.parse(await res.json());
    expect(view.device).toMatchObject({ id: "dev_phone", revoked: true, current: false });
    expect(view.tokensRevoked).toBe(2);
    expect(view).toMatchObject({ via: "service", serviceError: null });
    expect(svc.calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/devices/dev_phone/revoke",
      auth: `Bearer ${ADMIN}`,
    });
    const audit = await store.auditLog.list({ tool: DEVICE_AUDIT.revoked });
    expect(audit.at(-1)?.input_summary).toBe("device=dev_phone kind=phone");

    const own = await app.fetch(json("POST", "/devices/dev_pc/revoke"));
    expect(own.status).toBe(400);
    expect((await read(own)).code).toBe("validation");
    const before = svc.calls.length;
    const bobs = await app.fetch(json("POST", "/devices/dev_bob/revoke"));
    expect(bobs.status).toBe(404);
    // Ownership is checked against the human's list; the revoke route is never called.
    expect(svc.calls.slice(before).map((c) => c.path)).toEqual([`/devices?humanId=${ada}`]);
  });

  it("without a service lists and revokes over the shared store; pairing is reported unavailable", async () => {
    const phone = await store.device.register({
      owner_human_id: ada,
      name: "Ada's phone",
      platform: "android",
      public_key: ["pk-", "A".repeat(40)].join(""), // not-a-secret
      kind: "phone",
    });
    const bob = await store.human.insert({ name: "Bob", email: "bob@example.test" });
    const bobs = await store.device.register({
      owner_human_id: bob.id,
      name: "Bob's phone",
      platform: "android",
      public_key: ["pk-", "B".repeat(40)].join(""), // not-a-secret
      kind: "phone",
    });
    const app = routesWith(null, null);
    const list = DeviceListView.parse(await (await app.fetch(json("GET", "/devices"))).json());
    expect(list.pairingAvailable).toBe(false);
    expect(list.devices.map((d) => d.id)).toEqual([phone.id]);

    const res = await app.fetch(json("POST", `/devices/${phone.id}/revoke`));
    expect(res.status).toBe(200);
    const view = RevokeDeviceView.parse(await res.json());
    expect(view).toMatchObject({ device: { revoked: true }, tokensRevoked: null });
    expect((await store.device.get(phone.id))?.revoked).toBe(true);

    expect((await app.fetch(json("POST", `/devices/${bobs.id}/revoke`))).status).toBe(403);
    expect((await store.device.get(bobs.id))?.revoked).toBe(false);
    expect((await app.fetch(json("POST", "/devices/dev_nope/revoke"))).status).toBe(404);

    // Spec S.13 with R.2: revoking Ada's other PC drops the shared-secret copies wrapped to
    // it from every open grant; the copy for this PC stays, and so does the grant.
    const laptop = await store.device.register({
      owner_human_id: ada,
      name: "Ada's laptop",
      platform: "linux",
      public_key: ["pk-", "L".repeat(40)].join(""), // not-a-secret
      kind: "desktop",
      wrap_public_key: "x".repeat(44),
    });
    const alice = await store.agent.insert({ name: "Alice", owner_human_id: ada });
    const blob = {
      v: 1,
      ciphertext: "Y3Q=",
      tag: "dGFn",
      iv: "aXY=",
      salt: "cw==",
      ephemeralPublicKey: "ZQ==",
    };
    const grant = await store.secretGrant.propose({
      name: "org_deploy_token",
      owner_human_id: bob.id,
      agent_ids: [alice.id],
      required_human_ids: [],
      blobs: [
        { agent_id: alice.id, device_id: laptop.id, blob },
        { agent_id: alice.id, device_id: "dev_pc", blob },
      ],
    });
    expect((await app.fetch(json("POST", `/devices/${laptop.id}/revoke`))).status).toBe(200);
    const after = await store.secretGrant.mustGet(grant.id);
    expect(after.status).toBe("active");
    expect(after.blobs.map((b) => b.device_id)).toEqual(["dev_pc"]);
    expect(await store.auditLog.list({ tool: SHARED_SECRET_AUDIT.blobsDropped })).toHaveLength(1);
  });
});

describe("device revocation when the state service is out, and the change log", () => {
  let store: StateStore;
  const clock = new SimulatedClock("2026-10-23T09:00:00.000Z");
  let ada = "";
  let n = 0;

  beforeAll(async () => {
    store = await openStore({ url: "sqlite::memory:", clock });
    ada = (await store.human.insert({ name: "Ada", email: "ada@example.test" })).id;
  });
  afterAll(async () => {
    await store.close();
  });

  const phoneOf = (owner: string) =>
    store.device.register({
      owner_human_id: owner,
      name: `phone ${++n}`,
      platform: "android",
      public_key: ["pk-", String(n).padStart(3, "0"), "C".repeat(40)].join(""), // not-a-secret
      kind: "phone",
    });
  const managerWith = (service: DeviceServiceConfig | null) =>
    new DeviceManager({
      store,
      clock,
      humanId: ada,
      agentId: "agent_ada",
      currentDeviceId: () => null,
      service,
    });
  /** A service that accepts the request and never answers, until the caller aborts. */
  const hungFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  it("gives up on a service that never answers and reports unavailable instead of hanging", async () => {
    const app = createDeviceRoutes({
      devices: managerWith({
        baseUrl: SERVICE,
        adminToken: async () => ADMIN,
        fetch: hungFetch,
        timeoutMs: 50,
      }),
    });
    const res = await app.fetch(json("POST", "/devices/pairing", {}));
    expect(res.status).toBe(503);
    const body = await read(res);
    expect(body.code).toBe("unavailable");
    expect(body.message).toBe("state service did not answer within 50 ms");
  });

  it("revokes a lost phone in the shared store when the service is down, hung or refuses the token", async () => {
    const failing: [string, Partial<DeviceServiceConfig>][] = [
      [
        "down",
        {
          fetch: async () => {
            throw new TypeError("fetch failed");
          },
        },
      ],
      ["hung", { fetch: hungFetch, timeoutMs: 50 }],
      ["5xx", { fetch: async () => new Response("bad gateway", { status: 502 }) }],
      ["no token", { adminToken: async () => null, fetch: hungFetch }],
    ];
    for (const [label, cfg] of failing) {
      const phone = await phoneOf(ada);
      const app = createDeviceRoutes({
        devices: managerWith({ baseUrl: SERVICE, adminToken: async () => ADMIN, ...cfg }),
      });
      const res = await app.fetch(json("POST", `/devices/${phone.id}/revoke`));
      expect(res.status, label).toBe(200);
      const view = RevokeDeviceView.parse(await res.json());
      expect(view, label).toMatchObject({
        device: { id: phone.id, revoked: true },
        tokensRevoked: null,
        via: "store",
      });
      expect(view.serviceError, label).toMatch(/state service|admin token/);
      expect((await store.device.get(phone.id))?.revoked, label).toBe(true);
    }
    const audit = await store.auditLog.list({ tool: DEVICE_AUDIT.revoked });
    expect(audit.at(-1)?.result_summary).toContain("the state service failed");
  });

  it("does not touch the store when the service refuses the revocation itself (404) or the row is not local", async () => {
    const phone = await phoneOf(ada);
    const notFound = managerWith({
      baseUrl: SERVICE,
      adminToken: async () => ADMIN,
      fetch: async () =>
        Response.json({ code: "not_found", message: "device not found" }, { status: 404 }),
    });
    await expect(notFound.revoke(phone.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await store.device.get(phone.id))?.revoked).toBe(false);
    const down = managerWith({
      baseUrl: SERVICE,
      adminToken: async () => ADMIN,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down.revoke("dev_only_at_the_service")).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("writes the change log row of device.revoke (source ui, irreversible) once per revocation", async () => {
    const phone = await phoneOf(ada);
    const before = (await store.changeLog.list()).length;
    const local = managerWith(null);
    await local.revoke(phone.id);
    const rows = await store.changeLog.list(undefined, { orderBy: "created_at desc" });
    expect(rows).toHaveLength(before + 1);
    const row = rows.find((r) =>
      JSON.stringify(r.commands).includes(phone.id),
    ) as (typeof rows)[number];
    expect(row).toMatchObject({
      human_id: ada,
      agent_id: "agent_ada",
      commands: [{ name: "device.revoke", params: { device: phone.id } }],
      before: { device_id: phone.id, revoked: false },
      after: { device_id: phone.id, revoked: true },
      scope: "global",
      undo_state: "irreversible",
      source: "ui",
      sentence: `Revoked the device ${phone.name}; it must be paired again to reconnect.`,
    });
    // Revoking it again changes nothing, so nothing more is logged.
    await local.revoke(phone.id);
    expect(await store.changeLog.list()).toHaveLength(before + 1);

    // Through the service too.
    const svcPhone = device("dev_svc_phone", ada);
    const svc = fakeService([svcPhone]);
    await managerWith({ baseUrl: SERVICE, adminToken: async () => ADMIN, ...svc }).revoke(
      "dev_svc_phone",
    );
    const all = await store.changeLog.list();
    expect(all).toHaveLength(before + 2);
    expect(JSON.stringify(all)).toContain("dev_svc_phone");
  });
});

describe("device routes in the composed daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let home: string;
  let svc: ReturnType<typeof fakeService>;
  const clock = new SimulatedClock("2026-10-23T09:00:00.000Z");
  const req = (path: string, init: RequestInit = {}, auth = true) =>
    app.request(path, {
      ...init,
      headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-devices-daemon-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    const vault = new MemoryVault();
    // The default reference: the admin token is read from the vault per call.
    await vault.set("state_api_admin", ADMIN);
    svc = fakeService([]);
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home, FORERUNNER_STATE_API_URL: SERVICE },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault,
      provider: new ScriptedProvider([{ text: "Noted." }], clock),
      registryDir: join(process.cwd(), "evals", "registry"),
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      devices: { fetch: svc.fetch },
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists the three routes in the route table and mounts them behind the bearer", async () => {
    expect(DAEMON_ROUTES.devices.startsWith("GET /devices ")).toBe(true);
    expect(DAEMON_ROUTES.startPairing.startsWith("POST /devices/pairing ")).toBe(true);
    expect(DAEMON_ROUTES.revokeDevice.startsWith("POST /devices/:id/revoke ")).toBe(true);
    expect((await req("/devices", {}, false)).status).toBe(401);
    expect((await req("/devices/pairing", { method: "POST", body: "{}" }, false)).status).toBe(401);
    const list = DeviceListView.parse(await (await req("/devices")).json());
    expect(list).toEqual({ devices: [], pairingAvailable: true });
  });

  it("starts a pairing for the daemon's human with the vault's admin token from FORERUNNER_STATE_API_URL", async () => {
    const res = await req("/devices/pairing", { method: "POST", body: "{}" });
    expect(res.status).toBe(201);
    const view = PairingStartView.parse(await res.json());
    expect(view.humanId).toBe(rt.human.id);
    expect(view.link).toBe(pairingLink(SERVICE, CODE, rt.human.id));
    expect(svc.calls.at(-1)).toMatchObject({
      path: "/pairing/start",
      auth: `Bearer ${ADMIN}`,
      body: { humanId: rt.human.id, kind: "phone" },
    });
  });
});

describe("what to set up before pairing a phone, in words (U-055)", () => {
  /** A daemon as an installed app starts it: `env` and a vault, nothing injected. */
  const start = async (env: Record<string, string>, vault = new MemoryVault()) => {
    const home = mkdtempSync(join(tmpdir(), "fr-devices-setup-"));
    const clock = new SimulatedClock("2026-10-31T09:00:00.000Z");
    const svc = fakeService([]);
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home, ...env },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault,
      provider: new ScriptedProvider([{ text: "Noted." }], clock),
      registryDir: join(process.cwd(), "evals", "registry"),
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      devices: { fetch: svc.fetch },
    });
    const { app, token } = createDaemonApp(rt);
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    return { rt, svc, req, vault };
  };
  const runtimes: RuntimeApp[] = [];
  afterAll(async () => {
    for (const rt of runtimes) await rt.close().catch(() => undefined);
  });
  const GUIDE =
    "https://github.com/joelwellbournewood/Forerunner/blob/HEAD/docs/setup-guide.md#what-to-set-up-first-the-shared-state-service";

  it("without a state service: the list says what is missing and links the guide; Pair a phone says it in words", async () => {
    const d = await start({});
    runtimes.push(d.rt);
    const list = DeviceListView.parse(await (await d.req("/devices")).json());
    // The list comes from the store (this PC's own row); pairing says what it needs.
    expect(list.devices.map((x) => x.kind)).toEqual(["desktop"]);
    expect({ ...list, devices: [] }).toEqual({
      devices: [],
      pairingAvailable: false,
      pairingSetup: {
        serviceUrl: null,
        adminSecretName: "state_api_admin",
        adminSecretStored: false,
        guideUrl: GUIDE,
      },
    });
    const refused = await d.req("/devices/pairing", { method: "POST", body: "{}" });
    expect(refused.status).toBe(503);
    const message = String((await read(refused)).message);
    expect(message).toContain("shared state service");
    expect(message).toContain("environment variable FORERUNNER_STATE_API_URL");
    expect(message).toContain("Settings → Devices");
    expect(message).not.toContain("FORERUNNER_STATE_API_ADMIN_TOKEN_REF");
  }, 120_000);

  it("with the service's address but no admin secret: the list still answers, and pasting the secret makes pairing ready", async () => {
    const d = await start({ FORERUNNER_STATE_API_URL: SERVICE });
    runtimes.push(d.rt);
    const before = DeviceListView.parse(await (await d.req("/devices")).json());
    expect(before).toMatchObject({
      pairingAvailable: false,
      pairingSetup: { serviceUrl: SERVICE, adminSecretStored: false },
    });
    expect(d.svc.calls).toHaveLength(0);
    const refused = await d.req("/devices/pairing", { method: "POST", body: "{}" });
    expect(String((await read(refused)).message)).toContain(
      "The state service's admin token is not saved on this computer",
    );
    // Settings → Devices stores it through the app's secret box (U-054's route).
    const stored = await d.req("/secrets/store", {
      method: "POST",
      body: JSON.stringify({ name: "state_api_admin", value: ADMIN }),
    });
    expect(stored.status).toBe(200);
    const after = DeviceListView.parse(await (await d.req("/devices")).json());
    expect(after).toEqual({ devices: [], pairingAvailable: true });
    expect((await d.req("/devices/pairing", { method: "POST", body: "{}" })).status).toBe(201);
  }, 120_000);
});
