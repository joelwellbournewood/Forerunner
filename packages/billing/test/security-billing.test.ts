import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { CapChecker } from "../src/caps.ts";
import { BillingRouter, DEFAULT_ROUTING_POLICY } from "../src/router.ts";
import type { LedgerFilter, LedgerQuery } from "../src/sink.ts";
import type { BillingSource, BillingSourceProbe } from "../src/sources.ts";

/**
 * Security review of the billing caps and the router (spec I.1, I.5, S.14): the caps against
 * boundary and malformed inputs, the plan-share stop, and the router's two invariants (never
 * another human's source, never a disabled one) against a misconfigured policy or lister.
 */

function ledger(
  rows: { usd: number; share?: number; filter?: Partial<LedgerFilter> }[],
): LedgerQuery {
  return {
    async sum(filter: LedgerFilter) {
      let usd = 0;
      let share: number | null = null;
      for (const r of rows) {
        const f = r.filter ?? {};
        const matches = Object.entries(f).every(
          ([k, v]) => (filter as Record<string, unknown>)[k] === v,
        );
        if (!matches) continue;
        usd += r.usd;
        if (typeof r.share === "number") share = Math.max(share ?? 0, r.share);
      }
      return { usd_micro: usd, chf_micro: 0, rows: rows.length, plan_usage_share: share };
    },
  } as unknown as LedgerQuery;
}

function checker(rows: Parameters<typeof ledger>[0], caps = {}) {
  return new CapChecker({
    query: ledger(rows),
    clock: new SimulatedClock("2026-10-20T10:00:00Z"),
    caps: { monthUsdMicro: 100_000_000, sessionUsdMicro: 10_000_000, ...caps },
  });
}

describe("caps: malformed and boundary estimates", () => {
  it("NaN, infinity, fractions and negatives never reach a decision; zero is a real call", async () => {
    const c = checker([]);
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      -1,
      2 ** 53,
    ]) {
      await expect(
        c.check({ humanId: "j", sessionId: "s" }, bad, { phase: "work" }),
      ).rejects.toBeInstanceOf(ForerunnerError);
    }
    expect((await c.check({ humanId: "j", sessionId: "s" }, 0, { phase: "work" })).decision).toBe(
      "allow",
    );
  });

  it("one micro-unit over the session cap stops; exactly the 80% mark finishes current; the reserve bites in work only", async () => {
    const c = checker([{ usd: 7_999_999, filter: { sessionId: "s" } }]);
    expect((await c.check({ humanId: "j", sessionId: "s" }, 1, { phase: "work" })).decision).toBe(
      "finish_current",
    );
    expect((await c.check({ humanId: "j", sessionId: "s" }, 1, { phase: "review" })).decision).toBe(
      "finish_current",
    );
    const low = checker([{ usd: 7_999_998, filter: { sessionId: "s" } }]);
    expect((await low.check({ humanId: "j", sessionId: "s" }, 1, { phase: "work" })).decision).toBe(
      "allow",
    );
    const full = checker([{ usd: 9_999_999, filter: { sessionId: "s" } }]);
    expect(
      (await full.check({ humanId: "j", sessionId: "s" }, 1, { phase: "work" })).decision,
    ).toBe("stop");
    expect(
      (await full.check({ humanId: "j", sessionId: "s" }, 1, { phase: "review" })).decision,
    ).toBe("stop");
  });

  it("the plan share stops exactly at the cap and before the first call of the run; a bad share is refused", async () => {
    const c = checker([]);
    const scope = { humanId: "j", sessionId: "s" };
    expect((await c.check(scope, 1, { phase: "work", planUsageShare: 0.95 })).decision).toBe(
      "stop",
    );
    expect((await c.check(scope, 1, { phase: "work", planUsageShare: 1.5 })).decision).toBe("stop");
    expect((await c.check(scope, 1, { phase: "work", planUsageShare: 0.76 })).decision).toBe(
      "finish_current",
    );
    expect((await c.check(scope, 1, { phase: "work", planUsageShare: 0.75 })).decision).toBe(
      "allow",
    );
    // A per-source cap lower than the policy's is honoured through `caps.planShareCap`.
    const tight = checker([], { planShareCap: 0.5 });
    expect((await tight.check(scope, 1, { phase: "work", planUsageShare: 0.5 })).decision).toBe(
      "stop",
    );
    for (const bad of [Number.NaN, -0.1, Number.POSITIVE_INFINITY]) {
      await expect(
        c.check(scope, 1, { phase: "work", planUsageShare: bad }),
      ).rejects.toBeInstanceOf(ForerunnerError);
    }
    // The plan level is a subscription thing: an API source's share is ignored.
    expect(
      (await c.check(scope, 1, { phase: "work", planUsageShare: 1, sourceKind: "api_key" }))
        .decision,
    ).toBe("allow");
  });

  it("caps cannot be configured to zero, negative, fractional or with a reserve outside 15-25%", () => {
    const base = { monthUsdMicro: 1, sessionUsdMicro: 1 };
    for (const caps of [
      { ...base, monthUsdMicro: 0 },
      { ...base, sessionUsdMicro: -1 },
      { ...base, taskUsdMicro: 0.5 },
      { ...base, reserveShare: 0.1 },
      { ...base, reserveShare: 0.3 },
      { ...base, planShareCap: 0 },
      { ...base, planShareCap: 1.01 },
    ]) {
      expect(() => checker([], caps)).toThrow(ForerunnerError);
    }
  });
});

