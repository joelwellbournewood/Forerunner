import { CapChecker } from "@forerunner/billing";
import { SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { DynamicCaps } from "../src/daemon/compose.ts";
import { StateLedgerStore } from "../src/wiring/billing-ports.ts";

/**
 * The daemon's outer caps (`DynamicCaps`): the human's month and the project's budget read live
 * from state, the session level unbounded (SessionBudget enforces it in-process). Its room is
 * what the loop sizes a max-effort call's output cap with (ADR 0028, amendment of 2026-10-26).
 */
describe("DynamicCaps.roomUsdMicro", () => {
  const setup = async (monthCap: number, projectBudget: number, projectSpent: number) => {
    const clock = new SimulatedClock("2026-10-20T10:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const human = (
      await store.human.insert({
        name: "J",
        email: "j@x.test",
        timezone: "UTC",
        notify_prefs: {},
        default_autonomy: 2,
        monthly_cap_usd_micro: monthCap,
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
        budget_usd_micro: projectBudget,
        autonomy_level: 2,
        summary_cache: {},
        data_assets: [],
        settings: {},
        small_project_mode: false,
        active: true,
      })
    ).id;
    const ledger = new StateLedgerStore(store);
    if (projectSpent > 0) {
      await ledger.record({
        human_id: human,
        project_id: project,
        billing_source_id: null,
        kind: "api",
        usd_micro: projectSpent,
        chf_micro: Math.round(projectSpent * 0.8),
        rate_chf_per_usd: 0.8,
        model: "claude-sonnet-5-5",
        tokens_in: 1,
        tokens_out: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        occurred_at: clock.nowIso(),
      });
    }
    // As composeRuntime builds it.
    const checker = new CapChecker({
      query: ledger,
      clock,
      caps: { monthUsdMicro: Number.MAX_SAFE_INTEGER, sessionUsdMicro: Number.MAX_SAFE_INTEGER },
    });
    return { store, human, project, caps: new DynamicCaps(store, checker, clock) };
  };

  it("with the month cap unset, the project's 80% line bounds the room, never the session", async () => {
    const w = await setup(0, 10_000_000, 7_500_000);
    try {
      const scope = { humanId: w.human, projectId: w.project, sessionId: "s", runId: "r" };
      const room = await w.caps.roomUsdMicro(scope, { phase: "work" });
      expect(room).toBe(499_999);
      expect((await w.caps.check(scope, room ?? 0, { phase: "work" })).decision).toBe("allow");
      expect((await w.caps.check(scope, (room ?? 0) + 1, { phase: "work" })).decision).toBe(
        "finish_current",
      );
    } finally {
      await w.store.close();
    }
  });

  it("with no project budget and no month cap, nothing bounds the room in practice", async () => {
    const w = await setup(0, 0, 0);
    try {
      const room = await w.caps.roomUsdMicro(
        { humanId: w.human, projectId: w.project, sessionId: "s" },
        { phase: "review" },
      );
      expect(room).toBeGreaterThan(1e15);
    } finally {
      await w.store.close();
    }
  });

  it("a month cap set on the human bounds the room too", async () => {
    const w = await setup(5_000_000, 0, 1_000_000);
    try {
      // 80% of 5 USD less 1 USD spent this month, less one micro-USD.
      expect(
        await w.caps.roomUsdMicro({ humanId: w.human, projectId: w.project }, { phase: "review" }),
      ).toBe(2_999_999);
    } finally {
      await w.store.close();
    }
  });
});
