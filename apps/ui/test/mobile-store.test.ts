import { describe, expect, it } from "vitest";
import {
  type DeviceSigner,
  type SignOptions,
  TicketBook,
  WebCryptoSigner,
} from "../src/api/state-signing.ts";
import { memoryStorage } from "../src/lib/storage.ts";
import { ChangeLog } from "../src/mobile/change-log.ts";
import { LocalOutbox } from "../src/mobile/outbox.ts";
import { inQuietHours, noticeFor, PollingPush } from "../src/mobile/push.ts";
import { MobileController } from "../src/mobile/store.tsx";
import { HUMAN_J } from "./fake-state-service.ts";
import { createMobileHarness, NOW_MS, SERVICE_URL, until } from "./mobile-helpers.tsx";

/** Like the page's web signer: a new key after `forget`, one ticket book throughout. */
function regeneratingSigner(): DeviceSigner {
  const tickets = new TicketBook();
  let current: Promise<WebCryptoSigner> | null = null;
  const get = () => {
    current ??= WebCryptoSigner.generate({ tickets });
    return current;
  };
  return {
    kind: "webcrypto",
    tickets,
    publicKey: () => get().then((s) => s.publicKey()),
    sign: (m: Uint8Array, o?: SignOptions) => get().then((s) => s.sign(m, o)),
    forget: async () => {
      await (await get()).forget();
      current = null;
    },
  };
}

describe("LocalOutbox", () => {
  it("persists queued actions, flushes them in order and drops rejected ones", async () => {
    const h = await createMobileHarness();
    await h.controller.bootstrap();
    const storage = h.env.storage;
    const outbox = new LocalOutbox(storage, "k");
    outbox.enqueue({
      clientId: "c1",
      kind: "message.receipt",
      payload: { id: "msg_handoff", state: "read" },
      createdAt: "2026-10-20T10:00:01.000Z",
      label: "receipt",
    });
    outbox.enqueue({
      clientId: "c0",
      kind: "request.answer",
      payload: { id: "req_name", version: 1, answer: "Nexus" },
      createdAt: "2026-10-20T10:00:00.000Z",
      label: "answer",
    });
    outbox.enqueue({
      clientId: "c2",
      kind: "request.answer",
      payload: { id: "missing", version: 1, answer: "x" },
      createdAt: "2026-10-20T10:00:02.000Z",
      label: "bad answer",
    });
    // A second instance over the same storage sees the queue (restart survival).
    const reopened = new LocalOutbox(storage, "k");
    expect(reopened.pending().map((i) => i.clientId)).toEqual(["c0", "c1", "c2"]);
    const report = await reopened.flush(h.controller.api);
    expect(report.sent).toBe(2);
    expect(report.rejected).toEqual([
      { clientId: "c2", label: "bad answer", code: "not_found", message: "request not found" },
    ]);
    expect(reopened.size()).toBe(0);
    expect(h.service.state.requests.find((r) => r.id === "req_name")?.status).toBe("answered");
    h.controller.close();
  });

  it("keeps the queue on a transport failure and never applies twice", async () => {
    const h = await createMobileHarness();
    await h.controller.bootstrap();
    const outbox = new LocalOutbox(h.env.storage, "k");
    outbox.enqueue({
      clientId: "dup",
      kind: "message.receipt",
      payload: { id: "msg_handoff", state: "read" },
      createdAt: "2026-10-20T10:00:00.000Z",
      label: "receipt",
    });
    const broken = h.controller.api.withToken(h.controller.api.config.token);
    const failing = { ...broken, syncOutbox: async () => Promise.reject(new Error("down")) };
    const first = await outbox.flush(failing as typeof broken);
    expect(first).toMatchObject({ sent: 0, deferred: 1 });
    expect(outbox.pending()[0]?.attempts).toBe(1);
    const ok = await outbox.flush(h.controller.api);
    expect(ok.sent).toBe(1);
    outbox.enqueue({
      clientId: "dup",
      kind: "message.receipt",
      payload: { id: "msg_handoff", state: "read" },
      createdAt: "2026-10-20T10:00:00.000Z",
      label: "receipt",
    });
    const again = await outbox.flush(h.controller.api);
    expect(again.sent).toBe(1);
    // The failing flush never reached the service; the two real flushes did, and the second
    // one was answered as a duplicate.
    expect(h.service.state.calls.filter((c) => c.path === "/sync/outbox")).toHaveLength(2);
    h.controller.close();
  });
});