describe("router: invariants no policy can switch off", () => {
  const probe: BillingSourceProbe = {
    async status(s) {
      return {
        available: true,
        checkedAt: "t",
        planUsageShare: s.kind === "subscription" ? 0.1 : undefined,
      };
    },
  };
  const source = (over: Partial<BillingSource>): BillingSource => ({
    id: "s",
    kind: "subscription",
    humanId: "j",
    label: "sub",
    credentialRef: "anthropic_subscription_token",
    enabled: true,
    priority: 1,
    limits: {},
    ...over,
  });

  it("another human's subscription is never picked, even as the only source, even with subscriptionOnCloudRunner 'always' and a lister that returns it", async () => {
    const theirs = source({ id: "theirs", humanId: "k", limits: { personalRunner: true } });
    const router = new BillingRouter({
      probe,
      // A lister keyed by human that ignores the key (misconfiguration): still refused.
      sources: () => [theirs],
      policy: { ...DEFAULT_ROUTING_POLICY, subscriptionOnCloudRunner: "always" },
    });
    for (const runner of ["pc", "cloud"] as const) {
      const e = await router
        .pick({ humanId: "j", agentId: "alice", runner, purpose: "session", modelTier: "sonnet" })
        .catch((x) => x);
      expect(e).toBeInstanceOf(ForerunnerError);
      expect((e as ForerunnerError).code).toBe("unavailable");
      const skipped = (e as ForerunnerError).details.skipped as {
        sourceId: string;
        code: string;
      }[];
      expect(skipped).toEqual([
        {
          sourceId: "theirs",
          kind: "subscription",
          code: "other_human",
          reason: "belongs to another human",
        },
      ]);
      expect(JSON.stringify(e)).not.toContain("anthropic_subscription_token");
    }
  });

  it("a disabled source is skipped without being probed; a subscription on a shared cloud runner is skipped; the API key serves instead", async () => {
    let probed = 0;
    const counting: BillingSourceProbe = {
      async status(s) {
        probed++;
        return probe.status(s);
      },
    };
    const router = new BillingRouter({
      probe: counting,
      sources: [
        source({ id: "off", enabled: false }),
        source({ id: "sub" }),
        source({ id: "key", kind: "api_key", credentialRef: "anthropic_api_key", priority: 2 }),
      ],
    });
    const cloud = await router.pick({
      humanId: "j",
      agentId: "alice",
      runner: "cloud",
      purpose: "session",
      modelTier: "sonnet",
    });
    expect(cloud.source.id).toBe("key");
    expect(cloud.skipped.map((s) => `${s.sourceId}:${s.code}`)).toEqual([
      "off:disabled",
      "sub:cloud_runner",
    ]);
    expect(probed).toBe(1);
    const pc = await router.pick({
      humanId: "j",
      agentId: "alice",
      runner: "pc",
      purpose: "session",
      modelTier: "sonnet",
    });
    expect(pc.source.id).toBe("sub");
  });

  it("the plan share cap is enforced by the router before the call, at the boundary, per source", async () => {
    const at = { status: async () => ({ available: true, checkedAt: "t", planUsageShare: 0.95 }) };
    const router = new BillingRouter({
      probe: at,
      sources: [
        source({ id: "sub" }),
        source({ id: "key", kind: "api_key", credentialRef: "anthropic_api_key", priority: 2 }),
      ],
    });
    const d = await router.pick({
      humanId: "j",
      agentId: "alice",
      runner: "pc",
      purpose: "session",
      modelTier: "sonnet",
    });
    expect(d.source.id).toBe("key");
    expect(d.skipped[0]?.code).toBe("plan_share");
    const loose = new BillingRouter({
      probe: at,
      sources: [source({ id: "sub", limits: { planShareCap: 0.96 } })],
    });
    expect(
      (
        await loose.pick({
          humanId: "j",
          agentId: "alice",
          runner: "pc",
          purpose: "session",
          modelTier: "sonnet",
        })
      ).source.id,
    ).toBe("sub");
  });
});
