import { readdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, Logger, type LogRecord, SimulatedClock } from "@forerunner/platform";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signRequest } from "../src/auth/crypto.ts";
import { emptyIdempotency, type IdempotencyFile, IdempotencyStore } from "../src/outbox.ts";
import { MemoryJsonState } from "../src/state-file.ts";
import { type DeviceClient, type Harness, harness, json, readSse, START } from "./helpers.ts";

/**
 * Security review of the shared state service (spec S, ADR 0009, ADR 0024, ADR 0041).
 * Every test is a concrete attack from a real input and asserts the service's response
 * (refused, bounded, filtered). A test marked `it.fails` is a finding: it fails on the
 * current code and documents the gap; the comment above it names the fix.
 */

describe("security: device signatures and replay", () => {
  let h: Harness;
  let phone: DeviceClient;
  beforeEach(async () => {
    h = await harness();
    phone = await h.pairDevice(h.seed.ada.id);
  });
  afterEach(async () => {
    await h.close();
  });

  /**
   * security finding: the replay guard keys on the raw `X-Device-Signature` header string
   * while `fromBase64` decodes with Node's lenient base64 (padding optional, base64url
   * alphabet accepted, whitespace ignored). A captured signed mutation re-sent with the
   * same bytes under another spelling verifies again and is not seen as a replay.
   * Fix: key `ReplayGuard.accept` on the decoded signature bytes (hex), or refuse any
   * signature whose strict re-encoding differs from the header (as `isValidPublicKey` does).
   */
  it("refuses a captured mutation replayed with the same signature bytes under another base64 spelling", async () => {
    const body = JSON.stringify({
      fromAgentId: h.seed.alice.id,
      toHumanId: h.seed.bob.id,
      body: "handoff: please merge",
    });
    const timestamp = String(h.clock.now());
    const signature = signRequest(phone.keys.secretKey, {
      method: "POST",
      path: "/messages",
      body,
      timestamp,
      biometric: false,
    });
    const send = (sig: string) =>
      phone.app.request("/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${phone.token}`,
          "content-type": "application/json",
          "x-device-signature": sig,
          "x-device-timestamp": timestamp,
        },
        body,
      });
    expect((await send(signature)).status).toBe(201);
    // The honest replay is caught.
    expect((await send(signature)).status).toBe(401);
    // The same bytes, spelled differently: padding dropped, base64url alphabet, a space inside.
    const variants = new Set<string>([
      signature.replace(/=+$/, ""),
      signature.replace(/\+/g, "-").replace(/\//g, "_"),
      `${signature.slice(0, 20)} ${signature.slice(20)}`,
    ]);
    variants.delete(signature);
    for (const variant of variants) {
      const res = await send(variant);
      expect(res.status, `variant ${JSON.stringify(variant)}`).toBe(401);
    }
    const inbox = await h.store.message.inbox({ humanId: h.seed.bob.id }, { limit: 50 });
    expect(inbox).toHaveLength(1);
  });

  it("a signature over one body does not authorise another body, path or method", async () => {
    const body = JSON.stringify({ state: "read" });
    const timestamp = String(h.clock.now());
    const message = await h.store.message.send({
      from_agent_id: h.seed.bobAgent.id,
      to_human_id: h.seed.ada.id,
      type: "info",
      body: "hi",
    });
    const signature = signRequest(phone.keys.secretKey, {
      method: "POST",
      path: `/messages/${message.id}/receipt`,
      body,
      timestamp,
      biometric: false,
    });
    const headers = {
      authorization: `Bearer ${phone.token}`,
      "content-type": "application/json",
      "x-device-signature": signature,
      "x-device-timestamp": timestamp,
    };
    // Same signature, different body.
    const other = await phone.app.request(`/messages/${message.id}/receipt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ state: "acted" }),
    });
    expect(other.status).toBe(401);
    // Same signature, different path (a second message).
    const second = await h.store.message.send({
      from_agent_id: h.seed.bobAgent.id,
      to_human_id: h.seed.ada.id,
      type: "info",
      body: "hi again",
    });
    const otherPath = await phone.app.request(`/messages/${second.id}/receipt`, {
      method: "POST",
      headers,
      body,
    });
    expect(otherPath.status).toBe(401);
    // The genuine request still works once.
    const ok = await phone.app.request(`/messages/${message.id}/receipt`, {
      method: "POST",
      headers,
      body,
    });
    expect(ok.status).toBe(200);
    expect((await h.store.message.mustGet(second.id)).read_at).toBeNull();
  });

  it("the biometric flag cannot be added after signing, nor spelled as 'true' on an unsigned request", async () => {
    const r = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "approval",
      why: "raise the ceiling",
      risk: "high",
      options: ["yes", "no"],
    });
    // Signed with biometric=0, header says 1: the signature no longer verifies.
    const forged = await phone.post(
      `/requests/${r.id}/answer`,
      { version: r.version, answer: "yes" },
      { headers: { "x-biometric-assertion": "1" } },
    );
    expect(forged.status).toBe(401);
    expect((await json(forged)).code).toBe("bad_signature");
    // Unsigned with the header: a mutation needs a signature first.
    const unsigned = await phone.post(
      `/requests/${r.id}/answer`,
      { version: r.version, answer: "yes" },
      { unsigned: true, headers: { "x-biometric-assertion": "true" } },
    );
    expect(unsigned.status).toBe(401);
    // Signed without biometric: refused as biometric_required, and the request stays open.
    const plain = await phone.post(`/requests/${r.id}/answer`, {
      version: r.version,
      answer: "yes",
    });
    expect(plain.status).toBe(403);
    expect((await json(plain)).code).toBe("biometric_required");
    expect((await h.store.humanRequest.mustGet(r.id)).status).toBe("open");
  });

  it("a web device's biometric flag is only ever what its own key signed", async () => {
    // The web page never holds a biometric prompt (ADR 0034); the service cannot tell a
    // web key from a phone key, so the rule is: the flag counts only inside the signature.
    const web = await h.pairDevice(h.seed.ada.id, "web");
    const r = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      kind: "approval",
      why: "delete the repo",
      risk: "high",
    });
    const res = await web.post(`/requests/${r.id}/answer`, { version: r.version, answer: "yes" });
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("biometric_required");
  });

  it("a stolen bearer token without the device key can read but never mutate", async () => {
    // The token alone (no key) is what a leaked header or a compromised proxy would hold.
    const thief = phone;
    expect((await thief.get("/me", { unsigned: true })).status).toBe(200);
    const mutations: [string, unknown][] = [
      ["/messages", { fromAgentId: h.seed.alice.id, toHumanId: h.seed.bob.id, body: "x" }],
      [`/tasks/${h.seed.task1.id}/transition`, { version: 1, to: "cancelled", reason: "x" }],
      [`/projects/${h.seed.project.id}/queue`, { text: "note" }],
      ["/remote/commands", { target: "pc", command: "kill", params: {} }],
      ["/sync/outbox", { actions: [] }],
    ];
    for (const [path, body] of mutations) {
      const res = await thief.post(path, body, { unsigned: true });
      expect(res.status, path).toBe(401);
      expect((await json(res)).code, path).toBe("bad_signature");
    }
    expect(await h.store.remoteCommand.list()).toHaveLength(0);
    expect((await h.store.task.mustGet(h.seed.task1.id)).status).toBe("ready");
  });

  it("clock skew: a timestamp just inside the window passes, just outside is refused, both directions", async () => {
    const windowMs = h.api.config.signatureWindowMs;
    const at = (deltaMs: number) => String(h.clock.now() + deltaMs);
    const body = { fromAgentId: h.seed.alice.id, toHumanId: h.seed.bob.id, body: "t" };
    expect((await phone.post("/messages", body, { timestamp: at(windowMs - 1000) })).status).toBe(
      201,
    );
    expect((await phone.post("/messages", body, { timestamp: at(-windowMs + 1000) })).status).toBe(
      201,
    );
    expect((await phone.post("/messages", body, { timestamp: at(windowMs + 1000) })).status).toBe(
      401,
    );
    expect((await phone.post("/messages", body, { timestamp: at(-windowMs - 1000) })).status).toBe(
      401,
    );
    // A timestamp the device did not sign (header swapped after signing) fails too.
    const text = JSON.stringify(body);
    const signature = signRequest(phone.keys.secretKey, {
      method: "POST",
      path: "/messages",
      body: text,
      timestamp: at(1),
      biometric: false,
    });
    const res = await phone.app.request("/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${phone.token}`,
        "content-type": "application/json",
        "x-device-signature": signature,
        "x-device-timestamp": at(0),
      },
      body: text,
    });
    expect(res.status).toBe(401);
  });

  it("a replayed mutation is refused even after the device re-signs other requests, until the window passes", async () => {
    const body = { fromAgentId: h.seed.alice.id, toHumanId: h.seed.bob.id, body: "once" };
    const timestamp = String(h.clock.now());
    const first = await phone.post("/messages", body, { timestamp });
    expect(first.status).toBe(201);
    // Other traffic in between must not evict the remembered signature.
    for (let i = 0; i < 20; i++) {
      await phone.post("/messages", { ...body, body: `noise ${i}` });
    }
    expect((await phone.post("/messages", body, { timestamp })).status).toBe(401);
    h.clock.advance(h.api.config.signatureWindowMs + 1);
    // Outside the window the old timestamp is refused for that reason, never accepted.
    expect((await phone.post("/messages", body, { timestamp })).status).toBe(401);
  });
});

