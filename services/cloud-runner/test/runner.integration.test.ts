import { randomBytes } from "node:crypto";
import { MemoryGitHost } from "@forerunner/capabilities";
import { join, SimulatedClock } from "@forerunner/platform";
import { ENTITIES, openStore, type StateStore } from "@forerunner/state";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { EncryptedFileVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CloudRunner, startCloudRunner } from "../src/runner.ts";
import {
  answerUnlockChallenge,
  UNLOCK_AUDIT_TOOLS,
  type UnlockChallengeCard,
} from "../src/vault-unlock.ts";
import {
  addReadyTask,
  flush,
  type Seed,
  seedWorld,
  tempHome,
  testConfig,
  waitFor,
} from "./helpers.ts";

/**
 * Phase 6 gate, "Cloud runner completes an overnight session while both PCs are off", against
 * a real Postgres (FORERUNNER_TEST_PG). The runner unlocks its encrypted vault blob with a key
 * the human's device releases through the shared state, runs a nightly schedule with no PC
 * daemon registered while the clock advances eight simulated hours, completes two tasks on the
 * fake provider and bills them to the human's own source. A second runner shows that a kill
 * enqueued from a paired phone stops a running cloud session within 2 s.
 */
const PG = process.env.FORERUNNER_TEST_PG;
const REGISTRY = join(process.cwd(), "evals", "registry");
const schema = `fr_runner_${randomBytes(4).toString("hex")}`;
const tables = Object.values(ENTITIES)
  .filter((e) => e.envelope)
  .map((e) => `"${e.table}"`)
  .join(", ");
const SCRYPT = { N: 1024, r: 8, p: 1 };

