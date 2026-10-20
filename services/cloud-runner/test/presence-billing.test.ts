import { BillingRouter, DEFAULT_ROUTING_POLICY, type RoutingPolicy } from "@forerunner/billing";
import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNNER_MODEL_TIER,
  pickRunnerBillingSource,
  runnerRoutingPolicy,
  VaultCredentialProbe,
} from "../src/billing.ts";
import { PcPresence } from "../src/presence.ts";
import { type Seed, seedWorld } from "./helpers.ts";

/**
 * The PC-wins precedence rule (ADR 0033) and the choice of the human's billing source for
 * cloud work (T.13, S.14) through `@forerunner/billing`'s router, both against an in-memory
 * store.
 */
let store: StateStore;
let clock: SimulatedClock;
let seed: Seed;

beforeEach(async () => {
  clock = new SimulatedClock("2026-03-02T22:00:00Z");
  store = await openStore({ url: "sqlite::memory:", clock });
  seed = await seedWorld(store);
});
afterEach(async () => {
  await store.close();
});

describe("PC-wins precedence", () => {
  const presence = () =>
    new PcPresence({
      store,
      clock,
      humanId: seed.human.id,
      agentId: seed.agent.id,
      pcOnlineMs: 3 * 60_000,
    });

  it("no desktop device and no PC session: the cloud runner may run schedules", async () => {
    expect(await presence().check()).toMatchObject({ pcOnline: false, reason: "none" });
  });

  it("a desktop device seen within the window means the PC is online; a stale one does not", async () => {
    const desktop = await store.device.register({
      owner_human_id: seed.human.id,
      name: "J's PC",
      platform: "linux",
      public_key: "pk-desktop",
      kind: "desktop",
    });
    await store.device.seen(desktop.id);
    const p = presence();
    expect(await p.check()).toMatchObject({
      pcOnline: true,
      reason: "desktop_seen",
      deviceId: desktop.id,
    });
    await clock.advance(3 * 60_000 + 1);
    expect(await p.check()).toMatchObject({ pcOnline: false, reason: "none" });
    expect(p.lastVerdict?.pcOnline).toBe(false);
  });

  it("a revoked desktop, another human's desktop and a runner device never count", async () => {
    const other = await store.human.insert({ name: "B", email: "b@example.test" });
    for (const [owner, kind, revoked] of [
      [seed.human.id, "runner", false],
      [other.id, "desktop", false],
      [seed.human.id, "desktop", true],
    ] as const) {
      const d = await store.device.register({
        owner_human_id: owner,
        name: `${kind}-${owner}-${revoked}`,
        platform: "linux",
        public_key: `pk-${kind}-${owner}-${revoked}`,
        kind,
      });
      await store.device.seen(d.id);
      if (revoked) await store.device.revoke(d.id, (await store.device.mustGet(d.id)).version);
    }
    expect(await presence().check()).toMatchObject({ pcOnline: false });
  });

  it("an active session with runner pc means the PC is working, whatever its heartbeat", async () => {
    const s = await store.session.insert({
      agent_id: seed.agent.id,
      project_id: seed.project.id,
      trigger: "schedule",
      runner: "pc",
    });
    await store.session.start(s.id, s.version);
    expect(await presence().check()).toMatchObject({
      pcOnline: true,
      reason: "pc_session",
      sessionId: s.id,
    });
    const cloud = await store.session.insert({
      agent_id: seed.agent.id,
      project_id: seed.project.id,
      trigger: "schedule",
      runner: "cloud",
    });
    await store.session.setStatus(s.id, (await store.session.mustGet(s.id)).version, "completed");
    await store.session.start(cloud.id, cloud.version);
    expect(await presence().check()).toMatchObject({ pcOnline: false });
  });
});

