import { CapChecker } from "@forerunner/billing";
import { SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import {
  BillingCaps,
  credentialFor,
  pricingFor,
  StateLedgerStore,
  stateSources,
} from "../src/wiring/billing-ports.ts";

describe("billing wiring", () => {
  it("stores ledger rows in state and lets the cap checker read month, project and task spend", async () => {
    const clock = new SimulatedClock("2026-03-10T10:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const human = (
      await store.human.insert({
        name: "J",
        email: "j@x.test",
        timezone: "UTC",
        notify_prefs: {},
        default_autonomy: 2,
        monthly_cap_usd_micro: 150_000_000,
        locale: "en",
      })
    ).id;
    const project = (
      await store.project.insert({
        name: "P",
        goal: "g",
        repos: [],
        stage: "s",
        status: "active",
        budget_usd_micro: 50_000_000,
        autonomy_level: 2,
        summary_cache: {},
        data_assets: [],
        settings: {},
        small_project_mode: false,
        active: true,
      })
    ).id;
    const ledger = new StateLedgerStore(store);
    await ledger.record({
      human_id: human,
      project_id: project,
      billing_source_id: null,
      kind: "api",
      usd_micro: 40_000_000,
      chf_micro: 32_000_000,
      rate_chf_per_usd: 0.8,
      model: "claude-sonnet-5-5",
      tokens_in: 1,
      tokens_out: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      occurred_at: clock.nowIso(),
    });
    expect((await ledger.sum({ projectId: project })).usd_micro).toBe(40_000_000);
    expect(await ledger.list({ humanId: human, from: "2026-03-01T00:00:00.000Z" })).toHaveLength(1);
    expect(await ledger.list({ humanId: human, from: "2026-03-11T00:00:00.000Z" })).toHaveLength(0);
    const checker = new CapChecker({
      query: ledger,
      clock,
      caps: {
        monthUsdMicro: 150_000_000,
        projectUsdMicro: 50_000_000,
        sessionUsdMicro: 20_000_000,
      },
    });
    const caps = new BillingCaps(checker);
    const scope = { humanId: human, projectId: project, sessionId: "s", runId: "r" };
    expect((await caps.check(scope, 1_000_000, { phase: "work" })).decision).toBe("finish_current");
    const stop = await caps.check(scope, 11_000_000, { phase: "work" });
    expect(stop.decision).toBe("stop");
    expect(stop.level).toBe("project");
    // The read the loop sizes a call's output cap with (CapChecker.room): the project is at its
    // 80% line already, so its stop line bounds it (50 - 40 USD, less one micro-USD); the month
    // (80% of 150 less 40) and the session (80% of 20) leave more.
    expect(await caps.roomUsdMicro(scope, { phase: "review" })).toBe(9_999_999);
    await store.close();
  });

  it("prices runs from the table and reads sources and credentials", async () => {
    const p = pricingFor("claude-sonnet-5-5");
    expect(p.estimate(1_000_000, 1_000)).toBeGreaterThan(0);
    expect(
      p.cost({
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(p.estimate(1_000_000, 0));
    expect(() =>
      pricingFor("no-such-model").cost({
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toThrow();

    const clock = new SimulatedClock();
    const store = await openStore({ url: "sqlite::memory:", clock });
    const human = (
      await store.human.insert({
        name: "J",
        email: "j@x.test",
        timezone: "UTC",
        notify_prefs: {},
        default_autonomy: 2,
        monthly_cap_usd_micro: 1,
        locale: "en",
      })
    ).id;
    await store.billingSource.insert({
      human_id: human,
      kind: "subscription",
      label: "Max plan",
      credential_ref: "anthropic_subscription_token",
      limits: { planShareCap: 0.9 },
      enabled: true,
      priority: 1,
    });
    await store.billingSource.insert({
      human_id: human,
      kind: "api_key",
      label: "Console key",
      credential_ref: "anthropic_api_key",
      limits: {},
      enabled: false,
      priority: 2,
    });
    const sources = await stateSources(store)(human);
    expect(sources.map((s) => s.kind)).toEqual(["subscription"]);
    const vault = new MemoryVault();
    await vault.set("anthropic_subscription_token", "oat-value");
    const sub = sources[0]!;
    expect(await credentialFor(sub, vault)).toEqual({ kind: "oauth_token", value: "oat-value" });
    await expect(credentialFor({ ...sub, credentialRef: "missing" }, vault)).rejects.toMatchObject({
      code: "provider_auth",
    });
    await store.close();
  });
});
