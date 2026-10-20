import { isForerunnerError } from "@forerunner/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposePromotion } from "../src/promotion.ts";
import {
  formatSource,
  NEAR_DUPLICATE,
  parseSource,
  type RememberInput,
  remember,
} from "../src/record.ts";
import { recall } from "../src/retrieval.ts";
import { MemoryService } from "../src/service.ts";
import { DAY_MS, TEXTS, type World, world } from "./helpers.ts";

describe("remember", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  const expectValidation = async (input: RememberInput, re: RegExp) => {
    try {
      await remember(w.ctx, input);
      throw new Error(`expected validation error for ${JSON.stringify(input)}`);
    } catch (e) {
      expect(isForerunnerError(e, "validation")).toBe(true);
      expect((e as Error).message).toMatch(re);
    }
  };

  it("validates text length, tags, confidence, source and ownership", async () => {
    await expectValidation({ scope: "shared", text: "too short" }, /invalid lesson/);
    await expectValidation({ scope: "shared", text: "x".repeat(2001) }, /invalid lesson/);
    await expectValidation({ scope: "shared", text: TEXTS.windows, tags: ["Windows"] }, /kebab/);
    await expectValidation({ scope: "shared", text: TEXTS.windows, tags: ["a b"] }, /kebab/);
    await expectValidation(
      { scope: "shared", text: TEXTS.windows, confidence: 1.2 },
      /invalid lesson/,
    );
    await expectValidation(
      { scope: "shared", text: TEXTS.windows, source: "bad source" },
      /source/,
    );
    await expectValidation({ scope: "agent_private", text: TEXTS.windows }, /ownerAgentId/);
    await expectValidation(
      { scope: "shared", text: TEXTS.windows, ownerAgentId: w.alice },
      /cannot have an owner/,
    );
  });

  it("writes the file and the mirrored row", async () => {
    const res = await remember(w.ctx, {
      scope: "shared",
      text: `  ${TEXTS.windows}\r\n`,
      tags: ["windows", "ci", "windows"],
      source: "session:ses_1",
      confidence: 0.8,
      projectId: w.project,
      authorAgent: w.alice,
    });
    expect(res.action).toBe("inserted");
    expect(res.lesson.text).toBe(TEXTS.windows);
    expect(res.lesson.tags).toEqual(["ci", "windows"]);
    expect(res.lesson.file_path).toBe(res.filePath);
    expect(res.lesson.embedding?.length).toBe(256);
    expect(res.lesson.created_at).toBe(w.clock.nowIso());
    expect(res.lesson.project_id).toBe(w.project);
    expect(res.lesson.author_agent).toBe(w.alice);
    const file = await w.files.read(res.filePath);
    expect(file.id).toBe(res.lesson.id);
    expect(file.text).toBe(TEXTS.windows);
    expect(file.tags).toEqual(["ci", "windows"]);
    expect(file.version).toBe(1);
  });

  it("merges a near-duplicate in the same scope instead of inserting", async () => {
    const first = await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.windows,
      tags: ["windows"],
      confidence: 0.6,
      source: "session:ses_1",
    });
    await w.store.lesson.touch(first.lesson.id);
    await w.clock.advance(DAY_MS);
    const second = await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.windowsDup,
      tags: ["ci"],
      confidence: 0.9,
      source: "review:rev_2",
    });
    expect(second.action).toBe("merged");
    expect(second.supersededId).toBe(first.lesson.id);
    expect(second.similarity ?? 0).toBeGreaterThanOrEqual(NEAR_DUPLICATE);
    expect(second.lesson.text).toBe(TEXTS.windowsDup);
    expect(second.lesson.tags).toEqual(["ci", "windows"]);
    expect(second.lesson.confidence).toBe(0.9);
    expect(second.lesson.hit_count).toBe(1);
    expect(second.lesson.last_used).not.toBeNull();
    expect(second.lesson.file_path).toBe(second.filePath);

    const old = await w.store.lesson.mustGet(first.lesson.id);
    expect(old.status).toBe("retired");
    expect(old.superseded_by).toBe(second.lesson.id);
    const oldFile = await w.files.read(first.filePath);
    expect(oldFile.superseded_by).toBe(second.lesson.id);
    expect(oldFile.status).toBe("retired");
    expect((await w.files.read(second.filePath)).text).toBe(TEXTS.windowsDup);
    expect(await w.store.lesson.list({ scope: "shared", status: "active" })).toHaveLength(1);
  });

  it("inserts when the similarity is below the threshold", async () => {
    await remember(w.ctx, { scope: "shared", text: TEXTS.windows });
    const res = await remember(w.ctx, { scope: "shared", text: TEXTS.windowsDup2 });
    expect(res.action).toBe("inserted");
    expect(await w.store.lesson.list({ scope: "shared", status: "active" })).toHaveLength(2);
    const unrelated = await remember(w.ctx, { scope: "shared", text: TEXTS.vault });
    expect(unrelated.action).toBe("inserted");
  });

  it("never merges across scopes, owners or projects", async () => {
    await remember(w.ctx, { scope: "critic", text: TEXTS.windows });
    expect((await remember(w.ctx, { scope: "shared", text: TEXTS.windows })).action).toBe(
      "inserted",
    );
    await remember(w.ctx, { scope: "agent_private", ownerAgentId: w.alice, text: TEXTS.vault });
    expect(
      (await remember(w.ctx, { scope: "agent_private", ownerAgentId: w.bob, text: TEXTS.vault }))
        .action,
    ).toBe("inserted");
    await remember(w.ctx, { scope: "shared", text: TEXTS.vitest, projectId: w.project });
    expect(
      (await remember(w.ctx, { scope: "shared", text: TEXTS.vitest, projectId: w.project2 }))
        .action,
    ).toBe("inserted");
    // A global lesson (no project) does merge with a project one about the same thing.
    expect((await remember(w.ctx, { scope: "shared", text: TEXTS.vitest })).action).toBe("merged");
  });

  it("does not merge an opposite-polarity near-duplicate; consolidation flags it instead", async () => {
    await remember(w.ctx, {
      scope: "shared",
      text: "Always run the Windows CI job before merging a change that touches file paths.",
    });
    const res = await remember(w.ctx, {
      scope: "shared",
      text: "Never run the Windows CI job before merging a change that touches file paths.",
    });
    expect(res.action).toBe("inserted");
    expect(await w.store.lesson.list({ scope: "shared", status: "active" })).toHaveLength(2);
  });

  it("can skip the dedup for explicit copies", async () => {
    await remember(w.ctx, { scope: "shared", text: TEXTS.windows });
    const copy = await remember(w.ctx, { scope: "shared", text: TEXTS.windows }, { noDedup: true });
    expect(copy.action).toBe("inserted");
    expect(await w.store.lesson.list({ scope: "shared", status: "active" })).toHaveLength(2);
  });

  it("parses and formats the source grammar", () => {
    expect(parseSource("promotion:abc;approved_by:rev_1")).toEqual({
      promotion: "abc",
      approved_by: "rev_1",
    });
    expect(parseSource("")).toEqual({});
    expect(formatSource({ promotion: "abc", approved_by: "", session: "s1" })).toBe(
      "promotion:abc;session:s1",
    );
  });
});

