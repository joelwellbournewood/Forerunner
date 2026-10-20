import { ForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  BillingRouter,
  DEFAULT_ROUTING_POLICY,
  type RouteContext,
  type RoutingPolicy,
} from "../src/router.ts";
import { type BillingSource, FakeProbe, makeBillingSource } from "../src/sources.ts";

const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  humanId: "alice",
  agentId: "agent-alice",
  runner: "pc",
  purpose: "session",
  modelTier: "sonnet",
  ...over,
});

const aliceSub = makeBillingSource({
  id: "alice-sub",
  kind: "subscription",
  humanId: "alice",
  priority: 10,
  credentialRef: "claude_oauth_alice",
});
const aliceApi = makeBillingSource({ id: "alice-api", kind: "api_key", humanId: "alice" });
const aliceCredits = makeBillingSource({
  id: "alice-credits",
  kind: "plan_credits",
  humanId: "alice",
});
const bobSub = makeBillingSource({ id: "bob-sub", kind: "subscription", humanId: "bob" });
const bobApi = makeBillingSource({ id: "bob-api", kind: "api_key", humanId: "bob" });

function router(
  sources: BillingSource[],
  probe = new FakeProbe({ "alice-sub": { available: true, planUsageShare: 0.5 } }),
  policy?: RoutingPolicy,
) {
  return new BillingRouter({ probe, sources, ...(policy ? { policy } : {}) });
}

