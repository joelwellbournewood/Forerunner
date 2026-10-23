import { Logger, type LogRecord, SimulatedClock } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateDeviceKeyPair, signPairingProof } from "../src/auth/crypto.ts";
import { readConfig } from "../src/config.ts";
import { resolvePushSender } from "../src/main.ts";
import { AUDIT_TOOL_TOKEN_CLEARED, PUSH_NOT_CONFIGURED } from "../src/push/fanout.ts";
import { FcmSender, parseServiceAccount } from "../src/push/fcm.ts";
import {
  type FakeGoogle,
  HANG,
  startFakeGoogle,
  TEST_PROJECT,
  UNAVAILABLE,
  UNREGISTERED,
} from "./fake-google.ts";
import { Client, DeviceClient, type Harness, harness, json, START } from "./helpers.ts";

/**
 * Android push from the state service (spec R.6, ADR 0085): the FCM HTTP v1 sender against a
 * fake OAuth token endpoint and a fake FCM endpoint (real HTTP on the loopback address), the
 * fan-out of the four kinds to the human's devices with a push token, quiet hours, token
 * invalidation, retries, the token routes, and the unconfigured no-op.
 */

const REF = "fcm_service_account";
const PHONE_TOKEN = ["fcm", "registration", "token", "phone", "of", "ada"].join("-"); // not-a-secret

interface PushHarness extends Harness {
  google: FakeGoogle;
  waits: number[];
  /** Pair a phone for `humanId` sending `pushToken` at pairing. */
  pairPhone(humanId: string, pushToken?: string): Promise<DeviceClient>;
  /** Poll once and wait for every fan-out the poll started. */
  tick(): Promise<void>;
}

