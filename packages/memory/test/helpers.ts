import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import {
  createMemory,
  HashedNgramEmbedder,
  LessonFiles,
  type MemoryContext,
} from "../src/index.ts";

/**
 * One test world: an in-memory SQLite store (foreign keys on, so humans, agents and projects
 * exist), a temporary memory root, a simulated clock and a memory context bound to all three.
 */
export interface World {
  clock: SimulatedClock;
  store: StateStore;
  root: string;
  files: LessonFiles;
  ctx: MemoryContext;
  humanId: string;
  /** Principal agent of the first human. */
  alice: string;
  /** Principal agent of the second human. */
  bob: string;
  /** The critic agent. */
  critic: string;
  project: string;
  project2: string;
  close(): Promise<void>;
}

export const DAY_MS = 86_400_000;

export async function world(start = "2026-03-02T07:00:00Z"): Promise<World> {
  const clock = new SimulatedClock(start);
  const store = await openStore({ url: "sqlite::memory:", clock });
  const root = await mkdtemp(join(tmpdir(), "fr-memory-"));
  const human = await store.human.insert({ name: "J", email: "j@example.test" });
  const human2 = await store.human.insert({ name: "F", email: "f@example.test" });
  const alice = await store.agent.insert({ name: "Alice", owner_human_id: human.id });
  const bob = await store.agent.insert({ name: "Bob", owner_human_id: human2.id });
  const critic = await store.agent.insert({
    name: "Critic",
    owner_human_id: human.id,
    kind: "critic",
  });
  const project = await store.project.insert({ name: "pharmawatch" });
  const project2 = await store.project.insert({ name: "supplement-site" });
  const files = new LessonFiles(root);
  const ctx = createMemory({ store, files, embedder: new HashedNgramEmbedder(), clock });
  return {
    clock,
    store,
    root,
    files,
    ctx,
    humanId: human.id,
    alice: alice.id,
    bob: bob.id,
    critic: critic.id,
    project: project.id,
    project2: project2.id,
    close: async () => {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Lesson texts used across the suites; long enough for the 20-char minimum. */
export const TEXTS = {
  windows:
    "Run the Windows CI job before merging any change that touches file paths or separators.",
  windowsDup:
    "Run the Windows CI job before merging any change that touches file paths or path separators.",
  windowsDup2: "Run the Windows CI job before merging any change that touches file paths.",
  vault: "Keep vault secret names in kebab case and never write their values into a log line.",
  vitest:
    "Vitest tests that touch the filesystem must create their own temp directory and remove it.",
  budget: "Reserve a fifth of the session budget for the critic review and the fixes it asks for.",
} as const;
