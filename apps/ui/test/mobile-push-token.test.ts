import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyValueStore } from "../src/lib/storage.ts";
import { memoryStorage } from "../src/lib/storage.ts";
import {
  PollingPush,
  type PushPort,
  type PushStatus,
  parsePushLink,
  pushTokenFingerprint,
  safeAppPath,
} from "../src/mobile/push.ts";
import { MobileController } from "../src/mobile/store.tsx";
import { HUMAN_J } from "./fake-state-service.ts";
import { createMobileHarness, renderMobile, SERVICE_URL } from "./mobile-helpers.tsx";

// ADR 0085 points 6 and 9: the phone sends its FCM registration token at pairing and after a
// refresh, signed like every device mutation, and never logs, shows or stores the token.

/** Built by concatenation so the secret scan never sees a credential shape. */
const TOKEN_A = ["fcm", "registration", "token", "a", "0001"].join("-"); // not-a-secret
const TOKEN_B = ["fcm", "registration", "token", "b", "0002"].join("-"); // not-a-secret

/** The shell's push port with a token the test can rotate (what `push_status` returns with FCM). */
function fcmPush(initial: string | null): PushPort & { token: string | null } {
  const port = {
    token: initial,
    async status(): Promise<PushStatus> {
      return port.token
        ? { mode: "fcm", detail: "Firebase Cloud Messaging", token: port.token }
        : { mode: "polling", detail: "FCM not configured", token: null };
    },
    notify: () => false,
  };
  return port;
}

/** A storage that remembers every value ever written, to prove the token never lands there. */
function recordingStorage(): KeyValueStore & { written: string[] } {
  const inner = memoryStorage();
  const written: string[] = [];
  return {
    written,
    get: (k) => inner.get(k),
    set: (k, v) => {
      written.push(`${k}=${v}`);
      inner.set(k, v);
    },
    remove: (k) => inner.remove(k),
  };
}

async function pairWith(push: PushPort, storage = recordingStorage()) {
  const h = await createMobileHarness({ paired: false, env: { push, storage } });
  const code = h.service.startPairing(HUMAN_J.id, "phone").code;
  await h.controller.pair({ serviceUrl: SERVICE_URL, code, deviceName: "Test phone" });
  const deviceId = h.controller.state.session?.deviceId ?? "";
  return { ...h, storage, deviceId };
}

const pushTokenCalls = (h: Awaited<ReturnType<typeof pairWith>>) =>
  h.service.state.calls.filter((c) => /^\/devices\/[^/]+\/push-token$/.test(c.path));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("push token at pairing", () => {
  it("sends the shell's FCM token as pushToken on POST /pairing/complete", async () => {
    const h = await pairWith(fcmPush(TOKEN_A));
    const pairing = h.service.state.calls.find((c) => c.path === "/pairing/complete");
    expect((pairing?.body as { pushToken?: string } | undefined)?.pushToken).toBe(TOKEN_A);
    expect(h.service.state.pushTokens.get(h.deviceId)).toBe(TOKEN_A);
    // pairing registered it; the bootstrap-style sync finds nothing to send
    expect(await h.controller.syncPushToken()).toBe("unchanged");
    expect(pushTokenCalls(h)).toHaveLength(0);
    h.controller.close();
  });

  it("leaves pushToken out when the shell has none (polling stand-in) and never PUTs", async () => {
    const h = await pairWith(new PollingPush());
    const pairing = h.service.state.calls.find((c) => c.path === "/pairing/complete");
    expect(pairing?.body).not.toHaveProperty("pushToken");
    expect(h.service.state.pushTokens.size).toBe(0);
    expect(await h.controller.syncPushToken()).toBe("unchanged");
    const restarted = new MobileController(h.env);
    await restarted.bootstrap();
    expect(pushTokenCalls(h)).toHaveLength(0);
    expect(restarted.state.push?.mode).toBe("polling");
    restarted.close();
    h.controller.close();
  });
});

