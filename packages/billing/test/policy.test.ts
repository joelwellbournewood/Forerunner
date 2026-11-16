import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_POLICIES,
  CREDENTIAL_POLICY_SETTING,
  credentialPolicyOf,
  grantOf,
  moneyRank,
  nextMonthStartIso,
  ruleOf,
  stopKeyOf,
  stopOf,
} from "../src/policy.ts";
import type { BillingSourceLimits, BillingSourceStatus } from "../src/sources.ts";

// d1109-cred-engine CE-1 (ADR 0120): one credential policy for every call, read at every pick.
describe("d1109-cred-engine, run C: credentialPolicyOf", () => {
  const orders: (string[] | undefined)[] = [
    undefined,
    ["subscription"],
    ["subscription", "api_key"],
    ["api_key", "subscription"],
    ["plan_credits"],
  ];
  const mids: (string | undefined)[] = [undefined, "wait", "use_other"];
  const expected: Record<string, [string, string][]> = {
    // order -> [mid unset, wait, use_other] as [id, chosen]
    unset: [
      ["subscription_then_wait", "default"],
      ["subscription_then_wait", "default"],
      ["subscription_then_key", "default"],
    ],
    subscription: [
      ["subscription_then_wait", "derived"],
      ["subscription_then_wait", "derived"],
      ["subscription_then_key", "derived"],
    ],
    "subscription,api_key": [
      ["subscription_then_wait", "derived"],
      ["subscription_then_wait", "derived"],
      ["subscription_then_key", "derived"],
    ],
    "api_key,subscription": [
      ["earlier", "derived"],
      ["earlier", "derived"],
      ["key_then_subscription", "derived"],
    ],
    plan_credits: [
      ["earlier", "derived"],
      ["earlier", "derived"],
      ["key_then_subscription", "derived"],
    ],
  };
  for (const order of orders)
    mids.forEach((mid, i) => {
      const key = order ? order.join(",") : "unset";
      it(`billing_order ${key} x mid_session_limit ${mid ?? "unset"}`, () => {
        const prefs: Record<string, unknown> = {};
        if (order) prefs.billing_order = order;
        if (mid) prefs.mid_session_limit = mid;
        const p = credentialPolicyOf(prefs);
        const [id, chosen] = expected[key]?.[i] ?? ["", ""];
        expect([p.id, p.chosen]).toEqual([id, chosen]);
      });
    });

  it("an earlier API-key-first choice keeps its order, waits, and lets every kind serve", () => {
    const p = credentialPolicyOf({ billing_order: ["api_key", "subscription"] });
    expect(p.rule).toEqual({
      order: ["api_key", "subscription", "plan_credits"],
      whenStopped: "wait",
      kinds: ["subscription", "api_key", "plan_credits"],
    });
    const credits = credentialPolicyOf({ billing_order: ["plan_credits"] });
    expect(credits.rule.order).toEqual(["plan_credits", "subscription", "api_key"]);
  });

  it("a stored preset wins over both older settings; a malformed one reads as the derived state", () => {
    expect(
      credentialPolicyOf({
        [CREDENTIAL_POLICY_SETTING]: "key_only",
        billing_order: ["subscription"],
        mid_session_limit: "use_other",
      }),
    ).toMatchObject({ id: "key_only", chosen: "stored" });
    expect(
      credentialPolicyOf({
        [CREDENTIAL_POLICY_SETTING]: "always_key",
        mid_session_limit: "use_other",
      }),
    ).toMatchObject({ id: "subscription_then_key", chosen: "default" });
    expect(credentialPolicyOf(null)).toMatchObject({
      id: "subscription_then_wait",
      chosen: "default",
    });
  });
});

