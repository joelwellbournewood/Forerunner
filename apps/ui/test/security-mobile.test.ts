import { describe, expect, it, vi } from "vitest";

/**
 * Security review of the Android client (spec R.2, R.3, R.7; ADR 0009, ADR 0032): the
 * device key never leaves the keystore wrapper (the UI sees the public key and signatures
 * only), the outbox never applies an action twice, and an auth loss drops the token and
 * key while keeping the queued work. The Tauri bridge is mocked with a fake shell that
 * behaves as `apps/mobile/src-tauri` does; the state service is the UI's fake.
 */
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import {
  fromBase64,
  needsBiometricTicket,
  noBiometric,
  WebCryptoSigner,
} from "../src/api/state-signing.ts";
import { LocalOutbox } from "../src/mobile/outbox.ts";
import { ShellSigner, shellSecureStore } from "../src/mobile/shell-bridge.ts";
import { MobileController } from "../src/mobile/store.tsx";
import { FAKE_REQUESTS, HUMAN_J } from "./fake-state-service.ts";
import { createMobileHarness, SERVICE_URL, until } from "./mobile-helpers.tsx";

interface ShellCall {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

/**
 * A shell whose key is a non-extractable WebCrypto key: the closest a test can get to the
 * Keystore-wrapped seed. It signs `biometric=0` strings freely and refuses a `biometric=1`
 * string without the ticket of a prompt, exactly as `commands.rs` does.
 */
async function fakeShell(): Promise<{
  calls: ShellCall[];
  inner: WebCryptoSigner;
  secure: Map<string, string>;
}> {
  const inner = await WebCryptoSigner.generate();
  const secure = new Map<string, string>();
  const calls: ShellCall[] = [];
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "device_key_public":
        return { publicKey: await inner.publicKey() };
      case "device_key_sign": {
        const message = fromBase64(String(args?.message));
        if (needsBiometricTicket(message)) {
          throw "biometric ticket missing: a biometric=1 signature needs a successful prompt first";
        }
        return { signature: await inner.sign(message) };
      }
      case "device_key_forget":
        await inner.forget();
        return null;
      case "secure_store_get":
        return { value: secure.get(String(args?.key)) ?? null };
      case "secure_store_set":
        secure.set(String(args?.key), String(args?.value));
        return null;
      case "secure_store_delete":
        secure.delete(String(args?.key));
        return null;
      default:
        throw new Error(`unexpected shell command ${cmd}`);
    }
  });
  return { calls, inner, secure };
}

