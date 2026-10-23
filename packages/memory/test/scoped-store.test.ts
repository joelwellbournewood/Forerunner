import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  type Clock,
  ForerunnerError,
  isForerunnerError,
  join,
  SimulatedClock,
} from "@forerunner/platform";
import { type Database, LessonRepo, openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consolidate } from "../src/consolidation.ts";
import { HashedNgramEmbedder } from "../src/embedding.ts";
import { LessonFiles, reconcile } from "../src/files.ts";
import { pendingPromotions, promote, proposePromotion } from "../src/promotion.ts";
import { remember } from "../src/record.ts";
import { recall } from "../src/retrieval.ts";
import { ScopedLessonStore } from "../src/scoped-store.ts";
import { createMemory, grantFor, MemoryService } from "../src/service.ts";
import { LESSON_FORMAT, type LessonDoc, type MemoryContext } from "../src/types.ts";
import { TEXTS } from "./helpers.ts";

/**
 * Spec "whose private memory and keys each holds ... never leave that PC", G.1 "never mixed"
 * and ADR 0002: with a shared state store (Postgres in paired and hybrid mode) the private
 * scope lives in a local SQLite index and every other scope in the shared store. The memory
 * functions see one `LessonStore` (`ScopedLessonStore`) that routes by scope on writes and
 * unions the two on reads. The shared side here behaves as the Postgres adapter does (a private
 * write is refused with `MEMORY_SCOPE_VIOLATION`, `packages/state/test/lesson-scope.test.ts`)
 * over SQLite, so the suite needs no Postgres and still proves no private write is ever sent.
 */
class SharedLikePostgres extends LessonRepo {
  constructor(db: Database, clock: Clock) {
    super(db, clock);
  }
  private refuse(scope: unknown, op: string): void {
    if (scope === "agent_private")
      throw new ForerunnerError("MEMORY_SCOPE_VIOLATION", `shared store refused a private ${op}`, {
        details: { scope, dialect: "postgres", operation: op },
      });
  }
  override insert(input: Record<string, unknown>) {
    this.refuse(input.scope, "insert");
    return super.insert(input);
  }
  override updateWhere(
    patch: Parameters<LessonRepo["updateWhere"]>[0],
    whereSql: string,
    whereParams: unknown[],
    extra?: Parameters<LessonRepo["updateWhere"]>[3],
  ) {
    this.refuse((patch as { scope?: unknown }).scope, "update");
    return super.updateWhere(patch, whereSql, whereParams, extra);
  }
}

interface SplitWorld {
  clock: SimulatedClock;
  shared: StateStore;
  index: StateStore;
  root: string;
  files: LessonFiles;
  repo: ScopedLessonStore;
  ctx: MemoryContext;
  humanId: string;
  alice: string;
  bob: string;
  critic: string;
  project: string;
  close(): Promise<void>;
}

