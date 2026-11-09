import { describe, expect, it } from "vitest";
import type { ExecuteResult } from "../src/index.ts";
import { world } from "./helpers.ts";

/**
 * d1109-oversize-start (OS-6; the owner's D4 of 2026-11-09: "it should get a warning, but it
 * should get done anyway"). The chat's "start a session" is the Start dialog's sibling: when the
 * session would take a task larger than its work budget, its read-back carries the Start
 * dialog's warning (the runtime's `startWarning` port, the Start check's own sentence), and the
 * start is never refused for it. Before, the chat refused such a start with the Start dialog's
 * blocker sentence ("Nothing can run within this budget: ...") and read back no warning.
 */
const WARNING =
  '"Build the shop" needs more than its work budget of CHF 4.00: it pauses with its work kept and asks you to continue.';

function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}

describe("d1109-oversize-start, run C: the chat's start warns of a task larger than the work budget (OS-6)", () => {
  it("the read-back carries the warning after its question; the start is not refused", async () => {
    const w = await world();
    const asked: { projectId: string; budgetUsdMicro: number }[] = [];
    w.ports.startWarning = async (projectId, budgetUsdMicro) => {
      asked.push({ projectId, budgetUsdMicro });
      return WARNING;
    };
    // The Start check no longer blocks it (the runtime's startBlocked answers null).
    w.ports.startBlocked = async () => null;
    const card = await w.executor.plan({ name: "session.start", params: {} }, w.ctx());
    expect(card.impact.risk).toBe("medium");
    expect(card.ask).toBe(`Start a session on PharmaWatch (up to CHF 5)? ${WARNING}`);
    expect(asked).toEqual([{ projectId: w.pharma.id, budgetUsdMicro: 6_250_000 }]);
    // Yes: the session starts with the budget it said.
    const r = done(
      await w.executor.execute({
        name: "session.start",
        params: {},
        ctx: w.ctx(),
        confirmation: { kind: "tap", by: { kind: "human", id: w.human.id } },
      }),
    );
    // The read-back said the warning; what happened is said once, without it again.
    expect(r.sentence).toBe("Started a session on PharmaWatch (up to CHF 5).");
    expect(w.ports.starts.map((s) => s.budgetUsdMicro)).toEqual([6_250_000]);
    await w.store.close();
  });

  it("a start below the costly line is not read back, so its warning comes with what happened", async () => {
    const w = await world();
    w.ports.startWarning = async () => WARNING;
    const r = done(
      await w.executor.execute({ name: "session.start", params: { budgetChf: 1 }, ctx: w.ctx() }),
    );
    expect(r.sentence).toBe(`Started a session on PharmaWatch (up to CHF 1). ${WARNING}`);
    expect(w.ports.starts).toHaveLength(1);
    await w.store.close();
  });

  it("without a larger task nothing changes: the question alone, the sentence alone", async () => {
    const w = await world();
    w.ports.startWarning = async () => null;
    const card = await w.executor.plan({ name: "session.start", params: {} }, w.ctx());
    expect(card.ask).toBe("Start a session on PharmaWatch (up to CHF 5)?");
    const r = done(
      await w.executor.execute({ name: "session.start", params: { budgetChf: 1 }, ctx: w.ctx() }),
    );
    expect(r.sentence).toBe("Started a session on PharmaWatch (up to CHF 1).");
    await w.store.close();
  });
});
