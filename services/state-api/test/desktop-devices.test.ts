import { SimulatedClock } from "@forerunner/platform";
import { DEVICE_AUDIT, DeviceManager } from "@forerunner/runtime/devices/index";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateDeviceKeyPair, signPairingProof } from "../src/auth/crypto.ts";
import { ADMIN_TOKEN, Client, type Harness, harness, json, START } from "./helpers.ts";

const SERVICE = "https://state.example.test";

/**
 * Settings -> Devices end to end (spec R.2): the daemon's `DeviceManager` (what the desktop
 * app's Devices section calls through the daemon) against this service's real routes. The
 * daemon has its own local store, so everything it shows comes from the service through the
 * admin token, which only the manager holds. Start a pairing, the phone completes it with its
 * own key from the code in the `fr://` link, the list shows it, the revocation is immediate.
 */
describe("desktop Settings -> Devices over the state service", () => {
  let h: Harness;
  let local: StateStore;
  let calls: { url: string; auth: string | null }[];
  let manager: DeviceManager;

  const managerWith = (adminToken: string | null) =>
    new DeviceManager({
      store: local,
      clock: h.clock,
      humanId: h.seed.ada.id,
      currentDeviceId: () => h.seed.desktop.id,
      service: {
        baseUrl: `${SERVICE}/`,
        adminToken: async () => adminToken,
        fetch: async (input, init) => {
          const url = String(input);
          calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
          return h.app.request(url, init);
        },
      },
    });

  beforeEach(async () => {
    h = await harness();
    local = await openStore({ url: "sqlite::memory:", clock: new SimulatedClock(START) });
    calls = [];
    manager = managerWith(ADMIN_TOKEN);
  });
  afterEach(async () => {
    await local.close();
    await h.close();
  });

  it("starts a pairing whose fr:// link carries a code the phone completes with its own key", async () => {
    expect(manager.pairingAvailable).toBe(true);
    const start = await manager.startPairing({ kind: "phone" });
    expect(start.kind).toBe("phone");
    expect(start.humanId).toBe(h.seed.ada.id);
    expect(start.serviceUrl).toBe(SERVICE);
    expect(Date.parse(start.expiresAt) - Date.parse(START)).toBe(10 * 60_000);
    const link = new URL(start.link);
    expect(link.protocol).toBe("fr:");
    expect(link.host).toBe("pair");
    expect(link.searchParams.get("u")).toBe(SERVICE);
    expect(link.searchParams.get("c")).toBe(start.code);
    expect(link.searchParams.get("h")).toBe(h.seed.ada.id);
    expect(calls.map((c) => [c.url, c.auth])).toEqual([
      [`${SERVICE}/pairing/start`, `Bearer ${ADMIN_TOKEN}`],
    ]);

    // The phone: a fresh key pair, the code from the QR, the public pairing route.
    const keys = generateDeviceKeyPair();
    const code = link.searchParams.get("c") ?? "";
    const done = await new Client(h.app, undefined).post("/pairing/complete", {
      code,
      publicKey: keys.publicKey,
      proof: signPairingProof(keys.secretKey, code),
      name: "Ada's phone",
      platform: "android",
    });
    expect(done.status).toBe(201);
    const paired = await json<{ deviceId: string; token: string }>(done);

    const list = await manager.list();
    const phone = list.find((d) => d.id === paired.deviceId);
    expect(phone).toMatchObject({ name: "Ada's phone", kind: "phone", revoked: false });
    expect(phone?.current).toBe(false);
    expect(list.find((d) => d.id === h.seed.desktop.id)?.current).toBe(true);
    // Only the signed-in human's devices: Bob's phone never shows on Ada's desktop.
    const bobs = await h.pairDevice(h.seed.bob.id);
    expect((await manager.list()).some((d) => d.id === bobs.deviceId)).toBe(false);

    // The code is a one-time secret: the audit row names the kind and expiry, never the code.
    const audit = await local.auditLog.list({ tool: DEVICE_AUDIT.pairingStarted });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(start.code);
    expect(JSON.stringify(audit)).not.toContain(ADMIN_TOKEN);
  });

  it("revokes at once: the device's next request is refused and the list shows it revoked", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    expect((await phone.get("/me")).status).toBe(200);

    const result = await manager.revoke(phone.deviceId);
    expect(result.device).toMatchObject({ id: phone.deviceId, revoked: true, current: false });
    expect(result.tokensRevoked).toBe(1);
    expect((await phone.get("/me")).status).toBe(401);
    expect((await manager.list()).find((d) => d.id === phone.deviceId)?.revoked).toBe(true);
    const audit = await local.auditLog.list({ tool: DEVICE_AUDIT.revoked });
    expect(audit[0]?.result_summary).toContain("1 session token(s) dropped");
  });

  it("refuses this install's own device, another human's device and an unknown id", async () => {
    await expect(manager.revoke(h.seed.desktop.id)).rejects.toMatchObject({ code: "validation" });
    const bobs = await h.pairDevice(h.seed.bob.id);
    await expect(manager.revoke(bobs.deviceId)).rejects.toMatchObject({ code: "not_found" });
    expect((await bobs.get("/me")).status).toBe(200);
    await expect(manager.revoke("dev_missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("is unavailable without the admin token and with a wrong one, and never sends a token it lacks", async () => {
    await expect(managerWith(null).startPairing()).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toEqual([]);
    const wrong = managerWith("not-the-admin-token"); // not-a-secret
    await expect(wrong.startPairing()).rejects.toMatchObject({
      code: "unavailable",
      details: { status: 401 },
    });
  });
});