describe("BillingRouter", () => {
  it("prefers the subscription while plan usage is below the cap", async () => {
    const d = await router([aliceApi, aliceSub]).pick(ctx());
    expect(d.source.id).toBe("alice-sub");
    expect(d.reason).toContain("plan usage 50% below the cap 95%");
    expect(d.skipped).toEqual([]);
  });

  it("never uses a subscription for another human's agent", async () => {
    const r = router([aliceSub, bobApi]);
    const bob = await r.pick(ctx({ humanId: "bob", agentId: "agent-bob" }));
    expect(bob.source.id).toBe("bob-api");
    expect(bob.skipped).toEqual([
      {
        sourceId: "alice-sub",
        kind: "subscription",
        code: "other_human",
        reason: "belongs to another human",
      },
    ]);

    const only = router([aliceSub]);
    await expect(only.pick(ctx({ humanId: "bob", agentId: "agent-bob" }))).rejects.toMatchObject({
      code: "unavailable",
    });
    // even with no source of his own and alice's subscription wide open
    const probe = new FakeProbe({ "alice-sub": { available: true, planUsageShare: 0 } });
    await expect(
      router([aliceSub, bobSub], probe).pick(ctx({ humanId: "carol", agentId: "c" })),
    ).rejects.toThrow(/no billing source available/);
    expect(probe.calls).toEqual([]);
  });

  it("falls back to the API key once the plan share reaches the cap", async () => {
    const at = await router(
      [aliceSub, aliceApi],
      new FakeProbe({ "alice-sub": { available: true, planUsageShare: 0.95 } }),
    ).pick(ctx());
    expect(at.source.id).toBe("alice-api");
    expect(at.skipped[0]).toMatchObject({ sourceId: "alice-sub", code: "plan_share" });
    expect(at.reason).toContain("plan usage 95% is at or above the cap 95%");

    const below = await router(
      [aliceSub, aliceApi],
      new FakeProbe({ "alice-sub": { available: true, planUsageShare: 0.949 } }),
    ).pick(ctx());
    expect(below.source.id).toBe("alice-sub");
  });

  it("honours a per-source plan share cap", async () => {
    const strict = { ...aliceSub, limits: { planShareCap: 0.5 } };
    const d = await router(
      [strict, aliceApi],
      new FakeProbe({ "alice-sub": { available: true, planUsageShare: 0.6 } }),
    ).pick(ctx());
    expect(d.source.id).toBe("alice-api");
    expect(d.skipped[0]?.reason).toContain("cap 50%");
  });

  it("does not use a subscription on the cloud runner unless it is the owner's personal runner", async () => {
    const shared = await router([aliceSub, aliceApi]).pick(ctx({ runner: "cloud" }));
    expect(shared.source.id).toBe("alice-api");
    expect(shared.skipped[0]).toMatchObject({ code: "cloud_runner" });

    const personal = { ...aliceSub, limits: { personalRunner: true } };
    const own = await router([personal, aliceApi]).pick(ctx({ runner: "cloud" }));
    expect(own.source.id).toBe("alice-sub");

    const never: RoutingPolicy = { ...DEFAULT_ROUTING_POLICY, subscriptionOnCloudRunner: "never" };
    expect(
      (await router([personal, aliceApi], undefined, never).pick(ctx({ runner: "cloud" }))).source
        .id,
    ).toBe("alice-api");
    const always: RoutingPolicy = {
      ...DEFAULT_ROUTING_POLICY,
      subscriptionOnCloudRunner: "always",
    };
    expect(
      (await router([aliceSub, aliceApi], undefined, always).pick(ctx({ runner: "cloud" }))).source
        .id,
    ).toBe("alice-sub");
  });

  it("prefers the API key for batch work and plan credits before pay-per-token otherwise", async () => {
    const batch = await router([aliceSub, aliceApi, aliceCredits]).pick(ctx({ purpose: "batch" }));
    expect(batch.source.id).toBe("alice-api");
    const session = await router([aliceApi, aliceCredits]).pick(ctx());
    expect(session.source.id).toBe("alice-credits");
    const chat = await router([aliceSub, aliceApi, aliceCredits]).pick(ctx({ purpose: "chat" }));
    expect(chat.source.id).toBe("alice-sub");
  });

  it("skips disabled sources without probing them", async () => {
    const probe = new FakeProbe({ "alice-sub": { available: true, planUsageShare: 0.99 } });
    const disabled = { ...aliceApi, enabled: false };
    await expect(router([aliceSub, disabled], probe).pick(ctx())).rejects.toMatchObject({
      code: "unavailable",
      details: {
        skipped: [
          { sourceId: "alice-sub", code: "plan_share" },
          { sourceId: "alice-api", code: "disabled" },
        ],
      },
    });
    expect(probe.calls).toEqual(["alice-sub"]);
  });

  it("skips sources the probe reports unavailable, keeping the reason", async () => {
    const probe = new FakeProbe({ "alice-sub": { available: false, reason: "token expired" } });
    const d = await router([aliceSub, aliceApi], probe).pick(ctx());
    expect(d.source.id).toBe("alice-api");
    expect(d.skipped[0]).toMatchObject({ code: "unavailable", reason: "token expired" });
  });

  it("explains itself when nothing is available and never leaks credential names", async () => {
    const probe = new FakeProbe({
      "alice-sub": { available: false, reason: "token expired" },
      "alice-api": { available: false, reason: "key revoked" },
    });
    let err: ForerunnerError | undefined;
    try {
      await router([aliceSub, aliceApi, bobSub], probe).pick(ctx());
    } catch (e) {
      err = e as ForerunnerError;
    }
    expect(err).toBeInstanceOf(ForerunnerError);
    expect(err?.code).toBe("unavailable");
    const skipped = err?.details.skipped as { sourceId: string; code: string; reason: string }[];
    expect(skipped.map((s) => s.code).sort()).toEqual([
      "other_human",
      "unavailable",
      "unavailable",
    ]);
    expect(JSON.stringify(err?.toJSON())).not.toContain("claude_oauth_alice");
  });

  it("breaks ties by priority, then by id", async () => {
    const a = makeBillingSource({ id: "key-b", kind: "api_key", humanId: "alice", priority: 5 });
    const b = makeBillingSource({ id: "key-a", kind: "api_key", humanId: "alice", priority: 1 });
    const c = makeBillingSource({ id: "key-c", kind: "api_key", humanId: "alice", priority: 1 });
    expect((await router([a, b, c]).pick(ctx())).source.id).toBe("key-a");
    expect((await router([a, c]).pick(ctx())).source.id).toBe("key-c");
  });

  it("skips an API-style source whose monthly limit is reached", async () => {
    const limited = { ...aliceApi, limits: { monthlyUsdMicro: 1_000_000 } };
    const probe = new FakeProbe({
      "alice-api": { available: true, monthSpentUsdMicro: 1_000_000 },
    });
    const d = await router([limited, aliceCredits], probe).pick(ctx({ purpose: "batch" }));
    expect(d.source.id).toBe("alice-credits");
    expect(d.skipped[0]).toMatchObject({ code: "monthly_limit" });
  });

  it("treats the policy as data: purpose and tier rules change without code", async () => {
    const apiOnly: RoutingPolicy = {
      ...DEFAULT_ROUTING_POLICY,
      preference: { ...DEFAULT_ROUTING_POLICY.preference, session: ["api_key"] },
      kindsForTier: { fable: ["api_key", "plan_credits"] },
    };
    const d = await router([aliceSub, aliceApi], undefined, apiOnly).pick(ctx());
    expect(d.source.id).toBe("alice-api");
    expect(d.skipped[0]).toMatchObject({ sourceId: "alice-sub", code: "purpose" });

    const top = await router([aliceSub, aliceApi], undefined, apiOnly).pick(
      ctx({ purpose: "chat", modelTier: "fable" }),
    );
    expect(top.source.id).toBe("alice-api");
    expect(top.skipped[0]).toMatchObject({ code: "tier" });
  });

  it("accepts a source lister keyed by human", async () => {
    const seen: string[] = [];
    const r = new BillingRouter({
      probe: new FakeProbe(),
      sources: (humanId) => {
        seen.push(humanId);
        return humanId === "bob" ? [bobApi] : [];
      },
    });
    expect((await r.pick(ctx({ humanId: "bob", agentId: "b" }))).source.id).toBe("bob-api");
    await expect(r.pick(ctx())).rejects.toMatchObject({ code: "unavailable" });
    expect(seen).toEqual(["bob", "alice"]);
  });
});
