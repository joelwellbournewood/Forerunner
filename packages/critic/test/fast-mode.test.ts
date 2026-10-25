import { BUILTIN_PRICING, type PricingTable } from "@forerunner/billing";
import { FAST_MODE_AUDIT_TOOL, type RunEvent, type RunPricing } from "@forerunner/runtime";
import { describe, expect, it } from "vitest";
import type { CriticDeps } from "../src/critic.ts";
import type { ReviewInput, ReviewTier } from "../src/types.ts";
import { baseEvidence, closingReply, submitReply, type World, world } from "./helpers.ts";

/**
 * Opus fast mode reaches the critic (spec D.20, ADR 0057): a project's `fast_mode` routes
 * every Opus rung of its runs to the fast-mode variant, and tiers 2 and 3 review on the Opus
 * rung by default. With the flag on, an Opus review on an API-style source is requested with
 * `speed: "fast"` on the same model id, and its Run row, its ledger row and its price name the
 * variant. A subscription source ignores the flag with an audit row saying "API only"; a
 * review below the Opus rung, or a project with the flag off, is unchanged and writes nothing.
 */

/** The standard Opus rung priced at 1 µUSD per token, the variant at 2 (its published 2x). */
const STANDARD: RunPricing = {
  estimate: (i, o) => i + o,
  cost: (u) => u.input_tokens + u.output_tokens,
};
const FAST: RunPricing = {
  estimate: (i, o) => 2 * (i + o),
  cost: (u) => 2 * (u.input_tokens + u.output_tokens),
};
const pricing = (modelId: string): RunPricing => (modelId.endsWith("-fast") ? FAST : STANDARD);

/** The fake ladder's Opus rung and its variant, both priced, so the variant is never a guess. */
const TABLE: PricingTable = {
  ...BUILTIN_PRICING,
  "fake-opus": { ...(BUILTIN_PRICING["claude-opus-5-5"] as PricingTable[string]) },
  "fake-opus-fast": { ...(BUILTIN_PRICING["claude-opus-5-5-fast"] as PricingTable[string]) },
};

const input = (taskId: string, tier: ReviewTier): ReviewInput => ({
  subject: { kind: "task", taskId },
  tier,
  evidence: baseEvidence(),
});

async function review(opts: {
  settings: Record<string, boolean>;
  tier: ReviewTier;
  sourceKind?: "api_key" | "subscription" | "plan_credits";
  deps?: Partial<CriticDeps>;
}) {
  const w: World = await world({
    projectSettings: opts.settings,
    replies: [submitReply(), closingReply()],
    deps: {
      pricing,
      fastMode: async () => ({ sourceKind: opts.sourceKind ?? "api_key", pricing: TABLE }),
      ...opts.deps,
    },
  });
  // The fake provider offers fast mode here, as the Anthropic adapter does.
  Object.assign(w.provider, { fastMode: true });
  const events: RunEvent[] = [];
  const out = await w.critic.review(
    input(w.ids.task, opts.tier),
    w.ctx({ onEvent: (e) => events.push(e) }),
  );
  const runs = await w.store.run.forTask(w.ids.task);
  const audit = await w.store.auditLog.list({ tool: FAST_MODE_AUDIT_TOOL });
  return { w, out, runs, audit, events, calls: w.provider.calls.map((c) => c.request) };
}