describe("d1109-cred-engine, run C: ruleOf, moneyRank", () => {
  it("each preset's order, rule at a stop and kinds", () => {
    expect(CREDENTIAL_POLICIES.map((id) => [id, ruleOf(id)])).toEqual([
      [
        "subscription_then_wait",
        {
          order: ["subscription", "plan_credits", "api_key"],
          whenStopped: "wait",
          kinds: ["subscription", "plan_credits", "api_key"],
        },
      ],
      [
        "subscription_then_ask",
        {
          order: ["subscription", "plan_credits", "api_key"],
          whenStopped: "ask",
          kinds: ["subscription", "plan_credits", "api_key"],
        },
      ],
      [
        "subscription_then_key",
        {
          order: ["subscription", "plan_credits", "api_key"],
          whenStopped: "next",
          kinds: ["subscription", "plan_credits", "api_key"],
        },
      ],
      [
        "key_then_subscription",
        {
          order: ["api_key", "plan_credits", "subscription"],
          whenStopped: "next",
          kinds: ["api_key", "plan_credits", "subscription"],
        },
      ],
      [
        "key_only",
        {
          order: ["api_key", "plan_credits"],
          whenStopped: "wait",
          kinds: ["api_key", "plan_credits"],
        },
      ],
    ]);
  });

  it("money ranks: a lower rank moves less money without the person", () => {
    expect(CREDENTIAL_POLICIES.map(moneyRank)).toEqual([0, 1, 2, 3, 3]);
    expect(moneyRank("earlier")).toBe(3);
  });
});

describe("d1109-cred-engine, run C: stopKeyOf", () => {
  const now = Date.parse("2026-11-16T14:00:00Z");
  const sub = (limits: BillingSourceLimits = {}) => ({
    kind: "subscription" as const,
    limits: { planUsdMicro: 100_000_000, ...limits },
  });
  const key = (limits: BillingSourceLimits = {}) => ({ kind: "api_key" as const, limits });
  const ok: BillingSourceStatus = { available: true };

  it("is null while the source is not stopped", () => {
    expect(stopKeyOf(sub(), { ...ok, planUsageShare: 0.5 }, now, 0.95)).toBeNull();
    expect(
      stopKeyOf(key({ monthlyUsdMicro: 5 }), { ...ok, monthSpentUsdMicro: 4 }, now, 0.95),
    ).toBe(null);
  });

  it("is the same for the same row and differs after a new rest, a raised allowance or a new refusal", () => {
    const rest1 = { ...ok, restingUntil: "2026-11-16T15:40:00Z" };
    const rest2 = { ...ok, restingUntil: "2026-11-16T20:00:00Z" };
    expect(stopKeyOf(sub(), rest1, now, 0.95)).toBe(stopKeyOf(sub(), rest1, now, 0.95));
    expect(stopKeyOf(sub(), rest1, now, 0.95)).not.toBe(stopKeyOf(sub(), rest2, now, 0.95));
    const share = { ...ok, planUsageShare: 0.96 };
    const raised = sub({ planUsdMicro: 200_000_000 });
    expect(stopKeyOf(sub(), share, now, 0.95)).not.toBe(stopKeyOf(raised, share, now, 0.95));
    const ref1 = { ...ok, refused: "2026-11-16T13:00:00Z" };
    const ref2 = { ...ok, refused: "2026-11-16T13:30:00Z" };
    expect(stopKeyOf(key(), ref1, now, 0.95)).not.toBe(stopKeyOf(key(), ref2, now, 0.95));
  });

  it("names the stop: a share and a key's month cap end at the next month's start UTC", () => {
    expect(stopOf(sub(), { ...ok, planUsageShare: 0.96 }, now, 0.95)).toMatchObject({
      reason: "share",
      until: "2026-12-01T00:00:00.000Z",
    });
    expect(
      stopOf(key({ monthlyUsdMicro: 5 }), { ...ok, monthSpentUsdMicro: 5 }, now, 0.95),
    ).toMatchObject({ reason: "key_month", until: nextMonthStartIso(now) });
    expect(stopOf(key(), { ...ok, refused: "x" }, now, 0.95)).toMatchObject({
      reason: "refused",
      until: null,
    });
  });

  it("reads a stored grant, and nothing else", () => {
    expect(grantOf({ to: "api_key", stopKey: "limit:x", by: "card", at: "t" })).toEqual({
      to: "api_key",
      stopKey: "limit:x",
      by: "card",
      at: "t",
    });
    expect(grantOf({ to: "fake", stopKey: "x" })).toBeNull();
    expect(grantOf("yes")).toBeNull();
  });
});
