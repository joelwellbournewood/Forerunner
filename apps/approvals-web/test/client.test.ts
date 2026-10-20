import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, createClient, describeError, type StateClient } from "../src/api/client.ts";
import { exchangeCode, type WebSession } from "../src/api/session.ts";
import { type FakeStateService, startFakeStateService } from "./fake-state-service.ts";

const clock = { now: () => Date.now() };

/** The ApiError a call rejects with; fails when it resolves. */
async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the call to fail");
}

describe("state client", () => {
  let fake: FakeStateService;
  let session: WebSession;
  let client: StateClient;

  beforeEach(async () => {
    fake = await startFakeStateService({ clock });
    const code = fake.startPairing({
      scopes: ["read", "write:inbox", "write:approvals", "write:remote"],
    });
    session = await exchangeCode({ baseUrl: fake.url, code, deviceName: "t" });
    client = createClient({ baseUrl: fake.url, session, clock });
  });
  afterEach(async () => {
    await fake.close();
  });

  it("reads with the bearer header only and validates the body", async () => {
    const me = await client.me();
    expect(me.humanId).toBe("h1");
    const inbox = await client.inbox();
    expect(inbox.requests.length).toBe(5);
    expect(inbox.blockingCount).toBe(1);
    const call = fake.calls("/inbox")[0];
    expect(call?.headers.authorization).toBe(`Bearer ${session.token}`);
    expect(call?.headers["x-device-signature"]).toBeUndefined();
    expect(call?.query).toBe("?humanId=h1");
    expect(client.hasScope("write:remote")).toBe(true);
    expect(client.hasScope("confirm:high")).toBe(false);
  });

  it("signs every mutation so the service accepts it, and never signs the same request twice", async () => {
    const r = await client.answerRequest("req-blocking", { version: 1, answer: "Postgres" });
    expect(r.status).toBe("answered");
    const call = fake.calls("/requests/req-blocking/answer")[0];
    expect(call?.headers["x-device-signature"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(call?.headers["x-device-timestamp"]).toMatch(/^\d{13}$/);
    expect(call?.headers["x-biometric-assertion"]).toBeUndefined();
    expect(call?.body).toEqual({ version: 1, answer: "Postgres" });
    const m = await client.markRead("msg-1");
    expect(m.readAt).not.toBeNull();
    const cmd = await client.sendRemoteCommand({
      target: "pc",
      command: "kill",
      params: { scope: "all" },
    });
    expect(cmd.status).toBe("pending");
    const again = await client.remoteCommand(cmd.id);
    expect(again.id).toBe(cmd.id);
    expect((await client.remoteCommands(5)).map((c) => c.id)).toContain(cmd.id);
  });

  it("refuses a mutation signed by another key", async () => {
    const other = await exchangeCode({
      baseUrl: fake.url,
      code: fake.startPairing(),
      deviceName: "o",
    });
    const forged = createClient({
      baseUrl: fake.url,
      session: { ...session, privateJwk: other.privateJwk },
      clock,
    });
    await expect(forged.markRead("msg-1")).rejects.toMatchObject({ code: "bad_signature" });
  });

  it("maps service errors to codes and plain words", async () => {
    const conflict = await failure(
      client.answerRequest("req-blocking", { version: 7, answer: "x" }),
    );
    expect(conflict).toBeInstanceOf(ApiError);
    expect(conflict.code).toBe("version_conflict");
    expect(conflict.status).toBe(409);
    expect(describeError(conflict)).toMatch(/changed on another device/i);
    const high = await failure(
      client.answerRequest("req-high", { version: 1, answer: "Yes, raise it" }),
    );
    expect(high.code).toBe("biometric_required");
    expect(describeError(high)).toMatch(/confirm/i);
    const missing = await failure(client.remoteCommand("nope"));
    expect(missing.code).toBe("not_found");
    const noScope = createClient({
      baseUrl: fake.url,
      session: { ...session, scopes: ["read"] },
      clock,
    });
    expect(noScope.hasScope("write:remote")).toBe(false);
    const expired = createClient({
      baseUrl: fake.url,
      session: { ...session, token: "bogus" },
      clock,
    }); // not-a-secret
    const unauthorized = await failure(expired.me());
    expect(unauthorized.code).toBe("unauthorized");
    expect(describeError(unauthorized)).toMatch(/expired or was revoked/);
    expect(describeError(new ApiError("web.network", "", 0))).toMatch(/Cannot reach/);
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError(42)).toBe("Something went wrong.");
  });

  it("rejects a response that does not match the contract and a dead service", async () => {
    const bad = createClient({
      baseUrl: fake.url,
      session,
      clock,
      fetchImpl: async () =>
        new Response(JSON.stringify({ projects: [{ id: 1 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(bad.projects()).rejects.toMatchObject({ code: "web.invalid_response" });
    const notJson = createClient({
      baseUrl: fake.url,
      session,
      clock,
      fetchImpl: async () => new Response("<html>", { status: 502 }),
    });
    await expect(notJson.projects()).rejects.toMatchObject({ code: "web.http_error", status: 502 });
    const dead = createClient({ baseUrl: "http://127.0.0.1:9", session, clock });
    await expect(dead.projects()).rejects.toMatchObject({ code: "web.network" });
  });

  it("keeps the token out of every URL and error message", async () => {
    await client.projects();
    await client.devices();
    await client.sessions(["running"]);
    await client.answerRequest("req-blocking", { version: 1, answer: "SQLite" });
    for (const call of fake.calls()) {
      expect(call.path).not.toContain(session.token);
      expect(call.query).not.toContain(session.token);
    }
    const err = await failure(client.remoteCommand("missing"));
    expect(err.message).not.toContain(session.token);
    expect(describeError(err)).not.toContain(session.token);
  });
});