async function pushHarness(opts: { configured?: boolean } = {}): Promise<PushHarness> {
  const google = await startFakeGoogle();
  const waits: number[] = [];
  const push =
    opts.configured === false
      ? undefined
      : {
          sender: new FcmSender({
            account: parseServiceAccount(google.serviceAccountJson),
            clock: new SimulatedClock(START),
            apiUrl: google.url,
            backoffMs: 50,
            // Retries wait through a recorder instead of the simulated clock.
            sleep: async (ms) => {
              waits.push(ms);
            },
          }),
        };
  const h = await harness(push ? { push } : {});
  const pairPhone = async (humanId: string, pushToken?: string) => {
    const start = await h.admin.post("/pairing/start", { humanId, kind: "phone" });
    const { code } = (await start.json()) as { code: string };
    const keys = generateDeviceKeyPair();
    const res = await new Client(h.app, undefined).post("/pairing/complete", {
      code,
      publicKey: keys.publicKey,
      proof: signPairingProof(keys.secretKey, code),
      name: "Pixel",
      platform: "android",
      ...(pushToken ? { pushToken } : {}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { deviceId: string; token: string; humanId: string };
    return new DeviceClient(h.app, body.token, keys, body.deviceId, body.humanId, h.clock);
  };
  return {
    ...h,
    google,
    waits,
    pairPhone,
    async tick() {
      await h.api.poller.pollOnce();
      await h.api.push.idle();
    },
    async close() {
      await h.close();
      await google.close();
    },
  };
}

describe("FCM sender (HTTP v1, OAuth2 from the service account)", () => {
  let google: FakeGoogle;
  beforeEach(async () => {
    google = await startFakeGoogle();
  });
  afterEach(() => google.close());

  const message = {
    title: "t",
    body: "b",
    data: { kind: "approval", id: "x", link: "/inbox" },
    priority: "high" as const,
  };

  function sender(waits: number[] = []): FcmSender {
    return new FcmSender({
      account: parseServiceAccount(google.serviceAccountJson),
      clock: new SimulatedClock(START),
      apiUrl: google.url,
      backoffMs: 100,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
  }

  it("mints one access token with a valid RS256 JWT and reuses it across sends", async () => {
    const s = sender();
    expect(s.endpoint).toBe(`${google.url}/v1/projects/${TEST_PROJECT}/messages:send`);
    expect(await s.send("tok-a", message)).toEqual({ status: "sent", attempts: 1 });
    expect(await s.send("tok-b", message)).toEqual({ status: "sent", attempts: 1 });
    expect(google.tokenRequests).toHaveLength(1);
    expect(google.tokenRequests[0]?.signatureValid).toBe(true);
    expect(google.tokenRequests[0]?.grantType).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(google.sent.map((m) => m.message.token)).toEqual(["tok-a", "tok-b"]);
    expect(google.sent[0]?.authorization).toBe(`Bearer ${google.accessTokens[0]}`);
    expect(google.sent[0]?.message.android?.priority).toBe("HIGH");
    expect(google.sent[0]?.message.data).toEqual(message.data);
  });

  it("retries 5xx with doubling backoff and gives up after the attempt budget", async () => {
    const waits: number[] = [];
    const s = sender(waits);
    google.script("flaky", [UNAVAILABLE, UNAVAILABLE]);
    expect(await s.send("flaky", message)).toEqual({ status: "sent", attempts: 3 });
    expect(waits).toEqual([100, 200]);
    google.script("down", [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);
    const out = await s.send("down", message);
    expect(out).toMatchObject({ status: "failed", attempts: 4, httpStatus: 503 });
    expect(google.attempts.filter((a) => a.token === "down")).toHaveLength(4);
  });

  it("honours Retry-After on 429 and does not retry a 400", async () => {
    const waits: number[] = [];
    const s = sender(waits);
    google.script("limited", [{ status: 429, headers: { "retry-after": "2" }, body: {} }]);
    expect(await s.send("limited", message)).toEqual({ status: "sent", attempts: 2 });
    expect(waits).toEqual([2000]);
    google.script("bad", [{ status: 400, body: { error: { status: "INVALID_ARGUMENT" } } }]);
    expect(await s.send("bad", message)).toMatchObject({
      status: "failed",
      attempts: 1,
      httpStatus: 400,
    });
  });

  it("reports a 404 / UNREGISTERED token as unregistered without retrying", async () => {
    const s = sender();
    google.script("dead", [UNREGISTERED]);
    const out = await s.send("dead", message);
    expect(out.status).toBe("unregistered");
    expect(google.attempts.filter((a) => a.token === "dead")).toHaveLength(1);
  });

  it("a 404 without FCM's UNREGISTERED code (wrong API URL, a proxy page) is a failure, not a dead token", async () => {
    const s = sender();
    google.script("tok-html", [{ status: 404, body: "<html>not found</html>" }]);
    expect(await s.send("tok-html", message)).toMatchObject({
      status: "failed",
      attempts: 1,
      httpStatus: 404,
    });
    google.script("tok-bare", [{ status: 404, body: { error: { code: 404, status: "NOT_FOUND" } } }]);
    expect(await s.send("tok-bare", message)).toMatchObject({ status: "failed", httpStatus: 404 });
    // A sender pointed at the wrong path gets the fake's generic 404 for every token.
    const misrouted = new FcmSender({
      account: parseServiceAccount(google.serviceAccountJson),
      clock: new SimulatedClock(START),
      apiUrl: `${google.url}/wrong-prefix`,
      sleep: async () => undefined,
    });
    expect(await misrouted.send("tok-any", message)).toMatchObject({
      status: "failed",
      httpStatus: 404,
    });
  });

  it("a stalled FCM connection is aborted after the timeout and retried, never left hanging", async () => {
    const waits: number[] = [];
    const s = new FcmSender({
      account: parseServiceAccount(google.serviceAccountJson),
      clock: new SimulatedClock(START),
      apiUrl: google.url,
      backoffMs: 10,
      timeoutMs: 100,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    google.script("stall-once", [HANG]);
    expect(await s.send("stall-once", message)).toEqual({ status: "sent", attempts: 2 });
    google.script("stall", [HANG, HANG, HANG, HANG]);
    expect(await s.send("stall", message)).toEqual({
      status: "failed",
      attempts: 4,
      reason: "fcm request timed out",
      httpStatus: null,
    });
    expect(google.attempts.filter((a) => a.token === "stall")).toHaveLength(4);
    expect(waits).toEqual([10, 10, 20, 40]);
  }, 10_000);

  it("retries a 5xx from the token endpoint and re-mints once after a 401", async () => {
    const s = sender();
    google.failTokenRequests(1, 503);
    expect(await s.send("tok", message)).toEqual({ status: "sent", attempts: 2 });
    // A revoked access token: FCM answers 401, the sender mints a new one and succeeds.
    google.accessTokens.push("rotated-elsewhere");
    expect(await s.send("tok", message)).toEqual({ status: "sent", attempts: 2 });
  });

  it("main.ts builds the sender from the service account reference and the FCM env vars", async () => {
    const cfg = readConfig({
      FORERUNNER_FCM_SERVICE_ACCOUNT_REF: REF,
      FORERUNNER_FCM_API_URL: google.url,
      FORERUNNER_FCM_PROJECT_ID: TEST_PROJECT,
    });
    expect(cfg).toMatchObject({ fcmServiceAccountRef: REF, fcmApiUrl: google.url });
    const asked: string[] = [];
    const resolved = await resolvePushSender(
      cfg,
      async (name) => {
        asked.push(name);
        return google.serviceAccountJson;
      },
      new SimulatedClock(START),
    );
    expect(asked).toEqual([REF]);
    expect(resolved.disabledReason).toBeUndefined();
    expect(resolved.sender?.projectId).toBe(TEST_PROJECT);
    expect(await resolved.sender?.send("tok", message)).toEqual({ status: "sent", attempts: 1 });
    expect(google.sent).toHaveLength(1);
  });

  it("rejects a service account without a usable key, naming the field and never the content", () => {
    const account = JSON.parse(google.serviceAccountJson) as Record<string, string>;
    expect(() => parseServiceAccount("not json {")).toThrow(/not valid JSON/);
    const noEmail = { ...account, client_email: "" };
    expect(() => parseServiceAccount(JSON.stringify(noEmail))).toThrow(/client_email/);
    const badKey = { ...account, private_key: "garbage-key-material-1234" };
    let message = "";
    try {
      parseServiceAccount(JSON.stringify(badKey));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/private_key is not a PEM private key/);
    expect(message).not.toContain("garbage-key-material-1234");
  });
});

describe("push fan-out from the state service (spec R.6)", () => {
  let h: PushHarness;
  beforeEach(async () => {
    h = await pushHarness();
  });
  afterEach(() => h.close());

  it("pairing stores the pushToken; the device view says registered and never carries the token", async () => {
    const phone = await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    const row = await h.store.device.get(phone.deviceId);
    expect(row?.push_token).toBe(PHONE_TOKEN);
    const res = await phone.get(`/devices/${phone.deviceId}`);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ id: phone.deviceId, pushRegistered: true });
    expect(text).not.toContain(PHONE_TOKEN);
    const bare = await h.pairPhone(h.seed.ada.id);
    expect((await h.store.device.get(bare.deviceId))?.push_token).toBeNull();
  });

  it("PUT /devices/:id/push-token refreshes the token, signed, for the device itself only", async () => {
    const phone = await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    const other = await h.pairPhone(h.seed.ada.id);
    const path = `/devices/${phone.deviceId}/push-token`;

    const unsigned = await phone.request(
      "PUT",
      path,
      { pushToken: "new-token-1" },
      { unsigned: true },
    );
    expect(unsigned.status).toBe(401);
    const foreign = await other.request("PUT", path, { pushToken: "new-token-1" });
    expect(foreign.status).toBe(403);
    const empty = await phone.request("PUT", path, { pushToken: "" });
    expect(empty.status).toBe(400);

    const ok = await phone.request("PUT", path, { pushToken: "new-token-1" });
    expect(ok.status).toBe(200);
    const okText = await ok.text();
    expect(JSON.parse(okText).device.pushRegistered).toBe(true);
    expect(okText).not.toContain("new-token-1");
    expect((await h.store.device.get(phone.deviceId))?.push_token).toBe("new-token-1");

    const cleared = await phone.request("PUT", path, { pushToken: null });
    expect(cleared.status).toBe(200);
    expect((await h.store.device.get(phone.deviceId))?.push_token).toBeNull();

    // The desktop (admin) may set it too, e.g. after a re-pair; a missing device is 404.
    const byAdmin = await h.admin.request("PUT", path, { pushToken: "new-token-2" });
    expect(byAdmin.status).toBe(200);
    expect(
      (await h.admin.request("PUT", "/devices/nope/push-token", { pushToken: "x" })).status,
    ).toBe(404);

    const audit = await h.store.auditLog.list({ tool: "push.token_set" });
    expect(audit).toHaveLength(3);
    for (const a of audit) {
      expect(a.input_summary).not.toContain("new-token");
      expect(a.result_summary).not.toContain("new-token");
    }
  });

  it("sends each of the four kinds to every device of the human that holds a token", async () => {
    const phone = await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    const tablet = await h.pairPhone(h.seed.ada.id, "fcm-tablet-token");
    await h.pairPhone(h.seed.ada.id); // no token: not a target
    await h.pairPhone(h.seed.bob.id, "fcm-bob-token"); // another human: not a target
    await h.tick();
    expect(h.google.sent).toHaveLength(0);

    // 1. approval: an open request for Ada.
    const request = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "decision",
      why: "secret project detail that must not leave through Google",
      options: ["a", "b"],
    });
    await h.tick();
    // 2. budget warning: Ada's running session crosses 80% of its cap.
    await h.store.session.patch(h.seed.session.id, {
      budget_cap_usd_micro: 1_000_000,
      spent_usd_micro: 850_000,
    });
    await h.tick();
    // 3. finished session.
    await h.store.session.patch(h.seed.session.id, { status: "completed" });
    await h.tick();
    // 4. message: another human's agent writes to Ada's agent.
    const msg = await h.store.message.send({
      from_agent_id: h.seed.bobAgent.id,
      to_agent_id: h.seed.alice.id,
      type: "question",
      body: "private message text",
    });
    await h.tick();

    const byKind = (kind: string) => h.google.sent.filter((s) => s.message.data?.kind === kind);
    for (const kind of ["approval", "budget", "session", "message"]) {
      expect(
        byKind(kind)
          .map((s) => s.message.token)
          .sort(),
      ).toEqual([PHONE_TOKEN, "fcm-tablet-token"].sort());
    }
    expect(h.google.sent).toHaveLength(8);
    expect(byKind("approval")[0]?.message.data).toMatchObject({
      id: request.id,
      link: "/inbox",
      projectId: h.seed.project.id,
    });
    expect(byKind("budget")[0]?.message.notification?.title).toBe("Budget warning");
    expect(byKind("session")[0]?.message.notification?.title).toBe("Session finished");
    expect(byKind("session")[0]?.message.data?.link).toBe(`/sessions/${h.seed.session.id}`);
    expect(byKind("message")[0]?.message.data?.id).toBe(msg.id);
    // Data-minimal: no request reason or message text goes to Google.
    const wire = JSON.stringify(h.google.sent);
    expect(wire).not.toContain("secret project detail");
    expect(wire).not.toContain("private message text");
    // Sent once: polling again (or a later version of the same row) does not repeat.
    await h.store.humanRequest.patch(request.id, { risk: "medium" });
    await h.tick();
    expect(h.google.sent).toHaveLength(8);
    expect(
      (await json<{ push: { counters: { sent: number } } }>(await h.anonymous.get("/health"))).push
        .counters.sent,
    ).toBe(8);
    void phone;
    void tablet;
  });

  it("a session stopped at its budget cap is an urgent budget push; own-agent messages are not pushed", async () => {
    await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    await h.store.session.patch(h.seed.session.id, {
      budget_cap_usd_micro: 1_000_000,
      spent_usd_micro: 1_000_000,
      status: "stopped",
    });
    await h.store.message.send({
      from_agent_id: h.seed.alice.id,
      to_agent_id: h.seed.alice.id,
      type: "info",
      body: "note to self",
    });
    await h.tick();
    expect(h.google.sent).toHaveLength(1);
    expect(h.google.sent[0]?.message.data?.kind).toBe("budget");
    expect(h.google.sent[0]?.message.android?.priority).toBe("HIGH");
    expect(h.google.sent[0]?.message.notification?.title).toMatch(/Budget reached/);
  });

  it("a budget stop as the runner writes it (below the cap, stop_reason budget_exceeded) is urgent, even in quiet hours", async () => {
    await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    // 09:00 UTC is inside Ada's window: only an urgent notice goes out.
    await h.store.human.patch(h.seed.ada.id, {
      notify_prefs: { quiet_hours: { start: "08:00", end: "10:00" }, timezone: "UTC" },
    });
    // The runner's end-of-session writes: spend and handoff first, then the end status. The
    // budget hook refused the call that would cross the cap, so spend stays below it.
    await h.store.session.patch(h.seed.session.id, {
      budget_cap_usd_micro: 1_000_000,
      spent_usd_micro: 960_000,
      handoff: { stop_reason: "budget_exceeded", spent_usd_micro: 960_000 },
    });
    await h.tick();
    expect(h.google.sent).toHaveLength(0);
    expect(h.api.push.status().holding).toBe(0);
    await h.store.session.patch(h.seed.session.id, { status: "stopped" });
    await h.tick();
    expect(
      h.google.sent.map((s) => [
        s.message.data?.kind,
        s.message.notification?.title,
        s.message.android?.priority,
      ]),
    ).toEqual([["budget", "Budget reached: session stopped", "HIGH"]]);
    expect(h.api.push.status().holding).toBe(0);
  });

  it("a session that stopped new work at 80 % (budget_finish_current) pushes the budget warning and the end", async () => {
    await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    await h.store.session.patch(h.seed.session.id, {
      budget_cap_usd_micro: 1_000_000,
      spent_usd_micro: 820_000,
      handoff: { stop_reason: "budget_finish_current" },
      status: "completed",
    });
    await h.tick();
    expect(
      h.google.sent.map((s) => [s.message.data?.kind, s.message.notification?.title]),
    ).toEqual([
      ["budget", "Budget warning"],
      ["session", "Session finished"],
    ]);
    expect(h.google.sent[0]?.message.android?.priority).toBe("NORMAL");
  });

  it("a session end and its summary message buzz once; the own agent's questions and other humans' messages are pushed", async () => {
    await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    // What the runner writes at the end of a session: the status and a plain `info` summary
    // from Ada's own agent to Ada.
    await h.store.session.patch(h.seed.session.id, { status: "completed" });
    await h.store.message.send({
      from_agent_id: h.seed.alice.id,
      to_human_id: h.seed.ada.id,
      type: "info",
      body: "session summary",
    });
    await h.tick();
    expect(h.google.sent.map((s) => s.message.data?.kind)).toEqual(["session"]);
    const question = await h.store.message.send({
      from_agent_id: h.seed.alice.id,
      to_human_id: h.seed.ada.id,
      type: "question",
      body: "which branch?",
    });
    const fromBob = await h.store.message.send({
      from_agent_id: h.seed.bobAgent.id,
      to_human_id: h.seed.ada.id,
      type: "info",
      body: "fyi",
    });
    await h.tick();
    expect(
      h.google.sent.filter((s) => s.message.data?.kind === "message").map((s) => s.message.data?.id),
    ).toEqual([question.id, fromBob.id]);
  });

  it("quiet hours hold normal kinds until the window ends; urgent ones go through", async () => {
    await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    // 09:00 UTC is inside Ada's 08:00-10:00 window.
    await h.store.human.patch(h.seed.ada.id, {
      notify_prefs: { quiet_hours: { start: "08:00", end: "10:00" }, timezone: "UTC" },
    });
    await h.tick();
    const normal = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      kind: "decision",
      why: "pick",
      options: ["a", "b"],
    });
    await h.tick();
    expect(h.google.sent).toHaveLength(0);
    let health = await json<{ push: { holding: number; counters: { held: number } } }>(
      await h.anonymous.get("/health"),
    );
    expect(health.push.holding).toBe(1);
    expect(health.push.counters.held).toBe(1);

    const blocking = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      kind: "approval",
      why: "deploy",
      blocking: true,
    });
    await h.tick();
    expect(h.google.sent.map((s) => s.message.data?.id)).toEqual([blocking.id]);
    expect(h.google.sent[0]?.message.android?.priority).toBe("HIGH");

    // Still quiet: a flush sends nothing.
    expect(await h.api.push.flushHeld()).toBe(0);
    // 10:00 UTC: the window is over; the next poller tick flushes the held notice.
    await h.clock.advance(60 * 60 * 1000);
    await h.tick();
    await h.api.push.idle();
    expect(h.google.sent.map((s) => s.message.data?.id)).toEqual([blocking.id, normal.id]);
    health = await json(await h.anonymous.get("/health"));
    expect(health.push.holding).toBe(0);
  });

  it("a held notice whose request was answered or whose message was read meanwhile is dropped at the end of the window", async () => {
    await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    await h.store.human.patch(h.seed.ada.id, {
      notify_prefs: { quiet_hours: { start: "08:00", end: "10:00" }, timezone: "UTC" },
    });
    const answered = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      kind: "decision",
      why: "pick",
      options: ["a", "b"],
    });
    const stillOpen = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      kind: "decision",
      why: "pick again",
      options: ["a", "b"],
    });
    const read = await h.store.message.send({
      from_agent_id: h.seed.bobAgent.id,
      to_agent_id: h.seed.alice.id,
      type: "question",
      body: "read on the desktop at night",
    });
    await h.tick();
    expect(h.api.push.status().holding).toBe(3);
    // Answered on the desktop and read inside the window.
    await h.store.humanRequest.answer(answered.id, answered.version, "a" as never, h.seed.ada.id);
    await h.store.message.markRead(read.id);
    await h.tick();
    await h.clock.advance(60 * 60 * 1000);
    await h.tick();
    expect(h.google.sent.map((s) => s.message.data?.id)).toEqual([stillOpen.id]);
    const health = await json<{ push: { holding: number; counters: { expired: number } } }>(
      await h.anonymous.get("/health"),
    );
    expect(health.push.holding).toBe(0);
    expect(health.push.counters.expired).toBe(2);
  });

  it("one token on two device rows (a re-pair) is sent once and cleared from both when dead", async () => {
    const first = await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    const second = await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    await h.store.humanRequest.insert({ human_id: h.seed.ada.id, kind: "decision", why: "x" });
    await h.tick();
    expect(h.google.sent.map((s) => s.message.token)).toEqual([PHONE_TOKEN]);
    h.google.script(PHONE_TOKEN, [UNREGISTERED]);
    await h.store.humanRequest.insert({ human_id: h.seed.ada.id, kind: "decision", why: "y" });
    await h.tick();
    expect((await h.store.device.get(first.deviceId))?.push_token).toBeNull();
    expect((await h.store.device.get(second.deviceId))?.push_token).toBeNull();
    expect(await h.store.auditLog.list({ tool: AUDIT_TOOL_TOKEN_CLEARED })).toHaveLength(2);
    expect(h.google.attempts.filter((a) => a.token === PHONE_TOKEN)).toHaveLength(2);
  });

  it("a misrouted 404 keeps the device's token and is shown as a failure", async () => {
    const phone = await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    h.google.script(PHONE_TOKEN, [{ status: 404, body: "<html>not found</html>" }]);
    await h.store.humanRequest.insert({ human_id: h.seed.ada.id, kind: "decision", why: "x" });
    await h.tick();
    expect((await h.store.device.get(phone.deviceId))?.push_token).toBe(PHONE_TOKEN);
    expect(await h.store.auditLog.list({ tool: AUDIT_TOOL_TOKEN_CLEARED })).toHaveLength(0);
    expect(h.api.push.status()).toMatchObject({
      counters: { invalidated: 0, failed: 1 },
      lastError: "fcm http 404",
    });
  });

  it("an UNREGISTERED token is cleared from the device with an audit row; a refreshed token is kept", async () => {
    const phone = await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    h.google.script(PHONE_TOKEN, [UNREGISTERED]);
    await h.store.humanRequest.insert({ human_id: h.seed.ada.id, kind: "decision", why: "x" });
    await h.tick();
    expect(h.google.sent).toHaveLength(0);
    const row = await h.store.device.get(phone.deviceId);
    expect(row?.push_token).toBeNull();
    const audit = await h.store.auditLog.list({ tool: AUDIT_TOOL_TOKEN_CLEARED });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.human_id).toBe(h.seed.ada.id);
    expect(audit[0]?.input_summary).toContain(phone.deviceId);
    expect(audit[0]?.input_summary).not.toContain(PHONE_TOKEN);
    expect(audit[0]?.result_summary).toContain("UNREGISTERED");
    const health = await json<{ push: { counters: { invalidated: number } } }>(
      await h.anonymous.get("/health"),
    );
    expect(health.push.counters.invalidated).toBe(1);

    // The device is no longer a target until the app registers a new token.
    await h.store.humanRequest.insert({ human_id: h.seed.ada.id, kind: "decision", why: "y" });
    await h.tick();
    expect(h.google.attempts).toHaveLength(1);
    const put = await phone.request("PUT", `/devices/${phone.deviceId}/push-token`, {
      pushToken: "fcm-fresh-token",
    });
    expect(put.status).toBe(200);
    await h.store.humanRequest.insert({ human_id: h.seed.ada.id, kind: "decision", why: "z" });
    await h.tick();
    expect(h.google.sent.map((s) => s.message.token)).toEqual(["fcm-fresh-token"]);
  });

  it("5xx from FCM is retried with backoff; a final failure is counted and shown in /health", async () => {
    await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
    h.google.script(PHONE_TOKEN, [UNAVAILABLE, UNAVAILABLE]);
    await h.store.humanRequest.insert({ human_id: h.seed.ada.id, kind: "decision", why: "x" });
    await h.tick();
    expect(h.google.sent).toHaveLength(1);
    expect(h.waits).toEqual([50, 100]);
    h.google.script(PHONE_TOKEN, [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);
    await h.store.humanRequest.insert({ human_id: h.seed.ada.id, kind: "decision", why: "y" });
    await h.tick();
    const health = await json<{ push: { counters: { failed: number }; lastError: string } }>(
      await h.anonymous.get("/health"),
    );
    expect(health.push.counters.failed).toBe(1);
    expect(health.push.lastError).toMatch(/fcm http 503/);
  });

  it("no log line, /health body or audit row carries the key, the access token or a registration token", async () => {
    const records: LogRecord[] = [];
    Logger.setLevel("debug");
    const remove = Logger.addSink((r) => records.push(r));
    try {
      // Start-up resolution logs too.
      await resolvePushSender(
        { ...readConfig({}), fcmServiceAccountRef: REF },
        async () => h.google.serviceAccountJson,
        h.clock,
      );
      const phone = await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
      await h.pairPhone(h.seed.ada.id, "fcm-second-token");
      h.google.script("fcm-second-token", [UNREGISTERED]);
      h.google.script(PHONE_TOKEN, [
        UNAVAILABLE,
        { status: 400, body: { error: { status: "INVALID_ARGUMENT", message: PHONE_TOKEN } } },
      ]);
      await h.store.humanRequest.insert({ human_id: h.seed.ada.id, kind: "decision", why: "x" });
      await h.tick();
      await phone.request("PUT", `/devices/${phone.deviceId}/push-token`, {
        pushToken: "fcm-third-token",
      });
      h.google.failTokenRequests(0, 500);
      await h.store.humanRequest.insert({ human_id: h.seed.ada.id, kind: "decision", why: "y" });
      await h.tick();
      expect(h.google.sent.length).toBeGreaterThan(0);
      const health = await (await h.anonymous.get("/health")).text();
      const audit = JSON.stringify(await h.store.auditLog.list({}));
      const logs = records.map((r) => JSON.stringify(r)).join("\n");
      expect(records.some((r) => r.scope === "state-api:push")).toBe(true);
      const account = JSON.parse(h.google.serviceAccountJson) as { private_key: string };
      const keyBody = account.private_key.split("\n")[5] ?? "";
      expect(keyBody.length).toBeGreaterThan(20);
      const secrets = [
        keyBody,
        "PRIVATE KEY",
        ...h.google.accessTokens,
        PHONE_TOKEN,
        "fcm-second-token",
        "fcm-third-token",
      ];
      for (const s of secrets) {
        expect(logs).not.toContain(s);
        expect(health).not.toContain(s);
        expect(audit).not.toContain(s);
      }
    } finally {
      remove();
      Logger.setLevel("info");
    }
  });
});

