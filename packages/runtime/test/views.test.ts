import { openStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { costView } from "../src/daemon/views.ts";
import { seedWorld } from "./context-helpers.ts";

describe("daemon views: cost view savings", () => {
  it("shows compression (estimated) and cache (measured) savings from the Run rows, priced separately from spend", async () => {
    const store = await openStore({ url: "sqlite::memory:" });
    const w = await seedWorld(store);
    const run = await store.run.insert({
      session_id: w.session,
      specialist: "coder",
      model: "claude-sonnet-4-5",
      tokens_in: 20_000,
      tokens_out: 500,
      cache_read_tokens: 10_000,
      cache_write_tokens: 2_000,
      cost_usd_micro: 70_500,
      tokens_before_compression: 50_000,
      tokens_after_compression: 20_000,
      context_transforms: ["logs", "truncate"],
      headroom_used: false,
      outcome: "completed",
    });
    await store.costLedger.record({
      human_id: w.human,
      agent_id: w.agent,
      project_id: w.project,
      session_id: w.session,
      run_id: run.id,
      billing_source_id: null,
      kind: "api",
      usd_micro: 70_500,
      chf_micro: 56_400,
      rate_chf_per_usd: 0.8,
      model: "claude-sonnet-4-5",
      specialist: "coder",
      tokens_in: 20_000,
      tokens_out: 500,
      cache_read_tokens: 10_000,
      cache_write_tokens: 2_000,
      occurred_at: store.clock.nowIso(),
    });
    const byProject = await costView(store, { projectId: w.project }, 0.8);
    expect(byProject.totals).toEqual({ usdMicro: 70_500, chfMicro: 56_400 });
    expect(byProject.savings).toEqual({
      compressionTokens: 30_000,
      cacheTokens: 10_000,
      // 30_000 x 3 USD/MTok = 90_000 micro; cache reads 10_000 x (3 - 0.3) = 27_000 micro.
      compression: { usdMicro: 90_000, chfMicro: 72_000 },
      cache: { usdMicro: 27_000, chfMicro: 21_600 },
    });
    const byHuman = await costView(store, { humanId: w.human }, 0.8);
    expect(byHuman.savings).toEqual(byProject.savings);
    const other = await costView(store, { projectId: "nope" }, 0.8);
    expect(other.savings).toEqual({
      compressionTokens: 0,
      cacheTokens: 0,
      compression: { usdMicro: 0, chfMicro: 0 },
      cache: { usdMicro: 0, chfMicro: 0 },
    });
    await store.close();
  });
});