describe("ChangeLog", () => {
  const card = {
    command: "project.switch",
    what: "the active project",
    oldValue: "A",
    newValue: "B",
    scope: "global" as const,
    scopeLabel: "everything",
    duration: "until reverted",
    impact: { risk: "low" as const },
    undoHint: "Tap Undo in the change log.",
    sentence: "Switched. Undo.",
    projectId: "b",
    projectName: "B",
    usesActiveProject: false,
    expiresAt: null,
    reversible: true,
  };

  it("persists entries, maps remote statuses and keeps undone / failed final", () => {
    const storage = memoryStorage();
    const log = new ChangeLog(storage, "changes");
    log.add({
      id: "e1",
      at: "2026-10-20T10:00:00.000Z",
      wordsUsed: "switch to b",
      source: "chat",
      plan: [{ name: "project.switch", params: { project: "b" } }],
      card,
      remoteCommandId: "cmd_1",
      status: "sent",
      result: null,
      undoPlan: [{ name: "project.switch", params: { back: true } }],
      undoneBy: null,
      undoOf: null,
    });
    expect(new ChangeLog(storage, "changes").all()).toHaveLength(1);
    expect(log.applyRemoteStatus("cmd_1", "picked_up", null)?.status).toBe("picked_up");
    expect(log.applyRemoteStatus("cmd_1", "done", { ok: true })?.status).toBe("done");
    expect(log.canUndo(log.get("e1") as never)).toBe(true);
    log.update("e1", { status: "undone", undoneBy: "e2" });
    expect(log.applyRemoteStatus("cmd_1", "failed", null)?.status).toBe("undone");
    expect(log.canUndo(log.get("e1") as never)).toBe(false);
    expect(log.applyRemoteStatus("unknown", "done", null)).toBeUndefined();
    storage.set("changes", "not json");
    expect(new ChangeLog(storage, "changes").all()).toEqual([]);
  });
});

describe("push stand-in", () => {
  it("applies quiet hours, also over midnight, and maps feed events to notices", async () => {
    expect(inQuietHours({ from: "22:00", to: "07:00" }, 23 * 60)).toBe(true);
    expect(inQuietHours({ from: "22:00", to: "07:00" }, 6 * 60)).toBe(true);
    expect(inQuietHours({ from: "22:00", to: "07:00" }, 12 * 60)).toBe(false);
    expect(inQuietHours({ from: "09:00", to: "17:00" }, 12 * 60)).toBe(true);
    expect(inQuietHours({ from: null, to: null }, 12 * 60)).toBe(false);
    expect(inQuietHours({ from: "bad", to: "07:00" }, 12 * 60)).toBe(false);
    const push = new PollingPush();
    expect((await push.status()).mode).toBe("polling");
    const notice = noticeFor("human_request.changed", { status: "open", blocking: true }, "t");
    expect(notice?.category).toBe("approval");
    expect(push.notify(notice as never, { from: "22:00", to: "07:00" }, 23 * 60)).toBe(false);
    expect(push.notify(notice as never, { from: "22:00", to: "07:00" }, 12 * 60)).toBe(true);
    expect(push.shown).toHaveLength(1);
    expect(push.suppressed).toHaveLength(1);
    expect(noticeFor("session.changed", { status: "completed", id: "s" }, "t")?.category).toBe(
      "session",
    );
    expect(noticeFor("message.changed", { receipt: "read" }, "t")).toBeNull();
    expect(noticeFor("task.changed", {}, "t")).toBeNull();
  });
});

