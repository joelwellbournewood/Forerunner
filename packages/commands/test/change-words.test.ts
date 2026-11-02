import { describe, expect, it } from "vitest";
import { type ExecuteResult, renderChangeCard } from "../src/index.ts";
import { world } from "./helpers.ts";

function refused(r: ExecuteResult): Extract<ExecuteResult, { status: "refused" }> {
  if (r.status !== "refused") throw new Error(`expected refused, got ${r.status}`);
  return r;
}

/**
 * Change cards in a person's words (design §3.9, §5; the walks: "unset → {"start":"12:00",…}",
 * a per-session cap labelled "Scope: this session", and "Set the default autonomy for new
 * projects from 3 to 3." accepted and logged).
 */
describe("change cards in words", () => {
  it("quiet hours read as times and the read-back is one question", async () => {
    const w = await world();
    const r = await w.executor.execute({
      name: "settings.set",
      params: { key: "quiet_hours", value: { start: "12:00", end: "18:00" } },
      ctx: w.ctx({ source: "chat" }),
    });
    const card = r.status === "pending" || r.status === "done" ? r.card : null;
    expect(card?.oldValue).toBe("off");
    expect(card?.newValue).toBe("12:00–18:00");
    expect(card?.ask).toBe("Set quiet hours to 12:00–18:00?");
    expect(renderChangeCard(card as never)).not.toMatch(/[{}]|unset/);
    await w.store.close();
  });

  it("a change to the value already set is refused with 'already', and nothing is logged", async () => {
    const w = await world();
    const human = await w.store.human.mustGet(w.human.id);
    const same = refused(
      await w.executor.execute({
        name: "settings.set",
        params: { key: "default_autonomy", value: human.default_autonomy },
        ctx: w.ctx(),
      }),
    );
    expect(same.code).toBe("validation");
    expect(same.reason).toMatch(
      /^The default autonomy for new projects is already [A-Z][a-z]+ \(level \d\)\.$/,
    );
    const budget = refused(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "session", amountChf: 5 },
        ctx: w.ctx(),
      }),
    );
    expect(budget.reason).toBe("The session budget for PharmaWatch is already CHF 5.");
    expect((await w.store.changeLog.list()).length).toBe(0);
    await w.store.close();
  });

  it("a project's autonomy reads back in one line by its name (wave 2: the whole card with its risk)", async () => {
    const w = await world();
    const r = await w.executor.execute({
      name: "autonomy.set",
      params: { level: 3 },
      ctx: w.ctx({ source: "chat" }),
    });
    expect(r.status).toBe("pending");
    if (r.status === "pending")
      expect(r.readback).toBe("Set the autonomy of PharmaWatch to Trusted (level 3)?");
    await w.store.close();
  });

  it("a task named by words that match several says which and what to say (design §5 rule 8)", async () => {
    const w = await world();
    for (const title of [
      "Style the page in styles.css",
      "Style the print view",
      "Write the README",
    ])
      await w.store.task.insert({ project_id: w.pharma.id, title, status: "ready" } as never);
    const r = refused(
      await w.executor.execute({
        name: "task.pause",
        params: { task: "style" },
        ctx: w.ctx({ source: "chat" }),
      }),
    );
    expect(r.reason).toBe(
      '2 tasks match "style": "Style the page in styles.css" and "Style the print view". Say more of the title, for example "Style the page in styles.css"',
    );
    await w.store.close();
  });

  it("a project's per-session cap is for every session of the project; the read-back is one line", async () => {
    const w = await world();
    const r = await w.executor.execute({
      name: "budget.set",
      params: { scope: "session", amountChf: 15 },
      ctx: w.ctx({ source: "chat" }),
    });
    expect(r.status).toBe("pending");
    if (r.status !== "pending") return;
    expect(r.card.scopeLabel).toBe("every session of PharmaWatch");
    expect(renderChangeCard(r.card)).toContain("Scope: every session of PharmaWatch");
    expect(renderChangeCard(r.card)).not.toContain("this session");
    expect(r.readback).toBe("Raise the session budget for PharmaWatch to CHF 15?");
    expect(r.readback).not.toMatch(/Risk|Undo|Scope/);
    await w.store.close();
  });
});
