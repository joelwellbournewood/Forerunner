import {
  type Clock,
  type ForerunnerError,
  isForerunnerError,
  SimulatedClock,
} from "@forerunner/platform";
import { beforeEach, describe, expect, it } from "vitest";
import {
  isAppendOnlyViolation,
  isCheckViolation,
  isForeignKeyViolation,
} from "../src/db/dialect.ts";
import { MIGRATIONS, migrate, pendingMigrations } from "../src/migrations/index.ts";
import { Repository } from "../src/repos/base.ts";
import { allColumns, type ColumnDef, ENTITIES, type EntityDef, tableOrder } from "../src/schema.ts";
import type { StateStore } from "../src/store.ts";
import type { BaseRow, TaskRow } from "../src/types.ts";

/**
 * Conformance suite run against every adapter. `fresh(clock)` must return an empty,
 * migrated store bound to `clock` (a new in-memory database, or a truncated shared one).
 */
export interface SuiteTarget {
  name: string;
  fresh: (clock: Clock) => Promise<StateStore>;
}

const START = "2026-03-01T09:00:00.000Z";

async function seed(store: StateStore) {
  const human = await store.human.insert({ name: "Ada", email: "ada@example.test" });
  const human2 = await store.human.insert({ name: "Bob", email: "bob@example.test" });
  const alice = await store.agent.insert({ name: "Alice", owner_human_id: human.id });
  const bob = await store.agent.insert({ name: "Bob", owner_human_id: human2.id });
  const project = await store.project.insert({ name: "Demo" });
  const session = await store.session.insert({ agent_id: alice.id, project_id: project.id });
  return { human, human2, alice, bob, project, session };
}

async function expectCode(
  p: Promise<unknown>,
  code: ForerunnerError["code"],
): Promise<ForerunnerError> {
  try {
    await p;
  } catch (e) {
    if (isForerunnerError(e, code)) return e;
    throw new Error(`expected ForerunnerError(${code}), got ${String(e)}`);
  }
  throw new Error(`expected ForerunnerError(${code}), nothing was thrown`);
}

function minimalValue(col: ColumnDef, now: string): unknown {
  if (col.enum) return col.enum[col.enum.length - 1];
  if (col.check && col.default !== undefined) return col.default; // stay inside the range check
  switch (col.type) {
    case "text":
      return `${col.name}-value`;
    case "int":
      return 7;
    case "money":
      return 1_250_000;
    case "real":
      return 1.5;
    case "bool":
      return true;
    case "json":
      return { k: [1, "two", { three: null }] };
    case "timestamp":
      return now;
  }
}