describe("security: the device key never leaves the shell", () => {
  it("pairing and signing cross the bridge with the public key, messages and signatures only", async () => {
    const shell = await fakeShell();
    const h = await createMobileHarness({
      paired: false,
      env: { signer: new ShellSigner(), secure: shellSecureStore, biometric: noBiometric },
    });
    const ctrl = h.controller;
    const code = h.service.startPairing(HUMAN_J.id, "phone").code;
    await ctrl.pair({ serviceUrl: SERVICE_URL, code, deviceName: "Shell phone" });
    expect(ctrl.state.stage).toBe("paired");
    const publicKey = await shell.inner.publicKey();
    expect(h.service.state.devices[0]?.publicKey).toBe(publicKey);
    const token = shell.secure.get("session-token") as string;
    expect(token.length).toBeGreaterThan(20);

    // A low-risk answer: signed in the shell.
    const request = FAKE_REQUESTS.find((r) => r.id === "req_name");
    if (!request) throw new Error("fixture missing");
    expect(await ctrl.answerRequest(request, "Nexus")).toEqual({ queued: false });
    expect(h.service.state.requests.find((r) => r.id === "req_name")?.status).toBe("answered");

    // What crossed the bridge: per command, only the fields the contract names.
    const byCmd = new Map<string, Set<string>>();
    for (const c of shell.calls) {
      const keys = byCmd.get(c.cmd) ?? new Set<string>();
      for (const k of Object.keys(c.args ?? {})) keys.add(k);
      byCmd.set(c.cmd, keys);
    }
    expect([...(byCmd.get("device_key_sign") ?? [])].sort()).toEqual(["message", "ticket"]);
    expect([...(byCmd.get("device_key_public") ?? [])]).toEqual([]);
    expect([...(byCmd.get("secure_store_set") ?? [])].sort()).toEqual(["key", "value"]);
    const bridgeText = JSON.stringify(shell.calls);
    for (const word of ["secretKey", "seed", "privateKey", '"d":', "pkcs8"]) {
      expect(bridgeText.includes(word), word).toBe(false);
    }
    // The key is not exportable even to this test; the only secret stored is the token.
    await expect(shell.inner.exportSeed()).rejects.toBeDefined();
    expect([...shell.secure.keys()]).toEqual(["session-token"]);
    // Browser storage holds the session record without the token, and nothing key-shaped.
    const session = h.env.storage.get("forerunner.mobile.test.session") as string;
    expect(session).toBeTruthy();
    expect(session.includes(token)).toBe(false);
    expect(session.includes(publicKey)).toBe(false);
    // The service never saw more than the public key, and the token only as the bearer.
    for (const call of h.service.state.calls) {
      const body = JSON.stringify(call.body ?? null);
      expect(body.includes(token), call.path).toBe(false);
      expect(body.includes('"d":'), call.path).toBe(false);
    }
    expect(h.service.state.log.some((line) => line.includes(token))).toBe(false);
    ctrl.close();
  });

  it("a high-risk answer without a passed prompt never reaches the key nor the service", async () => {
    const shell = await fakeShell();
    const h = await createMobileHarness({
      paired: false,
      env: { signer: new ShellSigner(), secure: shellSecureStore, biometric: noBiometric },
    });
    const ctrl = h.controller;
    const code = h.service.startPairing(HUMAN_J.id, "phone").code;
    await ctrl.pair({ serviceUrl: SERVICE_URL, code, deviceName: "Shell phone" });
    const high = FAKE_REQUESTS.find((r) => r.id === "req_cap");
    if (!high) throw new Error("fixture missing");
    const before = shell.calls.length;
    await expect(ctrl.answerRequest(high, "Confirm")).rejects.toMatchObject({
      code: "biometric_required",
    });
    expect(shell.calls.slice(before).filter((c) => c.cmd === "device_key_sign")).toHaveLength(0);
    expect(h.service.state.calls.some((c) => c.path === "/requests/req_cap/answer")).toBe(false);
    expect(h.service.state.requests.find((r) => r.id === "req_cap")?.status).toBe("open");
    // Never queued either: the flag must be inside the signature of the request that carries it.
    expect(ctrl.outbox.size()).toBe(0);
    // A screen that fabricates the assertion gets refused before the IPC, with no sign call.
    const signer = new ShellSigner();
    const { canonicalRequest, utf8 } = await import("../src/api/state-signing.ts");
    const message = utf8(
      await canonicalRequest({
        method: "POST",
        path: "/requests/req_cap/answer",
        body: "{}",
        timestamp: "1",
        biometric: true,
      }),
    );
    const forged = { asserted: true, at: "now", method: "screen" } as never;
    await expect(signer.sign(message, { biometric: forged })).rejects.toMatchObject({
      code: "biometric_ticket",
    });
    expect(shell.calls.slice(before).filter((c) => c.cmd === "device_key_sign")).toHaveLength(0);
    ctrl.close();
  });
});

