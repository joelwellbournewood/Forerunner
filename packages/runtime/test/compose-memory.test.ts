import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { privateIndexUrl } from "../src/loop/memory.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Spec "whose private memory and keys each holds ... never leave that PC" and ADR 0002: when the
 * state store is shared (not a `sqlite:` URL: paired and hybrid mode) the daemon opens a local
 * index under the install's data directory and routes the private scope to it; critic and
 * shared rows stay in the shared store. Here the "shared" store is an in-memory SQLite and the
 * index is forced through `privateIndexUrl`, so the routing is proven without Postgres; the
 * decision itself is tested on the URL.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const WINDOWS =
  "Run the Windows CI job before merging any change that touches file paths or separators.";
const VITEST =
  "Vitest tests that touch the filesystem must create their own temp directory and remove it.";
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;

describe("private memory beside a shared state", () => {
  it("decides the private index from the state URL: none for sqlite, <data>/memory/private.sqlite otherwise", () => {
    const dirs = { data: join("/", "var", "fr", "data") };
    expect(privateIndexUrl("sqlite::memory:", dirs)).toBeNull();
    expect(privateIndexUrl(`sqlite:${join(dirs.data, "state.sqlite")}`, dirs)).toBeNull();
    expect(privateIndexUrl("postgres://u:p@db.example.test/forerunner", dirs)).toBe(
      `sqlite:${join(dirs.data, "memory", "private.sqlite")}`,
    );
    expect(privateIndexUrl("postgresql://db.example.test/forerunner", dirs)).toBe(
      `sqlite:${join(dirs.data, "memory", "private.sqlite")}`,
    );
  });

  describe("the daemon with a shared store and the local index", () => {
    let rt: RuntimeApp;
    let app: ReturnType<typeof createDaemonApp>["app"];
    let token: string;
    let home: string;
    let indexPath: string;
    const clock = new SimulatedClock("2026-10-23T08:00:00Z");
    const req = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), "fr-private-memory-"));
      const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
      indexPath = join(dirs.data, "memory", "private.sqlite");
      rt = await composeRuntime({
        env: { FORERUNNER_HOME: home },
        dirs,
        config: null,
        clock,
        stateUrl: "sqlite::memory:",
        privateIndexUrl: `sqlite:${indexPath}`,
        vault: new MemoryVault(),
        provider: new ScriptedProvider([{ text: "Noted." }], clock),
        registryDir: REGISTRY,
        identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
        startServices: false,
      });
      ({ app, token } = createDaemonApp(rt));
    }, 120_000);
    afterAll(async () => {
      await rt?.close();
      rmSync(home, { recursive: true, force: true });
    });

    it("opens the index under the data directory with the lesson schema", async () => {
      expect(rt.privateMemory).not.toBeNull();
      expect(existsSync(indexPath)).toBe(true);
      expect(rt.privateMemory?.dialect).toBe("sqlite");
      expect(rt.privateMemory?.migration?.version).toBe(rt.store.migration?.version);
    });

    it("records a session's private lessons in the index only and critic lessons in the shared store", async () => {
      const mine = await rt.memory.record({
        agentId: rt.agent.id,
        sessionId: "ses_private",
        projectId: null,
        lessons: [{ text: WINDOWS, tags: ["windows", "ci"], confidence: 0.8 }],
      });
      expect(mine).toMatchObject({ recorded: 1, merged: 0, rejected: [] });
      const critic = await rt.memory.record({
        agentId: rt.criticAgent.id,
        sessionId: "ses_private",
        projectId: null,
        scope: "critic",
        lessons: [{ text: VITEST, tags: ["vitest"], confidence: 0.6 }],
      });
      expect(critic).toMatchObject({ recorded: 1, rejected: [] });

      const index = rt.privateMemory;
      if (!index) throw new Error("no private index");
      expect(
        await index.lesson.count({ scope: "agent_private", owner_agent_id: rt.agent.id }),
      ).toBe(1);
      expect(await index.lesson.count()).toBe(1);
      expect(await rt.store.lesson.count({ scope: "agent_private" })).toBe(0);
      expect(await rt.store.lesson.count({ scope: "critic" })).toBe(1);
      // The file is canonical and lands in the agent's private root as before.
      const [row] = await index.lesson.list({ scope: "agent_private" });
      expect(row?.file_path).toBe(
        join(home, "data", "memory", "agents", rt.agent.id, "lessons", `${row?.id}.md`),
      );
      expect(existsSync(row?.file_path ?? "")).toBe(true);
    });

    it("recall gives the principal its private lesson and the critic none of it", async () => {
      const mine = await rt.memory.recall({
        agentId: rt.agent.id,
        kind: "principal",
        projectId: null,
        query: "Fix the Windows path separators in the CI job",
        tags: ["ci"],
        maxTokens: 1500,
      });
      expect(mine.block).toContain(WINDOWS);
      expect(mine.block).not.toContain(VITEST);
      expect(mine.denied).toEqual([]);
      const critic = await rt.memory.recall({
        agentId: rt.criticAgent.id,
        kind: "critic",
        projectId: null,
        query: "Fix the Windows path separators in the CI job; vitest temp directories",
        tags: ["ci", "vitest"],
        maxTokens: 1500,
      });
      expect(critic.block).toContain(VITEST);
      expect(critic.block).not.toContain(WINDOWS);
    });

    it("the memory views and routes read and edit the private scope through the index", async () => {
      const scopes = (await json(await req("/memory/scopes"))) as unknown as {
        scope: string;
        ownerAgentId: string | null;
        active: number;
      }[];
      expect(scopes).toContainEqual(
        expect.objectContaining({ scope: "agent_private", ownerAgentId: rt.agent.id, active: 1 }),
      );
      expect(scopes).toContainEqual(expect.objectContaining({ scope: "critic", active: 1 }));
      const view = await json(await req(`/memory?scope=agent_private&agentId=${rt.agent.id}`));
      const lessons = view.lessons as { id: string; text: string; pinned: boolean }[];
      expect(lessons.map((l) => l.text)).toEqual([WINDOWS]);
      const id = lessons[0]?.id as string;
      const pinned = await req(`/memory/lessons/${id}/pin`, {
        method: "POST",
        body: JSON.stringify({ pinned: true }),
      });
      expect(pinned.status).toBe(200);
      const index = rt.privateMemory;
      if (!index) throw new Error("no private index");
      expect((await index.lesson.mustGet(id)).pinned).toBe(true);
      const edited = await req(`/memory/lessons/${id}`, {
        method: "PUT",
        body: JSON.stringify({ confidence: 0.95 }),
      });
      expect(edited.status).toBe(200);
      expect((await index.lesson.mustGet(id)).confidence).toBe(0.95);
      const removed = await req(`/memory/lessons/${id}`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect((await index.lesson.mustGet(id)).status).toBe("retired");
      expect(await rt.store.lesson.count({ scope: "agent_private" })).toBe(0);
    });
  });

  it("a sqlite state keeps every scope in the one local store (solo mode: no index)", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-solo-memory-"));
    const clock = new SimulatedClock("2026-10-23T08:00:00Z");
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Noted." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      startServices: false,
    });
    try {
      expect(rt.privateMemory).toBeNull();
      await rt.memory.record({
        agentId: rt.agent.id,
        sessionId: "ses_solo",
        projectId: null,
        lessons: [{ text: WINDOWS, tags: ["windows"] }],
      });
      expect(await rt.store.lesson.count({ scope: "agent_private" })).toBe(1);
      expect(existsSync(join(home, "data", "memory", "private.sqlite"))).toBe(false);
    } finally {
      await rt.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
