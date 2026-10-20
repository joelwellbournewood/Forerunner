import { SimulatedClock } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import {
  canonicalRequest,
  generateDeviceKeyPair,
  signPairingProof,
  signRequest,
  verifyRequestSignature,
} from "../src/auth/crypto.ts";
import { resolveScopes } from "../src/auth/scopes.ts";
import { TokenBucketLimiter } from "../src/ratelimit.ts";
import { ADMIN_TOKEN, Client, type Harness, harness, json, START } from "./helpers.ts";

describe("device identity primitives", () => {
  it("signs and verifies the canonical request, and the biometric flag is inside the signature", () => {
    const keys = generateDeviceKeyPair();
    const parts = {
      method: "post",
      path: "/messages?x=1",
      body: '{"a":1}',
      timestamp: "1700000000000",
      biometric: false,
    };
    const sig = signRequest(keys.secretKey, parts);
    expect(verifyRequestSignature(keys.publicKey, sig, parts)).toBe(true);
    expect(verifyRequestSignature(keys.publicKey, sig, { ...parts, biometric: true })).toBe(false);
    expect(verifyRequestSignature(keys.publicKey, sig, { ...parts, body: '{"a":2}' })).toBe(false);
    expect(verifyRequestSignature(keys.publicKey, sig, { ...parts, path: "/messages" })).toBe(
      false,
    );
    expect(verifyRequestSignature(generateDeviceKeyPair().publicKey, sig, parts)).toBe(false);
    expect(canonicalRequest(parts).split("\n")).toHaveLength(5);
  });

  it("resolves scopes per device kind and rejects confirm:high as an issuable scope", () => {
    expect(resolveScopes("phone", undefined)).toEqual({
      ok: true,
      scopes: ["read", "write:inbox", "write:queue", "write:remote", "write:approvals"],
    });
    expect(resolveScopes("web", undefined)).toEqual({
      ok: true,
      scopes: ["read", "write:inbox", "write:queue", "write:approvals"],
    });
    expect(resolveScopes("phone", ["write:inbox"])).toEqual({
      ok: true,
      scopes: ["read", "write:inbox"],
    });
    expect(resolveScopes("phone", ["confirm:high"])).toEqual({
      ok: false,
      invalid: ["confirm:high"],
    });
    expect(resolveScopes("phone", ["admin"])).toEqual({ ok: false, invalid: ["admin"] });
  });
});

describe("pairing and session tokens", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it("pairs a phone through a one-time code and the token carries the scopes", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    const me = await json(await phone.get("/me"));
    expect(me.principal).toBe("device");
    expect(me.humanId).toBe(h.seed.ada.id);
    expect(me.scopes).toEqual([
      "read",
      "write:inbox",
      "write:queue",
      "write:remote",
      "write:approvals",
    ]);
    const devices = await json<{ devices: { id: string; kind: string; revoked: boolean }[] }>(
      await h.admin.get(`/devices?humanId=${h.seed.ada.id}`),
    );
    expect(
      devices.devices.some((d) => d.id === phone.deviceId && d.kind === "phone" && !d.revoked),
    ).toBe(true);
  });

  it("only the admin starts a pairing, and the code is single use", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    expect((await phone.post("/pairing/start", { humanId: h.seed.ada.id })).status).toBe(403);
    expect((await h.anonymous.post("/pairing/start", { humanId: h.seed.ada.id })).status).toBe(401);

    const start = await json<{ code: string }>(
      await h.admin.post("/pairing/start", { humanId: h.seed.ada.id }),
    );
    const keys = generateDeviceKeyPair();
    const complete = (code: string, k = keys) =>
      h.anonymous.post("/pairing/complete", {
        code,
        publicKey: k.publicKey,
        proof: signPairingProof(k.secretKey, code),
        platform: "android",
      });
    expect((await complete(start.code)).status).toBe(201);
    const again = await complete(start.code, generateDeviceKeyPair());
    expect(again.status).toBe(400);
    expect((await json(again)).code).toBe("pairing_invalid");
  });

  it("rejects a wrong proof, an unknown human and an expired code", async () => {
    const start = await json<{ code: string }>(
      await h.admin.post("/pairing/start", { humanId: h.seed.ada.id }),
    );
    const keys = generateDeviceKeyPair();
    const other = generateDeviceKeyPair();
    const bad = await h.anonymous.post("/pairing/complete", {
      code: start.code,
      publicKey: keys.publicKey,
      proof: signPairingProof(other.secretKey, start.code),
      platform: "android",
    });
    expect(bad.status).toBe(400);
    expect((await h.admin.post("/pairing/start", { humanId: "nobody" })).status).toBe(404);

    const short = await json<{ code: string }>(
      await h.admin.post("/pairing/start", { humanId: h.seed.ada.id, ttlSeconds: 30 }),
    );
    await h.clock.advance(31_000);
    const expired = await h.anonymous.post("/pairing/complete", {
      code: short.code,
      publicKey: keys.publicKey,
      proof: signPairingProof(keys.secretKey, short.code),
      platform: "android",
    });
    expect(expired.status).toBe(400);
  });

  it("refuses requests without a bearer, with a bad bearer, and with an expired token", async () => {
    expect((await h.anonymous.get("/me")).status).toBe(401);
    expect((await new Client(h.app, "nope").get("/me")).status).toBe(401);
    const phone = await h.pairDevice(h.seed.ada.id);
    expect((await phone.get("/me")).status).toBe(200);
    await h.clock.advance(31 * 24 * 3600 * 1000);
    expect((await phone.get("/me")).status).toBe(401);
  });

  it("refuses a revoked device within one request and deletes its tokens", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    expect((await phone.get("/projects")).status).toBe(200);
    const revoke = await h.admin.post(`/devices/${phone.deviceId}/revoke`);
    expect(revoke.status).toBe(200);
    expect((await json<{ tokensRevoked: number }>(revoke)).tokensRevoked).toBe(1);
    const after = await phone.get("/projects");
    expect(after.status).toBe(401);
    expect((await json(after)).code).toBe("unauthorized");
    expect((await phone.post(`/devices/${phone.deviceId}/revoke`)).status).toBe(401);
  });

  it("lets a device list only its own human's devices", async () => {
    const adaPhone = await h.pairDevice(h.seed.ada.id);
    await h.pairDevice(h.seed.bob.id);
    const mine = await json<{ devices: { ownerHumanId: string }[] }>(
      await adaPhone.get("/devices"),
    );
    expect(mine.devices.every((d) => d.ownerHumanId === h.seed.ada.id)).toBe(true);
    expect((await adaPhone.get(`/devices?humanId=${h.seed.bob.id}`)).status).toBe(403);
  });
});

