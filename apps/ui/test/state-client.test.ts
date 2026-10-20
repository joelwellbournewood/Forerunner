import { describe, expect, it } from "vitest";
import {
  createStateClient,
  describeStateError,
  newClientId,
  type RemotePlanEnvelope,
  StateApiError,
  type StateClient,
  verbForPlan,
} from "../src/api/state-client.ts";
import {
  type BiometricAssertion,
  simulatedBiometric,
  WebCryptoSigner,
} from "../src/api/state-signing.ts";
import { createFakeStateService, HUMAN_J } from "./fake-state-service.ts";
import { fetchFromApp } from "./helpers.tsx";
import { ADMIN_TOKEN, NOW_MS } from "./mobile-helpers.tsx";

async function paired(options: { now?: () => number; clientNow?: () => number } = {}) {
  const now = options.now ?? (() => NOW_MS);
  const service = createFakeStateService({ adminToken: ADMIN_TOKEN, pcAutoCompleteMs: null, now });
  const signer = await WebCryptoSigner.generate();
  const anonymous = createStateClient({ baseUrl: "http://state.test/", token: null }, signer, {
    fetch: fetchFromApp(service.app),
    now: options.clientNow ?? now,
  });
  const code = service.startPairing(HUMAN_J.id, "phone").code;
  const result = await anonymous.completePairing({ code, name: "Phone", platform: "android" });
  const client = anonymous.withToken(result.token);
  return { service, signer, client, anonymous, result, now };
}

describe("state client: pairing", () => {
  it("completes a pairing with a proof the service verifies and gets a scoped token", async () => {
    const { service, result, client, signer } = await paired();
    expect(result.deviceId).toMatch(/^dev_/);
    expect(result.humanId).toBe(HUMAN_J.id);
    expect(result.scopes).toContain("write:remote");
    expect(service.state.devices[0]?.publicKey).toBe(await signer.publicKey());
    const me = await client.me();
    expect(me.principal).toBe("device");
    expect(me.deviceId).toBe(result.deviceId);
    expect(client.config.baseUrl).toBe("http://state.test");
  });

  it("refuses a wrong code and a reused key", async () => {
    const { service, anonymous } = await paired();
    await expect(
      anonymous.completePairing({ code: "NOPE1234", name: "x", platform: "android" }),
    ).rejects.toMatchObject({ code: "pairing_invalid", status: 400 });
    const code = service.startPairing(HUMAN_J.id, "phone").code;
    await expect(
      anonymous.completePairing({ code, name: "x", platform: "android" }),
    ).rejects.toMatchObject({ code: "pairing_invalid", status: 409 });
  });
});