describe("the critic under Opus fast mode (D.20)", () => {
  it("flag on, a tier-2 review on the Opus rung of an API source: speed fast, the run and the ledger name and price the variant", async () => {
    const r = await review({ settings: { fast_mode: true }, tier: 2 });
    try {
      expect(r.out.outcome).toBe("completed");
      expect(r.calls.length).toBeGreaterThanOrEqual(1);
      for (const c of r.calls) {
        expect(c.model).toBe("fake-opus");
        expect(c.speed).toBe("fast");
      }
      expect(r.runs).toHaveLength(1);
      expect(r.runs[0]).toMatchObject({ specialist: "critic", model: "fake-opus-fast" });
      expect(r.out.model).toBe("fake-opus-fast");
      // Priced at the variant's rate: twice the tokens.
      const tokens = (r.runs[0]?.tokens_in ?? 0) + (r.runs[0]?.tokens_out ?? 0);
      expect(r.runs[0]?.cost_usd_micro).toBe(2 * tokens);
      expect(r.w.ledger.entries.length).toBeGreaterThanOrEqual(1);
      for (const e of r.w.ledger.entries) expect(e.model).toBe("fake-opus-fast");
      expect(r.audit).toHaveLength(1);
      expect(r.audit[0]?.result_summary).toMatch(/^applied: fake-opus requested with speed fast/);
      expect(JSON.parse(r.audit[0]?.input_summary ?? "{}")).toMatchObject({
        specialist: "critic",
        reviewTier: 2,
        tier: "opus",
        model: "fake-opus",
        variant: "fake-opus-fast",
        kind: "api_key",
        sourceId: "bs-test",
      });
      expect(r.audit[0]).toMatchObject({ run_id: r.out.runId, agent_id: r.w.ids.critic });
    } finally {
      await r.w.close();
    }
  });

  it("flag off: the Opus review is unchanged and nothing is audited", async () => {
    const r = await review({ settings: {}, tier: 2 });
    try {
      for (const c of r.calls) expect(c.speed).toBeUndefined();
      expect(r.runs[0]?.model).toBe("fake-opus");
      expect(r.audit).toEqual([]);
    } finally {
      await r.w.close();
    }
  });

  it("flag on, a tier-1 review on the sonnet rung: unchanged, nothing audited", async () => {
    const r = await review({ settings: { fast_mode: true }, tier: 1 });
    try {
      for (const c of r.calls) {
        expect(c.model).toBe("fake-sonnet");
        expect(c.speed).toBeUndefined();
      }
      expect(r.runs[0]?.model).toBe("fake-sonnet");
      expect(r.audit).toEqual([]);
    } finally {
      await r.w.close();
    }
  });

  it("a subscription source: ignored with an audit row saying API only and a warning, the review stays standard", async () => {
    const r = await review({ settings: { fast_mode: true }, tier: 3, sourceKind: "subscription" });
    try {
      for (const c of r.calls) {
        expect(c.model).toBe("fake-opus");
        expect(c.speed).toBeUndefined();
      }
      expect(r.runs[0]?.model).toBe("fake-opus");
      expect(r.audit).toHaveLength(1);
      expect(r.audit[0]?.result_summary).toMatch(/^ignored \(API only\)/);
      expect(JSON.parse(r.audit[0]?.input_summary ?? "{}")).toMatchObject({
        kind: "subscription",
        reviewTier: 3,
      });
      expect(r.events.some((e) => e.type === "warning" && e.message.includes("API only"))).toBe(
        true,
      );
    } finally {
      await r.w.close();
    }
  });

  it("without the billing facts the decision still runs: a provider without fast mode is noted, never asked", async () => {
    const w = await world({
      projectSettings: { fast_mode: true },
      replies: [submitReply(), closingReply()],
    });
    try {
      await w.critic.review(input(w.ids.task, 2), w.ctx());
      for (const c of w.provider.calls) expect(c.request.speed).toBeUndefined();
      const audit = await w.store.auditLog.list({ tool: FAST_MODE_AUDIT_TOOL });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.result_summary).toMatch(/provider fake has no fast mode/);
    } finally {
      await w.close();
    }
  });

  it("calibration (persist off) writes no audit row even when fast mode applies", async () => {
    const w = await world({
      projectSettings: { fast_mode: true },
      replies: [submitReply(), closingReply()],
      deps: { pricing, fastMode: async () => ({ sourceKind: "api_key", pricing: TABLE }) },
    });
    Object.assign(w.provider, { fastMode: true });
    try {
      await w.critic.review(input(w.ids.task, 2), w.ctx({ persist: false }));
      expect(w.provider.calls[0]?.request.speed).toBe("fast");
      expect(await w.store.auditLog.list({ tool: FAST_MODE_AUDIT_TOOL })).toEqual([]);
    } finally {
      await w.close();
    }
  });
});