describe("request signatures", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  const body = () => ({
    fromAgentId: h.seed.alice.id,
    toHumanId: h.seed.ada.id,
    type: "info",
    body: "hello from the phone",
  });

  it("accepts a signed mutation and refuses an unsigned or corrupted one", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    expect((await phone.post("/messages", body())).status).toBe(201);
    const unsigned = await phone.post("/messages", body(), { unsigned: true });
    expect(unsigned.status).toBe(401);
    expect((await json(unsigned)).code).toBe("bad_signature");
    const corrupt = await phone.post("/messages", body(), { corruptSignature: true });
    expect(corrupt.status).toBe(401);
    expect((await json(corrupt)).code).toBe("bad_signature");
  });

  it("enforces the five-minute timestamp window in both directions", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    const old = String(h.clock.now() - 5 * 60_000 - 1);
    const stale = await phone.post("/messages", body(), { timestamp: old });
    expect(stale.status).toBe(401);
    const future = String(h.clock.now() + 5 * 60_000 + 1);
    expect((await phone.post("/messages", body(), { timestamp: future })).status).toBe(401);
    const edge = String(h.clock.now() - 5 * 60_000 + 1000);
    expect((await phone.post("/messages", body(), { timestamp: edge })).status).toBe(201);
    const iso = new Date(h.clock.now()).toISOString();
    expect((await phone.post("/messages", body(), { timestamp: iso })).status).toBe(201);
  });

  it("GET works without a signature; a signature on GET is verified when present", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    expect((await phone.get("/projects", { unsigned: true })).status).toBe(200);
    expect((await phone.get("/projects")).status).toBe(200);
    expect((await phone.get("/projects", { corruptSignature: true })).status).toBe(401);
  });

  it("refuses a replayed signed mutation inside the window; a re-signed retry and signed reads pass", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    const first = await phone.post("/messages", body());
    expect(first.status).toBe(201);
    // The identical request (same timestamp, same signature) captured and sent again.
    const replay = await phone.post("/messages", body());
    expect(replay.status).toBe(401);
    const err = await json<{ code: string; message: string }>(replay);
    expect(err.code).toBe("bad_signature");
    expect(err.message).toMatch(/replay/i);
    // A client that re-signs with a fresh timestamp is a new request.
    expect(
      (await phone.post("/messages", body(), { timestamp: String(h.clock.now() + 1) })).status,
    ).toBe(201);
    // Signed reads change nothing and may repeat.
    expect((await phone.get("/me")).status).toBe(200);
    expect((await phone.get("/me")).status).toBe(200);
    // Once the window has passed the signature is stale anyway and the guard has forgotten it.
    await h.clock.advance(5 * 60_000 + 1);
    await h.api.poller.pollOnce();
    expect(h.api.replay.size()).toBe(0);
  });

  it("signs the query string: a replay on a different query fails", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    const headers = (
      phone as unknown as {
        headersFor: (
          m: string,
          p: string,
          b: string | undefined,
          o: object,
        ) => Record<string, string>;
      }
    ).headersFor("GET", "/projects?all=1", undefined, {});
    const replay = await h.app.request("/projects?all=0", { method: "GET", headers });
    expect(replay.status).toBe(401);
  });
});

