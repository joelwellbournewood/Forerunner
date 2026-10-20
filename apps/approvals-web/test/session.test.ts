import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSession,
  ExchangeError,
  exchangeCode,
  loadSession,
  parseFragment,
  SESSION_KEY,
  saveSession,
  stripFragment,
  type WebSession,
} from "../src/api/session.ts";
import { memoryStore } from "../src/lib/storage.ts";
import { type FakeStateService, startFakeStateService } from "./fake-state-service.ts";

const clock = { now: () => Date.now() };

function session(overrides: Partial<WebSession> = {}): WebSession {
  return {
    token: "tok", // not-a-secret
    deviceId: "dev-1",
    humanId: "h1",
    kind: "web",
    scopes: ["read"],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    publicKey: "pk",
    privateJwk: { kty: "OKP", crv: "Ed25519", d: "d", x: "x" },
    serviceUrl: "http://127.0.0.1:1",
    ...overrides,
  };
}

describe("parseFragment", () => {
  it("reads the code from the fragment only", () => {
    expect(parseFragment("#code=abcd2345")).toBe("ABCD2345");
    expect(parseFragment("code=ABCD2345")).toBe("ABCD2345");
    expect(parseFragment("#other=1&code=ABCD2345")).toBe("ABCD2345");
    expect(parseFragment("")).toBeNull();
    expect(parseFragment("#")).toBeNull();
    expect(parseFragment("#code=")).toBeNull();
    expect(parseFragment("#code=ab")).toBeNull();
    expect(parseFragment("#code=has space")).toBeNull();
    expect(parseFragment("?code=ABCD2345")).toBeNull();
  });

  it("stripFragment removes the code from the address bar", () => {
    window.location.hash = "#code=ABCD2345";
    stripFragment(window);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("ABCD2345");
  });
});

describe("session storage", () => {
  it("round trips, drops expired, foreign and malformed sessions", () => {
    const store = memoryStore();
    expect(loadSession(store, clock, "http://127.0.0.1:1")).toBeNull();
    saveSession(store, session());
    expect(loadSession(store, clock, "http://127.0.0.1:1")?.deviceId).toBe("dev-1");
    expect(loadSession(store, clock, "http://127.0.0.1:2")).toBeNull();
    saveSession(store, session({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(loadSession(store, clock, "http://127.0.0.1:1")).toBeNull();
    expect(store.get(SESSION_KEY)).toBeNull();
    store.set(SESSION_KEY, "{not json");
    expect(loadSession(store, clock, "http://127.0.0.1:1")).toBeNull();
    store.set(SESSION_KEY, JSON.stringify({ token: "x" }));
    expect(loadSession(store, clock, "http://127.0.0.1:1")).toBeNull();
    saveSession(store, session());
    clearSession(store);
    expect(store.get(SESSION_KEY)).toBeNull();
  });
});

describe("exchangeCode", () => {
  let fake: FakeStateService;
  beforeEach(async () => {
    fake = await startFakeStateService({ clock });
  });
  afterEach(async () => {
    await fake.close();
  });

  it("exchanges a one-time code for a scoped token, once", async () => {
    const code = fake.startPairing({ scopes: ["read", "write:approvals"] });
    const s = await exchangeCode({ baseUrl: fake.url, code, deviceName: "Test browser" });
    expect(s.token.length).toBeGreaterThan(20);
    expect(s.scopes).toEqual(["read", "write:approvals"]);
    expect(s.humanId).toBe("h1");
    expect(s.kind).toBe("web");
    expect(s.serviceUrl).toBe(fake.url);
    expect(fake.state.tokens.get(s.token)?.deviceId).toBe(s.deviceId);
    const device = fake.state.devices.find((d) => d.id === s.deviceId);
    expect(device?.publicKey).toBe(s.publicKey);
    expect(device?.name).toBe("Test browser");
    // The code travelled in the body of one POST, never in a path or query string.
    const calls = fake.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/pairing/complete");
    expect(calls.every((c) => !c.path.includes(code) && !c.query.includes(code))).toBe(true);
    await expect(
      exchangeCode({ baseUrl: fake.url, code, deviceName: "Test browser" }),
    ).rejects.toMatchObject({ code: "pairing_invalid" });
  });

  it("explains an unknown code, an unreachable service and a bad answer in plain words", async () => {
    const err = await exchangeCode({
      baseUrl: fake.url,
      code: "NOPE2345",
      deviceName: "x",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExchangeError);
    expect((err as ExchangeError).message).toMatch(/already used or has expired/);
    const down = await exchangeCode({
      baseUrl: "http://127.0.0.1:9",
      code: "NOPE2345",
      deviceName: "x",
    }).catch((e: unknown) => e as ExchangeError);
    expect((down as ExchangeError).code).toBe("web.network");
    const code = fake.startPairing();
    const bad = await exchangeCode({
      baseUrl: fake.url,
      code,
      deviceName: "x",
      fetchImpl: async () =>
        new Response(JSON.stringify({ nope: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    }).catch((e: unknown) => e as ExchangeError);
    expect((bad as ExchangeError).code).toBe("web.invalid_response");
  });
});
