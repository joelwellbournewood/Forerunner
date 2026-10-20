import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  consolidate,
  createMemory,
  HashedNgramEmbedder,
  LessonFiles,
  type MemoryContext,
  recall,
  reconcile,
  remember,
} from "../src/index.ts";
import { TEXTS } from "./helpers.ts";

/**
 * Critic and shared rows live in Postgres in team mode (spec "Source of truth rules"). This
 * runs the write, recall, touch, consolidate and reconcile path once against the Postgres
 * dialect. Needs FORERUNNER_TEST_PG; without it the file is skipped with the reason in its name.
 * One schema per run, dropped at the end.
 */
const PG = process.env.FORERUNNER_TEST_PG;
const schema = `fr_memory_test_${randomBytes(4).toString("hex")}`;

describe.skipIf(!PG)(
  PG ? "memory on postgres" : "memory on postgres (skipped: FORERUNNER_TEST_PG not set)",
  () => {
    let store: StateStore;
    let root: string;
    let ctx: MemoryContext;
    let clock: SimulatedClock;
    let critic: string;
    let project: string;

    beforeAll(async () => {
      clock = new SimulatedClock("2026-03-02T07:00:00Z");
      store = await openStore({ url: PG as string, schema, clock });
      root = await mkdtemp(join(tmpdir(), "fr-memory-pg-"));
      const human = await store.human.insert({ name: "J", email: "j@example.test" });
      critic = (
        await store.agent.insert({ name: "Critic", owner_human_id: human.id, kind: "critic" })
      ).id;
      project = (await store.project.insert({ name: "pharmawatch" })).id;
      ctx = createMemory({
        store,
        files: new LessonFiles(root),
        embedder: new HashedNgramEmbedder(),
        clock,
      });
    });

    afterAll(async () => {
      if (store) {
        await store.db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await store.close();
      }
      if (root) await rm(root, { recursive: true, force: true });
    });

    it("records, recalls, touches, consolidates and reconciles shared lessons", async () => {
      const a = await remember(ctx, {
        scope: "shared",
        text: TEXTS.windows,
        tags: ["windows", "ci"],
        projectId: project,
        authorAgent: critic,
      });
      const b = await remember(ctx, {
        scope: "shared",
        text: TEXTS.windowsDup2,
        tags: ["windows"],
        projectId: project,
      });
      expect(b.action).toBe("inserted");
      expect(a.lesson.embedding?.length).toBe(256);
      expect(a.lesson.file_path).toBe(a.filePath);

      const res = await recall(ctx, {
        scopes: ["shared"],
        agentId: critic,
        projectId: project,
        query: "Windows CI job and path separators",
        tags: ["windows"],
        maxTokens: 400,
      });
      expect(res.lessons.map((l) => l.lesson.id)).toContain(a.lesson.id);
      expect(res.tokensUsed).toBeLessThanOrEqual(400);
      const touched = await store.lesson.mustGet(a.lesson.id);
      expect(touched.hit_count).toBe(1);
      expect(touched.last_used).toBe(clock.nowIso());
      expect((await ctx.files.read(touched.file_path as string)).hit_count).toBe(1);

      const report = await consolidate(ctx, { scope: "shared", apply: true });
      expect(report.merged).toEqual([
        {
          keptId: a.lesson.id,
          retiredIds: [b.lesson.id],
          cosine: expect.any(Number),
          projectId: project,
        },
      ]);
      expect((await store.lesson.mustGet(b.lesson.id)).superseded_by).toBe(a.lesson.id);

      // A root that was never reconciled has no index.json: the first walk re-embeds it once
      // (files and rows already agree), the second finds everything unchanged.
      const first = await reconcile(ctx.files, ctx.repo, ctx.embedder, "shared");
      expect(first.embedder).toEqual({ name: ctx.embedder.name, previous: null, reembedded: true });
      expect(first.upserted.sort()).toEqual([a.lesson.id, b.lesson.id].sort());
      expect((await store.lesson.mustGet(a.lesson.id)).text).toBe(TEXTS.windows);
      const rec = await reconcile(ctx.files, ctx.repo, ctx.embedder, "shared");
      expect(rec.embedder.reembedded).toBe(false);
      expect(rec.upserted).toEqual([]);
      expect(rec.unchanged.sort()).toEqual([a.lesson.id, b.lesson.id].sort());
      expect(rec.orphans).toEqual([]);
      expect(rec.invalid).toEqual([]);
    });
  },
);
