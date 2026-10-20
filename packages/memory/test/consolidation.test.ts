import { isForerunnerError, join } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consolidate, consolidationDue, DEFAULT_CONSOLIDATION } from "../src/consolidation.ts";
import { polarityConflict } from "../src/polarity.ts";
import { remember } from "../src/record.ts";
import { recall } from "../src/retrieval.ts";
import { DAY_MS, TEXTS, type World, world } from "./helpers.ts";

const USE = "Use the Windows CI job before merging a change that touches file paths.";
const AVOID =
  "Avoid the Windows CI job before merging a change that touches file paths; it is flaky.";
const ALWAYS = "Always run the Windows CI job before merging a change that touches file paths.";
const NEVER = "Never run the Windows CI job before merging a change that touches file paths.";

describe("polarityConflict", () => {
  it("detects opposite sides of a polarity pair", () => {
    expect(polarityConflict(ALWAYS, NEVER)).toBe("always/never");
    expect(polarityConflict(USE, AVOID)).toBe("use/avoid");
    expect(polarityConflict("Do run the job.", "Don't run the job.")).toBe("do/don't");
    expect(polarityConflict("You should rebase.", "You should not rebase.")).toBe(
      "should/should not",
    );
    expect(polarityConflict(ALWAYS, ALWAYS)).toBeNull();
    expect(polarityConflict(USE, "Prefer the Linux job.")).toBeNull();
    // Both sides in one text is not a side.
    expect(polarityConflict("Always test, never skip.", NEVER)).toBeNull();
  });
});

describe("consolidationDue", () => {
  it("is due when never run or a week has passed", () => {
    const now = Date.parse("2026-03-09T07:00:00Z");
    expect(consolidationDue(null, now)).toBe(true);
    expect(consolidationDue(undefined, now)).toBe(true);
    expect(consolidationDue("garbage", now)).toBe(true);
    expect(consolidationDue(new Date(now - 6 * DAY_MS).toISOString(), now)).toBe(false);
    expect(consolidationDue(new Date(now - 7 * DAY_MS).toISOString(), now)).toBe(true);
    expect(consolidationDue(new Date(now - 7 * DAY_MS).toISOString(), new Date(now))).toBe(true);
    expect(consolidationDue(new Date(now - 2 * DAY_MS).toISOString(), now, 1)).toBe(true);
    expect(DEFAULT_CONSOLIDATION.intervalDays).toBe(7);
  });
});

