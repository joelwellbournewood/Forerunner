import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RECALL_GOLDEN,
  RECALL_HOME_NOW,
  type RecallHome,
  type RecallHomeStore,
  seedRecallHome,
} from "../../../testenv/src/bench/recall-home.ts";
import { RecallScope, recallTools } from "../src/conversation/recall.ts";
import { MemoryLoop } from "../src/loop/memory.ts";

/**
 * d1109-chat-recall (run C, ADR 0114), CR-7: the ranking's golden set. Recall ranks in code
 * (BM25 fused with the letter patterns of titles, boosts, strong or weak); over a seeded home of
 * four weeks (testenv/src/bench/recall-home.ts: 2 projects, 24 tasks with 3 renames and 2
 * cancels, 6 sessions, 14 cards, 5 decisions, 5 lessons, a docs folder, 120 conversation lines in
 * English and German, and another person's records) the 24 questions a person asks find their
 * record in the first three hits (recall@3 at least 0.9) and early (MRR at least 0.75); a dated
 * question's hits lie in its window; no hit is another person's or from a project not named.
 */

const folders: string[] = [];
let store: StateStore;
let home: RecallHome;
let clock: SimulatedClock;
let human: string;
let alice: string;
let memory: MemoryLoop;
let docs: string;

beforeAll(async () => {
  clock = new SimulatedClock("2026-10-19T06:00:00.000Z");
  store = await openStore({ url: "sqlite::memory:", clock });
  human = (
    await store.human.insert({
      name: "Robin",
      email: "robin@example.test",
      timezone: "Europe/Zurich",
    } as never)
  ).id;
  alice = (
    await store.agent.insert({ name: "Alice", owner_human_id: human, kind: "principal" } as never)
  ).id;
  const root = mkdtempSync(join(tmpdir(), "fr-recall-rank-mem-"));
  docs = mkdtempSync(join(tmpdir(), "fr-recall-rank-docs-"));
  folders.push(root, docs);
  memory = new MemoryLoop({ store, clock, root, humanId: human });
  home = await seedRecallHome({
    store: store as unknown as RecallHomeStore,
    at: (iso) => clock.set(iso),
    humanId: human,
    agentId: alice,
    conversationSession: async (agentId, projectId) =>
      (
        await store.session.insert({
          agent_id: agentId,
          project_id: projectId,
          trigger: "manual",
          plan: {},
          status: "planned",
          summary: "conversation",
          handoff: {},
          runner: "pc",
        } as never)
      ).id,
    recordLesson: async (agentId, projectId, text) => {
      await memory.record({
        agentId,
        sessionId: "seed",
        projectId,
        scope: "agent_private",
        lessons: [{ text }],
      });
    },
    docsRoot: docs,
  });
  expect(clock.nowIso()).toBe(RECALL_HOME_NOW);
});

afterAll(async () => {
  await store.close();
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

async function ask(input: Record<string, unknown>, projectId: string = home.quote) {
  const [recall] = recallTools({
    store,
    humanId: human,
    agent: await store.agent.mustGet(alice),
    projectId,
    scope: new RecallScope(),
    timeZone: "Europe/Zurich",
    nowMs: clock.now(),
    line: "x",
    countTokens: (t) => Math.ceil(t.length / 4),
    memory,
    docsDirs: async (id) => (id === home.quote ? [docs] : []),
  });
  const out = await recall?.execute(input as never, {} as never);
  return String(out?.content ?? "")
    .split("\n")
    .filter((l) => /^r\d+ \[/.test(l));
}

const DAY = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Zurich",
    weekday: "short",
    day: "numeric",
    month: "short",
  })
    .format(new Date(iso))
    .replace(",", "");

describe("d1109-chat-recall, run C: CR-7 the golden set", () => {
  it("24 questions: recall@3 at least 0.9 and MRR at least 0.75", async () => {
    expect(RECALL_GOLDEN).toHaveLength(24);
    let inThree = 0;
    let rr = 0;
    const misses: string[] = [];
    for (const g of RECALL_GOLDEN) {
      const hits = await ask(g.input);
      const at = hits.findIndex((h) => h.includes(g.expect));
      if (at >= 0 && at < 3) inThree++;
      if (at >= 0) rr += 1 / (at + 1);
      if (at < 0 || at > 0)
        misses.push(
          `${g.ask} -> ${at < 0 ? "not found" : `r${at + 1}`}: ${hits.slice(0, 3).join(" | ")}`,
        );
    }
    const recallAt3 = inThree / RECALL_GOLDEN.length;
    const mrr = rr / RECALL_GOLDEN.length;
    expect(recallAt3, misses.join("\n")).toBeGreaterThanOrEqual(0.9);
    expect(mrr, misses.join("\n")).toBeGreaterThanOrEqual(0.75);
  });

  it("every hit of a dated question lies in its window", async () => {
    for (const g of RECALL_GOLDEN.filter((q) => q.input.from || q.input.to)) {
      const from = Date.parse(`${g.input.from ?? "2026-01-01"}T00:00:00+01:00`);
      const to = Date.parse(`${g.input.to ?? "2026-12-31"}T23:59:59+01:00`);
      const days = new Set<string>();
      for (let t = from; t <= to; t += 3_600_000) days.add(DAY(new Date(t).toISOString()));
      for (const h of await ask(g.input)) {
        const date = /^r\d+ \[[a-z]+, ([^,]+),/.exec(h)?.[1] ?? "";
        expect(days.has(date), `${g.ask}: ${h}`).toBe(true);
      }
    }
  });

  it("no hit is another person's or from a project the question did not name", async () => {
    for (const g of RECALL_GOLDEN) {
      const named = g.input.project;
      for (const h of await ask(g.input)) {
        expect(h).not.toMatch(/Kim|Kai|garden/i);
        const project = /^r\d+ \[[a-z]+, [^,]+, ([^,]+),/.exec(h)?.[1];
        expect([named ?? "Quote Page", "no project"], `${g.ask}: ${h}`).toContain(project);
      }
    }
    for (const words of ["Kim plan logo garden", "garden photos private"])
      for (const h of await ask({ words, project: "all" })) expect(h).not.toMatch(/Kim|garden/i);
  });
});

describe("d1109-chat-recall, run C: the bench walk's finding", () => {
  it("a question is not matched to an earlier question for its question words alone ('what did we decide about the plan?' finds the plan's decision, not a newer 'what is left?')", async () => {
    const { rankRecords } = await import("../src/conversation/recall.ts");
    const record = (
      kind: "decisions" | "conversation",
      title: string,
      body: string,
      at: string,
    ) => ({
      kind,
      key: `${kind}:${title}`,
      at,
      projectId: "p",
      projectName: "Quote Page",
      title,
      earlier: [],
      body,
      who: null,
      open: async () => "",
      link: null,
    });
    const ranked = rankRecords(
      [
        record("decisions", "The plan for Quote Page", "Approved.", "2026-11-15T15:40:00.000Z"),
        record("conversation", "what is left?", "what is left?", "2026-11-15T15:42:00.000Z"),
      ],
      "what did we decide about the plan",
      [],
      { projectId: "p" },
    );
    expect(ranked[0]?.record.title).toBe("The plan for Quote Page");
    expect(ranked.map((h) => h.record.title)).not.toContain("what is left?");
  });
});