describe("billing source for cloud sessions", () => {
  async function sources() {
    const sub = await store.billingSource.insert({
      human_id: seed.human.id,
      kind: "subscription",
      label: "Claude Max",
      credential_ref: "anthropic_subscription_token",
      limits: {},
      enabled: true,
      priority: 1,
    });
    const api = await store.billingSource.insert({
      human_id: seed.human.id,
      kind: "api_key",
      label: "Console key",
      credential_ref: "anthropic_api_key",
      limits: {},
      enabled: true,
      priority: 2,
    });
    const vault = new MemoryVault();
    await vault.set("anthropic_subscription_token", ["sub", "token", "value"].join("-")); // not-a-secret
    await vault.set("anthropic_api_key", ["api", "key", "value"].join("-")); // not-a-secret
    return { sub, api, probe: new VaultCredentialProbe(vault), vault };
  }

  it("a shared runner never uses the subscription; a personal runner prefers it", async () => {
    const { sub, api, probe } = await sources();
    const shared = await pickRunnerBillingSource({
      store,
      humanId: seed.human.id,
      agentId: seed.agent.id,
      agentOwnerHumanId: seed.agent.owner_human_id,
      personal: false,
      probe,
    });
    expect(shared).toMatchObject({ sourceId: api.id, kind: "api_key" });
    expect(shared.skipped).toEqual([
      expect.objectContaining({ sourceId: sub.id, code: "cloud_runner" }),
    ]);
    const personal = await pickRunnerBillingSource({
      store,
      humanId: seed.human.id,
      agentId: seed.agent.id,
      agentOwnerHumanId: seed.agent.owner_human_id,
      personal: true,
      probe,
    });
    expect(personal).toMatchObject({ sourceId: sub.id, kind: "subscription", skipped: [] });
  });

  it("a source that opted in with limits.personalRunner may be used on a shared runner", async () => {
    const { sub, probe } = await sources();
    await store.billingSource.patch(sub.id, { limits: { personalRunner: true } });
    const choice = await pickRunnerBillingSource({
      store,
      humanId: seed.human.id,
      agentId: seed.agent.id,
      agentOwnerHumanId: seed.agent.owner_human_id,
      personal: false,
      probe,
    });
    expect(choice.sourceId).toBe(sub.id);
  });

  it("skips a source whose credential is not in the runner vault and a disabled one; fails when nothing is left", async () => {
    const { sub, api, vault, probe } = await sources();
    await vault.delete("anthropic_api_key");
    await store.billingSource.patch(sub.id, { enabled: false });
    await expect(
      pickRunnerBillingSource({
        store,
        humanId: seed.human.id,
        agentId: seed.agent.id,
        agentOwnerHumanId: seed.agent.owner_human_id,
        personal: true,
        probe,
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
      details: { skipped: [expect.objectContaining({ sourceId: api.id, code: "unavailable" })] },
    });
  });

  it("refuses to bill a human's source for another human's agent", async () => {
    const { probe } = await sources();
    await expect(
      pickRunnerBillingSource({
        store,
        humanId: seed.human.id,
        agentId: seed.agent.id,
        agentOwnerHumanId: "someone-else",
        personal: true,
        probe,
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("the billing package's router decides: it is asked for cloud session work and its policy wins", async () => {
    const { sub, api, probe } = await sources();
    const pick = vi.spyOn(BillingRouter.prototype, "pick");
    try {
      // The runner's own policy for a personal runner lets the subscription through...
      expect(runnerRoutingPolicy(true)).toMatchObject({ subscriptionOnCloudRunner: "always" });
      expect(runnerRoutingPolicy(false)).toBe(DEFAULT_ROUTING_POLICY);
      // ...and a policy handed to the router overrides it: "never" skips it on a personal runner.
      const never: RoutingPolicy = {
        ...DEFAULT_ROUTING_POLICY,
        subscriptionOnCloudRunner: "never",
      };
      const choice = await pickRunnerBillingSource({
        store,
        humanId: seed.human.id,
        agentId: seed.agent.id,
        agentOwnerHumanId: seed.agent.owner_human_id,
        personal: true,
        probe,
        policy: never,
      });
      expect(choice).toMatchObject({ sourceId: api.id, kind: "api_key" });
      expect(choice.skipped).toEqual([
        expect.objectContaining({ sourceId: sub.id, kind: "subscription", code: "cloud_runner" }),
      ]);
      expect(choice.reason).toContain("session work on the cloud runner");
      expect(choice.reason).toContain("personal runner");
      expect(pick).toHaveBeenCalledTimes(1);
      expect(pick.mock.calls[0]?.[0]).toEqual({
        humanId: seed.human.id,
        agentId: seed.agent.id,
        runner: "cloud",
        purpose: "session",
        modelTier: DEFAULT_RUNNER_MODEL_TIER,
      });
      expect((pick.mock.contexts[0] as BillingRouter).policy).toBe(never);
    } finally {
      pick.mockRestore();
    }
  });

  it("the router's plan-share rule applies: a subscription at its cap falls back to the API key", async () => {
    const { sub, api, probe } = await sources();
    const withUsage = {
      status: async (source: Parameters<typeof probe.status>[0]) => ({
        ...(await probe.status(source)),
        ...(source.kind === "subscription" ? { planUsageShare: 0.95 } : {}),
      }),
    };
    const choice = await pickRunnerBillingSource({
      store,
      humanId: seed.human.id,
      agentId: seed.agent.id,
      agentOwnerHumanId: seed.agent.owner_human_id,
      personal: true,
      probe: withUsage,
    });
    expect(choice).toMatchObject({ sourceId: api.id, kind: "api_key" });
    expect(choice.skipped).toEqual([
      expect.objectContaining({ sourceId: sub.id, code: "plan_share" }),
    ]);
    const below = {
      status: async (source: Parameters<typeof probe.status>[0]) => ({
        ...(await probe.status(source)),
        ...(source.kind === "subscription" ? { planUsageShare: 0.5 } : {}),
      }),
    };
    const fine = await pickRunnerBillingSource({
      store,
      humanId: seed.human.id,
      agentId: seed.agent.id,
      agentOwnerHumanId: seed.agent.owner_human_id,
      personal: true,
      probe: below,
    });
    expect(fine).toMatchObject({ sourceId: sub.id, kind: "subscription", skipped: [] });
    expect(fine.reason).toContain("plan usage 50% below the cap 95%");
  });
});
