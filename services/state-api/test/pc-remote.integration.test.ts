import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { ACTIVE_PROJECT_KEY, SESSION_OVERRIDE_KEY } from "@forerunner/commands";
import { appDirs, join, systemClock } from "@forerunner/platform";
import {
  collectStream,
  composeRuntime,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  type ModelResponse,
  type RuntimeApp,
  type StreamEvent,
} from "@forerunner/runtime";
import { ENTITIES, type JsonObject, openStore, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type StateApiApp } from "../src/app.ts";
import {
  type DeviceKeyPair,
  generateDeviceKeyPair,
  signPairingProof,
  signRequest,
} from "../src/auth/crypto.ts";
import { ADMIN_TOKEN } from "./helpers.ts";

/**
 * Scenario 9 against the real stack (spec, "From the phone, by talking"; ADR 0032): the state
 * service over HTTP on a real Postgres, the PC daemon composed on the same schema and polling
 * the service for `target: "pc"` commands, and a paired phone signing its requests the way the
 * Android client does (ADR 0009). "Switch to the game, give it 15 francs until tomorrow and
 * start a session on my PC" arrives as one plan envelope and ends with a running session on
 * the game project and `done` on the command; an `undoOf` plan stops it; a high-risk plan
 * waits for the phone's biometric answer through the service's inbox route.
 *
 * The Android app itself is not in this repository yet; `PhoneClient` below is the signed
 * device stand-in for its state client, speaking the same routes and envelopes.
 */
const PG = process.env.FORERUNNER_TEST_PG;
const schema = `fr_pc_remote_${randomBytes(4).toString("hex")}`;
const tables = Object.values(ENTITIES)
  .filter((e) => e.envelope)
  .map((e) => `"${e.table}"`)
  .join(", ");
const REGISTRY = join(process.cwd(), "evals", "registry");
const TZ = "Europe/Zurich";
const SCENARIO_WORDS =
  "switch to the game, give it 15 francs until tomorrow and start a session on my PC";

/** A provider that holds every model call until released, so a session stays running. */
class GateProvider implements ModelProvider {
  readonly name = "fake";
  calls = 0;
  private open = false;
  private readonly waiters: (() => void)[] = [];

  release(): void {
    this.open = true;
    for (const w of this.waiters.splice(0)) w();
  }

  async listModels(): Promise<ModelRef[]> {
    return [{ provider: "fake", id: "fake-haiku", tier: "haiku" }];
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    yield { type: "message_start", model: req.model };
    if (!this.open) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        req.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if (req.signal?.aborted) {
      yield { type: "error", code: "aborted", message: "aborted", retryable: false };
      return;
    }
    yield { type: "text_delta", text: "Done." };
    yield {
      type: "message_end",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  }

  complete(req: ModelRequest): Promise<ModelResponse> {
    const t0 = performance.now();
    return collectStream(
      this.stream(req),
      () => t0,
      () => performance.now(),
    );
  }
}

/** The phone's state client: bearer token plus an Ed25519 signature over every mutation. */
class PhoneClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly keys: DeviceKeyPair,
    readonly deviceId: string,
  ) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    opts: { biometric?: boolean } = {},
  ): Promise<Response> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const timestamp = String(Date.now());
    const biometric = opts.biometric ?? false;
    const signature = signRequest(this.keys.secretKey, {
      method,
      path,
      body: text ?? "",
      timestamp,
      biometric,
    });
    return fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "x-device-signature": signature,
        "x-device-timestamp": timestamp,
        ...(biometric ? { "x-biometric-assertion": "1" } : {}),
        ...(text === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(text === undefined ? {} : { body: text }),
    });
  }

  async json<T>(method: string, path: string, body?: unknown, opts?: { biometric?: boolean }) {
    const res = await this.request(method, path, body, opts);
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** `POST /remote/commands` for the PC, as `sendPlan` / `sendChat` on the phone do. */
  send(command: string, params: Record<string, unknown>) {
    return this.json<{ id: string; status: string }>("POST", "/remote/commands", {
      target: "pc",
      command,
      params,
    });
  }

  command(id: string) {
    return this.json<{ id: string; status: string; result: JsonObject | null }>(
      "GET",
      `/remote/commands/${id}`,
    );
  }
}

