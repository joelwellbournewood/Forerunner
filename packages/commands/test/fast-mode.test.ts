import { BUILTIN_PRICING, mergePricing } from "@forerunner/billing";
import { describe, expect, it } from "vitest";
import type { ExecuteResult } from "../src/index.ts";
import { SETTING_SPECS, settingSpec } from "../src/index.ts";
import { world } from "./helpers.ts";

/**
 * The project setting `fast_mode` (spec D.20, ADR 0057): off by default, medium risk because
 * it raises what an Opus call costs, and the change card and the change log sentence say what
 * switching it changes and what it costs, both ways (ADR 0051 item 4).
 */
const ON =
  "Opus runs of this project on an API key are requested in fast mode at USD 8 / 40 per million input / output tokens instead of USD 4 / 20, a 2x surcharge; a subscription ignores it (API only)";
const OFF =
  "Opus runs of this project go back to the standard speed at USD 4 / 20 per million input / output tokens; the fast-mode surcharge (2x, USD 8 / 40) stops";

function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}
function pending(r: ExecuteResult): Extract<ExecuteResult, { status: "pending" }> {
  if (r.status !== "pending")
    throw new Error(`expected pending, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}

describe("the fast_mode setting (D.20)", () => {
  it("is a project boolean of medium risk", () => {
    const spec = settingSpec("fast_mode");
    expect(spec).toMatchObject({ key: "fast_mode", scope: "project", risk: "medium" });
    expect(spec.schema.safeParse(true).success).toBe(true);
    expect(spec.schema.safeParse("on").success).toBe(false);
    expect(spec.label).toBe("Opus fast mode");
    expect(spec.description).toMatch(/\(API only, priced separately\)/);
    expect(spec.description).not.toMatch(/research preview/);
    expect(Object.keys(SETTING_SPECS)).toContain("fast_mode");
  });

  it("the card and the change log sentence name the effect and the surcharge, both ways", async () => {
    const w = await world();
    const human = { kind: "human" as const, id: w.human.id };
    const params = { key: "fast_mode", value: true, project: "game" };
    const card = await w.executor.plan({ name: "settings.set", params }, w.ctx());
    expect(card.what).toBe("Opus fast mode for Game");
    expect(card.oldValue).toBe("unset");
    expect(card.newValue).toBe(`true (${ON})`);
    expect(card.sentence).toBe(`Set Opus fast mode for Game from unset to true: ${ON}. Undo.`);

    // Medium risk: a yes before anything changes.
    const p = pending(await w.executor.execute({ name: "settings.set", params, ctx: w.ctx() }));
    expect(p.decision).toBe("needs_yes");
    expect((await w.store.project.mustGet(w.game.id)).settings.fast_mode).toBeUndefined();
    const on = done(await w.executor.confirmByText(p.pendingId, "yes", human));
    expect(on.sentence).toBe(`Set Opus fast mode for Game from unset to true: ${ON}. Undo.`);
    expect((await w.store.project.mustGet(w.game.id)).settings.fast_mode).toBe(true);
    // Other projects are untouched: the flag is per project.
    expect((await w.store.project.mustGet(w.pharma.id)).settings.fast_mode).toBeUndefined();

    const p2 = pending(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "fast_mode", value: false, project: "game" },
        ctx: w.ctx(),
      }),
    );
    expect(p2.card.newValue).toBe(`false (${OFF})`);
    const off = done(await w.executor.confirmByText(p2.pendingId, "yes", human));
    expect(off.sentence).toBe(`Set Opus fast mode for Game from true to false: ${OFF}. Undo.`);
    expect((await w.store.project.mustGet(w.game.id)).settings.fast_mode).toBe(false);
    const log = await w.store.changeLog.list();
    expect(log.map((e) => e.sentence)).toEqual(
      expect.arrayContaining([
        `Set Opus fast mode for Game from unset to true: ${ON}. Undo.`,
        `Set Opus fast mode for Game from true to false: ${OFF}. Undo.`,
      ]),
    );
    await w.store.close();
  });

  it("the card and the sentence quote the price table in force, so a corrected fast row is the surcharge the human says yes to", async () => {
    const w = await world();
    // The model watch (or a human) corrected the 5.5 fast row through pricing.json.
    const table = mergePricing(BUILTIN_PRICING, {
      "claude-opus-5-5-fast": { input_per_mtok_usd: 30, output_per_mtok_usd: 150 },
    });
    w.ports.pricingTable = () => table;
    const human = { kind: "human" as const, id: w.human.id };
    const corrected =
      "Opus runs of this project on an API key are requested in fast mode at USD 30 / 150 per million input / output tokens instead of USD 4 / 20, a 7.5x surcharge; a subscription ignores it (API only)";
    const params = { key: "fast_mode", value: true, project: "game" };
    const card = await w.executor.plan({ name: "settings.set", params }, w.ctx());
    expect(card.newValue).toBe(`true (${corrected})`);
    const p = pending(await w.executor.execute({ name: "settings.set", params, ctx: w.ctx() }));
    const on = done(await w.executor.confirmByText(p.pendingId, "yes", human));
    expect(on.sentence).toBe(`Set Opus fast mode for Game from unset to true: ${corrected}. Undo.`);
    const off = await w.executor.plan(
      { name: "settings.set", params: { key: "fast_mode", value: false, project: "game" } },
      w.ctx(),
    );
    expect(off.newValue).toContain("the fast-mode surcharge (7.5x, USD 30 / 150) stops");
    await w.store.close();
  });
});