describe("security: pairing and tokens", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("a pairing code is single use and bound to the key that proved it; a second device cannot take it over", async () => {
    const start = await h.admin.post("/pairing/start", { humanId: h.seed.ada.id, kind: "phone" });
    const { code } = await json<{ code: string }>(start);
    const { generateDeviceKeyPair, signPairingProof } = await import("../src/auth/crypto.ts");
    const honest = generateDeviceKeyPair();
    const attacker = generateDeviceKeyPair();
    // A proof made by another key is refused, and does not burn the code.
    const wrongProof = await h.anonymous.post("/pairing/complete", {
      code,
      publicKey: honest.publicKey,
      proof: signPairingProof(attacker.secretKey, code),
      platform: "android",
    });
    expect(wrongProof.status).toBe(400);
    expect((await json(wrongProof)).code).toBe("pairing_invalid");
    // A proof over another code is refused.
    const otherCode = await h.anonymous.post("/pairing/complete", {
      code,
      publicKey: honest.publicKey,
      proof: signPairingProof(honest.secretKey, "ABCD2345"),
      platform: "android",
    });
    expect(otherCode.status).toBe(400);
    const ok = await h.anonymous.post("/pairing/complete", {
      code,
      publicKey: honest.publicKey,
      proof: signPairingProof(honest.secretKey, code),
      platform: "android",
    });
    expect(ok.status).toBe(201);
    const again = await h.anonymous.post("/pairing/complete", {
      code,
      publicKey: attacker.publicKey,
      proof: signPairingProof(attacker.secretKey, code),
      platform: "android",
    });
    expect(again.status).toBe(400);
    expect(await h.store.device.list({ owner_human_id: h.seed.ada.id })).toHaveLength(2); // desktop + phone
  });

  it("the pairing response never echoes the admin token or the token hash; the token is not in the store", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    const token = phone.token as string;
    const devices = await h.store.device.list();
    for (const d of devices) {
      expect(JSON.stringify(d)).not.toContain(token);
    }
    const records = h.api.tokens.forDevice(phone.deviceId);
    expect(records).toHaveLength(1);
    expect(records[0]?.tokenHash).not.toBe(token);
    expect(JSON.stringify(records)).not.toContain(token);
  });

  it("an expired token is refused and the device cannot refresh it by itself", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    h.clock.advance(h.api.config.sessionTokenTtlMs + 1);
    expect((await phone.get("/me")).status).toBe(401);
    // No route lets a device mint a token: pairing/start is admin only.
    const start = await phone.post("/pairing/start", { humanId: h.seed.ada.id });
    expect(start.status).toBe(401);
  });

  it("a device token cannot reach any admin-only route", async () => {
    const phone = await h.pairDevice(h.seed.ada.id);
    const cmd = await h.store.remoteCommand.enqueue({
      device_id: phone.deviceId,
      target: "pc",
      command: "start",
      params: {},
    });
    const adminOnly: [string, string, unknown][] = [
      ["POST", "/pairing/start", { humanId: h.seed.ada.id }],
      ["POST", `/devices/${h.seed.desktop.id}/revoke`, {}],
      ["GET", "/remote/commands/pending?target=pc", undefined],
      ["POST", `/remote/commands/${cmd.id}/complete`, { result: {} }],
      ["POST", `/remote/commands/${cmd.id}/fail`, { result: {} }],
    ];
    for (const [method, path, body] of adminOnly) {
      const res = await phone.request(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect((await h.store.remoteCommand.mustGet(cmd.id)).status).toBe("pending");
    expect((await h.store.device.mustGet(h.seed.desktop.id)).revoked).toBe(false);
  });

  it("a read-only token is refused on every mutation route with 403, not 2xx", async () => {
    const ro = await h.pairDevice(h.seed.ada.id, "phone", ["read"]);
    const msg = await h.store.message.send({
      from_agent_id: h.seed.bobAgent.id,
      to_human_id: h.seed.ada.id,
      type: "info",
      body: "for ada",
    });
    const r = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      kind: "decision",
      why: "pick",
      options: ["a", "b"],
    });
    const review = await h.store.review.insert({
      task_id: h.seed.task1.id,
      critic_model: "fake",
      verdict: "accept",
    });
    const mutations: [string, unknown][] = [
      ["/messages", { fromAgentId: h.seed.alice.id, toHumanId: h.seed.bob.id, body: "x" }],
      [`/messages/${msg.id}/receipt`, { state: "read" }],
      [`/requests/${r.id}/answer`, { version: r.version, answer: "a" }],
      [`/tasks/${h.seed.task1.id}/transition`, { version: 1, to: "cancelled", reason: "x" }],
      [`/projects/${h.seed.project.id}/decisions`, { question: "q", chosen: "c" }],
      [`/projects/${h.seed.project.id}/queue`, { text: "note" }],
      ["/remote/commands", { target: "pc", command: "kill", params: {} }],
      [`/reviews/${review.id}/comment`, { body: "nice" }],
      [`/reviews/${review.id}/approve`, {}],
    ];
    for (const [path, body] of mutations) {
      const res = await ro.post(path, body);
      expect(res.status, path).toBe(403);
    }
    // The outbox applies the same scopes per action.
    const batch = await ro.post("/sync/outbox", {
      actions: [
        {
          clientId: "ro-answer-0001",
          kind: "request.answer",
          payload: { id: r.id, version: r.version, answer: "a" },
          createdAt: START,
        },
      ],
    });
    expect(batch.status).toBe(200);
    const { results } = await json<{ results: { status: string; code?: string }[] }>(batch);
    expect(results[0]).toMatchObject({ status: "rejected", code: "forbidden" });
    expect((await h.store.humanRequest.mustGet(r.id)).status).toBe("open");
    expect((await h.store.message.mustGet(msg.id)).read_at).toBeNull();
  });
});