describe("consolidate", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  it("proposes merging duplicates, keeping the most used, and applies only on request", async () => {
    const kept = await remember(w.ctx, { scope: "shared", text: TEXTS.windows, tags: ["windows"] });
    const loser = await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.windowsDup2,
      tags: ["windows"],
    });
    expect(loser.action).toBe("inserted");
    for (let i = 0; i < 3; i++) await w.store.lesson.touch(kept.lesson.id);

    const report = await consolidate(w.ctx, { scope: "shared" });
    expect(report.scope).toBe("shared");
    expect(report.ownerAgentId).toBeNull();
    expect(report.ranAt).toBe(w.clock.nowIso());
    expect(report.applied).toBe(false);
    expect(report.merged).toEqual([
      {
        keptId: kept.lesson.id,
        retiredIds: [loser.lesson.id],
        cosine: expect.any(Number),
        projectId: null,
      },
    ]);
    expect(report.merged[0]?.cosine ?? 0).toBeGreaterThanOrEqual(0.9);
    expect(report.contradictions).toEqual([]);
    expect(report.retired).toEqual([]);
    expect(report.proposals).toEqual([expect.stringMatching(/^merge: keep .* retire /)]);
    // Report only: nothing changed.
    expect((await w.store.lesson.mustGet(loser.lesson.id)).status).toBe("active");

    const applied = await consolidate(w.ctx, { scope: "shared", apply: true });
    expect(applied.applied).toBe(true);
    const retired = await w.store.lesson.mustGet(loser.lesson.id);
    expect(retired.status).toBe("retired");
    expect(retired.superseded_by).toBe(kept.lesson.id);
    expect(retired.version).toBe(loser.lesson.version + 1);
    const file = await w.files.read(retired.file_path as string);
    expect(file.status).toBe("retired");
    expect(file.superseded_by).toBe(kept.lesson.id);
    expect((await w.store.lesson.mustGet(kept.lesson.id)).status).toBe("active");
    expect(await w.files.exists(join(w.files.scopeRoot("shared"), "catalog.md"))).toBe(true);
  });

  it("flags contradictions without resolving them", async () => {
    const a = await remember(w.ctx, { scope: "shared", text: USE, tags: ["windows", "ci"] });
    const b = await remember(w.ctx, { scope: "shared", text: AVOID, tags: ["ci", "flaky"] });
    expect(b.action).toBe("inserted");
    const report = await consolidate(w.ctx, { scope: "shared" });
    expect(report.merged).toEqual([]);
    expect(report.contradictions).toEqual([
      {
        a: a.lesson.id,
        b: b.lesson.id,
        reason: expect.stringMatching(/^use\/avoid: /),
        cosine: expect.any(Number),
      },
    ]);
    expect(report.contradictions[0]?.cosine ?? 0).toBeGreaterThanOrEqual(0.6);
    expect(report.proposals[0]).toMatch(/contradiction \(flag only, not resolved\)/);

    await consolidate(w.ctx, { scope: "shared", apply: true });
    for (const [row, other] of [
      [a.lesson, b.lesson],
      [b.lesson, a.lesson],
    ] as const) {
      const fresh = await w.store.lesson.mustGet(row.id);
      expect(fresh.status).toBe("active");
      expect(fresh.superseded_by).toBeNull();
      const file = await w.files.read(fresh.file_path as string);
      expect(file.flags).toEqual([`contradiction:${other.id}`]);
    }
  });

  it("treats an opposite-polarity pair as a contradiction even above the duplicate threshold", async () => {
    const a = await remember(w.ctx, { scope: "shared", text: ALWAYS, tags: ["windows"] });
    const b = await remember(w.ctx, { scope: "shared", text: NEVER, tags: ["windows"] });
    expect(b.action).toBe("inserted");
    const report = await consolidate(w.ctx, { scope: "shared" });
    expect(report.merged).toEqual([]);
    expect(report.contradictions.map((c) => [c.a, c.b])).toEqual([[a.lesson.id, b.lesson.id]]);
    expect(report.contradictions[0]?.cosine ?? 0).toBeGreaterThanOrEqual(0.9);
    expect(report.contradictions[0]?.reason).toMatch(/^always\/never/);
  });

  it("does not pair lessons without a shared tag or from different projects", async () => {
    await remember(w.ctx, { scope: "shared", text: USE, tags: ["windows"] });
    await remember(w.ctx, { scope: "shared", text: AVOID, tags: ["linux"] });
    expect((await consolidate(w.ctx, { scope: "shared" })).contradictions).toEqual([]);
    await remember(w.ctx, { scope: "critic", text: TEXTS.windows, projectId: w.project });
    await remember(w.ctx, { scope: "critic", text: TEXTS.windowsDup2, projectId: w.project2 });
    expect((await consolidate(w.ctx, { scope: "critic" })).merged).toEqual([]);
  });

  it("retires unused and stale lessons by the simulated clock, never pinned ones", async () => {
    const neverUsed = await remember(w.ctx, { scope: "critic", text: TEXTS.windows, tags: ["a"] });
    const usedOnce = await remember(w.ctx, { scope: "critic", text: TEXTS.vault, tags: ["b"] });
    const pinned = await remember(w.ctx, { scope: "critic", text: TEXTS.vitest, pinned: true });
    await recall(w.ctx, { scopes: ["critic"], agentId: w.critic, query: TEXTS.vault, tags: ["b"] });
    expect((await w.store.lesson.mustGet(usedOnce.lesson.id)).hit_count).toBe(1);

    await w.clock.advance(40 * DAY_MS);
    const young = await remember(w.ctx, { scope: "critic", text: TEXTS.budget, tags: ["c"] });
    expect((await consolidate(w.ctx, { scope: "critic" })).retired).toEqual([]);

    await w.clock.advance(21 * DAY_MS); // day 61
    const at61 = await consolidate(w.ctx, { scope: "critic" });
    expect(at61.retired).toEqual([neverUsed.lesson.id]);
    expect(at61.proposals).toEqual([
      expect.stringMatching(/^retire: .* never used, created 2026-03-02/),
    ]);
    expect((await w.store.lesson.mustGet(neverUsed.lesson.id)).status).toBe("active");

    await w.clock.advance(39 * DAY_MS); // day 100: usedOnce last used 100 days ago, young is 60 days old
    const at100 = await consolidate(w.ctx, { scope: "critic", apply: true });
    expect(at100.retired.sort()).toEqual([neverUsed.lesson.id, usedOnce.lesson.id].sort());
    expect(at100.proposals).toEqual(
      expect.arrayContaining([expect.stringMatching(/last used 2026-03-02/)]),
    );
    expect((await w.store.lesson.mustGet(neverUsed.lesson.id)).status).toBe("retired");
    expect((await w.store.lesson.mustGet(usedOnce.lesson.id)).status).toBe("retired");
    expect((await w.store.lesson.mustGet(pinned.lesson.id)).status).toBe("active");
    expect((await w.store.lesson.mustGet(young.lesson.id)).status).toBe("active");
    expect((await w.files.read(usedOnce.lesson.file_path as string)).status).toBe("retired");
  });

  it("honours custom thresholds and needs an owner for a private plan", async () => {
    await remember(w.ctx, { scope: "shared", text: TEXTS.windows, tags: ["windows"] });
    await remember(w.ctx, { scope: "shared", text: TEXTS.windowsDup2, tags: ["windows"] });
    expect(
      (await consolidate(w.ctx, { scope: "shared", duplicateThreshold: 0.95 })).merged,
    ).toEqual([]);
    try {
      await consolidate(w.ctx, { scope: "agent_private" });
      throw new Error("expected a throw");
    } catch (e) {
      expect(isForerunnerError(e, "validation")).toBe(true);
    }
    await remember(w.ctx, { scope: "agent_private", ownerAgentId: w.alice, text: TEXTS.vault });
    const mine = await consolidate(w.ctx, { scope: "agent_private", ownerAgentId: w.alice });
    expect(mine.ownerAgentId).toBe(w.alice);
    expect(mine.retired).toEqual([]);
  });
});

