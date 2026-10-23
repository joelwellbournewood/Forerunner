import { describe, expect, it } from "vitest";
import type { ExecuteResult } from "../src/index.ts";
import { world } from "./helpers.ts";

function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}

const ON =
  "new tasks default to critic tier 0 and the next plan is written as one milestone with a flat task list; existing tasks keep their tier";
const OFF =
  "new tasks default to critic tier 1 and the next plan may have several milestones; existing tasks keep their tier";

describe("small-project mode (B.6)", () => {
  it("the settings card and the change log sentence say what changes, both ways", async () => {
    const w = await world();
    const card = await w.executor.plan(
      { name: "settings.set", params: { key: "small_project_mode", value: true, project: "game" } },
      w.ctx(),
    );
    expect(card.what).toBe("small project mode for Game");
    expect(card.oldValue).toBe("false");
    expect(card.newValue).toBe(`true (${ON})`);
    expect(card.sentence).toBe(`Set small project mode for Game from false to true: ${ON}. Undo.`);
    const on = done(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "small_project_mode", value: true, project: "game" },
        ctx: w.ctx(),
      }),
    );
    expect(on.sentence).toBe(`Set small project mode for Game from false to true: ${ON}. Undo.`);
    expect((await w.store.project.mustGet(w.game.id)).small_project_mode).toBe(true);
    const off = done(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "small_project_mode", value: false, project: "game" },
        ctx: w.ctx(),
      }),
    );
    expect(off.sentence).toBe(`Set small project mode for Game from true to false: ${OFF}. Undo.`);
    // A key without an effect keeps its plain sentence: the effect text is per key (the
    // speed-versus-quality slider has its own, `speed-quality.test.ts`).
    const plain = done(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "notify_channel", value: "email" },
        ctx: w.ctx(),
      }),
    );
    expect(plain.sentence).toBe("Set the notification channel from unset to email. Undo.");
    await w.store.close();
  });

  it("task.create defaults the tier from the project's flag unless the task names one", async () => {
    const w = await world();
    done(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "small_project_mode", value: true, project: "game" },
        ctx: w.ctx(),
      }),
    );
    /** Runs task.create and returns the row it wrote (the newest task with that title). */
    const create = async (projectId: string, params: Record<string, unknown>) => {
      done(await w.executor.execute({ name: "task.create", params, ctx: w.ctx() }));
      const rows = (await w.store.task.forProject(projectId)).filter(
        (t) => t.title === params.title,
      );
      const row = rows.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (!row) throw new Error(`no task ${String(params.title)} in ${projectId}`);
      return row;
    };
    const small = await create(w.game.id, {
      title: "Fix the typo on the home page",
      project: "game",
    });
    expect(small.risk_tier).toBe(0);
    const named = await create(w.game.id, {
      title: "Rotate the deploy key",
      project: "game",
      risk_tier: 2,
    });
    expect(named.risk_tier).toBe(2);
    const normal = await create(w.pharma.id, {
      title: "Fix the typo on the home page",
      project: "PharmaWatch",
    });
    expect(normal.risk_tier).toBe(1);
    // Flipping the flag back leaves the tasks created under it alone.
    done(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "small_project_mode", value: false, project: "game" },
        ctx: w.ctx(),
      }),
    );
    expect((await w.store.task.mustGet(small.id)).risk_tier).toBe(0);
    await w.store.close();
  });
});