describe("security: ownership between humans", () => {
  let h: Harness;
  let ada: DeviceClient;
  let bob: DeviceClient;
  beforeEach(async () => {
    h = await harness();
    ada = await h.pairDevice(h.seed.ada.id);
    bob = await h.pairDevice(h.seed.bob.id);
  });
  afterEach(async () => {
    await h.close();
  });

  it("another human's device cannot read or act on ada's requests, messages, sessions, devices, costs or commands", async () => {
    const r = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      project_id: h.seed.project.id,
      kind: "approval",
      why: "merge",
      options: ["yes", "no"],
    });
    const msg = await h.store.message.send({
      from_agent_id: h.seed.bobAgent.id,
      to_human_id: h.seed.ada.id,
      type: "info",
      body: "to ada",
    });
    const cmd = await json<{ id: string }>(
      await ada.post("/remote/commands", { target: "pc", command: "start", params: {} }),
    );
    const reads: string[] = [
      `/requests/${r.id}`,
      `/sessions/${h.seed.session.id}`,
      `/sessions/${h.seed.session.id}/events`,
      `/devices/${ada.deviceId}`,
      `/remote/commands/${cmd.id}`,
      `/inbox?humanId=${h.seed.ada.id}`,
      `/inbox?agentId=${h.seed.alice.id}`,
      `/devices?humanId=${h.seed.ada.id}`,
      `/costs?humanId=${h.seed.ada.id}`,
      `/requests?humanId=${h.seed.ada.id}`,
      `/sessions?agentId=${h.seed.alice.id}`,
    ];
    for (const path of reads) {
      const res = await bob.get(path);
      expect(res.status, path).toBe(403);
    }
    const writes: [string, unknown][] = [
      [`/requests/${r.id}/answer`, { version: r.version, answer: "yes" }],
      [`/messages/${msg.id}/receipt`, { state: "acted" }],
      ["/messages", { fromAgentId: h.seed.alice.id, toHumanId: h.seed.bob.id, body: "as alice" }],
      [
        "/remote/commands",
        { target: "pc", targetDeviceId: ada.deviceId, command: "kill", params: {} },
      ],
      [`/reviews/x/comment`, { body: "x", fromAgentId: h.seed.alice.id }],
    ];
    for (const [path, body] of writes) {
      const res = await bob.post(path, body);
      expect([403, 404], path).toContain(res.status);
      expect(res.status, path).not.toBe(200);
    }
    // Lists are filtered, never leaking by id.
    const list = await json<{ requests: { id: string }[] }>(await bob.get("/requests"));
    expect(list.requests.map((x) => x.id)).not.toContain(r.id);
    const sessions = await json<{ sessions: { id: string }[] }>(await bob.get("/sessions"));
    expect(sessions.sessions).toEqual([]);
    const commands = await json<{ commands: { id: string }[] }>(
      await bob.get(`/remote/commands?deviceId=${ada.deviceId}`),
    );
    expect(commands.commands.map((c) => c.id)).not.toContain(cmd.id);
    // Nothing changed.
    expect((await h.store.humanRequest.mustGet(r.id)).status).toBe("open");
    expect((await h.store.message.mustGet(msg.id)).acted_at).toBeNull();
    expect(await h.store.remoteCommand.list({ target_device_id: ada.deviceId })).toHaveLength(0);
  });

  it("the outbox applies the same ownership checks per action and never half-applies a batch", async () => {
    const r = await h.store.humanRequest.insert({
      human_id: h.seed.ada.id,
      kind: "decision",
      why: "pick",
      options: ["a", "b"],
    });
    const msg = await h.store.message.send({
      from_agent_id: h.seed.alice.id,
      to_human_id: h.seed.ada.id,
      type: "info",
      body: "ada's",
    });
    const res = await bob.post("/sync/outbox", {
      actions: [
        {
          clientId: "bob-steal-answer-1",
          kind: "request.answer",
          payload: { id: r.id, version: r.version, answer: "a" },
          createdAt: START,
        },
        {
          clientId: "bob-steal-receipt-1",
          kind: "message.receipt",
          payload: { id: msg.id, state: "acted" },
          createdAt: START,
        },
        {
          clientId: "bob-steal-remote-1",
          kind: "remote.enqueue",
          payload: { target: "pc", targetDeviceId: ada.deviceId, command: "kill", params: {} },
          createdAt: START,
        },
        {
          clientId: "bob-steal-send-1",
          kind: "message.send",
          payload: { fromAgentId: h.seed.alice.id, toHumanId: h.seed.bob.id, body: "as alice" },
          createdAt: START,
        },
      ],
    });
    expect(res.status).toBe(200);
    const { results } = await json<{ results: { status: string; code?: string }[] }>(res);
    expect(results.map((x) => x.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
    expect(results.every((x) => x.code === "forbidden")).toBe(true);
    expect((await h.store.humanRequest.mustGet(r.id)).status).toBe("open");
    expect((await h.store.message.mustGet(msg.id)).acted_at).toBeNull();
    expect(await h.store.remoteCommand.list()).toHaveLength(0);
    expect(await h.store.message.list({ from_agent_id: h.seed.alice.id })).toHaveLength(1);
  });

  it("a device cannot answer a request for the runtime (no human) nor one of a project it merely reads", async () => {
    const runtimeOwned = await h.store.humanRequest.insert({
      human_id: null,
      project_id: h.seed.project.id,
      kind: "approval",
      why: "runtime decides",
    });
    const res = await ada.post(`/requests/${runtimeOwned.id}/answer`, {
      version: runtimeOwned.version,
      answer: "yes",
    });
    expect(res.status).toBe(403);
    expect((await h.store.humanRequest.mustGet(runtimeOwned.id)).status).toBe("open");
  });

  /**
   * security finding: `POST /projects/:id/decisions` with `supersedes` passes the id to
   * `DecisionRepo.supersede` without checking that the superseded decision belongs to the
   * same project. A device can retire a decision of another project by naming its id
   * (the old decision gets `superseded_by` pointing into a different project and drops out
   * of that project's current decisions). Fix: in the route (or `DecisionRepo.supersede`),
   * refuse when `old.project_id !== projectId` with 400/404.
   */
  it("a decision of one project cannot be superseded through another project's route", async () => {
    const other = await h.store.project.insert({
      name: "Other",
      goal: "Separate",
      budget_usd_micro: 1_000_000,
    });
    const original = await h.store.decision.record({
      project_id: h.seed.project.id,
      question: "Database?",
      options: ["pg", "sqlite"],
      chosen: "pg",
      decided_by: h.seed.ada.id,
    });
    const res = await bob.post(`/projects/${other.id}/decisions`, {
      question: "Database?",
      chosen: "sqlite",
      supersedes: original.id,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const current = await h.store.decision.current(h.seed.project.id);
    expect(current.map((d) => d.id)).toContain(original.id);
    expect((await h.store.decision.mustGet(original.id)).superseded_by).toBeNull();
  });
});

describe("security: revocation", () => {
  let h: Harness;
  let phone: DeviceClient;
  let server: ReturnType<typeof serve>;
  let base: string;
  const controllers: AbortController[] = [];

  beforeEach(async () => {
    h = await harness();
    phone = await h.pairDevice(h.seed.ada.id);
    server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const c of controllers) c.abort();
    controllers.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await h.close();
  });

  function open(path: string, token: string) {
    const controller = new AbortController();
    controllers.push(controller);
    return fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
  }

  it("a revoked device is refused on its very next request, signed or not, and its token is gone", async () => {
    const revoke = await h.admin.post(`/devices/${phone.deviceId}/revoke`, {});
    expect(revoke.status).toBe(200);
    expect((await phone.get("/me")).status).toBe(401);
    expect(
      (
        await phone.post("/messages", {
          fromAgentId: h.seed.alice.id,
          toHumanId: h.seed.bob.id,
          body: "after revoke",
        })
      ).status,
    ).toBe(401);
    expect(h.api.tokens.forDevice(phone.deviceId)).toHaveLength(0);
    // Its key cannot pair again either.
    const start = await json<{ code: string }>(
      await h.admin.post("/pairing/start", { humanId: h.seed.ada.id }),
    );
    const { signPairingProof } = await import("../src/auth/crypto.ts");
    const again = await h.anonymous.post("/pairing/complete", {
      code: start.code,
      publicKey: phone.keys.publicKey,
      proof: signPairingProof(phone.keys.secretKey, start.code),
      platform: "android",
    });
    expect(again.status).toBe(409);
  });

  /**
   * security finding: `authenticate()` runs once per request, and `GET /events` is one
   * request that lives until the client hangs up. A phone revoked from the desktop keeps
   * receiving the live change feed (inbox, requests, commands, tasks) for as long as its
   * stream stays open; ADR 0009 promises refusal "within one request of the revocation".
   * Fix: in `sseLoop` (or the two SSE routes) re-read the device row on every flush or
   * subscribe to `device.changed` for the stream's own device id and end the stream when
   * `revoked` is true.
   */
  it("revoking a device ends its open change feed instead of streaming on", async () => {
    const res = await open("/events", phone.token as string);
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await readSse(reader, (events) => events.some((e) => e.event === "ready"));
    expect((await h.admin.post(`/devices/${phone.deviceId}/revoke`, {})).status).toBe(200);
    expect((await phone.get("/me")).status).toBe(401);
    // A private event for ada after the revocation.
    await h.admin.post("/messages", {
      fromAgentId: h.seed.bobAgent.id,
      toHumanId: h.seed.ada.id,
      body: "secret after revoke",
    });
    const events = await readSse(
      reader,
      (es) => es.some((e) => e.event === "message.changed"),
      1500,
    );
    expect(events.some((e) => e.event === "message.changed")).toBe(false);
  });
});

describe("security: the change feed never carries another human's private events", () => {
  let h: Harness;
  let server: ReturnType<typeof serve>;
  let base: string;
  const controllers: AbortController[] = [];

  beforeEach(async () => {
    h = await harness();
    server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const c of controllers) c.abort();
    controllers.length = 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await h.close();
  });

  function open(path: string, token: string) {
    const controller = new AbortController();
    controllers.push(controller);
    return fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
  }

  it("bob's phone never sees ada's inbox, requests, queue items, devices or remote commands on /events", async () => {
    const bob = await h.pairDevice(h.seed.bob.id);
    const ada = await h.pairDevice(h.seed.ada.id);
    const res = await open("/events", bob.token as string);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await readSse(reader, (events) => events.some((e) => e.event === "ready"));
    const privateIds = new Set<string>([ada.deviceId]);
    privateIds.add(
      (
        await json<{ id: string }>(
          await h.admin.post("/messages", {
            fromAgentId: h.seed.bobAgent.id,
            toHumanId: h.seed.ada.id,
            body: "private",
          }),
        )
      ).id,
    );
    privateIds.add(
      (
        await h.store.humanRequest.insert({
          human_id: h.seed.ada.id,
          kind: "decision",
          why: "private",
        })
      ).id,
    );
    privateIds.add(
      (
        await json<{ id: string }>(
          await ada.post(`/projects/${h.seed.project.id}/queue`, { text: "ada's note" }),
        )
      ).id,
    );
    privateIds.add(
      (
        await json<{ id: string }>(
          await ada.post("/remote/commands", { target: "pc", command: "start", params: {} }),
        )
      ).id,
    );
    await h.api.poller.pollOnce();
    // A project-wide marker so the read has something to stop on.
    await h.admin.post(`/tasks/${h.seed.task2.id}/transition`, {
      version: h.seed.task2.version,
      to: "cancelled",
      reason: "marker",
    });
    const events = await readSse(reader, (es) => es.some((e) => e.event === "task.changed"), 3000);
    const frames = events.filter((e) => e.event !== "ready" && e.event !== "heartbeat");
    const leaked = frames.filter((e) => {
      const d = e.data as { humanId: string | null; payload?: { id?: string } };
      return d.humanId === h.seed.ada.id || privateIds.has(d.payload?.id ?? "");
    });
    expect(leaked).toEqual([]);
    expect(frames.some((e) => e.event === "task.changed")).toBe(true);
  });

  /**
   * security finding: `ChangePoller.describe` leaves `humanId` null for `session` and
   * `event` rows, and `filterForHuman` treats null as project-wide, so every paired device
   * of every human receives `session.changed` and `session.event` frames for every other
   * human's sessions (session id, agent id, status, event type names and the pace of a
   * session) although `GET /sessions/:id` and the log route refuse them as "one human's
   * working notes" (ADR 0009 amendment). Fix: in `describe()` resolve the session's agent
   * owner (`ownerOfAgent(agent_id)`, and for `event` rows the session's agent) into
   * `humanId`, as remote commands and messages already do.
   */
  it("bob's phone does not receive session.event / session.changed frames of ada's agent's session", async () => {
    const bob = await h.pairDevice(h.seed.bob.id);
    const res = await open("/events", bob.token as string);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await readSse(reader, (events) => events.some((e) => e.event === "ready"));
    await h.store.event.append(h.seed.session.id, "tool.call", { text: "ada's private step" });
    await h.store.session.setStatus(
      h.seed.session.id,
      (await h.store.session.mustGet(h.seed.session.id)).version,
      "paused",
    );
    await h.api.poller.pollOnce();
    await h.admin.post(`/tasks/${h.seed.task2.id}/transition`, {
      version: h.seed.task2.version,
      to: "cancelled",
      reason: "marker",
    });
    const events = await readSse(reader, (es) => es.some((e) => e.event === "task.changed"), 3000);
    const adaSession = events.filter(
      (e) =>
        (e.event === "session.event" || e.event === "session.changed") &&
        (e.data as { sessionId: string | null }).sessionId === h.seed.session.id,
    );
    expect(adaSession).toEqual([]);
  });

  /**
   * security critic (low): `describe()` fell back to `humanId = null` (project-wide) when the
   * owner of a `session` or `event` row could not be resolved (`ownerOfAgent` /
   * `ownerOfSession` returning null for a missing row), so an unresolvable private event was
   * open rather than closed: sent to every device of the project. Fix: a row that names an
   * agent, session or device the store cannot resolve is not published at all, and the
   * missing referent is logged once.
   */
  it("a session whose agent row cannot be resolved is not broadcast to anyone (fail closed), logged once", async () => {
    const bob = await h.pairDevice(h.seed.bob.id);
    const res = await open("/events", bob.token as string);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await readSse(reader, (events) => events.some((e) => e.event === "ready"));
    const published: { type: string; sessionId: string | null; humanId: string | null }[] = [];
    const unsubscribe = h.api.bus.subscribe((e) =>
      published.push({ type: e.type, sessionId: e.sessionId, humanId: e.humanId }),
    );
    const warnings: LogRecord[] = [];
    const removeSink = Logger.addSink((r) => {
      if (r.level === "warn" && r.scope === "state-api:realtime") warnings.push(r);
    });
    try {
      // Ada's agent row disappears underneath her running session (a dangling reference).
      await h.store.db.exec("PRAGMA foreign_keys = OFF");
      await h.store.db.exec(`DELETE FROM "agent" WHERE "id" = '${h.seed.alice.id}'`);
      await h.store.db.exec("PRAGMA foreign_keys = ON");
      await h.store.event.append(h.seed.session.id, "tool.call", { text: "step one" });
      await h.store.event.append(h.seed.session.id, "tool.result", { text: "step two" });
      await h.store.session.setStatus(
        h.seed.session.id,
        (await h.store.session.mustGet(h.seed.session.id)).version,
        "paused",
      );
      await h.api.poller.pollOnce();
      await h.admin.post(`/tasks/${h.seed.task2.id}/transition`, {
        version: h.seed.task2.version,
        to: "cancelled",
        reason: "marker",
      });
      const events = await readSse(
        reader,
        (es) => es.some((e) => e.event === "task.changed"),
        3000,
      );
      const adaSession = events.filter(
        (e) =>
          (e.event === "session.event" || e.event === "session.changed") &&
          (e.data as { sessionId: string | null }).sessionId === h.seed.session.id,
      );
      expect(adaSession).toEqual([]);
      // Not even as a project-wide or admin event: the rows were skipped, not widened.
      expect(published.filter((e) => e.sessionId === h.seed.session.id)).toEqual([]);
      expect(published.some((e) => e.type === "task.changed")).toBe(true);
      // Three rows, one missing agent: one warning naming it, no ids of the rows' content.
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings[0])).toContain(h.seed.alice.id);
      // A later poll over the same dangling agent does not warn again.
      await h.store.event.append(h.seed.session.id, "tool.call", { text: "step three" });
      await h.api.poller.pollOnce();
      expect(warnings).toHaveLength(1);
      expect(published.filter((e) => e.sessionId === h.seed.session.id)).toEqual([]);
    } finally {
      removeSink();
      unsubscribe();
    }
  });

  it("Last-Event-ID resume replays only what the filter allows", async () => {
    const bob = await h.pairDevice(h.seed.bob.id);
    // Events published before bob connects: one private to ada, one project-wide.
    await h.admin.post("/messages", {
      fromAgentId: h.seed.bobAgent.id,
      toHumanId: h.seed.ada.id,
      body: "before",
    });
    await h.admin.post(`/tasks/${h.seed.task2.id}/transition`, {
      version: h.seed.task2.version,
      to: "cancelled",
      reason: "marker",
    });
    const controller = new AbortController();
    controllers.push(controller);
    const res = await fetch(`${base}/events`, {
      headers: {
        authorization: `Bearer ${bob.token}`,
        accept: "text/event-stream",
        "last-event-id": "0",
      },
      signal: controller.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const events = await readSse(reader, (es) => es.some((e) => e.event === "task.changed"), 3000);
    expect(events.some((e) => e.event === "message.changed")).toBe(false);
    expect(events.some((e) => e.event === "task.changed")).toBe(true);
  });
});