describe.skipIf(!PG)(
  PG
    ? "cloud runner on Postgres"
    : "cloud runner on Postgres (skipped: FORERUNNER_TEST_PG not set)",
  () => {
    // 00:30 in Zurich: the nightly 02:00 schedule is still ahead on this local day.
    const clock = new SimulatedClock("2026-03-02T23:30:00Z");
    /** The runner opens the shared store by URL only; the schema travels in the URL. */
    const stateUrl = `${PG}${PG?.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    let store: StateStore;
    let seed: Seed;
    let home: string;
    let vaultKey: Buffer;
    let apiSourceId: string;

    beforeAll(async () => {
      store = await openStore({ url: PG as string, schema, clock });
      await store.db.exec(`TRUNCATE ${tables} CASCADE`);
      seed = await seedWorld(store, {
        projectSettings: {
          schedules: [{ kind: "daily", time: "02:00", timezone: "Europe/Zurich" }],
        },
      });
      await store.billingSource.insert({
        human_id: seed.human.id,
        kind: "subscription",
        label: "Claude Max",
        credential_ref: "anthropic_subscription_token",
        limits: {},
        enabled: true,
        priority: 1,
      });
      apiSourceId = (
        await store.billingSource.insert({
          human_id: seed.human.id,
          kind: "api_key",
          label: "Console key",
          credential_ref: "anthropic_api_key",
          limits: {},
          enabled: true,
          priority: 2,
        })
      ).id;
      home = tempHome("fr-runner-pg-");
      // The human's device created the vault blob; the runner holds the file, not the key.
      vaultKey = randomBytes(32);
      const creator = await EncryptedFileVault.open({
        path: join(home, "config", "vault.runner.json"),
        key: vaultKey,
        scrypt: SCRYPT,
      });
      await creator.set("anthropic_api_key", ["api", "key", "value"].join("-")); // not-a-secret
      await creator.set("anthropic_subscription_token", ["sub", "token"].join("-")); // not-a-secret
      creator.lock();
    });

    afterAll(async () => {
      await store.db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await store.close();
    });

    async function boot(opts: {
      provider: FakeProvider;
      env?: NodeJS.ProcessEnv;
      answer?: boolean;
    }): Promise<CloudRunner> {
      const { env, config } = testConfig(home, stateUrl, {
        FORERUNNER_STATE_SCHEMA: schema,
        FORERUNNER_RUNNER_MAIL_AUTHSERV_IDS: "mx.example.test",
        FORERUNNER_RUNNER_UNLOCK: "ask",
        ...(opts.env ?? {}),
      });
      const starting = startCloudRunner({
        config,
        env,
        clock,
        provider: opts.provider,
        gitHost: new MemoryGitHost("alice"),
        registryDir: REGISTRY,
        sandboxDetection: { engine: "none", reason: "test", checkedAt: clock.nowIso() },
      });
      if (opts.answer !== false) {
        // The human's device: find the challenge in the shared state and release the key.
        await flush();
        const row = await waitFor(async () => {
          const rows = await store.humanRequest.open({ humanId: seed.human.id });
          return rows.find((r) => r.kind === "credential");
        });
        const card = row.change_card as unknown as UnlockChallengeCard;
        const reply = answerUnlockChallenge(card, vaultKey, { now: clock.now() });
        await store.humanRequest.answer(row.id, row.version, reply as never, seed.human.id);
        await clock.advance(500);
      }
      return starting;
    }

    it("completes an overnight session with no PC daemon registered, billed to the human's own source", async () => {
      const provider = new FakeProvider({ clock, latency: "none", replies: [], onNoMatch: "echo" });
      await addReadyTask(store, seed.project.id, "Write the readme");
      await addReadyTask(store, seed.project.id, "Add the changelog");
      const runner = await boot({ provider });
      try {
        expect(runner.unlock?.state).toMatchObject({ locked: false });
        expect(runner.billing).toMatchObject({ sourceId: apiSourceId, kind: "api_key" });
        expect(runner.billing.skipped.map((s) => s.code)).toEqual(["cloud_runner"]);
        expect(await store.device.list({ kind: "desktop" })).toHaveLength(0);
        expect(runner.scheduler.list()).toHaveLength(1);

        // 23:30 UTC to 07:30 UTC in half-hour steps; the schedule is due at 01:00 UTC.
        for (let i = 0; i < 16; i++) {
          await clock.advance(30 * 60_000);
          await flush();
        }
        const session = await waitFor(async () => {
          const rows = await store.session.list({ agent_id: seed.agent.id });
          return rows.find((s) => s.status === "completed");
        });
        expect(session).toMatchObject({
          runner: "cloud",
          trigger: "schedule",
          device_id: runner.device.id,
          project_id: seed.project.id,
        });
        // Due at 01:00 UTC; the simulated clock keeps moving while the real database answers.
        const startedAt = Date.parse(session.started_at ?? "");
        expect(startedAt).toBeGreaterThanOrEqual(Date.parse("2026-03-03T01:00:00Z"));
        expect(startedAt).toBeLessThan(Date.parse("2026-03-03T01:30:00Z"));
        expect(Date.parse(session.ended_at ?? "")).toBeLessThanOrEqual(
          Date.parse("2026-03-03T07:30:00Z"),
        );
        const tasks = await store.task.list({ project_id: seed.project.id });
        expect(tasks.map((t) => t.status).sort()).toEqual(["done", "done"]);
        const runs = await store.run.forSession(session.id);
        expect(runs).toHaveLength(2);
        for (const r of runs) {
          expect(r.outcome).toBe("completed");
          expect(r.billing_source_id).toBe(apiSourceId);
        }
        const ledger = await store.costLedger.list({ session_id: session.id });
        expect(ledger).toHaveLength(2);
        for (const e of ledger) {
          expect(e.human_id).toBe(seed.human.id);
          expect(e.billing_source_id).toBe(apiSourceId);
          expect(e.usd_micro).toBeGreaterThan(0);
        }
        expect((await store.costLedger.sum({ humanId: seed.human.id })).usd_micro).toBe(
          ledger.reduce((s, e) => s + e.usd_micro, 0),
        );
        const status = await runner.status();
        expect(status).toMatchObject({
          sessionsStarted: 1,
          schedulesSkipped: 0,
          activeSessions: 0,
        });
        const unlockAudit = await store.auditLog.list({ tool: UNLOCK_AUDIT_TOOLS.granted });
        expect(unlockAudit).toHaveLength(1);
        // The vault key, in any encoding, is nowhere in the shared state.
        for (const enc of [vaultKey.toString("base64"), vaultKey.toString("hex")]) {
          const requests = await store.humanRequest.list({});
          expect(JSON.stringify(requests)).not.toContain(enc);
          const audit = await store.auditLog.list({});
          expect(JSON.stringify(audit)).not.toContain(enc);
        }
      } finally {
        await runner.stop();
      }
    });

    it("a kill enqueued from the human's phone stops a running cloud session within 2 s", async () => {
      await store.db.exec(
        `TRUNCATE "session", "run", "event", "cost_ledger", "remote_command", "task" CASCADE`,
      );
      // A model call that would take two minutes: the session is mid-call when the kill lands.
      const provider = new FakeProvider({
        clock,
        latency: "simulated",
        replies: [textReply("still thinking", { ttftMs: 120_000, times: 10 })],
      });
      await addReadyTask(store, seed.project.id, "Slow task");
      const phone = await store.device.register({
        owner_human_id: seed.human.id,
        name: "phone",
        platform: "android",
        public_key: "pk-phone",
        kind: "phone",
      });
      const runner = await boot({ provider });
      try {
        expect(await runner.startSession({ projectId: seed.project.id, force: true })).toBe(
          "started",
        );
        const running = await waitFor(async () => {
          const rows = await store.session.list({ agent_id: seed.agent.id, status: "running" });
          return rows[0];
        });
        await waitFor(async () => (provider.calls.length > 0 ? true : undefined));
        const killedAt = clock.now();
        const wall0 = Date.now();
        await store.remoteCommand.enqueue({
          device_id: phone.id,
          target: "cloud",
          command: "kill",
          params: { reason: "stop everything" },
        });
        await clock.advance(500);
        const killed = await waitFor(async () => {
          const row = await store.session.mustGet(running.id);
          return row.status === "killed" ? row : undefined;
        }, 2_000);
        expect(Date.now() - wall0).toBeLessThan(2_000);
        expect(clock.now() - killedAt).toBeLessThanOrEqual(2_000);
        expect(killed.ended_at).toBeTruthy();
        const command = (await store.remoteCommand.list({ device_id: phone.id }))[0];
        expect(command).toMatchObject({ status: "done" });
        // The session and its run are both registered with the kill switch.
        const result = (command?.result ?? {}) as { stoppedRuns?: number };
        expect(result.stoppedRuns ?? 0).toBeGreaterThanOrEqual(1);
        expect((await runner.status()).killActive).toBe(true);
        expect((await store.task.list({ project_id: seed.project.id }))[0]?.claimed_by).toBeNull();
      } finally {
        await runner.stop();
      }
    });
  },
);
