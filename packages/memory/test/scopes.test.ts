import { isForerunnerError } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remember } from "../src/record.ts";
import { recall } from "../src/retrieval.ts";
import { grantFor } from "../src/service.ts";
import { TEXTS, type World, world } from "./helpers.ts";

/**
 * Spec "Privacy between collaborators" (S.10) and G.1: the three scopes are never mixed and an
 * agent cannot read another agent's private memory. Enforced in code, proven here.
 */
describe("scope isolation", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
    await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.alice,
      text: TEXTS.windows,
      tags: ["windows", "ci"],
    });
    await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.bob,
      text: TEXTS.vault,
      tags: ["vault", "secrets"],
    });
    await remember(w.ctx, { scope: "critic", text: TEXTS.vitest, tags: ["vitest", "testing"] });
    await remember(w.ctx, { scope: "shared", text: TEXTS.budget, tags: ["budget", "critic"] });
  });
  afterEach(async () => {
    await w.close();
  });

  it("agent B asking with agent A's id as owner gets nothing", async () => {
    const res = await recall(w.ctx, {
      scopes: ["agent_private"],
      agentId: w.bob,
      ownerAgentId: w.alice,
      query: TEXTS.windows,
      tags: ["windows"],
    });
    expect(res.lessons).toEqual([]);
    expect(res.candidates).toBe(0);
    expect(res.denied).toEqual([
      { scope: "agent_private", reason: expect.stringContaining(w.alice) },
    ]);
    // Alice's lesson is untouched by the attempt.
    const [alice] = await w.store.lesson.list({ scope: "agent_private", owner_agent_id: w.alice });
    expect(alice?.hit_count).toBe(0);
  });

  it("asking for agent_private without an owner throws", async () => {
    try {
      await recall(w.ctx, { scopes: ["agent_private"], agentId: w.bob, query: "anything" });
      throw new Error("expected a throw");
    } catch (e) {
      expect(isForerunnerError(e, "validation")).toBe(true);
      expect((e as Error).message).toMatch(/ownerAgentId/);
    }
  });

  it("an agent reads only its own private memory", async () => {
    const res = await recall(w.ctx, {
      scopes: ["agent_private"],
      agentId: w.alice,
      ownerAgentId: w.alice,
      query: "vault secret names and windows paths",
      tags: ["vault", "windows"],
    });
    expect(res.lessons.map((l) => l.lesson.text)).toEqual([TEXTS.windows]);
    expect(res.lessons.every((l) => l.lesson.owner_agent_id === w.alice)).toBe(true);
    expect(res.denied).toEqual([]);
  });

  it("critic and shared scopes are readable by every principal", async () => {
    for (const agentId of [w.alice, w.bob, w.critic]) {
      const res = await recall(w.ctx, {
        scopes: ["critic", "shared"],
        agentId,
        query: "testing with vitest and the session budget",
        tags: ["vitest", "budget"],
        touch: false,
      });
      expect(res.lessons.map((l) => l.lesson.text).sort()).toEqual(
        [TEXTS.budget, TEXTS.vitest].sort(),
      );
    }
  });

  it("a critic grant can never return a private lesson", async () => {
    const grant = grantFor("critic", w.critic);
    expect(grant.scopes).toEqual(["critic", "shared"]);
    const res = await recall(w.ctx, {
      ...grant,
      query: TEXTS.windows,
      tags: ["windows", "ci"],
    });
    expect(res.lessons.some((l) => l.lesson.scope === "agent_private")).toBe(false);
    expect(res.lessons.map((l) => l.lesson.text)).not.toContain(TEXTS.windows);
  });

  it("grants come from the agent kind, not the caller", () => {
    expect(grantFor("principal", w.alice)).toEqual({
      agentId: w.alice,
      scopes: ["agent_private", "shared"],
      ownerAgentId: w.alice,
    });
    expect(grantFor("conversation", w.alice).scopes).toEqual(["agent_private", "shared"]);
    expect(grantFor("critic", w.critic).ownerAgentId).toBeUndefined();
    expect(grantFor("specialist", "agt_spec").scopes).toEqual([]);
  });

  it("private lesson files live under the owner's root only", async () => {
    const mine = await w.files.list("agent_private", w.alice);
    const his = await w.files.list("agent_private", w.bob);
    expect(mine.lessons.map((l) => l.doc.text)).toEqual([TEXTS.windows]);
    expect(his.lessons.map((l) => l.doc.text)).toEqual([TEXTS.vault]);
    expect(mine.lessons[0]?.path.startsWith(w.files.scopeRoot("agent_private", w.alice))).toBe(
      true,
    );
    // The state layer refuses a private search without an owner as well.
    await expect(w.store.lesson.search({ scope: "agent_private" })).rejects.toThrow(/ownerAgentId/);
  });
});
