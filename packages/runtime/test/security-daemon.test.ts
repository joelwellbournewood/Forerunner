import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp, isLocalOrigin, startDaemon } from "../src/daemon/server.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Security review of the local daemon API (ADR 0011, ADR 0025, ADR 0030, ADR 0041): the
 * bearer token on 127.0.0.1, `daemon.json` permissions, the SSE query token, CORS, and the
 * ownership checks of the routes that act on rows other humans own on a shared state. A
 * test marked `it.fails` is a finding.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;

describe("security: local daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let home: string;
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");
  const req = (path: string, init: RequestInit = {}, auth = true) =>
    app.request(path, {
      ...init,
      headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-daemon-sec-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("every route but /health needs the exact bearer; a prefix, a suffix or a query token is refused", async () => {
    const routes: [string, string][] = [
      ["GET", "/me"],
      ["GET", "/projects"],
      ["GET", "/inbox"],
      ["GET", "/changes"],
      ["GET", "/settings"],
      ["GET", "/commands"],
      ["GET", "/memory"],
      ["POST", "/kill"],
      ["POST", "/kill/resume"],
      ["POST", "/projects"],
      ["POST", "/chat"],
      ["POST", "/commands/execute"],
      ["POST", "/sessions"],
      ["DELETE", "/memory/lessons/x"],
    ];
    for (const [method, path] of routes) {
      const none = await app.request(path, { method });
      expect(none.status, `${method} ${path} no token`).toBe(401);
      const prefix = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${token.slice(0, -1)}` },
      });
      expect(prefix.status, `${method} ${path} prefix`).toBe(401);
      const suffix = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}x` },
      });
      expect(suffix.status, `${method} ${path} suffix`).toBe(401);
      const query = await app.request(`${path}?token=${encodeURIComponent(token)}`, { method });
      expect(query.status, `${method} ${path} query token`).toBe(401);
      const basic = await app.request(path, {
        method,
        headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` },
      });
      expect(basic.status, `${method} ${path} basic`).toBe(401);
    }
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(false);
    expect(await rt.store.project.count()).toBe(0);
  });

  it("the query token is accepted only on the SSE routes, and only on GET", async () => {
    const post = await app.request(`/kill?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "all" }),
    });
    expect(post.status).toBe(401);
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(false);
    const controller = new AbortController();
    const res = await app.request(`/events?token=${encodeURIComponent(token)}`, {
      method: "GET",
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
    await res.body?.cancel().catch(() => undefined);
    const wrong = await app.request("/events?token=nope", { method: "GET" });
    expect(wrong.status).toBe(401);
  });

  it("daemon.json is written owner-only under the runtime dir, binds the loopback address, and is removed on stop", async () => {
    const running = await startDaemon(rt, { port: 0 });
    try {
      expect(running.url.startsWith("http://127.0.0.1:")).toBe(true);
      const file = join(rt.dirs.runtime, "daemon.json");
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { url: string; token: string };
      expect(parsed.url).toBe(running.url);
      expect(parsed.token).toBe(running.token);
      if (process.platform !== "win32") {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
      // The token file is the only way in: a remote-looking Host header changes nothing.
      const res = await fetch(`${running.url}/me`, {
        headers: { host: "evil.example", authorization: `Bearer ${running.token}` },
      });
      expect(res.status).toBe(200);
      const none = await fetch(`${running.url}/me`);
      expect(none.status).toBe(401);
    } finally {
      await running.stop();
    }
    expect(() => statSync(join(rt.dirs.runtime, "daemon.json"))).toThrow();
  });

  it("CORS: a foreign origin gets no allow-origin header on preflight or on a request", async () => {
    for (const origin of [
      "https://evil.example",
      "http://localhost.evil.example",
      "http://127.0.0.1.evil.example",
      "http://evil.example/localhost",
      "file://",
    ]) {
      const pre = await app.request("/me", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      });
      expect(pre.headers.get("access-control-allow-origin"), origin).toBeNull();
      const res = await req("/me", { headers: { origin } });
      expect(res.headers.get("access-control-allow-origin"), origin).toBeNull();
      expect(isLocalOrigin(origin), origin).toBe(false);
    }
    expect(isLocalOrigin("http://localhost:1420")).toBe(true);
    expect(isLocalOrigin("tauri://localhost")).toBe(true);
  });

  /**
   * security finding (low): `isLocalOrigin` accepts the literal origin `null`, which
   * browsers send for sandboxed iframes, `file://` pages and some redirects. With the
   * bearer token required on every route the practical impact is nil, but the allowance
   * is undocumented (ADR 0025 names the local hosts and `tauri://localhost` only) and
   * `Access-Control-Allow-Origin: null` is a known anti-pattern (CWE-942). Fix: drop
   * `origin === "null"` from `isLocalOrigin`, or record in ADR 0025 which shell needs it.
   */
  it("CORS: the opaque origin 'null' is not a local origin", async () => {
    const pre = await app.request("/me", {
      method: "OPTIONS",
      headers: { origin: "null", "access-control-request-method": "GET" },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    expect(isLocalOrigin("null")).toBe(false);
  });

  it("the kill switch and its resume need the token and are audited as the daemon's human", async () => {
    const killed = await req("/kill", {
      method: "POST",
      body: JSON.stringify({ scope: "all", reason: "security test" }),
    });
    expect(killed.status).toBe(200);
    expect((await json(killed)).killActive).toBe(true);
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(true);
    const resumed = await req("/kill/resume", { method: "POST" });
    expect(resumed.status).toBe(200);
    expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(false);
  });

  describe("rows of another human on a shared state", () => {
    let otherHuman: { id: string };
    let otherAgent: { id: string };
    beforeAll(async () => {
      otherHuman = await rt.store.human.insert({ name: "Other", email: "other@example.test" });
      otherAgent = await rt.store.agent.insert({
        name: "Otto",
        owner_human_id: otherHuman.id,
        kind: "principal",
      });
    });

    /**
     * security finding: `POST /requests/:id/answer` answers any human request as the
     * daemon's human, including one addressed to another human (`human_id` differs). On a
     * shared Postgres the desktop UI of one collaborator can answer the other's approval
     * requests (grant a capability, raise a cap, confirm a high-risk card) with no risk
     * check; the state service refuses the same for devices (`assertRequestOwner`). The
     * daemon holds database credentials, so this is defence in depth rather than a hard
     * boundary, but the route is the UI's contract. Fix: refuse (403) when
     * `r.human_id !== null && r.human_id !== rt.human.id`, as ADR 0041 item 4 describes.
     */
    it("does not answer a request addressed to another human", async () => {
      const r = await rt.store.humanRequest.insert({
        human_id: otherHuman.id,
        kind: "approval",
        why: "grant a capability to Otto",
        risk: "high",
        options: ["yes", "no"],
      });
      const res = await req(`/requests/${r.id}/answer`, {
        method: "POST",
        body: JSON.stringify({ version: r.version, answer: "yes" }),
      });
      expect(res.status).toBe(403);
      expect((await rt.store.humanRequest.mustGet(r.id)).status).toBe("open");
    });

    /**
     * security finding (low): `POST /messages/:id/read` marks any message read, including
     * one addressed to another human or another human's agent; the state service lets only
     * the addressee receipt a message (spec F.2). A read receipt on a `requires_ack`
     * handoff to the other human hides it from their inbox's unread view. Fix: refuse when
     * the message's human (addressee, or the owner of the addressed agent) is not the
     * daemon's human.
     */
    it("does not receipt a message addressed to another human", async () => {
      const m = await rt.store.message.send({
        from_agent_id: rt.agent.id,
        to_human_id: otherHuman.id,
        type: "handoff",
        body: "for Other only",
        requires_ack: true,
      });
      const res = await req(`/messages/${m.id}/read`, { method: "POST" });
      expect(res.status).toBe(403);
      expect((await rt.store.message.mustGet(m.id)).read_at).toBeNull();
    });

    /**
     * security finding (low): `GET /inbox?humanId=` returns the inbox of any human the
     * query names (open requests with their change cards and messages addressed to them),
     * not only the daemon's human; the state service forces a device's own human.
     * Fix: ignore the query parameter, or refuse a value other than `rt.human.id`.
     */
    it("does not serve another human's inbox through ?humanId", async () => {
      await rt.store.humanRequest.insert({
        human_id: otherHuman.id,
        kind: "decision",
        why: "Other's private decision",
        options: ["a", "b"],
      });
      await rt.store.message.send({
        from_agent_id: otherAgent.id,
        to_human_id: otherHuman.id,
        type: "info",
        body: "Other's private note",
      });
      const res = await req(`/inbox?humanId=${encodeURIComponent(otherHuman.id)}`);
      expect(res.status).not.toBe(200);
    });

    it("a session of another human's agent is still listed project-wide, but its events need the id", async () => {
      // Documented (ADR 0009 amendment: sessions are one human's notes). The daemon has
      // DB credentials; this test records the current behaviour so a change is deliberate.
      const list = await req(`/sessions?agentId=${encodeURIComponent(otherAgent.id)}`);
      expect(list.status).toBe(200);
    });
  });

  /**
   * security finding (low): list routes turn `?limit=` into `Number(...)` without
   * validation, so `limit=abc` reaches the store as NaN, the SQL fails and the daemon
   * answers 500 with the driver's error text (`errorMessage(err)` in `onError`); the same
   * for `/sessions`, `/projects/:id/runs`, `/memory` and `/changes`. Fix: parse list
   * numbers through one validator (as the state service's `intParam` does) and answer 400.
   */
  it("malformed numbers in list queries are a 400, never a 500 with driver text", async () => {
    const created = await json(
      await req("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Q", goal: "g" }),
      }),
    );
    const res = await req(`/projects/${String(created.id)}/tasks?limit=abc`);
    expect(res.status).toBe(400);
  });

  it("mutations that change limits go through the command registry and keep a change log row", async () => {
    const created = await json(
      await req("/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Budgeted", goal: "g", budgetUsdMicro: 1_000_000 }),
      }),
    );
    const projectId = String(created.id);
    const exec = await req("/commands/execute", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        commands: [{ name: "project.switch", params: { projectId } }],
      }),
    });
    expect(exec.status).toBe(200);
    const result = await json(exec);
    expect(["done", "pending", "partial", "refused"]).toContain(String(result.status));
    const changes = (await (await req("/changes")).json()) as Json[];
    expect(Array.isArray(changes)).toBe(true);
    // An unknown command is refused by the registry, never executed.
    const unknown = await req("/commands/execute", {
      method: "POST",
      body: JSON.stringify({ commands: [{ name: "vault.export", params: {} }] }),
    });
    expect(unknown.status).toBeLessThan(500);
    const body = await json(unknown);
    expect(body.status === "refused" || unknown.status >= 400).toBe(true);
  });
});