describe("scopes and high-risk confirmation", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it("refuses an action outside the token's scopes with 403", async () => {
    const web = await h.pairDevice(h.seed.ada.id, "web");
    const res = await web.post("/remote/commands", { target: "pc", command: "start", params: {} });
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("forbidden");
    const narrow = await h.pairDevice(h.seed.ada.id, "phone", ["read"]);
    expect(
      (await narrow.post(`/projects/${h.seed.project.id}/queue`, { text: "idea" })).status,
    ).toBe(403);
    expect((await narrow.get("/projects")).status).toBe(200);
  });

  it("answers a high-risk request only when the request is signed and carries the biometric flag", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    const request = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "approval",
      why: "Raise the monthly ceiling",
      risk: "high",
      blocking: true,
    });
    const path = `/requests/${request.id}/answer`;
    const answer = { version: request.version, answer: "yes" };
    const plain = await phone.post(path, answer);
    expect(plain.status).toBe(403);
    expect((await json(plain)).code).toBe("biometric_required");
    // The flag without a matching signature is a signature failure, not a grant.
    const forged = await phone.post(path, answer, { headers: { "x-biometric-assertion": "1" } });
    expect(forged.status).toBe(401);
    const ok = await phone.post(path, answer, { biometric: true });
    expect(ok.status).toBe(200);
    expect((await json(ok)).status).toBe("answered");
  });

  it("a low-risk request needs no biometric, and the admin needs neither", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    const low = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      kind: "decision",
      why: "Pick a colour",
      options: ["red", "blue"],
      risk: "low",
    });
    expect(
      (await phone.post(`/requests/${low.id}/answer`, { version: low.version, answer: "red" }))
        .status,
    ).toBe(200);
    const high = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      kind: "approval",
      why: "Grant",
      risk: "high",
    });
    expect(
      (await h.admin.post(`/requests/${high.id}/answer`, { version: high.version, answer: "yes" }))
        .status,
    ).toBe(200);
  });
});

