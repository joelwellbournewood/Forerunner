import { describe, expect, it } from "vitest";
import {
  type ExecuteResult,
  SETTING_SPECS,
  SPEED_QUALITY_EFFECT,
  speedQualityEffect,
} from "../src/index.ts";
import { world } from "./helpers.ts";

/**
 * The speed-versus-quality slider (spec D.16) as a setting: three positions (-1 speed, 0
 * balanced, +1 quality), low risk, and the card and the change log sentence say what the new
 * position changes, in both directions, the way small-project mode does (ADR 0051 item 4).
 */
function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}

const set = (value: unknown) => ({
  name: "settings.set",
  params: { key: "speed_quality_offset", value, project: "game" },
});

describe("speed-versus-quality slider (D.16)", () => {
  it("is a low-risk project setting with exactly three positions", () => {
    const spec = SETTING_SPECS.speed_quality_offset;
    expect(spec).toMatchObject({ scope: "project", risk: "low" });
    for (const v of [-1, 0, 1]) expect(spec?.schema.safeParse(v).success).toBe(true);
    for (const v of [-2, 2, 0.5, "quality", null])
      expect(spec?.schema.safeParse(v).success).toBe(false);
    expect(speedQualityEffect(-1)).toBe(SPEED_QUALITY_EFFECT.speed);
    expect(speedQualityEffect(0)).toBe(SPEED_QUALITY_EFFECT.balanced);
    expect(speedQualityEffect(1)).toBe(SPEED_QUALITY_EFFECT.quality);
  });

  it("the card and the change log sentence say what each move changes, both ways, and undo restores", async () => {
    const w = await world();
    const card = await w.executor.plan(set(1), w.ctx());
    expect(card.what).toBe("the speed-versus-quality slider for Game");
    expect(card.oldValue).toBe("unset");
    expect(card.newValue).toBe(`1 (${SPEED_QUALITY_EFFECT.quality})`);
    expect(card.impact.risk).toBe("low");
    expect(card.sentence).toBe(
      `Set the speed-versus-quality slider for Game from unset to 1: ${SPEED_QUALITY_EFFECT.quality}. Undo.`,
    );

    // Up to quality: a low-risk change runs at once and the row holds the new position.
    const up = done(await w.executor.execute({ ...set(1), ctx: w.ctx() }));
    expect(up.sentence).toBe(
      `Set the speed-versus-quality slider for Game from unset to 1: ${SPEED_QUALITY_EFFECT.quality}. Undo.`,
    );
    expect((await w.store.project.mustGet(w.game.id)).settings.speed_quality_offset).toBe(1);

    // Down to speed: the sentence names the other direction.
    const down = done(await w.executor.execute({ ...set(-1), ctx: w.ctx() }));
    expect(down.sentence).toBe(
      `Set the speed-versus-quality slider for Game from 1 to -1: ${SPEED_QUALITY_EFFECT.speed}. Undo.`,
    );
    expect((await w.store.project.mustGet(w.game.id)).settings.speed_quality_offset).toBe(-1);

    // Back to balanced.
    const mid = done(await w.executor.execute({ ...set(0), ctx: w.ctx() }));
    expect(mid.sentence).toBe(
      `Set the speed-versus-quality slider for Game from -1 to 0: ${SPEED_QUALITY_EFFECT.balanced}. Undo.`,
    );

    // The change log keeps every sentence as it was said, newest first.
    const rows = (await w.store.changeLog.list()).filter((r) =>
      r.sentence.startsWith("Set the speed-versus-quality slider"),
    );
    expect(rows.map((r) => r.sentence).sort()).toEqual(
      [up.sentence, down.sentence, mid.sentence].sort(),
    );

    // Undo of the last move puts the slider back at speed.
    done(await w.executor.undo(mid.changeLogId, w.ctx()));
    expect((await w.store.project.mustGet(w.game.id)).settings.speed_quality_offset).toBe(-1);
    await w.store.close();
  });

  it("refuses a position past one step and writes nothing", async () => {
    const w = await world();
    const r = await w.executor.execute({ ...set(2), ctx: w.ctx() });
    expect(r).toMatchObject({
      status: "refused",
      code: "validation",
      reason: "speed_quality_offset: Too big: expected number to be <=1",
    });
    // The other direction says so (the UI's fake daemon repeats these words).
    expect(await w.executor.execute({ ...set(-2), ctx: w.ctx() })).toMatchObject({
      status: "refused",
      reason: "speed_quality_offset: Too small: expected number to be >=-1",
    });
    expect((await w.store.project.mustGet(w.game.id)).settings.speed_quality_offset).toBe(
      undefined,
    );
    expect((await w.store.changeLog.list()).length).toBe(0);
    await w.store.close();
  });
});
