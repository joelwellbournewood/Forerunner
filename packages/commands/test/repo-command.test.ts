import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandContext,
  defaultRegistry,
  IntentParser,
  type RepoCommandPort,
  repoCreate,
} from "../src/index.ts";
import { START, TZ } from "./helpers.ts";

/**
 * repo.create (U-037, ADR 0097): Chat's phrases, the change card and the risk that decides who
 * confirms. A private repository asks the person (medium: a yes or a tap); a public one asks
 * for a paired device (high); the project's own agent acts alone only at Autopilot, where the
 * autonomy table frees outward-facing actions, and only for a private repository.
 */
const parser = new IntentParser(defaultRegistry());
const notes = { id: "p-notes", name: "Notes App" };
const intent = (overrides = {}) => ({
  source: "chat" as const,
  timezone: TZ,
  now: Date.parse(START),
  activeProjectId: notes.id,
  projects: [notes, { id: "p-garden", name: "Garden Planner" }],
  ...overrides,
});

describe("Chat: create a repository", () => {
  it.each([
    ["create a repository", { private: true, project: notes.id }],
    ["make a private GitHub repo", { private: true, project: notes.id }],
    ["set up a public repository for Garden Planner", { private: false, project: "p-garden" }],
    ["erstelle ein Repository für Garden Planner", { private: true, project: "p-garden" }],
  ])("%s", async (text, params) => {
    const r = await parser.parse(text, intent());
    expect(r.question).toBeUndefined();
    expect(r.commands).toEqual([{ name: "repo.create", params }]);
  });

  it("with no active project it asks which", async () => {
    const r = await parser.parse("create a repository", intent({ activeProjectId: null }));
    expect(r.commands).toEqual([]);
    expect(r.question?.text).toBe("Which project?");
  });
});

describe("repo.create: the card and who confirms", () => {
  const stores: StateStore[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.close();
  });

  async function ctxFor(level: number, actor: "human" | "agent"): Promise<CommandContext> {
    const clock = new SimulatedClock(START);
    const store = await openStore({ url: "sqlite::memory:", clock });
    stores.push(store);
    const human = await store.human.insert({ name: "Joel", email: "j@example.test" });
    const agent = await store.agent.insert({ name: "Alice", owner_human_id: human.id });
    const project = await store.project.insert({ name: "Notes App", autonomy_level: level });
    const repos: RepoCommandPort = {
      preview: async (req) => ({
        projectId: req.projectId,
        projectName: "Notes App",
        owner: req.owner ?? "joel",
        name: req.name ?? "notes-app",
        fullName: `${req.owner ?? "joel"}/${req.name ?? "notes-app"}`,
        private: req.private,
        accountKind: req.owner ? "organization" : "account",
      }),
      create: async () => {
        throw new Error("not in this test");
      },
    };
    return {
      actor: actor === "human" ? { kind: "human", id: human.id } : { kind: "agent", id: agent.id },
      humanId: human.id,
      agentId: agent.id,
      activeProjectId: project.id,
      store,
      clock,
      ports: { chfPerUsd: async () => 0.8, repos },
      source: "ui",
      wordsUsed: "",
      timezone: TZ,
    };
  }

  const risk = async (p: { private: boolean }, ctx: CommandContext) =>
    typeof repoCreate.risk === "function" ? repoCreate.risk(p, ctx) : repoCreate.risk;

  it("private is medium for the person and for the agent below Autopilot; public is high", async () => {
    expect(await risk({ private: true }, await ctxFor(2, "human"))).toBe("medium");
    expect(await risk({ private: true }, await ctxFor(4, "human"))).toBe("medium");
    expect(await risk({ private: true }, await ctxFor(3, "agent"))).toBe("medium");
    expect(await risk({ private: false }, await ctxFor(2, "human"))).toBe("high");
    expect(await risk({ private: false }, await ctxFor(4, "agent"))).toBe("high");
  });

  it("the project's agent at Autopilot creates a private repository without asking", async () => {
    expect(await risk({ private: true }, await ctxFor(4, "agent"))).toBe("low");
  });

  it("the card says the name, where and private or public, and that it cannot be undone", async () => {
    const ctx = await ctxFor(2, "human");
    const card = await repoCreate.plan?.({ private: true }, ctx);
    expect(card).toMatchObject({
      what: "a GitHub repository for Notes App",
      oldValue: "no repository",
      newValue: "joel/notes-app (private, under your GitHub account joel)",
      reversible: false,
    });
    const org = await repoCreate.plan?.({ private: false, owner: "acme" }, ctx);
    expect(org?.newValue).toBe("acme/notes-app (public, under the organization acme)");
  });
});
