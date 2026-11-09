import { describe, expect, it } from "vitest";
import { ZERO_REFUSED } from "../src/commands/budget.ts";
import type { ExecuteResult } from "../src/index.ts";
import { world } from "./helpers.ts";

/**
 * w15-words (wave 15 run B): what settings.set and budget.set say, at the functions that write
 * the sentence, the card and the undo question (design §5).
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
function refused(r: ExecuteResult): Extract<ExecuteResult, { status: "refused" }> {
  if (r.status !== "refused")
    throw new Error(`expected refused, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}

describe("w15-words, wave 15 run B", () => {
  describe("W15B-16: a yes/no setting reads 'on' or 'off'; a session budget of 0 says CHF 0.00", () => {
    const RAW = /\b(true|false|unset)\b/;

    it("fast_mode: the card, the sentence and the undo question say on and off", async () => {
      const w = await world();
      const human = { kind: "human" as const, id: w.human.id };
      const params = { key: "fast_mode", value: true, project: "game" };
      const card = await w.executor.plan({ name: "settings.set", params }, w.ctx());
      expect(card.oldValue).toBe("off");
      expect(card.newValue).toBe("on");
      expect(card.ask).toMatch(/^Set Opus fast mode for Game to on\? /);
      expect(card.sentence).toMatch(/^Set Opus fast mode for Game from off to on: /);
      const on = done(
        await w.executor.confirmByText(
          pending(await w.executor.execute({ name: "settings.set", params, ctx: w.ctx() }))
            .pendingId,
          "yes",
          human,
        ),
      );
      expect(on.sentence).toMatch(/^Set Opus fast mode for Game from off to on: /);
      // Its undo turns it off: at once, said with the words.
      const undone = done(await w.executor.undo(on.changeLogId, w.ctx()));
      const { oldValue, newValue, ask, sentence } = undone.card;
      expect([oldValue, newValue, ask ?? "", sentence, undone.sentence].join(" ")).not.toMatch(RAW);
      // Turned on again and then off, the undo of "off" turns it on, so it asks.
      const again = done(
        await w.executor.confirmByText(
          pending(await w.executor.execute({ name: "settings.set", params, ctx: w.ctx() }))
            .pendingId,
          "yes",
          human,
        ),
      );
      expect(again.sentence).toMatch(/from off to on/);
      const off = await w.executor.execute({
        name: "settings.set",
        params: { ...params, value: false },
        ctx: w.ctx(),
      });
      const offDone =
        off.status === "pending"
          ? done(await w.executor.confirmByText(off.pendingId, "yes", human))
          : done(off);
      expect(offDone.sentence).toMatch(/^Set Opus fast mode for Game from on to off: /);
      const undo = await w.executor.undo(offDone.changeLogId, w.ctx());
      if (undo.status !== "pending") throw new Error(`expected pending, got ${undo.status}`);
      expect(undo.card.ask).toMatch(/^Put Opus fast mode for Game back to on\?/);
      expect(undo.card.ask).not.toMatch(RAW);
    });

    it("voice alerts and small project mode: from off to on, never true or unset", async () => {
      const w = await world();
      const voice = done(
        await w.executor.execute({
          name: "settings.set",
          params: { key: "voice_alerts", value: true },
          ctx: w.ctx(),
        }),
      );
      expect(voice.sentence).toBe("Set voice alerts from off to on. Undo.");
      const small = await w.executor.plan(
        {
          name: "settings.set",
          params: { key: "small_project_mode", value: true, project: "game" },
        },
        w.ctx(),
      );
      expect(small.oldValue).toBe("off");
      expect(small.newValue).toBe("on");
      expect(small.sentence).toMatch(/^Set small project mode for Game from off to on: /);
      expect(`${small.ask} ${small.sentence}`).not.toMatch(RAW);
    });

    it("a session budget of 0 is refused with CHF 0.00 and what to do", async () => {
      expect(ZERO_REFUSED.session).toBe(
        "The budget per session must be more than CHF 0.00: a session plans its work within it. Enter the most a session may spend.",
      );
      const w = await world();
      const r = refused(
        await w.executor.execute({
          name: "budget.set",
          params: { scope: "session", amountChf: 0, project: "game" },
          ctx: w.ctx(),
        }),
      );
      expect(JSON.stringify(r)).toContain(ZERO_REFUSED.session);
      for (const words of Object.values(ZERO_REFUSED)) expect(words).not.toMatch(/CHF 0(?!\.00)/);
    });
  });
});