describe("state client: signed requests", () => {
  it("signs every mutation; the fake verifies with the service's crypto and records it", async () => {
    const { service, client } = await paired();
    const request = service.state.requests.find((r) => r.id === "req_merge");
    if (!request) throw new Error("fixture missing");
    const answered = await client.answerRequest(request.id, { version: 1, answer: "Approve" });
    expect(answered.status).toBe("answered");
    const call = service.state.calls.find((c) => c.path === "/requests/req_merge/answer");
    expect(call).toMatchObject({ signed: true, biometric: false, principal: "device" });
    expect(call?.body).toEqual({ version: 1, answer: "Approve" });
  });

  it("refuses an unsigned mutation and a replayed signature", async () => {
    const { client, service } = await paired();
    const token = tokenOf(client);
    const unsigned = await client.raw({
      method: "POST",
      path: "/messages/msg_handoff/receipt",
      body: { state: "read" },
      anonymous: true,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(unsigned.status).toBe(401);
    expect(((await unsigned.json()) as { code: string }).code).toBe("bad_signature");
    const first = await client.raw({
      method: "POST",
      path: "/messages/msg_handoff/receipt",
      body: { state: "read" },
    });
    expect(first.status).toBe(200);
    // A captured signed request presented again inside the window is refused: the client
    // signs afresh each time, so the replay is built by hand from the accepted signature.
    const sig = [...service.state.replay][0];
    expect(sig).toBeTruthy();
    const replay = await service.app.request("http://state.test/messages/msg_handoff/receipt", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-device-signature": sig as string,
        "x-device-timestamp": String(NOW_MS),
      },
      body: JSON.stringify({ state: "read" }),
    });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { message: string }).message).toMatch(/replayed/);
  });

  it("refuses a timestamp outside the window (phone clock skew)", async () => {
    let clock = NOW_MS;
    const { client } = await paired({ clientNow: () => clock });
    clock = NOW_MS + 6 * 60 * 1000;
    const res = await client.raw({
      method: "POST",
      path: "/messages/msg_handoff/receipt",
      body: { state: "read" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("bad_signature");
  });

  it("sends the biometric flag only with an assertion, and the service checks it on high risk", async () => {
    const { client, service, signer } = await paired();
    const high = service.state.requests.find((r) => r.id === "req_cap");
    if (!high) throw new Error("fixture missing");
    await expect(
      client.answerRequest(high.id, { version: 1, answer: "Confirm" }),
    ).rejects.toMatchObject({ code: "biometric_required", status: 403 });
    const notAsserted = { asserted: false } as unknown as BiometricAssertion;
    await expect(
      client.answerRequest(high.id, { version: 1, answer: "Confirm" }, { biometric: notAsserted }),
    ).rejects.toMatchObject({ code: "biometric_required" });
    // A literal assertion object made by a screen (no prompt ran): the signer refuses the
    // biometric=1 string, the client reports biometric_required and nothing leaves the phone
    // (the two refusals above were signed biometric=0 and reached the service; this one not).
    const reached = service.state.calls.filter((c) => c.path === "/requests/req_cap/answer");
    expect(reached).toHaveLength(2);
    expect(reached.every((c) => c.biometric === false)).toBe(true);
    const forged = {
      asserted: true,
      at: "x",
      method: "forged-by-screen",
      ticket: "never-issued",
    } as const satisfies BiometricAssertion;
    await expect(
      client.answerRequest(high.id, { version: 1, answer: "Confirm" }, { biometric: forged }),
    ).rejects.toMatchObject({ code: "biometric_required", status: 403 });
    expect(service.state.calls.filter((c) => c.path === "/requests/req_cap/answer")).toHaveLength(
      2,
    );
    expect(service.state.requests.find((r) => r.id === "req_cap")?.status).toBe("open");
    const port = simulatedBiometric(async () => true, { tickets: signer.tickets });
    const assertion = await port.assert("confirm");
    const answered = await client.answerRequest(
      high.id,
      { version: 1, answer: "Confirm" },
      { biometric: assertion },
    );
    expect(answered.status).toBe("answered");
    const call = service.state.calls.filter((c) => c.path === "/requests/req_cap/answer").pop();
    expect(call).toMatchObject({ signed: true, biometric: true });
    // The ticket was spent with that signature: replaying the assertion signs nothing more.
    await expect(
      client.answerRequest("req_name", { version: 1, answer: "Nexus" }, { biometric: assertion }),
    ).rejects.toMatchObject({ code: "biometric_required" });
  });

  it("maps revocation to unauthorized and the client's description never leaks the token", async () => {
    const { client, service, result } = await paired();
    const admin = createStateClient(
      { baseUrl: "http://state.test", token: ADMIN_TOKEN },
      await WebCryptoSigner.generate(),
      { fetch: fetchFromApp(service.app) },
    );
    const res = await admin.raw({
      method: "POST",
      path: `/devices/${result.deviceId}/revoke`,
      body: {},
    });
    expect(res.status).toBe(200);
    let error: unknown;
    try {
      await client.me();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(StateApiError);
    expect((error as StateApiError).code).toBe("unauthorized");
    expect(describeStateError(error)).toMatch(/no longer paired/);
    const text = `${(error as Error).message} ${describeStateError(error)} ${JSON.stringify((error as StateApiError).details)}`;
    expect(text).not.toContain(result.token);
    // Nor does the service's access log, nor the recorded calls.
    const everything = JSON.stringify(service.state.log) + JSON.stringify(service.state.calls);
    expect(everything).not.toContain(result.token);
  });

  it("validates responses against the contract and maps transport failures", async () => {
    const signer = await WebCryptoSigner.generate();
    const bad = createStateClient({ baseUrl: "http://state.test", token: "t" }, signer, {
      fetch: async () =>
        new Response(JSON.stringify({ projects: [{ id: 1 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(bad.projects()).rejects.toMatchObject({ code: "ui.invalid_response" });
    const down = createStateClient({ baseUrl: "http://state.test", token: "t" }, signer, {
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(down.projects()).rejects.toMatchObject({ code: "ui.network" });
    expect(
      describeStateError(new StateApiError("rate_limited", "slow down", 429, { retryAfterSec: 7 })),
    ).toMatch(/7 s/);
  });
});

describe("state client: reads and remote commands", () => {
  it("reads projects, inbox, sessions and devices", async () => {
    const { client, result } = await paired();
    const projects = await client.projects();
    expect(projects.map((p) => p.name)).toEqual(["PharmaWatch", "Supplement site", "Space game"]);
    const inbox = await client.inbox(HUMAN_J.id);
    expect(inbox.blockingCount).toBe(1);
    expect(inbox.requests).toHaveLength(3);
    expect(await client.sessions({ status: "running" })).toEqual([]);
    const devices = await client.devices();
    expect(devices[0]?.id).toBe(result.deviceId);
    await expect(client.inbox("someone_else")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("enqueues a plan as one remote command the PC picks up and completes", async () => {
    const { client, service } = await paired();
    const plan = [
      { name: "project.switch", params: { project: "proj_game" } },
      { name: "budget.set", params: { scope: "session", amountChf: 15, project: "proj_game" } },
      { name: "session.start", params: { project: "proj_game", runner: "pc" } },
    ];
    const envelope: RemotePlanEnvelope = {
      v: 1,
      kind: "plan",
      plan,
      wordsUsed:
        "switch to the game, give it 15 francs until tomorrow and start a session on my PC",
      card: {},
      clientId: newClientId(),
      confirmedAt: new Date(NOW_MS).toISOString(),
    };
    const row = await client.sendRemote({
      target: "pc",
      command: verbForPlan(plan),
      params: envelope,
    });
    expect(row.command).toBe("start");
    expect(row.status).toBe("pending");
    const stored = service.state.remoteCommands[0];
    if (!stored) throw new Error("not stored");
    service.pickUp(stored);
    expect((await client.remoteCommand(row.id)).status).toBe("picked_up");
    service.complete(stored, { executed: plan.map((c) => c.name), sessionId: "sess_1" });
    const done = await client.remoteCommand(row.id);
    expect(done.status).toBe("done");
    expect(done.result).toEqual({
      executed: ["project.switch", "budget.set", "session.start"],
      sessionId: "sess_1",
    });
    expect((await client.remoteCommands())[0]?.id).toBe(row.id);
    await expect(
      client.sendRemote({ target: "pc", command: "plan" as never, params: {} }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("picks the verb from the plan", () => {
    expect(verbForPlan([{ name: "session.stop", params: { scope: "all" } }])).toBe("kill");
    expect(verbForPlan([{ name: "session.stop", params: { scope: "agent" } }])).toBe("stop");
    expect(verbForPlan([{ name: "session.pause", params: {} }])).toBe("pause");
    expect(verbForPlan([{ name: "project.switch", params: { project: "x" } }])).toBe("start");
    expect(
      verbForPlan([
        { name: "budget.set", params: {} },
        { name: "session.start", params: {} },
      ]),
    ).toBe("start");
  });

  it("flushes an outbox batch with per-action results and duplicates", async () => {
    const { client } = await paired();
    const id = newClientId();
    const results = await client.syncOutbox([
      {
        clientId: id,
        kind: "message.receipt",
        payload: { id: "msg_handoff", state: "read" },
        createdAt: new Date(NOW_MS).toISOString(),
      },
      {
        clientId: newClientId(),
        kind: "request.answer",
        payload: { id: "nope", version: 1, answer: "x" },
        createdAt: new Date(NOW_MS).toISOString(),
      },
    ]);
    expect(results.map((r) => r.status)).toEqual(["applied", "rejected"]);
    const again = await client.syncOutbox([
      {
        clientId: id,
        kind: "message.receipt",
        payload: { id: "msg_handoff", state: "read" },
        createdAt: new Date(NOW_MS).toISOString(),
      },
    ]);
    expect(again[0]?.status).toBe("duplicate");
  });
});

/** The raw token for a client (tests only). */
function tokenOf(client: StateClient): string {
  return client.config.token ?? "";
}