/** A merge must never narrow visibility: a group with a global member stays global. */
describe("consolidate (project boundary)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  it("keeps the surviving lesson global when any merged lesson was global", async () => {
    const scoped = await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.windows,
      tags: ["windows"],
      projectId: w.project,
    });
    const global = await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.windowsDup2,
      tags: ["windows"],
    });
    expect(global.action).toBe("inserted");
    // The project lesson is the most used, so it is the one kept.
    for (let i = 0; i < 3; i++) await w.store.lesson.touch(scoped.lesson.id);

    const report = await consolidate(w.ctx, { scope: "shared" });
    expect(report.merged).toEqual([
      {
        keptId: scoped.lesson.id,
        retiredIds: [global.lesson.id],
        cosine: expect.any(Number),
        projectId: null,
      },
    ]);
    expect(report.proposals[0]).toMatch(/becomes global/);
    expect((await w.store.lesson.mustGet(scoped.lesson.id)).project_id).toBe(w.project);

    const beforeApply = await w.store.lesson.mustGet(scoped.lesson.id);
    await consolidate(w.ctx, { scope: "shared", apply: true });
    const kept = await w.store.lesson.mustGet(scoped.lesson.id);
    expect(kept.project_id).toBeNull();
    expect(kept.version).toBe(beforeApply.version + 1);
    expect((await w.files.read(kept.file_path as string)).project_id).toBeNull();
    const elsewhere = await recall(w.ctx, {
      scopes: ["shared"],
      agentId: w.bob,
      projectId: w.project2,
      query: TEXTS.windows,
      tags: ["windows"],
      touch: false,
    });
    expect(elsewhere.lessons.map((l) => l.lesson.id)).toEqual([scoped.lesson.id]);

    // Two lessons of one project keep that project.
    const p1 = await remember(w.ctx, { scope: "critic", text: TEXTS.vault, projectId: w.project });
    await remember(
      w.ctx,
      { scope: "critic", text: TEXTS.vault, projectId: w.project },
      { noDedup: true },
    );
    const critic = await consolidate(w.ctx, { scope: "critic", apply: true });
    expect(critic.merged[0]?.projectId).toBe(w.project);
    expect((await w.store.lesson.mustGet(p1.lesson.id)).project_id).toBe(w.project);
  });
});
