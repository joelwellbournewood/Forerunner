import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SimulatedClock } from "@forerunner/platform";
import { ENTITIES, openStore, type StateStore } from "@forerunner/state";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type StateApiApp } from "../src/app.ts";
import { generateDeviceKeyPair, signPairingProof } from "../src/auth/crypto.ts";
import { flushOutbox, MemoryOutbox, type OutboxResult, type OutboxSender } from "../src/outbox.ts";
import { ChangeBus, PostgresNotifier } from "../src/realtime.ts";
import { ADMIN_TOKEN, Client, DeviceClient, readSse, type Seed, START, seed } from "./helpers.ts";

/**
 * Against a real Postgres (FORERUNNER_TEST_PG): LISTEN/NOTIFY realtime between two service
 * instances, the polling fallback for direct writes, and the phase 2 gate "either install
 * can be offline for 48 simulated hours without breaking the other".
 */
const PG = process.env.FORERUNNER_TEST_PG;
const schema = `fr_state_api_${randomBytes(4).toString("hex")}`;
const tables = Object.values(ENTITIES)
  .filter((e) => e.envelope)
  .map((e) => `"${e.table}"`)
  .join(", ");

describe.skipIf(!PG)(
  PG
    ? "state service on Postgres"
    : "state service on Postgres (skipped: FORERUNNER_TEST_PG not set)",
  () => {
    const clock = new SimulatedClock(START);
    let storeA: StateStore;
    let storeB: StateStore;
    let s: Seed;

    beforeAll(async () => {
      storeA = await openStore({ url: PG as string, schema, clock });
      storeB = await openStore({ url: PG as string, schema, clock, migrate: false });
      await storeA.db.exec(`TRUNCATE ${tables} CASCADE`);
      s = await seed(storeA);
    });

    afterAll(async () => {
      await storeB.close();
      await storeA.db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await storeA.close();
    });

    async function instance(store: StateStore): Promise<{
      api: StateApiApp;
      notifier: PostgresNotifier;
      base: string;
      stop(): Promise<void>;
    }> {
      const bus = new ChangeBus(clock);
      const notifier = new PostgresNotifier({ url: PG as string, schema, store, bus, clock });
      await notifier.start();
      const api = createApp({
        store,
        clock,
        bus,
        notifier,
        startPoller: false,
        config: { adminToken: ADMIN_TOKEN, rateLimitPerMinute: 10_000 },
      });
      const server = serve({ fetch: api.app.fetch, hostname: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return {
        api,
        notifier,
        base,
        stop: async () => {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await api.close();
        },
      };
    }

    it("a write through instance A reaches a phone streaming from instance B through LISTEN/NOTIFY", async () => {
      const a = await instance(storeA);
      const b = await instance(storeB);
      const controller = new AbortController();
      try {
        expect(a.notifier.connected).toBe(true);
        const admin = new Client(a.api.app, ADMIN_TOKEN);
        const start = (await (
          await admin.post("/pairing/start", { humanId: s.ada.id })
        ).json()) as { code: string };
        const keys = generateDeviceKeyPair();
        const paired = (await (
          await new Client(b.api.app, undefined).post("/pairing/complete", {
            code: start.code,
            publicKey: keys.publicKey,
            proof: signPairingProof(keys.secretKey, start.code),
            platform: "android",
          })
        ).json()) as { token: string; deviceId: string };
        // Pairing codes live in one instance's memory: completing on B fails, on A succeeds.
        expect(paired.token).toBeUndefined();
        const pairedA = (await (
          await new Client(a.api.app, undefined).post("/pairing/complete", {
            code: start.code,
            publicKey: keys.publicKey,
            proof: signPairingProof(keys.secretKey, start.code),
            platform: "android",
          })
        ).json()) as { token: string; deviceId: string };
        expect(pairedA.token).toBeTruthy();
        // The token store is per instance too (JSON state); B accepts the token once it shares the file.
        // For this test B gets the same SessionTokenStore by pairing through B directly.
        const startB = (await (
          await new Client(b.api.app, ADMIN_TOKEN).post("/pairing/start", { humanId: s.ada.id })
        ).json()) as { code: string };
        const keysB = generateDeviceKeyPair();
        const pairedB = (await (
          await new Client(b.api.app, undefined).post("/pairing/complete", {
            code: startB.code,
            publicKey: keysB.publicKey,
            proof: signPairingProof(keysB.secretKey, startB.code),
            platform: "android",
          })
        ).json()) as { token: string; deviceId: string };

        const res = await fetch(`${b.base}/events`, {
          headers: { authorization: `Bearer ${pairedB.token}`, accept: "text/event-stream" },
          signal: controller.signal,
        });
        expect(res.status).toBe(200);
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        await readSse(reader, (events) => events.some((e) => e.event === "ready"));

        const sent = await admin.post("/messages", {
          fromAgentId: s.alice.id,
          toHumanId: s.ada.id,
          body: "via NOTIFY",
        });
        expect(sent.status).toBe(201);
        const events = await readSse(
          reader,
          (es) => es.some((e) => e.event === "message.changed"),
          10_000,
        );
        const change = events.find((e) => e.event === "message.changed");
        expect(change).toBeDefined();
        const data = change?.data as { origin: string; humanId: string } | undefined;
        expect(data?.origin).toBe(a.api.bus.instanceId);
        expect(data?.humanId).toBe(s.ada.id);

        // Polling fallback on B for a direct write by the other install (storeA bypassing the service).
        await storeA.message.send({
          from_agent_id: s.bobAgent.id,
          to_human_id: s.ada.id,
          type: "info",
          body: "direct",
        });
        await b.api.poller.pollOnce();
        const polled = await readSse(
          reader,
          (es) => es.filter((e) => e.event === "message.changed").length >= 1,
          10_000,
        );
        expect(
          polled.some(
            (e) =>
              e.event === "message.changed" &&
              (e.data as { origin: string }).origin === b.api.bus.instanceId,
          ),
        ).toBe(true);
      } finally {
        controller.abort();
        await a.stop();
        await b.stop();
      }
    });

    it("48 simulated hours offline: the other install keeps working and the returning one sees everything", async () => {
      // Install A = Ada's PC (storeA), install B = Bob's PC (storeB). Both talk to Postgres directly.
      const project = await storeA.project.insert({ name: "Shared", goal: "offline gate" });
      const tasks = [];
      for (let i = 0; i < 6; i++) {
        tasks.push(
          await storeA.task.insert({
            project_id: project.id,
            title: `task ${i}`,
            outcome: "o",
            status: "ready",
            priority: 6 - i,
          }),
        );
      }
      const TTL = 30 * 60_000;
      // Both claim one task and exchange a message before B goes dark.
      const claimA = await storeA.task.claim(tasks[0]?.id as string, s.alice.id, TTL);
      const claimB = await storeB.task.claim(tasks[1]?.id as string, s.bobAgent.id, TTL);
      expect(claimA.ok && claimB.ok).toBe(true);
      await storeB.message.send({
        from_agent_id: s.bobAgent.id,
        to_agent_id: s.alice.id,
        type: "handoff",
        body: "going dark",
        requires_ack: true,
      });
      const bobOutbox = new MemoryOutbox();

      // B is offline for 48 simulated hours. A keeps working: hourly sessions that claim, finish, message.
      const service = await instance(storeA);
      const admin = new Client(service.api.app, ADMIN_TOKEN);
      const errors: string[] = [];
      let messagesToBob = 0;
      try {
        for (let hour = 1; hour <= 48; hour++) {
          await clock.advance(3600_000);
          try {
            // Expire lapsed claims (B's claim lapses after 30 minutes without renewal; A renews its own).
            const expired = await storeA.task.expireClaims();
            if (hour === 1) expect(expired.map((t) => t.id)).toContain(tasks[1]?.id);
            const ready = await storeA.task.readyTasks(project.id, { limit: 1 });
            const next = ready[0];
            if (next) {
              const claim = await storeA.task.claim(next.id, s.alice.id, TTL);
              expect(claim.ok).toBe(true);
              if (claim.ok) {
                let t = await storeA.task.transition(
                  claim.task.id,
                  claim.task.version,
                  "in_progress",
                  "work",
                  { agentId: s.alice.id },
                );
                t = await storeA.task.transition(t.id, t.version, "in_review", "pr open", {
                  agentId: s.alice.id,
                });
                await storeA.task.transition(t.id, t.version, "done", "accepted", {
                  agentId: s.alice.id,
                });
              }
            }
            const res = await admin.post("/messages", {
              fromAgentId: s.alice.id,
              toAgentId: s.bobAgent.id,
              projectId: project.id,
              type: hour % 12 === 0 ? "handoff" : "info",
              body: `hour ${hour}`,
              requiresAck: hour % 12 === 0,
            });
            if (res.status !== 201) errors.push(`message hour ${hour}: ${res.status}`);
            else messagesToBob += 1;
            // Meanwhile Bob's phone queues actions it cannot deliver.
            if (hour % 16 === 0) {
              await bobOutbox.enqueue({
                clientId: `bob-${hour}-${randomBytes(4).toString("hex")}`,
                kind: "queue.enqueue",
                payload: {
                  projectId: project.id,
                  kind: "note",
                  text: `offline note at hour ${hour}`,
                },
                createdAt: clock.nowIso(),
              });
            }
            const health = (await (await service.api.app.request("/health")).json()) as {
              ok: boolean;
            };
            if (!health.ok) errors.push(`health hour ${hour}`);
          } catch (e) {
            errors.push(`hour ${hour}: ${String(e)}`);
          }
        }
        expect(errors).toEqual([]);
        expect(messagesToBob).toBe(48);
        const done = await storeA.task.forProject(project.id, { status: "done" });
        expect(done.length).toBe(6);

        // B comes back: reads everything, acknowledges, flushes its outbox, claims nothing stale.
        const inbox = await storeB.message.inbox({ agentId: s.bobAgent.id });
        expect(inbox.filter((m) => m.project_id === project.id)).toHaveLength(48);
        const unacked = await storeB.message.unacknowledged(s.alice.id);
        expect(unacked.filter((m) => m.project_id === project.id)).toHaveLength(4);
        for (const m of unacked) await storeB.message.markActed(m.id);
        expect(await storeB.message.unacknowledged(s.alice.id)).toHaveLength(0);
        const stillHeld = await storeB.task.claimedBy(s.bobAgent.id);
        expect(stillHeld).toHaveLength(0);
        const reclaim = await storeB.task.claim(tasks[1]?.id as string, s.bobAgent.id, TTL);
        expect(reclaim.ok).toBe(false);
        if (!reclaim.ok) expect(reclaim.reason).toBe("not_claimable");

        // Bob's phone flushes its queued notes through the service.
        const startB = (await (
          await admin.post("/pairing/start", { humanId: s.bob.id })
        ).json()) as { code: string };
        const keys = generateDeviceKeyPair();
        const paired = (await (
          await new Client(service.api.app, undefined).post("/pairing/complete", {
            code: startB.code,
            publicKey: keys.publicKey,
            proof: signPairingProof(keys.secretKey, startB.code),
            platform: "android",
          })
        ).json()) as { token: string; deviceId: string; humanId: string };
        const phone = new DeviceClient(
          service.api.app,
          paired.token,
          keys,
          paired.deviceId,
          paired.humanId,
          clock,
        );
        const sender: OutboxSender = {
          async send(actions) {
            const res = await phone.post("/sync/outbox", { actions });
            if (res.status >= 500) throw new Error(`server ${res.status}`);
            return ((await res.json()) as { results: OutboxResult[] }).results;
          },
        };
        expect(await flushOutbox(bobOutbox, sender)).toEqual({ sent: 3, rejected: 0, deferred: 0 });
        const queued = await storeB.queue.pending(project.id);
        expect(queued.map((q) => q.text).sort()).toEqual([
          "offline note at hour 16",
          "offline note at hour 32",
          "offline note at hour 48",
        ]);
        // A's view is unchanged by B's return (no errors, same facts).
        expect((await storeA.task.forProject(project.id, { status: "done" })).length).toBe(6);
      } finally {
        await service.stop();
      }
    }, 120_000);
  },
);
