import { isForerunnerError } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  offerToProjects,
  pendingPromotions,
  promote,
  proposePromotion,
  rejectPromotion,
} from "../src/promotion.ts";
import { parseSource, remember } from "../src/record.ts";
import { recall } from "../src/retrieval.ts";
import { TEXTS, type World, world } from "./helpers.ts";

describe("promotion", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  const expectCode = async (p: Promise<unknown>, code: string, re?: RegExp) => {
    try {
      await p;
      throw new Error("expected a throw");
    } catch (e) {
      expect(isForerunnerError(e) ? e.code : String(e)).toBe(code);
      if (re) expect((e as Error).message).toMatch(re);
    }
  };

  it("proposes only active lessons tagged general, idempotently", async () => {
    const plain = await remember(w.ctx, {
      scope: "critic",
      text: TEXTS.windows,
      projectId: w.project,
    });
    await expectCode(proposePromotion(w.ctx, plain.lesson.id), "validation", /general/);

    const origin = await remember(w.ctx, {
      scope: "critic",
      text: TEXTS.vitest,
      tags: ["general", "testing"],
      projectId: w.project,
      confidence: 0.9,
    });
    const proposed = await proposePromotion(w.ctx, origin.lesson.id, { agentId: w.critic });
    expect(proposed.scope).toBe("shared");
    expect(proposed.status).toBe("proposed");
    expect(proposed.project_id).toBeNull();
    expect(proposed.text).toBe(TEXTS.vitest);
    expect(proposed.confidence).toBe(0.9);
    expect(parseSource(proposed.source)).toEqual({ promotion: origin.lesson.id });
    expect((await proposePromotion(w.ctx, origin.lesson.id)).id).toBe(proposed.id);
    expect((await pendingPromotions(w.ctx)).map((p) => p.id)).toEqual([proposed.id]);
    // The origin is untouched and a proposal is not retrievable.
    expect((await w.store.lesson.mustGet(origin.lesson.id)).status).toBe("active");
    const seen = await recall(w.ctx, {
      scopes: ["shared"],
      agentId: w.bob,
      projectId: w.project2,
      query: TEXTS.vitest,
      tags: ["testing"],
    });
    expect(seen.lessons).toEqual([]);
    await expectCode(proposePromotion(w.ctx, proposed.id), "validation", /active/);
  });

  it("a private lesson is proposed only by its owner after the human approved the text", async () => {
    const mine = await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.alice,
      text: TEXTS.budget,
      tags: ["general", "budget"],
    });
    await expectCode(
      proposePromotion(w.ctx, mine.lesson.id, { agentId: w.bob }),
      "autonomy_insufficient",
    );
    await expectCode(
      proposePromotion(w.ctx, mine.lesson.id, { agentId: w.alice }),
      "approval_required",
    );
    const proposed = await proposePromotion(w.ctx, mine.lesson.id, {
      agentId: w.alice,
      humanApproval: { humanId: w.humanId },
    });
    expect(proposed.scope).toBe("shared");
    expect(proposed.author_human).toBe(w.humanId);
    const original = await w.store.lesson.mustGet(mine.lesson.id);
    expect(original.scope).toBe("agent_private");
    expect(original.status).toBe("active");
    expect(original.superseded_by).toBeNull();
  });

  it("refuses text that cites ids outside the shared scope", async () => {
    // A private id is already refused when the lesson is written (record.test.ts); a critic
    // id passes the write-time check and is still outside the destination scope.
    const other = await remember(w.ctx, { scope: "critic", text: TEXTS.windows });
    const citing = await remember(w.ctx, {
      scope: "critic",
      text: `See ${other.lesson.id} for the Windows path rule before merging.`,
      tags: ["general"],
    });
    expect(citing.action).toBe("inserted");
    await expectCode(
      proposePromotion(w.ctx, citing.lesson.id),
      "validation",
      /outside the shared scope/,
    );
  });

  it("promotes after an accepting critic review and retires a shared project-level origin", async () => {
    const origin = await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.windows,
      tags: ["general", "windows"],
      projectId: w.project,
    });
    const proposed = await proposePromotion(w.ctx, origin.lesson.id);
    await expectCode(promote(w.ctx, proposed.id, { reviewId: "" }), "approval_required");
    const revise = await w.store.review.insert({
      critic_model: "fake",
      verdict: "revise",
      tier: 1,
    });
    await expectCode(
      promote(w.ctx, proposed.id, { reviewId: revise.id }),
      "approval_required",
      /did not accept/,
    );
    await expectCode(promote(w.ctx, proposed.id, { reviewId: "rev_missing" }), "not_found");
    const accept = await w.store.review.insert({
      critic_model: "fake",
      verdict: "accept",
      tier: 1,
    });

    const promoted = await promote(w.ctx, proposed.id, { reviewId: accept.id });
    expect(promoted.id).toBe(proposed.id);
    expect(promoted.status).toBe("active");
    expect(promoted.project_id).toBeNull();
    expect(parseSource(promoted.source)).toEqual({
      promotion: origin.lesson.id,
      approved_by: accept.id,
    });
    const file = await w.files.read(promoted.file_path as string);
    expect(file.status).toBe("active");
    const retired = await w.store.lesson.mustGet(origin.lesson.id);
    expect(retired.status).toBe("retired");
    expect(retired.superseded_by).toBe(promoted.id);
    await expectCode(promote(w.ctx, proposed.id, { reviewId: accept.id }), "validation", /pending/);

    // Another project now receives it through ordinary retrieval.
    const seen = await recall(w.ctx, {
      scopes: ["shared"],
      agentId: w.bob,
      projectId: w.project2,
      query: TEXTS.windows,
      tags: ["windows"],
    });
    expect(seen.lessons.map((l) => l.lesson.id)).toEqual([promoted.id]);
  });

  it("leaves a critic origin active after promotion and can reject a proposal", async () => {
    const origin = await remember(w.ctx, {
      scope: "critic",
      text: TEXTS.vault,
      tags: ["general", "vault"],
      projectId: w.project,
    });
    const proposed = await proposePromotion(w.ctx, origin.lesson.id);
    const accept = await w.store.review.insert({ critic_model: "fake", verdict: "accept" });
    await promote(w.ctx, proposed.id, { reviewId: accept.id });
    expect((await w.store.lesson.mustGet(origin.lesson.id)).status).toBe("active");

    const other = await remember(w.ctx, {
      scope: "critic",
      text: TEXTS.budget,
      tags: ["general", "budget"],
    });
    const second = await proposePromotion(w.ctx, other.lesson.id);
    const rejected = await rejectPromotion(w.ctx, second.id);
    expect(rejected.status).toBe("retired");
    expect((await w.store.lesson.mustGet(other.lesson.id)).status).toBe("active");
    expect(await pendingPromotions(w.ctx)).toEqual([]);
    await expectCode(rejectPromotion(w.ctx, second.id), "validation");
  });

  it("offers a promoted lesson to projects that share its tags, not to its origin", async () => {
    const origin = await remember(w.ctx, {
      scope: "critic",
      text: TEXTS.windows,
      tags: ["general", "windows", "ci"],
      projectId: w.project,
    });
    const proposed = await proposePromotion(w.ctx, origin.lesson.id);
    const accept = await w.store.review.insert({ critic_model: "fake", verdict: "accept" });
    const promoted = await promote(w.ctx, proposed.id, { reviewId: accept.id });

    const explicit = await offerToProjects(w.ctx, promoted.id, [
      { id: w.project, tags: ["windows", "ci"] },
      { id: w.project2, tags: ["ci"] },
      { id: "prj_three", tags: ["general", "vault"] },
      { id: "prj_four", tags: ["windows", "ci", "general"] },
    ]);
    expect(explicit).toEqual([
      { projectId: "prj_four", sharedTags: ["ci", "windows"] },
      { projectId: w.project2, sharedTags: ["ci"] },
    ]);

    // Derived from what is recorded about each project when no list is given.
    await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.vitest,
      tags: ["windows"],
      projectId: w.project2,
    });
    expect(await offerToProjects(w.ctx, promoted.id)).toEqual([
      { projectId: w.project2, sharedTags: ["windows"] },
    ]);
  });
});