describe("admin token, rate limit and schema compatibility", () => {
  it("accepts the admin token and never a prefix of it", async () => {
    const h = await harness();
    try {
      expect((await h.admin.get("/me")).status).toBe(200);
      expect((await json(await h.admin.get("/me"))).principal).toBe("admin");
      expect((await new Client(h.app, ADMIN_TOKEN.slice(0, -1)).get("/me")).status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("rate limits a device at the configured requests per minute and recovers with time", async () => {
    const h = await harness({ config: { adminToken: ADMIN_TOKEN, rateLimitPerMinute: 5 } });
    try {
      const phone = await h.pairDevice(h.seed.ada.id);
      for (let i = 0; i < 5; i++) expect((await phone.get("/me")).status).toBe(200);
      const limited = await phone.get("/me");
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      await h.clock.advance(13_000);
      expect((await phone.get("/me")).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it("keys the admin limiter per install when X-Forerunner-Install is sent", async () => {
    // Admin budget is ten times the device budget: 10 per minute here.
    const h = await harness({ config: { adminToken: ADMIN_TOKEN, rateLimitPerMinute: 1 } });
    try {
      const a = { headers: { "x-forerunner-install": "pc-ada" } };
      const b = { headers: { "x-forerunner-install": "cloud-runner-1" } };
      for (let i = 0; i < 10; i++) expect((await h.admin.get("/me", a)).status).toBe(200);
      expect((await h.admin.get("/me", a)).status).toBe(429);
      expect((await h.admin.get("/me", b)).status).toBe(200);
      expect((await json<{ installId: string }>(await h.admin.get("/me", b))).installId).toBe(
        "cloud-runner-1",
      );
      // A malformed install id is ignored (shared default bucket), never an error.
      const odd = await h.admin.get("/me", { headers: { "x-forerunner-install": "a b/c" } });
      expect([200, 429]).toContain(odd.status);
    } finally {
      await h.close();
    }
  });

  it("trusts X-Forwarded-For for the public pairing limiter only behind a declared proxy", async () => {
    // 60 per minute per device => 10 per minute for unauthenticated pairing completions.
    const attempt = (h: Harness, i: number) =>
      h.anonymous.post(
        "/pairing/complete",
        { code: "nope" },
        { headers: { "x-forwarded-for": `203.0.113.${i}` } },
      );
    const direct = await harness({ config: { adminToken: ADMIN_TOKEN, rateLimitPerMinute: 60 } });
    try {
      const statuses: number[] = [];
      for (let i = 1; i <= 12; i++) statuses.push((await attempt(direct, i)).status);
      // Spoofed addresses share one bucket (the socket), so the 11th request is limited.
      expect(statuses.filter((s) => s === 429).length).toBe(2);
      expect(statuses.filter((s) => s === 400).length).toBe(10);
    } finally {
      await direct.close();
    }
    const proxied = await harness({
      config: { adminToken: ADMIN_TOKEN, rateLimitPerMinute: 60, trustProxy: true },
    });
    try {
      const statuses: number[] = [];
      for (let i = 1; i <= 12; i++) statuses.push((await attempt(proxied, i)).status);
      expect(statuses.every((s) => s === 400)).toBe(true);
      // The same forwarded address is limited as one client.
      const same: number[] = [];
      for (let i = 0; i < 12; i++) same.push((await attempt(proxied, 7)).status);
      expect(same.filter((s) => s === 429).length).toBeGreaterThan(0);
    } finally {
      await proxied.close();
    }
  });

  it("the token bucket forgets idle buckets on sweep, caps its keys, and the poller tick sweeps", async () => {
    const clock = new SimulatedClock(START);
    const limiter = new TokenBucketLimiter(clock, 60, { maxKeys: 3 });
    for (const k of ["a", "b", "c"]) limiter.take(k);
    expect(limiter.size()).toBe(3);
    limiter.take("a"); // most recently used
    limiter.take("d"); // over the cap: the least recently used key ("b") goes
    expect(limiter.size()).toBe(3);
    expect(limiter.has("b")).toBe(false);
    expect(limiter.has("a")).toBe(true);
    await clock.advance(11 * 60_000);
    limiter.sweep();
    expect(limiter.size()).toBe(0);

    const h = await harness();
    try {
      const phone = await h.pairDevice(h.seed.ada.id);
      expect((await phone.get("/me")).status).toBe(200);
      expect(h.api.limiters.device.size()).toBe(1);
      expect(h.api.limiters.admin.size()).toBe(1);
      await h.clock.advance(11 * 60_000);
      await h.api.poller.pollOnce();
      expect(h.api.limiters.device.size()).toBe(0);
      expect(h.api.limiters.admin.size()).toBe(0);
      expect(h.api.limiters.public.size()).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("refuses a client that declares another schema version", async () => {
    const h = await harness();
    try {
      const health = await json<{ schema: { code: number; applied: number; state: string } }>(
        await h.app.request("/health"),
      );
      expect(health.schema.state).toBe("current");
      const ok = await h.admin.get("/projects", {
        headers: { "x-forerunner-schema": String(health.schema.code) },
      });
      expect(ok.status).toBe(200);
      const bad = await h.admin.get("/projects", {
        headers: { "x-forerunner-schema": String(health.schema.code + 1) },
      });
      expect(bad.status).toBe(409);
      expect((await json(bad)).code).toBe("schema_mismatch");
    } finally {
      await h.close();
    }
  });

  it("serves CORS headers only for the configured origin", async () => {
    const h = await harness({
      config: { adminToken: ADMIN_TOKEN, corsOrigin: "https://approvals.example.test" },
    });
    try {
      const preflight = await h.app.request("/projects", {
        method: "OPTIONS",
        headers: {
          origin: "https://approvals.example.test",
          "access-control-request-method": "GET",
        },
      });
      expect(preflight.headers.get("access-control-allow-origin")).toBe(
        "https://approvals.example.test",
      );
      const other = await h.app.request("/projects", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example.test", "access-control-request-method": "GET" },
      });
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await h.close();
    }
    const none = await harness();
    try {
      const res = await none.admin.get("/projects", {
        headers: { origin: "https://approvals.example.test" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await none.close();
    }
  });

  it("refuses bodies over the limit with 413", async () => {
    const h = await harness({ config: { adminToken: ADMIN_TOKEN, jsonBodyLimitBytes: 200 } });
    try {
      const big = await h.admin.post("/messages", {
        fromAgentId: h.seed.alice.id,
        toHumanId: h.seed.ada.id,
        body: "x".repeat(400),
      });
      expect(big.status).toBe(413);
    } finally {
      await h.close();
    }
  });

  it("createApp works without an admin token (devices only) and never logs it", async () => {
    const h = await harness();
    try {
      const app = createApp({
        store: h.store,
        clock: h.clock,
        startPoller: false,
        config: { adminToken: undefined },
      });
      const res = await app.app.request("/me", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(401);
      await app.close();
    } finally {
      await h.close();
    }
  });
});