/** Critic findings on the first build: merge visibility, cross-scope references, write ownership. */
describe("remember (scope and ownership rules)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.close();
  });

  it("keeps a merged lesson global when either side is global", async () => {
    // Project lesson first, then the same lesson recorded globally: the merge must not narrow it.
    const scoped = await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.windows,
      tags: ["windows"],
      projectId: w.project,
    });
    const merged = await remember(w.ctx, { scope: "shared", text: TEXTS.windowsDup });
    expect(merged.action).toBe("merged");
    expect(merged.supersededId).toBe(scoped.lesson.id);
    expect(merged.lesson.project_id).toBeNull();
    expect((await w.files.read(merged.filePath)).project_id).toBeNull();
    const elsewhere = await recall(w.ctx, {
      scopes: ["shared"],
      agentId: w.bob,
      projectId: w.project2,
      query: TEXTS.windows,
      tags: ["windows"],
      touch: false,
    });
    expect(elsewhere.lessons.map((l) => l.lesson.id)).toEqual([merged.lesson.id]);

    // The other direction: a global lesson followed by a project one stays global too.
    const global = await remember(w.ctx, { scope: "critic", text: TEXTS.vault, tags: ["vault"] });
    const again = await remember(w.ctx, {
      scope: "critic",
      text: TEXTS.vault,
      tags: ["vault"],
      projectId: w.project,
    });
    expect(again.action).toBe("merged");
    expect(again.supersededId).toBe(global.lesson.id);
    expect(again.lesson.project_id).toBeNull();

    // Two lessons of the same project merge into that project.
    const mine = await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.vitest,
      projectId: w.project2,
    });
    const same = await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.vitest,
      projectId: w.project2,
    });
    expect(same.supersededId).toBe(mine.lesson.id);
    expect(same.lesson.project_id).toBe(w.project2);
  });

  it("refuses a critic or shared lesson that cites a private lesson id", async () => {
    const mine = await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.alice,
      text: TEXTS.windows,
    });
    const citing = `See ${mine.lesson.id} for the Windows path rule before merging a change.`;
    for (const scope of ["shared", "critic"] as const) {
      try {
        await remember(w.ctx, { scope, text: citing });
        throw new Error("expected a throw");
      } catch (e) {
        expect(isForerunnerError(e, "validation")).toBe(true);
        expect((e as Error).message).toMatch(/private lesson/);
      }
    }
    expect(await w.store.lesson.list({ scope: "shared" })).toEqual([]);
    // A shared id may be cited by anyone; private memory may cite anything.
    const shared = await remember(w.ctx, { scope: "shared", text: TEXTS.vault });
    const ok = await remember(w.ctx, {
      scope: "critic",
      text: `Lesson ${shared.lesson.id} covers the vault naming rule; apply it in reviews.`,
    });
    expect(ok.action).toBe("inserted");
    const privateCiting = await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.bob,
      text: `${mine.lesson.id} is another agent's id that I noted from a shared review thread.`,
    });
    expect(privateCiting.action).toBe("inserted");
    // Promotion still refuses the same text later on.
    const general = await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.alice,
      text: citing,
      tags: ["general"],
    });
    await expect(
      proposePromotion(w.ctx, general.lesson.id, {
        agentId: w.alice,
        humanApproval: { humanId: w.humanId },
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("refuses a private write on behalf of another agent when the acting agent is known", async () => {
    try {
      await remember(w.ctx, {
        scope: "agent_private",
        ownerAgentId: w.alice,
        agentId: w.bob,
        text: TEXTS.vault,
      });
      throw new Error("expected a throw");
    } catch (e) {
      expect(isForerunnerError(e, "autonomy_insufficient")).toBe(true);
      expect((e as Error).message).toMatch(new RegExp(w.alice));
    }
    expect((await w.files.list("agent_private", w.alice)).lessons).toEqual([]);
    expect(await w.store.lesson.list({ scope: "agent_private", owner_agent_id: w.alice })).toEqual(
      [],
    );
    const own = await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.alice,
      agentId: w.alice,
      text: TEXTS.vault,
    });
    expect(own.action).toBe("inserted");
    expect(own.filePath.startsWith(w.files.scopeRoot("agent_private", w.alice))).toBe(true);
    // The service never lets the caller choose the owner: it is the acting agent.
    const svc = new MemoryService(w.ctx);
    const viaService = await svc.rememberFromSession({
      agentId: w.bob,
      sessionId: "ses_1",
      lessons: [{ text: TEXTS.windows }],
    });
    expect(viaService.recorded[0]?.lesson.owner_agent_id).toBe(w.bob);
  });
});