async function splitWorld(): Promise<SplitWorld> {
  const clock = new SimulatedClock("2026-10-23T07:00:00Z");
  const shared = await openStore({ url: "sqlite::memory:", clock });
  // The private index holds lesson rows only; its agent and project rows live in the shared
  // store, so it is opened without foreign keys (as the runtime opens it).
  const index = await openStore({ url: "sqlite::memory:", clock, sqlite: { foreignKeys: false } });
  const root = await mkdtemp(join(tmpdir(), "fr-memory-split-"));
  const human = await shared.human.insert({ name: "J", email: "j@example.test" });
  const human2 = await shared.human.insert({ name: "F", email: "f@example.test" });
  const alice = await shared.agent.insert({ name: "Alice", owner_human_id: human.id });
  const bob = await shared.agent.insert({ name: "Bob", owner_human_id: human2.id });
  const critic = await shared.agent.insert({
    name: "Critic",
    owner_human_id: human.id,
    kind: "critic",
  });
  const project = await shared.project.insert({ name: "pharmawatch" });
  const files = new LessonFiles(root);
  const sharedLessons = new SharedLikePostgres(shared.db, clock);
  const ctx = createMemory({
    store: { lesson: sharedLessons, clock },
    privateStore: { lesson: index.lesson },
    files,
    embedder: new HashedNgramEmbedder(),
    clock,
  });
  return {
    clock,
    shared,
    index,
    root,
    files,
    repo: ctx.repo as ScopedLessonStore,
    ctx,
    humanId: human.id,
    alice: alice.id,
    bob: bob.id,
    critic: critic.id,
    project: project.id,
    close: async () => {
      await shared.close();
      await index.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const expectCode = async (p: Promise<unknown>, code: string, re?: RegExp) => {
  try {
    await p;
    throw new Error("expected a throw");
  } catch (e) {
    expect(isForerunnerError(e) ? e.code : String(e)).toBe(code);
    if (re) expect((e as Error).message).toMatch(re);
  }
};

describe("the by-scope lesson store", () => {
  let w: SplitWorld;
  beforeEach(async () => {
    w = await splitWorld();
  });
  afterEach(async () => {
    await w.close();
  });

  it("is what createMemory builds when a private store is given", () => {
    expect(w.ctx.repo).toBeInstanceOf(ScopedLessonStore);
    expect(w.repo.storeFor("agent_private")).toBe(w.index.lesson);
    expect(w.repo.storeFor("critic")).not.toBe(w.index.lesson);
    expect(w.repo.storeFor("shared")).not.toBe(w.index.lesson);
  });

  it("writes a session's private lessons to the local index only, critic and shared ones to the shared store", async () => {
    const svc = new MemoryService(w.ctx);
    const mine = await svc.rememberFromSession({
      agentId: w.alice,
      sessionId: "ses_1",
      projectId: w.project,
      lessons: [{ text: TEXTS.windows, tags: ["windows", "ci"], confidence: 0.7 }],
    });
    expect(mine.rejected).toEqual([]);
    expect(mine.recorded.map((r) => r.action)).toEqual(["inserted"]);
    const criticLesson = await svc.rememberFromSession({
      agentId: w.critic,
      sessionId: "ses_1",
      projectId: w.project,
      scope: "critic",
      lessons: [{ text: TEXTS.vitest, tags: ["vitest"] }],
    });
    expect(criticLesson.rejected).toEqual([]);
    const sharedLesson = await remember(w.ctx, {
      scope: "shared",
      text: TEXTS.budget,
      tags: ["budget"],
    });

    expect(await w.index.lesson.count()).toBe(1);
    expect(await w.index.lesson.count({ scope: "agent_private", owner_agent_id: w.alice })).toBe(1);
    expect(await w.shared.lesson.count({ scope: "agent_private" })).toBe(0);
    expect(await w.shared.lesson.count({ scope: "critic" })).toBe(1);
    expect(await w.shared.lesson.count({ scope: "shared" })).toBe(1);

    // The files land in the usual roots: the file is canonical, the row is the index.
    const privateId = mine.recorded[0]?.lesson.id as string;
    expect(await readdir(join(w.root, "agents", w.alice, "lessons"))).toEqual([`${privateId}.md`]);
    expect(await readdir(join(w.root, "shared", "lessons"))).toEqual([
      `${sharedLesson.lesson.id}.md`,
    ]);

    // One store for the readers: every row is found through the facade, in its own store.
    expect((await w.repo.get(privateId))?.scope).toBe("agent_private");
    expect((await w.repo.mustGet(criticLesson.recorded[0]?.lesson.id as string)).scope).toBe(
      "critic",
    );
    expect(await w.repo.exists(sharedLesson.lesson.id)).toBe(true);
    expect(await w.repo.exists("les_missing")).toBe(false);
    await expectCode(w.repo.mustGet("les_missing"), "not_found");
  });

  it("recall unions the private index with the shared store for the owner and gives the critic no private row", async () => {
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
      tags: ["vault"],
    });
    await remember(w.ctx, { scope: "critic", text: TEXTS.vitest, tags: ["vitest", "ci"] });
    await remember(w.ctx, { scope: "shared", text: TEXTS.budget, tags: ["budget", "ci"] });

    const svc = new MemoryService(w.ctx);
    const alice = await svc.recallForSession({
      grant: grantFor("principal", w.alice),
      brief: "Windows CI job and the session budget for the critic",
      tags: ["ci"],
      maxTokens: 1500,
    });
    expect(alice.result.lessons.map((l) => l.lesson.scope).sort()).toEqual([
      "agent_private",
      "shared",
    ]);
    expect(alice.result.lessons.map((l) => l.lesson.text)).toContain(TEXTS.windows);
    expect(alice.result.lessons.map((l) => l.lesson.text)).not.toContain(TEXTS.vault);
    expect(alice.result.denied).toEqual([]);
    // Touching went to the store that holds the row.
    const touched = await w.index.lesson.list({ scope: "agent_private", owner_agent_id: w.alice });
    expect(touched[0]?.hit_count).toBe(1);
    expect(await w.shared.lesson.count({ scope: "agent_private" })).toBe(0);

    const critic = await recall(w.ctx, {
      scopes: grantFor("critic", w.critic).scopes,
      agentId: w.critic,
      query: "Windows CI job and vitest",
      tags: ["ci"],
    });
    expect(critic.lessons.map((l) => l.lesson.scope).sort()).toEqual(["critic", "shared"]);

    const bobAsAlice = await recall(w.ctx, {
      scopes: ["agent_private"],
      agentId: w.bob,
      ownerAgentId: w.alice,
      query: TEXTS.windows,
    });
    expect(bobAsAlice.lessons).toEqual([]);
    expect(bobAsAlice.denied).toHaveLength(1);
  });

  it("edits, pins, retires and deletes a row in the store that holds it", async () => {
    const mine = await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.alice,
      text: TEXTS.windows,
      tags: ["windows"],
    });
    const ours = await remember(w.ctx, { scope: "shared", text: TEXTS.budget, tags: ["budget"] });

    const edited = await w.repo.update(mine.lesson.id, mine.lesson.version, { confidence: 0.9 });
    expect(edited.confidence).toBe(0.9);
    expect((await w.index.lesson.mustGet(mine.lesson.id)).confidence).toBe(0.9);
    const pinned = await w.repo.setPinned(mine.lesson.id, edited.version, true);
    expect(pinned.pinned).toBe(true);
    const touched = await w.repo.touch(ours.lesson.id);
    expect(touched.hit_count).toBe(1);
    expect((await w.shared.lesson.mustGet(ours.lesson.id)).hit_count).toBe(1);
    const retired = await w.repo.retire(ours.lesson.id, touched.version);
    expect(retired.status).toBe("retired");
    await expectCode(w.repo.update("les_missing", 1, { confidence: 0.1 }), "not_found");
    await expectCode(w.repo.touch("les_missing"), "not_found");
    expect(await w.repo.delete(mine.lesson.id)).toBe(true);
    expect(await w.repo.delete(mine.lesson.id)).toBe(false);
    expect(await w.index.lesson.count()).toBe(0);
    expect(await w.shared.lesson.count()).toBe(1);
  });

  it("never moves a row between the stores: a scope change across the boundary is refused", async () => {
    const mine = await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.alice,
      text: TEXTS.windows,
      tags: ["windows"],
    });
    const ours = await remember(w.ctx, { scope: "shared", text: TEXTS.budget, tags: ["budget"] });
    await expectCode(
      w.repo.update(mine.lesson.id, mine.lesson.version, { scope: "shared", owner_agent_id: null }),
      "MEMORY_SCOPE_VIOLATION",
    );
    await expectCode(
      w.repo.patch(ours.lesson.id, { scope: "agent_private", owner_agent_id: w.alice }),
      "MEMORY_SCOPE_VIOLATION",
    );
    await expectCode(
      w.repo.supersede(mine.lesson.id, { text: TEXTS.windowsDup, scope: "shared" }),
      "MEMORY_SCOPE_VIOLATION",
    );
    await expectCode(
      w.repo.supersede(ours.lesson.id, {
        text: TEXTS.windowsDup,
        scope: "agent_private",
        owner_agent_id: w.alice,
      }),
      "MEMORY_SCOPE_VIOLATION",
    );
    expect((await w.index.lesson.mustGet(mine.lesson.id)).version).toBe(mine.lesson.version);
    expect((await w.shared.lesson.mustGet(ours.lesson.id)).version).toBe(ours.lesson.version);
    expect(await w.shared.lesson.count({ scope: "agent_private" })).toBe(0);
    expect(await w.index.lesson.count({ scope: "shared" })).toBe(0);
    await expectCode(
      w.repo.insert({ scope: "nowhere", text: "no such scope, nowhere to route it" }),
      "validation",
    );

    // Within one store the near-duplicate merge still supersedes (the private index keeps both rows).
    const merged = await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.alice,
      text: TEXTS.windowsDup,
      tags: ["ci"],
    });
    expect(merged.action).toBe("merged");
    expect(merged.supersededId).toBe(mine.lesson.id);
    expect(await w.index.lesson.count({ scope: "agent_private", owner_agent_id: w.alice })).toBe(2);
    expect((await w.index.lesson.mustGet(mine.lesson.id)).superseded_by).toBe(merged.lesson.id);
  });

  it("promotion copies a private general lesson into the shared store and leaves the origin at home", async () => {
    const origin = await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.alice,
      text: TEXTS.vitest,
      tags: ["general", "testing"],
      projectId: w.project,
      confidence: 0.9,
    });
    const proposed = await proposePromotion(w.ctx, origin.lesson.id, {
      agentId: w.alice,
      humanApproval: { humanId: w.humanId },
    });
    expect(proposed.scope).toBe("shared");
    expect(proposed.status).toBe("proposed");
    expect((await w.shared.lesson.mustGet(proposed.id)).status).toBe("proposed");
    expect(await w.index.lesson.get(proposed.id)).toBeUndefined();
    expect((await pendingPromotions(w.ctx)).map((p) => p.id)).toEqual([proposed.id]);

    const promoted = await promote(w.ctx, proposed.id, { reviewId: "rev_accepting" });
    expect(promoted.status).toBe("active");
    expect(promoted.project_id).toBeNull();
    expect(promoted.source).toContain(`promotion:${origin.lesson.id}`);
    // The private origin is untouched and still only in the index; the copy is only shared.
    const home = await w.index.lesson.mustGet(origin.lesson.id);
    expect(home.status).toBe("active");
    expect(home.superseded_by).toBeNull();
    expect(await w.shared.lesson.count({ scope: "agent_private" })).toBe(0);
    expect(await w.index.lesson.count({ scope: "shared" })).toBe(0);
    const bob = await recall(w.ctx, {
      scopes: grantFor("principal", w.bob).scopes,
      agentId: w.bob,
      ownerAgentId: w.bob,
      query: TEXTS.vitest,
      tags: ["testing"],
    });
    expect(bob.lessons.map((l) => l.lesson.id)).toEqual([promoted.id]);
  });

  it("consolidates the private scope on the index and the shared scope on the shared store", async () => {
    const a = await remember(
      w.ctx,
      { scope: "agent_private", ownerAgentId: w.alice, text: TEXTS.windows, tags: ["ci"] },
      { noDedup: true },
    );
    const b = await remember(
      w.ctx,
      { scope: "agent_private", ownerAgentId: w.alice, text: TEXTS.windowsDup, tags: ["ci"] },
      { noDedup: true },
    );
    const c = await remember(
      w.ctx,
      { scope: "shared", text: TEXTS.windows, tags: ["ci"] },
      { noDedup: true },
    );
    const d = await remember(
      w.ctx,
      { scope: "shared", text: TEXTS.windowsDup, tags: ["ci"] },
      { noDedup: true },
    );
    const mine = await consolidate(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.alice,
      apply: true,
    });
    expect(mine.merged).toHaveLength(1);
    expect(new Set([mine.merged[0]?.keptId, ...(mine.merged[0]?.retiredIds ?? [])])).toEqual(
      new Set([a.lesson.id, b.lesson.id]),
    );
    expect(await w.index.lesson.count({ scope: "agent_private", status: "retired" })).toBe(1);
    // The shared pair is untouched until its own run.
    expect(await w.shared.lesson.count({ scope: "shared", status: "retired" })).toBe(0);
    const ours = await consolidate(w.ctx, { scope: "shared", apply: true });
    expect(new Set([ours.merged[0]?.keptId, ...(ours.merged[0]?.retiredIds ?? [])])).toEqual(
      new Set([c.lesson.id, d.lesson.id]),
    );
    expect(await w.shared.lesson.count({ scope: "shared", status: "retired" })).toBe(1);
    expect(await w.shared.lesson.count({ scope: "agent_private" })).toBe(0);
  });

  it("reconciles a private root into the index and never into the shared store", async () => {
    const now = w.clock.nowIso();
    const doc: LessonDoc = {
      id: "les_handwritten_private",
      scope: "agent_private",
      owner_agent_id: w.alice,
      project_id: null,
      text: TEXTS.vault,
      source: "human:j",
      tags: ["vault"],
      confidence: 0.6,
      last_used: null,
      hit_count: 0,
      superseded_by: null,
      pinned: false,
      status: "active",
      created_at: now,
      updated_at: now,
      author_agent: null,
      author_human: w.humanId,
      version: 1,
      flags: [],
    };
    await w.files.write(doc);
    const report = await reconcile(w.files, w.ctx.repo, w.ctx.embedder, "agent_private", w.alice);
    expect(report.upserted).toEqual([doc.id]);
    expect(report.embedder.reembedded).toBe(true);
    const row = await w.index.lesson.mustGet(doc.id);
    expect(row.text).toBe(TEXTS.vault);
    expect(row.version).toBe(1);
    expect(row.created_at).toBe(now);
    expect(await w.shared.lesson.get(doc.id)).toBeUndefined();
    // A second run finds the row in place and changes nothing.
    const again = await reconcile(w.files, w.ctx.repo, w.ctx.embedder, "agent_private", w.alice);
    expect(again.unchanged).toEqual([doc.id]);
    expect(again.upserted).toEqual([]);
    expect((await w.files.readIndexMeta("agent_private", w.alice))?.format).toBe(LESSON_FORMAT);
  });

  it("lists one store for a scoped filter and both for an unscoped one", async () => {
    await remember(w.ctx, {
      scope: "agent_private",
      ownerAgentId: w.alice,
      text: TEXTS.windows,
      tags: ["windows"],
    });
    await remember(w.ctx, { scope: "critic", text: TEXTS.vitest, tags: ["vitest"] });
    await remember(w.ctx, { scope: "shared", text: TEXTS.budget, tags: ["budget"] });
    expect((await w.repo.list({ scope: "agent_private" })).map((r) => r.scope)).toEqual([
      "agent_private",
    ]);
    expect((await w.repo.list({ scope: "critic" })).map((r) => r.scope)).toEqual(["critic"]);
    expect((await w.repo.list()).map((r) => r.scope).sort()).toEqual([
      "agent_private",
      "critic",
      "shared",
    ]);
    expect(await w.repo.count()).toBe(3);
    expect(await w.repo.count({ scope: ["critic", "shared"] })).toBe(2);
    expect(await w.repo.count({ scope: "agent_private" })).toBe(1);
    expect(
      (await w.repo.search({ scope: "agent_private", ownerAgentId: w.alice, text: "windows" })).map(
        (r) => r.text,
      ),
    ).toEqual([TEXTS.windows]);
    expect((await w.repo.search({ scope: "shared", tags: ["budget"] })).map((r) => r.text)).toEqual(
      [TEXTS.budget],
    );
  });
});