describe("security: the outbox never duplicates", () => {
  it("the same client id is one item, and two flushes racing over one queue apply it once", async () => {
    const h = await createMobileHarness();
    await h.controller.bootstrap();
    const outbox = new LocalOutbox(h.env.storage, "race");
    const action = {
      clientId: "note-race-0001",
      kind: "queue.enqueue" as const,
      payload: { projectId: "proj_game", kind: "note", text: "once" },
      createdAt: "2026-10-20T10:00:00.000Z",
      label: "note",
    };
    outbox.enqueue(action);
    outbox.enqueue({ ...action, payload: { ...action.payload, text: "twice" } });
    expect(outbox.size()).toBe(1);
    // A second instance over the same storage (an app restart mid-flush) sees the same item.
    const reopened = new LocalOutbox(h.env.storage, "race");
    const [a, b] = await Promise.all([
      outbox.flush(h.controller.api),
      reopened.flush(h.controller.api),
    ]);
    expect(a.sent + b.sent).toBeGreaterThanOrEqual(1);
    expect(a.rejected).toEqual([]);
    expect(b.rejected).toEqual([]);
    expect(h.service.state.queue.filter((q) => q.text === "once")).toHaveLength(1);
    expect(h.service.state.queue.filter((q) => q.text === "twice")).toHaveLength(0);
    expect(outbox.size()).toBe(0);
    expect(new LocalOutbox(h.env.storage, "race").size()).toBe(0);
    h.controller.close();
  });

  it("a response lost after the service applied the batch leads to a duplicate, never a second row", async () => {
    const h = await createMobileHarness();
    await h.controller.bootstrap();
    const outbox = new LocalOutbox(h.env.storage, "lost");
    outbox.enqueue({
      clientId: "note-lost-0001",
      kind: "queue.enqueue",
      payload: { projectId: "proj_game", kind: "note", text: "lost answer" },
      createdAt: "2026-10-20T10:00:00.000Z",
      label: "note",
    });
    const realFetch = h.env.fetch as NonNullable<typeof h.env.fetch>;
    let drop = true;
    h.env.fetch = async (input, init) => {
      const res = await realFetch(input, init);
      if (drop && String(input).endsWith("/sync/outbox")) {
        drop = false;
        throw new Error("connection reset after the request was received");
      }
      return res;
    };
    const ctrl = new MobileController(h.env);
    await ctrl.bootstrap();
    const first = await outbox.flush(ctrl.api);
    expect(first.sent).toBe(0);
    expect(first.deferred).toBe(1);
    expect(h.service.state.queue.filter((q) => q.text === "lost answer")).toHaveLength(1);
    const second = await outbox.flush(ctrl.api);
    expect(second.sent).toBe(1);
    expect(h.service.state.queue.filter((q) => q.text === "lost answer")).toHaveLength(1);
    expect(outbox.size()).toBe(0);
    ctrl.close();
    h.controller.close();
  });
});

describe("security: auth loss", () => {
  it("after a revocation nothing is sent under the old token, the token is gone everywhere, and the queue waits", async () => {
    const h = await createMobileHarness();
    let online = true;
    const realFetch = h.env.fetch as NonNullable<typeof h.env.fetch>;
    h.env.fetch = (input, init) =>
      online ? realFetch(input, init) : Promise.reject(new Error("offline"));
    const ctrl = new MobileController(h.env);
    await ctrl.bootstrap();
    await until(() => ctrl.state.projectsLoaded, 3000, "projects");
    const oldToken = (await h.env.secure.get("session-token")) as string;
    expect(oldToken).toBeTruthy();
    online = false;
    expect(await ctrl.addNote("proj_game", "queued before the revoke")).toEqual({ queued: true });
    expect(ctrl.outbox.size()).toBe(1);

    const device = h.service.state.devices[0];
    if (!device) throw new Error("not paired");
    await h.service.app.request(`http://state.test/devices/${device.id}/revoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${h.service.adminToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const mark = h.service.state.calls.length;
    online = true;
    await ctrl.refresh();
    await until(() => ctrl.state.stage === "unpaired", 3000, "unpaired");

    // Nothing after the 401 used the old token for a mutation, and the outbox was not flushed.
    const after = h.service.state.calls.slice(mark);
    expect(after.some((c) => c.path === "/sync/outbox")).toBe(false);
    expect(after.every((c) => c.method === "GET" || c.principal === "none")).toBe(true);
    expect(ctrl.outbox.size()).toBe(1);
    expect(ctrl.state.outboxPending).toBe(1);
    // The token is gone from the secure store, the client and the session record.
    expect(await h.env.secure.get("session-token")).toBeNull();
    expect(ctrl.api.config.token).toBeNull();
    expect(h.env.storage.get("forerunner.mobile.test.session")).toBeNull();
    const outboxRaw = h.env.storage.get("forerunner.mobile.test.outbox") as string;
    expect(outboxRaw.includes(oldToken)).toBe(false);
    // An explicit flush while unpaired sends nothing.
    await ctrl.flushOutbox();
    expect(h.service.state.calls.slice(mark).some((c) => c.path === "/sync/outbox")).toBe(false);
    expect(h.service.state.queue).toHaveLength(0);
    // The old token is dead on the service as well: a hand-made request with it is refused.
    const res = await h.service.app.request("http://state.test/me", {
      headers: { Authorization: `Bearer ${oldToken}` },
    });
    expect(res.status).toBe(401);
    ctrl.close();
    h.controller.close();
  });
});