/** Poll with the wall clock until `fn` returns a value or `ms` passed. */
async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20_000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`waitFor: nothing after ${ms} ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const tomorrow0600 = (): string => {
  // 06:00 Europe/Zurich the next morning, like the phone's intent parser computes it.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(now).split("-").map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(y, m - 1, d + 1, 4, 0, 0));
  return guess.toISOString();
};

describe.skipIf(!PG)(
  PG
    ? "scenario 9: the phone's plan runs on the PC daemon through the real state service"
    : "scenario 9 through the real stack (skipped: FORERUNNER_TEST_PG not set)",
  () => {
    let serviceStore: StateStore;
    let api: StateApiApp;
    let server: ReturnType<typeof serve>;
    let base: string;
    let rt: RuntimeApp;
    let provider: GateProvider;
    let phone: PhoneClient;
    let game: { id: string };
    let pharma: { id: string };

    beforeAll(async () => {
      serviceStore = await openStore({ url: PG as string, schema, clock: systemClock });
      await serviceStore.db.exec(`TRUNCATE ${tables} CASCADE`);
      api = createApp({
        store: serviceStore,
        clock: systemClock,
        startPoller: false,
        config: { adminToken: ADMIN_TOKEN, rateLimitPerMinute: 10_000 },
      });
      server = serve({ fetch: api.app.fetch, hostname: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      // The PC daemon: its store is the same Postgres schema (ADR 0024: runtimes talk to
      // Postgres directly); its remote commands come through the service's routes.
      const home = mkdtempSync(join(tmpdir(), "fr-pc-remote-"));
      provider = new GateProvider();
      rt = await composeRuntime({
        env: { FORERUNNER_HOME: home },
        dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
        config: null,
        clock: systemClock,
        stateUrl: PG as string,
        stateSchema: schema,
        vault: new MemoryVault(),
        provider,
        registryDir: REGISTRY,
        identity: { humanName: "J", timezone: TZ, agentName: "Alice" },
        appVersion: "0.1.0-test",
        stateApi: { url: base, adminToken: ADMIN_TOKEN },
        remotePollMs: 100,
        sandboxWhich: async () => null,
      });
      expect(rt.remote).not.toBeNull();

      pharma = await rt.store.project.insert({ name: "PharmaWatch", autonomy_level: 2 });
      game = await rt.store.project.insert({ name: "Game", autonomy_level: 2 });
      const h = await rt.store.human.mustGet(rt.human.id);
      await rt.store.human.update(h.id, h.version, {
        notify_prefs: { ...h.notify_prefs, [ACTIVE_PROJECT_KEY]: pharma.id },
      });
      await rt.store.task.insert({
        project_id: game.id,
        title: "Polish the main menu",
        outcome: "The menu reads well",
        acceptance_criteria: ["every item has a label"],
        risk_tier: 0,
        status: "ready",
        priority: 5,
        depends_on: [],
        budget_usd_micro: 1_000_000,
        est_cost_usd_micro: 400_000,
        actual_cost_usd_micro: 0,
        attempt: 0,
        reason: "seed",
      });

      // Pair the phone: the desktop starts the pairing (admin), the phone completes it with its
      // own key and gets a scoped token (ADR 0009).
      const start = await fetch(`${base}/pairing/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ humanId: rt.human.id, kind: "phone", name: "Pixel 8" }),
      });
      expect(start.status).toBe(201);
      const { code } = (await start.json()) as { code: string };
      const keys = generateDeviceKeyPair();
      const complete = await fetch(`${base}/pairing/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          publicKey: keys.publicKey,
          proof: signPairingProof(keys.secretKey, code),
          name: "Pixel 8",
          platform: "android",
        }),
      });
      expect(complete.status).toBe(201);
      const paired = (await complete.json()) as { deviceId: string; token: string };
      phone = new PhoneClient(base, paired.token, keys, paired.deviceId);
    }, 120_000);

    afterAll(async () => {
      provider?.release();
      await rt?.close();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      await api?.close();
      await serviceStore?.db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await serviceStore?.close();
    });

    let changeLogId = "";
    let sessionId = "";

    it("the scenario-9 envelope ends with a running session on the game project and done on the command", async () => {
      const until = tomorrow0600();
      const sent = await phone.send("start", {
        v: 1,
        kind: "plan",
        plan: [
          { name: "project.switch", params: { project: "the game" } },
          { name: "budget.set", params: { scope: "session", amountChf: 15, until } },
          { name: "session.start", params: {} },
        ],
        wordsUsed: SCENARIO_WORDS,
        card: { impact: { risk: "low" }, sentence: "what the phone showed" },
        clientId: "pixel-8",
        confirmedAt: new Date().toISOString(),
        source: "voice",
      });
      expect(sent.status).toBe("pending");

      const done = await waitFor(async () => {
        const c = await phone.command(sent.id);
        return c.status === "done" || c.status === "failed" ? c : undefined;
      });
      expect(done.status).toBe("done");
      const result = done.result as JsonObject;
      expect(result).toMatchObject({
        executed: ["project.switch", "budget.set", "session.start"],
        undoOf: null,
        status: "done",
      });
      changeLogId = String(result.changeLogId);
      sessionId = String(result.sessionId);
      expect(sessionId).toMatch(/\S/);

      const session = await rt.store.session.mustGet(sessionId);
      expect(session).toMatchObject({
        agent_id: rt.agent.id,
        project_id: game.id,
        status: "running",
        trigger: "remote",
        device_id: phone.deviceId,
        runner: "pc",
        budget_cap_usd_micro: 18_750_000,
      });
      // The session reaches the model and stays there: the provider holds every call.
      await waitFor(async () => (provider.calls > 0 ? true : undefined));
      expect((await rt.store.session.mustGet(sessionId)).status).toBe("running");

      const human = await rt.store.human.mustGet(rt.human.id);
      expect(human.notify_prefs[ACTIVE_PROJECT_KEY]).toBe(game.id);
      const project = await rt.store.project.mustGet(game.id);
      expect(project.settings[SESSION_OVERRIDE_KEY]).toMatchObject({
        cap_chf_micro: 15_000_000,
        cap_usd_micro: 18_750_000,
        expires_at: until,
      });
      const log = await rt.store.changeLog.mustGet(changeLogId);
      expect(log).toMatchObject({
        words_used: SCENARIO_WORDS,
        source: "voice",
        undo_state: "undoable",
      });

      // The phone sees its session in the service's session list.
      const sessions = await phone.json<{ sessions?: unknown[] } | unknown[]>(
        "GET",
        `/sessions?projectId=${game.id}`,
      );
      const list = Array.isArray(sessions) ? sessions : (sessions.sessions ?? []);
      expect(JSON.stringify(list)).toContain(sessionId);
    }, 60_000);

    it("an undoOf plan stops the session and puts the budget and the active project back", async () => {
      const sent = await phone.send("stop", {
        v: 1,
        kind: "plan",
        plan: [{ name: "session.stop", params: {} }],
        wordsUsed: "undo",
        clientId: "pixel-8",
        confirmedAt: new Date().toISOString(),
        undoOf: changeLogId,
      });
      const done = await waitFor(async () => {
        const c = await phone.command(sent.id);
        return c.status === "done" || c.status === "failed" ? c : undefined;
      });
      expect(done.status).toBe("done");
      expect(done.result).toMatchObject({ executed: ["undo"], undoOf: changeLogId });

      const ended = await waitFor(async () => {
        const s = await rt.store.session.mustGet(sessionId);
        return s.status === "running" || s.status === "paused" ? undefined : s;
      });
      expect(ended.status).toBe("killed");
      expect((await rt.store.changeLog.mustGet(changeLogId)).undo_state).toBe("undone");
      expect((await rt.store.human.mustGet(rt.human.id)).notify_prefs[ACTIVE_PROJECT_KEY]).toBe(
        pharma.id,
      );
      expect(
        (await rt.store.project.mustGet(game.id)).settings[SESSION_OVERRIDE_KEY],
      ).toBeUndefined();
      expect(rt.kill.isFrozen({ agentId: rt.agent.id })).toBe(false);
    }, 60_000);

    it("a high-risk plan waits for the phone's biometric answer through the service and then runs", async () => {
      const sent = await phone.send("start", {
        v: 1,
        kind: "plan",
        plan: [{ name: "budget.set", params: { scope: "month", amountChf: 500 } }],
        wordsUsed: "raise the monthly cap to 500 francs",
        card: { impact: { risk: "low" } },
        clientId: "pixel-8",
        confirmedAt: new Date().toISOString(),
      });
      // Picked up, then waiting: the executor filed a device confirmation in the inbox.
      const request = await waitFor(async () => {
        const inbox = await phone.json<{
          requests: { id: string; kind: string; risk: string; options: unknown[] }[];
        }>("GET", "/inbox");
        return inbox.requests.find((r) => r.kind === "approval" && r.risk === "high");
      });
      expect(request.options).toEqual(["approve on device", "reject"]);
      expect((await phone.command(sent.id)).status).toBe("picked_up");
      // The ceiling compose seeded (CHF 150 at 0.8 CHF/USD) is untouched while the command waits.
      const before = (await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro;
      expect(before).toBe(188_000_000);

      // Without the biometric flag the service refuses the answer outright (spec R.7).
      const plain = await phone.request("POST", `/requests/${request.id}/answer`, {
        version: (await rt.store.humanRequest.mustGet(request.id)).version,
        answer: "approve on device",
      });
      expect(plain.status).toBe(403);
      expect((await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro).toBe(before);

      const row = await rt.store.humanRequest.mustGet(request.id);
      await phone.json(
        "POST",
        `/requests/${request.id}/answer`,
        { version: row.version, answer: "approve on device" },
        { biometric: true },
      );
      const done = await waitFor(async () => {
        const c = await phone.command(sent.id);
        return c.status === "done" || c.status === "failed" ? c : undefined;
      });
      expect(done.status).toBe("done");
      expect(done.result).toMatchObject({ executed: ["budget.set"], confirmedBy: phone.deviceId });
      expect((await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro).toBe(625_000_000);
    }, 60_000);
  },
);
