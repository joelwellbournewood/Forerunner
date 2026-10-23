import { isForerunnerError, SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { isForeignKeyViolation } from "../src/db/dialect.ts";
import type { Database } from "../src/db/types.ts";
import { LessonRepo } from "../src/repos/lesson.ts";
import { openStore } from "../src/store.ts";
import type { NewLesson } from "../src/types.ts";

/**
 * Spec "whose private memory and keys each holds ... never leave that PC" and ADR 0002
 * "Private rows exist only in the local SQLite; the Postgres adapter throws
 * `MEMORY_SCOPE_VIOLATION` on any private write". The Postgres half runs here on a handle that
 * fails the test if a statement reaches it, so the refusal is proven to happen before any SQL
 * (the real adapter is covered by `suite.ts` on the integration project); the SQLite half is
 * the acceptance in solo mode and in the private index the runtime opens next to a shared
 * store.
 */

/** A Postgres-dialect handle: every statement that reaches it is a test failure. */
function refusingPostgres(): Database & { statements: string[] } {
  const statements: string[] = [];
  const db: Database & { statements: string[] } = {
    statements,
    dialect: "postgres",
    inTransaction: false,
    async query(sql: string) {
      statements.push(sql);
      throw new Error(`statement reached the shared store: ${sql}`);
    },
    async exec(sql: string) {
      statements.push(sql);
      throw new Error(`statement reached the shared store: ${sql}`);
    },
    transaction: (fn) => fn(db),
    async close() {},
  };
  return db;
}

async function expectScopeViolation(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    if (isForerunnerError(e, "MEMORY_SCOPE_VIOLATION")) {
      expect(e.details).toMatchObject({ scope: "agent_private", dialect: "postgres" });
      return;
    }
    throw new Error(`expected ForerunnerError(MEMORY_SCOPE_VIOLATION), got ${String(e)}`);
  }
  throw new Error("expected ForerunnerError(MEMORY_SCOPE_VIOLATION), nothing was thrown");
}

describe("private lessons never reach the shared store", () => {
  const clock = new SimulatedClock("2026-10-23T08:00:00Z");

  it("the Postgres adapter refuses an agent_private insert before any statement runs", async () => {
    const db = refusingPostgres();
    const repo = new LessonRepo(db, clock);
    await expectScopeViolation(
      repo.add({ scope: "agent_private", owner_agent_id: "agent-alice", text: "Alice's habit" }),
    );
    await expectScopeViolation(
      repo.insertMany([
        { scope: "agent_private", owner_agent_id: "agent-alice", text: "Alice's habit" },
      ]),
    );
    expect(db.statements).toEqual([]);
  });

  it("the Postgres adapter refuses an update or patch that would turn a row private", async () => {
    const db = refusingPostgres();
    const repo = new LessonRepo(db, clock);
    await expectScopeViolation(
      repo.update("les_1", 1, { scope: "agent_private", owner_agent_id: "agent-alice" }),
    );
    await expectScopeViolation(repo.patch("les_1", { scope: "agent_private" }));
    await expectScopeViolation(
      repo.updateWhere({ scope: "agent_private" } as never, '"id" = ?', ["les_1"]),
    );
    expect(db.statements).toEqual([]);
  });

  it("the SQLite adapter accepts the same writes (solo mode and the private index)", async () => {
    const store = await openStore({ url: "sqlite::memory:", clock });
    try {
      const human = await store.human.insert({ name: "Ada", email: "ada@example.test" });
      const alice = await store.agent.insert({ name: "Alice", owner_human_id: human.id });
      const row = await store.lesson.add({
        scope: "agent_private",
        owner_agent_id: alice.id,
        text: "Alice's habit",
      });
      expect(row.scope).toBe("agent_private");
      const patched = await store.lesson.patch(row.id, { scope: "agent_private", pinned: true });
      expect(patched.pinned).toBe(true);
      const next = await store.lesson.supersede(row.id, { text: "Alice's newer habit" });
      expect(next.scope).toBe("agent_private");
      expect(next.owner_agent_id).toBe(alice.id);
    } finally {
      await store.close();
    }
  });

  it("a private index opened without foreign keys holds rows whose agent and project live in the shared store", async () => {
    const strict = await openStore({ url: "sqlite::memory:", clock });
    const index = await openStore({
      url: "sqlite::memory:",
      clock,
      sqlite: { foreignKeys: false },
    });
    try {
      const input: NewLesson = {
        scope: "agent_private",
        owner_agent_id: "agent-in-the-shared-store",
        project_id: "project-in-the-shared-store",
        text: "A private lesson about a shared project",
      };
      await expect(strict.lesson.add(input)).rejects.toSatisfy((e: unknown) =>
        isForeignKeyViolation(e),
      );
      const row = await index.lesson.add(input);
      expect(row.owner_agent_id).toBe("agent-in-the-shared-store");
      expect(row.project_id).toBe("project-in-the-shared-store");
      expect(
        await index.lesson.search({
          scope: "agent_private",
          ownerAgentId: "agent-in-the-shared-store",
        }),
      ).toHaveLength(1);
    } finally {
      await strict.close();
      await index.close();
    }
  });
});