describe("push without a service account", () => {
  it("is a no-op with a visible reason in /health", async () => {
    const h = await pushHarness({ configured: false });
    try {
      await h.pairPhone(h.seed.ada.id, PHONE_TOKEN);
      await h.store.humanRequest.insert({
        human_id: h.seed.ada.id,
        kind: "approval",
        why: "x",
        blocking: true,
      });
      await h.tick();
      expect(h.google.attempts).toHaveLength(0);
      expect(h.google.tokenRequests).toHaveLength(0);
      const health = await json<{ push: Record<string, unknown> }>(
        await h.anonymous.get("/health"),
      );
      expect(health.push).toMatchObject({
        mode: "polling",
        enabled: false,
        projectId: null,
        holding: 0,
      });
      expect(health.push.reason).toBe(PUSH_NOT_CONFIGURED);
      expect(String(health.push.reason)).toMatch(/FCM not configured/);
      expect(h.api.push.enabled).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("a reference that resolves to nothing or to a bad file leaves push off with the reason, not the content", async () => {
    const cfg = { ...readConfig({}), fcmServiceAccountRef: REF };
    const clock = new SimulatedClock(START);
    const none = await resolvePushSender(cfg, async () => undefined, clock);
    expect(none.sender).toBeUndefined();
    expect(none.disabledReason).toMatch(/fcm_service_account resolved to nothing/);
    const bad = await resolvePushSender(
      cfg,
      async () =>
        JSON.stringify({ project_id: "p", client_email: "e", private_key: "leaky-bytes-42" }),
      clock,
    );
    expect(bad.sender).toBeUndefined();
    expect(bad.disabledReason).toMatch(/private_key is not a PEM private key/);
    expect(bad.disabledReason).not.toContain("leaky-bytes-42");
    const unset = await resolvePushSender(readConfig({}), async () => "x", clock);
    expect(unset).toEqual({ disabledReason: PUSH_NOT_CONFIGURED });
    expect(readConfig({ FORERUNNER_FCM_SERVICE_ACCOUNT_REF: REF }).fcmServiceAccountRef).toBe(REF);
  });
});