describe("controller", () => {
  it("boots from the stored session and never puts the token or key in state, storage or logs", async () => {
    const h = await createMobileHarness();
    await h.controller.bootstrap();
    await until(() => h.controller.state.projectsLoaded, 3000, "projects");
    const token = (await h.env.secure.get("session-token")) as string;
    const snapshot = JSON.stringify(h.controller.state);
    expect(snapshot).not.toContain(token);
    const stored = ["session", "activeProject", "changes", "outbox"]
      .map((k) => h.env.storage.get(`forerunner.mobile.test.${k}`) ?? "")
      .join("\n");
    expect(stored).not.toContain(token);
    expect(JSON.stringify(h.service.state.log)).not.toContain(token);
    expect(h.service.state.log.length).toBeGreaterThan(0);
    expect(h.controller.state.session?.humanId).toBe(HUMAN_J.id);
    expect(h.controller.state.stage).toBe("paired");
    h.controller.close();
  });

  it("sends a note to the next-session queue, queuing it offline", async () => {
    const h = await createMobileHarness();
    await h.controller.bootstrap();
    const first = await h.controller.addNote("proj_game", "ship the docs", "idea");
    expect(first).toEqual({ queued: false });
    expect(h.service.state.queue[0]).toMatchObject({
      projectId: "proj_game",
      kind: "idea",
      text: "ship the docs",
    });
    const realFetch = h.env.fetch as NonNullable<typeof h.env.fetch>;
    let online = false;
    h.env.fetch = (input, init) =>
      online ? realFetch(input, init) : Promise.reject(new Error("offline"));
    // The controller keeps the fetch it was built with; rebuild one over the switchable fetch.
    const { MobileController } = await import("../src/mobile/store.tsx");
    const offline = new MobileController(h.env);
    await offline.bootstrap();
    const second = await offline.addNote("proj_game", "later", "note");
    expect(second).toEqual({ queued: true });
    expect(offline.state.outboxPending).toBe(1);
    online = true;
    await offline.flushOutbox();
    expect(offline.state.outboxPending).toBe(0);
    expect(h.service.state.queue.map((q) => q.text)).toEqual(["ship the docs", "later"]);
    expect(h.now()).toBe(NOW_MS);
    offline.close();
    h.controller.close();
  });

  it("keeps queued actions and the change log on auth loss and sends them after pairing again", async () => {
    const h = await createMobileHarness({ env: { signer: regeneratingSigner() } });
    let online = true;
    const realFetch = h.env.fetch as NonNullable<typeof h.env.fetch>;
    h.env.fetch = (input, init) =>
      online ? realFetch(input, init) : Promise.reject(new Error("offline"));
    const ctrl = new MobileController(h.env);
    await ctrl.bootstrap();
    await until(() => ctrl.state.projectsLoaded, 3000, "projects");
    online = false;
    expect(await ctrl.addNote("proj_game", "queued while offline")).toEqual({ queued: true });
    const sent = await ctrl.sendPlan({
      words: "switch to the game",
      plan: [{ name: "project.switch", params: { project: "proj_game" } }],
      source: "chat",
    });
    expect(sent.queued).toBe(true);
    expect(ctrl.state.outboxPending).toBe(2);
    expect(ctrl.changeLog.all()).toHaveLength(1);

    // The desktop revokes the device (or the 30-day token expires) before the phone reconnects.
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
    online = true;
    await ctrl.refresh();
    await until(() => ctrl.state.stage === "unpaired", 3000, "unpaired");
    await until(() => /kept/.test(ctrl.state.notice ?? ""), 3000, "notice");
    expect(ctrl.state.notice).toMatch(
      /revoked or its token expired.*2 queued actions are kept and will be sent after pairing/,
    );
    expect(ctrl.state.outboxPending).toBe(2);
    expect(ctrl.outbox.size()).toBe(2);
    expect(ctrl.changeLog.all()).toHaveLength(1);
    expect(await h.env.secure.get("session-token")).toBeNull();
    expect(h.env.storage.get("forerunner.mobile.test.session")).toBeNull();
    expect(h.service.state.queue).toHaveLength(0);

    // Pair again (a new key: the service refuses a reused one): the queue goes out at once.
    const code = h.service.startPairing(HUMAN_J.id, "phone").code;
    await ctrl.pair({ serviceUrl: SERVICE_URL, code, deviceName: "Test phone again" });
    expect(ctrl.state.stage).toBe("paired");
    expect(h.service.state.devices).toHaveLength(2);
    expect(h.service.state.devices[1]?.publicKey).not.toBe(device.publicKey);
    await until(() => ctrl.state.outboxPending === 0, 3000, "flush");
    expect(h.service.state.queue.map((q) => q.text)).toEqual(["queued while offline"]);
    expect(h.service.state.remoteCommands).toHaveLength(1);
    expect(h.service.state.remoteCommands[0]?.deviceId).toBe(h.service.state.devices[1]?.id);
    await until(
      () =>
        ctrl.changeLog.get(sent.entry.id)?.remoteCommandId ===
        h.service.state.remoteCommands[0]?.id,
      3000,
      "change log linked",
    );
    expect(ctrl.state.notice).toMatch(/Sent 2 queued actions/);

    // Only an explicit "Forget this device" clears the queue and the log.
    online = false;
    await ctrl.addNote("proj_game", "another one");
    expect(ctrl.outbox.size()).toBe(1);
    await ctrl.forgetDevice();
    expect(ctrl.outbox.size()).toBe(0);
    expect(ctrl.changeLog.all()).toEqual([]);
    expect(ctrl.state.outboxPending).toBe(0);
    expect(ctrl.state.notice).toBeNull();
    ctrl.close();
    h.controller.close();
  });

  it("takes the monthly cap and the CHF rate from the service, never from constants", async () => {
    const h = await createMobileHarness();
    await h.controller.bootstrap();
    await until(() => h.controller.state.projectsLoaded, 3000, "projects");
    const ctx = h.controller.cardContext();
    // The fake's /me carries no monthly cap (the real service does not send one yet): unknown.
    expect(ctx.monthlyCeilingChfMicro).toBeNull();
    // The rate comes from the project cards' USD/CHF pairs (the fake applies 0.8).
    expect(ctx.chfPerUsd).toBeCloseTo(0.8, 5);
    const unknown = h.controller.planCard([
      { name: "budget.set", params: { scope: "month", amountChf: 250 } },
    ]);
    expect(unknown).toMatchObject({ oldValue: "the current cap", impact: { risk: "high" } });
    expect(unknown.impact.costChfMicro).toBeUndefined();
    const usd = h.controller.planCard([
      { name: "budget.set", params: { scope: "project", amountUsdMicro: 50_000_000 } },
    ]);
    expect(usd.newValue).toBe("CHF 40");

    // Once /me carries the cap, the card uses it: old value, risk and the undo amount.
    const realFetch = h.env.fetch as NonNullable<typeof h.env.fetch>;
    h.env.fetch = async (input, init) => {
      const res = await realFetch(input, init);
      if (!/\/me$/.test(input) || !res.ok) return res;
      const json = (await res.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ...json, monthlyCap: { usdMicro: 250_000_000, chfMicro: 200_000_000 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const ctrl = new MobileController(h.env);
    await ctrl.bootstrap();
    await until(() => ctrl.state.session?.monthlyCapChfMicro === 200_000_000, 3000, "cap");
    expect(ctrl.cardContext().monthlyCeilingChfMicro).toBe(200_000_000);
    expect(h.env.storage.get("forerunner.mobile.test.session")).toContain("200000000");
    const lower = ctrl.planCard([
      { name: "budget.set", params: { scope: "month", amountChf: 150 } },
    ]);
    expect(lower).toMatchObject({ oldValue: "CHF 200", impact: { risk: "medium" } });
    expect(lower.impact.costChfMicro).toBe(-50_000_000);
    ctrl.close();
    h.controller.close();
  });
});