export function defineStateSuite(target: SuiteTarget): void {
  describe(`state conformance: ${target.name}`, () => {
    let clock: SimulatedClock;
    let store: StateStore;
    let s: Awaited<ReturnType<typeof seed>>;

    beforeEach(async () => {
      clock = new SimulatedClock(START);
      store = await target.fresh(clock);
      s = await seed(store);
    });

    async function readyTask(title = "Task", extra: Partial<TaskRow> = {}): Promise<TaskRow> {
      const t = await store.task.insert({ project_id: s.project.id, title, ...extra });
      return store.task.transition(t.id, t.version, "ready", "planned", { agentId: s.alice.id });
    }

    describe("migrations", () => {
      it("are idempotent: a second migrate applies nothing and records one row per version", async () => {
        const again = await migrate(store.db, { clock });
        expect(again.applied).toEqual([]);
        expect(again.version).toBe(MIGRATIONS.length);
        const rows = await store.db.query<{ version: number; name: string; applied_at: string }>(
          'SELECT * FROM "schema_migrations" ORDER BY "version"',
        );
        expect(rows.map((r) => Number(r.version))).toEqual(MIGRATIONS.map((m) => m.version));
        expect(rows[0]?.name).toBe("initial");
        expect(await pendingMigrations(store.db)).toEqual([]);
      });

      it("created every table of the schema", async () => {
        for (const table of tableOrder()) {
          const rows = await store.db.query(`SELECT COUNT(*) AS n FROM "${table}"`);
          expect(rows).toHaveLength(1);
        }
      });
    });

    describe("round trips", () => {
      it("every entity inserts a full row and reads it back with identical JS types", async () => {
        const fresh = await target.fresh(new SimulatedClock(START));
        try {
          const ids = new Map<string, string>();
          for (const table of tableOrder()) {
            const entity = ENTITIES[table] as EntityDef;
            if (!entity.envelope) continue;
            const repo = new Repository<BaseRow>(fresh.db, entity, fresh.clock);
            const input: Record<string, unknown> = {};
            for (const col of entity.columns) {
              if (col.references) {
                input[col.name] =
                  col.references.table === table ? null : ids.get(col.references.table);
                if (input[col.name] === undefined)
                  throw new Error(`no parent for ${table}.${col.name}`);
              } else input[col.name] = minimalValue(col, fresh.clock.nowIso());
            }
            const inserted = await repo.insert(input);
            ids.set(table, inserted.id);
            const read = await repo.mustGet(inserted.id);
            expect(read, table).toEqual(inserted);
            for (const col of allColumns(entity)) {
              const v = (read as unknown as Record<string, unknown>)[col.name];
              if (v === null) continue;
              const expected =
                col.type === "bool"
                  ? "boolean"
                  : col.type === "json"
                    ? "object"
                    : col.type === "text" || col.type === "timestamp"
                      ? "string"
                      : "number";
              expect(typeof v, `${table}.${col.name}`).toBe(expected);
            }
            expect(read.version).toBe(1);
            expect(read.created_at).toBe(START);
            expect(read.updated_at).toBe(START);
          }
          expect(ids.size).toBe(Object.values(ENTITIES).filter((e) => e.envelope).length);
        } finally {
          if (fresh !== store) await fresh.close();
        }
      });

      it("booleans, JSON, money and nullable columns keep their shape", async () => {
        const p = await store.project.insert({
          name: "Shapes",
          repos: ["https://example.test/a.git", "https://example.test/b.git"],
          settings: { speed_quality_offset: -1, critic_ceiling: 2, nested: { ok: true } },
          small_project_mode: true,
          active: false,
          budget_usd_micro: 9_007_199_254_740_991,
        });
        const read = await store.project.mustGet(p.id);
        expect(read.small_project_mode).toBe(true);
        expect(read.active).toBe(false);
        expect(read.repos).toEqual(["https://example.test/a.git", "https://example.test/b.git"]);
        expect(read.settings).toEqual({
          speed_quality_offset: -1,
          critic_ceiling: 2,
          nested: { ok: true },
        });
        expect(read.budget_usd_micro).toBe(9_007_199_254_740_991);
        const t = await store.task.insert({ project_id: s.project.id, title: "nulls" });
        expect(t.milestone_id).toBeNull();
        expect(t.claim_expires).toBeNull();
        expect(t.depends_on).toEqual([]);
        expect(t.acceptance_criteria).toEqual([]);
        expect(t.status).toBe("draft");
        expect(typeof t.budget_usd_micro).toBe("number");
      });

      it("fills the envelope from the clock and bumps version and updated_at on every write", async () => {
        const t = await store.task.insert({ project_id: s.project.id, title: "env" });
        expect(t.created_at).toBe(START);
        expect(t.updated_at).toBe(START);
        expect(t.version).toBe(1);
        expect(t.author_agent).toBeNull();
        await clock.advance(5_000);
        const u = await store.task.update(t.id, 1, { title: "env2", author_agent: s.alice.id });
        expect(u.version).toBe(2);
        expect(u.updated_at).toBe("2026-03-01T09:00:05.000Z");
        expect(u.created_at).toBe(START);
        expect(u.author_agent).toBe(s.alice.id);
      });

      it("rejects a missing required column, an unknown column, a bad enum and an unsafe integer", async () => {
        await expectCode(store.task.insert({ title: "no project" }), "validation");
        await expectCode(
          store.task.insert({ project_id: s.project.id, title: "x", nope: 1 }),
          "validation",
        );
        await expectCode(
          store.task.insert({ project_id: s.project.id, title: "x", status: "bogus" }),
          "validation",
        );
        await expectCode(
          store.task.insert({
            project_id: s.project.id,
            title: "x",
            budget_usd_micro: 2 ** 53 + 2,
          }),
          "validation",
        );
        await expectCode(
          store.task.insert({ project_id: s.project.id, title: "x", priority: 1.5 }),
          "validation",
        );
      });

      it("the database itself refuses bad enums, ranges and dangling references", async () => {
        const now = clock.nowIso();
        const raw = (status: string, tier: number, project: string) =>
          store.db.query(
            `INSERT INTO "task" ("id","created_at","updated_at","version","project_id","title","status","risk_tier")
             VALUES (?, ?, ?, 1, ?, 'raw', ?, ?)`,
            [`raw-${status}-${tier}`, now, now, project, status, tier],
          );
        await expect(raw("bogus", 0, s.project.id)).rejects.toSatisfy(isCheckViolation);
        await expect(raw("draft", 9, s.project.id)).rejects.toSatisfy(isCheckViolation);
        await expect(raw("draft", 0, "no-such-project")).rejects.toSatisfy(isForeignKeyViolation);
      });
    });

    describe("generic repository", () => {
      it("update with a stale version throws version_conflict with details, missing rows not_found", async () => {
        const t = await store.task.insert({ project_id: s.project.id, title: "occ" });
        await store.task.update(t.id, 1, { title: "first" });
        const err = await expectCode(
          store.task.update(t.id, 1, { title: "second" }),
          "version_conflict",
        );
        expect(err.details).toMatchObject({ expected: 1, actual: 2, table: "task" });
        expect(err.retryable).toBe(true);
        expect((await store.task.mustGet(t.id)).title).toBe("first");
        await expectCode(store.task.update("missing", 1, { title: "x" }), "not_found");
        await expectCode(store.task.mustGet("missing"), "not_found");
        expect(await store.task.get("missing")).toBeUndefined();
      });

      it("list filters by equality, NULL and IN, orders, paginates and counts", async () => {
        const ms = await store.milestone.insert({ project_id: s.project.id, name: "M1" });
        await store.task.insert({
          project_id: s.project.id,
          title: "a",
          priority: 1,
          milestone_id: ms.id,
        });
        await store.task.insert({ project_id: s.project.id, title: "b", priority: 3 });
        await store.task.insert({
          project_id: s.project.id,
          title: "c",
          priority: 2,
          status: "ready",
        });
        const byPriority = await store.task.list(
          { project_id: s.project.id },
          { orderBy: "priority desc" },
        );
        expect(byPriority.map((t) => t.title)).toEqual(["b", "c", "a"]);
        expect((await store.task.list({ milestone_id: null })).map((t) => t.title).sort()).toEqual([
          "b",
          "c",
        ]);
        expect((await store.task.list({ status: ["ready", "done"] })).map((t) => t.title)).toEqual([
          "c",
        ]);
        expect(await store.task.list({ status: [] })).toEqual([]);
        const page = await store.task.list(
          { project_id: s.project.id },
          { orderBy: "priority", limit: 1, offset: 1 },
        );
        expect(page.map((t) => t.title)).toEqual(["c"]);
        const offsetOnly = await store.task.list(
          { project_id: s.project.id },
          { orderBy: "priority", offset: 2 },
        );
        expect(offsetOnly.map((t) => t.title)).toEqual(["b"]);
        expect(await store.task.count({ project_id: s.project.id })).toBe(3);
        await expectCode(store.task.list({ depends_on: ["x"] } as never), "validation");
        await expectCode(store.task.list({}, { orderBy: "nope; DROP TABLE task" }), "validation");
      });

      it("delete returns true once, then false", async () => {
        const q = await store.queue.enqueue({
          project_id: s.project.id,
          human_id: s.human.id,
          kind: "note",
          text: "n",
        });
        expect(await store.queue.delete(q.id)).toBe(true);
        expect(await store.queue.delete(q.id)).toBe(false);
        expect(await store.queue.exists(q.id)).toBe(false);
      });
    });

    describe("task workflow", () => {
      it("walks draft -> ready -> claimed -> in_progress -> in_review -> done recording reason and actor", async () => {
        let t = await store.task.insert({ project_id: s.project.id, title: "flow" });
        t = await store.task.transition(t.id, t.version, "ready", "planned", {
          humanId: s.human.id,
        });
        expect(t.status).toBe("ready");
        expect(t.reason).toBe("planned");
        expect(t.author_human).toBe(s.human.id);
        const c = await store.task.claim(t.id, s.alice.id, 60_000);
        if (!c.ok) throw new Error("claim failed");
        t = c.task;
        expect(t.status).toBe("claimed");
        t = await store.task.transition(t.id, t.version, "in_progress", "started", {
          agentId: s.alice.id,
        });
        expect(t.claimed_by).toBe(s.alice.id);
        t = await store.task.transition(t.id, t.version, "in_review", "pr opened", {
          agentId: s.alice.id,
        });
        expect(t.claimed_by).toBe(s.alice.id);
        t = await store.task.transition(t.id, t.version, "done", "accepted", {
          agentId: s.alice.id,
        });
        expect(t.status).toBe("done");
        expect(t.claimed_by).toBeNull();
        expect(t.claim_expires).toBeNull();
        expect(t.author_agent).toBe(s.alice.id);
        expect(t.version).toBe(6);
      });

      it("refuses illegal transitions with validation and the allowed targets", async () => {
        const t = await store.task.insert({ project_id: s.project.id, title: "illegal" });
        const err = await expectCode(
          store.task.transition(t.id, t.version, "done", "skip"),
          "validation",
        );
        expect(err.details).toMatchObject({
          from: "draft",
          to: "done",
          allowed: ["ready", "cancelled"],
        });
        await expectCode(store.task.transition(t.id, t.version, "in_review", "skip"), "validation");
        const r = await store.task.transition(t.id, t.version, "ready", "ok");
        await expectCode(store.task.transition(r.id, r.version, "in_review", "skip"), "validation");
        const cancelled = await store.task.transition(r.id, r.version, "cancelled", "nope");
        await expectCode(
          store.task.transition(cancelled.id, cancelled.version, "ready", "revive"),
          "validation",
        );
      });

      it("side exits clear the claim; failed -> ready counts an attempt; needs_human -> ready retries", async () => {
        let t = await readyTask("exits");
        const c = await store.task.claim(t.id, s.alice.id, 60_000);
        if (!c.ok) throw new Error("claim failed");
        t = await store.task.transition(c.task.id, c.task.version, "in_progress", "go");
        t = await store.task.transition(t.id, t.version, "failed", "tests red");
        expect(t.claimed_by).toBeNull();
        expect(t.attempt).toBe(0);
        t = await store.task.transition(t.id, t.version, "ready", "retry");
        expect(t.attempt).toBe(1);
        t = await store.task.transition(t.id, t.version, "needs_human", "credential missing");
        t = await store.task.transition(t.id, t.version, "ready", "credential provided");
        expect(t.status).toBe("ready");
        expect(t.attempt).toBe(1);
        const rev = await store.task.claim(t.id, s.alice.id, 60_000);
        if (!rev.ok) throw new Error("claim failed");
        t = await store.task.transition(rev.task.id, rev.task.version, "in_progress", "go");
        t = await store.task.transition(t.id, t.version, "in_review", "pr");
        t = await store.task.transition(t.id, t.version, "in_progress", "critic says revise");
        expect(t.status).toBe("in_progress");
        expect(t.claimed_by).toBe(s.alice.id);
      });

      it("transition honours the expected version", async () => {
        const t = await store.task.insert({ project_id: s.project.id, title: "stale" });
        await store.task.transition(t.id, t.version, "ready", "ok");
        await expectCode(
          store.task.transition(t.id, t.version, "cancelled", "stale"),
          "version_conflict",
        );
      });
    });

    describe("claims", () => {
      it("two agents claiming concurrently: exactly one wins, the other learns who holds it", async () => {
        const t = await readyTask("contested");
        const [a, b] = await Promise.all([
          store.task.claim(t.id, s.alice.id, 30 * 60_000),
          store.task.claim(t.id, s.bob.id, 30 * 60_000),
        ]);
        const winners = [a, b].filter((r) => r.ok);
        const losers = [a, b].filter((r) => !r.ok);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        const winner = winners[0];
        const loser = losers[0];
        if (!winner?.ok || !loser || loser.ok) throw new Error("unreachable");
        expect(loser.reason).toBe("held_by");
        if (loser.reason !== "held_by") throw new Error("unreachable");
        expect(loser.holder).toBe(winner.task.claimed_by);
        expect(loser.expires).toBe("2026-03-01T09:30:00.000Z");
        const stored = await store.task.mustGet(t.id);
        expect(stored.status).toBe("claimed");
        expect(stored.version).toBe(3);
      });

      it("the holder can re-claim and renew; a non-holder cannot renew", async () => {
        const t = await readyTask("renew");
        const first = await store.task.claim(t.id, s.alice.id, 60_000);
        expect(first.ok).toBe(true);
        await clock.advance(30_000);
        const again = await store.task.claim(t.id, s.alice.id, 60_000);
        expect(again.ok).toBe(true);
        if (!again.ok) throw new Error("unreachable");
        expect(again.task.claim_expires).toBe("2026-03-01T09:01:30.000Z");
        expect(again.task.claimed_by).toBe(s.alice.id);
        const renewed = await store.task.renewClaim(t.id, s.alice.id, 120_000);
        expect(renewed.claim_expires).toBe("2026-03-01T09:02:30.000Z");
        expect(renewed.version).toBe(again.task.version + 1);
        const err = await expectCode(
          store.task.renewClaim(t.id, s.bob.id, 120_000),
          "claim_conflict",
        );
        expect(err.details).toMatchObject({ holder: s.alice.id });
      });

      it("an expired claim can be taken by another agent and expireClaims returns tasks to ready", async () => {
        const t = await readyTask("expiring");
        const c = await store.task.claim(t.id, s.alice.id, 60_000);
        if (!c.ok) throw new Error("claim failed");
        await store.task.transition(c.task.id, c.task.version, "in_progress", "working");
        const tooEarly = await store.task.claim(t.id, s.bob.id, 60_000);
        expect(tooEarly.ok).toBe(false);
        await clock.advance(61_000);
        expect(await store.task.expireClaims()).toHaveLength(1);
        const back = await store.task.mustGet(t.id);
        expect(back.status).toBe("ready");
        expect(back.claimed_by).toBeNull();
        expect(back.reason).toBe("claim expired");
        const other = await readyTask("expiring-2");
        await store.task.claim(other.id, s.alice.id, 60_000);
        await clock.advance(61_000);
        const taken = await store.task.claim(other.id, s.bob.id, 60_000);
        expect(taken.ok).toBe(true);
        if (!taken.ok) throw new Error("unreachable");
        expect(taken.task.claimed_by).toBe(s.bob.id);
        expect(await store.task.expireClaims()).toHaveLength(0);
      });

      it("releaseClaim returns the task to ready; only the holder may release", async () => {
        const t = await readyTask("release");
        await store.task.claim(t.id, s.alice.id, 60_000);
        await expectCode(store.task.releaseClaim(t.id, s.bob.id), "claim_conflict");
        const released = await store.task.releaseClaim(t.id, s.alice.id);
        expect(released.status).toBe("ready");
        expect(released.claimed_by).toBeNull();
        expect(await store.task.claimedBy(s.alice.id)).toEqual([]);
      });

      it("reports not_claimable, version_conflict and not_found", async () => {
        const draft = await store.task.insert({ project_id: s.project.id, title: "draft" });
        expect(await store.task.claim(draft.id, s.alice.id, 1000)).toEqual({
          ok: false,
          reason: "not_claimable",
          status: "draft",
        });
        const t = await readyTask("versioned");
        expect(
          await store.task.claim(t.id, s.alice.id, 1000, clock.now(), { expectedVersion: 99 }),
        ).toEqual({
          ok: false,
          reason: "version_conflict",
          version: t.version,
        });
        expect(
          (
            await store.task.claim(t.id, s.alice.id, 1000, clock.now(), {
              expectedVersion: t.version,
            })
          ).ok,
        ).toBe(true);
        expect((await store.task.claimedBy(s.alice.id)).map((x) => x.id)).toEqual([t.id]);
        await expectCode(store.task.claim("missing", s.alice.id, 1000), "not_found");
      });
    });

    describe("findings and reviews", () => {
      it("refuses to close a task with open findings until they are resolved", async () => {
        let t = await readyTask("reviewed");
        const c = await store.task.claim(t.id, s.alice.id, 60_000);
        if (!c.ok) throw new Error("claim failed");
        t = await store.task.transition(c.task.id, c.task.version, "in_progress", "go");
        t = await store.task.transition(t.id, t.version, "in_review", "pr");
        const review = await store.review.insert({
          task_id: t.id,
          session_id: s.session.id,
          critic_model: "critic-1",
          verdict: "revise",
          grade: 55,
        });
        const f = await store.finding.insert({
          review_id: review.id,
          task_id: t.id,
          severity: "high",
          description: "no tests",
          fingerprint: "no-tests",
        });
        const err = await expectCode(
          store.task.transition(t.id, t.version, "done", "ship"),
          "findings_open",
        );
        expect(err.details).toMatchObject({ taskId: t.id, findings: [f.id] });
        expect((await store.task.mustGet(t.id)).status).toBe("in_review");
        const run = await store.run.insert({
          session_id: s.session.id,
          task_id: t.id,
          specialist: "coder",
          model: "m",
        });
        const resolved = await store.finding.resolve(f.id, f.version, run.id);
        expect(resolved.status).toBe("resolved");
        expect(resolved.resolved_by_run).toBe(run.id);
        expect(await store.finding.openFor(t.id)).toEqual([]);
        t = await store.task.transition(t.id, t.version, "done", "ship");
        expect(t.status).toBe("done");
        expect((await store.review.latestForTask(t.id))?.id).toBe(review.id);
      });

      it("counts repeated findings across sessions by fingerprint", async () => {
        const session2 = await store.session.insert({
          agent_id: s.bob.id,
          project_id: s.project.id,
        });
        const t1 = await store.task.insert({ project_id: s.project.id, title: "t1" });
        const t2 = await store.task.insert({ project_id: s.project.id, title: "t2" });
        const r1 = await store.review.insert({
          task_id: t1.id,
          session_id: s.session.id,
          critic_model: "c",
          verdict: "revise",
        });
        const r2 = await store.review.insert({
          task_id: t2.id,
          session_id: session2.id,
          critic_model: "c",
          verdict: "revise",
        });
        const r3 = await store.review.insert({
          task_id: t2.id,
          session_id: session2.id,
          critic_model: "c",
          verdict: "accept",
        });
        for (const r of [r1, r2, r3]) {
          await store.finding.insert({
            review_id: r.id,
            task_id: r.task_id,
            severity: "medium",
            description: "missing docs",
            fingerprint: "docs-missing",
          });
        }
        await store.finding.insert({
          review_id: r1.id,
          task_id: t1.id,
          severity: "low",
          description: "once",
          fingerprint: "once",
        });
        expect(await store.finding.patterns("docs-missing")).toEqual({
          fingerprint: "docs-missing",
          total: 3,
          sessions: 2,
          tasks: 2,
        });
        expect(await store.finding.patterns("nothing")).toEqual({
          fingerprint: "nothing",
          total: 0,
          sessions: 0,
          tasks: 0,
        });
        expect((await store.finding.repeated(2)).map((p) => p.fingerprint)).toEqual([
          "docs-missing",
        ]);
      });
    });

    describe("dependencies", () => {
      it("readyTasks returns ready tasks whose depends_on are all done, highest priority first", async () => {
        const dep = await readyTask("dep");
        const blocked = await readyTask("blocked", { depends_on: [dep.id], priority: 10 });
        const free = await readyTask("free", { priority: 1 });
        const ghost = await readyTask("ghost", { depends_on: ["does-not-exist"] });
        const draft = await store.task.insert({ project_id: s.project.id, title: "draft" });
        expect((await store.task.readyTasks(s.project.id)).map((t) => t.title)).toEqual([
          "free",
          "dep",
        ]);
        const c = await store.task.claim(dep.id, s.alice.id, 60_000);
        if (!c.ok) throw new Error("claim failed");
        let d = await store.task.transition(c.task.id, c.task.version, "in_progress", "go");
        d = await store.task.transition(d.id, d.version, "in_review", "pr");
        await store.task.transition(d.id, d.version, "done", "ok");
        expect((await store.task.readyTasks(s.project.id)).map((t) => t.title)).toEqual([
          "blocked",
          "free",
        ]);
        expect((await store.task.readyTasks(s.project.id, { limit: 1 })).map((t) => t.id)).toEqual([
          blocked.id,
        ]);
        expect([free.id, ghost.id, draft.id].includes(blocked.id)).toBe(false);
      });
    });

    describe("messages", () => {
      it("needs an addressee, fills inboxes for agents and humans, and filters unread", async () => {
        await expectCode(
          store.message.send({ from_agent_id: s.alice.id, type: "info", body: "nobody" }),
          "validation",
        );
        const m1 = await store.message.send({
          from_agent_id: s.alice.id,
          to_agent_id: s.bob.id,
          type: "info",
          body: "hi bob",
        });
        const m2 = await store.message.send({
          from_agent_id: s.alice.id,
          to_human_id: s.human.id,
          type: "question",
          body: "hi ada",
        });
        await store.message.markRead(m1.id);
        expect((await store.message.inbox({ agentId: s.bob.id })).map((m) => m.id)).toEqual([
          m1.id,
        ]);
        expect(await store.message.inbox({ agentId: s.bob.id }, { unreadOnly: true })).toEqual([]);
        expect(
          (await store.message.inbox({ humanId: s.human.id }, { unreadOnly: true })).map(
            (m) => m.id,
          ),
        ).toEqual([m2.id]);
        const reply = await store.message.send({
          from_agent_id: s.bob.id,
          to_agent_id: s.alice.id,
          type: "info",
          body: "re",
          reply_to: m1.id,
        });
        expect((await store.message.replies(m1.id)).map((m) => m.id)).toEqual([reply.id]);
      });

      it("receipts come from the clock, imply earlier receipts, and the first receipt wins", async () => {
        const m = await store.message.send({
          from_agent_id: s.alice.id,
          to_agent_id: s.bob.id,
          type: "request",
          body: "do",
          requires_ack: true,
        });
        expect(m.delivered_at).toBeNull();
        await clock.advance(1_000);
        const delivered = await store.message.markDelivered(m.id);
        expect(delivered.delivered_at).toBe("2026-03-01T09:00:01.000Z");
        await clock.advance(1_000);
        const read = await store.message.markRead(m.id);
        expect(read.read_at).toBe("2026-03-01T09:00:02.000Z");
        expect(read.delivered_at).toBe("2026-03-01T09:00:01.000Z");
        await clock.advance(1_000);
        const acted = await store.message.markActed(m.id);
        expect(acted.acted_at).toBe("2026-03-01T09:00:03.000Z");
        await clock.advance(1_000);
        const again = await store.message.markActed(m.id);
        expect(again.acted_at).toBe("2026-03-01T09:00:03.000Z");
        expect(again.version).toBe(acted.version);
        const direct = await store.message.send({
          from_agent_id: s.alice.id,
          to_agent_id: s.bob.id,
          type: "info",
          body: "x",
        });
        const actedDirect = await store.message.markActed(direct.id);
        expect(actedDirect.delivered_at).toBe(actedDirect.acted_at);
        expect(actedDirect.read_at).toBe(actedDirect.acted_at);
      });

      it("unacknowledged lists requires_ack messages until they are acted on", async () => {
        const a = await store.message.send({
          from_agent_id: s.alice.id,
          to_agent_id: s.bob.id,
          type: "request",
          body: "ack me",
          requires_ack: true,
        });
        await store.message.send({
          from_agent_id: s.alice.id,
          to_agent_id: s.bob.id,
          type: "info",
          body: "fyi",
        });
        const b = await store.message.send({
          from_agent_id: s.alice.id,
          to_human_id: s.human.id,
          type: "warning",
          body: "budget",
          requires_ack: true,
        });
        await store.message.markRead(a.id);
        expect((await store.message.unacknowledged(s.alice.id)).map((m) => m.id)).toEqual([
          a.id,
          b.id,
        ]);
        await store.message.markActed(a.id);
        expect((await store.message.unacknowledged(s.alice.id)).map((m) => m.id)).toEqual([b.id]);
        expect(await store.message.unacknowledged(s.bob.id)).toEqual([]);
      });
    });

    describe("events", () => {
      it("append assigns a per-session seq, list reads after a seq, payloads round-trip", async () => {
        const other = await store.session.insert({ agent_id: s.bob.id });
        const e1 = await store.event.append(s.session.id, "note", { a: 1 }, 5);
        const e2 = await store.event.append(s.session.id, "tool_call", ["x", null], 0, {
          redacted: true,
          authorAgent: s.alice.id,
        });
        const o1 = await store.event.append(other.id, "note", "plain string");
        expect([e1.seq, e2.seq, o1.seq]).toEqual([1, 2, 1]);
        expect(e2.payload).toEqual(["x", null]);
        expect(e2.redacted).toBe(true);
        expect(e2.author_agent).toBe(s.alice.id);
        expect(e1.cost_usd_micro).toBe(5);
        expect(o1.payload).toBe("plain string");
        expect((await store.event.list(s.session.id)).map((e) => e.seq)).toEqual([1, 2]);
        expect((await store.event.list(s.session.id, 1)).map((e) => e.id)).toEqual([e2.id]);
        expect(await store.event.latestSeq(other.id)).toBe(1);
        expect(await store.event.count(s.session.id)).toBe(2);
      });

      it("concurrent appends never collide: seqs are unique and contiguous", async () => {
        await Promise.all(
          Array.from({ length: 12 }, (_, i) => store.event.append(s.session.id, "n", { i })),
        );
        const seqs = (await store.event.list(s.session.id)).map((e) => e.seq);
        expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      });

      it("is append-only: the repo has no update or delete and the database refuses both", async () => {
        const e = await store.event.append(s.session.id, "note", {});
        expect("update" in store.event).toBe(false);
        expect("delete" in store.event).toBe(false);
        expect("patch" in store.event).toBe(false);
        await expect(
          store.db.query('UPDATE "event" SET "type" = ? WHERE "id" = ?', ["x", e.id]),
        ).rejects.toSatisfy(isAppendOnlyViolation);
        await expect(
          store.db.query('DELETE FROM "event" WHERE "id" = ?', [e.id]),
        ).rejects.toSatisfy(isAppendOnlyViolation);
        expect(await store.event.get(e.id)).toEqual(e);
      });
    });

    describe("cost ledger", () => {
      async function ledger() {
        const p2 = await store.project.insert({ name: "Other" });
        const task = await store.task.insert({ project_id: s.project.id, title: "t" });
        const run = await store.run.insert({
          session_id: s.session.id,
          task_id: task.id,
          specialist: "coder",
          model: "m-big",
        });
        const base = { human_id: s.human.id, agent_id: s.alice.id, kind: "api" as const };
        await store.costLedger.record({
          ...base,
          project_id: s.project.id,
          session_id: s.session.id,
          task_id: task.id,
          run_id: run.id,
          usd_micro: 1_000,
          chf_micro: 900,
          model: "m-big",
          specialist: "coder",
          tokens_in: 100,
          tokens_out: 10,
          occurred_at: "2026-03-01T09:00:00.000Z",
        });
        await store.costLedger.record({
          ...base,
          project_id: s.project.id,
          session_id: s.session.id,
          usd_micro: 2_000,
          chf_micro: 1_800,
          model: "m-small",
          specialist: "tester",
          tokens_in: 50,
          occurred_at: "2026-03-01T10:00:00.000Z",
          kind: "subscription",
          plan_usage_share: 0.42,
        });
        await store.costLedger.record({
          ...base,
          project_id: p2.id,
          usd_micro: 4_000,
          chf_micro: 3_600,
          model: "m-big",
          specialist: "coder",
          occurred_at: "2026-03-02T09:00:00.000Z",
          plan_usage_share: 0.2,
        });
        await store.costLedger.record({
          human_id: s.human2.id,
          kind: "api",
          project_id: p2.id,
          usd_micro: 8_000,
          chf_micro: 7_200,
          model: "m-big",
          occurred_at: "2026-03-02T09:00:00.000Z",
        });
        return { p2, task, run };
      }

      it("sums by human, project, session, task, run and time window; plan share is a max", async () => {
        const { p2, task, run } = await ledger();
        expect(await store.costLedger.sum()).toMatchObject({
          usd_micro: 15_000,
          chf_micro: 13_500,
          entries: 4,
          tokens_in: 150,
          tokens_out: 10,
          plan_usage_share: 0.42,
        });
        expect(await store.costLedger.sum({ humanId: s.human.id })).toMatchObject({
          usd_micro: 7_000,
          entries: 3,
        });
        expect(await store.costLedger.sum({ projectId: s.project.id })).toMatchObject({
          usd_micro: 3_000,
          entries: 2,
        });
        expect(await store.costLedger.sum({ projectId: p2.id })).toMatchObject({
          usd_micro: 12_000,
          plan_usage_share: 0.2,
        });
        expect(await store.costLedger.sum({ sessionId: s.session.id })).toMatchObject({
          usd_micro: 3_000,
        });
        expect(await store.costLedger.sum({ taskId: task.id })).toMatchObject({ usd_micro: 1_000 });
        expect(await store.costLedger.sum({ runId: run.id })).toMatchObject({ usd_micro: 1_000 });
        expect(
          await store.costLedger.sum({
            from: "2026-03-01T09:30:00.000Z",
            to: "2026-03-02T00:00:00.000Z",
          }),
        ).toMatchObject({ usd_micro: 2_000, entries: 1 });
        expect(await store.costLedger.sum({ kind: "subscription" })).toMatchObject({
          usd_micro: 2_000,
        });
        expect(await store.costLedger.sum({ projectId: "none" })).toEqual({
          usd_micro: 0,
          chf_micro: 0,
          plan_usage_share: null,
          entries: 0,
          tokens_in: 0,
          tokens_out: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        });
      });

      it("breaks down by model, specialist and project, largest first", async () => {
        const { p2 } = await ledger();
        expect((await store.costLedger.byModel()).map((b) => [b.key, b.usd_micro])).toEqual([
          ["m-big", 13_000],
          ["m-small", 2_000],
        ]);
        expect(
          (await store.costLedger.bySpecialist({ humanId: s.human.id })).map((b) => [
            b.key,
            b.usd_micro,
          ]),
        ).toEqual([
          ["coder", 5_000],
          ["tester", 2_000],
        ]);
        expect(
          (await store.costLedger.byProject()).map((b) => [b.key, b.usd_micro, b.entries]),
        ).toEqual([
          [p2.id, 12_000, 2],
          [s.project.id, 3_000, 2],
        ]);
        expect(
          (await store.costLedger.bySpecialist({ humanId: s.human2.id })).map((b) => b.key),
        ).toEqual([null]);
      });
    });

    describe("decisions", () => {
      it("finds an answered question regardless of case, whitespace and trailing punctuation", async () => {
        const d = await store.decision.record({
          project_id: s.project.id,
          question: "Should we use  Tabs or Spaces?",
          options: ["tabs", "spaces"],
          chosen: "spaces",
          decided_by: s.human.id,
          rationale: "team habit",
        });
        expect(d.question_normalised).toBe("should we use tabs or spaces");
        expect(
          (await store.decision.findAnswered(s.project.id, "  should we use tabs or spaces "))?.id,
        ).toBe(d.id);
        expect(
          (await store.decision.findAnswered(s.project.id, "SHOULD WE USE TABS OR SPACES?!"))?.id,
        ).toBe(d.id);
        expect(
          await store.decision.findAnswered(s.project.id, "should we use tabs"),
        ).toBeUndefined();
        const other = await store.project.insert({ name: "Other" });
        expect(
          await store.decision.findAnswered(other.id, "should we use tabs or spaces"),
        ).toBeUndefined();
      });

      it("supersede links old and new and hides the old answer", async () => {
        const d1 = await store.decision.record({
          project_id: s.project.id,
          question: "Which database?",
          chosen: "sqlite",
          decided_by: s.human.id,
        });
        const d2 = await store.decision.supersede(d1.id, {
          project_id: s.project.id,
          question: "Which database?",
          chosen: "postgres",
          decided_by: s.human.id,
        });
        expect(d2.supersedes).toBe(d1.id);
        expect((await store.decision.mustGet(d1.id)).superseded_by).toBe(d2.id);
        expect((await store.decision.findAnswered(s.project.id, "which database"))?.chosen).toBe(
          "postgres",
        );
        expect((await store.decision.current(s.project.id)).map((d) => d.id)).toEqual([d2.id]);
      });
    });

    describe("human requests", () => {
      it("lists open requests blocking first and records answers once", async () => {
        const info = await store.humanRequest.insert({
          kind: "info",
          why: "fyi",
          human_id: s.human.id,
          project_id: s.project.id,
        });
        await clock.advance(1_000);
        const cred = await store.humanRequest.insert({
          kind: "credential",
          why: "need token",
          blocking: true,
          human_id: s.human.id,
          risk: "high",
        });
        await clock.advance(1_000);
        const other = await store.humanRequest.insert({
          kind: "approval",
          why: "deploy",
          blocking: true,
          human_id: s.human2.id,
        });
        expect((await store.humanRequest.open({ humanId: s.human.id })).map((r) => r.id)).toEqual([
          cred.id,
          info.id,
        ]);
        expect((await store.humanRequest.open()).map((r) => r.id)).toEqual([
          cred.id,
          other.id,
          info.id,
        ]);
        expect(
          (await store.humanRequest.open({ projectId: s.project.id })).map((r) => r.id),
        ).toEqual([info.id]);
        const answered = await store.humanRequest.answer(
          cred.id,
          cred.version,
          { secret_ref: "github_pat" },
          s.human.id,
        );
        expect(answered).toMatchObject({
          status: "answered",
          answer: { secret_ref: "github_pat" },
          answered_by: s.human.id,
          answered_at: clock.nowIso(),
          author_human: s.human.id,
        });
        expect((await store.humanRequest.open({ humanId: s.human.id })).map((r) => r.id)).toEqual([
          info.id,
        ]);
        await expectCode(
          store.humanRequest.answer(cred.id, answered.version, "again", s.human.id),
          "validation",
        );
        await expectCode(
          store.humanRequest.answer(info.id, 99, "x", s.human.id),
          "version_conflict",
        );
        const withdrawn = await store.humanRequest.withdraw(info.id, info.version);
        expect(withdrawn.status).toBe("withdrawn");
        await expectCode(
          store.humanRequest
            .expire(other.id, other.version)
            .then((r) => store.humanRequest.withdraw(r.id, r.version)),
          "validation",
        );
      });
    });

    describe("lessons", () => {
      it("keeps private lessons private: agent B cannot read agent A's through the repo API", async () => {
        await store.lesson.add({
          scope: "agent_private",
          owner_agent_id: s.alice.id,
          text: "Alice secret habit",
          tags: ["habit"],
        });
        const shared = await store.lesson.add({
          scope: "shared",
          text: "Shared habit",
          tags: ["habit"],
        });
        const critic = await store.lesson.add({
          scope: "critic",
          text: "Critic habit",
          tags: ["habit"],
        });
        const asBob = await store.lesson.search({
          scope: "agent_private",
          ownerAgentId: s.bob.id,
          tags: ["habit"],
        });
        expect(asBob).toEqual([]);
        const asBobText = await store.lesson.search({
          scope: "agent_private",
          ownerAgentId: s.bob.id,
          text: "alice",
        });
        expect(asBobText).toEqual([]);
        await expectCode(store.lesson.search({ scope: "agent_private" }), "validation");
        expect(
          (await store.lesson.search({ scope: "agent_private", ownerAgentId: s.alice.id })).map(
            (l) => l.text,
          ),
        ).toEqual(["Alice secret habit"]);
        expect(
          (await store.lesson.search({ scope: "shared", tags: ["habit"] })).map((l) => l.id),
        ).toEqual([shared.id]);
        expect((await store.lesson.search({ scope: "critic" })).map((l) => l.id)).toEqual([
          critic.id,
        ]);
        await expectCode(
          store.lesson.add({ scope: "agent_private", text: "no owner" }),
          "validation",
        );
      });

      it("searches by tags, text and status; touch, retire and supersede behave", async () => {
        const a = await store.lesson.add({
          scope: "shared",
          text: "Run the linter before pushing",
          tags: ["ci", "lint"],
          confidence: 0.9,
        });
        const b = await store.lesson.add({
          scope: "shared",
          text: "Pin dependency versions",
          tags: ["ci"],
          confidence: 0.5,
          pinned: true,
        });
        const c = await store.lesson.add({
          scope: "shared",
          text: "Old advice",
          tags: ["ci"],
          status: "retired",
        });
        expect(
          (await store.lesson.search({ scope: "shared", tags: ["ci"] })).map((l) => l.id),
        ).toEqual([b.id, a.id]);
        expect(
          (await store.lesson.search({ scope: "shared", tags: ["ci", "lint"] })).map((l) => l.id),
        ).toEqual([a.id]);
        expect(
          (await store.lesson.search({ scope: "shared", text: "LINTER" })).map((l) => l.id),
        ).toEqual([a.id]);
        expect(
          (await store.lesson.search({ scope: "shared", text: "100%" })).map((l) => l.id),
        ).toEqual([]);
        expect(
          (await store.lesson.search({ scope: "shared", status: "retired" })).map((l) => l.id),
        ).toEqual([c.id]);
        expect((await store.lesson.search({ scope: "shared", limit: 1 })).map((l) => l.id)).toEqual(
          [b.id],
        );
        await clock.advance(10_000);
        const touched = await store.lesson.touch(a.id);
        expect(touched.hit_count).toBe(1);
        expect(touched.last_used).toBe(clock.nowIso());
        expect((await store.lesson.touch(a.id)).hit_count).toBe(2);
        const retired = await store.lesson.retire(b.id, b.version);
        expect(retired.status).toBe("retired");
        const next = await store.lesson.supersede(a.id, {
          text: "Run lint and tests before pushing",
        });
        expect(next.scope).toBe("shared");
        expect(next.tags).toEqual(["ci", "lint"]);
        const old = await store.lesson.mustGet(a.id);
        expect(old.superseded_by).toBe(next.id);
        expect(old.status).toBe("retired");
        expect((await store.lesson.search({ scope: "shared" })).map((l) => l.id)).toEqual([
          next.id,
        ]);
        await expectCode(store.lesson.touch("missing"), "not_found");
      });
    });

    describe("change log", () => {
      it("records changes, lists undoable ones until they expire, and marks undone", async () => {
        const perm = await store.changeLog.record({
          human_id: s.human.id,
          project_id: s.project.id,
          commands: [{ name: "project.switch" }],
          scope: "session",
          source: "voice",
          sentence: "Switched to Demo.",
        });
        await clock.advance(1_000);
        const temp = await store.changeLog.record({
          human_id: s.human.id,
          project_id: s.project.id,
          commands: [{ name: "budget.set", usd_micro: 20_000_000 }],
          before: { usd_micro: 5_000_000 },
          after: { usd_micro: 20_000_000 },
          scope: "project",
          source: "chat",
          sentence: "Raised tonight's budget.",
          expires_at: "2026-03-02T06:00:00.000Z",
        });
        const fixed = await store.changeLog.record({
          human_id: s.human2.id,
          commands: [],
          scope: "global",
          source: "ui",
          sentence: "Deleted a repo.",
          undo_state: "irreversible",
        });
        expect((await store.changeLog.undoable()).map((c) => c.id)).toEqual([temp.id, perm.id]);
        expect((await store.changeLog.undoable({ humanId: s.human2.id })).map((c) => c.id)).toEqual(
          [],
        );
        expect(
          (
            await store.changeLog.undoable({ projectId: s.project.id }, "2026-03-02T06:00:00.000Z")
          ).map((c) => c.id),
        ).toEqual([perm.id]);
        const undone = await store.changeLog.markUndone(perm.id, perm.version);
        expect(undone.undo_state).toBe("undone");
        expect(undone.undone_at).toBe(clock.nowIso());
        await clock.set("2026-03-02T06:00:00.000Z");
        expect((await store.changeLog.expireDue()).map((c) => c.id)).toEqual([temp.id]);
        expect((await store.changeLog.mustGet(temp.id)).undo_state).toBe("expired");
        expect(await store.changeLog.undoable()).toEqual([]);
        expect((await store.changeLog.mustGet(fixed.id)).undo_state).toBe("irreversible");
        expect((await store.changeLog.forProject(s.project.id)).map((c) => c.id)).toEqual([
          temp.id,
          perm.id,
        ]);
      });
    });

    describe("devices", () => {
      it("registers with paired_at, tracks last_seen, and revocation removes it from the active list", async () => {
        const key = ["ed25519:", "A".repeat(43), "="].join(""); // not-a-secret
        const d = await store.device.register({
          owner_human_id: s.human.id,
          name: "Pixel",
          platform: "android",
          public_key: key,
          kind: "phone",
        });
        expect(d.paired_at).toBe(START);
        expect(d.revoked).toBe(false);
        const other = await store.device.register({
          owner_human_id: s.human.id,
          name: "Desk",
          platform: "windows",
          public_key: `${key}2`,
          kind: "desktop",
        });
        expect((await store.device.active(s.human.id)).map((x) => x.id)).toEqual([d.id, other.id]);
        await clock.advance(2_000);
        expect((await store.device.seen(d.id)).last_seen).toBe(clock.nowIso());
        const revoked = await store.device.revoke(d.id, (await store.device.mustGet(d.id)).version);
        expect(revoked.revoked).toBe(true);
        expect(revoked.revoked_at).toBe(clock.nowIso());
        expect((await store.device.active(s.human.id)).map((x) => x.id)).toEqual([other.id]);
        expect((await store.device.byPublicKey(`${key}2`))?.id).toBe(other.id);
        await expect(
          store.device.register({
            owner_human_id: s.human.id,
            name: "Dup",
            platform: "linux",
            public_key: key,
            kind: "desktop",
          }),
        ).rejects.toThrow();
      });
    });

    describe("queue and remote commands", () => {
      it("queue items are consumed or dismissed once, highest priority first", async () => {
        const low = await store.queue.enqueue({
          project_id: s.project.id,
          human_id: s.human.id,
          kind: "note",
          text: "low",
          priority: 1,
        });
        const high = await store.queue.enqueue({
          project_id: s.project.id,
          human_id: s.human.id,
          kind: "idea",
          text: "high",
          priority: 5,
        });
        expect((await store.queue.pending(s.project.id)).map((q) => q.id)).toEqual([
          high.id,
          low.id,
        ]);
        const consumed = await store.queue.consume(high.id, high.version, s.session.id);
        expect(consumed).toMatchObject({ status: "consumed", consumed_by_session: s.session.id });
        await expectCode(
          store.queue.consume(high.id, consumed.version, s.session.id),
          "validation",
        );
        expect((await store.queue.dismiss(low.id, low.version)).status).toBe("dismissed");
        expect(await store.queue.pending(s.project.id)).toEqual([]);
      });

      it("consume checks the version it was given and never takes a dismissed item; inside a transaction a refused item rolls the batch back", async () => {
        const note = await store.queue.enqueue({
          project_id: s.project.id,
          human_id: s.human.id,
          kind: "note",
          text: "note",
          priority: 3,
        });
        const gone = await store.queue.enqueue({
          project_id: s.project.id,
          human_id: s.human.id,
          kind: "correction",
          text: "gone",
          priority: 2,
        });
        // A version the caller did not read (the item was edited since) is a conflict.
        await expectCode(
          store.queue.consume(note.id, note.version + 1, s.session.id),
          "version_conflict",
        );
        expect(await store.queue.mustGet(note.id)).toMatchObject({
          status: "queued",
          version: 1,
          consumed_by_session: null,
        });
        // Dismissed is final: the workflow graph refuses the consume before any write.
        const dismissed = await store.queue.dismiss(gone.id, gone.version);
        await expectCode(
          store.queue.consume(gone.id, dismissed.version, s.session.id),
          "validation",
        );
        expect(await store.queue.mustGet(gone.id)).toMatchObject({
          status: "dismissed",
          consumed_by_session: null,
        });
        // The runner consumes a brief's items in one transaction: a refused item the caller
        // does not catch rolls the already consumed ones back.
        await expectCode(
          store.transaction(async (tx) => {
            await tx.queue.consume(note.id, note.version, s.session.id);
            await tx.queue.consume(gone.id, dismissed.version, s.session.id);
          }),
          "validation",
        );
        expect(await store.queue.mustGet(note.id)).toMatchObject({ status: "queued", version: 1 });
        expect(await store.queue.pending(s.project.id)).toHaveLength(1);
        const consumed = await store.queue.consume(note.id, note.version, s.session.id);
        expect(consumed).toMatchObject({
          status: "consumed",
          consumed_by_session: s.session.id,
          version: 2,
        });
        expect(await store.queue.pending(s.project.id)).toEqual([]);
      });

      it("remote command pick-up is atomic: concurrent pickers get it exactly once", async () => {
        const key = ["pk-", "B".repeat(40)].join(""); // not-a-secret
        const phone = await store.device.register({
          owner_human_id: s.human.id,
          name: "Phone",
          platform: "android",
          public_key: key,
          kind: "phone",
        });
        const cmd = await store.remoteCommand.enqueue({
          device_id: phone.id,
          target: "pc",
          command: "session.start",
          params: { project: s.project.id },
        });
        const results = await Promise.all(
          Array.from({ length: 6 }, () => store.remoteCommand.pickUpById(cmd.id)),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        const picked = results.find(Boolean);
        expect(picked).toMatchObject({ status: "picked_up", picked_up_at: clock.nowIso() });
        expect(await store.remoteCommand.pending("pc")).toEqual([]);
        const done = await store.remoteCommand.complete(cmd.id, { ok: true });
        expect(done).toMatchObject({ status: "done", result: { ok: true } });
        await expectCode(store.remoteCommand.complete(cmd.id), "validation");
      });

      it("pickUp takes the oldest pending command for a target, honouring a specific target device", async () => {
        const key = ["pk-", "C".repeat(40)].join(""); // not-a-secret
        const phone = await store.device.register({
          owner_human_id: s.human.id,
          name: "Phone",
          platform: "android",
          public_key: key,
          kind: "phone",
        });
        const pc = await store.device.register({
          owner_human_id: s.human.id,
          name: "PC",
          platform: "linux",
          public_key: `${key}pc`,
          kind: "desktop",
        });
        const first = await store.remoteCommand.enqueue({
          device_id: phone.id,
          target: "pc",
          command: "session.start",
        });
        await clock.advance(1_000);
        const forOther = await store.remoteCommand.enqueue({
          device_id: phone.id,
          target: "pc",
          target_device_id: phone.id,
          command: "session.stop",
        });
        await clock.advance(1_000);
        const second = await store.remoteCommand.enqueue({
          device_id: phone.id,
          target: "pc",
          target_device_id: pc.id,
          command: "session.pause",
        });
        await store.remoteCommand.enqueue({
          device_id: phone.id,
          target: "cloud",
          command: "session.start",
        });
        const [a, b] = await Promise.all([
          store.remoteCommand.pickUp("pc", { deviceId: pc.id }),
          store.remoteCommand.pickUp("pc", { deviceId: pc.id }),
        ]);
        expect([a?.id, b?.id].sort()).toEqual([first.id, second.id].sort());
        expect(await store.remoteCommand.pickUp("pc", { deviceId: pc.id })).toBeUndefined();
        expect((await store.remoteCommand.pickUp("pc"))?.id).toBe(forOther.id);
        expect((await store.remoteCommand.fail(forOther.id, { error: "offline" })).status).toBe(
          "failed",
        );
        expect((await store.remoteCommand.pending("cloud")).map((c) => c.command)).toEqual([
          "session.start",
        ]);
      });

      it("pickUp with an owner filter takes only commands issued by the owner's devices (ADR 0033 8b)", async () => {
        const key = ["pk-", "D".repeat(40)].join(""); // not-a-secret
        const phoneA = await store.device.register({
          owner_human_id: s.human.id,
          name: "Ada's phone",
          platform: "android",
          public_key: `${key}a`,
          kind: "phone",
        });
        const phoneB = await store.device.register({
          owner_human_id: s.human2.id,
          name: "Bob's phone",
          platform: "android",
          public_key: `${key}b`,
          kind: "phone",
        });
        const revokedA = await store.device.register({
          owner_human_id: s.human.id,
          name: "Ada's old phone",
          platform: "android",
          public_key: `${key}r`,
          kind: "phone",
        });
        await store.device.revoke(revokedA.id, revokedA.version);
        // Bob's command is the oldest; without the filter it would be taken first.
        const fromB = await store.remoteCommand.enqueue({
          device_id: phoneB.id,
          target: "pc",
          command: "kill",
        });
        await clock.advance(1_000);
        const fromA = await store.remoteCommand.enqueue({
          device_id: phoneA.id,
          target: "pc",
          command: "start",
        });
        await clock.advance(1_000);
        const fromRevoked = await store.remoteCommand.enqueue({
          device_id: revokedA.id,
          target: "pc",
          command: "stop",
        });
        // By the owner: Ada's runner sees Ada's commands, Bob's stays pending for Bob's runner.
        expect((await store.remoteCommand.pickUp("pc", { ownerHumanId: s.human.id }))?.id).toBe(
          fromA.id,
        );
        // A revoked device of the owner is still handed over (the runner refuses it visibly).
        expect((await store.remoteCommand.pickUp("pc", { ownerHumanId: s.human.id }))?.id).toBe(
          fromRevoked.id,
        );
        expect(
          await store.remoteCommand.pickUp("pc", { ownerHumanId: s.human.id }),
        ).toBeUndefined();
        expect((await store.remoteCommand.mustGet(fromB.id)).status).toBe("pending");
        // By the agent: the owner is resolved through agent.owner_human_id in SQL.
        expect(await store.remoteCommand.pickUp("pc", { agentId: s.alice.id })).toBeUndefined();
        expect((await store.remoteCommand.pickUp("pc", { agentId: s.bob.id }))?.id).toBe(fromB.id);
        // An unknown agent matches nothing; a device filter combines with the owner filter.
        const later = await store.remoteCommand.enqueue({
          device_id: phoneA.id,
          target: "pc",
          target_device_id: phoneB.id,
          command: "pause",
        });
        expect(
          await store.remoteCommand.pickUp("pc", { agentId: "no-such-agent" }),
        ).toBeUndefined();
        expect(
          await store.remoteCommand.pickUp("pc", { ownerHumanId: s.human.id, deviceId: phoneA.id }),
        ).toBeUndefined();
        expect((await store.remoteCommand.pickUp("pc", { ownerHumanId: s.human.id }))?.id).toBe(
          later.id,
        );
      });
    });

    describe("sessions and runs", () => {
      it("follows the session graph, stamps start and end, and counts spend atomically", async () => {
        let session = await store.session.insert({
          agent_id: s.alice.id,
          project_id: s.project.id,
          budget_cap_usd_micro: 5_000_000,
          step_cap: 50,
        });
        expect(session.status).toBe("planned");
        await clock.advance(1_000);
        session = await store.session.start(session.id, session.version);
        expect(session).toMatchObject({ status: "running", started_at: clock.nowIso() });
        await Promise.all([
          store.session.recordSpend(session.id, 1_000),
          store.session.recordSpend(session.id, 2_000, 2),
          store.session.recordSpend(session.id, 500, 0),
        ]);
        session = await store.session.mustGet(session.id);
        expect(session.spent_usd_micro).toBe(3_500);
        expect(session.steps).toBe(3);
        expect((await store.session.active(s.alice.id)).map((x) => x.id)).toContain(session.id);
        await expectCode(
          store.session.setStatus(session.id, session.version, "planned"),
          "validation",
        );
        await clock.advance(1_000);
        const paused = await store.session.setStatus(session.id, session.version, "paused");
        expect(paused.ended_at).toBeNull();
        const ended = await store.session.setStatus(paused.id, paused.version, "stopped", {
          summary: "halted",
          handoff: { next: ["resume"] },
        });
        expect(ended).toMatchObject({
          status: "stopped",
          ended_at: clock.nowIso(),
          summary: "halted",
          handoff: { next: ["resume"] },
        });
        expect((await store.session.active(s.alice.id)).map((x) => x.id)).not.toContain(session.id);
        expect((await store.session.latestForAgent(s.alice.id))?.id).toBe(session.id);
        const run = await store.run.insert({
          session_id: session.id,
          specialist: "coder",
          model: "m",
          depth: 1,
        });
        const child = await store.run.insert({
          session_id: session.id,
          specialist: "tester",
          model: "m",
          parent_run_id: run.id,
          depth: 2,
        });
        const finished = await store.run.finish(run.id, run.version, {
          tokens_in: 10,
          tokens_out: 5,
          cost_usd_micro: 123,
          ttft_ms: 300,
          duration_ms: 2_000,
          outcome: "success",
          timed_out: false,
          artifacts: ["pr#1"],
        });
        expect(finished).toMatchObject({
          tokens_in: 10,
          ttft_ms: 300,
          outcome: "success",
          timed_out: false,
          artifacts: ["pr#1"],
          version: 2,
        });
        expect((await store.run.children(run.id)).map((r) => r.id)).toEqual([child.id]);
        expect((await store.run.forSession(session.id)).map((r) => r.id)).toEqual([
          run.id,
          child.id,
        ]);
      });
    });

    describe("reasons on milestone and plan changes (B.5)", () => {
      it("a milestone change carries the reason and the actor, bumps the version and refuses a stale one", async () => {
        const m = await store.milestone.insert({ project_id: s.project.id, name: "M1" });
        expect(m.reason).toBe("");
        await clock.advance(1_000);
        const changed = await store.milestone.change(
          m.id,
          m.version,
          { status: "active", target_date: "2026-04-01" },
          "kickoff moved up",
          { humanId: s.human.id },
        );
        expect(changed).toMatchObject({
          status: "active",
          target_date: "2026-04-01",
          reason: "kickoff moved up",
          author_human: s.human.id,
          author_agent: null,
          version: 2,
          updated_at: clock.nowIso(),
        });
        expect(await store.milestone.mustGet(m.id)).toEqual(changed);
        const err = await expectCode(
          store.milestone.change(m.id, m.version, { name: "stale" }, "late edit", {
            agentId: s.alice.id,
          }),
          "version_conflict",
        );
        expect(err.details).toMatchObject({ expected: 1, actual: 2, table: "milestone" });
        expect((await store.milestone.mustGet(m.id)).name).toBe("M1");
        const again = await store.milestone.change(
          changed.id,
          changed.version,
          { name: "M1 renamed" },
          "renamed after the review",
          { agentId: s.alice.id },
        );
        expect(again).toMatchObject({
          name: "M1 renamed",
          reason: "renamed after the review",
          author_agent: s.alice.id,
          author_human: null,
          version: 3,
        });
      });

      it("a milestone change without a reason or an actor is a validation error on every write path", async () => {
        const m = await store.milestone.insert({ project_id: s.project.id, name: "M2" });
        for (const reason of ["", "   "]) {
          const err = await expectCode(
            store.milestone.change(m.id, m.version, { name: "x" }, reason, {
              humanId: s.human.id,
            }),
            "validation",
          );
          expect(err.details).toMatchObject({ table: "milestone", missing: "reason" });
        }
        const noActor = await expectCode(
          store.milestone.change(m.id, m.version, { name: "x" }, "why", {}),
          "validation",
        );
        expect(noActor.details).toMatchObject({ table: "milestone", missing: "actor" });
        // The generic update and patch are no back door: both go through the same check.
        await expectCode(store.milestone.update(m.id, m.version, { name: "x" }), "validation");
        await expectCode(store.milestone.patch(m.id, { status: "done" }), "validation");
        await expectCode(
          store.milestone.patch(m.id, { status: "done", reason: "closing" }),
          "validation",
        );
        const viaPatch = await store.milestone.patch(m.id, {
          status: "done",
          reason: "closing",
          author_human: s.human.id,
        });
        expect(viaPatch).toMatchObject({ status: "done", reason: "closing", version: 2 });
        expect((await store.milestone.mustGet(m.id)).name).toBe("M2");
      });

      it("a session plan change carries the reason and the actor; other session writes need none", async () => {
        const plan = { items: [{ taskId: "t1" }], summary: "one task" };
        await clock.advance(1_000);
        const planned = await store.session.setPlan(
          s.session.id,
          s.session.version,
          plan,
          "planned from the brief",
          { agentId: s.alice.id },
        );
        expect(planned).toMatchObject({
          plan,
          reason: "planned from the brief",
          author_agent: s.alice.id,
          author_human: null,
          version: 2,
          updated_at: clock.nowIso(),
        });
        await expectCode(
          store.session.setPlan(s.session.id, s.session.version, plan, "stale", {
            agentId: s.alice.id,
          }),
          "version_conflict",
        );
        const blank = await expectCode(
          store.session.setPlan(planned.id, planned.version, plan, " ", { agentId: s.alice.id }),
          "validation",
        );
        expect(blank.details).toMatchObject({ table: "session", missing: "reason" });
        await expectCode(
          store.session.setPlan(planned.id, planned.version, plan, "no actor", {}),
          "validation",
        );
        // A plan written through the generic update or patch needs the same reason and actor.
        await expectCode(store.session.patch(planned.id, { plan: { items: [] } }), "validation");
        await expectCode(
          store.session.update(planned.id, planned.version, { plan: { items: [] }, reason: "cut" }),
          "validation",
        );
        const cut = await store.session.update(planned.id, planned.version, {
          plan: { items: [] },
          reason: "cut to the budget",
          author_agent: s.alice.id,
        });
        expect(cut).toMatchObject({ plan: { items: [] }, reason: "cut to the budget", version: 3 });
        // Spend, status and summary writes are not plan changes and carry no reason.
        const spent = await store.session.recordSpend(cut.id, 10);
        expect(spent.reason).toBe("cut to the budget");
        const started = await store.session.start(spent.id, spent.version);
        const summarised = await store.session.patch(started.id, { summary: "halfway" });
        expect(summarised).toMatchObject({
          summary: "halfway",
          reason: "cut to the budget",
          plan: { items: [] },
        });
      });
    });

    describe("audit log", () => {
      it("is append-only with filters by actor, tool, allowed and time", async () => {
        expect("update" in store.auditLog).toBe(false);
        expect("delete" in store.auditLog).toBe(false);
        expect("patch" in store.auditLog).toBe(false);
        const a = await store.auditLog.append({
          session_id: s.session.id,
          agent_id: s.alice.id,
          tool: "bash",
          input_summary: "ls",
          result_summary: "ok",
          allowed: true,
          cost_usd_micro: 1,
        });
        await clock.advance(60_000);
        const b = await store.auditLog.append({
          session_id: s.session.id,
          agent_id: s.alice.id,
          tool: "web",
          input_summary: "fetch",
          result_summary: "",
          allowed: false,
          denied_reason: "domain_not_allowed",
        });
        expect(a.occurred_at).toBe(START);
        expect(b.occurred_at).toBe(clock.nowIso());
        expect((await store.auditLog.list({ sessionId: s.session.id })).map((x) => x.id)).toEqual([
          a.id,
          b.id,
        ]);
        expect((await store.auditLog.list({ allowed: false })).map((x) => x.id)).toEqual([b.id]);
        expect((await store.auditLog.list({ tool: "bash" })).map((x) => x.id)).toEqual([a.id]);
        expect(
          (await store.auditLog.list({ from: "2026-03-01T09:00:30.000Z" })).map((x) => x.id),
        ).toEqual([b.id]);
        expect(
          (await store.auditLog.list({ to: "2026-03-01T09:00:30.000Z" })).map((x) => x.id),
        ).toEqual([a.id]);
        expect((await store.auditLog.list({}, { limit: 1, offset: 1 })).map((x) => x.id)).toEqual([
          b.id,
        ]);
        expect(await store.auditLog.count({ agentId: s.alice.id })).toBe(2);
        await expect(
          store.db.query('UPDATE "audit_log" SET "allowed" = ? WHERE "id" = ?', [true, b.id]),
        ).rejects.toSatisfy(isAppendOnlyViolation);
        await expect(
          store.db.query('DELETE FROM "audit_log" WHERE "id" = ?', [a.id]),
        ).rejects.toSatisfy(isAppendOnlyViolation);
        expect((await store.auditLog.get(b.id))?.allowed).toBe(false);
      });
    });

    describe("supporting repositories", () => {
      it("secret references carry grants, never values", async () => {
        const cols = allColumns(ENTITIES.secret_ref as EntityDef).map((c) => c.name);
        expect(cols.some((c) => /value|secret$|password|token$/.test(c))).toBe(false);
        const ref = await store.secretRef.insert({
          name: "github_pat",
          scope: "human",
          owner_human_id: s.human.id,
          kind: "token",
          created_by: s.human.id,
        });
        expect(await store.secretRef.isGranted(ref.id, s.alice.id)).toBe(false);
        const granted = await store.secretRef.grant(ref.id, ref.version, s.alice.id);
        expect(granted.granted_to).toEqual([s.alice.id]);
        expect(await store.secretRef.grant(ref.id, granted.version, s.alice.id)).toEqual(granted);
        expect((await store.secretRef.forAgent(s.alice.id)).map((r) => r.name)).toEqual([
          "github_pat",
        ]);
        expect(await store.secretRef.forAgent(s.bob.id)).toEqual([]);
        expect((await store.secretRef.byName(s.human.id, "github_pat"))?.id).toBe(ref.id);
        const revoked = await store.secretRef.revokeGrant(ref.id, granted.version, s.alice.id);
        expect(revoked.granted_to).toEqual([]);
        expect((await store.secretRef.markUsed(ref.id)).last_used).toBe(clock.nowIso());
      });

      it("budget windows move ok -> warn80 -> stopped and a zero cap never stops", async () => {
        const w = await store.budgetWindow.open({
          scope: "project",
          scope_id: s.project.id,
          period_start: "2026-03-01T00:00:00.000Z",
          period_end: "2026-04-01T00:00:00.000Z",
          cap_usd_micro: 10_000,
        });
        expect(
          (
            await store.budgetWindow.open({
              scope: "project",
              scope_id: s.project.id,
              period_start: "2026-03-01T00:00:00.000Z",
              period_end: "2026-04-01T00:00:00.000Z",
              cap_usd_micro: 99,
            })
          ).id,
        ).toBe(w.id);
        expect((await store.budgetWindow.current("project", s.project.id))?.id).toBe(w.id);
        expect(
          await store.budgetWindow.current("project", s.project.id, "2026-04-01T00:00:00.000Z"),
        ).toBeUndefined();
        expect((await store.budgetWindow.addSpent(w.id, 7_999)).state).toBe("ok");
        expect((await store.budgetWindow.addSpent(w.id, 1)).state).toBe("warn80");
        expect((await store.budgetWindow.addSpent(w.id, 1_999)).state).toBe("warn80");
        const stopped = await store.budgetWindow.addSpent(w.id, 1);
        expect(stopped).toMatchObject({ state: "stopped", spent_usd_micro: 10_000 });
        const raised = await store.budgetWindow.setCap(w.id, stopped.version, 100_000);
        expect(raised.state).toBe("ok");
        const noCap = await store.budgetWindow.open({
          scope: "task",
          scope_id: "t",
          period_start: "2026-03-01T00:00:00.000Z",
          period_end: "2026-04-01T00:00:00.000Z",
          cap_usd_micro: 0,
        });
        expect((await store.budgetWindow.addSpent(noCap.id, 1_000_000)).state).toBe("ok");
        await expectCode(store.budgetWindow.addSpent("missing", 1), "not_found");
      });

      it("billing sources, extensions, releases, commands, data assets, sources, milestones and people", async () => {
        const api = await store.billingSource.insert({
          human_id: s.human.id,
          kind: "api_key",
          label: "API",
          priority: 20,
        });
        const sub = await store.billingSource.insert({
          human_id: s.human.id,
          kind: "subscription",
          label: "Max",
          priority: 10,
        });
        const off = await store.billingSource.insert({
          human_id: s.human.id,
          kind: "fake",
          label: "Fake",
          enabled: false,
        });
        expect((await store.billingSource.enabledFor(s.human.id)).map((b) => b.id)).toEqual([
          sub.id,
          api.id,
        ]);
        expect((await store.billingSource.setEnabled(off.id, off.version, true)).enabled).toBe(
          true,
        );

        const ext = await store.extension.insert({
          kind: "mcp_server",
          name: "github",
          ext_version: "1.2.3",
          permissions: ["repo:read"],
        });
        expect(await store.extension.enabled()).toEqual([]);
        await store.extension.setEnabled(ext.id, ext.version, true);
        expect((await store.extension.enabled("mcp_server")).map((e) => e.name)).toEqual([
          "github",
        ]);
        expect((await store.extension.byName("mcp_server", "github"))?.ext_version).toBe("1.2.3");
        await expect(
          store.extension.insert({ kind: "mcp_server", name: "github" }),
        ).rejects.toThrow();

        const r1 = await store.release.insert({ release_version: "1.0.0", channel: "stable" });
        await clock.advance(1_000);
        const r2 = await store.release.insert({ release_version: "1.0.1", channel: "stable" });
        expect((await store.release.latest("stable"))?.id).toBe(r2.id);
        const published = await store.release.setStatus(r1.id, r1.version, "published");
        expect(published.published_at).toBe(clock.nowIso());
        expect((await store.release.latest("stable", "published"))?.id).toBe(r1.id);
        await expectCode(store.release.setStatus(r2.id, r2.version, "installed"), "validation");
        expect(
          (
            await store.release.setStatus(published.id, published.version, "rolled_back", {
              reason: "crash",
            })
          ).health,
        ).toEqual({ reason: "crash" });

        const c1 = await store.command.register({
          name: "budget.set",
          risk: "medium",
          undo_strategy: "restore previous",
          parameters_schema: { type: "object" },
        });
        const c2 = await store.command.register({
          name: "budget.set",
          risk: "high",
          description: "sets a budget",
        });
        expect(c2.id).toBe(c1.id);
        expect(c2).toMatchObject({ risk: "high", description: "sets a budget", version: 2 });
        expect(await store.command.count()).toBe(1);
        expect((await store.command.byName("budget.set"))?.undo_strategy).toBe("restore previous");

        const asset = await store.dataAsset.insert({
          project_ids: [s.project.id],
          locator: "s3://bucket/data.parquet",
          kind: "parquet",
          registered_by: s.human.id,
          size_bytes: 10 * 1024 ** 3,
        });
        expect((await store.dataAsset.forProject(s.project.id)).map((a) => a.id)).toEqual([
          asset.id,
        ]);
        expect(await store.dataAsset.forProject("none")).toEqual([]);
        expect((await store.dataAsset.byLocator("s3://bucket/data.parquet"))?.size_bytes).toBe(
          10 * 1024 ** 3,
        );

        const src = await store.source.insert({
          kind: "github_org",
          display_name: "Acme",
          locator: "acme",
        });
        expect((await store.source.byLocator("github_org", "acme"))?.id).toBe(src.id);
        const scanned = await store.source.markScanned(src.id, { repos: ["a", "b"] });
        expect(scanned).toMatchObject({
          last_scan: clock.nowIso(),
          scan_result: { repos: ["a", "b"] },
          status: "connected",
        });

        const m2 = await store.milestone.insert({
          project_id: s.project.id,
          name: "Second",
          order_index: 2,
        });
        const m1 = await store.milestone.insert({
          project_id: s.project.id,
          name: "First",
          order_index: 1,
          success_criteria: ["ci green"],
        });
        expect((await store.milestone.forProject(s.project.id)).map((m) => m.id)).toEqual([
          m1.id,
          m2.id,
        ]);

        const archived = await store.project.insert({
          name: "Archived",
          status: "archived",
          active: false,
        });
        expect((await store.project.active()).map((p) => p.name)).toEqual(["Demo"]);
        expect((await store.project.byName("Archived"))?.id).toBe(archived.id);
        await expect(store.project.insert({ name: "Demo" })).rejects.toThrow();

        expect((await store.human.byEmail("  ADA@example.test "))?.id).toBe(s.human.id);
        expect((await store.agent.forOwner(s.human.id)).map((a) => a.id)).toEqual([s.alice.id]);
        expect((await store.agent.byName(s.human.id, "Alice"))?.id).toBe(s.alice.id);
        expect((await store.agent.principals(s.human.id)).map((a) => a.id)).toEqual([s.alice.id]);
      });
    });

    describe("transactions", () => {
      it("rolls back everything written through the transactional store when the callback throws", async () => {
        const before = await store.task.count();
        await expect(
          store.transaction(async (tx) => {
            await tx.task.insert({ project_id: s.project.id, title: "doomed" });
            await tx.event.append(s.session.id, "note", {});
            throw new Error("abort");
          }),
        ).rejects.toThrow("abort");
        expect(await store.task.count()).toBe(before);
        expect(await store.event.count(s.session.id)).toBe(0);
      });

      it("root-handle repositories join an open transaction, and nested transactions use savepoints", async () => {
        const result = await store.transaction(async (tx) => {
          const keep = await store.task.insert({ project_id: s.project.id, title: "kept" });
          await expect(
            tx.transaction(async (inner) => {
              await inner.task.insert({ project_id: s.project.id, title: "inner" });
              await store.task.insert({ project_id: s.project.id, title: "inner-via-root" });
              throw new Error("inner abort");
            }),
          ).rejects.toThrow("inner abort");
          expect(await tx.task.count({ title: "inner" })).toBe(0);
          expect(await tx.task.count({ title: "inner-via-root" })).toBe(0);
          return keep;
        });
        expect((await store.task.mustGet(result.id)).title).toBe("kept");
        expect(await store.task.count({ title: "inner" })).toBe(0);
        await expect(
          store.db.transaction(async () => {
            await store.task.insert({ project_id: s.project.id, title: "root-in-tx" });
            throw new Error("outer abort");
          }),
        ).rejects.toThrow("outer abort");
        expect(await store.task.count({ title: "root-in-tx" })).toBe(0);
      });
    });
  });
}
