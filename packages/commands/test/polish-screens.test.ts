import { describe, expect, it } from "vitest";
import type { ExecuteResult } from "../src/index.ts";
import { world } from "./helpers.ts";

/**
 * polish-screens (wave 13): Settings' change cards say a value as its words and what it
 * changes as the card's sentence; a project's budget takes 0 as "no budget"; the monthly cap
 * stays positive and says why.
 */
function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}
function pending(r: ExecuteResult): Extract<ExecuteResult, { status: "pending" }> {
  if (r.status !== "pending")
    throw new Error(`expected pending, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}

describe("Settings' change cards (P7-10, P7-31, later #30)", () => {
  it("the merge mode's card value is its label; what it means is the read-back's second sentence", async () => {
    const w = await world();
    const params = { key: "merge_mode", value: "after_review", project: "game" };
    const card = await w.executor.plan({ name: "settings.set", params }, w.ctx());
    // Before: "Merge automatically after review (Forerunner merges each task's … goes live)".
    expect(card.newValue).toBe("Merge automatically after review");
    expect(card.oldValue).toBe("You press Merge");
    expect(card.ask).toBe(
      "Set who merges accepted work for Game to Merge automatically after review? Forerunner merges each task's pull request once the critic accepts it. Merges show under your GitHub name, a comment on a merged pull request starts nothing, and if this repository's main goes online by itself, every accepted task goes live.",
    );
    const p = pending(await w.executor.execute({ name: "settings.set", params, ctx: w.ctx() }));
    // The read-back the Settings screen shows is the same question with its meaning.
    expect(p.readback).toBe(card.ask);
  });

  it("the site rule's change sentence has one colon, and its value names the sites", async () => {
    const w = await world();
    const human = { kind: "human" as const, id: w.human.id };
    // Narrowing acts at once.
    const r = done(
      await w.executor.execute({
        name: "settings.set",
        params: {
          key: "web_access",
          value: { mode: "only", only: ["example.com"], never: [] },
          project: "game",
        },
        ctx: w.ctx(),
      }),
    );
    void human;
    // Before: "… from Any public website to Only these websites: example.com: research reads …".
    expect(r.sentence).toBe(
      "Set web pages research may read for Game from any public website to only example.com: research reads only these websites and their subdomains, on the API key and on the subscription. Undo.",
    );
    expect((r.sentence ?? "").split(":")).toHaveLength(2);
  });

  it("the calibration's change says it in words, never JSON", async () => {
    const w = await world();
    const params = {
      key: "calibration",
      value: { enabled: false, day: 1, time: "06:00", budget_usd: 10, tier: 1 },
    };
    const card = await w.executor.plan({ name: "settings.set", params }, w.ctx());
    // Before: 'Set the monthly critic calibration from unset to {"enabled":false,…}'.
    expect(card.sentence).toBe(
      "Set the monthly critic calibration from on, day 1 at 06:00 (the default) to off: the critic is no longer graded against the eval sets each month. Undo.",
    );
    expect(`${card.sentence} ${card.newValue} ${card.oldValue}`).not.toMatch(/[{}"]/);
    const watch = await w.executor.plan(
      {
        name: "settings.set",
        params: { key: "model_watch", value: { run_evals: true, allow_process_sandbox: false } },
      },
      w.ctx(),
    );
    expect(watch.newValue).toBe(
      "runs the paid evaluations without asking; evaluations need a container",
    );
    expect(`${watch.sentence}`).not.toMatch(/[{}]/);
  });
});

describe("money fields and 0 (later #43; design §6)", () => {
  it("a project's budget of 0 is accepted and reads 'no budget'", async () => {
    const w = await world();
    const human = { kind: "human" as const, id: w.human.id };
    const yes = async (r: ExecuteResult) =>
      r.status === "pending"
        ? done(await w.executor.confirmByText(r.pendingId, "yes", human))
        : done(r);
    // Game starts without a budget: "no budget", never "CHF 0.00".
    const first = await w.executor.plan(
      { name: "budget.set", params: { scope: "project", amountChf: 12, project: "game" } },
      w.ctx(),
    );
    expect(first.oldValue).toBe("no budget");
    expect(first.sentence).toBe("Set the project budget for Game from no budget to CHF 12. Undo.");
    await yes(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "project", amountChf: 12, project: "game" },
        ctx: w.ctx(),
      }),
    );
    const params = { scope: "project", amountChf: 0, project: "game" };
    const card = await w.executor.plan({ name: "budget.set", params }, w.ctx());
    expect(card.newValue).toBe("no budget");
    expect(card.ask).toBe(
      "Remove the project budget for Game? Only the monthly cap limits its spending then.",
    );
    const d = await yes(await w.executor.execute({ name: "budget.set", params, ctx: w.ctx() }));
    expect(d.sentence).toBe(
      "Set the project budget for Game from CHF 12 to no budget: only the monthly cap limits its spending. Undo.",
    );
    expect((await w.store.project.mustGet(w.game.id)).budget_usd_micro).toBe(0);
  });

  it("the monthly cap's 0 is refused in words saying why; a session's too", async () => {
    const w = await world();
    for (const [scope, said] of [
      ["month", "The monthly cap must be more than CHF 0: it is the limit that stops all spending"],
      ["session", "The budget per session must be more than CHF 0"],
    ] as const) {
      const r = await w.executor
        .plan({ name: "budget.set", params: { scope, amountChf: 0, project: "game" } }, w.ctx())
        .then(
          () => null,
          (e: unknown) => e,
        );
      const issues = (r as { details?: { issues?: { message: string }[] } } | null)?.details
        ?.issues;
      expect(issues?.map((i) => i.message).join(" ")).toContain(said);
    }
  });
});