describe("security: input validation and bounds", () => {
  let h: Harness;
  let phone: DeviceClient;
  beforeEach(async () => {
    h = await harness();
    phone = await h.pairDevice(h.seed.ada.id);
  });
  afterEach(async () => {
    await h.close();
  });

  it("rejects malformed query numbers, ids and enums instead of guessing", async () => {
    const cases: [string, number][] = [
      ["/inbox?limit=-1", 400],
      ["/inbox?limit=abc", 400],
      [`/sessions/${h.seed.session.id}/events?afterSeq=-1`, 400],
      [`/sessions/${h.seed.session.id}/events?afterSeq=x`, 400],
      [`/projects/${h.seed.project.id}/tasks?offset=-5`, 400],
    ];
    for (const [path, status] of cases) {
      expect((await phone.get(path)).status, path).toBe(status);
    }
    // Unknown statuses are dropped, never passed through.
    // Signed as the real clients do: the path of the URL object that is fetched.
    const injected = new URL(
      `/projects/${h.seed.project.id}/tasks?status=${encodeURIComponent("ready,';DROP TABLE task;--")}`,
      "http://localhost",
    );
    const tasksRes = await phone.get(`${injected.pathname}${injected.search}`);
    expect(tasksRes.status, await tasksRes.clone().text()).toBe(200);
    const tasks = await json<{ tasks: unknown[] }>(tasksRes);
    expect(tasks.tasks).toHaveLength(2);
    expect((await h.store.task.list()).length).toBe(2);
    const bad = await phone.post("/remote/commands", {
      target: "pc",
      command: "rm -rf /",
      params: {},
    });
    expect(bad.status).toBe(400);
    const badTarget = await phone.post("/remote/commands", {
      target: "mars",
      command: "start",
      params: {},
    });
    expect(badTarget.status).toBe(400);
    const badTransition = await phone.post(`/tasks/${h.seed.task1.id}/transition`, {
      version: 1,
      to: "exploded",
      reason: "x",
    });
    expect(badTransition.status).toBe(400);
  });

  it("upload names cannot escape the project's upload directory", async () => {
    const boundary = "----forerunner-security-boundary";
    const raw = new TextEncoder().encode(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="../../../../etc/passwd"',
        "Content-Type: text/plain",
        "",
        "root:x:0:0",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const res = await phone.send("POST", `/projects/${h.seed.project.id}/uploads`, raw, {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    });
    expect(res.status).toBe(201);
    const view = await json<{ name: string; id: string }>(res);
    expect(view.name).not.toMatch(/[\\/]/);
    expect(view.name).not.toContain("..");
    const asset = await h.store.dataAsset.mustGet(view.id);
    const dir = join(h.dir, "uploads", h.seed.project.id);
    expect(asset.locator.startsWith(dir)).toBe(true);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("..");
  });

  it("the JSON body limit and the batch bound hold on the outbox", async () => {
    const big = "x".repeat(h.api.config.jsonBodyLimitBytes + 1);
    const res = await phone.post("/sync/outbox", {
      actions: [
        {
          clientId: "big-body-0001",
          kind: "queue.enqueue",
          payload: { text: big },
          createdAt: START,
        },
      ],
    });
    expect(res.status).toBe(413);
    const many = await phone.post("/sync/outbox", {
      actions: Array.from({ length: 101 }, (_, i) => ({
        clientId: `many-${String(i).padStart(4, "0")}`,
        kind: "message.receipt",
        payload: { id: "nope", state: "read" },
        createdAt: START,
      })),
    });
    expect(many.status).toBe(400);
  });

  /**
   * security finding: the idempotency store (`idempotency.json`) keeps one record per
   * (device, clientId) for a week with no cap per device or in total, and every `put`
   * rewrites the whole file. A paired device sending fresh client ids at its rate limit
   * (60 batches/min x 100 actions, rejected ones included) grows the service's state file
   * without bound and makes every outbox write O(n). Fix: cap records per device key
   * (drop the oldest beyond, say, 5,000) and the file as a whole, or move the records to
   * a table with an index on (key) and a TTL sweep.
   */
  it("the idempotency store is bounded per device", async () => {
    const clock = new SimulatedClock(START);
    const state = new MemoryJsonState<IdempotencyFile>(emptyIdempotency());
    const store = new IdempotencyStore(state, clock);
    const CAP = 5_000;
    for (let i = 0; i < CAP + 1_000; i++) {
      await store.put("device-a", `client-${i}`, { clientId: `client-${i}`, status: "rejected" });
    }
    expect(state.get().records.length).toBeLessThanOrEqual(CAP);
  });

  /**
   * security critic (low): the per-key cap selected a key's records with
   * `r.key.startsWith(`${deviceKey}:`)`. `INSTALL_ID` allows ':' in an admin install id, so
   * install `default` and install `default:x` shared one cap and the oldest of the union were
   * dropped (the wrong records for one of them). Fix: a record carries its device key, and
   * the cap counts records by that key, never by a prefix of the composite key.
   */
  it("the idempotency cap is per key: an install id that extends another's never shares its cap", async () => {
    const clock = new SimulatedClock(START);
    const state = new MemoryJsonState<IdempotencyFile>(emptyIdempotency());
    const store = new IdempotencyStore(state, clock, undefined, { maxPerKey: 3 });
    const outer = "admin:default";
    const inner = "admin:default:x";
    const rejected = (clientId: string) => ({ clientId, status: "rejected" as const });
    for (const c of ["c1", "c2", "c3"]) await store.put(inner, c, rejected(c));
    for (const d of ["d1", "d2", "d3"]) await store.put(outer, d, rejected(d));
    // Both installs are at their cap of 3; neither dropped the other's records.
    expect(state.get().records).toHaveLength(6);
    for (const c of ["c1", "c2", "c3"]) expect(store.get(inner, c)).toBeDefined();
    for (const d of ["d1", "d2", "d3"]) expect(store.get(outer, d)).toBeDefined();
    // A fourth record of the outer install drops the outer's oldest only.
    await store.put(outer, "d4", rejected("d4"));
    expect(store.get(outer, "d1")).toBeUndefined();
    expect(store.get(outer, "d4")).toBeDefined();
    for (const c of ["c1", "c2", "c3"]) expect(store.get(inner, c)).toBeDefined();
    // A client id containing ':' belongs to the key that stored it, not to a longer one.
    await store.put(outer, "x:c1", rejected("x:c1"));
    expect(store.get(outer, "x:c1")).toBeDefined();
    expect(store.get(inner, "c1")).toBeDefined();
    expect(state.get().records.filter((r) => r.key === `${inner}:c1`)).toHaveLength(1);
  });

  it("a device's rate limit is per device: one chatty device does not starve another", async () => {
    const tight = await harness({ config: { rateLimitPerMinute: 5 } });
    try {
      const a = await tight.pairDevice(tight.seed.ada.id);
      const b = await tight.pairDevice(tight.seed.bob.id);
      let limited = false;
      for (let i = 0; i < 8; i++) {
        if ((await a.get("/me")).status === 429) limited = true;
      }
      expect(limited).toBe(true);
      expect((await b.get("/me")).status).toBe(200);
      expect((await tight.admin.get("/projects")).status).toBe(200);
    } finally {
      await tight.close();
    }
  });
});

describe("security: remote command flow", () => {
  let h: Harness;
  let ada: DeviceClient;
  let bob: DeviceClient;
  beforeEach(async () => {
    h = await harness();
    ada = await h.pairDevice(h.seed.ada.id);
    bob = await h.pairDevice(h.seed.bob.id);
  });
  afterEach(async () => {
    await h.close();
  });

  it("a device cannot issue as another device, and a PC runner keyed on ada's agent never takes bob's command", async () => {
    const forged = await json<{ deviceId: string }>(
      await bob.post("/remote/commands", {
        target: "pc",
        command: "kill",
        params: { scope: "all" },
        deviceId: ada.deviceId,
      }),
    );
    expect(forged.deviceId).toBe(bob.deviceId);
    const pick = await h.admin.get(
      `/remote/commands/pending?target=pc&agentId=${h.seed.alice.id}&deviceId=${h.seed.desktop.id}`,
    );
    expect(pick.status).toBe(204);
    const row = (await h.store.remoteCommand.list())[0];
    expect(row?.status).toBe("pending");
  });

  it("a stale tap (replayed envelope) never becomes a second command, and a changed body under the same id is refused", async () => {
    const envelope = {
      target: "pc",
      command: "start",
      params: {
        v: 1,
        kind: "plan",
        plan: [{ name: "session.start", params: {} }],
        clientId: "tap-0001",
      },
    };
    const first = await ada.post("/remote/commands", envelope);
    expect(first.status).toBe(201);
    h.clock.advance(1);
    const again = await ada.post("/remote/commands", envelope);
    expect(again.status).toBe(200);
    const viaOutbox = await json<{ results: { status: string }[] }>(
      await ada.post("/sync/outbox", {
        actions: [
          { clientId: "tap-0001", kind: "remote.enqueue", payload: envelope, createdAt: START },
        ],
      }),
    );
    expect(viaOutbox.results[0]?.status).toBe("duplicate");
    h.clock.advance(1);
    const changed = await ada.post("/remote/commands", {
      ...envelope,
      params: { ...envelope.params, plan: [{ name: "session.stop", params: { scope: "all" } }] },
    });
    expect(changed.status).toBe(409);
    expect(await h.store.remoteCommand.list()).toHaveLength(1);
  });

  it("a command's lifecycle cannot be rewound: done stays done, a second pick-up gets nothing", async () => {
    const cmd = await json<{ id: string }>(
      await ada.post("/remote/commands", { target: "pc", command: "start", params: {} }),
    );
    const picked = await h.admin.get("/remote/commands/pending?target=pc");
    expect(picked.status).toBe(200);
    expect((await h.admin.get("/remote/commands/pending?target=pc")).status).toBe(204);
    expect(
      (await h.admin.post(`/remote/commands/${cmd.id}/complete`, { result: { ok: true } })).status,
    ).toBe(200);
    expect(
      (await h.admin.post(`/remote/commands/${cmd.id}/fail`, { result: { ok: false } })).status,
    ).toBe(400);
    expect((await h.admin.post(`/remote/commands/${cmd.id}/complete`, { result: {} })).status).toBe(
      400,
    );
    const row = await h.store.remoteCommand.mustGet(cmd.id);
    expect(row.status).toBe("done");
    expect(row.result).toEqual({ ok: true });
  });
});