describe("push token refresh", () => {
  it("sends a refreshed token with PUT /devices/:id/push-token, signed by the device", async () => {
    const push = fcmPush(TOKEN_A);
    const h = await pairWith(push);
    push.token = TOKEN_B;
    expect(await h.controller.syncPushToken()).toBe("sent");
    const calls = pushTokenCalls(h);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: `/devices/${h.deviceId}/push-token`,
      body: { pushToken: TOKEN_B },
      signed: true,
      principal: "device",
      deviceId: h.deviceId,
    });
    expect(h.service.state.pushTokens.get(h.deviceId)).toBe(TOKEN_B);
    // the same token again is not re-sent
    expect(await h.controller.syncPushToken()).toBe("unchanged");
    expect(pushTokenCalls(h)).toHaveLength(1);
    h.controller.close();
  });

  it("sends a token that rotated while the app was closed at the next launch", async () => {
    const push = fcmPush(TOKEN_A);
    const h = await pairWith(push);
    h.controller.close();
    push.token = TOKEN_B;
    const restarted = new MobileController(h.env);
    await restarted.bootstrap();
    expect(restarted.state.stage).toBe("paired");
    expect(pushTokenCalls(h)).toHaveLength(1);
    expect(h.service.state.pushTokens.get(h.deviceId)).toBe(TOKEN_B);
    restarted.close();
  });

  it("clears the registration with null when the token disappears", async () => {
    const push = fcmPush(TOKEN_A);
    const h = await pairWith(push);
    push.token = null;
    expect(await h.controller.syncPushToken()).toBe("sent");
    expect(pushTokenCalls(h)[0]?.body).toEqual({ pushToken: null });
    expect(h.service.state.pushTokens.has(h.deviceId)).toBe(false);
    h.controller.close();
  });

  it("re-checks the token when the app comes back to the foreground", async () => {
    const push = fcmPush(TOKEN_A);
    const h = await pairWith(push);
    h.controller.close();
    const c = new MobileController(h.env);
    await c.bootstrap();
    push.token = TOKEN_B;
    document.dispatchEvent(new Event("visibilitychange"));
    const deadline = Date.now() + 3000;
    while (pushTokenCalls(h).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(pushTokenCalls(h)).toHaveLength(1);
    expect(h.service.state.pushTokens.get(h.deviceId)).toBe(TOKEN_B);
    c.close();
    // after close the listener is gone
    push.token = TOKEN_A;
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 50));
    expect(pushTokenCalls(h)).toHaveLength(1);
  });

  it("does not send while unpaired", async () => {
    const h = await createMobileHarness({ paired: false, env: { push: fcmPush(TOKEN_A) } });
    await h.controller.bootstrap();
    expect(await h.controller.syncPushToken()).toBe("skipped");
    expect(h.service.state.calls).toHaveLength(0);
    h.controller.close();
  });

  it("a failed PUT is quiet and retried on the next sync", async () => {
    const push = fcmPush(TOKEN_A);
    const h = await pairWith(push);
    push.token = TOKEN_B;
    const realFetch = h.env.fetch;
    let fail = true;
    h.env.fetch = (input, init) =>
      fail && String(input).includes("/push-token")
        ? Promise.reject(new Error("offline"))
        : (realFetch as NonNullable<typeof realFetch>)(input, init);
    // the controller's client captured the original fetch; restart so it uses the failing one
    h.controller.close();
    const c = new MobileController(h.env);
    await c.bootstrap();
    expect(h.service.state.pushTokens.get(h.deviceId)).toBe(TOKEN_A);
    expect(c.state.notice ?? "").not.toContain(TOKEN_B);
    fail = false;
    expect(await c.syncPushToken()).toBe("sent");
    expect(h.service.state.pushTokens.get(h.deviceId)).toBe(TOKEN_B);
    c.close();
  });
});

describe("the push token is never logged, shown or stored by the UI", () => {
  it("keeps it out of the console, the service log, the state and the phone's storage", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    const push = fcmPush(TOKEN_A);
    const h = await pairWith(push);
    push.token = TOKEN_B;
    await h.controller.syncPushToken();
    h.controller.close();
    const restarted = new MobileController(h.env);
    await restarted.bootstrap();

    for (const token of [TOKEN_A, TOKEN_B]) {
      expect(lines.join("\n")).not.toContain(token);
      expect(h.service.state.log.join("\n")).not.toContain(token);
      expect(h.storage.written.join("\n")).not.toContain(token);
      expect(JSON.stringify(restarted.state)).not.toContain(token);
      expect(JSON.stringify(h.controller.state)).not.toContain(token);
    }
    // what is stored is the fingerprint, bound to the device
    const fingerprint = await pushTokenFingerprint(TOKEN_B);
    expect(h.storage.written.join("\n")).toContain(fingerprint);
    expect(restarted.state.push).toMatchObject({ mode: "fcm", token: null });
    // the device views the service returns say pushRegistered, never the token
    const device = await restarted.api.device(h.deviceId);
    expect(JSON.stringify(device)).not.toContain(TOKEN_B);
    restarted.close();
  });
});

describe("notification links", () => {
  it("accepts fr://open with a plain in-app path", () => {
    expect(parsePushLink("fr://open?link=%2Finbox")).toBe("/inbox");
    expect(parsePushLink("fr://open?link=/sessions/ses_1")).toBe("/sessions/ses_1");
    expect(parsePushLink("FR://open/?link=%2Fsessions%2Fses_2")).toBe("/sessions/ses_2");
  });

  it("refuses anything that is not a plain app path", () => {
    for (const link of [
      "https://evil.example/",
      "//evil.example/x",
      "/../etc",
      "/a/./b",
      "javascript:alert(1)",
      "/inbox?x=1",
      "/inbox#x",
      "inbox",
      "",
      `/${"a".repeat(300)}`,
    ]) {
      expect(safeAppPath(link)).toBeNull();
      expect(parsePushLink(`fr://open?link=${encodeURIComponent(link)}`)).toBeNull();
    }
    expect(parsePushLink("fr://pair?c=ABCD1234")).toBeNull();
    expect(parsePushLink("https://example.com/open?link=%2Finbox")).toBeNull();
  });

  it("holds the route from a deep link until the shell takes it; pairing links still pre-fill", async () => {
    const h = await createMobileHarness();
    await h.controller.bootstrap();
    h.controller.offerDeepLink("fr://open?link=%2Fsessions%2Fses_1");
    expect(h.controller.state.pendingLink).toBe("/sessions/ses_1");
    expect(h.controller.takePendingLink()).toBe("/sessions/ses_1");
    expect(h.controller.takePendingLink()).toBeNull();
    h.controller.offerDeepLink("fr://open?link=https%3A%2F%2Fevil.example");
    expect(h.controller.state.pendingLink).toBeNull();
    h.controller.offerDeepLink(`fr://pair?u=${encodeURIComponent(SERVICE_URL)}&c=ABCD2345`);
    expect(h.controller.state.pendingPairing?.code).toBe("ABCD2345");
    expect(h.controller.state.pendingLink).toBeNull();
    h.controller.close();
  });

  it("opens the notification's link when the app is launched from it", async () => {
    const h = await createMobileHarness({
      env: {
        deepLink: {
          current: async () => "fr://open?link=%2Finbox",
          listen: () => () => {},
        },
      },
    });
    renderMobile("/", h);
    await screen.findByRole("heading", { name: "Approvals and requests" });
    expect(h.controller.state.pendingLink).toBeNull();
    h.controller.close();
  });
});
